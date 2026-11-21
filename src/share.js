// Sharing new leads evenly between recruiters.
// The next lead goes to the recruiter who has been given the fewest leads today; ties go to the fewest in the
// last 7 days, then to whoever got one longest ago. Leads a recruiter added themselves don't count, so finding
// your own leads never costs you shared ones.
// Only recruiters working right now get leads (onlyOnline): active on the website in the last ONLINE_MIN minutes
// and not on a day off. A lead that comes in while nobody is working waits, and goes to the first ones who start.
// A new lead its recruiter has not opened after moveAfter minutes, while they are away, goes to someone working.
const db = require('./db');
const hours = require('./api-hours');

const ONLINE_MIN = 20;
const cfg = () => ({ on: true, people: null, onlyOnline: true, moveAfter: 60, ...(db.settings.share || {}) });

async function standings(c = db.pool) {
  const s = cfg();
  const tz = db.settings.tz;
  const r = await c.query(`
    WITH t AS (SELECT (now() AT TIME ZONE $1)::date d)
    SELECT u.id, u.name, u.role, u.hours, extract(dow FROM t.d)::int dow, u.last_active_at,
      (u.last_active_at > now() - make_interval(mins => $2::int)) online,
      EXISTS (SELECT 1 FROM days_off o WHERE o.user_id = u.id AND o.day = t.d) off,
      (SELECT count(*)::int FROM drivers d WHERE d.owner_id = u.id AND d.created_by IS DISTINCT FROM u.id AND d.assigned_at >= (t.d::timestamp AT TIME ZONE $1)) today,
      (SELECT count(*)::int FROM drivers d WHERE d.owner_id = u.id AND d.created_by IS DISTINCT FROM u.id AND d.assigned_at >= now() - interval '7 days') week,
      (SELECT max(d.assigned_at) FROM drivers d WHERE d.owner_id = u.id AND d.created_by IS DISTINCT FROM u.id) last
    FROM users u, t WHERE u.active ORDER BY lower(u.name)`, [tz, ONLINE_MIN]);
  const inRotation = (u) => (Array.isArray(s.people) ? s.people.includes(u.id) && u.role !== 'dispatcher' : u.role === 'member');
  return r.rows.filter(inRotation).map((u) => {
    const week = hours.weekOf(u);
    return { id: u.id, name: u.name, today: u.today, week: u.week, last: u.last, off: u.off, working: !u.off && !!week[u.dow], online: !u.off && !!u.online, lastActive: u.last_active_at };
  });
}
const order = (a, b) => a.today - b.today || a.week - b.week || (a.last ? +new Date(a.last) : 0) - (b.last ? +new Date(b.last) : 0) || a.id - b.id;
// The recruiter the next lead goes to, or null.
// For new leads (default): with onlyOnline, only someone working right now; null means the lead waits.
// anyone: an admin's own action ("share now", a lead added with "share"): falls back to the work schedule.
async function pick(c = db.pool, { anyone = false, not = null } = {}) {
  const all = (await standings(c)).filter((x) => x.id !== not);
  const online = all.filter((x) => x.online);
  if (cfg().onlyOnline && !anyone) return online.length ? online.sort(order)[0].id : null;
  const on = all.filter((x) => x.working);
  const pool = online.length ? online : on.length ? on : all.filter((x) => !x.off).length ? all.filter((x) => !x.off) : all;
  return pool.length ? pool.sort(order)[0].id : null;
}

const WAITING = (a) => `${require('./lib').unownedSql(a)} AND ${a}.status <> 'Hired' AND NOT (${a}.status = ANY($1::text[])) AND ${a}.created_at > now() - interval '3 days'`;
const history = (c, id, text) => c.query(`INSERT INTO driver_events (driver_id, type, text, who, fp) VALUES ($1, 'web', $2, 'Website', $3)`, [id, text, require('crypto').randomBytes(12).toString('hex')]);

// Every minute: leads that came in while nobody was working go to whoever is working now;
// a new lead nobody opened goes from a recruiter who is away to one who is working.
async function tick() {
  const s = cfg(); if (!s.on) return { given: 0, moved: 0 };
  let given = 0, moved = 0;
  const c = await db.pool.connect();
  try {
    if (s.onlyOnline) {
      const wait = (await c.query(`SELECT d.id, d.name FROM drivers d WHERE ${WAITING('d')} ORDER BY d.created_at LIMIT 200`, [db.LOST])).rows;
      for (const d of wait) {
        const to = await pick(c); if (!to) break;
        const r = await c.query(`UPDATE drivers SET owner_id = $2, assigned_at = now() WHERE id = $1 AND owner_id IS NULL RETURNING id`, [d.id, to]); if (!r.rows[0]) continue;
        const who = (await c.query(`SELECT name FROM users WHERE id = $1`, [to])).rows[0].name;
        await history(c, d.id, `Assigned to ${who} (leads shared evenly, the first one working)`);
        await db.notify(c, to, 'lead_new', `New lead for you: ${d.name}, from Indeed`, `#/driver/${d.id}`, { driverId: d.id });
        given++;
      }
    }
    if (s.moveAfter > 0) {
      // shared to them (not their own), new, never opened or touched by them, and they are away now; moved at most twice
      const stale = (await c.query(`SELECT d.id, d.name, d.owner_id, u.name owner FROM drivers d JOIN users u ON u.id = d.owner_id
        WHERE d.assigned_at < now() - make_interval(mins => $2::int) AND d.assigned_at > now() - interval '1 day' AND d.created_by IS DISTINCT FROM d.owner_id AND d.share_moves < 2
          AND d.status = ANY($1::text[]) AND NOT (u.last_active_at > now() - make_interval(mins => $3::int))
          AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.user_id = d.owner_id AND a.driver_id = d.id AND a.at >= d.assigned_at)
          AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.user_id = d.owner_id AND n.driver_id = d.id AND n.created_at >= d.assigned_at)
        ORDER BY d.assigned_at LIMIT 100`, [db.FRESH, s.moveAfter, ONLINE_MIN])).rows;
      for (const d of stale) {
        const to = await pick(c, { not: d.owner_id }); if (!to) break;
        const r = await c.query(`UPDATE drivers SET owner_id = $2, assigned_at = now(), share_moves = share_moves + 1 WHERE id = $1 AND owner_id = $3 RETURNING id`, [d.id, to, d.owner_id]); if (!r.rows[0]) continue;
        const who = (await c.query(`SELECT name FROM users WHERE id = $1`, [to])).rows[0].name;
        await history(c, d.id, `Moved from ${d.owner} to ${who}: ${d.owner} was away and had not opened it in ${s.moveAfter} minutes`);
        await db.notify(c, to, 'lead_new', `New lead for you: ${d.name} (moved from ${d.owner}, who is away)`, `#/driver/${d.id}`, { driverId: d.id });
        await db.notify(c, d.owner_id, 'lead_moved', `${d.name} went to ${who}: you were away and had not opened it`, `#/driver/${d.id}`, { driverId: d.id });
        moved++;
      }
    }
  } finally { c.release(); }
  return { given, moved };
}
function start() {
  const run = () => tick().catch((e) => console.error('share tick', e.message));
  setTimeout(run, +process.env.SHARE_TICK_MS || 30000); setInterval(run, +process.env.SHARE_TICK_MS || 60000);
}
module.exports = { standings, pick, order, tick, start, cfg, ONLINE_MIN };
