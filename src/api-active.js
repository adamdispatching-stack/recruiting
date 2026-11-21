// Active drivers: hired and still with us. Their CDL and medical card expiry dates, their working period
// (weeks out, days home), and when their current stretch on the road began.
const db = require('./db');
const lib = require('./lib');
const { q } = db;
const { wrap, needUser, visSql } = lib;

// The driver's mood day by day, from the evening summaries of his Telegram groups and the alerts there.
// The worst of the day counts. issue = a bad mood or an important alert on any of those days.
const RANK = { angry: 4, unhappy: 3, neutral: 2, good: 1, unknown: 0 };
async function moods(ids, n, admin) {
  if (!ids.length) return {};
  const tz = db.settings.tz;
  const today = (await q(`SELECT (now() AT TIME ZONE $1)::date::text d`, [tz])).rows[0].d;
  const days = []; for (let i = n - 1; i >= 0; i--) { const x = new Date(today + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - i); days.push(x.toISOString().slice(0, 10)); }
  const sums = (await q(`SELECT c.driver_id, c.kind, s.day::text AS day, s.mood, s.summary FROM tg_summaries s JOIN tg_chats c ON c.chat_id = s.chat_id WHERE c.driver_id = ANY($1::int[]) AND s.day >= $2::date`, [ids, days[0]])).rows;
  const al = (await q(`SELECT driver_id, (at AT TIME ZONE $3)::date::text AS day, kind, severity, text FROM tg_alerts WHERE driver_id = ANY($1::int[]) AND (at AT TIME ZONE $3)::date >= $2::date ${admin ? '' : "AND kind <> 'unprofessional_dispatcher'"}`, [ids, days[0], tz])).rows;
  const out = {};
  for (const id of ids) out[id] = days.map((day) => ({ day, mood: null, alerts: 0, high: 0, notes: [] }));
  const at = (id, day) => (out[id] || []).find((x) => x.day === day);
  for (const r of sums) { const x = at(r.driver_id, r.day); if (!x) continue; if (r.mood && (RANK[r.mood] || 0) > (RANK[x.mood] || -1)) x.mood = r.mood; if (r.summary) x.notes.push(r.summary); }
  for (const a of al) { const x = at(a.driver_id, a.day); if (!x) continue; x.alerts++; if (a.severity === 'high') x.high++; if (a.kind === 'driver_upset' && (RANK[x.mood] || 0) < RANK.unhappy) x.mood = 'unhappy'; }
  return out;
}
const issue = (m) => (m || []).some((x) => x.mood === 'unhappy' || x.mood === 'angry' || x.high > 0);

module.exports = (app) => {
  app.get('/api/active', needUser, wrap(async (req, res) => {
    const params = []; const vis = visSql(req.user, params);
    const cols = `d.id, d.name, d.phones, d.mode, d.location, d.company_id, d.owner_id, d.truck_year, d.truck_model, d.cdl_expires, d.med_expires, d.weeks_out, d.days_home, d.out_since,
      d.left_on, d.left_reason, COALESCE(o.completed_at, d.status_at) hired_at, t.id truck_id, t.unit truck_unit, t.details truck_details`;
    const from = `FROM drivers d LEFT JOIN onboarding o ON o.driver_id = d.id LEFT JOIN trucks t ON t.driver_id = d.id WHERE d.status = 'Hired'${vis ? ' AND ' + vis : ''}`;
    const active = await q(`SELECT ${cols} ${from} AND d.left_on IS NULL ORDER BY lower(d.name)`, params);
    const left = await q(`SELECT ${cols} ${from} AND d.left_on IS NOT NULL AND d.left_on > now() - interval '180 days' ORDER BY d.left_on DESC`, params);
    const row = (d) => ({ id: d.id, name: d.name, phone: (d.phones || [])[0] || null, mode: d.mode, location: d.location, companyId: d.company_id, ownerId: d.owner_id,
      truck: d.truck_unit ? { id: d.truck_id, unit: d.truck_unit, details: d.truck_details } : null, ownTruck: [d.truck_year, d.truck_model].filter(Boolean).join(' ') || null,
      cdlExpires: d.cdl_expires, medExpires: d.med_expires, weeksOut: d.weeks_out === null ? null : +d.weeks_out, daysHome: d.days_home, outSince: d.out_since,
      hiredAt: d.hired_at, leftOn: d.left_on, leftReason: d.left_reason });
    const ids = active.rows.map((d) => d.id);
    const groups = ids.length ? (await q(`SELECT driver_id, kind, chat_id::text FROM tg_chats WHERE active AND driver_id = ANY($1::int[]) AND kind IS NOT NULL`, [ids])).rows : [];
    const tg = {}; for (const g of groups) (tg[g.driver_id] = tg[g.driver_id] || {})[g.kind] = g.chat_id;
    const md = await moods(ids, 3, req.user.role === 'admin');
    const oa = ids.length ? (await q(`SELECT driver_id, count(*)::int n FROM tg_alerts WHERE resolved_at IS NULL AND driver_id = ANY($1::int[]) ${req.user.role === 'admin' ? '' : "AND kind <> 'unprofessional_dispatcher'"} GROUP BY 1`, [ids])).rows : [];
    const openA = Object.fromEntries(oa.map((r) => [r.driver_id, r.n]));
    res.json({ today: await lib.today(), drivers: active.rows.map((d) => ({ ...row(d), groups: tg[d.id] || {}, mood: md[d.id], moodIssue: issue(md[d.id]), openAlerts: openA[d.id] || 0 })), left: left.rows.map(row) });
  }));

  // One active driver's own page: his three groups, his mood, what the bot noticed, alerts, his truck
  app.get('/api/active/:id', needUser, wrap(async (req, res) => {
    const d = await lib.loadDriver(req, res); if (!d) return;
    const admin = req.user.role === 'admin'; const tz = db.settings.tz;
    const o = (await q(`SELECT completed_at FROM onboarding WHERE driver_id = $1`, [d.id])).rows[0];
    const t = (await q(`SELECT * FROM trucks WHERE driver_id = $1`, [d.id])).rows[0];
    const fl = require('./fleet');
    const groups = (await q(`SELECT chat_id::text id, kind, title, last_at, (SELECT count(*)::int FROM tg_messages m WHERE m.chat_id = c.chat_id AND m.at > now() - interval '24 hours' AND NOT m.is_bot) today
      FROM tg_chats c WHERE driver_id = $1 AND active AND kind IS NOT NULL`, [d.id])).rows;
    const md = (await moods([d.id], 14, admin))[d.id];
    const sums = (await q(`SELECT s.day::text AS day, s.summary, s.mood, s.issues, c.kind FROM tg_summaries s JOIN tg_chats c ON c.chat_id = s.chat_id WHERE c.driver_id = $1 ORDER BY s.day DESC, c.kind LIMIT 30`, [d.id])).rows;
    const alerts = (await q(`SELECT id, chat_id::text chat_id, kind, severity, text, at, resolved_at, resolved_by FROM tg_alerts WHERE driver_id = $1 ${admin ? '' : "AND kind <> 'unprofessional_dispatcher'"} ORDER BY at DESC LIMIT 40`, [d.id])).rows;
    const notes = (await q(`SELECT kind, text, at FROM driver_notes WHERE driver_id = $1 ORDER BY at DESC LIMIT 60`, [d.id])).rows;
    const promises = (await q(`SELECT what, due, state, evidence, at FROM tg_promises WHERE driver_id = $1 ORDER BY at DESC LIMIT 20`, [d.id])).rows;
    const word = (await q(`SELECT count(*) FILTER (WHERE state = 'kept')::int kept, count(*) FILTER (WHERE state = 'broken')::int broken FROM tg_promises WHERE driver_id = $1 AND at > now() - interval '60 days'`, [d.id])).rows[0];
    const updates = (await q(`SELECT u.id, u.checked, u.status, u.place, u.eta, u.load_ref, u.by_role, u.at, u.chat_id::text chat_id FROM tg_updates u WHERE u.driver_id = $1 ORDER BY u.at DESC LIMIT 20`, [d.id])).rows;
    const evs = (await q(`SELECT e.id, e.kind, e.title, e.status, e.cost, e.paid, e.at, e.done_on::text done_on, t.unit FROM truck_events e LEFT JOIN trucks t ON t.id = e.truck_id WHERE e.driver_id = $1 ORDER BY e.at DESC LIMIT 15`, [d.id])).rows;
    res.json({
      driver: { id: d.id, name: d.name, phone: (d.phones || [])[0] || null, mode: d.mode, status: d.status, companyId: d.company_id, ownerId: d.owner_id, location: d.location,
        cdlExpires: d.cdl_expires, medExpires: d.med_expires, weeksOut: d.weeks_out === null ? null : +d.weeks_out, daysHome: d.days_home, outSince: d.out_since, leftOn: d.left_on,
        hiredAt: (o && o.completed_at) || d.status_at, ownTruck: [d.truck_year, d.truck_model].filter(Boolean).join(' ') || null },
      truck: t ? { id: t.id, unit: t.unit, details: t.details, oil: fl.oilStatus(t, (await fl.lastOils([t.id]))[t.id]) } : null,
      groups: groups.map((g) => ({ id: g.id, kind: g.kind, title: g.title, lastAt: g.last_at, today: g.today })),
      mood: md, moodIssue: issue(md.slice(-3)), summaries: sums.map((x) => ({ day: x.day, kind: x.kind, summary: x.summary, mood: x.mood, issues: x.issues || [] })),
      alerts: alerts.map((a) => ({ id: a.id, chatId: a.chat_id, kind: a.kind, severity: a.severity, text: a.text, at: a.at, resolved_at: a.resolved_at, resolved_by: a.resolved_by })),
      notes, updates, promises, word, truckEvents: evs.map((e) => ({ id: e.id, kind: e.kind, title: e.title, status: e.status, cost: e.cost === null ? null : +e.cost, paid: e.paid, day: e.done_on || null, at: e.at, unit: e.unit })),
      canLead: req.user.role !== 'dispatcher'
    });
  }));
};

module.exports.moods = moods;
