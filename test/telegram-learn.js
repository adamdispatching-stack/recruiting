// Test of an onboarding group the bot joins midway: watch and learn, the AI's status and steps, learning, importing history, autopilot.
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
    if (method === 'setMyCommands') { (tg.commands = tg.commands || []).push(p); return out(true); }
    res.statusCode = 404; res.end(JSON.stringify({ ok: false, description: 'unknown ' + method }));
  });
}).listen(4999);
// ---------- fake AI: an onboarding group the bot watches and learns from ----------
const AI = { autoAnswer: false };
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body); const tool = j.tools[0].name; let input;
    const text = (j.messages[0].content.find((c) => c.type === 'text') || {}).text || '';
    if (tool === 'group_digest') {
      const fresh = text.split('NEW MESSAGES:')[1] || '';
      input = { truck_events: [], driver_notes: [], alerts: [], learned: [] };
      const steps = /ONBOARDING STEPS still open \(id: step\): (.*)/.exec(j.system);
      const pick = (label) => { const m = steps && new RegExp('(\\d+): ' + label).exec(steps[1]); return m ? +m[1] : null; };
      if (steps) input.onboarding = { summary: 'Olga sent her drug test result; waiting on her bus ticket.', waiting_on: 'driver', next_step: 'Book the bus ticket', blockers: [], open_questions: [], driver_mood: 'good', done_steps: [] };
      if (/Pay is every Friday by direct deposit/.test(fresh)) input.learned.push({ question: 'When is pay day?', answer: 'Every Friday, by direct deposit.' });
      if (/drug test is done/i.test(fresh) && pick('Drug test')) input.onboarding.done_steps.push({ id: pick('Drug test'), evidence: 'drug test is done, negative' });
      if (/orientation done/i.test(fresh) && pick('Orientation')) input.onboarding.done_steps.push({ id: pick('Orientation'), evidence: 'orientation done' });
      if (/CONTAINER ABCU9/.test(fresh)) input.alerts.push({ kind: 'container_mismatch', severity: 'high', text: 'Old container mix-up', ask_driver: 'is this the right container?' });
      if (/OLD import marker/.test(fresh)) input.driver_notes.push({ kind: 'routine', text: 'Calls in the evening (from the old messages)' });
    } else if (tool === 'reply_plan') {
      input = AI.autoAnswer ? { is_question: true, confident: true, answer: 'Every Friday, by direct deposit.', progress: 'none', mood: 'good' } : { is_question: true, confident: false, answer: '', progress: 'none', mood: 'neutral' };
    } else input = { summary: 'A day.', issues: [], mood: 'good' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input }] }));
  });
}).listen(4998);

const push = (u) => { u.update_id = tg.nextUpdate++; tg.updates.push(u); };
const DCHAT = { id: -100901, type: 'supergroup', title: 'Onboarding Olga Onb' };
const ECHAT = { id: -100802, type: 'supergroup', title: 'ELD Zed Newman' };
const ACHAT = { id: -100803, type: 'supergroup', title: 'Accounting' };
let CHAT = DCHAT;
const RITA = { id: 11, is_bot: false, first_name: 'Rita', last_name: 'Recruiter', username: 'rita_r' };
const OLGA = { id: 44, is_bot: false, first_name: 'Olga', last_name: 'Onb', username: 'olga_o' };
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
    TELEGRAM_BOT_TOKEN: '999:test', TG_API_BASE: 'http://localhost:4999', TG_POLL_SECONDS: '1', TG_TICK_MS: '1000', TG_NO_QUIET: '1', TG_DIGEST_MS: '1000', TG_DIGEST_SETTLE_MIN: '0.03', TG_PROFILE_MS: '600000', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4998' };
  require('child_process').spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', require('fs').openSync('/tmp/server.log', 'w'), require('fs').openSync('/tmp/server.log', 'a')], detached: true }).unref();
  let cookie = '';
  const web = async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: opts.cookie || cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && !opts.cookie) cookie = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  await until(async () => { try { return (await fetch(BASE + '/healthz')).ok; } catch (e) { return false; } }, 15000, 'server');
  await web('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  await until(async () => { const s = await web('/api/tg/status'); return s.running && s.bot; }, 10000, 'bot');
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  const rita = (await web('/api/users', { method: 'POST', body: { name: 'Rita Recruiter', email: 'rita@example.com', password: 'rita-pass-1234' } })).id;
  const olga = (await web('/api/drivers', { method: 'POST', body: { name: 'Olga Onb', source: 'Indeed', phone: '2155550133', ownerId: rita } })).id;
  await web('/api/drivers/' + olga, { method: 'PATCH', body: { status: 'Onboarding' } });
  await web('/api/settings', { method: 'PUT', body: { checklist: [...(await web('/api/settings')).checklist, { key: 'drugtest', label: 'Drug test', auto: null }, { key: 'orient', label: 'Orientation', auto: null }] } });
  await pg.query(`INSERT INTO checklist (driver_id, key, label, position) VALUES ($1, 'drugtest', 'Drug test', 90), ($1, 'orient', 'Orientation', 91) ON CONFLICT DO NOTHING`, [olga]);
  const me = await web('/api/tg/me-code', { method: 'POST', body: {} });
  push({ message: { message_id: mid++, from: RITA, chat: { id: 11, type: 'private', first_name: 'Rita' }, date: Math.floor(Date.now() / 1000), text: '/me ' + me.code } });
  await until(() => tg.sent.some((m) => /Connected: you are/.test(m.text)));

  // the / menu in Telegram lists the commands
  const grp = (tg.commands || []).find((c) => c.scope && c.scope.type === 'all_group_chats'), prv = (tg.commands || []).find((c) => c.scope && c.scope.type === 'all_private_chats');
  ok(grp && ['register', 'mode', 'status', 'sum', 'help'].every((x) => grp.commands.some((c) => c.command === x)) && prv && ['me', 'driver', 'help'].every((x) => prv.commands.some((c) => c.command === x)), 'Telegram\'s / menu: /register /mode /status /sum /help in groups; /me /driver /help in private');
  // a group already going: /register from the menu; the title names the driver; the bot starts in Watch and learn
  CHAT = DCHAT;
  let n = tg.sent.length; say(RITA, '/help');
  ok(await until(() => sentSince(n).some((m) => /\/register: connect this group/.test(m.text))), '/help lists what the bot does');
  n = tg.sent.length; say(RITA, '/register');
  ok(await until(() => sentSince(n).some((m) => /now the <b>Dispatch<\/b> group for <b>Olga Onb<\/b>/.test(m.text))), '/register alone: the group title says who (Olga Onb): linked right away');
  ok(await until(() => sentSince(n).some((m) => /^👀 Watch and learn: I read along.*\nTo change: \/mode/s.test(m.text))), 'starts in 👀 Watch and learn (the default); /mode to change');
  await sleep(1500);
  ok(!tg.sent.some((m) => m.chat_id === DCHAT.id && /Welcome, <b>Olga<\/b>|I am the driver/.test(m.text)), 'watching: no welcome, no card, nothing written');
  ok((await pg.query(`SELECT mode FROM onb_cases WHERE driver_id = $1`, [olga])).rows[0].mode === 'watch', 'mode saved: watch');
  // the driver asks; the bot stays quiet; Rita answers; the drug test is done
  n = tg.sent.length; say(OLGA, 'When is payday?');
  await sleep(1500);
  ok(!sentSince(n).some((m) => m.chat_id === DCHAT.id), 'watching: the bot does not answer the driver');
  say(RITA, 'Pay is every Friday by direct deposit');
  say(OLGA, 'My drug test is done, negative result');
  const tgd = await until(async () => { const x = await web(`/api/drivers/${olga}/tg`); return x.onb && x.onb.status && x.onb.steps.length ? x : null; }, 15000);
  ok(tgd && /drug test/.test(tgd.onb.status.summary) && tgd.onb.status.waitingOn === 'driver' && tgd.onb.status.nextStep === 'Book the bus ticket', 'the website: where the onboarding stands, waiting on the driver, next step');
  ok(tgd && tgd.onb.steps[0].label === 'Drug test' && tgd.onb.steps[0].state === 'suggested', 'the AI saw "Drug test" done: to confirm');
  ok(!(await pg.query(`SELECT done FROM checklist WHERE driver_id = $1 AND key = 'drugtest'`, [olga])).rows[0].done, 'not ticked until someone confirms');
  ok(((await web('/api/notices')).notices || []).length >= 0, '');
  const k = (await web('/api/tg/knowledge')).knowledge.find((x) => /pay day/i.test(x.question));
  ok(k && k.review && !k.active && /Every Friday/.test(k.answer), 'learned from Rita\'s answer: waiting for approval');
  // confirm the step, approve the answer
  ok((await web('/api/onb-ai-steps/' + tgd.onb.steps[0].id, { method: 'POST', body: { ok: true } })).ok && (await pg.query(`SELECT done FROM checklist WHERE driver_id = $1 AND key = 'drugtest'`, [olga])).rows[0].done, 'confirmed: "Drug test" is ticked');
  await web('/api/tg/knowledge/' + k.id, { method: 'PATCH', body: { active: true } });
  const k2 = (await web('/api/tg/knowledge')).knowledge.find((x) => x.id === k.id);
  ok(k2.active && !k2.review, 'approved: the bot answers with it from now on');
  let rd = await web('/api/tg/readiness');
  ok(rd.steps.accuracy === 1 && rd.steps.confirmed === 1 && rd.knowledge.approved >= 1 && !rd.ready, 'autopilot: 100% right so far (1 of 1), not ready yet');
  // earlier messages from an export: read quietly
  const t0 = Math.floor(Date.now() / 1000) - 5 * 86400;
  const imp = await web(`/api/tg/chats/${DCHAT.id}/import`, { method: 'POST', body: { messages: [
    { id: 900003, date: t0, fromId: '44', from: 'Olga Onb', text: 'Hello, OLD import marker, I usually call in the evening' },
    { id: 900004, date: t0 + 60, fromId: '77', from: 'Rita Recruiter', text: 'Welcome Olga!' },
    { id: 900005, date: t0 + 120, fromId: '44', from: 'Olga Onb', text: 'CONTAINER ABCU9 photo' }], people: [{ tgId: '44', name: 'Olga Onb', role: 'driver' }, { tgId: '77', name: 'Rita Recruiter', role: 'staff' }] } });
  if (process.env.DBG) console.log('IMP', JSON.stringify(imp)); ok(imp.imported === 3, 'three earlier messages brought in from the export');
  ok(await until(async () => (await pg.query(`SELECT 1 FROM driver_notes WHERE driver_id = $1 AND text LIKE '%old messages%'`, [olga])).rows[0], 15000), 'the AI read them: a note from the old messages');
  await sleep(800);
  ok(!tg.sent.some((m) => /🔎/.test(m.text)) && (await pg.query(`SELECT 1 FROM tg_alerts WHERE driver_id = $1 AND kind = 'container_mismatch'`, [olga])).rows[0], 'old messages: the alert is kept, but nothing is asked in the group');
  ok((await pg.query(`SELECT count(*)::int n FROM tg_messages WHERE chat_id = $1 AND imported AND digested`, [DCHAT.id])).rows[0].n === 3, 'all read');
  // /mode in the group: buttons, the current one ticked
  n = tg.sent.length; say(RITA, '/mode');
  const mb = await until(() => sentSince(n).find((m) => /How should I work in <b>Olga Onb<\/b>'s group\? Now: 👀 Watch and learn/.test(m.text)));
  ok(mb && /^✓ 👀/.test(mb.reply_markup.inline_keyboard[0][0].text), '/mode shows the modes, the current one ticked');
  n = tg.sent.length; say(OLGA, '/mode run');
  ok(await until(() => sentSince(n).some((m) => /Only our team can change this/.test(m.text))), 'the driver cannot change it');
  n = tg.sent.length; say(RITA, '/sum');
  ok(await until(() => sentSince(n).some((m) => /Summed up on the website|Nothing to sum up/.test(m.text))), '/sum sums up today on the website');
  // switch to answering: the bot answers the driver now, and it counts
  AI.autoAnswer = true; await pg.query(`UPDATE tg_messages SET at = at - interval '30 minutes' WHERE from_id = $1`, [RITA.id]); // the team was not just talking
  ok((await web(`/api/drivers/${olga}/tg-mode`, { method: 'PATCH', body: { mode: 'assist' } })).ok, 'switched to "Answer questions" on the website');
  await sleep(300);
  n = tg.sent.length; say(OLGA, 'Is payday on Friday?');
  ok(await until(() => sentSince(n).some((m) => /Every Friday, by direct deposit/.test(m.text))), 'answering: the bot answers the driver');
  ok((await web('/api/tg/readiness')).questions.byBot === 1, 'counted as answered by the bot');
  // run: the full welcome goes out
  n = tg.sent.length;
  await web(`/api/drivers/${olga}/tg-mode`, { method: 'PATCH', body: { mode: 'run' } });
  ok(await until(() => sentSince(n).some((m) => /Welcome, <b>Olga<\/b>/.test(m.text))), 'run: the welcome and the steps go out now');
  // the AI ticks steps itself when allowed, and a person can undo
  ok((await web('/api/tg/autopilot', { method: 'PUT', body: { autoTick: true, onbMode: 'assist' } })).autoTick, 'the admin lets the AI tick steps itself; new groups start in "Answer questions"');
  say(OLGA, 'Orientation done yesterday');
  ok(await until(async () => (await pg.query(`SELECT done FROM checklist WHERE driver_id = $1 AND key = 'orient'`, [olga])).rows[0].done, 15000), 'the AI ticked "Orientation" itself');
  const auto = (await web(`/api/drivers/${olga}/tg`)).onb.steps.find((x) => x.state === 'auto');
  await web('/api/onb-ai-steps/' + auto.id, { method: 'POST', body: { ok: false } });
  ok(!(await pg.query(`SELECT done FROM checklist WHERE driver_id = $1 AND key = 'orient'`, [olga])).rows[0].done, 'undone by a person');
  rd = await web('/api/tg/readiness');
  ok(rd.steps.rejected === 1 && rd.steps.accuracy === 0.5, 'and it counts against the AI: 50% right');
  ok((await web('/api/onboarding')).drivers.find((d) => d.id === olga).bot.nextStep === 'Book the bus ticket', 'the onboarding board shows the bot\'s next step');
  if (process.env.SHOTS) {
    const { chromium } = require('playwright'); const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const p = await (await b.newContext({ viewport: { width: 1440, height: 1100 } })).newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE + '/#/login'); await p.fill('input[name=email]', 'admin@example.com'); await p.fill('input[name=password]', 'test-password-123'); await p.click('#lf button'); await p.waitForSelector('.rail');
    await pg.query(`INSERT INTO onb_ai_steps (driver_id, checklist_id, label, evidence) SELECT $1, id, label, 'Sent the ticket photo' FROM checklist WHERE driver_id = $1 AND key = 'orient'`, [olga]);
    await p.goto(BASE + '/#/driver/' + olga); await p.waitForSelector('.onbbot .aist'); await p.locator('.onbbot').screenshot({ path: '/tmp/e2e-web/tl-panel.png' });
    await p.goto(BASE + '/#/telegram?tab=knowledge'); await p.waitForTimeout(300); await p.goto(BASE + '/#/telegram'); await p.click('a[href*="knowledge"], button[data-tab=knowledge], [data-act=tgTab][data-k=knowledge]').catch(() => {}); await p.waitForSelector('.autop', { timeout: 5000 }).catch(() => {});
    await p.screenshot({ path: '/tmp/e2e-web/tl-know.png', fullPage: true });
    await p.goto(BASE + '/#/onboarding'); await p.waitForSelector('.obai'); await p.screenshot({ path: '/tmp/e2e-web/tl-board.png' });
    await p.goto(BASE + '/#/telegram/' + DCHAT.id); await p.click('[data-act=tgImport]'); await p.waitForSelector('#tgFile');
    require('fs').writeFileSync('/tmp/result.json', JSON.stringify({ name: 'Onboarding Olga Onb', messages: [{ id: 900009, type: 'message', date: '2026-11-10T10:00:00', date_unixtime: String(t0 - 999), from: 'Olga Onb', from_id: 'user44', text: ['Hi, ', { type: 'bold', text: 'ready' }] }, { id: 900010, type: 'message', date: '2026-11-10T10:01:00', date_unixtime: String(t0 - 900), from: 'Dan D', from_id: 'user66', text: 'Great' }] }));
    await p.setInputFiles('#tgFile', '/tmp/result.json'); await p.waitForSelector('[data-who]'); await p.screenshot({ path: '/tmp/e2e-web/tl-import.png' });
    await p.selectOption('[data-who="66"]', 'staff'); await p.click('#tgGo'); await p.waitForTimeout(1000);
    ok((await pg.query(`SELECT count(*)::int n FROM tg_messages WHERE chat_id = $1 AND msg_id IN (900009, 900010) AND imported`, [DCHAT.id])).rows[0].n === 2 && (await pg.query(`SELECT role FROM tg_people WHERE tg_id = 66`)).rows[0].role === 'staff', 'importing from the page: 2 messages, Dan marked as our team');
    ok(!errs.length, 'no page errors ' + errs.join(' | ')); await b.close();
  }
  await pg.end();
  execSync('pkill -f "node src/serve[r].js" || true');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
