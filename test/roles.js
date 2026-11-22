// Who sees what: recruiters see recruiting (leads, onboarding, their groups, answers for drivers); dispatchers see
// dispatching (trucks, working drivers, their groups) and never another dispatcher's review, coaching or activity;
// admins see everything. Starts its own server.
//   node test/roles.js
const { execSync } = require('child_process');
const BASE = 'http://localhost:3999';
const DB = 'postgresql://postgres@localhost:5433/recruiting_test?host=/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
async function until(f, ms = 10000) { for (let i = 0; i < ms / 100; i++) { const v = await f(); if (v) return v; await sleep(100); } return null; }

(async () => {
  execSync(`pkill -f "node src/serve[r].js" || true; sleep 0.4; su postgres -c "psql -q -h /tmp -p 5433 -c 'DROP DATABASE IF EXISTS recruiting_test' -c 'CREATE DATABASE recruiting_test'"`, { stdio: 'ignore' });
  const env = { ...process.env, DATABASE_URL: DB, PGSSL: 'off', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-password-123', PORT: '3999' };
  delete env.TELEGRAM_BOT_TOKEN; delete env.ANTHROPIC_API_KEY;
  require('child_process').spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', require('fs').openSync('/tmp/server.log', 'w'), require('fs').openSync('/tmp/server.log', 'a')], detached: true }).unref();
  await until(async () => { try { return (await fetch(BASE + '/healthz')).ok; } catch (e) { return false; } }, 15000);
  const login = async (email, password) => { const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); return (r.headers.get('set-cookie') || '').split(';')[0]; };
  const as = (cookie) => async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  const A = as(await login('admin@example.com', 'test-password-123'));
  const rita = (await A('/api/users', { method: 'POST', body: { name: 'Rita Recruiter', email: 'rita@example.com', password: 'rita-pass-1234' } })).id;
  const dan = (await A('/api/users', { method: 'POST', body: { name: 'Dan Dispatch', email: 'dan@example.com', password: 'dan-pass-12345', role: 'dispatcher' } })).id;
  const sam = (await A('/api/users', { method: 'POST', body: { name: 'Sam Senior', email: 'sam@example.com', password: 'sam-pass-12345', role: 'dispatcher' } })).id;
  const R = as(await login('rita@example.com', 'rita-pass-1234')), D = as(await login('dan@example.com', 'dan-pass-12345'));
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  // a lead in onboarding and a working (hired) driver, each with a Telegram group, an alert and bot history
  const olga = (await A('/api/drivers', { method: 'POST', body: { name: 'Olga Onb', source: 'Indeed', phone: '2155550101', ownerId: rita } })).id;
  const hank = (await A('/api/drivers', { method: 'POST', body: { name: 'Hank Hired', source: 'Indeed', phone: '2155550102', ownerId: rita } })).id;
  await pg.query(`UPDATE drivers SET status = 'Onboarding' WHERE id = $1`, [olga]); await pg.query(`UPDATE drivers SET status = 'Hired' WHERE id = $1`, [hank]);
  await pg.query(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active) VALUES (-501, 'Olga Onb', 'dispatch', $1, true), (-502, 'Hank Hired', 'dispatch', $2, true), (-503, 'Day shift', 'shift', NULL, true)`, [olga, hank]);
  await pg.query(`INSERT INTO tg_alerts (chat_id, driver_id, kind, severity, text) VALUES (-501, $1, 'other', 'low', 'Olga asked about the drug test'), (-502, $2, 'late_risk', 'high', 'Hank may be late'), (-502, $2, 'unprofessional_dispatcher', 'high', 'Sam was rude to Hank')`, [olga, hank]);
  await pg.query(`INSERT INTO tg_log (chat_id, driver_id, kind, text) VALUES (-501, $1, 'reply', 'Answered Olga'), (-502, $2, 'fact', 'Hank rolling to Kearny'), (-502, $2, 'desk', 'Asked Sam Senior: where is Hank rolling to'), (-503, NULL, 'connect', 'Connected the day shift')`, [olga, hank]);
  // the dispatchers' reviews and coaching
  await pg.query(`INSERT INTO tg_people (tg_id, name, user_id, role, profile, profile_at) VALUES (701, 'Dan Dispatch', $1, 'dispatch', '{"summary":"Dan review","scores":[{"area":"speed","score":4}]}', now()), (702, 'Sam Senior', $2, 'dispatch', '{"summary":"Sam review: too harsh","scores":[{"area":"speed","score":2}]}', now())`, [dan, sam]);
  // the knowledge base: answers for drivers, dispatching, a site
  for (const [kind, qq, a] of [['general', 'When is pay day?', 'Every Friday.'], ['dispatch', 'The driver will be late', 'Ask for the new ETA.'], ['site', 'KRB1', 'Gate 3.']]) await A('/api/kb', { method: 'POST', body: { kind, question: qq, answer: a } });
  await pg.query(`INSERT INTO places (name, kind, city, state) VALUES ('Kearny Truck Repair', 'shop', 'Kearny', 'NJ')`);

  // ---------- a recruiter: recruiting only ----------
  const no = async (who, paths) => { const bad = []; for (const p of paths) { const r = await who(p); if (r.status !== 403) bad.push(`${p} ${r.status}`); } return bad; };
  const rb = await no(R, ['/api/trucks', '/api/active', '/api/cases', '/api/places', '/api/playbooks', '/api/tg/dispatch-readiness', '/api/tg/desk', '/api/tg/routines', '/api/team/dispatchers', '/api/tg/dispatchers/u' + dan, '/api/fleet/dispatchers', `/api/drivers/${hank}/profile`, '/api/team/' + dan]);
  ok(!rb.length, 'a recruiter cannot open trucks, active drivers, road cases, shops, the shift desk, dispatchers\' reviews or another person\'s page' + (rb.length ? ': ' + rb.join(', ') : ''));
  const rOk = await Promise.all(['/api/drivers', '/api/onboarding', '/api/companies', '/api/fleet/goal', '/api/team/me', '/api/kb', '/api/tg/chats', '/api/tg/readiness'].map(async (p) => [p, (await R(p)).status]));
  ok(rOk.every(([, s]) => s === 200), 'a recruiter opens leads, onboarding, companies, the hiring goal, his own activity, answers for drivers, his Telegram groups' + (rOk.some(([, s]) => s !== 200) ? ': ' + JSON.stringify(rOk) : ''));
  const rc = (await R('/api/tg/chats')).chats;
  ok(rc.length === 1 && rc[0].driver === 'Olga Onb', 'a recruiter\'s Telegram: only the onboarding driver\'s group, not the working driver\'s or the shift group');
  ok((await R('/api/tg/chats/-502')).status === 404, 'a recruiter cannot open a working driver\'s group');
  const ra = (await R('/api/tg/alerts')).alerts; ok(ra.length === 1 && /Olga/.test(ra[0].text), 'a recruiter\'s alerts: onboarding only');
  const rl = (await R('/api/tg/log')).log; ok(rl.length === 1 && rl[0].text === 'Answered Olga', 'a recruiter\'s bot history: his onboarding groups only (no shift desk, no working drivers)');
  const rk = await R('/api/kb'); ok(rk.entries.length === 1 && rk.entries[0].kind === 'general' && rk.recruiter && !rk.kinds.dispatch, 'a recruiter\'s knowledge base: the answers for drivers only');
  ok((await R('/api/kb', { method: 'POST', body: { kind: 'dispatch', question: 'x situation', answer: 'y practice' } })).status === 403, 'a recruiter cannot add dispatching practices');
  const rs = (await R('/api/kb/search?q=kearny')).results; ok(!rs.length, 'a recruiter\'s search does not show sites, shops or dispatch words');

  // ---------- a dispatcher: dispatching only, nothing about another dispatcher ----------
  const db2 = await no(D, ['/api/team/' + sam, '/api/tg/dispatchers/u' + sam, '/api/tg/dispatch-readiness', '/api/tg/desk', '/api/team/dispatchers', '/api/team', '/api/tg/log', '/api/drivers', '/api/onboarding', '/api/badges/team', '/api/coaching/pick']);
  ok(!db2.length, 'a dispatcher cannot open another dispatcher\'s page or review, the shift desk, the team, bot history, leads or onboarding' + (db2.length ? ': ' + db2.join(', ') : ''));
  const me = await D('/api/team/me'); ok(me.status === 200 && me.person && me.person.name === 'Dan Dispatch', 'a dispatcher opens his own activity');
  const co = await D('/api/coaching?user=' + sam); ok(co.status === 403 || (co.status === 200 && co.tips.every((t) => t.userId === dan)), 'coaching tips: never Sam\'s');
  const mc = await D('/api/me/coaching'); ok(mc.status === 200 && !/Sam/.test(JSON.stringify(mc)), 'his coaching: nothing from Sam\'s review');
  const dc = (await D('/api/tg/chats')).chats; ok(dc.length === 1 && dc[0].driver === 'Hank Hired', 'a dispatcher\'s Telegram: the working driver\'s group, not onboarding groups');
  const da = (await D('/api/tg/alerts')).alerts; ok(da.length === 1 && /late/.test(da[0].text), 'a dispatcher\'s alerts: no "unprofessional dispatcher" alert (admins only)');
  const dg = await D('/api/tg/chats/-502'); ok(dg.status === 200 && !dg.alerts.some((a) => a.kind === 'unprofessional_dispatcher'), 'the group page: no alert about a dispatcher');
  ok((await D('/api/tg/chats/-501')).status === 404, 'a dispatcher cannot open an onboarding group');
  ok((await D('/api/kb')).status === 200 && (await D('/api/trucks')).status === 200 && (await D('/api/active')).status === 200, 'a dispatcher opens trucks, active drivers, the knowledge base');

  // ---------- an admin: everything ----------
  const aOk = await Promise.all(['/api/team/' + sam, '/api/tg/dispatchers/u' + sam, '/api/tg/dispatch-readiness', '/api/tg/desk', '/api/team/dispatchers', '/api/tg/log', '/api/trucks', '/api/drivers'].map(async (p) => [p, (await A(p)).status]));
  ok(aOk.every(([, s]) => s === 200), 'an admin opens everything' + (aOk.some(([, s]) => s !== 200) ? ': ' + JSON.stringify(aOk) : ''));
  ok((await A('/api/tg/alerts')).alerts.some((a) => a.kind === 'unprofessional_dispatcher') && (await A('/api/tg/chats')).chats.length === 3, 'an admin sees the alert about the dispatcher and every group');

  // ---------- the menus ----------
  try {
    const { chromium } = require('playwright'); const b = await chromium.launch(); const errs = [];
    const menu = async (email, pw, shot) => { const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(BASE + '/'); await p.fill('input[type=email]', email); await p.fill('input[type=password]', pw); await p.click('button[type=submit], .btn.primary'); await p.waitForSelector('.rail', { timeout: 8000 });
      const items = await p.$$eval('.rail nav[aria-label=Sections] a span', (x) => x.map((e) => e.textContent)); await p.screenshot({ path: shot }); return { p, items }; };
    const r = await menu('rita@example.com', 'rita-pass-1234', '/tmp/shot/menu-recruiter.png');
    ok(['Leads', 'Onboarding', 'Telegram', 'Answers for drivers'].every((x) => r.items.includes(x)) && !['Trucks', 'Active drivers', 'Road cases', 'Shops & services', 'Shift desk', 'Team'].some((x) => r.items.includes(x)), 'recruiter menu: ' + r.items.join(', '));
    await sleep(1000); await r.p.goto(BASE + '/#/trucks'); await sleep(1000); ok(!/#\/trucks/.test(r.p.url()), 'a recruiter typing #/trucks is sent back to his day');
    const d = await menu('dan@example.com', 'dan-pass-12345', '/tmp/shot/menu-dispatcher.png');
    ok(['Trucks', 'Active drivers', 'Road cases', 'Telegram', 'Knowledge base'].every((x) => d.items.includes(x)) && !['Leads', 'Onboarding', 'Team', 'Shift desk', 'Badges'].some((x) => d.items.includes(x)), 'dispatcher menu: ' + d.items.join(', '));
    await sleep(1200); await d.p.goto(BASE + '/#/telegram'); await d.p.waitForSelector('.fbtabs', { timeout: 8000 });
    const tabs = await d.p.$$eval('.fbtabs button', (x) => x.map((e) => e.textContent)); ok(!tabs.includes('Bot history') && !tabs.includes('Autopilot'), 'a dispatcher\'s Telegram tabs: ' + tabs.join(', '));
    await d.p.goto(BASE + '/#/team/' + sam); await sleep(800); ok(!(await d.p.textContent('main')).includes('Sam Senior'), 'a dispatcher opening Sam\'s page sees nothing of Sam');
    const ad = await menu('admin@example.com', 'test-password-123', '/tmp/shot/menu-admin.png');
    ok(['Leads', 'Trucks', 'Shift desk', 'Team', 'Knowledge base'].every((x) => ad.items.includes(x)), 'admin menu: everything');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } catch (e) { ok(false, 'menus: ' + e.message); }
  await pg.end(); execSync('pkill -f "node src/serve[r].js" || true'); process.exit();
})().catch((e) => { console.error(e); execSync('pkill -f "node src/serve[r].js" || true'); process.exit(1); });
