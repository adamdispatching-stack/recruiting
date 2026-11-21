// Test of the per-company tables (trucks, active drivers, Telegram groups), the driver's mood and his own page.
//   node test/drivers.js   (starts the website itself)
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const BASE = 'http://localhost:3999';
const DB = 'postgresql://postgres@localhost:5433/recruiting_test?host=/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
async function until(f, ms = 8000) { for (let i = 0; i < ms / 100; i++) { const v = await f().catch(() => null); if (v) return v; await sleep(100); } return null; }
const env = { ...process.env, DATABASE_URL: DB, PGSSL: 'off', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-password-123', PORT: '3999', TELEGRAM_BOT_TOKEN: '' };
const start = async () => { spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', fs.openSync('/tmp/server.log', 'w'), fs.openSync('/tmp/server.log', 'a')], detached: true }).unref(); await until(async () => (await fetch(BASE + '/healthz')).ok, 15000); };
const stop = async () => { execSync('pkill -f "node src/serve[r].js" || true'); await sleep(600); };
(async () => {
  await stop();
  execSync(`su postgres -c "psql -q -h /tmp -p 5433 -c 'DROP DATABASE IF EXISTS recruiting_test' -c 'CREATE DATABASE recruiting_test'"`, { stdio: 'ignore' });
  await start();
  const jar = {};
  const as = (who) => async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: jar[who] || '' }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && /sid=/.test(sc)) jar[who] = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  const A = as('admin'), D = as('dan');
  const login = async () => { await A('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } }); await D('/api/login', { method: 'POST', body: { email: 'dan@example.com', password: 'dan-pass-12345' } }); };
  await A('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  await A('/api/users', { method: 'POST', body: { name: 'Dan Dispatch', email: 'dan@example.com', password: 'dan-pass-12345', role: 'dispatcher' } });
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  const coA = (await A('/api/companies', { method: 'POST', body: { name: 'Bobtail Trucking' } })).id;
  const coB = (await A('/api/companies', { method: 'POST', body: { name: 'CMJ CO' } })).id;
  const mk = async (name, co) => { const id = (await A('/api/drivers', { method: 'POST', body: { name, source: 'Referral', phone: '215555' + String(1000 + Math.floor(Math.random() * 8999)) } })).id; await pg.query(`UPDATE drivers SET status = 'Hired', company_id = $2 WHERE id = $1`, [id, co]); return id; };
  const hank = await mk('Hank Hired', coA), ivy = await mk('Ivy Calm', coA), zed = await mk('Zed Newman', coB), lou = await mk('Lou Loner', null);
  // trucks: A has one with Hank, one empty; B has one with a typed name "zed newman" (to link at start), one empty
  const t1 = (await A('/api/trucks', { method: 'POST', body: { unit: '101', companyId: coA } })).id;
  const t2 = (await A('/api/trucks', { method: 'POST', body: { unit: '102', companyId: coA } })).id;
  const t3 = (await A('/api/trucks', { method: 'POST', body: { unit: '201', companyId: coB, driverName: 'zed newman ' } })).id;
  const t4 = (await A('/api/trucks', { method: 'POST', body: { unit: '202', companyId: coB } })).id;
  ok((await A('/api/trucks/' + t1, { method: 'PATCH', body: { driverId: hank } })).ok, 'a truck is linked to an active driver from the list');
  ok(/Hank Hired already drives truck 101/.test((await A('/api/trucks/' + t2, { method: 'PATCH', body: { driverId: hank } })).error || ''), 'one driver, one truck');
  ok((await A('/api/trucks')).trucks.find((t) => t.id === t3).driver === null, 'truck 201 has only a typed name');
  await stop(); await start(); await login();
  const tr = (await A('/api/trucks')).trucks;
  ok(tr.find((t) => t.id === t3).driver && tr.find((t) => t.id === t3).driver.id === zed, 'after a restart, the typed name "zed newman" is linked to Zed Newman');
  ok((await pg.query(`SELECT 1 FROM truck_history WHERE truck_id = $1 AND kind = 'driver' AND to_id = $2`, [t3, zed])).rows.length === 1, 'and the truck\'s history says so');
  // Telegram groups and what the bot found
  const tz = 'America/New_York';
  const day = (n) => new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: tz });
  let cid = -1001;
  for (const [d, kinds] of [[hank, ['dispatch', 'eld', 'accounting']], [ivy, ['dispatch']], [zed, ['dispatch', 'eld']]]) for (const k of kinds) await pg.query(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, linked_at, last_at) VALUES ($1, $2, $3, $4, now(), now())`, [cid--, `${k} group`, k, d]);
  const chat = async (d, k) => (await pg.query(`SELECT chat_id FROM tg_chats WHERE driver_id = $1 AND kind = $2`, [d, k])).rows[0].chat_id;
  await pg.query(`INSERT INTO tg_summaries (chat_id, day, summary, mood, messages) VALUES ($1, $2, 'Long wait at the DC, driver frustrated.', 'angry', 20), ($1, $3, 'Normal day.', 'good', 8), ($4, $3, 'Logs fine.', 'neutral', 3), ($5, $2, 'Easy runs.', 'good', 5)`,
    [await chat(hank, 'dispatch'), day(1), day(2), await chat(hank, 'eld'), await chat(ivy, 'dispatch')]);
  await pg.query(`INSERT INTO tg_alerts (chat_id, driver_id, kind, severity, text) VALUES ($1, $2, 'late_risk', 'high', 'Running 2 hours late to the DC')`, [await chat(zed, 'dispatch'), zed]);
  await pg.query(`INSERT INTO driver_notes (driver_id, kind, text) VALUES ($1, 'routine', 'Wants a wake-up call at 7 AM'), ($1, 'dislikes_loads', 'Does not like NYC loads')`, [hank]);
  const act = (await A('/api/active')).drivers; const H = act.find((d) => d.id === hank), I = act.find((d) => d.id === ivy), Z = act.find((d) => d.id === zed);
  if (process.env.DBG) console.log(JSON.stringify(H.mood));
  ok(H.mood.length === 3 && H.mood[1].mood === 'angry' && H.mood[0].mood === 'neutral' && H.moodIssue, 'Hank\'s last 3 days: neutral (the worst of his groups), angry, today not summed up yet: needs attention');
  ok(I.mood[1].mood === 'good' && !I.moodIssue, 'Ivy: a good day, nothing to look at');
  ok(Z.moodIssue && Z.openAlerts === 1 && Z.mood[2].high === 1, 'Zed: an important alert today');
  ok(H.groups.dispatch && H.groups.eld && H.groups.accounting && !I.groups.eld, 'each driver\'s three groups');
  const P = await D('/api/active/' + hank);
  ok(P.status === 200 && P.groups.length === 3 && P.mood.length === 14 && P.summaries.length === 3 && P.notes.length === 2 && P.truck.unit === '101', 'the driver\'s own page: 3 groups, 14 days of mood, summaries, notes, truck');
  ok(!P.canLead && (await D('/api/drivers/' + hank)).status === 403, 'a dispatcher opens it, but not the lead page');
  if (process.env.SHOTS) {
    const { chromium } = require('playwright'); const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE + '/#/login'); await p.fill('input[name=email]', 'admin@example.com'); await p.fill('input[name=password]', 'test-password-123'); await p.click('#lf button'); await p.waitForSelector('.rail');
    await p.goto(BASE + '/#/trucks'); await p.waitForSelector('.cotable');
    const heads = await p.locator('.cotable .cohead').allTextContents();
    ok(heads.length === 2 && /Bobtail/.test(heads[0]) && /CMJ/.test(heads[1]), 'Trucks: a table for each company');
    const units = await p.locator('.cotable').first().locator('a.unit').allTextContents();
    ok(units[0] === '102' && units[1] === '101', 'empty trucks on top');
    ok((await p.locator(`a[href="#/active/${hank}"]`).count()) >= 1, 'the driver\'s name goes to his own page');
    await p.screenshot({ path: '/tmp/e2e-web/dr-trucks.png', fullPage: true });
    await p.click('[data-truck="' + t2 + '"] [data-act=truckEdit]'); await p.waitForSelector('#truckForm [name=driverPick]');
    ok((await p.locator('#truckForm [name=driverPick] option').allTextContents()).some((x) => /Ivy Calm/.test(x)), 'a free truck: pick a driver from the active drivers');
    await p.selectOption('#truckForm [name=driverPick]', String(ivy)); await p.click('#truckForm .btn.primary'); await p.waitForTimeout(800);
    ok((await A('/api/trucks')).trucks.find((t) => t.id === t2).driver.id === ivy, 'Ivy now drives truck 102');
    await p.goto(BASE + '/#/active'); await p.waitForSelector('table.active');
    ok((await p.locator('.cotable').count()) === 3, 'Active drivers: a table per company, and one for no company');
    ok((await p.locator('.cotable').first().locator('tbody tr').first().textContent()).includes('Hank'), 'a driver who needs attention comes first');
    await p.screenshot({ path: '/tmp/e2e-web/dr-active.png', fullPage: true });
    await p.click('[data-act=activeFilter][data-k=mood]'); await p.waitForTimeout(300);
    ok((await p.locator('.cotable tbody tr').count()) === 2, '"Needs attention": Hank and Zed');
    await p.goto(BASE + '/#/telegram'); await p.waitForSelector('.tgco');
    ok((await p.locator('table.tgco').count()) === 3 && (await p.locator('table.tgco tbody tr').count()) === 4, 'Telegram groups: active drivers by company, with their groups');
    await p.screenshot({ path: '/tmp/e2e-web/dr-tg.png', fullPage: true });
    await p.goto(BASE + '/#/active/' + hank); await p.waitForSelector('.moodcard'); await p.waitForSelector('#dprof .pform');
    await p.screenshot({ path: '/tmp/e2e-web/dr-page.png', fullPage: true });
    const dp = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); dp.on('pageerror', (e) => errs.push(e.message));
    await dp.goto(BASE + '/#/login'); await dp.fill('input[name=email]', 'dan@example.com'); await dp.fill('input[name=password]', 'dan-pass-12345'); await dp.click('#lf button'); await dp.waitForSelector('table.trucks');
    await dp.click(`a[href="#/active/${zed}"]`); await dp.waitForSelector('.moodcard');
    ok(/#\/active\/\d+$/.test(dp.url()) && !(await dp.locator('a[href^="#/driver/"]').count()), 'a dispatcher gets to the driver\'s page from Trucks, with no lead links');
    await dp.goto(BASE + '/#/driver/' + hank); await dp.waitForSelector('.moodcard'); ok(dp.url().endsWith('#/active/' + hank), 'a lead link takes a dispatcher to the driver\'s page');
    await dp.setViewportSize({ width: 390, height: 900 }); await dp.reload(); await dp.waitForSelector('.moodcard'); await dp.screenshot({ path: '/tmp/e2e-web/dr-mobile.png', fullPage: true });
    ok(!errs.length, 'no page errors ' + errs.join(' | ')); await b.close();
  }
  await pg.end(); await stop(); process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
