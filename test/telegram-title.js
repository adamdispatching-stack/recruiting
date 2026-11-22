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
    if (method === 'setMessageReaction') { (tg.reactions = tg.reactions || []).push(p); return out(true); }
    if (method === 'getChatMemberCount') return out((tg.counts || {})[p.chat_id] || 3);
    if (method === 'answerCallbackQuery') { tg.answers.push(p); return out(true); }
    if (method === 'getChatMember') return out({ status: 'administrator', user: BOT });
    if (method === 'getFile') return out({ file_id: p.file_id, file_path: 'f/' + p.file_id, file_size: 10 });
    if (method === 'deleteMessage') { (tg.deleted = tg.deleted || []).push(p); return out(true); }
    if (method === 'setMyCommands') { (tg.commands = tg.commands || []).push(p); return out(true); }
    res.statusCode = 404; res.end(JSON.stringify({ ok: false, description: 'unknown ' + method }));
  });
}).listen(4999);
// ---------- fake AI: the start date from the chat ----------
const AI = {};
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body); const tool = j.tools[0].name;
    if (tool === 'group_digest' && /ONBOARDING STEPS/.test(j.system)) {
      const fresh = ((j.messages[0].content.find((c) => c.type === 'text') || {}).text || '').split('NEW MESSAGES:')[1] || '';
      const today = /Today is \w+ (\d{4}-\d{2}-\d{2})/.exec(j.system)[1]; const day = (dow) => { const d = new Date(today + 'T12:00:00Z'); do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== dow); return d.toISOString().slice(0, 10); };
      const o = { summary: 'Onboarding.', waiting_on: 'driver', next_step: 'Start', blockers: [], open_questions: [], driver_mood: 'good', done_steps: [] };
      if (/ready to roll on Monday/.test(fresh)) { o.start_date = day(1); o.travel = 'Greyhound, arrives Newark Sunday 6 PM, ticket 88812345'; }
      if (/actually Wednesday/.test(fresh)) o.start_date = day(3);
      AI.seen = (AI.seen || 0) + 1;
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input: { truck_events: [], driver_notes: [], alerts: [], learned: [], onboarding: o } }] }));
    }
    if (tool === 'group_digest') { // a working group: who is who, and a container mix-up
      const fresh = ((j.messages[0].content.find((c) => c.type === 'text') || {}).text || '').split('NEW MESSAGES:')[1] || '';
      const unk = (/People whose role is not known yet: (.*)\./.exec(j.system) || [])[1];
      const people = unk ? unk.split('; ').map((n) => ({ name: n, role: /Dispatch/.test(n) ? 'dispatcher' : /Hank/.test(n) ? 'driver' : 'other' })) : [];
      const alerts = /CONTAINER ABCU9/.test(fresh) ? [{ kind: 'container_mismatch', severity: 'high', text: 'Container number does not match', ask_driver: 'is ABCU9 the right container?' }] : [];
      const working = /WORKING driver/.test(j.system); const load_updates = [], dispatch_lessons = [];
      if (working) {
        const at = /\[#(\d+) [^\]]*\] [^:]+: Arrived at the shipper/.exec(fresh); if (at) load_updates.push({ msg_id: +at[1], status: 'at_pickup', place: 'the shipper', by: 'driver' });
        const rl = /\[#(\d+) [^\]]*\] [^:]+: Rolling, ETA 4 PM/.exec(fresh); if (rl) load_updates.push({ msg_id: +rl[1], status: 'rolling', eta: '4 PM', place: 'Harrisburg', by: 'driver' });
        if (/send the BOL when loaded/.test(fresh)) dispatch_lessons.push({ situation: 'The driver arrives at the shipper', practice: 'Thanks him and asks for a photo of the BOL once loaded' });
      }
      const promises = [], promise_results = [];
      if (working) {
        const pm = /\[#(\d+) [^\]]*\] [^:]+: I will be at the receiver by 6 AM/.exec(fresh); if (pm) promises.push({ msg_id: +pm[1], what: 'Be at the receiver by 6 AM', due: '6 AM' });
        const op = /OPEN PROMISES \(id: what, due\): (\d+): Be at the receiver/.exec(j.system);
        if (op && /Sorry, overslept, will be there at 8/.test(fresh)) promise_results.push({ id: +op[1], result: 'broken', evidence: 'Overslept, 2 hours late' });
      }
      AI.working = (AI.working || 0) + (working ? 1 : 0);
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input: { truck_events: [], driver_notes: [], alerts, learned: [], people, load_updates, dispatch_lessons, promises, promise_results } }] }));
    }
    if (tool === 'dispatcher_profile') { AI.disp = (AI.disp || 0) + 1; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input: { summary: 'Short, clear messages.', tone: 'friendly', clarity: 'clear', professionalism: 'high', update_habits: ['Asks for the BOL photo once loaded'], phrases: ['Send me the BOL once loaded'], strengths: ['Answers fast'], improve: ['Ask for the ETA earlier'] } }] })); }
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
const SCHAT = { id: -100704, type: 'supergroup', title: 'Mark Marshall' };
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
    TELEGRAM_BOT_TOKEN: '999:test', TG_API_BASE: 'http://localhost:4999', TG_POLL_SECONDS: '1', TG_TICK_MS: '1000', TG_NO_QUIET: '1', TG_DIGEST_MS: '1000', TG_DIGEST_SETTLE_MIN: '0.03', TG_PROFILE_MS: '1500', TG_TEAM_MS: '1000', TG_DISP_MIN_MSGS: '2', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4998' };
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
  ok(await until(async () => ((await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [PCHAT.id])).rows[0] || {}).driver_id === paul), 'bot added by the team: the title\'s phone finds Paul, the group is connected, no command');
  ok(((await until(async () => (await pg.query(`SELECT mode FROM onb_cases WHERE driver_id = $1`, [paul])).rows[0])) || {}).mode === 'watch', 'it starts in Watch and learn');
  await sleep(500); ok(!inChat(n, PCHAT).length, 'silent: nothing written in the group');
  ok((await pg.query(`SELECT kind, driver_id FROM tg_chats WHERE chat_id = $1`, [PCHAT.id])).rows[0].driver_id === paul, 'linked to Paul on the website');
  // an ELD group: the title says ELD
  n = tg.sent.length; added(ECHAT, RITA);
  ok(await until(async () => ((await pg.query(`SELECT kind, driver_id FROM tg_chats WHERE chat_id = $1`, [ECHAT.id])).rows[0] || {}).kind === 'eld'), '"ELD - Paul Penn": connected as Paul\'s ELD group');
  // someone outside the team adds the bot: it asks the team to confirm
  n = tg.sent.length; added(SCHAT, STRANGER);
  await until(async () => (await web('/api/tg/waiting')).waiting.length, 5000);
  ok(!(await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [SCHAT.id])).rows[0].driver_id && !inChat(n, SCHAT).length, 'added by someone unknown (name only): nothing connected, nothing written in the group');
  let wt = (await web('/api/tg/waiting')).waiting;
  ok(wt.length === 1 && wt[0].driverId === mark && /looks like Mark Marshall's Dispatch group/.test(wt[0].what) && /Some One added the bot but has not connected Telegram/.test(wt[0].what), 'the website: waiting, "looks like Mark Marshall\'s group … Some One has not connected Telegram"');
  ok((await pg.query(`SELECT text FROM notices WHERE text LIKE 'Waiting:%'`)).rows.length >= 1, 'the admins are told');
  // he connects his Telegram: the group is connected by itself
  const sam = (await web('/api/users', { method: 'POST', body: { name: 'Sam Staff', email: 'sam@example.com', password: 'sam-pass-12345' } })).id;
  const sl = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sam@example.com', password: 'sam-pass-12345' }) });
  const scode = (await web('/api/tg/me-code', { method: 'POST', body: {}, cookie: sl.headers.get('set-cookie').split(';')[0] })).code;
  n = tg.sent.length; priv(STRANGER, '/me ' + scode);
  ok(await until(async () => (await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [SCHAT.id])).rows[0].driver_id === mark), 'he connects Telegram (/me): Mark\'s group is connected right away');
  ok(await until(() => sentSince(n).some((m) => m.chat_id === STRANGER.id && /Also connected what was waiting for you: <b>Mark Marshall<\/b>/.test(m.text))), 'and he is told');
  ok(!(await web('/api/tg/waiting')).waiting.length, 'nothing waiting any more');
  // someone unknown again: the admin connects it on the website, or dismisses it
  const tom = (await web('/api/drivers', { method: 'POST', body: { name: 'Tom Tester', source: 'Indeed', phone: '2155550123' } })).id;
  const TCHAT = { id: -100705, type: 'supergroup', title: 'Tom Tester' }, ZCHAT = { id: -100706, type: 'supergroup', title: 'Zack Zero' };
  const X = { id: 77, is_bot: false, first_name: 'Xavier', last_name: 'X' };
  added(TCHAT, X); added(ZCHAT, X);
  wt = await until(async () => { const w = (await web('/api/tg/waiting')).waiting; return w.length === 2 ? w : null; });
  ok(wt && wt.find((w) => w.chatId == TCHAT.id).driverId === tom && !wt.find((w) => w.chatId == ZCHAT.id).driverId, 'two waiting: Tom\'s group (found by name) and Zack Zero (nobody found)');
  ok((await web('/api/tg/waiting/' + wt.find((w) => w.chatId == TCHAT.id).id, { method: 'POST', body: {} })).ok && (await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [TCHAT.id])).rows[0].driver_id === tom, 'the admin taps "Connect to Tom Tester" on the website');
  ok((await web('/api/tg/waiting/' + wt.find((w) => w.chatId == ZCHAT.id).id, { method: 'POST', body: { dismiss: true } })).ok && !(await web('/api/tg/waiting')).waiting.length, 'Dismiss');
  // nobody on the website: a new driver in onboarding, with the phone from the title
  n = tg.sent.length; added(NCHAT, RITA);
  const nw = await until(async () => (await web('/api/tg/waiting')).waiting.find((w) => w.chatId == NCHAT.id));
  ok(nw && nw.newName === 'Nina Newbie' && /nobody on the website/.test(nw.what) && !inChat(n, NCHAT).length, 'unknown name and phone: waiting on the website, "Add Nina Newbie", nothing in the group');
  await web('/api/tg/waiting/' + nw.id, { method: 'POST', body: { newDriver: 'onboarding' } });
  const nina = await until(async () => (await pg.query(`SELECT d.id, d.status, d.phones FROM drivers d JOIN tg_chats c ON c.driver_id = d.id WHERE c.chat_id = $1`, [NCHAT.id])).rows[0]);
  ok(nina && nina.status === 'Onboarding' && nina.phones.includes('6105550199') && (await pg.query(`SELECT 1 FROM onboarding WHERE driver_id = $1`, [nina.id])).rows.length === 1, 'Nina added in onboarding, with the phone, and her group connected');

  // someone not connected adds the bot, but the title has a driver's phone: connected by itself
  const yon = (await web('/api/drivers', { method: 'POST', body: { name: 'Yonis Santa', source: 'Indeed', phone: '4844541057', ownerId: rita } })).id;
  const UPD = { id: 55, is_bot: false, first_name: 'Update', last_name: 'Department' };
  const YCHAT = { id: -100708, type: 'supergroup', title: 'Yonis Santa +1 (484) 454-1057' };
  n = tg.sent.length; added(YCHAT, UPD);
  ok(await until(async () => ((await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [YCHAT.id])).rows[0] || {}).driver_id === yon), 'added by "Update Department" (not connected): the phone in the title matches Yonis Santa, connected by itself');
  ok(!(await web('/api/tg/waiting')).waiting.some((w) => w.chatId == YCHAT.id), 'nothing left waiting for it');
  // "is our team" on the waiting card: marked, and their groups connect
  const KCHAT = { id: -100709, type: 'supergroup', title: 'Kim Kane' };
  const kim = (await web('/api/drivers', { method: 'POST', body: { name: 'Kim Kane', source: 'Indeed', phone: '6105550100' } })).id;
  added(KCHAT, UPD);
  const kw = await until(async () => (await web('/api/tg/waiting')).waiting.find((w) => w.chatId == KCHAT.id));
  const tr = await web('/api/tg/waiting/' + kw.id, { method: 'POST', body: { team: true } });
  ok(tr.ok && tr.connected === 1 && (await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [KCHAT.id])).rows[0].driver_id === kim && (await pg.query(`SELECT role FROM tg_people WHERE tg_id = 55`)).rows[0].role === 'staff', '"Update Department is our team": marked, Kim\'s group connected');
  const K2 = { id: -100710, type: 'supergroup', title: 'Kim Kane ELD' };
  added(K2, UPD);
  ok(await until(async () => ((await pg.query(`SELECT driver_id, kind FROM tg_chats WHERE chat_id = $1`, [K2.id])).rows[0] || {}).kind === 'eld'), 'from then on, groups they add connect by themselves (by name too)');

  // the MVR and the drug test, in Paul's group, the bot watching
  n = tg.sent.length;
  say(RITA, 'Paul, which state is your CDL from?', PCHAT); await sleep(200);
  say(PAUL, 'Pennsylvania', PCHAT);
  ok(await until(async () => (await pg.query(`SELECT license_state FROM drivers WHERE id = $1`, [paul])).rows[0].license_state === 'PA'), 'the driver answers "Pennsylvania": CDL state PA');
  ok(await until(async () => (await pg.query(`SELECT text FROM notices WHERE user_id = $1`, [rita])).rows.some((r) => /CDL is from Pennsylvania: the MVR needs the last 4 of the SSN/.test(r.text))), 'Rita is told: a PA MVR needs the last 4 of the SSN');
  let dv = await web('/api/drivers/' + paul);
  ok(dv.mvrNeeds.map((x) => x.key).join() === 'ssn4,zip,start', 'the driver page: still needed: last 4 of SSN, ZIP, start date');
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
  ok(dv.driver.licenseState === 'PA' && dv.driver.hasSsn4 && !('ssn4' in dv.driver) && dv.mvrNeeds.map((x) => x.key).join() === 'start', 'the driver page: PA, last 4 given (not sent with the page), only the start date missing');
  // "ready to roll on Monday": the start date on the website, from the chat
  say(PAUL, 'I will be ready to roll on Monday, taking the Greyhound', PCHAT);
  const ob1 = await until(async () => (await pg.query(`SELECT to_char(expected_arrival, 'YYYY-MM-DD') ea, extract(dow FROM expected_arrival)::int dow, arrival_by, arrival_note FROM onboarding WHERE driver_id = $1 AND expected_arrival IS NOT NULL`, [paul])).rows[0], 15000, 'start date');
  ok(ob1 && ob1.dow === 1 && ob1.arrival_by === 'ai', '"ready to roll on Monday": the start date is set to Monday');
  ok(ob1 && /Greyhound/.test(ob1.arrival_note) && !/88812345/.test(ob1.arrival_note), 'and the travel details (no ticket number)');
  ok((await pg.query(`SELECT text FROM notices WHERE user_id = $1 AND text LIKE 'Paul Penn: start date set to%'`, [rita])).rows.length === 1, 'Rita is told');
  ok((await pg.query(`SELECT done FROM checklist WHERE driver_id = $1 AND key = 'arrival_date'`, [paul])).rows[0].done, 'the "Arrival date set" step ticks itself');
  // the team sets another date: the chat never overwrites it, the recruiter is told instead
  const tue = new Date(new Date(ob1.ea + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);
  await web(`/api/drivers/${paul}/onboarding`, { method: 'PATCH', body: { expectedArrival: tue } });
  ok(!(await pg.query(`SELECT arrival_by FROM onboarding WHERE driver_id = $1`, [paul])).rows[0].arrival_by, 'Rita changes it on the website (Tuesday): the team\'s date now');
  say(PAUL, 'actually Wednesday is better', PCHAT);
  ok(await until(async () => (await pg.query(`SELECT text FROM notices WHERE user_id = $1 AND text LIKE 'Paul Penn: the Telegram group says the start is%'`, [rita])).rows.length === 1, 15000), 'the driver says Wednesday: Rita is told the chat and the website differ');
  ok((await pg.query(`SELECT extract(dow FROM expected_arrival)::int d FROM onboarding WHERE driver_id = $1`, [paul])).rows[0].d === 2, 'the team\'s date (Tuesday) stays');
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

  // ---------- working drivers' groups: more than 10 people ----------
  tg.counts = {};
  const hank = (await web('/api/drivers', { method: 'POST', body: { name: 'Hank Hired', source: 'Referral', phone: '2155550177' } })).id;
  await pg.query(`UPDATE drivers SET status = 'Hired' WHERE id = $1`, [hank]);
  const HCHAT = { id: -100720, type: 'supergroup', title: 'Hank Hired' }; tg.counts[HCHAT.id] = 14;
  n = tg.sent.length; added(HCHAT, UPD);
  ok(await until(async () => ((await pg.query(`SELECT driver_id, member_count, mode FROM tg_chats WHERE chat_id = $1`, [HCHAT.id])).rows[0] || {}).driver_id === hank), '14 people, "Hank Hired": the one active driver with that name, connected');
  ok((await pg.query(`SELECT member_count, mode FROM tg_chats WHERE chat_id = $1`, [HCHAT.id])).rows[0].mode === 'watch' && !inChat(n, HCHAT).length, 'watch and learn, nothing written');
  // a truck number in the title
  const t140 = (await web('/api/trucks', { method: 'POST', body: { unit: '140', details: '2023 Freightliner Cascadia' } })).id;
  const walt = (await web('/api/drivers', { method: 'POST', body: { name: 'Walt Worker', source: 'Referral' } })).id;
  await pg.query(`UPDATE drivers SET status = 'Hired' WHERE id = $1`, [walt]); await pg.query(`UPDATE trucks SET driver_id = $2 WHERE id = $1`, [t140, walt]);
  const TRK = { id: -100721, type: 'supergroup', title: 'Truck #140 updates' }; tg.counts[TRK.id] = 22;
  added(TRK, UPD);
  ok(await until(async () => ((await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [TRK.id])).rows[0] || {}).driver_id === walt), '"Truck #140 updates": the driver on truck 140');
  // a big group, but the website has the driver in onboarding: connected, no onboarding started, admins asked to check
  const ona = (await web('/api/drivers', { method: 'POST', body: { name: 'Ona Old', source: 'Indeed', phone: '6105550444' } })).id;
  await web('/api/drivers/' + ona, { method: 'PATCH', body: { status: 'Onboarding' } });
  const OCHAT = { id: -100722, type: 'supergroup', title: 'Ona Old 610 555 0444' }; tg.counts[OCHAT.id] = 12;
  n = tg.sent.length; added(OCHAT, UPD);
  ok(await until(async () => ((await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [OCHAT.id])).rows[0] || {}).driver_id === ona), 'Ona (in onboarding) by phone, 12 people: connected');
  await sleep(500);
  ok(!(await pg.query(`SELECT 1 FROM onb_cases WHERE driver_id = $1`, [ona])).rows.length && !inChat(n, OCHAT).length, 'no onboarding started there, nothing written');
  ok((await pg.query(`SELECT 1 FROM notices WHERE text LIKE '%has 12 people, so it looks like a working driver''s group, but Ona Old is "Onboarding"%'`)).rows.length >= 1, 'the admins are asked to check her status');
  say(PAUL, 'hello', OCHAT); await sleep(600); ok(!(await pg.query(`SELECT 1 FROM onb_cases WHERE driver_id = $1`, [ona])).rows.length, 'messages there do not start onboarding either');
  // nobody found in a big group: "Add as an active driver"
  const GCHAT = { id: -100723, type: 'supergroup', title: 'Gary Gone 484 555 0999' }; tg.counts[GCHAT.id] = 15;
  added(GCHAT, UPD);
  const gw = await until(async () => (await web('/api/tg/waiting')).waiting.find((w) => w.chatId == GCHAT.id));
  ok(gw && gw.big && gw.members === 15 && gw.newName === 'Gary Gone', 'nobody found, 15 people: waiting, offered as a new active driver');
  // learning who is who; how fast dispatchers answer
  const HANK = { id: 61, is_bot: false, first_name: 'Hank', last_name: 'Hired' }, DAN = { id: 62, is_bot: false, first_name: 'Dan', last_name: 'Dispatch' };
  say(HANK, 'Arrived at the shipper, door 12', HCHAT); await sleep(300); say(DAN, 'Thanks Hank, send the BOL when loaded', HCHAT);
  ok(await until(async () => ((await pg.query(`SELECT role FROM tg_people WHERE tg_id = 62`)).rows[0] || {}).role === 'dispatch', 15000), 'learned: Dan is a dispatcher');
  ok(((await pg.query(`SELECT role, driver_id FROM tg_people WHERE tg_id = 61`)).rows[0] || {}).driver_id === hank, 'learned: Hank is the driver of this group');
  await pg.query(`UPDATE tg_messages SET at = now() - interval '20 minutes' WHERE chat_id = $1 AND from_id = 61`, [HCHAT.id]);
  const ppl = (await web('/api/tg/people')).people;
  const dan = ppl.find((x) => x.tg_id === '62');
  ok(ppl[0].role === 'dispatch' && dan.msgs7 === 1 && dan.reply_min >= 19 && dan.reply_min <= 21, 'People: dispatchers first, Dan answers the driver in about 20 min');
  // load updates and how the dispatchers work
  ok(await until(async () => (await pg.query(`SELECT status FROM tg_updates WHERE chat_id = $1`, [HCHAT.id])).rows.some((x) => x.status === 'at_pickup')), 'load update seen: at the shipper');
  say(HANK, 'Rolling, ETA 4 PM', HCHAT);
  ok(await until(async () => (await pg.query(`SELECT eta FROM tg_updates WHERE chat_id = $1 AND status = 'rolling'`, [HCHAT.id])).rows[0]), 'and "Rolling, ETA 4 PM"');
  const lesson = (await web('/api/tg/knowledge')).knowledge.find((x) => x.kind === 'dispatch');
  ok(lesson && /arrives at the shipper/.test(lesson.question) && lesson.review && !lesson.active, 'a dispatching practice learned, waiting for approval');
  const ad = await web('/api/active/' + hank);
  ok(ad.updates && ad.updates[0].status === 'rolling' && ad.updates[0].eta === '4 PM', 'the active driver page: the latest load update');
  ok(((await web('/api/tg/chats')).chats.find((c) => c.chatId == HCHAT.id).lastUpdate || {}).status === 'rolling', 'the groups list: the latest update');
  // the driver's word
  say(HANK, 'I will be at the receiver by 6 AM', HCHAT);
  ok(await until(async () => (await pg.query(`SELECT 1 FROM tg_promises WHERE driver_id = $1 AND state = 'open'`, [hank])).rows.length, 15000), 'a promise: "be at the receiver by 6 AM"');
  say(HANK, 'Sorry, overslept, will be there at 8', HCHAT);
  ok(await until(async () => (await pg.query(`SELECT 1 FROM tg_promises WHERE driver_id = $1 AND state = 'broken'`, [hank])).rows.length, 15000), 'not kept: overslept');
  const ad2 = await web('/api/active/' + hank);
  ok(ad2.promises[0].state === 'broken' && ad2.word.broken === 1, 'the active driver page: Keeps his word, 0 of 1');
  // checking the load updates; the dispatch autopilot
  const upd = (await web('/api/tg/chats/' + HCHAT.id)).updates;
  ok((await web('/api/tg/updates/' + upd[0].id, { method: 'POST', body: { ok: true } })).ok && (await web('/api/tg/updates/' + upd[1].id, { method: 'POST', body: { ok: false } })).ok, 'the team checks two load updates: right, wrong');
  const dr = await web('/api/tg/dispatch-readiness');
  ok(dr.groups.groups >= 2 && dr.updates.ok === 1 && dr.updates.wrong === 1 && dr.updates.accuracy === 0.5 && dr.practices.waiting === 1 && dr.promises.broken === 1 && !dr.ready, 'Dispatch autopilot: groups, 50% read right, 1 practice to approve, 1 promise broken, still learning');
  say(DAN, 'Ok Hank, let me know when you are rolling', HCHAT); say(DAN, 'Send me the ETA please', HCHAT);
  ok(await until(async () => ((await web('/api/tg/dispatch-readiness')).dispatchers.find((x) => x.name === 'Dan Dispatch') || {}).profile, 15000), 'Dan\'s dispatcher profile is written');
  const dd = (await web('/api/tg/dispatch-readiness')).dispatchers.find((x) => x.name === 'Dan Dispatch');
  ok(dd.profile.tone === 'friendly' && dd.profile.update_habits.length && dd.msgs30 >= 1, 'with tone, how he runs updates, messages');
  ok((await web('/api/tg/autopilot', { method: 'PUT', body: { workMode: 'updater' } })).ok && (await web('/api/tg/dispatch-readiness')).settings.workMode === 'updater', 'new working groups can start in Updater');
  const U2 = { id: -100724, type: 'supergroup', title: 'Walt Worker 2' }; tg.counts[U2.id] = 11;
  added(U2, UPD);
  ok(await until(async () => ((await pg.query(`SELECT mode FROM tg_chats WHERE chat_id = $1 AND driver_id = $2`, [U2.id, walt])).rows[0] || {}).mode === 'updater'), 'and they do');
  await web('/api/tg/autopilot', { method: 'PUT', body: { workMode: 'watch' } });
  // an onboarding group whose driver is hired: it becomes a dispatch group, the bot learns dispatching there
  await web('/api/drivers/' + nina.id, { method: 'PATCH', body: { status: 'Hired' } });
  ok(await until(async () => (await web('/api/tg/log?chat=' + NCHAT.id)).log.some((x) => /is active now: this is the driver's dispatch group/.test(x.text))), 'Nina hired: her group is now a dispatch group (history)');
  const w0 = AI.working; say(PAUL, 'test message', NCHAT);
  ok(await until(() => AI.working > w0, 15000), 'and the bot reads it as a working group (learns updates)');
  // the group page; updater mode
  const gp = await web('/api/tg/chats/' + HCHAT.id);
  ok(gp.chat.working && gp.chat.members === 14 && gp.chat.mode === 'watch' && gp.chat.learning.msgs >= 3 && gp.chat.learning.dispatchers === 1 && gp.chat.learning.updates >= 2 && gp.chat.learning.lessons === 1 && gp.updates.length >= 2, 'the group page: working group, 14 people, 3 messages read, 1 dispatcher, 2 load updates, 1 practice');
  n = tg.sent.length; say(HANK, 'loaded CONTAINER ABCU9', HCHAT);
  ok(await until(async () => (await pg.query(`SELECT 1 FROM tg_alerts WHERE chat_id = $1`, [HCHAT.id])).rows.length, 15000), 'watch: the container mix-up is an alert on the website');
  await sleep(500); ok(!inChat(n, HCHAT).length, 'and nothing is written in the group');
  ok((await web(`/api/tg/chats/${HCHAT.id}/mode`, { method: 'PATCH', body: { mode: 'updater' } })).ok, 'switch to 🚚 Updater on the website');
  n = tg.sent.length; say(HANK, 'second one CONTAINER ABCU9', HCHAT);
  ok(await until(() => inChat(n, HCHAT).some((m) => /is ABCU9 the right container\?/.test(m.text)), 15000), 'updater: the bot asks the driver about the container');
  n = tg.sent.length; say(RITA, '/mode', HCHAT);
  const mb = await until(() => inChat(n, HCHAT).find((m) => /Now: 🚚 Updater/.test(m.text)));
  ok(mb && /^✓ 🚚/.test(mb.reply_markup.inline_keyboard[1][0].text), '/mode in a working group: Watch and learn / Updater');
  say(RITA, '/mode watch', HCHAT);
  ok(await until(async () => (await pg.query(`SELECT mode FROM tg_chats WHERE chat_id = $1`, [HCHAT.id])).rows[0].mode === 'watch'), '/mode watch: back to watching');

  // ---------- /empty: the empty trucks ----------
  const co = (await pg.query(`INSERT INTO companies (name) VALUES ('Bobtail Trucking') RETURNING id`)).rows[0].id;
  await pg.query(`INSERT INTO trucks (unit, company_id) VALUES ('T7', $1), ('T9', $1)`, [co]);
  const cody = (await web('/api/drivers', { method: 'POST', body: { name: 'Cody Coming', source: 'Indeed' } })).id;
  await web('/api/drivers/' + cody, { method: 'PATCH', body: { status: 'Onboarding' } });
  await pg.query(`UPDATE trucks SET driver_id = $1 WHERE unit = 'T9'`, [cody]); // Cody is coming for T9
  n = tg.sent.length; priv(RITA, '/empty');
  const em = await until(() => sentSince(n).find((m) => m.chat_id === RITA.id && /empty truck/.test(m.text)));
  ok(em && /<b>Bobtail Trucking<\/b> \(2\)/.test(em.text) && /<b>T7<\/b>/.test(em.text) && /coming: Cody Coming/.test(em.text) && /a day/.test(em.text), '/empty in a private chat: the empty trucks by company, the cost, who is coming');
  n = tg.sent.length; priv(RITA, 'empty');
  ok(await until(() => sentSince(n).some((m) => m.chat_id === RITA.id && /empty truck/.test(m.text))), 'just "empty" works too');
  n = tg.sent.length; say(RITA, '/empty', HCHAT);
  ok(await until(() => sentSince(n).some((m) => String(m.chat_id) === String(RITA.id) && /empty truck/.test(m.text))) && !inChat(n, HCHAT).length, 'in a driver\'s group: sent to Rita privately, nothing in the group');
  n = tg.sent.length; priv(X, '/empty');
  ok(await until(() => sentSince(n).some((m) => m.chat_id === X.id && /Only our team/.test(m.text))), 'someone not on the team: refused');
  n = tg.sent.length; say(HANK, '/empty', HCHAT); await sleep(600);
  ok(!sentSince(n).length, 'a driver typing it: nothing');

  // ---------- /onboard and management groups ----------
  await pg.query(`UPDATE drivers SET amazon_step = 'verified' WHERE id = $1`, [paul]);
  await pg.query(`UPDATE drivers SET amazon_step = 'accurate', amazon_log = jsonb_build_object('accurate', (now() - interval '6 hours')::text), owner_id = $2 WHERE id = $1`, [cody, rita]);
  await pg.query(`UPDATE tg_people SET user_id = $1 WHERE tg_id = 11`, [rita]); // Rita's Telegram is Rita on the website
  n = tg.sent.length; priv(RITA, '/onboard');
  const ob = await until(() => sentSince(n).find((m) => String(m.chat_id) === String(RITA.id) && /in onboarding/.test(m.text)), 20000);
  ok(ob && /✅ <b>Amazon verified<\/b> \(\d+\)[\s\S]*Paul Penn[\s\S]*⏳ <b>Pending Amazon<\/b>[\s\S]*Cody Coming/.test(ob.text), '/onboard: Amazon verified (Paul), then pending Amazon (Cody)');
  ok(ob && /Amazon: Background check \(6 h\)/.test(ob.text) && /Paul Penn<\/b>: Rita Recruiter, starts/.test(ob.text), 'with the recruiter, the start date, the Amazon step and how long');
  const MCHAT = { id: -100740, type: 'supergroup', title: 'Management Team' };
  n = tg.sent.length; added(MCHAT, RITA);
  ok(await until(async () => ((await pg.query(`SELECT kind FROM tg_chats WHERE chat_id = $1`, [MCHAT.id])).rows[0] || {}).kind === 'management'), '"Management Team" added by Rita: our team\'s group');
  await sleep(500);
  ok(!inChat(n, MCHAT).length, 'silent when connected');
  n = tg.sent.length; say(RITA, '/onboard', MCHAT);
  ok(await until(() => inChat(n, MCHAT).some((m) => /in onboarding/.test(m.text) && /@rita_r/.test(m.text))), '/onboard in the management group: posted there, the recruiter tagged');
  // the morning report and follow-ups
  await pg.query(`UPDATE drivers SET callback_state = 'due', callback_at = now() - interval '1 hour', callback_said = '3 PM' WHERE id = $1`, [cody]);
  await pg.query(`UPDATE drivers SET amazon_log = jsonb_build_object('accurate', (now() - interval '6 days')::text) WHERE id = $1`, [cody]);
  const nowT = new Date(Date.now() - 60000).toLocaleTimeString('en-GB', { timeZone: (await pg.query(`SELECT value FROM settings WHERE key = 'tz'`)).rows[0]?.value || 'America/New_York', hour: '2-digit', minute: '2-digit' });
  n = tg.sent.length; ok((await web('/api/tg/autopilot', { method: 'PUT', body: { teamReportAt: nowT } })).ok, 'morning report time set');
  ok(await until(() => inChat(n, MCHAT).some((m) => /Good morning, team/.test(m.text)), 15000), 'the morning report is posted');
  ok(await until(() => inChat(n, MCHAT).some((m) => /🔔 @rita_r: Cody Coming has been on "Background check" with Amazon for 6 days/.test(m.text)), 15000), 'follow-up: Amazon stuck, Rita tagged');
  ok(await until(() => inChat(n, MCHAT).some((m) => /🔔 @rita_r missed the call-back to Cody Coming/.test(m.text)), 15000), 'follow-up: a missed call-back');
  await sleep(2500); ok(inChat(n, MCHAT).filter((m) => /Background check" with Amazon/.test(m.text)).length === 1, 'each follow-up once a day');
  await pg.query(`UPDATE drivers SET callback_state = NULL WHERE id = $1`, [cody]);
  // someone not on the team adds the bot to a team group: the website connects it
  const OPS = { id: -100741, type: 'supergroup', title: 'Ops office' };
  added(OPS, X);
  const ow = await until(async () => (await web('/api/tg/waiting')).waiting.find((w) => w.chatId == OPS.id));
  ok(ow && ow.kind === 'management', 'added by someone not connected: waiting as a management group');
  await web('/api/tg/waiting/' + ow.id, { method: 'POST', body: { kind: 'management' } });
  ok(((await pg.query(`SELECT kind FROM tg_chats WHERE chat_id = $1`, [OPS.id])).rows[0] || {}).kind === 'management', 'connected on the website');
  ok((await web(`/api/tg/chats/${MCHAT.id}/report`, { method: 'POST' })).ok, '"Send the onboarding list now" on the group page');

  // ---------- ELD and accounting groups ----------
  const ella = (await web('/api/drivers', { method: 'POST', body: { name: 'Ella Evans', source: 'Referral' } })).id;
  await pg.query(`UPDATE drivers SET status = 'Hired' WHERE id = $1`, [ella]);
  const E1 = { id: -100730, type: 'supergroup', title: 'Ella Evans - ELD team +1 215 555 0999' };
  added(E1, X); // someone not connected; the phone is not on the website
  ok(await until(async () => ((await pg.query(`SELECT kind, driver_id FROM tg_chats WHERE chat_id = $1`, [E1.id])).rows[0] || {}).kind === 'eld'), '"Ella Evans - ELD team +1 215…": the ELD word is seen, Ella (active) found by name, connected as her ELD group');
  ok(((await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [E1.id])).rows[0] || {}).driver_id === ella, 'to Ella');
  await sleep(800); ok(!tg.sent.some((m) => String(m.chat_id) === String(E1.id)) && (await pg.query(`SELECT mode FROM tg_chats WHERE chat_id = $1`, [E1.id])).rows[0].mode === 'watch', 'Ella is already active: silent, no ELD setup messages, reads only');
  say(PAUL, 'logs look fine today', E1); await sleep(800); ok(!tg.sent.some((m) => String(m.chat_id) === String(E1.id)), 'messages there get no answer from the bot');
  const E2 = { id: -100731, type: 'supergroup', title: 'Аccounting Ella Evans' }; // Cyrillic А
  added(E2, X);
  ok(await until(async () => ((await pg.query(`SELECT kind, driver_id FROM tg_chats WHERE chat_id = $1`, [E2.id])).rows[0] || {}).kind === 'accounting'), '"Аccounting" typed on a Russian keyboard: her accounting group');
  await sleep(800); ok(!tg.sent.some((m) => String(m.chat_id) === String(E2.id)), 'her accounting group: silent too');
  // switched on from the website: the ELD setup starts
  ok((await web(`/api/tg/chats/${E1.id}/mode`, { method: 'PATCH', body: { mode: 'updater' } })).ok && (await until(() => tg.sent.some((m) => String(m.chat_id) === String(E1.id)))), 'switched on on the group page: the ELD setup posts');
  await web(`/api/tg/chats/${E1.id}/mode`, { method: 'PATCH', body: { mode: 'watch' } });
  // nobody fits: the card lets you pick the group type and any driver
  const E3 = { id: -100732, type: 'supergroup', title: 'Zed Zero ELD 610 555 0101' };
  added(E3, X);
  const e3 = await until(async () => (await web('/api/tg/waiting')).waiting.find((w) => w.chatId == E3.id));
  ok(e3 && e3.kind === 'eld' && e3.others.some((o) => o.id === walt) && e3.others[0].status === 'Hired', 'nobody fits: waiting as an ELD group, every driver to pick from (active first)');
  await web('/api/tg/waiting/' + e3.id, { method: 'POST', body: { driverId: walt, kind: 'eld' } });
  ok(((await pg.query(`SELECT kind, driver_id FROM tg_chats WHERE chat_id = $1`, [E3.id])).rows[0] || {}).driver_id === walt, 'picked Walt: his ELD group');
  // a dispatch group renamed to say ELD: the same driver's ELD group now
  push({ message: { message_id: mid++, from: RITA, chat: { ...YCHAT, title: 'Yonis Santa ELD' }, date: Math.floor(Date.now() / 1000), new_chat_title: 'Yonis Santa ELD' } });
  ok(await until(async () => ((await pg.query(`SELECT kind, driver_id FROM tg_chats WHERE chat_id = $1`, [YCHAT.id])).rows[0] || {}).kind === 'eld'), 'renamed "Yonis Santa ELD": now his ELD group');

  // the bot's history: reactions and replies to the bot
  const bm = tg.sent.filter((m) => String(m.chat_id) === String(PCHAT.id)).pop();
  push({ message_reaction: { chat: PCHAT, message_id: bm.message_id, user: PAUL, date: Math.floor(Date.now() / 1000), old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] } });
  push({ message: { message_id: mid++, from: PAUL, chat: PCHAT, date: Math.floor(Date.now() / 1000), text: 'ok my zip is 19104', reply_to_message: { message_id: bm.message_id, from: BOT, text: bm.text } } });
  const lg = await until(async () => { const r = await web('/api/tg/log'); return r.log.some((x) => x.kind === 'reaction') && r.log.some((x) => x.kind === 'reply') ? r : null; });
  ok(lg && /Reacted 👍 to the bot/.test(lg.log.find((x) => x.kind === 'reaction').text) && lg.log.find((x) => x.kind === 'reaction').who === 'Paul Penn', 'history: Paul reacted 👍 to the bot');
  ok(lg && /Replied to the bot .*ok my zip is ••••/.test(lg.log.find((x) => x.kind === 'reply').text), 'history: Paul replied to the bot (numbers hidden)');
  const kinds = new Set(); for (const k of ['join', 'title', 'connect', 'wait', 'me', 'said', 'fact', 'mode', 'ask']) if ((await web('/api/tg/log?kinds=' + k)).log.length) kinds.add(k);
  ok(['join', 'title', 'connect', 'wait', 'me', 'said', 'fact', 'mode', 'ask'].every((k) => kinds.has(k)), 'history: joined, read the title, connected, waiting, Telegram connected, bot messages, saved facts, mode, asked');
  ok(!(await pg.query(`SELECT 1 FROM tg_log WHERE text ~ '4321|6789|5555'`)).rows.length, 'history never shows the SSN digits');
  const lp = await web('/api/tg/log?chat=' + PCHAT.id + '&kinds=tap,reaction,reply');
  ok(lp.log.length && lp.log.every((x) => String(x.chatId) === String(PCHAT.id) && ['tap', 'reaction', 'reply'].includes(x.kind)), 'filtered by group and by "reactions"');
  if (process.env.SHOTS) {
    const { chromium } = require('playwright'); const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const p = await (await b.newContext({ viewport: { width: 1300, height: 1000 } })).newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE + '/#/login'); await p.fill('input[name=email]', 'admin@example.com'); await p.fill('input[name=password]', 'test-password-123'); await p.click('#lf button'); await p.waitForSelector('.rail');
    added({ id: -100707, type: 'supergroup', title: 'Mark Marshall ELD' }, X); added({ id: -100733, type: 'supergroup', title: 'Nobody Here ELD 6105550199' }, X); added({ id: -100711, type: 'supergroup', title: 'New group' }, X); await sleep(1500);
    await p.goto(BASE + '/#/telegram?tab=groups'); await p.waitForSelector('.tgwait'); await p.locator('.tgwait').screenshot({ path: '/tmp/shot/wait.png' });
    await p.goto(BASE + '/#/telegram?tab=history'); await p.waitForSelector('.tgloglist li'); await p.screenshot({ path: '/tmp/shot/hist.png', fullPage: false });
    await p.click('[data-act=tgLogF][data-k="tap,reaction,reply"]'); await p.waitForTimeout(500); await p.screenshot({ path: '/tmp/shot/hist2.png' });
    await p.goto(BASE + '/#/telegram/' + HCHAT.id); await p.waitForSelector('.tgwork'); await p.locator('.tgwork').screenshot({ path: '/tmp/shot/work.png' });
    await p.goto(BASE + '/#/telegram?tab=knowledge'); await p.waitForSelector('.dautop'); await p.locator('.dautop').screenshot({ path: '/tmp/shot/dauto.png' });
    await p.goto(BASE + '/#/active/' + hank); await p.waitForSelector('.list'); await p.screenshot({ path: '/tmp/shot/driver.png', fullPage: true });
    await p.goto(BASE + '/#/telegram/' + MCHAT.id); await p.waitForSelector('#teamForm'); await p.locator('.tgwork').screenshot({ path: '/tmp/shot/team.png' });
    await p.goto(BASE + '/#/telegram?tab=people'); await p.waitForSelector('table.tgt'); await p.locator('table.tgt').screenshot({ path: '/tmp/shot/people.png' });
    await p.goto(BASE + '/#/telegram/' + PCHAT.id); await p.waitForSelector('#tgLogBox li.tglog'); await p.locator('.tglogc').screenshot({ path: '/tmp/shot/histc.png' });
    await p.setViewportSize({ width: 390, height: 900 }); await p.goto(BASE + '/#/telegram?tab=history'); await p.waitForSelector('.tgloglist li'); await p.screenshot({ path: '/tmp/shot/hist-m.png' });
    ok(!errs.length, 'no page errors ' + errs.join(' | ')); await b.close();
  }
  await pg.end();
  execSync('pkill -f "node src/serve[r].js" || true');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
