// Sharing new leads evenly between recruiters.
// The next lead goes to the recruiter who has been given the fewest leads today; ties go to the fewest in the
// last 7 days, then to whoever got one longest ago. Leads a recruiter added themselves don't count, so finding
// your own leads never costs you shared ones. Someone on a day off, or not working today, is skipped
// (when nobody is working today, everyone in the rotation takes turns).
const db = require('./db');
const hours = require('./api-hours');

async function standings(c = db.pool) {
  const cfg = db.settings.share || {};
  const tz = db.settings.tz;
  const r = await c.query(`
    WITH t AS (SELECT (now() AT TIME ZONE $1)::date d)
    SELECT u.id, u.name, u.role, u.hours, extract(dow FROM t.d)::int dow,
      EXISTS (SELECT 1 FROM days_off o WHERE o.user_id = u.id AND o.day = t.d) off,
      (SELECT count(*)::int FROM drivers d WHERE d.owner_id = u.id AND d.created_by IS DISTINCT FROM u.id AND d.assigned_at >= (t.d::timestamp AT TIME ZONE $1)) today,
      (SELECT count(*)::int FROM drivers d WHERE d.owner_id = u.id AND d.created_by IS DISTINCT FROM u.id AND d.assigned_at >= now() - interval '7 days') week,
      (SELECT max(d.assigned_at) FROM drivers d WHERE d.owner_id = u.id AND d.created_by IS DISTINCT FROM u.id) last
    FROM users u, t WHERE u.active ORDER BY lower(u.name)`, [tz]);
  const inRotation = (u) => (Array.isArray(cfg.people) ? cfg.people.includes(u.id) && u.role !== 'dispatcher' : u.role === 'member');
  return r.rows.filter(inRotation).map((u) => {
    const week = hours.weekOf(u);
    return { id: u.id, name: u.name, today: u.today, week: u.week, last: u.last, off: u.off, working: !u.off && !!week[u.dow] };
  });
}
const order = (a, b) => a.today - b.today || a.week - b.week || (a.last ? +new Date(a.last) : 0) - (b.last ? +new Date(b.last) : 0) || a.id - b.id;
// The recruiter the next lead goes to, or null when nobody is in the rotation.
async function pick(c = db.pool) {
  const all = await standings(c);
  const on = all.filter((x) => x.working);
  const pool = on.length ? on : all.filter((x) => !x.off).length ? all.filter((x) => !x.off) : all;
  return pool.length ? pool.sort(order)[0].id : null;
}
module.exports = { standings, pick, order };
