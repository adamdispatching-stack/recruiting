// Activity tracking, the Team pages, and the dashboard.
const db = require('./db');
const lib = require('./lib');
const hours = require('./api-hours');
const { q } = db;
const { wrap, needUser, needAdmin, act, range } = lib;

const BEAT = 30; // seconds between the website's "I'm here" signals
const ENGAGED = ['Interested', 'Email collected', 'Relay invite sent', 'Signed up on Relay', 'Onboarding', 'Hired'];

// One row of numbers per person for a stretch of time. Effort (time, clicks, notes, calls) and results
// (their leads that moved to onboarding or got hired) are kept apart on purpose.
async function teamStats(r, userId = null) {
  const res = await q(`
    SELECT u.id, u.name, u.email, u.role, u.active, u.created_at, u.last_seen_at, u.last_visible_at, u.last_active_at,
      h.active_seconds, h.open_seconds, h.clicks, h.views, h.first_at, h.last_at, h.days_active,
      a.opened, a.notes, a.contacts, a.calls, a.added, a.followups, a.checks,
      f.forward, w.onboarded, w.hired, o.owned, o.due, o.cold, o.received, l.logins
    FROM users u
    LEFT JOIN LATERAL (SELECT COALESCE(sum(active_seconds), 0)::int active_seconds, COALESCE(sum(open_seconds), 0)::int open_seconds, COALESCE(sum(clicks), 0)::int clicks,
        COALESCE(sum(views), 0)::int views, min(first_at) first_at, max(last_at) last_at, count(DISTINCT (hour AT TIME ZONE $3)::date)::int days_active
      FROM activity_hours WHERE user_id = u.id AND hour >= $1 AND hour < $2) h ON TRUE
    LEFT JOIN LATERAL (SELECT count(DISTINCT driver_id) FILTER (WHERE type = 'open')::int opened, count(*) FILTER (WHERE type = 'note')::int notes,
        count(*) FILTER (WHERE type = 'contact')::int contacts, count(*) FILTER (WHERE type = 'contact' AND detail LIKE 'Call%')::int calls,
        count(*) FILTER (WHERE type = 'lead_add')::int added, count(*) FILTER (WHERE type = 'followup')::int followups, count(*) FILTER (WHERE type = 'check')::int checks
      FROM activity WHERE user_id = u.id AND at >= $1 AND at < $2) a ON TRUE
    LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE array_position($4::text[], to_status) > array_position($4::text[], from_status))::int forward
      FROM status_log WHERE user_id = u.id AND at >= $1 AND at < $2) f ON TRUE
    LEFT JOIN LATERAL (SELECT count(DISTINCT s.driver_id) FILTER (WHERE s.to_status = 'Onboarding')::int onboarded, count(DISTINCT s.driver_id) FILTER (WHERE s.to_status = 'Hired')::int hired
      FROM status_log s JOIN drivers d ON d.id = s.driver_id WHERE d.owner_id = u.id AND s.at >= $1 AND s.at < $2) w ON TRUE
    LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE status = ANY($5::text[]))::int owned, count(*) FILTER (WHERE follow_up IS NOT NULL AND follow_up <= $6::date)::int due,
        count(*) FILTER (WHERE status = ANY($5::text[]) AND follow_up IS NULL AND updated_at < now() - make_interval(days => $7::int))::int cold,
        count(*) FILTER (WHERE COALESCE(assigned_at, lead_at, created_at) >= $1 AND COALESCE(assigned_at, lead_at, created_at) < $2 AND status <> 'Invited')::int received
      FROM drivers WHERE owner_id = u.id) o ON TRUE
    LEFT JOIN LATERAL (SELECT count(*)::int logins FROM logins WHERE user_id = u.id AND kind = 'in' AND at >= $1 AND at < $2) l ON TRUE
    WHERE ($8::int IS NULL OR u.id = $8::int)
    ORDER BY u.active DESC, lower(u.name)`,
  [r.from, r.to, r.tz, db.ROUTE, db.ACTIVE, r.today, db.COLD_DAYS, userId]);
  return res.rows.map((x) => ({ id: x.id, name: x.name, email: x.email, role: x.role, active: x.active, createdAt: x.created_at,
    lastSeenAt: x.last_seen_at, lastVisibleAt: x.last_visible_at, lastActiveAt: x.last_active_at,
    activeSeconds: x.active_seconds, openSeconds: x.open_seconds, clicks: x.clicks, views: x.views, firstAt: x.first_at, lastAt: x.last_at, daysActive: x.days_active,
    opened: x.opened, notes: x.notes, contacts: x.contacts, calls: x.calls, added: x.added, followups: x.followups, checks: x.checks,
    forward: x.forward, onboarded: x.onboarded, hired: x.hired, owned: x.owned, due: x.due, cold: x.cold, received: x.received, logins: x.logins }));
}

const feedRow = (a) => ({ id: a.id, at: a.at, type: a.type, userId: a.user_id, user: a.user_name, driverId: a.driver_id, driver: a.driver_name, text: a.detail });
function browserOf(ua) {
  const s = String(ua || ''); if (!s) return '';
  const b = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Browser';
  const o = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iPhone or iPad' : /Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : '';
  return o ? `${b} on ${o}` : b;
}

module.exports = (app) => {
  // ---------- "I'm here" signal ----------
  // Sent every 30 seconds while the site is open. A signal counts as active time only when the page was on
  // screen and the person clicked, typed, scrolled or moved the mouse since the last one. Time is credited
  // by the clock, so two open tabs never count twice.
  app.post('/api/beat', needUser, wrap(async (req, res) => {
    const b = req.body || {}; const u = req.user; const now = Date.now();
    const visible = b.visible !== false; const active = !!b.active && visible;
    const clicks = Math.max(0, Math.min(600, parseInt(b.clicks, 10) || 0));
    const since = (t) => (t ? Math.round((now - new Date(t).getTime()) / 1000) : 1e9);
    const worked = active && !b.start ? Math.max(0, Math.min(BEAT, since(u.last_active_at))) : 0;
    const open = visible && !b.start ? Math.max(worked, Math.min(BEAT, since(u.last_visible_at))) : 0; // active time is always part of the time on site
    await q(`UPDATE users SET last_seen_at = now(), last_visible_at = CASE WHEN $2 THEN now() ELSE last_visible_at END, last_active_at = CASE WHEN $3 THEN now() ELSE last_active_at END WHERE id = $1`, [u.id, visible, active]);
    if (visible || clicks) {
      await q(`INSERT INTO activity_hours (user_id, hour, active_seconds, open_seconds, clicks) VALUES ($1, date_trunc('hour', now()), $2, $3, $4)
        ON CONFLICT (user_id, hour) DO UPDATE SET active_seconds = LEAST(3600, activity_hours.active_seconds + EXCLUDED.active_seconds),
          open_seconds = LEAST(3600, activity_hours.open_seconds + EXCLUDED.open_seconds), clicks = activity_hours.clicks + EXCLUDED.clicks, last_at = now()`, [u.id, worked, open, clicks]);
    }
    res.json({ ok: true });
  }));
  // A page was opened. Opening a lead is also written to the person's feed (once per 10 minutes per lead).
  app.post('/api/track', needUser, wrap(async (req, res) => {
    const path = String((req.body || {}).path || '').slice(0, 120);
    await q(`INSERT INTO activity_hours (user_id, hour, views) VALUES ($1, date_trunc('hour', now()), 1)
      ON CONFLICT (user_id, hour) DO UPDATE SET views = activity_hours.views + 1, last_at = now()`, [req.user.id]);
    const m = path.match(/^#\/driver\/(\d+)$/);
    if (m) {
      const d = (await q(`SELECT id, name, owner_id FROM drivers WHERE id = $1`, [+m[1]])).rows[0];
      if (d && lib.canSee(req.user, d)) {
        const recent = await q(`SELECT 1 FROM activity WHERE user_id = $1 AND type = 'open' AND driver_id = $2 AND at > now() - interval '10 minutes' LIMIT 1`, [req.user.id, d.id]);
        if (!recent.rows[0]) await act(req.user, 'open', d, 'Opened the lead');
      }
    }
    res.json({ ok: true });
  }));

  // ---------- Team ----------
  app.get('/api/team', needUser, needAdmin, wrap(async (req, res) => {
    const r = await range(req.query.period);
    const people = await teamStats(r);
    const att = await hours.attendance(await hours.loadPeople(people.map((p) => p.id)), r.fromDate, r.toDate);
    for (const p of people) { const a = att[p.id]; p.att = a.totals; p.weekText = a.weekText; if (r.days === 1) { const d = a.days[0]; p.day = { status: d.status, late: d.late, early: d.early, sch: d.sch, offReason: d.offReason }; } }
    res.json({ now: new Date().toISOString(), period: r.period, days: r.days, tz: r.tz, today: r.today, people });
  }));
  // One person: numbers, time by hour or by day, sign-ins, and everything they did. Admins see anyone; a recruiter sees their own page.
  app.get('/api/team/:id', needUser, wrap(async (req, res) => {
    const id = req.params.id === 'me' ? req.user.id : +req.params.id;
    if (req.user.role !== 'admin' && id !== req.user.id) return res.status(403).json({ error: 'Only an admin can see other people' });
    const r = await range(req.query.period);
    const [person] = await teamStats(r, id);
    if (!person) return res.status(404).json({ error: 'Person not found' });
    { const a = (await hours.attendance(await hours.loadPeople([id]), r.fromDate, r.toDate))[id]; person.att = a.totals; person.weekText = a.weekText;
      if (r.days === 1) { const d = a.days[0]; person.day = { status: d.status, late: d.late, early: d.early, sch: d.sch, offReason: d.offReason }; } }
    const byHour = r.days === 1;
    const series = byHour
      ? await q(`SELECT to_char(g AT TIME ZONE $4, 'FMHH12 AM') label, COALESCE(h.active_seconds, 0)::int active, COALESCE(h.open_seconds, 0)::int open, COALESCE(h.clicks, 0)::int clicks, COALESCE(h.views, 0)::int views
          FROM generate_series($2::timestamptz, $3::timestamptz - interval '1 hour', interval '1 hour') g LEFT JOIN activity_hours h ON h.user_id = $1 AND h.hour >= g AND h.hour < g + interval '1 hour' ORDER BY g`, [id, r.from, r.to, r.tz])
      : await q(`SELECT to_char(g, 'Dy FMMon FMDD') label, COALESCE(s.active, 0)::int active, COALESCE(s.open, 0)::int open, COALESCE(s.clicks, 0)::int clicks, COALESCE(s.views, 0)::int views
          FROM generate_series(($2::timestamptz AT TIME ZONE $4)::date, ($3::timestamptz AT TIME ZONE $4)::date - 1, interval '1 day') g
          LEFT JOIN (SELECT (hour AT TIME ZONE $4)::date d, sum(active_seconds) active, sum(open_seconds) open, sum(clicks) clicks, sum(views) views FROM activity_hours WHERE user_id = $1 AND hour >= $2 AND hour < $3 GROUP BY 1) s ON s.d = g::date
          ORDER BY g`, [id, r.from, r.to, r.tz]);
    const logins = await q(`SELECT at, kind, ip, ua FROM logins WHERE user_id = $1 AND at >= $2 AND at < $3 ORDER BY at DESC LIMIT 100`, [id, r.from, r.to]);
    const feed = await q(`SELECT a.*, u.name user_name FROM activity a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1 AND a.at >= $2 AND a.at < $3 ORDER BY a.at DESC LIMIT 300`, [id, r.from, r.to]);
    res.json({ now: new Date().toISOString(), period: r.period, days: r.days, tz: r.tz, today: r.today, person, unit: byHour ? 'hour' : 'day', series: series.rows,
      logins: logins.rows.map((l) => ({ at: l.at, kind: l.kind, ip: req.user.role === 'admin' ? l.ip : undefined, browser: browserOf(l.ua) })), feed: feed.rows.map(feedRow) });
  }));

  // ---------- Dashboard ----------
  app.get('/api/dashboard', needUser, wrap(async (req, res) => {
    const u = req.user; const tz = db.settings.tz; const day = await range('today'); const now = new Date().toISOString();
    if (u.role !== 'admin') {
      // A recruiter's own day: who to call, what is going cold, and the same numbers the manager sees.
      const [stats] = await teamStats(day, u.id);
      const calls = await q(`SELECT id, name, status, phones, follow_up, mode, location, (SELECT ${lib.NOTE_TEXT} FROM notes n WHERE n.driver_id = d.id ORDER BY n.updated_at DESC LIMIT 1) last_note
        FROM drivers d WHERE d.owner_id = $1 AND d.follow_up IS NOT NULL AND d.follow_up <= $2::date ORDER BY d.follow_up, d.updated_at DESC LIMIT 40`, [u.id, day.today]);
      const cold = await q(`SELECT id, name, status, phones, updated_at FROM drivers d WHERE d.owner_id = $1 AND d.status = ANY($2::text[]) AND d.follow_up IS NULL AND d.updated_at < now() - make_interval(days => $3::int) ORDER BY d.updated_at LIMIT 15`, [u.id, db.ACTIVE, db.COLD_DAYS]);
      const pipe = await q(`SELECT status, count(*)::int n FROM drivers WHERE owner_id = $1 GROUP BY 1`, [u.id]);
      const pool = await q(`SELECT count(*)::int n FROM drivers d WHERE ${lib.unownedSql()} AND status = ANY($1::text[])`, [db.ACTIVE]);
      const onb = await q(`SELECT d.id, d.name, o.expected_arrival, o.arrived_on, (SELECT count(*) FROM checklist c WHERE c.driver_id = d.id)::int total, (SELECT count(*) FROM checklist c WHERE c.driver_id = d.id AND c.done)::int done
        FROM drivers d JOIN onboarding o ON o.driver_id = d.id WHERE d.owner_id = $1 AND d.status = 'Onboarding' ORDER BY o.expected_arrival NULLS LAST`, [u.id]);
      return res.json({ role: 'member', now, today: day.today, tz, stats,
        calls: calls.rows.map((d) => ({ id: d.id, name: d.name, status: d.status, phones: d.phones, followUp: d.follow_up, mode: d.mode, location: d.location, lastNote: d.last_note })),
        cold: cold.rows.map((d) => ({ id: d.id, name: d.name, status: d.status, phones: d.phones, updatedAt: d.updated_at })),
        pipeline: pipe.rows, unassigned: pool.rows[0].n,
        onboarding: onb.rows.map((d) => ({ id: d.id, name: d.name, expectedArrival: d.expected_arrival, arrivedOn: d.arrived_on, total: d.total, done: d.done })) });
    }
    const att = (await q(`SELECT
        (SELECT count(*) FROM drivers WHERE follow_up IS NOT NULL AND follow_up <= t.today)::int due,
        (SELECT count(*) FROM drivers d WHERE ${lib.unownedSql()} AND status = ANY($2::text[]))::int unassigned,
        (SELECT count(*) FROM drivers WHERE status = ANY($2::text[]) AND follow_up IS NULL AND updated_at < now() - make_interval(days => $3::int))::int cold,
        (SELECT count(*) FROM drivers d JOIN onboarding o ON o.driver_id = d.id WHERE d.status = 'Onboarding' AND o.arrived_on IS NULL AND o.expected_arrival BETWEEN t.today AND t.today + 7)::int arriving,
        (SELECT count(*) FROM drivers d JOIN onboarding o ON o.driver_id = d.id WHERE d.status = 'Onboarding' AND o.arrived_on IS NULL AND o.expected_arrival < t.today)::int late,
        (SELECT count(*) FROM drivers d JOIN onboarding o ON o.driver_id = d.id WHERE d.status = 'Onboarding' AND o.progress_at < now() - interval '3 days' AND EXISTS (SELECT 1 FROM checklist c WHERE c.driver_id = d.id AND NOT c.done))::int stuck,
        (SELECT count(*) FROM drivers d WHERE d.status = 'Onboarding' AND EXISTS (SELECT 1 FROM checklist c WHERE c.driver_id = d.id) AND NOT EXISTS (SELECT 1 FROM checklist c WHERE c.driver_id = d.id AND NOT c.done))::int ready,
        (SELECT count(*) FROM drivers WHERE status = 'Onboarding')::int onboarding,
        (SELECT count(*) FROM trucks WHERE driver_id IS NULL AND driver_name IS NULL AND NOT out_of_service)::int empty_trucks,
        (SELECT count(*) FROM trucks)::int trucks,
        (SELECT count(*) FROM drivers WHERE status = 'Hired' AND left_on IS NULL)::int active_drivers,
        (SELECT count(*) FROM drivers WHERE status = 'Hired' AND left_on IS NULL AND (cdl_expires <= t.today + 30 OR med_expires <= t.today + 30))::int expiring,
        (SELECT count(*) FROM drivers WHERE status = 'Hired' AND left_on IS NULL AND (cdl_expires IS NULL OR med_expires IS NULL))::int missing_docs,
        (SELECT count(*) FROM drivers WHERE status = 'Hired' AND left_on IS NULL AND out_since IS NOT NULL AND weeks_out IS NOT NULL AND out_since + round(weeks_out * 7)::int <= t.today + 3)::int due_home
      FROM (SELECT (now() AT TIME ZONE $1)::date today) t`, [tz, db.ACTIVE, db.COLD_DAYS])).rows[0];
    const pipe = await q(`SELECT status, count(*)::int n FROM drivers GROUP BY 1`);
    const week = await range('7d'); const month = await range('30d');
    const moved = (await q(`SELECT
        (SELECT count(*) FROM drivers WHERE lead_at >= $1 AND lead_at < $2)::int new_leads,
        (SELECT count(DISTINCT driver_id) FROM status_log WHERE at >= $1 AND at < $2 AND array_position($5::text[], to_status) > array_position($5::text[], from_status) AND to_status = ANY($6::text[]))::int forward,
        (SELECT count(DISTINCT driver_id) FROM status_log WHERE at >= $3 AND at < $4 AND to_status = 'Onboarding')::int onboarded,
        (SELECT count(DISTINCT driver_id) FROM status_log WHERE at >= $3 AND at < $4 AND to_status = 'Hired')::int hired`,
      [week.from, week.to, month.from, month.to, db.ROUTE, ENGAGED])).rows[0];
    const sources = await q(`SELECT COALESCE(source, 'Not set') source, count(*)::int leads, count(*) FILTER (WHERE status = ANY($3::text[]))::int engaged, count(*) FILTER (WHERE status IN ('Onboarding', 'Hired'))::int won
      FROM drivers WHERE lead_at >= $1 AND lead_at < $2 GROUP BY 1 ORDER BY 2 DESC, 1`, [month.from, month.to, ENGAGED]);
    const lost = await q(`SELECT COALESCE(NULLIF(lost_reason, ''), CASE WHEN status IN ('No CDL', 'Declined on Indeed') THEN status ELSE 'No reason given' END) reason, count(*)::int n FROM drivers d
      WHERE status = ANY($1::text[]) AND EXISTS (SELECT 1 FROM status_log s WHERE s.driver_id = d.id AND s.at >= $2 AND s.to_status = d.status) GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`, [db.LOST.concat('Stalled'), month.from]);
    const feed = await q(`SELECT a.*, u.name user_name FROM activity a JOIN users u ON u.id = a.user_id WHERE a.type NOT IN ('open', 'logout') ORDER BY a.at DESC LIMIT 40`);
    res.json({ role: 'admin', now, today: day.today, tz,
      attention: { due: att.due, unassigned: att.unassigned, cold: att.cold, arriving: att.arriving, late: att.late, stuck: att.stuck, ready: att.ready, onboarding: att.onboarding, emptyTrucks: att.empty_trucks, trucks: att.trucks,
        activeDrivers: att.active_drivers, expiring: att.expiring, missingDocs: att.missing_docs, dueHome: att.due_home },
      pipeline: pipe.rows, week: { newLeads: moved.new_leads, forward: moved.forward }, month: { onboarded: moved.onboarded, hired: moved.hired },
      team: await teamStats(day), sources: sources.rows, lost: lost.rows, feed: feed.rows.map(feedRow) });
  }));
};
module.exports.teamStats = teamStats;
