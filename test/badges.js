// Test of the badges: five groups, five levels each, from recorded work. Levels are kept, and a new one is announced.
// Needs DATABASE_URL (it writes back-dated work straight into the database).
//   DATABASE_URL=... node test/badges.js http://localhost:3999 admin@example.com password
const [, , base = 'http://localhost:3999', email = 'admin@example.com', pw = 'test-password-123'] = process.argv;
const db = require('../src/db');
function session() {
  let cookie = '';
  return async (path, opts = {}) => {
    const r = await fetch(base + path, { method: opts.method || 'GET', headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, body: j };
  };
}
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const u = Date.now().toString().slice(-5);
(async () => {
  await db.migrate();
  const A = session(); await A('/api/login', { method: 'POST', body: { email, password: pw } });
  const em = `bea${u}@example.com`;
  const id = (await A('/api/users', { method: 'POST', body: { name: `Bea Badge${u}`, email: em, password: 'badge-pass-1234' } })).body.id;
  await A(`/api/team/${id}/hours`, { method: 'PUT', body: { week: Array.from({ length: 7 }, () => ({ s: '09:00', e: '17:00' })) } });
  await db.q(`UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1`, [id]);
  const tz = db.settings.tz;
  // 6 past days on time and to the end; 1 day late; 1 day leaving early
  const day = async (n, startMin, endMin) => {
    const d = (await db.q(`SELECT ((now() AT TIME ZONE $1)::date - $2::int)::text d`, [tz, n])).rows[0].d;
    const at = (m) => `(($1::date + interval '${m} minutes')::timestamp AT TIME ZONE $2)`;
    await db.q(`INSERT INTO activity_hours (user_id, hour, active_seconds, open_seconds, clicks, first_at, last_at) VALUES ($3, date_trunc('hour', ${at(startMin)}), 3000, 3000, 10, ${at(startMin)}, ${at(startMin + 50)})`, [d, tz, id]);
    await db.q(`INSERT INTO activity_hours (user_id, hour, active_seconds, open_seconds, clicks, first_at, last_at) VALUES ($3, date_trunc('hour', ${at(endMin - 30)}), 3000, 3000, 10, ${at(endMin - 30)}, ${at(endMin)})`, [d, tz, id]);
  };
  for (const n of [9, 8, 7, 6, 5, 4]) await day(n, 9 * 60 + 2, 17 * 60 + 5);
  await day(3, 10 * 60 + 30, 17 * 60 + 5); // late
  await day(2, 9 * 60 + 1, 15 * 60);      // left early
  const R = session(); await R('/api/login', { method: 'POST', body: { email: em, password: 'badge-pass-1234' } });
  // leads: 12 added, 60 calls (30 talked)
  for (let i = 0; i < 12; i++) await db.q(`INSERT INTO activity (user_id, type, detail) VALUES ($1, 'lead_add', 'Added the lead')`, [id]);
  for (let i = 0; i < 60; i++) await db.q(`INSERT INTO activity (user_id, type, detail) VALUES ($1, 'contact', $2)`, [id, i < 30 ? 'Call, talked' : 'Call, no answer']);
  // drivers: 2 hired (one still driving), onboarding 3, one verified on Relay
  const drv = async (name, status) => (await db.q(`INSERT INTO drivers (name, name_key, status, owner_id) VALUES ($1, $2, $3, $4) RETURNING id`, [name, `${name.toLowerCase()} ${u}`, status, id])).rows[0].id;
  const h1 = await drv(`Hank Hired${u}`, 'Hired'), h2 = await drv(`Lou Left${u}`, 'Hired'), o1 = await drv(`Ona Onb${u}`, 'Onboarding');
  for (const x of [h1, h2, o1]) await db.q(`INSERT INTO onboarding (driver_id, started_by, arrived_on) VALUES ($1, $2, current_date - 5)`, [x, id]);
  for (const x of [h1, h2]) await db.q(`INSERT INTO status_log (driver_id, from_status, to_status, user_id) VALUES ($1, 'Onboarding', 'Hired', $2)`, [x, id]);
  await db.q(`UPDATE drivers SET amazon_step = 'verified' WHERE id = $1`, [h1]);
  await db.q(`UPDATE drivers SET left_on = current_date - 1 WHERE id = $1`, [h2]);
  for (let i = 0; i < 26; i++) await db.q(`INSERT INTO checklist (driver_id, key, label, done, done_by, done_at) VALUES ($1, $2, 'Step', true, $3, now())`, [o1, 'k' + i + u, id]);

  let r = await R('/api/badges'); const b = () => Object.fromEntries(r.body.badges.map((x) => [x.id, x]));
  let B = b();
  ok(r.status === 200 && r.body.groups.length === 5 && r.body.badges.length >= 25 && r.body.badges.every((x) => x.need.length === 5), 'five groups, every badge with five levels');
  ok(B.early_bird.have === 7 && B.early_bird.level === 1 && B.early_bird.levelName === 'Bronze' && B.early_bird.next === 20, `Early bird: 7 on-time days, Bronze, Silver at 20 (have ${B.early_bird.have})`);
  ok(B.finisher.have === 7 && B.finisher.level === 1, `Strong finisher: 7 days to the end (the late day counts, the day she left early does not) (have ${B.finisher.have})`);
  ok(B.clockwork.have === 6 && B.clockwork.level === 1, `Like clockwork: 6 on time in a row, broken by the late day (have ${B.clockwork.have})`);
  ok(B.hard_worker.have === 13 && B.hard_worker.level === 0 && B.hard_worker.next === 25, `Hard worker: 13 hours, not yet (have ${B.hard_worker.have})`);
  ok(B.lead_finder.level === 1 && B.dialer.level === 1 && B.connector.level === 1, 'Leads: Lead finder, Dialer and Connector at Bronze');
  ok(B.closer.have === 2 && B.closer.level === 1 && B.fleet_builder.have === 1 && B.relay_ready.level === 1 && B.wheels_in.have === 3 && B.checklist_pro.level === 1 && B.onboarder.have === 3, 'Onboarding and Active drivers counted from her drivers');
  ok(r.body.earned === r.body.badges.reduce((a, x) => a + x.level, 0) && r.body.total === r.body.badges.length * 5, 'level totals add up');
  ok(!(await R('/api/notices')).body.notices.some((n) => n.kind === 'badge'), 'the first time, levels are recorded quietly (no flood of notifications)');

  // more work: Hard worker reaches Bronze -> one notification
  await db.q(`INSERT INTO activity_hours (user_id, hour, active_seconds, open_seconds, clicks) VALUES ($1, date_trunc('hour', now() - interval '20 days'), 3600, 3600, 1)`, [id]);
  for (let k = 0; k < 11; k++) await db.q(`INSERT INTO activity_hours (user_id, hour, active_seconds, open_seconds, clicks) VALUES ($1, date_trunc('hour', now() - interval '21 days') + ($2 || ' hours')::interval, 3600, 3600, 1)`, [id, k]);
  r = await R('/api/badges?fresh=1'); B = b();
  ok(B.hard_worker.have === 25 && B.hard_worker.level === 1, 'Hard worker: 25 hours, Bronze');
  const nn = (await R('/api/notices')).body.notices.filter((n) => n.kind === 'badge');
  ok(nn.length === 1 && /Hard worker, Bronze/.test(nn[0].text) && nn[0].link === '#/badges', 'one notification for the new level: ' + (nn[0] || {}).text);
  // a level is kept when the count drops (her driver left)
  await db.q(`UPDATE drivers SET left_on = current_date WHERE id = $1`, [h1]);
  r = await R('/api/badges?fresh=1'); B = b();
  ok(B.fleet_builder.have === 0 && B.fleet_builder.level === 1, 'Fleet builder keeps Bronze after the driver left');
  ok(r.body.recent.length && r.body.recent[0].id === 'hard_worker', 'latest badge listed first');
  // admin
  ok((await R(`/api/badges?user=${(await A('/api/me')).body.id}`)).status === 403, 'a recruiter cannot see another person');
  const T = (await A('/api/badges/team')).body; const me = T.people.find((p) => p.id === id);
  ok(me && me.earned === r.body.earned && me.groups.length === 5, 'the admin sees her levels on the team badges page');
  ok((await A(`/api/badges?user=${id}`)).body.person.id === id, 'the admin opens her badges');
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
