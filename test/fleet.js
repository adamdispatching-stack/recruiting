// Test of trucks: their own page, oil changes, costs, history, the Telegram group, and dispatcher accounts.
// It starts the website itself (with /tmp/fresh.sh-style settings) pointed at the fakes.
//   node test/telegram.js
const http = require('http');
const { execSync } = require('child_process');
const BASE = 'http://localhost:3999';
const DB = 'postgresql://postgres@localhost:5433/recruiting_test?host=/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

// ---------- fake Telegram ----------
const tg = { updates: [], nextUpdate: 1, sent: [], edits: [], answers: [], nextMsg: 1000, files: {} };
const BOT = { id: 999, is_bot: true, first_name: 'FleetHire', username: 'fleethire_test_bot' };
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const out = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
    const p = JSON.parse(body || '{}');
    const fm = /^\/file\/bot[^/]+\/(.+)$/.exec(req.url); if (fm) { res.end(tg.files[fm[1]] || ''); return; }
    const method = req.url.split('/').pop();
    if (method === 'getMe') return out(BOT);
    if (method === 'getUpdates') {
      for (let i = 0; i < 10 && !tg.updates.some((u) => u.update_id >= (p.offset || 0)); i++) await sleep(100);
      return out(tg.updates.filter((u) => u.update_id >= (p.offset || 0)));
    }
    if (method === 'sendMessage') { const m = { message_id: ++tg.nextMsg, date: Math.floor(Date.now() / 1000), chat: { id: p.chat_id }, text: p.text, reply_markup: p.reply_markup }; tg.sent.push({ ...p, message_id: m.message_id }); return out(m); }
    if (method === 'editMessageText' || method === 'editMessageReplyMarkup') { tg.edits.push({ method, ...p }); return out(true); }
    if (method === 'answerCallbackQuery') { tg.answers.push(p); return out(true); }
    if (method === 'getChatMember') return out({ status: 'administrator', user: BOT });
    if (method === 'getFile') return out({ file_id: p.file_id, file_path: 'f/' + p.file_id, file_size: 10 });
    res.statusCode = 404; res.end(JSON.stringify({ ok: false, description: 'unknown ' + method }));
  });
}).listen(4999);
// ---------- fake AI: reads oil changes and payments from the dispatch group ----------
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body); const tool = j.tools[0].name; let input;
    const text = (j.messages[0].content.find((c) => c.type === 'text') || {}).text || '';
    if (tool === 'group_digest') {
      const fresh = text.split('NEW MESSAGES:')[1] || '';
      input = { truck_events: [], driver_notes: [], alerts: [] };
      if (/Oil change done at Speedco/.test(fresh)) input.truck_events.push({ kind: 'oil_change', title: 'Oil change', status: 'fixed', shop: 'Speedco', odometer: 452000, cost: 310, paid: true });
      if (/Brakes fixed at TA, \$1500, will pay Friday/.test(fresh)) input.truck_events.push({ kind: 'repair', title: 'Brakes', status: 'fixed', shop: 'TA', cost: 1500, paid: false });
      const unpaid = /Truck services not marked paid yet \(id: title, cost\): (\d+): Brakes/.exec(j.system);
      if (/Brakes are paid/.test(fresh) && unpaid) input.paid_ids = [+unpaid[1]];
      if (/odometer 455100/.test(fresh)) input.odometer = 455100;
    } else input = { summary: 'A day.', issues: [], mood: 'good' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input }] }));
  });
}).listen(4998);

const push = (u) => { u.update_id = tg.nextUpdate++; tg.updates.push(u); };
const DCHAT = { id: -100801, type: 'supergroup', title: 'Dispatch - Hank Hired' };
const ECHAT = { id: -100802, type: 'supergroup', title: 'ELD Zed Newman' };
const ACHAT = { id: -100803, type: 'supergroup', title: 'Accounting' };
let CHAT = DCHAT;
const RITA = { id: 11, is_bot: false, first_name: 'Rita', last_name: 'Recruiter', username: 'rita_r' };
const HANK = { id: 55, is_bot: false, first_name: 'Hank', last_name: 'Hired', username: 'hank_h' };
const DAN = { id: 66, is_bot: false, first_name: 'Dan', last_name: 'Dispatch', username: 'dan_d' };
const ACC = { id: 88, is_bot: false, first_name: 'Amy', last_name: 'Accounts', username: 'amy_acc' };
const STRANGER = { id: 99, is_bot: false, first_name: 'Some', last_name: 'One' };
const ELI = { id: 33, is_bot: false, first_name: 'Eli', last_name: 'Eld', username: 'eli_eld' };
let mid = 1;
const say = (from, text, extra = {}, chat = CHAT) => push({ message: { message_id: mid++, from, chat, date: Math.floor(Date.now() / 1000), text, ...extra } });
const photo = (from, fileId, content, chat = CHAT) => { tg.files['f/' + fileId] = content; push({ message: { message_id: mid++, from, chat, date: Math.floor(Date.now() / 1000), photo: [{ file_id: fileId + 's' }, { file_id: fileId }] } }); };
const tap = (from, data, msgId = 1, chat = CHAT) => push({ callback_query: { id: 'cq' + mid++, from, data, message: { message_id: msgId, chat, reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: data }]] } } } });
const sentSince = (n) => tg.sent.slice(n);
async function until(f, ms = 8000, what = '') { for (let i = 0; i < ms / 100; i++) { const v = await f(); if (v) return v; await sleep(100); } console.log('   (timed out waiting for ' + what + ')'); return null; }

(async () => {
  execSync(`pkill -f "node src/serve[r].js" || true; sleep 0.4; su postgres -c "psql -q -h /tmp -p 5433 -c 'DROP DATABASE IF EXISTS recruiting_test' -c 'CREATE DATABASE recruiting_test'"`, { stdio: 'ignore' });
  const env = { ...process.env, DATABASE_URL: DB, PGSSL: 'off', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-password-123', PORT: '3999',
    TELEGRAM_BOT_TOKEN: '999:test', TG_API_BASE: 'http://localhost:4999', TG_POLL_SECONDS: '1', TG_TICK_MS: '600000', TG_NO_QUIET: '1', TG_DIGEST_MS: '1000', TG_DIGEST_SETTLE_MIN: '0.03', TG_PROFILE_MS: '600000',
    ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4998', FLEET_TICK_MS: '1500' };
  require('child_process').spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', require('fs').openSync('/tmp/server.log', 'w'), require('fs').openSync('/tmp/server.log', 'a')], detached: true }).unref();
  const jar = {};
  const as = (who) => async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: jar[who] || '' }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && /sid=/.test(sc)) jar[who] = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  const A = as('admin'), D = as('dan'), R = as('rita');
  await until(async () => { try { return (await fetch(BASE + '/healthz')).ok; } catch (e) { return false; } }, 15000, 'server');
  await A('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // a dispatcher account and a recruiter
  const dan = (await A('/api/users', { method: 'POST', body: { name: 'Dan Dispatch', email: 'dan@example.com', password: 'dan-pass-12345', role: 'dispatcher' } })).id;
  await A('/api/users', { method: 'POST', body: { name: 'Rita Recruiter', email: 'rita@example.com', password: 'rita-pass-1234' } });
  ok((await pg.query(`SELECT role FROM users WHERE id = $1`, [dan])).rows[0].role === 'dispatcher', 'a dispatcher account is created');
  await D('/api/login', { method: 'POST', body: { email: 'dan@example.com', password: 'dan-pass-12345' } });
  await R('/api/login', { method: 'POST', body: { email: 'rita@example.com', password: 'rita-pass-1234' } });
  ok((await D('/api/me')).role === 'dispatcher', 'the dispatcher signs in');
  ok((await D('/api/drivers')).status === 403 && (await D('/api/dashboard')).status === 403 && (await D('/api/fb/day')).status === 403, 'a dispatcher cannot open leads, the dashboard or Facebook');
  ok((await D('/api/trucks')).status === 200 && (await D('/api/active')).status === 200 && (await D('/api/tg/chats')).status === 200, 'a dispatcher sees trucks, active drivers and Telegram groups');
  ok(!(await A('/api/share')).people || !(((await A('/api/share')).people || []).some((p) => p.id === dan && p.on)), 'a dispatcher gets no new leads');

  // a truck with a company and a driver: its history is kept
  const coA = (await A('/api/companies', { method: 'POST', body: { name: 'Bobtail Trucking' } })).id;
  const coB = (await A('/api/companies', { method: 'POST', body: { name: 'CMJ CO' } })).id;
  const hank = (await A('/api/drivers', { method: 'POST', body: { name: 'Hank Hired', source: 'Referral', phone: '2155550177' } })).id;
  await pg.query(`UPDATE drivers SET status = 'Hired' WHERE id = $1`, [hank]);
  const t = (await D('/api/trucks', { method: 'POST', body: { unit: 'T300', details: '2022 Freightliner Cascadia', companyId: coA, vin: '1fuj123', plate: 'nj-55', dispatcherId: dan } })).id;
  ok(!!t, 'the dispatcher adds a truck (VIN, plate, company, dispatcher)');
  await pg.query(`UPDATE trucks SET driver_id = $2 WHERE id = $1`, [t, hank]);
  await D('/api/trucks/' + t, { method: 'PATCH', body: { companyId: coB } });
  let p = await D('/api/trucks/' + t);
  ok(p.truck.vin === '1FUJ123' && p.truck.dispatcher === 'Dan Dispatch' && p.truck.company === 'CMJ CO', 'the truck\'s page: VIN, dispatcher, company');
  ok(p.history.some((h) => h.kind === 'driver' && h.to === 'Hank Hired') && p.history.some((h) => h.kind === 'company' && h.from === 'Bobtail Trucking' && h.to === 'CMJ CO'), 'history: Hank got the truck, it moved from Bobtail to CMJ');
  ok(p.oil.state === 'unknown', 'no oil change on record yet');

  // oil changes
  ok((await D(`/api/trucks/${t}/events`, { method: 'POST', body: { kind: 'oil_change', status: 'fixed', doneOn: day(-100), odometer: 400000, shop: 'Love\'s', cost: 289.5, paid: true } })).ok, 'an old oil change is logged (100 days ago, 400,000 mi)');
  p = await D('/api/trucks/' + t);
  ok(p.oil.state === 'overdue' && p.oil.daysLeft <= -9 && p.oil.dueMiles === 425000, 'overdue by days (every 90 days), next at 425,000 mi');
  ok((await D(`/api/trucks/${t}/events`, { method: 'POST', body: { kind: 'oil_change', status: 'fixed', doneOn: day(1), odometer: 425000 } })).status === 400, 'an oil change cannot be done tomorrow');
  await D(`/api/trucks/${t}/events`, { method: 'POST', body: { kind: 'oil_change', status: 'fixed', doneOn: day(0), odometer: 425000, shop: 'Speedco', cost: 300, paid: false } });
  p = await D('/api/trucks/' + t);
  ok(p.oil.state === 'ok' && p.oil.milesLeft === 25000 && p.oil.odometer === 425000, 'after today\'s oil change: OK, 25,000 mi left, mileage 425,000');
  ok((await D(`/api/trucks/${t}/miles`, { method: 'POST', body: { odometer: 420000 } })).status === 400, 'mileage cannot go back without "correct"');
  await D(`/api/trucks/${t}/miles`, { method: 'POST', body: { odometer: 448000 } });
  p = await D('/api/trucks/' + t);
  ok(p.oil.state === 'soon' && p.oil.milesLeft === 2000, 'at 448,000 mi: due soon, 2,000 mi left');
  ok(p.costs.month === 300 && p.costs.all === 589.5 && p.costs.unpaid === 300 && p.costs.byKind.oil_change === 589.5, 'costs: $300 this month, $589.50 in all, $300 not paid');
  const unpaidOil = p.events.find((e) => e.cost === 300);
  await D('/api/truck-events/' + unpaidOil.id, { method: 'PATCH', body: { paid: true } });
  ok((await D('/api/trucks/' + t)).costs.unpaid === 0, 'marked paid');
  const list = await D('/api/trucks');
  ok(list.summary.soon === 1 && list.trucks[0].oil.state === 'soon' && list.trucks[0].monthCost === 300, 'the Trucks list: 1 due soon, $300 this month');
  // the oil reminder goes to the truck's dispatcher and the admins
  ok(await until(async () => ((await D('/api/notices')).notices || []).some((x) => /Truck T300 \(Hank Hired\): oil change due soon: 2,000 mi left/.test(x.text)), 8000, 'reminder'), 'the dispatcher is reminded: oil change due soon');
  ok(((await A('/api/notices')).notices || []).some((x) => /Truck T300/.test(x.text)), 'and the admin');
  await sleep(2000);
  ok(((await D('/api/notices')).notices || []).filter((x) => /Truck T300/.test(x.text)).length === 1, 'once, not every hour');
  ok(!(((await R('/api/notices')).notices || []).some((x) => /Truck T300/.test(x.text))), 'recruiters are not bothered');
  // fleet settings
  ok((await R('/api/fleet/settings', { method: 'PUT', body: { oilMiles: 20000 } })).status === 403, 'a recruiter cannot change the oil interval');
  ok((await D('/api/fleet/settings', { method: 'PUT', body: { oilMiles: 20000 } })).oilMiles === 20000, 'the dispatcher sets every 20,000 miles');
  ok((await D('/api/trucks/' + t)).oil.state === 'overdue', 'now T300 is overdue (448,000 > 445,000)');
  await D('/api/trucks/' + t, { method: 'PATCH', body: { oilMiles: 30000 } });
  p = await D('/api/trucks/' + t);
  ok(p.oil.every.miles === 30000 && p.oil.state === 'ok', 'T300 has its own interval: 30,000 miles, OK again');

  // the Telegram dispatch group: oil change done and paid, a repair to pay, mileage
  await pg.query(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, linked_at) VALUES ($1, 'Dispatch - Hank Hired', 'dispatch', $2, now())`, [DCHAT.id, hank]);
  await until(async () => (await A('/api/tg/status')).bot, 8000, 'bot');
  say(HANK, 'Oil change done at Speedco, 452000 miles, paid $310');
  ok(await until(async () => (await D('/api/trucks/' + t)).events.some((e) => e.source === 'telegram' && e.kind === 'oil_change' && e.paid === true && e.cost === 310), 15000, 'digest oil'), 'Telegram: "oil change done, paid" is in the truck\'s history, paid, $310');
  p = await D('/api/trucks/' + t);
  ok(p.oil.last.odometer === 452000 && p.oil.odometer === 452000 && p.oil.milesLeft === 30000, 'the next oil change counts from 452,000 mi'); if (process.env.DBG) console.log(JSON.stringify(p.oil), JSON.stringify(p.events.filter((e) => e.kind === 'oil_change')));
  say(HANK, 'Brakes fixed at TA, $1500, will pay Friday');
  ok(await until(async () => (await D('/api/trucks/' + t)).costs.unpaid === 1500, 15000, 'brakes'), 'a repair not paid yet: $1,500 not paid');
  say(DAN, 'Brakes are paid. Hank, odometer 455100 now');
  ok(await until(async () => { const x = await D('/api/trucks/' + t); return x.costs.unpaid === 0 && x.oil.odometer === 455100; }, 15000, 'paid'), 'the group says it is paid: marked paid, and the mileage is updated');

  // the dispatcher's page and the role
  const pp = await A('/api/team/' + dan);
  ok(pp.fleetWork && pp.fleetWork.trucks.length === 1 && pp.fleetWork.entries >= 4, 'the dispatcher\'s page: 1 truck, the entries they made');
  ok((await D('/api/team/me')).status === 200 && (await D('/api/team/1')).status === 403, 'the dispatcher sees their own activity, not others\'');
  ok((await A('/api/users/' + dan, { method: 'PATCH', body: { role: 'member' } })).ok && (await D('/api/drivers')).status === 200, 'made a recruiter: leads open');
  await A('/api/users/' + dan, { method: 'PATCH', body: { role: 'dispatcher' } });
  if (process.env.SHOTS) {
    const { chromium } = require('playwright'); const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const pg2 = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); const errs = []; pg2.on('pageerror', (e) => errs.push(e.message));
    await pg2.goto(BASE + '/#/login'); await pg2.fill('input[name=email]', 'dan@example.com'); await pg2.fill('input[name=password]', 'dan-pass-12345'); await pg2.click('#lf button'); await pg2.waitForSelector('.rail');
    await pg2.waitForSelector('table.trucks'); ok(/#\/trucks$/.test(pg2.url()), 'a dispatcher lands on Trucks');
    ok(!(await pg2.locator('#rail a[href="#/leads"]').count()) && (await pg2.locator('#rail a[href="#/trucks"]').count()) === 1, 'their menu: no leads');
    await pg2.screenshot({ path: '/tmp/e2e-web/fl-trucks.png' });
    await pg2.click('a.unit'); await pg2.waitForSelector('.oilhero'); await pg2.screenshot({ path: '/tmp/e2e-web/fl-truck.png', fullPage: true });
    await pg2.click('[data-act=evAdd][data-k=oil_change]'); await pg2.waitForSelector('#evForm'); await pg2.screenshot({ path: '/tmp/e2e-web/fl-oil.png' });
    await pg2.fill('#evForm [name=odometer]', '456000'); await pg2.fill('#evForm [name=cost]', '295'); await pg2.click('#evForm .btn.primary');
    await pg2.waitForSelector('#evForm', { state: 'hidden' }); await pg2.waitForTimeout(600);
    ok((await pg2.locator('.oilhero.ok').count()) === 1 && /30,000 mi left/.test(await pg2.locator('.oilhero').textContent()), 'logged from the page: up to date, 30,000 mi left');
    await pg2.click('a[href="#/driver/' + hank + '"]'); await pg2.waitForSelector('#dlg .dprof'); await pg2.keyboard.press('Escape');
    await pg2.goto(BASE + '/#/leads'); await pg2.waitForTimeout(800); ok(/#\/trucks$/.test(pg2.url()), 'a dispatcher sent to /leads is taken back to Trucks');
    await pg2.click('[data-act=fleetSettings]'); await pg2.waitForSelector('#fsForm'); await pg2.screenshot({ path: '/tmp/e2e-web/fl-settings.png' }); await pg2.keyboard.press('Escape');
    const ap = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); ap.on('pageerror', (e) => errs.push(e.message));
    await ap.goto(BASE + '/#/login'); await ap.fill('input[name=email]', 'admin@example.com'); await ap.fill('input[name=password]', 'test-password-123'); await ap.click('#lf button'); await ap.waitForSelector('.rail');
    await ap.goto(BASE + '/#/team/' + dan); await ap.waitForSelector('.tlist'); await ap.screenshot({ path: '/tmp/e2e-web/fl-person.png', fullPage: true });
    await ap.click('[data-act=personRole]'); await ap.waitForSelector('#roleForm'); await ap.screenshot({ path: '/tmp/e2e-web/fl-role.png' });
    await ap.setViewportSize({ width: 390, height: 900 }); await ap.goto(BASE + '/#/truck/' + t); await ap.waitForSelector('.oilhero'); await ap.screenshot({ path: '/tmp/e2e-web/fl-mobile.png', fullPage: true });
    ok(!errs.length, 'no page errors ' + errs.join(' | ')); await b.close();
  }
  await pg.end();
  execSync('pkill -f "node src/serve[r].js" || true');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
