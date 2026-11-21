// Test of the Telegram bot's ELD group, against a fake Telegram and a fake AI started here.
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
let aiCalls = 0;
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    aiCalls++; const j = JSON.parse(body); const tool = j.tools[0].name; let input;
    if (tool === 'document_kind') {
      const blk = j.messages[0].content[0]; const txt = Buffer.from(blk.source.data, 'base64').toString();
      input = { kind: /CDL/.test(txt) ? 'cdl' : /REG/.test(txt) ? 'registration' : 'other', note: /CDL/.test(txt) ? 'front of a CDL' : 'a document' };
    } else input = { summary: 'Ruby sent her CDL and registration. The ELD team sent the login and found a missing trailer number, now fixed.', issues: ['Logs not signed on the first day'], mood: 'good' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input }] }));
  });
}).listen(4998);

const push = (u) => { u.update_id = tg.nextUpdate++; tg.updates.push(u); };
const CHAT = { id: -100500, type: 'supergroup', title: 'ELD · Ruby Ready' };
const RITA = { id: 11, is_bot: false, first_name: 'Rita', last_name: 'Recruiter', username: 'rita_r' };
const RUBY = { id: 22, is_bot: false, first_name: 'Ruby', last_name: 'Ready', username: 'ruby_r' };
const ELI = { id: 33, is_bot: false, first_name: 'Eli', last_name: 'Eld', username: 'eli_eld' };
let mid = 1;
const say = (from, text, extra = {}) => push({ message: { message_id: mid++, from, chat: CHAT, date: Math.floor(Date.now() / 1000), text, ...extra } });
const photo = (from, fileId, content) => { tg.files['f/' + fileId] = content; push({ message: { message_id: mid++, from, chat: CHAT, date: Math.floor(Date.now() / 1000), photo: [{ file_id: fileId + 's' }, { file_id: fileId }] } }); };
const tap = (from, data, msgId = 1) => push({ callback_query: { id: 'cq' + mid++, from, data, message: { message_id: msgId, chat: CHAT, reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: data }]] } } } });
const sentSince = (n) => tg.sent.slice(n);
async function until(f, ms = 8000, what = '') { for (let i = 0; i < ms / 100; i++) { const v = await f(); if (v) return v; await sleep(100); } console.log('   (timed out waiting for ' + what + ')'); return null; }

(async () => {
  execSync(`pkill -f "node src/serve[r].js" || true; sleep 0.4; su postgres -c "psql -q -h /tmp -p 5433 -c 'DROP DATABASE IF EXISTS recruiting_test' -c 'CREATE DATABASE recruiting_test'"`, { stdio: 'ignore' });
  const env = { ...process.env, DATABASE_URL: DB, PGSSL: 'off', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-password-123', PORT: '3999',
    TELEGRAM_BOT_TOKEN: '123:test', TG_API_BASE: 'http://localhost:4999', TG_POLL_SECONDS: '1', TG_TICK_MS: '1000', TG_NO_QUIET: '1', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4998' };
  require('child_process').spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', require('fs').openSync('/tmp/server.log', 'w'), require('fs').openSync('/tmp/server.log', 'a')], detached: true }).unref();
  let cookie = '';
  const web = async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: opts.cookie || cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && !opts.cookie) cookie = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  await until(async () => { try { return (await fetch(BASE + '/healthz')).ok; } catch (e) { return false; } }, 15000, 'server');
  await web('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  const st = await until(async () => { const s = await web('/api/tg/status'); return s.running && s.bot ? s : null; }, 10000, 'bot');
  ok(st && st.bot.username === 'fleethire_test_bot' && st.ai, 'the bot is on as @fleethire_test_bot, with AI');

  // a driver in onboarding
  const co = (await web('/api/companies', { method: 'POST', body: { name: 'Bobtail Trucking LLC' } })).id;
  const id = (await web('/api/drivers', { method: 'POST', body: { name: 'Ruby Ready', source: 'Indeed', phone: '2155550199', email: 'ruby@example.com', mode: 'Company drivers' } })).id;
  await web('/api/drivers/' + id, { method: 'PATCH', body: { status: 'Onboarding', companyId: co } });
  const truck = (await web('/api/trucks', { method: 'POST', body: { unit: '118', details: '2022 Freightliner Cascadia' } })).id;
  await web(`/api/drivers/${id}/onboarding`, { method: 'PATCH', body: { truckId: truck } });

  // the bot is added to a group
  push({ my_chat_member: { chat: CHAT, from: RITA, date: 1, old_chat_member: { status: 'left', user: BOT }, new_chat_member: { status: 'member', user: BOT } } });
  ok(await until(() => tg.sent.some((m) => m.chat_id === CHAT.id && /link code/.test(m.text)), 5000, 'intro'), 'added to a group: the bot says how to link it');
  say(RITA, '/link 000000');
  ok(await until(() => tg.sent.some((m) => /not valid/.test(m.text))), 'a wrong code is refused');
  const code = (await web(`/api/drivers/${id}/tg-link`, { method: 'POST', body: { kind: 'eld' } })).code;
  ok(/^\d{6}$/.test(code), 'the website makes a 6-digit link code');
  let n = tg.sent.length; say(RITA, '/link ' + code);
  await until(() => tg.sent.some((m) => /please send here/.test(m.text || '')), 8000, 'docs prompt');
  const after = sentSince(n).map((m) => m.text).join('\n----\n');
  ok(/now the <b>ELD<\/b> group for <b>Ruby Ready<\/b>/.test(after), 'linked: "This is now the ELD group for Ruby Ready"');
  ok(/Phone: \(215\) 555-0199/.test(after) && /ruby@example.com/.test(after) && /Bobtail Trucking LLC/.test(after) && /118 \(2022 Freightliner Cascadia\)/.test(after), 'the driver\'s info goes to the ELD team: phone, email, company, truck');
  ok(/ELD setup: Ruby Ready/.test(after) && /✅ Driver info shared/.test(after) && /⬜ CDL photo shared/.test(after), 'a setup card with the steps');
  const d1 = (await web('/api/drivers/' + id)).onboarding.items.find((i) => i.key === 'eld_group');
  ok(d1 && d1.done, 'the onboarding step "ELD group set up" ticks itself');

  // who is who
  tap(RUBY, `eld:${id}:iam:driver`); tap(ELI, `eld:${id}:iam:eld`);
  ok(await until(() => tg.answers.some((a) => /you are the driver/.test(a.text)) && tg.answers.some((a) => /ELD team ✓/.test(a.text))), 'the driver and the ELD person say who they are');
  // documents: the AI reads the pictures
  photo(RUBY, 'cdl1', 'CDL front picture');
  ok(await until(() => tg.sent.some((m) => /Got it: CDL photo ✓/.test(m.text))), 'a photo of the CDL is recognised and ticked');
  n = tg.sent.length; tg.files['f/reg1'] = 'REG cab card'; push({ message: { message_id: mid++, from: RUBY, chat: CHAT, date: Math.floor(Date.now() / 1000), document: { file_id: 'reg1', mime_type: 'application/pdf', file_name: 'reg.pdf' } } });
  ok(await until(() => sentSince(n).some((m) => /@eli_eld, the documents for <b>Ruby Ready<\/b> are above/.test(m.text))), 'registration PDF recognised; the ELD team is tagged to send the login');
  // the ELD login (hidden when saved)
  n = tg.sent.length; say(ELI, 'Login: rubyready01\nPassword: Secret#99');
  ok(await until(() => sentSince(n).some((m) => /@ruby_r, please:/.test(m.text) && /Log in to the ELD app/.test(m.text))), 'login received; the driver is asked to log in, keep the manual and paper logs');
  const chat0 = await web('/api/tg/chats/' + CHAT.id);
  const saved = chat0.messages.find((m) => /rubyready01/.test(m.text || ''));
  ok(saved && !/Secret#99/.test(saved.text) && /\[hidden\]/.test(saved.text), 'the password is hidden on the website: ' + (saved && saved.text.replace(/\n/g, ' ')));
  // only the driver can tap the driver's buttons
  tap(ELI, `eld:${id}:mark:logged_in`);
  ok(await until(() => tg.answers.some((a) => /Only the driver can tap this/.test(a.text))), 'the ELD team cannot tap the driver\'s buttons');
  n = tg.sent.length;
  for (const k of ['logged_in', 'manual', 'paper']) tap(RUBY, `eld:${id}:mark:${k}`);
  ok(await until(() => sentSince(n).some((m) => /@eli_eld, <b>Ruby Ready<\/b> is logged in/.test(m.text))), 'driver steps done; the ELD team is asked to check the setup');
  // a setup problem, then good
  tap(ELI, `eld:${id}:setup_problem`);
  await until(() => tg.sent.some((m) => /what is wrong with the setup/.test(m.text)));
  n = tg.sent.length; say(ELI, 'Trailer number missing in the profile');
  ok(await until(() => sentSince(n).some((m) => /@ruby_r, the ELD team found a problem with the setup/.test(m.text) && /Trailer number missing/.test(m.text))), 'a setup problem goes to the driver');
  ok(await until(async () => ((await web('/api/notices')).notices || []).some((x) => x.kind === 'tg' && /ELD setup problem for Ruby Ready/.test(x.text))), 'and to the website (recruiter and admins)');
  n = tg.sent.length; tap(ELI, `eld:${id}:mark:checked`);
  ok(await until(() => sentSince(n).some((m) => /ELD setup for Ruby Ready is complete/.test(m.text))), 'setup checked: complete, daily checks start');
  const ob = (await web('/api/drivers/' + id)).onboarding.items.find((i) => i.key === 'eld_profile');
  ok(ob && ob.done, 'the onboarding step "ELD profile set up" ticks itself');
  ok(tg.edits.some((e) => e.method === 'editMessageText' && /✅ ELD team checked the setup/.test(e.text)), 'the setup card is kept up to date');

  // daily checks: a check time two minutes ago
  const tz = (await web('/api/settings')).tz;
  const hm = (minAgo) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() - minAgo * 60000));
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  await pg.query(`UPDATE eld_cases SET setup_done_at = now() - interval '3 hours'`);
  n = tg.sent.length;
  await web('/api/settings', { method: 'PUT', body: { tg: { eldTimes: [hm(2)], eldDays: 14, remindMin: 15 } } });
  const ck = await until(() => sentSince(n).find((m) => /ELD check: Ruby Ready/.test(m.text)), 8000, 'daily check');
  ok(ck && /@eli_eld, please check today's logs/.test(ck.text) && /day 1 of 14/.test(ck.text), 'at the check time the ELD team is tagged to check the logs (day 1 of 14)');
  const checkId = ck && ck.reply_markup.inline_keyboard[0][1].callback_data.split(':')[3];
  tap(ELI, `eld:${id}:check_problem:${checkId}`);
  await until(() => tg.sent.some((m) => /what is wrong\? Reply here/.test(m.text)));
  n = tg.sent.length; say(ELI, 'Logs from yesterday are not signed');
  const fx = await until(() => sentSince(n).find((m) => /found a problem in your logs/.test(m.text)));
  ok(fx && /@ruby_r/.test(fx.text) && /not signed/.test(fx.text), 'a problem in the logs goes to the driver, with a Fixed button');
  n = tg.sent.length; tap(RUBY, fx.reply_markup.inline_keyboard[0][0].callback_data);
  ok(await until(() => sentSince(n).some((m) => /says it is fixed. @eli_eld, please take another look/.test(m.text))), 'driver taps Fixed: the ELD team is asked to look again');
  // a check nobody answers: a reminder, then the website hears
  n = tg.sent.length;
  await web('/api/settings', { method: 'PUT', body: { tg: { eldTimes: [hm(2), hm(5)] } } });
  const ck2 = await until(() => sentSince(n).find((m) => /ELD check: Ruby Ready/.test(m.text)), 8000, 'second check');
  await pg.query(`UPDATE eld_checks SET asked_at = now() - interval '20 minutes' WHERE answer IS NULL`);
  ok(await until(() => tg.sent.some((m) => /⏰ Reminder: 📋/.test(m.text))), 'no answer: the ELD team is tagged again');
  await pg.query(`UPDATE eld_checks SET asked_at = now() - interval '40 minutes' WHERE answer IS NULL`);
  ok(await until(async () => ((await web('/api/notices')).notices || []).some((x) => /has not done the .* check for Ruby Ready/.test(x.text))), 'still no answer: the recruiter and admins are told on the website');
  ok(!!ck2, 'each check time gets its own check');

  // the website: list, group page, summary
  const list = (await web('/api/tg/chats')).chats; const g = list.find((c) => +c.chatId === CHAT.id);
  ok(g && g.kind === 'eld' && g.driver === 'Ruby Ready' && g.eld.phase === 'done' && g.eld.setupDoneAt, 'the Telegram manager lists the group: ELD, Ruby Ready, setup done');
  const s = await web(`/api/tg/chats/${CHAT.id}/summary`, { method: 'POST', body: {} });
  const det = await web('/api/tg/chats/' + CHAT.id);
  ok(s.ok && det.summaries[0] && /Ruby sent her CDL/.test(det.summaries[0].summary) && det.summaries[0].issues[0] === 'Logs not signed on the first day', 'the AI summary of the day is kept');
  ok(det.checks.some((k) => k.answer === 'problem' && k.fixed_at) && det.eld.steps.every((x) => x.done), 'checks and steps are on the group page');
  ok(det.people.some((p) => p.name === 'Ruby Ready' && p.role === 'driver') && det.people.some((p) => p.name === 'Eli Eld' && p.role === 'eld'), 'people with their roles');
  ok(det.messages.some((m) => m.media === 'photo' && /cdl: front of a CDL/.test(m.media_note || '')), 'pictures are not kept, only what they show');
  const dg = await web(`/api/drivers/${id}/tg`); ok(dg.groups.length === 1 && dg.groups[0].kind === 'eld', 'the lead page lists its Telegram group');
  // another recruiter cannot see this driver's group
  await web('/api/users', { method: 'POST', body: { name: 'Other Rec', email: 'other@example.com', password: 'other-pass-1234' } });
  const rita = (await web('/api/users', { method: 'POST', body: { name: 'Rita Recruiter', email: 'rita@example.com', password: 'rita-pass-1234' } })).id;
  ok((await web('/api/drivers/' + id, { method: 'PATCH', body: { ownerId: rita } })).ok, 'the lead goes to Rita');
  await web('/api/settings', { method: 'PUT', body: { visibility: 'own' } });
  const o = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'other@example.com', password: 'other-pass-1234' }) });
  const oc = o.headers.get('set-cookie').split(';')[0];
  ok((await web('/api/tg/chats/' + CHAT.id, { cookie: oc })).status === 404 && !(await web('/api/tg/chats', { cookie: oc })).chats.length, 'another recruiter does not see this driver\'s group');
  ok(aiCalls >= 3, 'AI was used for pictures and the summary');
  if (process.env.SHOTS) { // pictures of the pages, for a look
    const { chromium } = require('playwright'); const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE + '/#/login'); await p.fill('input[name=email]', 'admin@example.com'); await p.fill('input[name=password]', 'test-password-123'); await p.click('#lf button'); await p.waitForSelector('.rail');
    await p.goto(BASE + '/#/telegram'); await p.waitForSelector('table.tgt'); await p.screenshot({ path: '/tmp/e2e-web/tg-list.png' });
    await p.click('table.tgt tr[data-chat]'); await p.waitForSelector('.tgcols'); await p.screenshot({ path: '/tmp/e2e-web/tg-chat.png', fullPage: true });
    await p.goto(BASE + '/#/telegram'); await p.waitForSelector('[data-tab=settings]'); await p.click('[data-tab=settings]'); await p.waitForSelector('#tgForm'); await p.screenshot({ path: '/tmp/e2e-web/tg-settings.png' });
    await p.click('[data-tab=people]'); await p.waitForSelector('select[data-ch=tgRole]'); await p.screenshot({ path: '/tmp/e2e-web/tg-people.png' });
    await p.goto(BASE + '/#/driver/' + id); await p.waitForSelector('.tglead'); await p.locator('#onb').screenshot({ path: '/tmp/e2e-web/tg-lead.png' });
    await p.click('[data-act=tgLink][data-kind=accounting]'); await p.waitForSelector('#dlg .gcopy'); await p.screenshot({ path: '/tmp/e2e-web/tg-linkdlg.png' });
    ok(!errs.length, 'no page errors ' + errs.join(' | ')); await b.close();
  }
  await pg.end();
  execSync('pkill -f "node src/serve[r].js" || true');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
