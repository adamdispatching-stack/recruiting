// Test: the bot connects a group from its title (name, phone, ELD/Accounting), and collects what the MVR and the drug test need.
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
    if (method === 'deleteMessage') { (tg.deleted = tg.deleted || []).push(p); return out(true); }
    if (method === 'setMyCommands') { (tg.commands = tg.commands || []).push(p); return out(true); }
    res.statusCode = 404; res.end(JSON.stringify({ ok: false, description: 'unknown ' + method }));
  });
}).listen(4999);
// ---------- fake AI: nothing special ----------
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body); const tool = j.tools[0].name;
    const input = tool === 'group_digest' ? { truck_events: [], driver_notes: [], alerts: [], learned: [] } : tool === 'reply_plan' ? { is_question: false, confident: false, answer: '', progress: 'none', mood: 'neutral' } : { summary: 'A day.', issues: [], mood: 'good' };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input }] }));
  });
}).listen(4998);

const push = (u) => { u.update_id = tg.nextUpdate++; tg.updates.push(u); };
const RITA = { id: 11, is_bot: false, first_name: 'Rita', last_name: 'Recruiter', username: 'rita_r' };
const PAUL = { id: 45, is_bot: false, first_name: 'Paul', last_name: 'Penn' };
const STRANGER = { id: 99, is_bot: false, first_name: 'Some', last_name: 'One' };
const PCHAT = { id: -100701, type: 'supergroup', title: 'Paul Penn +1 (267) 555-0177' };
const ECHAT = { id: -100702, type: 'supergroup', title: 'ELD - Paul Penn' };
const NCHAT = { id: -100703, type: 'supergroup', title: 'Nina Newbie 610.555.0199' };
const SCHAT = { id: -100704, type: 'supergroup', title: 'Mark Marshall 4845550111' };
let mid = 1;
const say = (from, text, chat) => push({ message: { message_id: mid++, from, chat, date: Math.floor(Date.now() / 1000), text } });
const priv = (from, text) => push({ message: { message_id: mid++, from, chat: { id: from.id, type: 'private', first_name: from.first_name }, date: Math.floor(Date.now() / 1000), text } });
const added = (chat, by) => push({ my_chat_member: { chat, from: by, date: Math.floor(Date.now() / 1000), old_chat_member: { status: 'left', user: BOT }, new_chat_member: { status: 'administrator', user: BOT } } });
const tap = (from, data, chat, msgId = 1) => push({ callback_query: { id: 'cq' + mid++, from, data, message: { message_id: msgId, chat, reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: data }]] } } } });
const sentSince = (n) => tg.sent.slice(n);
const inChat = (n, chat) => sentSince(n).filter((m) => String(m.chat_id) === String(chat.id));
async function until(f, ms = 8000, what = '') { for (let i = 0; i < ms / 100; i++) { const v = await f(); if (v) return v; await sleep(100); } console.log('   (timed out waiting for ' + what + ')'); return null; }

(async () => {
  execSync(`pkill -f "node src/serve[r].js" || true; sleep 0.4; su postgres -c "psql -q -h /tmp -p 5433 -c 'DROP DATABASE IF EXISTS recruiting_test' -c 'CREATE DATABASE recruiting_test'"`, { stdio: 'ignore' });
  const env = { ...process.env, DATABASE_URL: DB, PGSSL: 'off', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-password-123', PORT: '3999',
    TELEGRAM_BOT_TOKEN: '999:test', TG_API_BASE: 'http://localhost:4999', TG_POLL_SECONDS: '1', TG_TICK_MS: '1000', TG_NO_QUIET: '1', TG_DIGEST_MS: '600000', TG_PROFILE_MS: '600000', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4998' };
  require('child_process').spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', require('fs').openSync('/tmp/server.log', 'w'), require('fs').openSync('/tmp/server.log', 'a')], detached: true }).unref();
  let cookie = '';
  const web = async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: opts.cookie || cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && !opts.cookie) cookie = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  await until(async () => { try { return (await fetch(BASE + '/healthz')).ok; } catch (e) { return false; } }, 15000, 'server');
  await web('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  await until(async () => { const s = await web('/api/tg/status'); return s.running && s.bot; }, 10000, 'bot');
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  const rita = (await web('/api/users', { method: 'POST', body: { name: 'Rita Recruiter', email: 'rita@example.com', password: 'rita-pass-1234' } })).id;
  const paul = (await web('/api/drivers', { method: 'POST', body: { name: 'Paul Penn', source: 'Indeed', phone: '267-555-0177', ownerId: rita } })).id;
  await web('/api/drivers/' + paul, { method: 'PATCH', body: { status: 'Onboarding' } });
  const mark = (await web('/api/drivers', { method: 'POST', body: { name: 'Mark Marshall', source: 'Indeed', phone: '4845550111', ownerId: rita } })).id;
  const me = await web('/api/tg/me-code', { method: 'POST', body: {} });
  priv(RITA, '/me ' + me.code);
  await until(() => tg.sent.some((m) => /Connected: you are/.test(m.text)));

  // Rita adds the bot to "Paul Penn +1 (267) 555-0177": matched by the phone, connected, watch and learn
  let n = tg.sent.length; added(PCHAT, RITA);
  ok(await until(() => inChat(n, PCHAT).some((m) => /now the <b>Dispatch<\/b> group for <b>Paul Penn<\/b>/.test(m.text))), 'bot added by the team: the title\'s phone finds Paul, the group is connected, no command');
  ok(await until(() => inChat(n, PCHAT).some((m) => /^👀 Watch and learn/.test(m.text))), 'it starts in Watch and learn');
  ok((await pg.query(`SELECT kind, driver_id FROM tg_chats WHERE chat_id = $1`, [PCHAT.id])).rows[0].driver_id === paul, 'linked to Paul on the website');
  // an ELD group: the title says ELD
  n = tg.sent.length; added(ECHAT, RITA);
  ok(await until(() => inChat(n, ECHAT).some((m) => /now the <b>ELD<\/b> group for <b>Paul Penn<\/b>/.test(m.text))), '"ELD - Paul Penn": connected as Paul\'s ELD group');
  // someone outside the team adds the bot: it asks the team to confirm
  n = tg.sent.length; added(SCHAT, STRANGER);
  const conf = await until(() => inChat(n, SCHAT).find((m) => /looks like the <b>Dispatch<\/b> group for <b>Mark Marshall<\/b>/.test(m.text)));
  ok(!!conf && !(await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [SCHAT.id])).rows[0].driver_id, 'added by someone unknown: the bot asks, nothing connected yet');
  n = tg.sent.length; tap(STRANGER, conf.reply_markup.inline_keyboard[0][0].callback_data, SCHAT);
  await sleep(800); ok(!(await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [SCHAT.id])).rows[0].driver_id, 'a stranger cannot connect it');
  tap(RITA, conf.reply_markup.inline_keyboard[0][0].callback_data, SCHAT);
  ok(await until(async () => (await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [SCHAT.id])).rows[0].driver_id === mark), 'Rita taps Connect: Mark\'s group');
  // nobody on the website: a new driver in onboarding, with the phone from the title
  n = tg.sent.length; added(NCHAT, RITA);
  const pick = await until(() => inChat(n, NCHAT).find((m) => /Which driver is this <b>Dispatch<\/b> group for\?/.test(m.text) && /found nobody/.test(m.text)));
  const nb = pick && pick.reply_markup.inline_keyboard.flat().find((b) => /New driver in onboarding: Nina Newbie/.test(b.text));
  ok(!!nb, 'unknown name and phone: buttons to add Nina');
  tap(RITA, nb.callback_data, NCHAT);
  const nina = await until(async () => (await pg.query(`SELECT d.id, d.status, d.phones FROM drivers d JOIN tg_chats c ON c.driver_id = d.id WHERE c.chat_id = $1`, [NCHAT.id])).rows[0]);
  ok(nina && nina.status === 'Onboarding' && nina.phones.includes('6105550199') && (await pg.query(`SELECT 1 FROM onboarding WHERE driver_id = $1`, [nina.id])).rows.length === 1, 'Nina added in onboarding, with the phone, and her group connected');

  // the MVR and the drug test, in Paul's group, the bot watching
  n = tg.sent.length;
  say(RITA, 'Paul, which state is your CDL from?', PCHAT); await sleep(200);
  say(PAUL, 'Pennsylvania', PCHAT);
  ok(await until(async () => (await pg.query(`SELECT license_state FROM drivers WHERE id = $1`, [paul])).rows[0].license_state === 'PA'), 'the driver answers "Pennsylvania": CDL state PA');
  ok(await until(async () => (await pg.query(`SELECT text FROM notices WHERE user_id = $1`, [rita])).rows.some((r) => /CDL is from Pennsylvania: the MVR needs the last 4 of the SSN/.test(r.text))), 'Rita is told: a PA MVR needs the last 4 of the SSN');
  let dv = await web('/api/drivers/' + paul);
  ok(dv.mvrNeeds.map((x) => x.key).join() === 'ssn4,zip', 'the driver page: still needed: last 4 of SSN, ZIP');
  say(RITA, 'Please send the last 4 of your SSN for the MVR', PCHAT); await sleep(200);
  const m4 = mid; say(PAUL, '4321', PCHAT);
  ok(await until(async () => (await pg.query(`SELECT ssn4 FROM drivers WHERE id = $1`, [paul])).rows[0].ssn4 === '4321'), 'the 4 digits are saved');
  ok((await pg.query(`SELECT text FROM tg_messages WHERE chat_id = $1 AND msg_id = $2`, [PCHAT.id, m4])).rows[0].text === '[last 4 of SSN, hidden]', 'the saved message hides them');
  say(RITA, 'And your ZIP code for the drug test?', PCHAT); await sleep(200);
  say(PAUL, '19103', PCHAT);
  ok(await until(async () => (await pg.query(`SELECT zip FROM drivers WHERE id = $1`, [paul])).rows[0].zip === '19103'), 'the ZIP for the drug test is saved');
  const m9 = mid; say(PAUL, 'my social is 123456789', PCHAT); await sleep(800);
  ok((await pg.query(`SELECT text FROM tg_messages WHERE chat_id = $1 AND msg_id = $2`, [PCHAT.id, m9])).rows[0].text !== 'my social is 123456789', 'a full SSN is never saved');
  ok((tg.deleted || []).some((d) => d.chat_id === PCHAT.id && d.message_id === m9) && (await pg.query(`SELECT ssn4 FROM drivers WHERE id = $1`, [paul])).rows[0].ssn4 === '6789', 'a full SSN in the group: deleted, only the last 4 kept');
  ok(!inChat(n, PCHAT).length, 'watch and learn: the bot wrote nothing in the group');
  dv = await web('/api/drivers/' + paul);
  ok(dv.driver.licenseState === 'PA' && dv.driver.hasSsn4 && !('ssn4' in dv.driver) && !dv.mvrNeeds.length, 'the driver page: PA, last 4 given (not sent with the page), nothing missing');
  ok((await web(`/api/drivers/${paul}/ssn4`)).ssn4 === '6789', 'Show: the admin sees the 4 digits');
  ok((await pg.query(`SELECT 1 FROM driver_events WHERE driver_id = $1 AND text LIKE '%looked at the last 4 of SSN%'`, [paul])).rows.length === 1, 'and the look is in the history');
  const disp = (await web('/api/users', { method: 'POST', body: { name: 'Dee Dispatch', email: 'dee@example.com', password: 'dee-pass-12345', role: 'dispatcher' } }));
  const dl = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dee@example.com', password: 'dee-pass-12345' }) });
  if (disp.id) ok((await web(`/api/drivers/${paul}/ssn4`, { cookie: dl.headers.get('set-cookie').split(';')[0] })).status === 403, 'a dispatcher cannot see it');

  // the private link: the driver sends the 4 digits to the bot, not in the group
  await web(`/api/drivers/${paul}/mvr`, { method: 'PATCH', body: { ssn4: '' } });
  ok(!(await pg.query(`SELECT ssn4 FROM drivers WHERE id = $1`, [paul])).rows[0].ssn4, 'Delete on the website');
  const ln = await web(`/api/drivers/${paul}/ssn4-link`, { method: 'POST' });
  const code = (/start=(s4_\S+)/.exec(ln.url || '') || [])[1];
  ok(!!code && /fleethire_test_bot/.test(ln.url) && /last 4 digits/.test(ln.text), 'a private link to copy for the driver');
  n = tg.sent.length; priv(PAUL, '/start ' + code);
  ok(await until(() => sentSince(n).some((m) => m.chat_id === PAUL.id && /last 4 digits/.test(m.text))), 'the driver opens it: the bot asks privately');
  priv(PAUL, 'abc'); ok(await until(() => sentSince(n).some((m) => m.chat_id === PAUL.id && /just the last 4/.test(m.text))), 'not 4 digits: asks again');
  const pm = mid; priv(PAUL, '5555');
  ok(await until(async () => (await pg.query(`SELECT ssn4 FROM drivers WHERE id = $1`, [paul])).rows[0].ssn4 === '5555'), 'saved from the private chat');
  ok(!(await pg.query(`SELECT 1 FROM tg_messages WHERE chat_id = $1 AND msg_id = $2`, [PAUL.id, pm])).rows.length, 'and that private message is not kept');

  // run mode: the bot asks for what is missing (once)
  await pg.query(`UPDATE drivers SET zip = NULL WHERE id = $1`, [paul]);
  n = tg.sent.length; await web(`/api/drivers/${paul}/tg-mode`, { method: 'PATCH', body: { mode: 'run' } });
  ok(await until(() => inChat(n, PCHAT).some((m) => /What is your ZIP code\? We will book your drug test/i.test(m.text)), 10000), 'run mode: the bot asks for the ZIP code');
  await sleep(2500); ok(inChat(n, PCHAT).filter((m) => /ZIP code/.test(m.text)).length === 1, 'only once');
  // the 30 days
  await pg.query(`UPDATE drivers SET ssn4_at = now() - interval '31 days' WHERE id = $1`, [paul]);
  ok(await until(async () => !(await pg.query(`SELECT ssn4 FROM drivers WHERE id = $1`, [paul])).rows[0].ssn4, 5000), 'the last 4 are deleted after 30 days');
  ok((await web(`/api/drivers/${paul}/mvr`, { method: 'PATCH', body: { zip: '123' } })).status === 400, 'a wrong ZIP is refused');

  await pg.end();
  execSync('pkill -f "node src/serve[r].js" || true');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
