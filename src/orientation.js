// Orientation day: the first day of a new driver (truck handed over, ELD, fuel card, Relay app, tolls, the safety talk,
// pay once more, the first load). Made when he arrives; the dispatcher ticks the steps (active driver page, lead page),
// and the bot ticks the ones the driver's group shows done.
const db = require('./db');
const { q } = db;
async function ensure(driverId) {
  const o = (await q(`SELECT arrived_on FROM onboarding WHERE driver_id = $1`, [driverId])).rows[0];
  if (!o || !o.arrived_on || new Date(o.arrived_on) < Date.now() - 30 * 864e5) return; // only new drivers, not those working for months
  let i = 0;
  for (const it of db.settings.orientation || []) await q(`INSERT INTO orientation (driver_id, key, label, position) VALUES ($1, $2, $3, $4) ON CONFLICT (driver_id, key) DO NOTHING`, [driverId, it.key, it.label, i++]);
}
const list = async (driverId) => (await q(`SELECT key, label, done, done_at, done_by FROM orientation WHERE driver_id = $1 ORDER BY position`, [driverId])).rows;
async function tick(driverId, key, done, by) {
  const r = (await q(`UPDATE orientation SET done = $3, done_at = CASE WHEN $3 THEN now() END, done_by = CASE WHEN $3 THEN $4 END WHERE driver_id = $1 AND key = $2 AND done <> $3 RETURNING label`, [driverId, key, !!done, by])).rows[0];
  if (r) await require('./lib').history(driverId, `Orientation day: ${r.label}${done ? '' : ' (not done)'}`, by, 'check').catch(() => {});
  return r;
}
// for the AI: the steps still open
async function openFor(driverId) { return (await list(driverId)).filter((x) => !x.done); }
module.exports = { ensure, list, tick, openFor };
