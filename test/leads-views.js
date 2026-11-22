// The Leads work views: due today, overdue (follow-up dates and call-back times), going cold, the stage filter.
//   node test/leads-views.js   (against a fresh server: /tmp/fresh.sh, DATABASE_URL set)
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  let cookie = '';
  const A = async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return r.json(); };
  await A('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  const { Client } = require('pg'); const pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect();
  const mk = async (name, status) => { const r = await A('/api/drivers', { method: 'POST', body: { name, phone: '21555' + String(Math.random()).slice(2, 7), source: 'Indeed' } }); await pg.query(`UPDATE drivers SET status = $2 WHERE id = $1`, [r.id, status]); return r.id; };
  const late = await mk('Late Follow', 'Replied'), today = await mk('Today Follow', 'Interested'), future = await mk('Future Follow', 'Interested');
  const cbSoon = await mk('Callback Soon', 'Replied'), cbMissed = await mk('Callback Missed', 'Replied'), cold = await mk('Cold One', 'Relay invite sent');
  const D = "(now() AT TIME ZONE 'America/New_York')::date";
  await pg.query(`UPDATE drivers SET follow_up = ${D} - 3 WHERE id = $1`, [late]);
  await pg.query(`UPDATE drivers SET follow_up = ${D} WHERE id = $1`, [today]);
  await pg.query(`UPDATE drivers SET follow_up = ${D} + 4 WHERE id = $1`, [future]);
  await pg.query(`UPDATE drivers SET callback_at = date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' + interval '23 hours 50 minutes', callback_state = 'due' WHERE id = $1`, [cbSoon]);
  await pg.query(`UPDATE drivers SET callback_at = now() - interval '2 hours', callback_state = 'due' WHERE id = $1`, [cbMissed]);
  await pg.query(`UPDATE drivers SET follow_up = NULL, updated_at = now() - interval '20 days' WHERE id = $1`, [cold]);
  const ids = async (qs) => (await A('/api/drivers?' + qs)).drivers.map((d) => d.id);
  const ov = await ids('overdue=1'), td = await ids('today=1'), cd = await ids('cold=1'), due = await ids('due=1&sort=due');
  ok(ov.length === 2 && ov.includes(late) && ov.includes(cbMissed), 'Overdue: a passed follow-up date and a call-back missed by 30+ minutes');
  ok(td.includes(today) && td.includes(cbSoon) && !td.includes(late) && !td.includes(future), 'Due today: today\'s follow-up and today\'s call-back, nothing overdue or later');
  ok(cd.length === 1 && cd[0] === cold, 'Going cold: in progress, no follow-up date, nothing new for days');
  ok(due.length === 4 && ov.every((x) => due.slice(0, 2).includes(x)), 'the old "follow-ups due" link = due today + overdue, overdue first');
  const r = await A('/api/drivers?status=Interested&today=1');
  const c = Object.fromEntries(r.counts.map((x) => [x.status, x]));
  ok(r.drivers.length === 1 && r.drivers[0].id === today && c.Replied.overdue === 2 && c.Interested.today === 1, 'the stage filter works with a view; the counts per stage carry today and overdue');
  const row = (await A('/api/drivers?overdue=1')).drivers.find((d) => d.id === late);
  ok(row.overdue === true && row.dueToday === false, 'each row says if it is overdue or due today');
  const onb = await mk('In Onboarding', 'Onboarding'), hired = await mk('Already Hired', 'Hired');
  const open = await ids('exclude=Onboarding,Hired&limit=500');
  ok(!open.includes(onb) && !open.includes(hired) && open.includes(late) && open.includes(cold), 'the default stage (still recruiting) leaves out onboarding and hired leads');
  ok((await ids('exclude=Onboarding,Hired&status=Onboarding')).includes(onb), 'picking a stage overrides it');
  await pg.end();
})();
