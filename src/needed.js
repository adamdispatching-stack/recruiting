// What a driver verified on Amazon Relay still needs before they start:
//   no arrival date yet                              -> the arrival date
//   arriving within 3 days (or late, or arrived)     -> the company and the truck (owner-operators: their own truck noted)
// The lead's recruiter (or the admins, if nobody has the lead) gets a notification, at most once a day per driver
// unless what is missing changes. Checked every 30 minutes, and right after the lead or its onboarding changes.
const db = require('./db');
const lib = require('./lib');
const { q } = db;

const SOON = 3;
const SQL = `SELECT d.id, d.name, d.mode, d.owner_id, d.company_id, d.truck_year, d.truck_model, to_char(o.expected_arrival, 'YYYY-MM-DD') exp, to_char(o.arrived_on, 'YYYY-MM-DD') arr,
    EXISTS (SELECT 1 FROM trucks t WHERE t.driver_id = d.id) has_truck
  FROM drivers d JOIN onboarding o ON o.driver_id = d.id WHERE d.status = 'Onboarding' AND d.amazon_step = 'verified'`;
const days = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);

// ['arrival date'] or ['company', 'truck'] or [] for one driver row (as from SQL)
function neededOf(r, today) {
  if (!r.arr && !r.exp) return ['arrival date'];
  const soon = r.arr || days(today, r.exp) <= SOON; if (!soon) return [];
  const out = [];
  if (!r.company_id) out.push('company');
  const oo = r.mode === 'Owner-operators';
  if (oo ? !(r.has_truck || r.truck_year || r.truck_model) : !r.has_truck) out.push(oo ? 'their truck (year and model)' : 'truck');
  return out;
}
const join = (l) => (l.length < 2 ? l[0] : l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1]);
function textOf(r, need, today) {
  const when = r.arr ? 'has arrived' : !r.exp ? '' : days(today, r.exp) < 0 ? `was due ${lib.niceDate(r.exp)}` : days(today, r.exp) === 0 ? 'arrives today' : days(today, r.exp) === 1 ? 'arrives tomorrow' : `arrives ${lib.niceDate(r.exp)}`;
  return `${r.name} is verified on Amazon${when ? ' and ' + when : ''}: set the ${join(need)}`;
}

async function check(driverId) {
  const today = await lib.today(); const tz = db.settings.tz;
  const rows = (await q(SQL + (driverId ? ' AND d.id = $1' : ''), driverId ? [driverId] : [])).rows;
  let admins = null;
  for (const r of rows) {
    const need = neededOf(r, today); if (!need.length) continue;
    const text = textOf(r, need, today);
    const to = r.owner_id && !(await q(`SELECT 1 FROM users WHERE id = $1 AND NOT active`, [r.owner_id])).rows[0] ? [r.owner_id]
      : (admins = admins || (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((x) => x.id));
    for (const uid of to) {
      // once a day, unless what is missing changed
      const told = (await q(`SELECT 1 FROM notices WHERE user_id = $1 AND kind = 'needed' AND driver_id = $2 AND text = $3 AND (created_at AT TIME ZONE $4)::date = (now() AT TIME ZONE $4)::date`, [uid, r.id, text, tz])).rows[0];
      if (!told) await db.notify(db.pool, uid, 'needed', text, `#/driver/${r.id}`, { driverId: r.id, merge: true });
    }
  }
}
// For the onboarding list and a lead's page
async function neededFor(ids) {
  if (!ids.length) return {};
  const today = await lib.today();
  const rows = (await q(SQL + ' AND d.id = ANY($1::int[])', [ids])).rows;
  return Object.fromEntries(rows.map((r) => [r.id, neededOf(r, today)]).filter(([, n]) => n.length));
}
function start() {
  const run = () => check().catch((e) => console.error('needed check', e.message));
  setTimeout(run, 20000); setInterval(run, 30 * 60 * 1000);
}
module.exports = { check, neededFor, neededOf, start };
