// Test of call-backs: the extension's AI finds "call me at 3 pm", the lead gets the time, the recruiter is reminded
// before, told when it is late, the admins an hour later; a logged call or "Called" ends it.
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
  spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env: { ...process.env, DATABASE_URL: DB, PGSSL: 'off', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-password-123', PORT: '3999', TELEGRAM_BOT_TOKEN: '', CALLBACK_TICK_MS: '1000' },
    stdio: ['ignore', fs.openSync('/tmp/server.log', 'w'), fs.openSync('/tmp/server.log', 'a')], detached: true }).unref();
  await until(async () => (await fetch(BASE + '/healthz')).ok, 15000);
  const jar = {};
  const as = (who) => async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: jar[who] || '' }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && /sid=/.test(sc)) jar[who] = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  const A = as('admin'), R = as('rita');
  await A('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  const rita = (await A('/api/users', { method: 'POST', body: { name: 'Rita Recruiter', email: 'rita@example.com', password: 'rita-pass-1234' } })).id;
  await R('/api/login', { method: 'POST', body: { email: 'rita@example.com', password: 'rita-pass-1234' } });
  await A('/api/settings', { method: 'PUT', body: { share: { on: false, people: null } } });
  const key = (await A('/api/keys', { method: 'POST', body: { name: 'Chrome 1', assignTo: rita } })).key;
  const push = (drivers) => fetch(BASE + '/api/ext/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ drivers }) }).then((r) => r.json());
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  const row = async () => (await pg.query(`SELECT * FROM drivers WHERE name = 'Carl Callback'`)).rows[0];
  const notes = async (X) => ((await X('/api/notices')).notices || []).map((n) => n.text);

  const at = new Date(Date.now() + 2 * 3600000).toISOString();
  await push([{ name: 'Carl Callback', phones: ['2155550111'], status: 'Interested', callbackAt: at, callbackSaid: 'call me around 3 pm, driving now', callbackTz: 'America/Chicago' }]);
  let d = await row();
  ok(d.owner_id === rita && d.callback_state === 'due' && d.callback_at.toISOString() === at && d.callback_by === 'AI' && d.callback_tz === 'America/Chicago', 'the AI\'s call-back time is on the lead');
  ok(!!d.follow_up, 'and its follow-up day');
  ok((await notes(R)).some((t) => /Carl Callback asked for a call at .* \(.* his time\): "call me around 3 pm/.test(t)), 'Rita is told, with his own time too');
  const ev = (await pg.query(`SELECT text, who FROM driver_events WHERE driver_id = $1 ORDER BY id`, [d.id])).rows;
  ok(ev.some((e) => /^Call back at .*the AI found it in the chat/.test(e.text) && e.who === 'AI'), 'the history says so');
  await push([{ name: 'Carl Callback', phones: ['2155550111'], status: 'Interested', callbackAt: at, callbackSaid: 'call me around 3 pm, driving now' }]);
  ok((await pg.query(`SELECT count(*)::int n FROM driver_events WHERE driver_id = $1 AND text LIKE 'Call back at%'`, [d.id])).rows[0].n === 1, 'the same request again changes nothing');
  await push([{ name: 'Carl Callback', phones: ['2155550111'], callbackAt: new Date(Date.now() - 5 * 3600000).toISOString(), callbackSaid: 'old' }]);
  ok((await row()).callback_at.toISOString() === at, 'an old request, hours past, is ignored');
  const L = await R('/api/drivers/' + d.id);
  ok(L.driver.callback && L.driver.callback.state === 'due' && L.driver.callback.said === 'call me around 3 pm, driving now', 'the lead page has it');
  // reminders
  await pg.query(`UPDATE drivers SET callback_at = now() + interval '8 minutes' WHERE id = $1`, [d.id]);
  ok(await until(async () => (await notes(R)).some((t) => /^Call Carl Callback at .*he asked for it/.test(t))), '10 minutes before: Rita is reminded');
  const day = await R('/api/dashboard');
  ok(day.calls && day.calls[0] && day.calls[0].name === 'Carl Callback' && day.calls[0].callback, 'My day: the call-back is first on the call list');
  await pg.query(`UPDATE drivers SET callback_at = now() - interval '20 minutes' WHERE id = $1`, [d.id]);
  ok(await until(async () => (await notes(R)).some((t) => /^Not called yet: Carl Callback asked for a call/.test(t))), '15 minutes late with no call: Rita is told');
  ok(!(await notes(A)).some((t) => /nobody has called yet/.test(t)), 'not the admin yet');
  await pg.query(`UPDATE drivers SET callback_at = now() - interval '65 minutes' WHERE id = $1`, [d.id]);
  ok(await until(async () => (await notes(A)).some((t) => /Carl Callback asked for a call at .* and nobody has called yet \(Rita Recruiter's lead\)/.test(t))), 'an hour late: the admin is told');
  // a logged call ends it
  await R(`/api/drivers/${d.id}/notes`, { method: 'POST', body: { kind: 'call', outcome: 'Talked', body: 'Spoke, he is in, sending the Relay invite today', indeed: false } });
  ok((await row()).callback_state === 'done', 'logging a call marks the call-back done');
  // a recruiter sets one by hand, then marks it done
  const t2 = new Date(Date.now() + 26 * 3600000);
  ok((await R(`/api/drivers/${d.id}/callback`, { method: 'POST', body: { at: t2.toISOString(), said: 'tomorrow after lunch' } })).ok, 'Rita sets a call-back for tomorrow');
  d = await row(); ok(d.callback_state === 'due' && d.callback_by === 'Rita Recruiter' && d.callback_reminded === 0, 'it is due, set by Rita');
  ok((await R(`/api/drivers/${d.id}/callback`, { method: 'POST', body: { at: new Date(Date.now() - 3600000).toISOString() } })).status === 400, 'not in the past');
  if (process.env.SHOTS) {
    const { chromium } = require('playwright'); const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE + '/#/login'); await p.fill('input[name=email]', 'rita@example.com'); await p.fill('input[name=password]', 'rita-pass-1234'); await p.click('#lf button'); await p.waitForSelector('.rail');
    await p.goto(BASE + '/#/driver/' + d.id); await p.waitForSelector('.cbcard'); await p.locator('.cbcard').screenshot({ path: '/tmp/e2e-web/cb-card.png' });
    await p.click('[data-act=cbSet]'); await p.waitForSelector('#cbForm');
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    await p.fill('#cbForm [name=at]', tomorrow + 'T15:00'); await p.click('#cbForm .btn.primary'); await p.waitForTimeout(800);
    const set = (await row()).callback_at; const ny = set.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
    ok(ny === '3:00 PM' && set.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === tomorrow, 'the time picked on the page is 3:00 PM New York time (' + ny + ')');
    await p.goto(BASE + '/#/leads'); await p.waitForSelector('table.leads .cbk'); await p.screenshot({ path: '/tmp/e2e-web/cb-leads.png' });
    await p.goto(BASE + '/#/driver/' + d.id); await p.waitForSelector('.cbcard'); await p.click('[data-act=cbDone]'); await p.waitForTimeout(800);
    ok((await row()).callback_state === 'done' && (await p.locator('.cbset').count()) === 1, '"Called" ends it');
    ok(!errs.length, 'no page errors ' + errs.join(' | ')); await b.close();
  }
  await pg.end(); execSync('pkill -f "node src/serve[r].js" || true'); process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
