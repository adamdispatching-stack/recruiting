// Test of lead opens (who opened a lead, how often) and sharing leads only with recruiters working right now.
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
  spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env: { ...process.env, DATABASE_URL: DB, PGSSL: 'off', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-password-123', PORT: '3999', TELEGRAM_BOT_TOKEN: '', SHARE_TICK_MS: '1000' },
    stdio: ['ignore', fs.openSync('/tmp/server.log', 'w'), fs.openSync('/tmp/server.log', 'a')], detached: true }).unref();
  await until(async () => (await fetch(BASE + '/healthz')).ok, 15000);
  const jar = {};
  const as = (who) => async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: jar[who] || '', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && /sid=/.test(sc)) jar[who] = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  const A = as('admin'), R = as('rita'), M = as('max');
  await A('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  const rita = (await A('/api/users', { method: 'POST', body: { name: 'Rita Recruiter', email: 'rita@example.com', password: 'rita-pass-1234' } })).id;
  const max = (await A('/api/users', { method: 'POST', body: { name: 'Max Morning', email: 'max@example.com', password: 'max-pass-12345' } })).id;
  await R('/api/login', { method: 'POST', body: { email: 'rita@example.com', password: 'rita-pass-1234' } });
  await M('/api/login', { method: 'POST', body: { email: 'max@example.com', password: 'max-pass-12345' } });
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  await pg.query(`UPDATE users SET last_active_at = NULL`);
  const key = (await A('/api/keys', { method: 'POST', body: { name: 'Chrome 1' } })).key;
  const push = (drivers) => fetch(BASE + '/api/ext/push', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Key': key, Authorization: 'Bearer ' + key }, body: JSON.stringify({ drivers }) }).then((r) => r.json());
  const owner = async (name) => (await pg.query(`SELECT owner_id FROM drivers WHERE name = $1`, [name])).rows[0].owner_id;
  const beat = (X) => X('/api/beat', { method: 'POST', body: { active: true, visible: true, clicks: 3 } });

  // nobody is working: the lead waits
  const p1 = await push([{ name: 'Night Lead', phones: ['2155550101'], status: 'Replied', updatedAt: new Date().toISOString() }]);
  ok(p1.merged === 1, 'a lead comes in from the extension');
  ok((await owner('Night Lead')) === null, 'nobody is working: it waits, given to nobody');
  ok((await A('/api/share')).next === null, 'settings say: nobody is working right now');
  // Max starts work: he gets the waiting lead
  await beat(M);
  ok(await until(async () => (await owner('Night Lead')) === max), 'Max starts working: the waiting lead goes to him');
  ok(((await M('/api/notices')).notices || []).some((n) => /New lead for you: Night Lead/.test(n.text)), 'and he is told');
  // only Max works: the next leads go to him, not to Rita who is away
  await push([{ name: 'Day Lead One', phones: ['2155550102'], status: 'Replied' }, { name: 'Day Lead Two', phones: ['2155550103'], status: 'Replied' }]);
  ok((await owner('Day Lead One')) === max && (await owner('Day Lead Two')) === max, 'only Max is working: new leads go to him');
  // Rita starts too: shared evenly between the two now
  await beat(R);
  await push([{ name: 'Day Lead Three', phones: ['2155550104'], status: 'Replied' }]);
  ok((await owner('Day Lead Three')) === rita, 'Rita starts: the next lead goes to her (she has fewer today)');
  // Rita goes away without opening her lead: after moveAfter minutes it goes to Max
  await A('/api/settings', { method: 'PUT', body: { share: { on: true, people: null, onlyOnline: true, moveAfter: 30 } } });
  await pg.query(`UPDATE users SET last_active_at = now() - interval '45 minutes' WHERE id = $1`, [rita]);
  await pg.query(`UPDATE drivers SET assigned_at = now() - interval '40 minutes' WHERE name = 'Day Lead Three'`);
  ok(await until(async () => (await owner('Day Lead Three')) === max), 'Rita is away and never opened it: after 30 minutes it moves to Max');
  ok(((await R('/api/notices')).notices || []).some((n) => /Day Lead Three went to Max Morning: you were away/.test(n.text)), 'Rita is told why');
  const ev = (await pg.query(`SELECT text FROM driver_events WHERE driver_id = (SELECT id FROM drivers WHERE name = 'Day Lead Three') ORDER BY id DESC LIMIT 1`)).rows[0].text;
  ok(/Moved from Rita Recruiter to Max Morning/.test(ev), 'the lead\'s history says so');
  // a lead the recruiter opened is never moved
  await beat(R); await push([{ name: 'Opened Lead', phones: ['2155550105'], status: 'Replied' }]);
  const oid = (await pg.query(`SELECT id, owner_id FROM drivers WHERE name = 'Opened Lead'`)).rows[0];
  const ox = oid.owner_id === rita ? R : M;
  await ox('/api/track', { method: 'POST', body: { path: '#/driver/' + oid.id } }); await ox('/api/drivers/' + oid.id);
  await pg.query(`UPDATE users SET last_active_at = now() - interval '45 minutes' WHERE id = $1`, [oid.owner_id]);
  await pg.query(`UPDATE drivers SET assigned_at = now() - interval '40 minutes' WHERE id = $1`, [oid.id]);
  await sleep(2500);
  ok((await owner('Opened Lead')) === oid.owner_id, 'a lead its recruiter opened stays theirs');
  // opens: who opened a lead, how many times
  const L = (await pg.query(`SELECT id FROM drivers WHERE name = 'Night Lead'`)).rows[0].id;
  await M('/api/track', { method: 'POST', body: { path: '#/driver/' + L } });
  await A('/api/track', { method: 'POST', body: { path: '#/driver/' + L } });
  await pg.query(`INSERT INTO activity (user_id, type, driver_id, detail, at) VALUES ($1, 'open', $2, 'Opened the lead', now() - interval '2 hours')`, [max, L]);
  const o = await A(`/api/drivers/${L}/opens`);
  ok(o.total === 3 && o.people.find((p) => p.id === max).times === 2 && o.people.find((p) => p.name === 'Admin' || p.role === 'admin').times === 1, 'opens: 3 in all, Max twice, the admin once');
  const list = (await A('/api/drivers?q=Night')).drivers[0];
  ok(list.opens === 3, 'the leads list shows 3 opens');
  ok((await A('/api/drivers/' + L)).opens >= 3, 'and the lead page');
  if (process.env.SHOTS) {
    const { chromium } = require('playwright'); const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE + '/#/login'); await p.fill('input[name=email]', 'admin@example.com'); await p.fill('input[name=password]', 'test-password-123'); await p.click('#lf button'); await p.waitForSelector('.rail');
    await p.goto(BASE + '/#/leads'); await p.waitForSelector('table.leads .opens'); await p.screenshot({ path: '/tmp/e2e-web/as-leads.png' });
    await p.click(`tr[data-id="${L}"] .opens`); await p.waitForSelector('.opensdlg'); await p.screenshot({ path: '/tmp/e2e-web/as-opens.png' });
    ok(/Opened 3 times/.test(await p.locator('.opensdlg h2').textContent()) && /#\/leads/.test(p.url()), 'clicking the eye shows who opened it, without opening the lead');
    await p.keyboard.press('Escape');
    await p.goto(BASE + '/#/settings'); await p.waitForSelector('#shareForm'); await p.locator('#sharing').screenshot({ path: '/tmp/e2e-web/as-settings.png' });
    ok(!errs.length, 'no page errors ' + errs.join(' | ')); await b.close();
  }
  await pg.end(); execSync('pkill -f "node src/serve[r].js" || true'); process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
