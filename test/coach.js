// Test of filling the trucks (empty trucks cost, credit, team goal), the morning plan, coaching, and call notes.
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const BASE = 'http://localhost:3999';
const DB = 'postgresql://postgres@localhost:5433/recruiting_test?host=/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
async function until(f, ms = 8000) { for (let i = 0; i < ms / 100; i++) { const v = await f().catch(() => null); if (v) return v; await sleep(100); } return null; }
(async () => {
  execSync('pkill -f "node src/serve[r].js" || true'); await sleep(500);
  execSync(`su postgres -c "psql -q -h /tmp -p 5433 -c 'DROP DATABASE IF EXISTS recruiting_test' -c 'CREATE DATABASE recruiting_test'"`, { stdio: 'ignore' });
  spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env: { ...process.env, DATABASE_URL: DB, PGSSL: 'off', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-password-123', PORT: '3999', TELEGRAM_BOT_TOKEN: '', COACH_TICK_MS: '1000' },
    stdio: ['ignore', fs.openSync('/tmp/server.log', 'w'), fs.openSync('/tmp/server.log', 'a')], detached: true }).unref();
  await until(async () => (await fetch(BASE + '/healthz')).ok, 15000);
  const jar = {};
  const as = (who) => async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: jar[who] || '' }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && /sid=/.test(sc)) jar[who] = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  const A = as('admin'), R = as('rita');
  await A('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  const rita = (await A('/api/users', { method: 'POST', body: { name: 'Rita Recruiter', email: 'rita@example.com', password: 'rita-pass-1234' } })).id;
  await R('/api/login', { method: 'POST', body: { email: 'rita@example.com', password: 'rita-pass-1234' } });
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  const notes = async (X) => ((await X('/api/notices')).notices || []).map((n) => n.text);

  // ---- empty trucks and what they cost
  const t1 = (await A('/api/trucks', { method: 'POST', body: { unit: '101' } })).id;
  const t2 = (await A('/api/trucks', { method: 'POST', body: { unit: '102' } })).id;
  await pg.query(`UPDATE truck_history SET at = now() - interval '10 days' WHERE truck_id = $1`, [t1]);
  let e = await R('/api/fleet/empty');
  ok(e.monthly === 8000 && Math.abs(e.perDay - 263.01) < 0.01, 'a truck costs $8,000 a month: $263.01 a day');
  const e1 = e.trucks.find((t) => t.id === t1);
  ok(e.count === 2 && e1.days === 10 && e1.lost === 2630 && e.losingPerDay === 526, 'two empty trucks: 101 empty 10 days, $2,630 lost; $526 a day for both');
  // a driver of Rita's is coming for truck 101, then starts
  const dv = (await R('/api/drivers', { method: 'POST', body: { name: 'Sam Starter', source: 'Indeed', phone: '2155550199' } })).id;
  await R('/api/drivers/' + dv, { method: 'PATCH', body: { status: 'Onboarding' } });
  await R(`/api/drivers/${dv}/onboarding`, { method: 'PATCH', body: { truckId: t1 } });
  e = await R('/api/fleet/empty');
  ok(e.trucks.find((t) => t.id === t1).coming && e.trucks.find((t) => t.id === t1).coming.owner === 'Rita Recruiter', 'truck 101: Sam is coming, Rita\'s driver');
  // last month Rita filled one (her best so far)
  await pg.query(`INSERT INTO truck_fills (truck_id, driver_id, user_id, unit, driver_name, at) VALUES ($1, NULL, $2, '102', 'Old Driver', now() - interval '40 days')`, [t2, rita]);
  await R('/api/drivers/' + dv, { method: 'PATCH', body: { status: 'Hired' } });
  const g = await R('/api/fleet/goal');
  ok(g.filled === 1 && g.fills[0].unit === '101' && g.fills[0].owner === 'Rita Recruiter', 'Sam started: truck 101 is filled, credit to Rita');
  ok(g.people.find((p) => p.id === rita).filled === 1 && g.people.find((p) => p.id === rita).best === 1, 'Rita: 1 this month, her best month 1');
  ok(g.target === 2 && !g.setByAdmin, 'the goal: the empty trucks plus those filled (2)');
  ok((await notes(A)).some((t) => /Truck 101 is filled: Sam Starter started\. Great work, Rita Recruiter!/.test(t)) && (await notes(R)).some((t) => /Truck 101 is filled/.test(t)), 'the whole team hears it');
  ok((await R('/api/fleet/empty')).count === 1, 'one empty truck left');
  ok((await R('/api/fleet/goal', { method: 'PUT', body: { target: 5 } })).status === 403 && (await A('/api/fleet/goal', { method: 'PUT', body: { target: 5 } })).target === 5, 'the admin sets the team goal: 5');
  const tp = await A('/api/trucks/' + t1);
  ok(tp.fills.length === 1 && tp.fills[0].owner === 'Rita Recruiter', 'the truck page: filled by Rita');
  ok((await A('/api/trucks')).trucks.find((t) => t.id === t1).lastFill.owner === 'Rita Recruiter', 'the trucks list too');
  await A('/api/fleet/settings', { method: 'PUT', body: { costLease: 4000 } });
  ok((await R('/api/fleet/empty')).monthly === 7000, 'costs are a setting');

  // ---- the morning plan
  const l1 = (await R('/api/drivers', { method: 'POST', body: { name: 'Plan Lead One', source: 'Indeed', phone: '2155550201', followUp: (await R('/api/plan')).day } })).id;
  const l2 = (await R('/api/drivers', { method: 'POST', body: { name: 'Plan Lead Two', source: 'Indeed', phone: '2155550202' } })).id;
  await R('/api/drivers/' + l2, { method: 'PATCH', body: { status: 'Interested' } });
  let p = await R('/api/plan');
  ok(p.needed && !p.plan && p.suggestions.some((x) => x.id === l1) && p.suggestions.some((x) => x.id === l2), 'no plan yet: the leads to call are suggested');
  ok((await R('/api/plan', { method: 'POST', body: { goal: 'calls', items: [] } })).status === 400, 'the goal needs a real sentence');
  const past = new Date(Date.now() - 60000).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
  p = await R('/api/plan', { method: 'POST', body: { goal: 'Get 2 drivers to the Relay invite today', items: [{ driverId: l1, time: past }, { driverId: l2 }] } });
  ok(p.plan.items.length === 2 && p.plan.done === 0, 'Rita writes her plan: 2 calls');
  ok(await until(async () => (await notes(R)).some((t) => t === `Your plan: call Plan Lead One at ${past}`)), 'at the planned time: "Your plan: call Plan Lead One"');
  // ---- calls need notes
  ok((await R(`/api/drivers/${l1}/notes`, { method: 'POST', body: { kind: 'call', outcome: 'Talked', body: 'ok', indeed: false } })).status === 400, '"Called, talked" with no real note is refused');
  ok((await R(`/api/drivers/${l1}/notes`, { method: 'POST', body: { kind: 'call', outcome: 'No answer', body: '', indeed: false } })).status === 200, 'no answer needs no note');
  ok((await R(`/api/drivers/${l1}/notes`, { method: 'POST', body: { kind: 'call', outcome: 'Talked', body: 'Interested, 5 years OTR, sending the invite today', indeed: false } })).status === 200, 'talked, with what was said: logged');
  ok((await R('/api/plan')).plan.done === 1, 'the plan ticks off Plan Lead One');
  await R(`/api/drivers/${l2}/call-start`, { method: 'POST', body: {} });
  ok((await R('/api/calls/unlogged')).calls.length === 1, 'a call started from the website is waiting for its outcome');
  await pg.query(`UPDATE call_starts SET at = now() - interval '25 minutes'`);
  ok(await until(async () => (await notes(R)).some((t) => /You called Plan Lead Two: log how the call went/.test(t))), '20 minutes later: "log how the call went"');
  ok((await A('/api/team/' + rita)).unlogged === 1, 'the manager sees 1 call not logged');
  await R(`/api/drivers/${l2}/notes`, { method: 'POST', body: { kind: 'call', outcome: 'Left voicemail', body: '', indeed: false } });
  ok((await R('/api/calls/unlogged')).calls.length === 0, 'logging it clears it');
  // ---- coaching
  ok((await R('/api/coaching', { method: 'POST', body: { userId: rita, tip: 'Ask about home time first' } })).status === 403, 'only a manager gives tips');
  const tip = (await A('/api/coaching', { method: 'POST', body: { userId: rita, driverId: l1, tip: 'Ask about home time before pay: it is what most drivers care about.' } })).id;
  ok((await notes(R)).some((t) => /^Tip from Admin.*on Plan Lead One.*home time before pay/.test(t)), 'Rita gets the tip');
  ok((await R('/api/coaching')).tips[0].id === tip && (await R('/api/coaching?driver=' + l1)).tips.length === 1, 'on My day and on the lead');
  await R('/api/coaching/' + tip, { method: 'PATCH', body: { reply: 'Will do on my next calls' } });
  ok((await notes(A)).some((t) => /Rita Recruiter got your tip: Will do/.test(t)), 'she answers "Got it", the manager is told');
  ok(((await A('/api/coaching/pick?user=' + rita)).lead || {}).id === l2, 'a lead to review: Plan Lead Two (worked this week, not coached yet)');
  const per = await A('/api/team/' + rita);
  ok(per.plan && per.plan.goal.startsWith('Get 2 drivers') && per.tips.length === 1, 'the manager sees her plan and tips on her page');
  if (process.env.SHOTS) {
    const { chromium } = require('playwright'); const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 1100 } }); await ctx.addInitScript(() => { window.__CALL_ASK_MS = 1500; });
    const pp = await ctx.newPage(); const errs = []; pp.on('pageerror', (er) => errs.push(er.message)); if (process.env.DBG) pp.on('response', async (x) => { if (/notes|call-start/.test(x.url())) console.log('RESP', x.request().method(), x.url(), x.status(), (await x.text().catch(() => '')).slice(0, 120)); });
    await pp.goto(BASE + '/#/login'); await pp.fill('input[name=email]', 'rita@example.com'); await pp.fill('input[name=password]', 'rita-pass-1234'); await pp.click('#lf button'); await pp.waitForSelector('.fillcard');
    await pp.screenshot({ path: '/tmp/e2e-web/co-myday.png', fullPage: true });
    await pp.goto(BASE + '/#/driver/' + l2); await pp.waitForSelector('#newNote');
    await pp.click('[data-act=logContact][data-outcome=Talked]'); await pp.waitForTimeout(300);
    ok(await pp.locator('#newNote.need').count() === 1, 'the lead page: "Called, talked" with no note asks for the note');
    await pp.locator('.contact button.cpy').first().click();
    await pp.waitForSelector('#callLog', { timeout: 6000 }); await pp.screenshot({ path: '/tmp/e2e-web/co-calllog.png' });
    if (process.env.DBG) console.log('BEFORE', await pp.evaluate(() => typeof document.querySelector('#callLog').onsubmit));
    await pp.fill('#callLog [name=note]', 'Talked, he wants to start in December. Calling back Monday.'); await pp.click('#callLog .btn.primary'); await pp.waitForTimeout(800); if (process.env.DBG) console.log('ERR', await pp.evaluate(() => { const f = document.querySelector('#callLog'); return f ? JSON.stringify({ h: typeof f.onsubmit, open: document.querySelector('#dlg').open, n: document.querySelectorAll('#callLog').length, v: f.note.value, valid: f.checkValidity(), o: f.o.value, err: document.querySelector('#clErr').textContent, msg: f.note.validationMessage }) : 'none'; }));
    ok((await pg.query(`SELECT count(*)::int n FROM notes WHERE driver_id = $1 AND kind = 'call' AND outcome = 'Talked'`, [l2])).rows[0].n === 1, 'clicking the number, then the call is logged with its note');
    const ap = await (await b.newContext({ viewport: { width: 1440, height: 1100 } })).newPage(); ap.on('pageerror', (er) => errs.push(er.message));
    await ap.goto(BASE + '/#/login'); await ap.fill('input[name=email]', 'admin@example.com'); await ap.fill('input[name=password]', 'test-password-123'); await ap.click('#lf button'); await ap.waitForSelector('.fillcard');
    await ap.locator('.fillwide').screenshot({ path: '/tmp/e2e-web/co-dash.png' });
    await ap.goto(BASE + '/#/trucks'); await ap.waitForSelector('.eboard'); await ap.screenshot({ path: '/tmp/e2e-web/co-trucks.png' });
    await ap.goto(BASE + '/#/team/' + rita); await ap.waitForSelector('[data-act=coachPerson]'); await ap.screenshot({ path: '/tmp/e2e-web/co-person.png', fullPage: true });
    ok(!errs.length, 'no page errors ' + errs.join(' | ')); await b.close();
  }
  await pg.end(); execSync('pkill -f "node src/serve[r].js" || true'); process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
