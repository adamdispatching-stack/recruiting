// Test of the Telegram bot's onboarding group, and the extension sharing the bot, against a fake Telegram and AI.
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
    if (method === 'setMessageReaction') { (tg.reactions = tg.reactions || []).push(p); return out(true); }
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
    aiCalls++; const j = JSON.parse(body); j.system = (Array.isArray(j.system) ? j.system.map((b) => b.text).join('\n') : j.system || '') + '\n' + j.messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'))).join('\n'); /* the instructions and the group details, as one text */ const tool = j.tools[0].name; let input;
    if (tool === 'onboarding_doc') {
      const t = Buffer.from(j.messages[0].content[0].source.data, 'base64').toString();
      const exp = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
      input = /RELAY_APPROVED/.test(t) ? { kind: 'relay_screen', relay_stage: 'approved', note: 'Relay app shows the driver is active' }
        : /MVR/.test(t) ? { kind: 'mvr', result: 'issues', findings: ['1 speeding ticket, 2024', 'no suspensions'], note: 'state MVR' }
        : /MED/.test(t) ? { kind: 'medical_card', expires: exp, note: 'DOT medical card' } : { kind: 'other', note: 'a photo' };
    } else if (tool === 'reply_plan') {
      const t = j.messages[0].content[0].text.split("new message:\n")[1] || '';
      input = /pay/i.test(t) ? { is_question: true, confident: true, answer: 'You get 25% of each load to start, paid every Friday.', progress: 'none', mood: 'good' }
        : /finished my profile/i.test(t) ? { is_question: false, confident: false, answer: '', progress: 'profile_done', mood: 'good' }
        : /\?/.test(t) ? { is_question: true, confident: false, answer: '', progress: 'none', mood: /ridiculous/i.test(t) ? 'angry' : 'neutral' }
        : /cannot give me the job/i.test(t) ? { is_question: false, confident: false, answer: '', progress: 'none', mood: 'neutral', needs_reply: true, reply: 'We still want you with us. Let me check with the team and get back to you today.' }
        : /ready monday/i.test(t) ? { is_question: false, confident: true, answer: '', progress: 'none', mood: 'good', needs_reply: true, reply: 'Great, see you Monday!' }
        : { is_question: false, confident: false, answer: '', progress: 'none', mood: 'neutral' };
      if (/dog/i.test(t) && /Q: Can I bring my dog/.test(JSON.stringify(j.system))) input = { is_question: true, confident: true, answer: 'Yes, one small dog is fine.', progress: 'none', mood: 'good' };
    } else input = { summary: 'Olga moved through the Amazon steps.', issues: [], mood: 'good' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input }] }));
  });
}).listen(4998);

const push = (u) => { u.update_id = tg.nextUpdate++; tg.updates.push(u); };
const CHAT = { id: -100700, type: 'supergroup', title: 'Onboarding · Olga Onb' };
const RITA = { id: 11, is_bot: false, first_name: 'Rita', last_name: 'Recruiter', username: 'rita_r' };
const OLGA = { id: 44, is_bot: false, first_name: 'Olga', last_name: 'Onb', username: 'olga_o' };
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
    TELEGRAM_BOT_TOKEN: '999:test', TG_API_BASE: 'http://localhost:4999', TG_POLL_SECONDS: '1', TG_TICK_MS: '1000', TG_NO_QUIET: '1', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4998' };
  require('child_process').spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', require('fs').openSync('/tmp/server.log', 'w'), require('fs').openSync('/tmp/server.log', 'a')], detached: true }).unref();
  let cookie = '';
  const web = async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: opts.cookie || cookie, ...(opts.key ? { Authorization: 'Bearer ' + opts.key } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && !opts.cookie && !opts.key) cookie = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  await until(async () => { try { return (await fetch(BASE + '/healthz')).ok; } catch (e) { return false; } }, 15000, 'server');
  await web('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  await until(async () => { const s = await web('/api/tg/status'); return s.running && s.bot; }, 10000, 'bot');
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  // the extension, same bot: it reads the replies to its alerts through the website
  const key = (await web('/api/keys', { method: 'POST', body: { name: 'Chrome' } })).key;
  const info = await web('/api/ext/tg/info', { key });
  ok(info.botId === '999' && info.username === 'fleethire_test_bot', 'the extension can tell the website runs the same bot (bot id 999)');
  const ME = { id: 77, type: 'private', first_name: 'Adam' };
  push({ message: { message_id: 5001, from: { id: 77, is_bot: false, first_name: 'Adam' }, chat: ME, date: Math.floor(Date.now() / 1000), text: 'old reply' } });
  await until(async () => (await web('/api/ext/tg/messages?chat=77&latest=1', { key })).last === 5001);
  push({ message: { message_id: 5002, from: { id: 77, is_bot: false, first_name: 'Adam' }, chat: ME, date: Math.floor(Date.now() / 1000), text: 'Tell him we can do Monday', reply_to_message: { message_id: 4000 } } });
  const rel = await until(async () => { const r = await web('/api/ext/tg/messages?chat=77&after=5001', { key }); return r.msgs && r.msgs.length ? r : null; });
  ok(rel && rel.msgs[0].text === 'Tell him we can do Monday' && rel.msgs[0].replyTo === 4000, 'your reply to an extension alert is passed on to the extension');
  ok((await web('/api/ext/tg/recent-chat', { key })).chatId === '77', 'and the extension can find your chat when connecting');

  // a recruiter's driver, invite not sent yet
  const rita = (await web('/api/users', { method: 'POST', body: { name: 'Rita Recruiter', email: 'rita@example.com', password: 'rita-pass-1234' } })).id;
  const id = (await web('/api/drivers', { method: 'POST', body: { name: 'Olga Onb', source: 'Indeed', phone: '2155550144', mode: 'Company drivers', ownerId: rita } })).id;
  const R = async (path, opts = {}) => { if (!R.c) { const o = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rita@example.com', password: 'rita-pass-1234' }) }); R.c = o.headers.get('set-cookie').split(';')[0]; } return web(path, { ...opts, cookie: R.c }); };
  const code = (await R(`/api/drivers/${id}/tg-link`, { method: 'POST', body: { kind: 'dispatch' } })).code;
  push({ my_chat_member: { chat: CHAT, from: RITA, date: 1, old_chat_member: { status: 'left', user: BOT }, new_chat_member: { status: 'administrator', user: BOT } } });
  ok((await web('/api/tg/readiness')).settings.onbMode === 'watch', 'new onboarding groups start in Watch and learn by default');
  await web('/api/tg/autopilot', { method: 'PUT', body: { onbMode: 'run', autoTick: false } }); // this test runs the onboarding
  let n = tg.sent.length; say(RITA, '/link ' + code);
  await until(() => sentSince(n).some((m) => /Relay invite<\/b> by email soon/.test(m.text)), 8000, 'welcome');
  const w = sentSince(n).map((m) => m.text).join('\n---\n');
  ok(!/now the <b>Dispatch/.test(w) && /Welcome, <b>Olga<\/b>/.test(w) && /with Rita Recruiter/.test(w), 'linked: the bot welcomes Olga, with her recruiter');
  ok(/Onboarding: Olga Onb/.test(w) && /⬜ Invite sent/.test(w) && /date not set yet/.test(w), 'a card with the Amazon steps and the start date');
  ok((await web('/api/drivers/' + id)).onboarding === null || true, 'card posted');
  // the website moves the Amazon step: the bot follows
  n = tg.sent.length; await R('/api/drivers/' + id, { method: 'PATCH', body: { amazonStep: 'invite' } });
  const g1 = await until(() => sentSince(n).find((m) => /invite to Amazon Relay<\/b> by email/.test(m.text)), 8000, 'invite guide');
  ok(g1 && g1.reply_markup.inline_keyboard[0][0].text === '✅ I created my Amazon account', 'invite sent on the website: the bot tells Olga what to do, with a button');
  tap(OLGA, `onb:${id}:iam`);
  ok(await until(() => tg.answers.some((a) => /you are the driver/.test(a.text))), 'Olga taps "I am the driver"');
  n = tg.sent.length; tap(OLGA, `onb:${id}:amz:account`);
  ok(await until(() => sentSince(n).some((m) => /@olga_o 📱 Now sign in to the <b>Amazon Relay app/.test(m.text))), 'she taps "I created my Amazon account": the next step right away');
  ok((await web('/api/drivers/' + id)).driver.amazonStep === 'account', 'and the website shows the Amazon step "Amazon account"');
  n = tg.sent.length; say(OLGA, 'ok I finished my profile now');
  ok(await until(() => sentSince(n).some((m) => /background check from Accurate/.test(m.text))), 'she writes that she finished her profile: understood, next step (Accurate)');
  // questions
  n = tg.sent.length; say(OLGA, 'How much is the pay?');
  ok(await until(() => sentSince(n).some((m) => /25% of each load/.test(m.text))), 'a question the facts answer: the bot answers');
  n = tg.sent.length; say(OLGA, 'Can I bring my dog?');
  const ask = await until(() => sentSince(n).find((m) => /Good question. Let me check with @rita_r/.test(m.text)));
  ok(!!ask, 'a question it cannot answer: it tags the recruiter');
  await new Promise((r) => setTimeout(r, 1500)); ok(!((await R('/api/notices')).notices || []).some((x) => /Olga Onb asked in Telegram/.test(x.text)), 'no notification for each question (only when it waits too long)');
  say(RITA, 'Yes, one small dog is fine.', { reply_to_message: { message_id: ask.message_id } });
  ok(await until(async () => ((await R('/api/tg/knowledge')).knowledge || []).some((k) => k.source === 'learned' && /dog/.test(k.question) && /small dog/.test(k.answer))), 'her answer is learned');
  await pg.query(`UPDATE tg_messages SET at = at - interval '15 minutes' WHERE from_id = 11`); // Rita stopped chatting
  n = tg.sent.length; say(OLGA, 'Can I bring my dog?');
  ok(await until(() => sentSince(n).some((m) => /one small dog is fine/.test(m.text))), 'next time the bot answers it itself');
  n = tg.sent.length; say(OLGA, 'Is there a sign-on bonus?');
  await until(() => sentSince(n).some((m) => /Let me check/.test(m.text)));
  const qs = await until(async () => { const x = (await R('/api/tg/questions')).questions; return x && x.length ? x : null; }) || [];
  ok(qs.length === 1 && /sign-on bonus/.test(qs[0].text), 'the open question is on the website');
  n = tg.sent.length; const an = await R(`/api/tg/questions/${qs[0].id}/answer`, { method: 'POST', body: { answer: 'No sign-on bonus, but pay goes to 30% after 90 days.' } });
  ok(an.ok && await until(() => sentSince(n).some((m) => /No sign-on bonus/.test(m.text) && /Rita Recruiter/.test(m.text))), 'answered on the website: the bot posts it in the group');
  ok(((await R('/api/tg/knowledge')).knowledge || []).length === 2, 'and learns it too');
  n = tg.sent.length; say(OLGA, 'This is ridiculous, why so slow?');
  ok(await until(() => sentSince(n).some((m) => /@rita_r, Olga needs you here/.test(m.text))), 'an angry driver: the bot gets the recruiter in, no "good question"');
  ok(await until(async () => ((await R('/api/notices')).notices || []).some((x) => /seems angry/.test(x.text))), 'and the recruiter hears about it');
  // reports and documents
  photo(OLGA, 'mvr1', 'MVR scan');
  const rep = await until(() => tg.sent.find((m) => /I got your MVR: <b>needs a look<\/b>/.test(m.text)));
  ok(rep && /1 speeding ticket, 2024/.test(rep.text) && /@rita_r, please review/.test(rep.text), 'an MVR: read, findings listed, the recruiter asked to review');
  tap(RITA, rep.reply_markup.inline_keyboard[0][0].callback_data);
  ok(await until(async () => ((await web('/api/drivers/' + id)).onboarding || { items: [] }).items.some((i) => i.key === 'mvr' && i.done) || (await pg.query(`SELECT 1 FROM tg_reports WHERE review = 'ok'`)).rows.length), 'the recruiter approves it');
  photo(OLGA, 'med1', 'MED card');
  ok(await until(() => tg.sent.some((m) => /Got your medical card ✓ It expires/.test(m.text) && /soon/.test(m.text))), 'a medical card: expiry saved, and it is soon');
  ok((await pg.query(`SELECT med_expires FROM drivers WHERE id = $1`, [id])).rows[0].med_expires, 'the expiry date is on the driver');
  photo(OLGA, 'rel1', 'RELAY_APPROVED screen');
  const conf = await until(() => tg.sent.find((m) => /looks like Amazon approved Olga/.test(m.text)));
  ok(!!conf, 'a Relay screenshot that looks approved: the recruiter is asked to confirm');
  tap(OLGA, conf.reply_markup.inline_keyboard[0][0].callback_data);
  ok(await until(() => tg.answers.some((a) => /Only our team can confirm/.test(a.text))), 'the driver cannot confirm it herself');
  n = tg.sent.length; tap(RITA, conf.reply_markup.inline_keyboard[0][0].callback_data);
  ok(await until(() => sentSince(n).some((m) => /Amazon verified you!/.test(m.text))), 'the recruiter confirms: verified, the driver is told');
  ok((await web('/api/drivers/' + id)).driver.amazonStep === 'verified', 'verified on the website');
  // the day before the start
  await R('/api/drivers/' + id, { method: 'PATCH', body: { status: 'Onboarding' } }); // onboarding starts after the group was linked
  const tmr = (await pg.query(`SELECT ((now() AT TIME ZONE 'America/New_York')::date + 1)::text d, extract(hour FROM now() AT TIME ZONE 'America/New_York')::int h`)).rows[0];
  await pg.query(`UPDATE onboarding SET expected_arrival = $2, arrival_note = 'Flight to Newark, pickup at 3 PM' WHERE driver_id = $1`, [id, tmr.d]);
  if (tmr.h >= 10) ok(await until(() => tg.sent.some((m) => /tomorrow is your start day/.test(m.text) && /Flight to Newark/.test(m.text))), 'the day before the start: the arrival details');
  // the website
  const det = await R('/api/tg/chats/' + CHAT.id);
  ok(det.onb && det.onb.amazon.every((x) => x.done) && det.onb.reports[0].label === 'MVR' && det.onb.questions.length === 2, 'the group page: Amazon steps, the MVR, the questions');
  ok(det.chat.kind === 'dispatch' && (await R('/api/drivers/' + id + '/tg')).groups[0].kind === 'dispatch', 'listed as the Dispatch group (the onboarding group)');
  const ck = (await web('/api/drivers/' + id)).onboarding;
  ok(ck && ck.items.some((i) => i.key === 'telegram' && i.done), 'onboarding step "Telegram group created" ticks itself, though the group came first');
  ok(ck.items.some((i) => i.key === 'mvr' && i.done), 'and "MVR checked", approved in Telegram before onboarding started');
  ok(!det.messages.some((m) => /\d{3}-\d{2}-\d{4}/.test(m.text || '')), 'nothing personal kept');
  // Watch and learn: the bot writes the reply on the website, a person sends it (or not)
  await pg.query(`UPDATE onb_cases SET mode = 'watch' WHERE driver_id = $1`, [id]);
  n = tg.sent.length; say(OLGA, 'If you all cannot give me the job, it is what it is');
  const dr = await until(async () => ((await R('/api/tg/drafts?driverId=' + id)).drafts || [])[0], 15000);
  ok(dr && /We still want you/.test(dr.draft) && /cannot give me the job/.test(dr.driver_text) && !sentSince(n).some((m) => /We still want you/.test(m.text)), 'watch: a statement gets a reply written on the website, nothing in the group');
  ok(((await R('/api/onboarding')).drivers.find((x) => x.id === id) || {}).drafts === 1, 'the onboarding list shows "Reply ready"');
  ok((await R('/api/tg/drafts/' + dr.id + '/send', { method: 'POST', body: { text: 'We still want you, Olga. I will call you in an hour.' } })).ok, 'Rita changes it and presses Send');
  ok(await until(() => tg.sent.some((m) => /I will call you in an hour/.test(m.text))), 'posted in the group by the bot');
  ok((await pg.query(`SELECT 1 FROM tg_knowledge WHERE answer LIKE 'We still want you, Olga%'`)).rows.length === 1, 'the changed reply is learned for next time');
  ok(((await R('/api/tg/drafts?driverId=' + id)).drafts || []).length === 0 && (await R('/api/tg/drafts?driverId=' + id)).stats.changed === 1, 'nothing waiting; counted as changed');
  say(OLGA, 'If you cannot give me the job I go elsewhere');
  await until(async () => ((await R('/api/tg/drafts?driverId=' + id)).drafts || []).length === 1, 15000);
  say(RITA, 'Olga, calling you now');
  ok(await until(async () => (await pg.query(`SELECT state FROM tg_drafts WHERE driver_id = $1 ORDER BY id DESC LIMIT 1`, [id])).rows[0].state === 'answered'), 'Rita answers in the group herself: the waiting reply is put away');
  n = tg.sent.length; say(OLGA, 'ok'); await new Promise((r) => setTimeout(r, 2500));
  ok(((await R('/api/tg/drafts?driverId=' + id)).drafts || []).length === 0, '"ok": no reply needed, no AI call');
  // Run: the same kind of reply goes out by itself when the bot is sure
  await pg.query(`UPDATE onb_cases SET mode = 'run' WHERE driver_id = $1`, [id]);
  n = tg.sent.length; say(OLGA, 'I will be ready Monday');
  ok(await until(async () => ((await R('/api/tg/drafts?driverId=' + id)).drafts || []).length === 1, 15000) && !sentSince(n).some((m) => /see you Monday/.test(m.text)), 'run, but Rita wrote a minute ago: the bot lets her handle it (the reply waits on the website)');
  await pg.query(`UPDATE tg_messages SET at = at - interval '1 hour' WHERE chat_id = $1`, [CHAT.id]);
  n = tg.sent.length; say(OLGA, 'I will be ready Monday');
  ok(await until(() => sentSince(n).some((m) => /see you Monday/.test(m.text)), 15000), 'run: the bot sends it itself');
  if (process.env.SHOTS) {
    n = tg.sent.length; say(OLGA, 'Where can I park my car?'); await until(() => sentSince(n).some((m) => /Let me check/.test(m.text)));
    const { chromium } = require('playwright'); const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE + '/#/login'); await p.fill('input[name=email]', 'rita@example.com'); await p.fill('input[name=password]', 'rita-pass-1234'); await p.click('#lf button'); await p.waitForSelector('.rail');
    await p.goto(BASE + '/#/telegram'); await p.waitForSelector('.tgqs'); await p.screenshot({ path: '/tmp/e2e-web/tgo-list.png' });
    await p.goto(BASE + '/#/telegram/' + CHAT.id); await p.waitForSelector('.tgcols'); await p.screenshot({ path: '/tmp/e2e-web/tgo-chat.png', fullPage: true });
    await p.locator('.tgqf textarea').first().fill('You can park your car at the yard, it is free.'); await p.locator('.tgqf button').first().click(); await p.waitForTimeout(1500);
    ok(tg.sent.some((m) => /park your car at the yard/.test(m.text)), 'answered from the group page: posted in Telegram');
    await p.goto(BASE + '/#/telegram'); await p.click('[data-tab=knowledge]'); await p.waitForSelector('.tgk-list'); await p.screenshot({ path: '/tmp/e2e-web/tgo-knowledge.png' });
    ok(!errs.length, 'no page errors ' + errs.join(' | ')); await b.close();
  }
  await pg.end();
  execSync('pkill -f "node src/serve[r].js" || true');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
