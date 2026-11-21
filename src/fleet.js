// Trucks: mileage, when the oil is due, what each truck cost, and the oil change reminders.
const db = require('./db');
const { q } = db;

const DAY = 86400000;
// the day work was done, in the team's time zone ($2): what the history is sorted by
const DAY_SQL = `coalesce(done_on, (coalesce(fixed_at, at) AT TIME ZONE $2)::date)`;
const fleet = () => ({ oilMiles: 25000, oilDays: 90, warnMiles: 2500, warnDays: 10, askDriver: false, ...(db.settings.fleet || {}) });
const when = (e) => (e.done_on ? new Date(e.done_on + 'T12:00:00Z') : e.fixed_at || e.at);

// The latest mileage wins; an older or smaller reading never moves the odometer back.
async function setOdometer(truckId, miles, at = new Date()) {
  miles = Math.round(+miles);
  if (!truckId || !(miles > 0 && miles < 5000000)) return false;
  const r = await q(`UPDATE trucks SET odometer = $2, odometer_at = $3 WHERE id = $1 AND (odometer IS NULL OR odometer < $2) RETURNING id`, [truckId, miles, at]);
  return !!r.rows[0];
}

async function lastOils(ids) {
  if (!ids.length) return {};
  const r = await q(`SELECT DISTINCT ON (truck_id) id, truck_id, odometer, shop, cost, paid, at, fixed_at, done_on::text FROM truck_events
    WHERE truck_id = ANY($1::int[]) AND kind = 'oil_change' AND status = 'fixed' ORDER BY truck_id, ${DAY_SQL} DESC, odometer DESC NULLS LAST, id DESC`, [ids, db.settings.tz]);
  return Object.fromEntries(r.rows.map((e) => [e.truck_id, e]));
}
// state: ok | soon | overdue | unknown (no oil change on record yet)
function oilStatus(t, last) {
  const f = fleet();
  const every = { miles: t.oil_miles || f.oilMiles, days: t.oil_days || f.oilDays };
  if (!last) return { state: 'unknown', every, odometer: t.odometer, odometerAt: t.odometer_at };
  const lastAt = when(last);
  const dueDate = new Date(lastAt.getTime() + every.days * DAY);
  const daysLeft = Math.ceil((dueDate - Date.now()) / DAY);
  const dueMiles = last.odometer ? last.odometer + every.miles : null;
  const now = Math.max(t.odometer || 0, last.odometer || 0) || null;
  const milesLeft = dueMiles && now ? dueMiles - now : null;
  const state = (milesLeft !== null && milesLeft <= 0) || daysLeft <= 0 ? 'overdue' : (milesLeft !== null && milesLeft <= f.warnMiles) || daysLeft <= f.warnDays ? 'soon' : 'ok';
  return { state, every, last: { id: last.id, at: lastAt, odometer: last.odometer, shop: last.shop, cost: last.cost === null ? null : +last.cost, paid: last.paid },
    dueDate: dueDate.toISOString().slice(0, 10), daysLeft, dueMiles, milesLeft, odometer: now, odometerAt: t.odometer_at };
}
const oilText = (o) => {
  if (o.state === 'unknown') return 'no oil change on record';
  const parts = [];
  if (o.milesLeft !== null) parts.push(o.milesLeft <= 0 ? `${(-o.milesLeft).toLocaleString('en-US')} mi over` : `${o.milesLeft.toLocaleString('en-US')} mi left`);
  parts.push(o.daysLeft <= 0 ? `${-o.daysLeft} day${o.daysLeft === -1 ? '' : 's'} over` : `${o.daysLeft} day${o.daysLeft === 1 ? '' : 's'} left`);
  return (o.state === 'overdue' ? 'oil change overdue: ' : o.state === 'soon' ? 'oil change due soon: ' : 'oil change in ') + parts.join(', ');
};

// What a truck cost: this month, this year, all time, by kind, and what is not paid yet
async function costs(truckId) {
  const tz = db.settings.tz;
  const r = (await q(`SELECT kind, cost, paid, to_char(coalesce(done_on, (at AT TIME ZONE $2)::date), 'YYYY-MM-DD') d FROM truck_events WHERE truck_id = $1 AND cost IS NOT NULL`, [truckId, tz])).rows;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const month = today.slice(0, 7), year = today.slice(0, 4);
  const out = { month: 0, year: 0, all: 0, unpaid: 0, byKind: {} };
  for (const e of r) {
    const c = +e.cost; const d = e.d;
    out.all += c; if (d.startsWith(year)) out.year += c; if (d.startsWith(month)) out.month += c;
    if (e.paid === false) out.unpaid += c;
    out.byKind[e.kind] = (out.byKind[e.kind] || 0) + c;
  }
  for (const k of ['month', 'year', 'all', 'unpaid']) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}

// Once an hour: tell the truck's dispatcher (or every dispatcher) and the admins when an oil change is due soon or overdue,
// once for each state between two oil changes. With askDriver on, the bot asks for the mileage in the dispatch group.
async function remind() {
  const trucks = (await q(`SELECT t.*, d.name driver FROM trucks t LEFT JOIN drivers d ON d.id = t.driver_id WHERE NOT t.out_of_service`)).rows;
  const last = await lastOils(trucks.map((t) => t.id));
  const admins = (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id);
  const dispatchers = (await q(`SELECT id FROM users WHERE active AND role = 'dispatcher'`)).rows.map((r) => r.id);
  for (const t of trucks) {
    const o = oilStatus(t, last[t.id]);
    if (o.state !== 'soon' && o.state !== 'overdue') continue;
    const key = `${o.state}:${o.last.id}`;
    const ins = await q(`INSERT INTO truck_reminders (truck_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING truck_id`, [t.id, key]);
    if (!ins.rows[0]) continue;
    const to = new Set([...admins, ...(t.dispatcher_id ? [t.dispatcher_id] : dispatchers)]);
    const text = `Truck ${t.unit}${t.driver ? ` (${t.driver})` : ''}: ${oilText(o)}`;
    for (const id of to) await db.notify(db.pool, id, 'truck', text, '#/truck/' + t.id);
    if (fleet().askDriver && t.driver_id) await askMiles(t, o).catch((e) => console.error('oil ask', e.message));
  }
}
async function askMiles(t, o) {
  const bot = require('./tg/bot'); if (!bot.on() || !bot.state.me) return;
  const g = (await q(`SELECT chat_id FROM tg_chats WHERE driver_id = $1 AND kind = 'dispatch'`, [t.driver_id])).rows[0]; if (!g) return;
  const p = (await q(`SELECT * FROM tg_people WHERE role = 'driver' AND driver_id = $1 ORDER BY seen_at DESC LIMIT 1`, [t.driver_id])).rows[0];
  const who = p ? bot.tag(p) : `<b>${bot.esc(t.driver.split(/\s+/)[0])}</b>`;
  await bot.send(g.chat_id, `🛢 ${who}, truck ${bot.esc(t.unit)} is ${o.state === 'overdue' ? 'due' : 'almost due'} for an oil change (the last one was ${o.last.at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${o.last.odometer ? ` at ${o.last.odometer.toLocaleString('en-US')} mi` : ''}). What is the mileage now?`);
}
function start() {
  const run = () => remind().catch((e) => console.error('oil remind', e.message));
  setTimeout(run, +process.env.FLEET_TICK_MS || 20000); setInterval(run, +process.env.FLEET_TICK_MS || 3600000);
}
module.exports = { DAY_SQL, fleet, setOdometer, lastOils, oilStatus, oilText, costs, remind, start };
