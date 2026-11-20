// Idle time: stretches inside a person's working hours with no activity on the website (computer only).
// A stretch counts once it reaches settings.hours.idleMinutes (15 by default). When it reaches idleAlert
// (60 by default) the person and every admin get an alert on the website.
// Before the first activity of the day nothing counts as idle: that is a late start, which the report shows already.
const db = require('./db');
const hours = require('./api-hours');
const { q } = db;

const cfg = () => ({ idle: (db.settings.hours.idleMinutes || 15) * 60000, alert: (db.settings.hours.idleAlert || 60) * 60000 });

// Today's working hours for each person, as real moments in time (team time zone), or nothing on a day off.
async function shifts(ids) {
  const tz = db.settings.tz;
  const t = (await q(`SELECT (now() AT TIME ZONE $1)::date::text d, extract(dow FROM (now() AT TIME ZONE $1))::int dow`, [tz])).rows[0];
  const people = (await q(`SELECT u.id, u.name, u.role, u.hours, u.last_active_at, EXISTS (SELECT 1 FROM days_off o WHERE o.user_id = u.id AND o.day = $1::date) off
    FROM users u WHERE u.active ${ids ? 'AND u.id = ANY($2::int[])' : ''}`, ids ? [t.d, ids] : [t.d])).rows;
  const out = [];
  for (const u of people) {
    const sch = hours.weekOf(u)[t.dow];
    if (!sch || u.off) continue;
    const r = (await q(`SELECT (($1::date + $2::time)::timestamp AT TIME ZONE $4) s, (($1::date + $3::time)::timestamp AT TIME ZONE $4) e`, [t.d, sch.s, sch.e, tz])).rows[0];
    out.push({ ...u, start: r.s, end: r.e });
  }
  return out;
}

// Record the stretch from the person's last activity up to `until` (or now), if it is long enough.
async function measure(u, until = new Date(), closing = false) {
  const { idle } = cfg();
  const la = u.last_active_at && new Date(u.last_active_at);
  if (!la || la < u.start) return null; // not started today (or not since the shift began)
  const from = la, to = new Date(Math.min(until.getTime(), u.end.getTime()));
  if (to - from < idle) return null;
  const open = !closing && Date.now() < u.end.getTime();
  return (await q(`INSERT INTO idle_spells (user_id, started_at, ended_at, shift_end, open) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, started_at) DO UPDATE SET ended_at = GREATEST(idle_spells.ended_at, EXCLUDED.ended_at), open = EXCLUDED.open RETURNING *`, [u.id, from, to, u.end, open])).rows[0];
}

const clock = (d) => new Date(d).toLocaleTimeString('en-US', { timeZone: db.settings.tz, hour: 'numeric', minute: '2-digit' });
const span = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} minutes` : `${Math.floor(m / 60)} hour${m >= 120 ? 's' : ''}${m % 60 ? ` ${m % 60} min` : ''}`; };

async function alertFor(u, spell) {
  const since = clock(spell.started_at); const long = span(Date.now() - new Date(spell.started_at).getTime());
  const admins = (await q(`SELECT id FROM users WHERE active AND role = 'admin' AND id <> $1`, [u.id])).rows;
  await q(`INSERT INTO notices (user_id, kind, text, link) VALUES ($1, 'idle', $2, '#/team/me')`,
    [u.id, `No activity on FleetHire for ${long}, since ${since}, during your working hours. If you are working somewhere else, open the website so your time counts.`]);
  for (const a of admins) await q(`INSERT INTO notices (user_id, kind, text, link) VALUES ($1, 'idle', $2, $3)`, [a.id, `${u.name} has had no activity on the website for ${long}, since ${since}, during working hours.`, `#/team/${u.id}`]);
  await q(`UPDATE idle_spells SET notified_at = now() WHERE id = $1`, [spell.id]);
  await q(`INSERT INTO activity (user_id, type, detail) VALUES ($1, 'idle', $2)`, [u.id, `No activity for ${long} since ${since}; the person and the admins were alerted`]).catch(() => {});
}

// Every minute: keep open stretches up to date, close the ones whose shift ended, and send alerts.
async function tick() {
  const { alert } = cfg();
  for (const u of await shifts()) {
    const sp = await measure(u);
    if (sp && sp.open && !sp.notified_at && Date.now() - new Date(sp.started_at).getTime() >= alert) await alertFor(u, sp);
  }
  await q(`UPDATE idle_spells SET open = false WHERE open AND shift_end <= now()`);
}

// The person is active again: finish the stretch that just ended.
async function onActive(userId, prevActive) {
  if (!prevActive || Date.now() - new Date(prevActive).getTime() < cfg().idle) return;
  const [u] = await shifts([userId]);
  if (u) await measure({ ...u, last_active_at: prevActive }, new Date(), true);
  await q(`UPDATE idle_spells SET open = false WHERE user_id = $1 AND open`, [userId]);
}

let timer = null;
function start() {
  if (timer) return;
  const run = () => tick().catch((e) => console.error('idle check', e.message));
  timer = setInterval(run, 60000); setTimeout(run, 5000);
}

module.exports = { tick, onActive, start, shifts, measure };
