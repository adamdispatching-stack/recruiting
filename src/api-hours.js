// Working hours, days off, and the monthly report for each person.
// A working day (from the person's hours, or the team's) counts as worked when the person was active on the site
// for at least the team's minimum. A working day without that is a day off; the admin can mark one as approved.
const db = require('./db');
const lib = require('./lib');
const { q } = db;
const { wrap, needUser, needAdmin, act, isDate } = lib;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A week of hours from the browser: 7 entries, each null or { s: 'HH:MM', e: 'HH:MM' } with the end after the start.
function cleanWeek(w) {
  if (!Array.isArray(w) || w.length !== 7) throw new Error('Working hours need all 7 days of the week');
  return w.map((d, i) => {
    if (!d) return null;
    const s = String(d.s || ''), e = String(d.e || '');
    if (!TIME.test(s) || !TIME.test(e)) throw new Error(`${DOW[i]}: enter a start and an end time`);
    if (mins(e) <= mins(s)) throw new Error(`${DOW[i]}: the end time must be after the start time`);
    return { s, e };
  });
}
// Admins keep no working hours unless they are given their own (then they are counted like anyone else).
const NONE = [null, null, null, null, null, null, null];
const weekOf = (u) => (u && Array.isArray(u.hours) && u.hours.length === 7 ? u.hours : u && u.role === 'admin' ? NONE : db.settings.hours.week);
const fmtT = (t) => { const m = mins(t); const h = Math.floor(m / 60) % 12 || 12; return `${h}${m % 60 ? ':' + String(m % 60).padStart(2, '0') : ''} ${m < 720 ? 'AM' : 'PM'}`; };
const weekText = (w) => {
  // "Mon to Fri, 9 AM to 6 PM" when the working days share hours; otherwise day by day
  const on = w.map((d, i) => (d ? i : -1)).filter((i) => i >= 0);
  if (!on.length) return 'No working days';
  const same = on.every((i) => w[i].s === w[on[0]].s && w[i].e === w[on[0]].e);
  const short = (i) => DOW[i].slice(0, 3);
  const run = on.length > 2 && on[on.length - 1] - on[0] === on.length - 1;
  const days = run ? `${short(on[0])} to ${short(on[on.length - 1])}` : on.map(short).join(', ');
  return same ? `${days}, ${fmtT(w[on[0]].s)} to ${fmtT(w[on[0]].e)}` : on.map((i) => `${short(i)} ${fmtT(w[i].s)} to ${fmtT(w[i].e)}`).join('; ');
};

// Day-by-day attendance for some people between two dates (inclusive, 'YYYY-MM-DD', team time zone).
// Returns { [userId]: { days: [...], totals: {...} } }.
async function attendance(users, from, to) {
  const tz = db.settings.tz; const H = db.settings.hours; const ids = users.map((u) => u.id);
  const today = await lib.today();
  const fromTs = `(($2::date)::timestamp AT TIME ZONE $4)`, toTs = `(($3::date + 1)::timestamp AT TIME ZONE $4)`;
  const hrs = (await q(`SELECT user_id, to_char(hour AT TIME ZONE $4, 'YYYY-MM-DD') d, extract(hour FROM hour AT TIME ZONE $4)::int h,
      active_seconds a, open_seconds o, clicks c, views v, first_at, last_at,
      to_char(first_at AT TIME ZONE $4, 'HH24:MI') ft, to_char(last_at AT TIME ZONE $4, 'HH24:MI') lt
    FROM activity_hours WHERE user_id = ANY($1::int[]) AND hour >= ${fromTs} AND hour < ${toTs} ORDER BY hour`, [ids, from, to, tz])).rows;
  const work = (await q(`SELECT user_id, to_char(at AT TIME ZONE $4, 'YYYY-MM-DD') d, count(*) FILTER (WHERE type = 'note')::int notes,
      count(*) FILTER (WHERE type = 'contact')::int contacts, count(*) FILTER (WHERE type = 'contact' AND detail LIKE 'Call%')::int calls,
      count(*) FILTER (WHERE type = 'lead_add')::int added, count(DISTINCT driver_id) FILTER (WHERE type = 'open')::int opened
    FROM activity WHERE user_id = ANY($1::int[]) AND at >= ${fromTs} AND at < ${toTs} GROUP BY 1, 2`, [ids, from, to, tz])).rows;
  const moved = (await q(`SELECT user_id, to_char(at AT TIME ZONE $4, 'YYYY-MM-DD') d, count(*)::int n FROM status_log
    WHERE user_id = ANY($1::int[]) AND at >= ${fromTs} AND at < ${toTs} AND array_position($5::text[], to_status) > array_position($5::text[], from_status) GROUP BY 1, 2`, [ids, from, to, tz, db.ROUTE])).rows;
  const offs = (await q(`SELECT user_id, day::text d, reason FROM days_off WHERE user_id = ANY($1::int[]) AND day BETWEEN $2::date AND $3::date`, [ids, from, to])).rows;
  const dates = (await q(`SELECT g::date::text d, extract(dow FROM g)::int dow FROM generate_series($1::date, $2::date, interval '1 day') g ORDER BY g`, [from, to])).rows;
  const out = {};
  for (const u of users) {
    const week = weekOf(u); const born = u.created_local || '0000-00-00';
    const days = dates.map(({ d, dow }) => {
      const sch = week[dow]; const hs = hrs.filter((x) => x.user_id === u.id && x.d === d);
      const w = work.find((x) => x.user_id === u.id && x.d === d) || {}; const off = offs.find((x) => x.user_id === u.id && x.d === d);
      const active = hs.reduce((a, x) => a + x.a, 0), open = hs.reduce((a, x) => a + x.o, 0);
      // active time inside the working hours: each hour's active time, in proportion to how much of that hour is working time
      const inHours = sch ? Math.round(hs.reduce((a, x) => a + x.a * Math.max(0, Math.min(x.h * 60 + 60, mins(sch.e)) - Math.max(x.h * 60, mins(sch.s))) / 60, 0)) : 0;
      const first = hs.length ? hs.reduce((m, x) => (x.first_at < m.first_at ? x : m)).ft : null;
      const last = hs.length ? hs.reduce((m, x) => (x.last_at > m.last_at ? x : m)).lt : null;
      const worked = active >= H.minMinutes * 60;
      let status;
      if (d < born) status = 'before';
      else if (worked) status = sch ? 'worked' : 'extra';
      else if (off) status = 'approved'; // also a planned day off later in the month
      else if (d > today) status = 'future';
      else if (!sch) status = 'rest';
      else if (d === today) status = 'today'; // the day is not over yet
      else status = 'off';
      const late = !!(worked && sch && first && mins(first) > mins(sch.s) + H.grace);
      const early = !!(worked && sch && last && d < today && mins(last) < mins(sch.e) - H.grace);
      return { date: d, dow, sch, status, active, open, inHours, first, last, late, early, offReason: off ? off.reason || '' : null,
        clicks: hs.reduce((a, x) => a + x.c, 0), views: hs.reduce((a, x) => a + x.v, 0),
        notes: w.notes || 0, contacts: w.contacts || 0, calls: w.calls || 0, added: w.added || 0, opened: w.opened || 0,
        moved: (moved.find((x) => x.user_id === u.id && x.d === d) || {}).n || 0 };
    });
    const n = (f) => days.filter(f).length; const sum = (k) => days.reduce((a, x) => a + x[k], 0);
    const workedDays = n((x) => x.status === 'worked' || x.status === 'extra');
    const t = {
      scheduled: n((x) => x.sch && !['future', 'before', 'today'].includes(x.status)), // working days so far (today counts once it is worked)
      worked: workedDays, extra: n((x) => x.status === 'extra'), off: n((x) => x.status === 'off'), approved: n((x) => x.status === 'approved' && x.sch),
      late: n((x) => x.late), early: n((x) => x.early), active: sum('active'), open: sum('open'), inHours: sum('inHours'),
      notes: sum('notes'), contacts: sum('contacts'), calls: sum('calls'), added: sum('added'), moved: sum('moved'), opened: sum('opened'), clicks: sum('clicks')
    };
    t.avgActive = workedDays ? Math.round(t.active / workedDays) : 0;
    out[u.id] = { week, weekText: u.role === 'admin' && week === NONE ? 'None (admins have no working hours unless given their own)' : weekText(week), own: !!(Array.isArray(u.hours) && u.hours.length === 7), days, totals: t };
  }
  return out;
}

// The people a report needs, with the day their account started (team time zone).
const peopleSql = `SELECT id, name, email, role, active, hours, (created_at AT TIME ZONE $1)::date::text created_local FROM users`;
async function loadPeople(ids) {
  const r = ids ? await q(`${peopleSql} WHERE id = ANY($2::int[])`, [db.settings.tz, ids]) : await q(peopleSql, [db.settings.tz]);
  return r.rows;
}

// Month 'YYYY-MM' -> first and last date; anything else -> this month.
async function monthBounds(m) {
  const today = await lib.today();
  const ym = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || '')) ? m : today.slice(0, 7);
  const r = (await q(`SELECT $1::date::text a, ($1::date + interval '1 month' - interval '1 day')::date::text b`, [ym + '-01'])).rows[0];
  return { month: ym, from: r.a, to: r.b, today };
}

module.exports = (app) => {
  // ---------- the monthly report ----------
  app.get('/api/team/:id/month', needUser, wrap(async (req, res) => {
    const id = req.params.id === 'me' ? req.user.id : +req.params.id;
    if (req.user.role !== 'admin' && id !== req.user.id) return res.status(403).json({ error: 'Only an admin can see other people' });
    const [p] = await loadPeople([id]); if (!p) return res.status(404).json({ error: 'Person not found' });
    const b = await monthBounds(req.query.m);
    const a = (await attendance([p], b.from, b.to))[p.id];
    // results of the month: their leads that reached onboarding or were hired
    const tz = db.settings.tz;
    const res2 = (await q(`SELECT count(DISTINCT s.driver_id) FILTER (WHERE s.to_status = 'Onboarding')::int onboarded, count(DISTINCT s.driver_id) FILTER (WHERE s.to_status = 'Hired')::int hired
      FROM status_log s JOIN drivers d ON d.id = s.driver_id WHERE d.owner_id = $1 AND s.at >= ($2::date::timestamp AT TIME ZONE $4) AND s.at < (($3::date + 1)::timestamp AT TIME ZONE $4)`, [id, b.from, b.to, tz])).rows[0];
    const first = (await q(`SELECT to_char(min(hour) AT TIME ZONE $2, 'YYYY-MM') m FROM activity_hours WHERE user_id = $1`, [id, tz])).rows[0].m;
    res.json({ person: { id: p.id, name: p.name, role: p.role, active: p.active, since: p.created_local }, month: b.month, from: b.from, to: b.to, today: b.today, tz,
      firstMonth: [first, p.created_local.slice(0, 7)].filter(Boolean).sort()[0], hours: { ...db.settings.hours, week: a.week }, own: a.own, weekText: a.weekText,
      teamWeek: db.settings.hours.week, days: a.days, totals: { ...a.totals, ...res2 } });
  }));

  // ---------- one person's hours (admin) ----------
  app.put('/api/team/:id/hours', needUser, needAdmin, wrap(async (req, res) => {
    const id = +req.params.id; const [p] = await loadPeople([id]); if (!p) return res.status(404).json({ error: 'Person not found' });
    let week = null;
    if (req.body && req.body.week) { try { week = cleanWeek(req.body.week); } catch (e) { return res.status(400).json({ error: e.message }); } }
    await q(`UPDATE users SET hours = $2::jsonb WHERE id = $1`, [id, week ? JSON.stringify(week) : null]);
    await act(req.user, 'admin', null, week ? `Set working hours for ${p.name}: ${weekText(week)}` : `${p.name} now follows the team's working hours`);
    res.json({ ok: true });
  }));

  // ---------- approved days off (admin) ----------
  app.put('/api/team/:id/days/:day', needUser, needAdmin, wrap(async (req, res) => {
    const id = +req.params.id; const day = req.params.day; const [p] = await loadPeople([id]);
    if (!p) return res.status(404).json({ error: 'Person not found' });
    if (!isDate(day)) return res.status(400).json({ error: 'Pick a date' });
    const reason = String((req.body || {}).reason || '').trim().slice(0, 80);
    await q(`INSERT INTO days_off (user_id, day, reason, set_by) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, day) DO UPDATE SET reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()`, [id, day, reason || null, req.user.id]);
    await act(req.user, 'admin', null, `Approved a day off for ${p.name} on ${lib.niceDate(day)}${reason ? ` (${reason})` : ''}`);
    res.json({ ok: true });
  }));
  app.delete('/api/team/:id/days/:day', needUser, needAdmin, wrap(async (req, res) => {
    const id = +req.params.id; const day = req.params.day; const [p] = await loadPeople([id]);
    if (!p || !isDate(day)) return res.status(404).json({ error: 'Not found' });
    const r = await q(`DELETE FROM days_off WHERE user_id = $1 AND day = $2`, [id, day]);
    if (r.rowCount) await act(req.user, 'admin', null, `Took back the approved day off for ${p.name} on ${lib.niceDate(day)}`);
    res.json({ ok: true });
  }));
};
module.exports.attendance = attendance;
module.exports.loadPeople = loadPeople;
module.exports.cleanWeek = cleanWeek;
module.exports.weekText = weekText;
module.exports.weekOf = weekOf;
module.exports.monthBounds = monthBounds;
