// Test of registering groups, the bot reading every message (truck, driver notes, alerts), profiles and accounting.
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
// ---------- fake AI ----------
let aiCalls = 0; const seen = { images: 0 };
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    aiCalls++; const j = JSON.parse(body); const tool = j.tools[0].name; let input;
    const text = (j.messages[0].content.find((c) => c.type === 'text') || {}).text || '';
    if (tool === 'group_digest') {
      const imgs = j.messages[0].content.filter((c) => c.type === 'image'); seen.images += imgs.length;
      const pics = imgs.map((i) => Buffer.from(i.source.data, 'base64').toString()).join(' ');
      const fresh = text.split('NEW MESSAGES:')[1] || '';
      input = { truck_events: [], driver_notes: [], alerts: [] };
      if (/Check engine light came on/.test(fresh)) input.truck_events.push({ kind: 'warning_light', title: 'Check engine light', details: 'Came on near Harrisburg', status: 'open' });
      if (/oil change done/i.test(fresh)) input.truck_events.push({ kind: 'oil_change', title: 'Oil change', status: 'fixed', shop: 'Speedco', odometer: 412000, cost: 289.5 });
      const open = /Open truck issues \(id: title\): (\d+): Check engine light/.exec(j.system);
      if (/light is off/.test(fresh) && open) input.fixed_issue_ids = [+open[1]];
      if (/call me at 7 AM/.test(fresh)) input.driver_notes.push({ kind: 'routine', text: 'Wants a wake-up call at 7 AM every day' });
      if (/NYC/.test(fresh)) input.driver_notes.push({ kind: 'dislikes_loads', text: 'Does not like NYC loads' });
      if (/ABCU1026430/.test(fresh) && /ABCU1026340/.test(pics)) input.alerts.push({ kind: 'container_mismatch', severity: 'high', text: 'Photo shows ABCU1026340, the load is ABCU1026430', ask_driver: 'the photo shows ABCU 1026340 but the load is ABCU 1026430. Is this the right container?' });
      if (/Appointment moved to 3 PM/.test(fresh)) input.alerts.push({ kind: 'appointment_change', severity: 'low', text: 'Delivery appointment moved to 3 PM' });
      if (/useless/.test(fresh)) input.alerts.push({ kind: 'unprofessional_dispatcher', severity: 'high', text: 'Dispatcher Dan called the driver useless' });
    } else if (tool === 'driver_profile') {
      input = { summary: 'Steady driver, likes regional runs.', reliability: 'high', supervision: 'light_check_ins', work_style: 'Runs long weeks', routines: ['Wake-up call at 7 AM'], requests: [], likes_loads: ['Regional PA loads'], dislikes_loads: ['NYC loads'], home_time: '', communication: 'Short and direct', tips_for_dispatchers: ['Call at 7 AM sharp'], watch_outs: [] };
      if (!/PINNED[^]*No night driving/.test(text)) input.summary += ' (no pins)';
    } else if (tool === 'reply_plan') {
      const t = text.split("new message:\n")[1] || '';
      input = /payday/i.test(t) ? { is_question: true, confident: true, answer: 'Pay day is every Friday.', progress: 'none', mood: 'good' }
        : /\?/.test(t) ? { is_question: true, confident: false, answer: '', progress: 'none', mood: 'neutral' } : { is_question: false, confident: false, answer: '', progress: 'none', mood: 'neutral' };
      if (/accounting assistant/.test(j.system) && /deducted/.test(t) && /Q: Why was \$50 deducted/.test(j.system)) input = { is_question: true, confident: true, answer: 'That is the weekly ELD fee.', progress: 'none', mood: 'good' };
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
    TELEGRAM_BOT_TOKEN: '999:test', TG_API_BASE: 'http://localhost:4999', TG_POLL_SECONDS: '1', TG_TICK_MS: '1000', TG_NO_QUIET: '1', TG_DIGEST_MS: '1000', TG_DIGEST_SETTLE_MIN: '0.05', TG_PROFILE_MS: '600000', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4998' };
  require('child_process').spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', require('fs').openSync('/tmp/server.log', 'w'), require('fs').openSync('/tmp/server.log', 'a')], detached: true }).unref();
  let cookie = '';
  const web = async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: opts.cookie || cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && !opts.cookie) cookie = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  await until(async () => { try { return (await fetch(BASE + '/healthz')).ok; } catch (e) { return false; } }, 15000, 'server');
  await web('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  await until(async () => { const s = await web('/api/tg/status'); return s.running && s.bot; }, 10000, 'bot');
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  const rita = (await web('/api/users', { method: 'POST', body: { name: 'Rita Recruiter', email: 'rita@example.com', password: 'rita-pass-1234' } })).id;
  const R = async (path, opts = {}) => { if (!R.c) { const o = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rita@example.com', password: 'rita-pass-1234' }) }); R.c = o.headers.get('set-cookie').split(';')[0]; } return web(path, { ...opts, cookie: R.c }); };
  // an active driver with a truck
  const hank = (await web('/api/drivers', { method: 'POST', body: { name: 'Hank Hired', source: 'Referral', phone: '2155550177', mode: 'Company drivers', ownerId: rita } })).id;
  await pg.query(`UPDATE drivers SET status = 'Hired' WHERE id = $1`, [hank]);
  const truck = (await web('/api/trucks', { method: 'POST', body: { unit: 'T200', details: '2023 Freightliner Cascadia' } })).id;
  await pg.query(`UPDATE trucks SET driver_id = $2 WHERE id = $1`, [truck, hank]);

  // someone the bot does not know cannot register a group
  say(STRANGER, 'register dispatch');
  ok(await until(() => tg.sent.some((m) => /I don't know you yet/.test(m.text))), 'a stranger cannot register a group');
  // Rita connects her Telegram with a code from the website
  const me = await R('/api/tg/me-code', { method: 'POST', body: {} });
  push({ message: { message_id: mid++, from: RITA, chat: { id: 11, type: 'private', first_name: 'Rita' }, date: Math.floor(Date.now() / 1000), text: '/me ' + me.code } });
  ok(await until(() => tg.sent.some((m) => /Connected: you are <b>Rita Recruiter<\/b>/.test(m.text))), 'Rita connects her Telegram (/me code)');
  // register the dispatch group: the driver is found from the group's name
  let n = tg.sent.length; say(RITA, 'register dispatch');
  ok(await until(() => sentSince(n).some((m) => /now the <b>Dispatch<\/b> group for <b>Hank Hired<\/b>/.test(m.text))), 'register dispatch: the group name says Hank Hired: linked as Hank\'s dispatch group');
  ok(await until(() => sentSince(n).some((m) => /I keep track of this group for the team/.test(m.text))), 'an active driver\'s group: the bot just says it keeps track');
  // a fleet driver who is not on the website yet: added from Telegram
  n = tg.sent.length; say(RITA, 'register eld', {}, ECHAT);
  const pick2 = await until(() => sentSince(n).find((m) => /Which driver is this <b>ELD<\/b> group for\?/.test(m.text)));
  const add = pick2 && pick2.reply_markup.inline_keyboard.flat().find((b) => /Add "Zed Newman" as an active driver/.test(b.text));
  ok(!!add, 'no such driver: "Add Zed Newman as an active driver"');
  tap(RITA, add.callback_data, 1, ECHAT);
  ok(await until(() => tg.sent.some((m) => /now the <b>ELD<\/b> group for <b>Zed Newman<\/b>/.test(m.text))), 'added and linked');
  const zed = (await pg.query(`SELECT id, status FROM drivers WHERE name = 'Zed Newman'`)).rows[0];
  ok(zed && zed.status === 'Hired', 'Zed Newman is on the website as an active driver');
  // accounting group, with the name in the command
  n = tg.sent.length; say(RITA, 'register accounting Hank', {}, ACHAT);
  const pick3 = await until(() => sentSince(n).find((m) => /<b>Accounting<\/b> group for\?/.test(m.text)));
  tap(RITA, pick3.reply_markup.inline_keyboard[0][0].callback_data, 1, ACHAT);
  ok(await until(() => tg.sent.some((m) => /accounting<\/b> group for <b>Hank Hired<\/b>/.test(m.text))), 'accounting group registered for Hank');
  tap(ACC, `acc:${hank}:iam`, 1, ACHAT);
  ok(await until(() => tg.answers.some((a) => /you are with accounting/.test(a.text))), 'Amy says she is with accounting');
  n = tg.sent.length; say(HANK, 'When is payday?', {}, ACHAT);
  ok(await until(() => sentSince(n).some((m) => /Pay day is every Friday/.test(m.text))), 'accounting: the bot answers what it knows');
  n = tg.sent.length; say(HANK, 'Why was $50 deducted?', {}, ACHAT);
  const aq = await until(() => sentSince(n).find((m) => /Let me check with @amy_acc/.test(m.text)));
  ok(!!aq, 'not sure: it tags accounting (Amy)');
  say(ACC, 'That is the weekly ELD fee.', { reply_to_message: { message_id: aq.message_id } }, ACHAT);
  ok(await until(async () => (await R('/api/tg/knowledge')).knowledge.some((k) => /deducted/.test(k.question) && /ELD fee/.test(k.answer))), 'Amy\'s answer is learned');
  // the active drivers page shows each driver's groups
  const act = await web('/api/active'); const h = act.drivers.find((d) => d.id === hank); const z = act.drivers.find((d) => d.id === zed.id);
  ok(h && h.groups.dispatch && h.groups.accounting && !h.groups.eld && z && z.groups.eld, 'Active drivers: Hank has dispatch and accounting (no ELD yet), Zed has ELD');

  // the bot reads the dispatch group: truck, driver notes, alerts, the container in a photo
  CHAT = DCHAT;
  say(HANK, 'Check engine light came on near Harrisburg');
  say(DAN, 'Pick up container ABCU1026430 at door 12');
  photo(HANK, 'cont1', 'CONTAINER ABCU1026340');
  say(HANK, 'Please call me at 7 AM every day, and no NYC loads for me');
  say(HANK, 'Appointment moved to 3 PM');
  ok(await until(() => tg.sent.some((m) => /🔎 @hank_h, the photo shows ABCU 1026340 but the load is ABCU 1026430/.test(m.text)), 15000), 'a container in the photo that does not match the load: the bot asks the driver right away');
  ok(seen.images >= 1, 'the AI was shown the photo');
  ok(await until(() => tg.sent.some((m) => /📌 Noted: Delivery appointment moved to 3 PM/.test(m.text))), 'an appointment change: noted in the group');
  const tr = await until(async () => { const t = (await web('/api/trucks')).trucks.find((x) => x.id === truck); return t && t.openIssues ? t : null; });
  ok(tr && tr.openIssues === 1 && /Check engine light/.test(tr.lastEvent.title), 'the check engine light is on truck T200\'s issues');
  ok(await until(async () => ((await web('/api/notices')).notices || []).some((x) => /Truck T200 of Hank Hired: Check engine light/.test(x.text))), 'the admins hear about the warning light');
  const pr = await R(`/api/drivers/${hank}/profile`);
  ok(pr.notesCount === 2 && pr.notes.some((x) => /7 AM/.test(x.text)) && pr.notes.some((x) => /NYC/.test(x.text)), 'two notes about Hank: the 7 AM call and no NYC loads');
  // next batch: fixed, oil change, a rude dispatcher
  say(HANK, 'Shop says all good, the light is off now. Oil change done at Speedco too');
  say(DAN, 'You are useless, just drive');
  ok(await until(async () => (await web(`/api/trucks/${truck}/events`)).events.some((e) => /Check engine/.test(e.title) && e.status === 'fixed'), 15000), 'the light is off: the issue is marked fixed');
  const ev = (await web(`/api/trucks/${truck}/events`)).events;
  ok(ev.some((e) => e.kind === 'oil_change' && e.status === 'fixed' && e.shop === 'Speedco' && e.odometer === 412000 && e.cost === 289.5), 'the oil change is in the truck\'s history (shop, miles, cost)');
  ok(await until(async () => ((await web('/api/notices')).notices || []).some((x) => /Dispatcher conduct in Hank Hired's group/.test(x.text))), 'a rude dispatcher: the admins are told');
  ok(!((await R('/api/notices')).notices || []).some((x) => /Dispatcher conduct/.test(x.text)) && !(await R('/api/tg/alerts')).alerts.some((a) => a.kind === 'unprofessional_dispatcher'), 'the recruiter does not see dispatcher conduct alerts');
  const al = (await web('/api/tg/alerts')).alerts;
  ok(al.some((a) => a.kind === 'container_mismatch') && al.some((a) => a.kind === 'unprofessional_dispatcher'), 'the admin sees the alerts');
  ok((await web('/api/tg/alerts/' + al[0].id, { method: 'PATCH', body: {} })).ok && (await web('/api/tg/alerts')).alerts.length === al.length - 1, 'an alert can be marked done');
  // the profile for dispatchers
  await R(`/api/drivers/${hank}/profile`, { method: 'PUT', body: { pins: 'No night driving.' } });
  await R(`/api/drivers/${hank}/profile/build`, { method: 'POST', body: {} });
  const pf = await R(`/api/drivers/${hank}/profile`);
  ok(pf.profile && pf.profile.reliability === 'high' && !/no pins/.test(pf.profile.summary) && pf.pins === 'No night driving.', 'the profile is built, with the team\'s own notes');
  ok(/Wake-up call at 7 AM/.test(pf.text) && /NYC loads/.test(pf.text) && /No night driving/.test(pf.text), 'a text to hand to a new dispatcher');
  n = tg.sent.length; push({ message: { message_id: mid++, from: RITA, chat: { id: 11, type: 'private', first_name: 'Rita' }, date: Math.floor(Date.now() / 1000), text: '/driver Hank' } });
  ok(await until(() => sentSince(n).some((m) => m.chat_id === 11 && /Hank Hired/.test(m.text) && /Wake-up call at 7 AM/.test(m.text))), '/driver Hank in a private chat: the profile, only to the team');
  n = tg.sent.length; push({ message: { message_id: mid++, from: STRANGER, chat: { id: 99, type: 'private', first_name: 'Some' }, date: Math.floor(Date.now() / 1000), text: '/driver Hank' } });
  ok(await until(() => sentSince(n).some((m) => m.chat_id === 99 && /Only our team/.test(m.text))), 'not to strangers');
  ok(!tg.sent.some((m) => m.chat_id === DCHAT.id && /Reliability/.test(m.text)), 'the profile is never posted in the driver\'s group');
  // trucks by hand
  ok((await R(`/api/trucks/${truck}/events`, { method: 'POST', body: { title: 'New steer tires', kind: 'tires', status: 'scheduled' } })).ok, 'an issue logged by hand');
  const e2 = (await R(`/api/trucks/${truck}/events`)).events.find((e) => e.title === 'New steer tires');
  ok((await R('/api/truck-events/' + e2.id, { method: 'PATCH', body: { status: 'fixed' } })).ok && (await R(`/api/trucks/${truck}/events`)).events.find((e) => e.id === e2.id).status === 'fixed', 'and marked fixed');
  const g = (await web('/api/tg/chats/' + DCHAT.id));
  ok(g.alerts.length >= 2 && g.truckEvents.length >= 2 && g.notes.length === 2, 'the group page shows alerts, truck issues and notes');
  if (process.env.SHOTS) {
    const { chromium } = require('playwright'); const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE + '/#/login'); await p.fill('input[name=email]', 'admin@example.com'); await p.fill('input[name=password]', 'test-password-123'); await p.click('#lf button'); await p.waitForSelector('.rail');
    await p.goto(BASE + '/#/driver/' + hank); await p.waitForSelector('#dprof:not([hidden]) .pbadges'); await p.locator('#dprof').screenshot({ path: '/tmp/e2e-web/tgd-profile.png' });
    await p.goto(BASE + '/#/trucks'); await p.waitForSelector('.tiss'); await p.screenshot({ path: '/tmp/e2e-web/tgd-trucks.png' });
    await p.click('[data-truck] .tiss.open, [data-truck] .tiss'); await p.waitForSelector('.tissues'); await p.screenshot({ path: '/tmp/e2e-web/tgd-truckdlg.png' }); await p.keyboard.press('Escape');
    await p.goto(BASE + '/#/active'); await p.waitForSelector('.tgcell'); await p.screenshot({ path: '/tmp/e2e-web/tgd-active.png' });
    await p.goto(BASE + '/#/telegram'); await p.waitForSelector('.tgal'); await p.screenshot({ path: '/tmp/e2e-web/tgd-list.png' });
    await p.goto(BASE + '/#/telegram/' + DCHAT.id); await p.waitForSelector('.tgcols'); await p.screenshot({ path: '/tmp/e2e-web/tgd-chat.png', fullPage: true });
    await p.goto(BASE + '/#/telegram'); await p.click('[data-act=tgMe]'); await p.waitForSelector('#dlg .gcopy'); await p.screenshot({ path: '/tmp/e2e-web/tgd-me.png' });
    ok(!errs.length, 'no page errors ' + errs.join(' | ')); await b.close();
  }
  await pg.end();
  execSync('pkill -f "node src/serve[r].js" || true');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
