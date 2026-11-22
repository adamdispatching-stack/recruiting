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
    let p; try { p = JSON.parse(body || '{}'); } catch (e) { // a file (multipart): keep the chat, the caption and the size
      p = { chat_id: (/name="chat_id"\r\n\r\n(-?\d+)/.exec(body) || [])[1], caption: (/name="caption"\r\n\r\n([^\r]*)/.exec(body) || [])[1], filename: (/filename="([^"]*)"/.exec(body) || [])[1], bytes: body.length }; }
    if (/send(Photo|Document)$/.test(req.url)) { (tg.files_sent = tg.files_sent || []).push({ method: req.url.split('/').pop(), ...p }); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, result: { message_id: 7000 + tg.files_sent.length, date: 0, chat: { id: +p.chat_id } } })); }
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
    const j = JSON.parse(body); j.system = (Array.isArray(j.system) ? j.system.map((b) => b.text).join('\n') : j.system || '') + '\n' + j.messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'))).join('\n'); /* the instructions and the group details, as one text */
    const tool = j.tools[0].name;
    if (tool === 'group_digest') { const who = (/group of ([^,.\n]+)/.exec(j.system) || [])[1]; AI.dg = AI.dg || {}; AI.dg[who] = (AI.dg[who] || 0) + 1; AI.lastDigest = { model: j.model, cached: !!j.tools[0].cache_control && Array.isArray(JSON.parse(body).system) }; }
    if (tool === 'group_digest' && /ONBOARDING STEPS/.test(j.system)) {
      const fresh = ((j.messages[0].content.find((c) => c.type === 'text') || {}).text || '').split('NEW MESSAGES:')[1] || '';
      const today = /Today is \w+ (\d{4}-\d{2}-\d{2})/.exec(j.system)[1]; const day = (dow) => { const d = new Date(today + 'T12:00:00Z'); do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== dow); return d.toISOString().slice(0, 10); };
      const o = { summary: 'Onboarding.', waiting_on: 'driver', next_step: 'Start', blockers: [], open_questions: [], driver_mood: 'good', done_steps: [] };
      if (/ready to roll on Monday/.test(fresh)) { o.start_date = day(1); o.travel = 'Greyhound, arrives Newark Sunday 6 PM, ticket 88812345'; }
      if (/actually Wednesday/.test(fresh)) o.start_date = day(3);
      if (/not be able to come/.test(fresh)) o.dropping_out = { quote: 'I will not be able to come, found a local job', reason: 'Found another job' };
      AI.seen = (AI.seen || 0) + 1;
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input: { truck_events: [], driver_notes: [], alerts: [], learned: [], onboarding: o } }] }));
    }
    if (tool === 'group_digest') { // a working group: who is who, and a container mix-up
      const fresh = ((j.messages[0].content.find((c) => c.type === 'text') || {}).text || '').split('NEW MESSAGES:')[1] || '';
      const unk = (/People whose role is not known yet: (.*)\./.exec(j.system) || [])[1];
      const people = unk ? unk.split('; ').map((n) => ({ name: n, role: /Dispatch/.test(n) ? 'dispatcher' : /Hank/.test(n) ? 'driver' : 'other' })) : [];
      const alerts = /CONTAINER ABCU9/.test(fresh) ? [{ kind: 'container_mismatch', severity: 'high', text: 'Container number does not match', ask_driver: 'is ABCU9 the right container?' }] : [];
      const working = /This is a WORKING driver/.test(j.system); const load_updates = [], dispatch_lessons = [];
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
      // the case playbook: a breakdown on the Turnpike; then he moved off it
      const cases_opened = [], case_updates = [];
      if (working) {
        AI.playbook = /CASE PLAYBOOK/.test(j.system);
        const pbid = (/\n(\d+): Breakdown on the NJ Turnpike/.exec(j.system) || [])[1];
        const bd = /\[#(\d+) [^\]]*\] [^:]+: Truck broke down on the turnpike/.exec(fresh); if (bd && pbid) cases_opened.push({ playbook_id: +pbid, msg_id: +bd[1], summary: 'Truck broke down on the NJ Turnpike near exit 7A', city: 'Elizabeth', state: 'NJ' });
        const oc = (/case (\d+): Breakdown on the NJ Turnpike/.exec(j.system) || [])[1];
        if (oc && /moved to the service area/.test(fresh)) case_updates.push({ case_id: +oc, steps_done: [1, 2], note: 'At the Molly Pitcher service area', resolved: false });
      }
      // shops, home time, leaving signs, the orientation day
      const places = [], leaving_signs = [], orientation_done = [], desk_asks = []; let home_time;
      if (working && /wake up at 10:30/.test(fresh)) desk_asks.push({ kind: 'rest', until: '10:30', quote: 'I will wake up at 10:30' });
      if (working && /I am empty in Harrisburg/.test(fresh)) desk_asks.push({ kind: 'needs_load', place: 'Harrisburg, PA', quote: 'I am empty, need a load' });
      if (working) {
        if (/Use Mikes Diesel/.test(fresh)) places.push({ name: 'Mikes Diesel Repair', kind: 'shop', services: ['DPF cleaning', 'air leaks'], phone: '(410) 555-0199', city: 'Baltimore', state: 'MD', area: 'Baltimore area', outcome: 'unknown' });
        if (/fixed at Mikes Diesel/.test(fresh)) places.push({ name: 'Mikes Diesel Repair', kind: 'shop', phone: '4105550199', outcome: 'good', cost: 850, note: 'Fixed the air leak', services: ['air leaks'] });
        const today = (/Today is \w+ (\d{4}-\d{2}-\d{2})/.exec(j.system) || [])[1];
        const plus = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
        if (/going home tomorrow, back in 2 days, need a ticket/.test(fresh) && today) home_time = { event: 'going_home', leave_on: plus(1), back_on: plus(2), needs_ticket: true, quote: 'going home tomorrow' };
        if (/back on the road now/.test(fresh)) home_time = { event: 'back_on_road', quote: 'back on the road now' };
        if (/offer from another company/.test(fresh)) leaving_signs.push({ kind: 'other_offer', strength: 'strong', quote: 'Got an offer from another company' });
        if (/ELD works, I am logged in/.test(fresh) && /or_eld:/.test(j.system)) orientation_done.push('or_eld');
      }
      AI.working = (AI.working || 0) + (working ? 1 : 0);
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input: { truck_events: [], driver_notes: [], alerts, learned: [], desk_asks, places, leaving_signs, orientation_done, ...(home_time ? { home_time } : {}), cases_opened, case_updates, people, load_updates, dispatch_lessons, promises, promise_results } }] }));
    }
    if (tool === 'dispatcher_profile') { AI.disp = (AI.disp || 0) + 1; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input: { summary: 'Short, clear messages.', tone: 'friendly', clarity: 'clear', professionalism: 'high', update_habits: ['Asks for the BOL photo once loaded'], phrases: ['Send me the BOL once loaded'], strengths: ['Answers fast'], improve: ['Ask for the ETA earlier'],
      scores: [{ area: 'speed', score: 4, seen: 'Answers within 20 minutes.', example: 'Send me the ETA please' }, { area: 'driver_care', score: 2, seen: 'Pushed a tired driver.' }],
      issues: [{ situation: 'Driver late to the receiver', what_he_did: 'Asked for a new ETA', verdict: 'ok', better_way: 'Call the receiver first' }], thinking: 'Reacts more than he plans.', drivers_view: 'Drivers trust him.',
      red_flags: AI.disp > 1 ? ['Told a driver to keep driving past his hours'] : [], feedback: { praise_first: 'You answer fast.', main_point: 'Ask for the ETA before the driver is late.', how_to_say_it: 'Dan, you answer fast. Ask for the ETA earlier.', goal: 'ETA asked at every pickup', check_how: 'Look for ETA questions after loaded' },
      tip: 'Ask for the ETA as soon as the driver says loaded.', trend: { direction: AI.disp > 1 ? 'better' : 'first', what_changed: '' }, confidence: 'low' } }] })); }
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
    TELEGRAM_BOT_TOKEN: '999:test', TG_CASE_MS: '1500', TG_API_BASE: 'http://localhost:4999', TG_POLL_SECONDS: '1', TG_TICK_MS: '1000', TG_NO_QUIET: '1', TG_DIGEST_MS: '1000', TG_DIGEST_SETTLE_MIN: '0.03', TG_PROFILE_MS: '1500', TG_TEAM_MS: '1000', TG_DISP_MIN_MSGS: '2', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4998' };
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
  const note1 = await until(async () => (await pg.query(`SELECT arrival_note FROM onboarding WHERE driver_id = $1 AND arrival_note IS NOT NULL`, [paul])).rows[0]);
  ok(note1 && /Greyhound/.test(note1.arrival_note) && !/88812345/.test(note1.arrival_note), 'and the travel details (no ticket number)');
  ok((await pg.query(`SELECT text FROM notices WHERE user_id = $1 AND text LIKE 'Paul Penn: start date%'`, [rita])).rows.length === 0, 'no notification for it (it is in the bot history)');
  ok((await pg.query(`SELECT done FROM checklist WHERE driver_id = $1 AND key = 'arrival_date'`, [paul])).rows[0].done, 'the "Arrival date set" step ticks itself');
  // the team sets another date: the chat never overwrites it, the recruiter is told instead
  const tue = new Date(new Date(ob1.ea + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);
  await web(`/api/drivers/${paul}/onboarding`, { method: 'PATCH', body: { expectedArrival: tue } });
  ok(!(await pg.query(`SELECT arrival_by FROM onboarding WHERE driver_id = $1`, [paul])).rows[0].arrival_by, 'Rita changes it on the website (Tuesday): the team\'s date now');
  say(PAUL, 'actually Wednesday is better', PCHAT);
  ok(await until(async () => (await pg.query(`SELECT 1 FROM tg_log WHERE text LIKE 'The chat says the start is%'`)).rows.length === 1, 15000), 'the driver says Wednesday: the bot history shows the chat and the website differ (no notification)');
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
  // cheaper reading: "ok" and 👍 need no AI call; groups are read by the cheaper model with its instructions cached
  const hd0 = (AI.dg || {})['Hank Hired'] || 0;
  say(HANK, 'ok', HCHAT); say(DAN, '👍', HCHAT);
  ok(await until(async () => (await pg.query(`SELECT bool_and(digested) x FROM tg_messages WHERE chat_id = $1`, [HCHAT.id])).rows[0].x, 15000) && ((AI.dg || {})['Hank Hired'] || 0) === hd0, '"ok" and 👍: marked read without an AI call');
  ok(AI.lastDigest && AI.lastDigest.model === 'claude-haiku-5-5' && AI.lastDigest.cached, 'the groups are read by Haiku, with the instructions cached');
  // the case playbook: a breakdown on the NJ Turnpike
  ok((await web('/api/playbooks')).playbooks.length >= 11, 'the playbook starts with the common road cases');
  const njTow = (await web('/api/places', { method: 'POST', body: { name: 'Turnpike Towing', kind: 'tow', services: 'heavy tow', phone: '7325550188', city: 'Edison', state: 'NJ' } })).id;
  say(HANK, 'Truck broke down on the turnpike near exit 7A, waiting for amazon roadside', HCHAT);
  const cs = await until(async () => ((await web('/api/cases')).cases || []).find((c) => c.driver_id === hank), 15000);
  ok(AI.playbook && cs && /Turnpike/.test(cs.title) && cs.next === 1 && cs.steps.length === 6 && cs.rules.some((r) => /never leave him waiting on the shoulder/.test(r)), 'the bot opens the case "Breakdown on the NJ Turnpike" with its steps and if/else rules');
  ok(cs.draft && /Are you safe/.test(cs.draft.text) && !tg.sent.some((m) => /Are you safe/.test(m.text)), 'Watch: the message for the driver waits on the website');
  ok(cs.state === 'NJ' && (cs.nearby || []).some((p) => p.name === 'Turnpike Towing'), 'the case knows it is in NJ and shows the towing we have there');
  ok((await pg.query(`SELECT 1 FROM notices WHERE text LIKE 'Hank Hired: Breakdown on the NJ Turnpike%'`)).rows.length >= 1, 'the team is told, with the first step');
  say(HANK, 'Ok I moved to the service area, truck still runs rough', HCHAT);
  const cs2 = await until(async () => { const c = ((await web('/api/cases')).cases || []).find((x) => x.id === cs.id); return c && c.next === 3 ? c : null; }, 15000);
  ok(cs2 && cs2.done.includes(2) && /Molly Pitcher/.test(cs2.note), 'he moved off the Turnpike: steps 1 and 2 done, next is calling road service');
  await pg.query(`UPDATE tg_cases SET step_since = now() - interval '45 minutes' WHERE id = $1`, [cs.id]);
  ok(await until(async () => (await pg.query(`SELECT 1 FROM notices WHERE text LIKE 'Hank Hired: Breakdown on the NJ Turnpike%Step 3 is waiting%'`)).rows.length >= 1, 15000), 'step 3 waits longer than 30 min: raised with the team');
  ok((await web('/api/cases/' + cs.id + '/step', { method: 'POST', body: { step: 3 } })).ok && (await web('/api/cases/' + cs.id + '/step', { method: 'POST', body: { step: 4 } })).ok, 'the dispatcher ticks steps 3 and 4 on the website');
  const cs3 = ((await web('/api/cases')).cases || []).find((x) => x.id === cs.id);
  ok(cs3.next === 5, 'next: tell Amazon about the delay');
  const n5 = tg.sent.length; const d4 = (await pg.query(`SELECT id FROM tg_drafts WHERE chat_id = $1 AND kind = 'case' AND state = 'open'`, [HCHAT.id])).rows[0];
  if (d4) await web('/api/cases/drafts/' + d4.id + '/skip', { method: 'POST' });
  ok((await web('/api/cases/' + cs.id + '/close', { method: 'POST', body: { note: 'Fixed at the service area', lesson: 'On the Turnpike, move the truck off before calling road service.', cost: 1200, placeId: njTow, rate: 'good' } })).ok, 'resolved, with what to do next time');
  const cst = await web('/api/cases/stats?days=30'); const k1 = cst.kinds.find((x) => /Turnpike/.test(x.label));
  ok(k1 && k1.cases === 1 && +k1.cost === 1200 && cst.places.some((x) => x.label === 'Turnpike Towing'), 'Times and costs: the case, its cost and the towing company');
  ok(((await web('/api/places')).places.find((p) => p.id === njTow) || {}).good === 1, 'the towing company gets a 👍');
  ok((await pg.query(`SELECT 1 FROM tg_knowledge WHERE question = 'Case: Breakdown on the NJ Turnpike or Garden State Parkway' AND review AND NOT active`)).rows.length === 1, 'the lesson waits in Knowledge to approve');
  ok(((await web('/api/cases?status=closed')).cases || []).some((x) => x.id === cs.id), 'listed under Closed, last 7 days');
  const pbs = (await web('/api/playbooks')).playbooks; const tp = pbs.find((x) => x.key === 'breakdown_toll_road');
  ok((await web('/api/playbooks/' + tp.id, { method: 'PUT', body: { title: tp.title, when: tp.when_text, steps: [...tp.steps, { text: 'Send the repair invoice to accounting', driver: '', wait: 0 }], rules: tp.rules } })).ok
    && (await web('/api/playbooks')).playbooks.find((x) => x.id === tp.id).steps.length === 7, 'an admin adds a step to the playbook');
  // shops and services from the group
  say(DAN, 'Use Mikes Diesel in Baltimore for the DPF, (410) 555-0199', HCHAT);
  const md = await until(async () => ((await web('/api/places')).places || []).find((p) => p.name === 'Mikes Diesel Repair'), 15000);
  ok(md && md.state === 'MD' && md.services.includes('DPF cleaning') && md.source === 'ai' && md.area === 'Baltimore area', 'a shop shared in the group goes to Shops & services: what they fix, where');
  say(HANK, 'Truck fixed at Mikes Diesel, $850, good job', HCHAT);
  const md2 = await until(async () => { const p = ((await web('/api/places')).places || []).find((x) => x.name === 'Mikes Diesel Repair'); return p && p.good === 1 ? p : null; }, 15000);
  ok(md2 && +md2.last_cost === 850 && md2.uses === 1 && (await web('/api/places')).places.filter((x) => x.name === 'Mikes Diesel Repair').length === 1, 'how it went and what it cost, on the same shop (no duplicate)');
  // the orientation day
  await pg.query(`INSERT INTO onboarding (driver_id, arrived_on) VALUES ($1, (now() AT TIME ZONE 'America/New_York')::date) ON CONFLICT (driver_id) DO UPDATE SET arrived_on = EXCLUDED.arrived_on`, [hank]);
  ok(((await web('/api/active/' + hank)).orientation || []).length === 8, 'he arrived: the orientation day list (8 steps)');
  say(HANK, 'ELD works, I am logged in', HCHAT);
  ok(await until(async () => ((await web('/api/active/' + hank)).orientation || []).some((x) => x.key === 'or_eld' && x.done && /AI/.test(x.done_by)), 15000), 'the bot ticks "ELD works" from the group');
  ok((await web('/api/orientation/' + hank + '/or_fuel', { method: 'POST', body: { done: true } })).orientation.some((x) => x.key === 'or_fuel' && x.done), 'the dispatcher ticks "Fuel card given"');
  // home time: going home, the question 2 days before he comes back, back on the road
  say(HANK, 'I am going home tomorrow, back in 2 days, need a ticket', HCHAT);
  const ht = await until(async () => ((await web('/api/hometime')).now || []).find((h) => h.driver_id === hank), 15000);
  ok(ht && ht.status === 'planned' && ht.back_on && ht.needs_ticket, 'home time: going home, back date, needs a ticket');
  ok(await until(async () => (await pg.query(`SELECT 1 FROM tg_drafts WHERE driver_id = $1 AND kind = 'remind' AND draft LIKE '%coming back on%'`, [hank])).rows.length === 1, 15000), '2 days before he comes back: the question for him waits on the website (Watch)');
  ok((await pg.query(`SELECT 1 FROM notices WHERE text LIKE 'Hank Hired comes back%book his ticket%'`)).rows.length >= 1, 'and the recruiter / dispatcher is told to confirm and book the ticket');
  say(HANK, 'I am back on the road now', HCHAT);
  ok(await until(async () => !((await web('/api/hometime')).now || []).some((h) => h.driver_id === hank), 15000), 'back on the road: off the home time list');
  // leaving signs
  say(HANK, 'Got an offer from another company, thinking about it', HCHAT);
  const rkd = await until(async () => { const x = ((await web('/api/active')).drivers || []).find((d) => d.id === hank); return x && x.risk && x.risk.level === 'high' ? x : null; }, 15000);
  ok(rkd && rkd.risk.reasons.some((r) => /another offer/.test(r)), 'May leave: another offer (high)');
  ok((await pg.query(`SELECT 1 FROM notices WHERE kind = 'leaving' AND text LIKE 'Hank Hired may leave%'`)).rows.length >= 1, 'his recruiter and the admins are told to call him');
  ok((await web('/api/active/' + hank + '/leaving-ok', { method: 'POST' })).ok && !(((await web('/api/active')).drivers.find((d) => d.id === hank) || {}).risk || { reasons: [] }).reasons.some((r) => /another offer/.test(r)), 'Talked to him: the signs are cleared');
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
  ok(dr.groups.groups >= 2 && dr.updates.ok === 1 && dr.updates.wrong === 1 && dr.updates.accuracy === 0.5 && dr.practices.waiting >= 1 && dr.promises.broken === 1 && !dr.ready, 'Dispatch autopilot: groups, 50% read right, 1 practice to approve, 1 promise broken, still learning');
  say(DAN, 'Ok Hank, let me know when you are rolling', HCHAT); say(DAN, 'Send me the ETA please', HCHAT);
  ok(await until(async () => ((await web('/api/tg/dispatch-readiness')).dispatchers.find((x) => x.name === 'Dan Dispatch') || {}).profile, 15000), 'Dan\'s dispatcher profile is written');
  const dd = (await web('/api/tg/dispatch-readiness')).dispatchers.find((x) => x.name === 'Dan Dispatch');
  ok(dd.profile.tone === 'friendly' && dd.profile.update_habits.length && dd.msgs30 >= 1, 'with tone, how he runs updates, messages');
  // a dispatcher the bot learned gets a website account (no login yet), the admins are told
  const danU = await until(async () => (await pg.query(`SELECT u.id, u.email, u.role, u.from_tg FROM tg_people p JOIN users u ON u.id = p.user_id WHERE p.tg_id = $1`, [DAN.id])).rows[0], 15000);
  ok(danU && danU.role === 'dispatcher' && /@no-login\.fleethire$/.test(danU.email) && +danU.from_tg === DAN.id, 'Dan gets a dispatcher account made by the bot, nobody can sign in with it yet');
  ok((await pg.query(`SELECT 1 FROM notices WHERE text LIKE 'Dan Dispatch writes as a dispatcher%'`)).rows.length >= 1, 'the admins are told to give him a login');
  ok((await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: danU.email, password: 'whatever-123' }) })).status !== 200, 'no sign in with the made-up email');
  const tdp = (await web('/api/team/dispatchers?period=7d')).people.find((x) => x.id === danU.id);
  ok(tdp && tdp.msgs >= 2 && tdp.noLogin && tdp.review && tdp.review.goal, 'Team → Dispatchers: Dan with his messages, no login yet, his review');
  // his work review
  const rv = await web('/api/tg/dispatchers/u' + danU.id);
  ok(rv.profile && rv.profile.feedback.goal && rv.profile.scores.length === 2 && rv.stats.msgs >= 2 && rv.user.noLogin && rv.history.length === 1, 'work review: scores, feedback to give, his numbers, linked account');
  say(DAN, 'Hank, call me when you are empty', HCHAT);
  await until(async () => +(await pg.query(`SELECT count(*) n FROM tg_messages WHERE from_id = $1 AND text IS NOT NULL`, [DAN.id])).rows[0].n >= 3, 15000);
  const rvn = await web('/api/tg/dispatchers/' + DAN.id + '/review', { method: 'POST' }); ok(rvn.ok, 'Review again now ' + (rvn.ok ? '' : JSON.stringify(rvn)));
  const rv2 = await web('/api/tg/dispatchers/' + DAN.id);
  ok(rv2.history.length === 2 && rv2.profile.trend.direction === 'better', 'two reviews: the trend shows');
  ok(await until(async () => (await pg.query(`SELECT 1 FROM notices WHERE text LIKE 'Dispatcher Dan Dispatch: Told a driver%'`)).rows.length === 1), 'a red flag: the admins are told (once)');
  // the admin gives him a login; he sees his own coaching with the goal
  ok((await web('/api/users/' + danU.id, { method: 'PATCH', body: { email: 'dan@example.com', password: 'dan-pass-12345' } })).ok, 'the admin gives Dan an email and password');
  const dnl = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dan@example.com', password: 'dan-pass-12345' }) });
  const dco = dnl.status === 200 ? await web('/api/me/coaching', { cookie: dnl.headers.get('set-cookie').split(';')[0] }) : {};
  ok(dco.coaching && dco.coaching.goal === 'ETA asked at every pickup' && dco.coaching.improve.length && /ETA as soon as/.test(dco.coaching.tip), 'Dan signs in and sees his own coaching, goal and this week\'s tip');
  ok((await web('/api/tg/dispatchers/' + DAN.id, { cookie: dnl.headers.get('set-cookie').split(';')[0] })).status === 403, 'but not the admin review');
  // someone with an account already: linked by name, no second account
  await pg.query(`INSERT INTO tg_people (tg_id, name, role) VALUES (64, 'Dee Dispatch', 'dispatch') ON CONFLICT (tg_id) DO UPDATE SET role = 'dispatch', user_id = NULL`);
  ok(await until(async () => +((await pg.query(`SELECT user_id FROM tg_people WHERE tg_id = 64`)).rows[0] || {}).user_id === disp.id, 15000) && (await pg.query(`SELECT 1 FROM users WHERE from_tg = 64`)).rows.length === 0, 'Dee writes as a dispatcher: linked to her account, none made');
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
  ok(gp.chat.working && gp.chat.members === 14 && gp.chat.mode === 'watch' && gp.chat.learning.msgs >= 3 && gp.chat.learning.dispatchers === 1 && gp.chat.learning.updates >= 2 && gp.chat.learning.lessons >= 1 && gp.updates.length >= 2, 'the group page: working group, 14 people, 3 messages read, 1 dispatcher, 2 load updates, 1 practice');
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
  await pg.query(`UPDATE drivers SET amazon_step = 'verified', mode = 'Owner-operators', truck_year = 2021, truck_model = 'Freightliner Cascadia' WHERE id = $1`, [paul]);
  const cara = (await web('/api/drivers', { method: 'POST', body: { name: 'Cara Company', source: 'Indeed' } })).id;
  await web('/api/drivers/' + cara, { method: 'PATCH', body: { status: 'Onboarding' } });
  await pg.query(`UPDATE drivers SET amazon_step = 'verified', mode = 'Company drivers' WHERE id = $1`, [cara]);
  await pg.query(`UPDATE drivers SET amazon_step = 'accurate', amazon_log = jsonb_build_object('accurate', (now() - interval '6 hours')::text), owner_id = $2 WHERE id = $1`, [cody, rita]);
  await pg.query(`UPDATE tg_people SET user_id = $1 WHERE tg_id = 11`, [rita]); // Rita's Telegram is Rita on the website
  n = tg.sent.length; priv(RITA, '/onboard');
  const ob = await until(() => sentSince(n).find((m) => String(m.chat_id) === String(RITA.id) && /Onboarding: \d+<\/b>/.test(m.text)), 20000);
  ok(ob && /<b>Amazon verified<\/b> \(2\)\nCD \(1\)\nCara Company — no start date\nOO \(1\)\nPaul Penn — Nov \d+\n/.test(ob.text), 'plain: Amazon verified → CD, OO; name and start date');
  ok(ob && /<b>Amazon pending<\/b> \(2\)/.test(ob.text) && /Cody Coming — no start date/.test(ob.text) && !/[🟢🟡🔴✈️🗓📝💬]|Rita|Background check/.test(ob.text), 'Amazon pending too; no icons, scores, recruiters or stats');
  const MCHAT = { id: -100740, type: 'supergroup', title: 'Management Team' };
  n = tg.sent.length; added(MCHAT, RITA);
  ok(await until(async () => ((await pg.query(`SELECT kind FROM tg_chats WHERE chat_id = $1`, [MCHAT.id])).rows[0] || {}).kind === 'management'), '"Management Team" added by Rita: our team\'s group');
  await sleep(500);
  ok(!inChat(n, MCHAT).length, 'silent when connected');
  n = tg.sent.length; say(RITA, '/onboard', MCHAT);
  ok(await until(() => inChat(n, MCHAT).some((m) => /Onboarding: \d+<\/b>/.test(m.text))), '/onboard in the management group: posted there');
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
  // ---------- /oil ----------
  await pg.query(`UPDATE trucks SET odometer = 412500 WHERE unit = '140'`);
  await pg.query(`INSERT INTO truck_events (truck_id, kind, title, status, odometer, at, fixed_at, done_on) SELECT id, 'oil_change', 'Oil change', 'fixed', 386000, now() - interval '40 days', now() - interval '40 days', (now() - interval '40 days')::date FROM trucks WHERE unit = '140'`);
  await pg.query(`UPDATE trucks SET odometer = 120400 WHERE unit = 'T7'`);
  await pg.query(`INSERT INTO truck_events (truck_id, kind, title, status, odometer, at, fixed_at, done_on) SELECT id, 'oil_change', 'Oil change', 'fixed', 110000, now() - interval '10 days', now() - interval '10 days', (now() - interval '10 days')::date FROM trucks WHERE unit = 'T7'`);
  n = tg.sent.length; priv(RITA, '/oil');
  const oil = await until(() => sentSince(n).find((m) => String(m.chat_id) === String(RITA.id) && /Oil changes: \d+ trucks/.test(m.text)));
  ok(oil && /<b>Overdue<\/b> \(1\)\n140 — Walt Worker — now 412,500 mi — done at 386,000 mi on \w+ \d+ — due at 411,000 mi \(1,500 over\)/.test(oil.text), '/oil: overdue first: truck, driver, miles now, done at, due at (miles over)');
  ok(oil && /T7 — no driver — now 120,400 mi — done at 110,000 mi on \w+ \d+ — due at 135,000 mi \(14,600 left\), by \w+ \d+/.test(oil.text) && /<b>No oil change on record<\/b>/.test(oil.text), 'OK trucks with miles left and the date; trucks with no oil change on record');
  n = tg.sent.length; priv(X, '/oil');
  ok(await until(() => sentSince(n).some((m) => m.chat_id === X.id && /Only our team/.test(m.text))), 'not for people outside the team');

  // ---------- the chance to make it: how the driver responds ----------
  await pg.query(`UPDATE tg_messages SET at = at - interval '3 days' WHERE chat_id = $1`, [PCHAT.id]);
  say(RITA, 'Paul, are you there?', PCHAT); await sleep(300); say(RITA, 'Paul, please call me back', PCHAT);
  for (let i = 0; i < 3; i++) await pg.query(`INSERT INTO notes (driver_id, user_id, body, kind, outcome) VALUES ($1, $2, 'called', 'call', 'No answer')`, [cody, rita]);
  const lr = await until(async () => { const r = (await web('/api/drivers/' + paul)).reach; return r && r.unanswered >= 2 ? r : null; });
  ok(lr && lr.silentDays === 3 && lr.unanswered === 2 && lr.level !== 'likely' && lr.reasons.some((x) => /silent 3 days, 2 messages unanswered/.test(x.text)), 'Paul silent 3 days, 2 of our messages unanswered: his chance drops, with the reasons');
  const cr = (await web('/api/drivers/' + cody)).reach;
  ok(cr && cr.calls.noAnswer === 3 && cr.reasons.some((x) => /not reachable by phone/.test(x.text)), 'Cody: 3 calls not answered this week');
  const obl = await web('/api/onboarding');
  ok(obl.drivers.every((d) => d.reach && typeof d.reach.score === 'number'), 'the onboarding page shows each driver\'s chance');
  ok(await until(() => inChat(0, MCHAT).some((m) => /🔔 @rita_r: Paul Penn has been silent 3 days \([12] of our messages unanswered\): please give a call/.test(m.text)), 15000), 'management group: the silence countdown tags Rita');
  await sleep(2500); ok(inChat(0, MCHAT).filter((m) => /Paul Penn has been silent/.test(m.text)).length === 1, 'once for this silence');
  n = tg.sent.length; priv(RITA, '/onboard');
  const ob2 = await until(() => sentSince(n).find((m) => String(m.chat_id) === String(RITA.id) && /Onboarding: \d+<\/b>/.test(m.text)), 20000);
  ok(ob2 && /Paul Penn — Nov \d+/.test(ob2.text) && !/🔇/.test(ob2.text), '/onboard stays plain (the chance and the silence are on the website and in the follow-ups)');

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
  // ---------- papers: uploaded on the website, shared in the ELD group with /info ----------
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');
  const up1 = await web('/api/docs', { method: 'POST', body: { driverId: ella, kind: 'cdl', name: 'ella-cdl.png', mime: 'image/png', data: png } });
  ok(up1.doc && up1.doc.kind === 'cdl', 'CDL uploaded on the website');
  ok((await web('/api/docs', { method: 'POST', body: { driverId: ella, kind: 'cdl', name: 'x.exe', mime: 'application/x-msdownload', data: png } })).status === 400, 'only photos and PDFs');
  const tE = (await pg.query(`INSERT INTO trucks (unit, details, vin, plate) VALUES ('E22', '2022 Volvo VNL', '4V4NC9EH1NN000001', 'PA 12345') RETURNING id`)).rows[0].id;
  await pg.query(`UPDATE trucks SET driver_id = $1 WHERE id = $2`, [ella, tE]);
  await pg.query(`UPDATE drivers SET phones = ARRAY['2155550999'], emails = ARRAY['ella@example.com'] WHERE id = $1`, [ella]);
  const pdf = Buffer.from('%PDF-1.4 test registration').toString('base64');
  ok((await web('/api/docs', { method: 'POST', body: { truckId: tE, kind: 'registration', name: 'e22-registration.pdf', mime: 'application/pdf', data: pdf } })).doc, 'truck registration uploaded');
  const fl = await fetch(BASE + '/api/docs/' + up1.doc.id + '/file', { headers: { Cookie: cookie } });
  ok(fl.ok && fl.headers.get('content-type') === 'image/png', 'the file opens on the website');
  n = tg.sent.length; const f0 = (tg.files_sent || []).length;
  say(PAUL, '/info', E1); await sleep(700);
  ok(!sentSince(n).length && (tg.files_sent || []).length === f0, 'someone not on the team types /info: nothing');
  say(RITA, '/info', E1);
  const info = await until(() => sentSince(n).find((m) => String(m.chat_id) === String(E1.id) && /🪪 <b>Ella Evans<\/b>/.test(m.text)));
  ok(info && /📞 \(215\) 555-0999/.test(info.text) && /✉️ ella@example.com/.test(info.text) && /🚛 E22 · 2022 Volvo VNL · VIN 4V4NC9EH1NN000001 · plate PA 12345/.test(info.text), '/info in the ELD group: name, phone, email, the truck');
  const fs2 = await until(() => { const f = (tg.files_sent || []).slice(f0); return f.length >= 2 ? f : null; });
  ok(fs2 && fs2.some((f) => f.method === 'sendPhoto' && /CDL/.test(f.caption) && String(f.chat_id) === String(E1.id)) && fs2.some((f) => f.method === 'sendDocument' && /Truck registration · truck E22/.test(f.caption)), 'and the CDL photo and the truck registration PDF');
  ok((await web('/api/tg/log?chat=' + E1.id)).log.some((x) => /\/info: driver info and 2 papers shared/.test(x.text)), 'in the bot history');
  // nothing automatic in a new ELD group
  const nd = (await web('/api/drivers', { method: 'POST', body: { name: 'Nate Newdriver', source: 'Indeed', phone: '2155551234' } })).id;
  await web('/api/drivers/' + nd, { method: 'PATCH', body: { status: 'Onboarding' } });
  const NE = { id: -100736, type: 'supergroup', title: 'Nate Newdriver ELD 215 555 1234' };
  n = tg.sent.length; added(NE, RITA);
  ok(await until(async () => ((await pg.query(`SELECT kind, mode FROM tg_chats WHERE chat_id = $1`, [NE.id])).rows[0] || {}).kind === 'eld'), 'a new driver\'s ELD group connects');
  await sleep(800); ok(!inChat(n, NE).length, 'and stays silent: no automatic info or questions');

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

  // ---------- a group linked as the wrong type, and fixed ----------
  const zed = (await web('/api/drivers', { method: 'POST', body: { name: 'Zed Zulu', source: 'Indeed', phone: '6105550999', ownerId: rita } })).id;
  await web('/api/drivers/' + zed, { method: 'PATCH', body: { status: 'Onboarding' } });
  const ZD = { id: -100801, type: 'supergroup', title: 'Zed Zulu 610 555 0999' }, ZE = { id: -100802, type: 'supergroup', title: 'Zed Zulu ELD 610 555 0999' };
  added(ZD, RITA); added(ZE, RITA);
  await until(async () => (await pg.query(`SELECT count(*)::int n FROM tg_chats WHERE chat_id IN ($1, $2) AND driver_id = $3`, [ZD.id, ZE.id, zed])).rows[0].n === 2, 15000);
  ok((await web(`/api/tg/chats/${ZE.id}/link`, { method: 'PATCH', body: { kind: 'dispatch', driverId: zed } })).ok, 'the mistake: the ELD group is set as Dispatch');
  const zm = Object.fromEntries((await pg.query(`SELECT chat_id::text id, kind FROM tg_chats WHERE chat_id IN ($1, $2)`, [ZD.id, ZE.id])).rows.map((x) => [x.id, x.kind]));
  ok(zm[ZE.id] === 'dispatch' && zm[ZD.id] === null && (await pg.query(`SELECT 1 FROM tg_log WHERE chat_id = $1 AND text LIKE '%was Zed Zulu''s Dispatch group: it is unlinked now%'`, [ZD.id])).rows.length === 1, 'the real Dispatch group is pushed out, and the bot history says so');
  const fx = await web(`/api/tg/chats/${ZE.id}/link`, { method: 'PATCH', body: { kind: 'eld', driverId: zed } });
  const zm2 = Object.fromEntries((await pg.query(`SELECT chat_id::text id, kind, driver_id FROM tg_chats WHERE chat_id IN ($1, $2)`, [ZD.id, ZE.id])).rows.map((x) => [x.id, x]));
  ok(fx.ok && fx.restored.length === 1 && zm2[ZE.id].kind === 'eld' && zm2[ZD.id].kind === 'dispatch' && zm2[ZD.id].driver_id === zed, 'fixed on the group page: ELD again, and the real Dispatch group is back');
  ok(+((await pg.query(`SELECT chat_id FROM onb_cases WHERE driver_id = $1`, [zed])).rows[0] || {}).chat_id === ZD.id, 'the onboarding conversation is in the right group');

  // ---------- the shift desk: one to one with the dispatcher on shift ----------
  ok((await web('/api/tg/desk', { method: 'PUT', body: { on: true, where: 'private', answerMin: 15, shifts: [{ name: 'All day', start: '00:00', end: '23:59', people: [danU.id] }] } })).ok, 'a shift with Dan on it');
  push({ message: { message_id: mid++, from: DAN, chat: { id: DAN.id, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/start' } }); await sleep(1500);
  let dn = tg.sent.length; say(HANK, 'Going to sleep, I will wake up at 10:30', HCHAT);
  const q1 = await until(() => sentSince(dn).find((m) => String(m.chat_id) === String(DAN.id) && /will be up at/.test(m.text)), 15000);
  ok(q1 && /10:30/.test(q1.text) && /No calls until then/.test(q1.text) && !inChat(dn, HCHAT).some((m) => /will be up at/.test(m.text)), 'the driver will wake up at 10:30: the bot asks Dan privately, nothing in the group');
  const cid = /desk:(\d+):ok/.exec(JSON.stringify(q1.reply_markup))[1];
  tap(DAN, `desk:${cid}:ok`, { id: DAN.id, type: 'private' }, q1.message_id);
  ok(await until(async () => ((await pg.query(`SELECT state, answered_by FROM tg_checks WHERE id = $1`, [cid])).rows[0] || {}).answered_by === 'Dan Dispatch'), 'Dan taps Got it');
  dn = tg.sent.length; await pg.query(`UPDATE tg_checks SET until_at = now() - interval '1 minute' WHERE id = $1`, [cid]);
  ok(await until(() => sentSince(dn).some((m) => String(m.chat_id) === String(DAN.id) && /should be up now/.test(m.text)), 15000), 'at 10:30 the bot checks back: he should be up now');
  dn = tg.sent.length; say(HANK, 'Delivered. I am empty in Harrisburg', HCHAT);
  const q2 = await until(() => sentSince(dn).find((m) => String(m.chat_id) === String(DAN.id) && /needs a load/.test(m.text)), 15000);
  ok(q2 && /best option you see now, and why it is good or not/.test(q2.text), 'he is empty: Dan is asked for a load, or the best option he sees and why');
  push({ message: { message_id: mid++, from: DAN, chat: { id: DAN.id, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'Harrisburg to Newark tomorrow 6 AM, $2,100 for 170 miles: good rate, close to home', reply_to_message: { message_id: q2.message_id } } });
  ok(await until(async () => /Harrisburg to Newark/.test(((await pg.query(`SELECT answer FROM tg_checks WHERE driver_id = $1 AND kind = 'needs_load' ORDER BY id DESC LIMIT 1`, [hank])).rows[0] || {}).answer || '')), 'his load option and why is saved');
  const dk = await web('/api/tg/desk');
  ok(dk.now === 'All day' && dk.checks.some((c) => c.kind === 'needs_load' && c.answered_by === 'Dan Dispatch') && dk.speed.some((x) => x.name === 'Dan Dispatch' && x.answered >= 2), 'Shift desk: on shift now, what was asked and answered, how fast');

  // a Telegram group for the shift: the bot asks there, tagging the dispatcher
  const SG = { id: -100901, type: 'supergroup', title: 'Dispatch day shift' }; added(SG, RITA); await sleep(1500);
  say(RITA, 'register shift All day', SG);
  ok(await until(async () => ((await pg.query(`SELECT kind FROM tg_chats WHERE chat_id = $1`, [SG.id])).rows[0] || {}).kind === 'shift', 15000) && String((await web('/api/tg/desk')).desk.shifts[0].chatId) === String(SG.id), '"register shift All day" in a group: it is that shift\'s group');
  ok((await web('/api/tg/desk', { method: 'PUT', body: { where: 'shift', answerMin: 15, shifts: (await web('/api/tg/desk')).desk.shifts } })).ok, 'ask in the shift\'s group');
  await pg.query(`UPDATE tg_checks SET state = 'done' WHERE driver_id = $1`, [hank]);
  dn = tg.sent.length; say(HANK, 'Delivered again. I am empty in Harrisburg', HCHAT);
  const q3 = await until(() => sentSince(dn).find((m) => String(m.chat_id) === String(SG.id) && /needs a load/.test(m.text)), 15000);
  ok(q3 && !sentSince(dn).some((m) => String(m.chat_id) === String(DAN.id) && /needs a load/.test(m.text)), 'the question goes to the shift group (tagging Dan), not privately');
  push({ message: { message_id: mid++, from: DAN, chat: SG, date: Math.floor(Date.now() / 1000), text: 'Booked Harrisburg to Baltimore, $1,400, leaves 4 PM', reply_to_message: { message_id: q3.message_id, from: { id: 999, is_bot: true } } } });
  ok(await until(async () => /Harrisburg to Baltimore/.test(((await pg.query(`SELECT answer FROM tg_checks WHERE driver_id = $1 AND kind = 'needs_load' ORDER BY id DESC LIMIT 1`, [hank])).rows[0] || {}).answer || '')), 'Dan replies in the shift group: saved');
  await web('/api/tg/desk', { method: 'PUT', body: { where: 'private', answerMin: 15, shifts: (await web('/api/tg/desk')).desk.shifts } });

  // ---------- the contract and the Clearinghouse ----------
  ok((await pg.query(`SELECT count(*)::int n FROM checklist WHERE driver_id = $1 AND key IN ('contract_sent', 'contract_signed', 'ch_registered', 'ch_query', 'ch_consent')`, [zed])).rows[0].n === 5, 'onboarding has the contract and Clearinghouse steps');
  await pg.query(`UPDATE onb_cases SET started_at = now() - interval '2 hours' WHERE driver_id = $1`, [zed]);
  ok(await until(async () => (await pg.query(`SELECT 1 FROM tg_drafts WHERE driver_id = $1 AND kind = 'remind' AND draft LIKE '%clearinghouse.fmcsa.dot.gov/register%'`, [zed])).rows.length === 1, 15000), 'Watch: how to register in the Clearinghouse waits on the website for the driver');
  await pg.query(`UPDATE checklist SET done = true, done_at = now() - interval '25 hours' WHERE driver_id = $1 AND key = 'contract_sent'`, [zed]);
  ok(await until(async () => (await pg.query(`SELECT 1 FROM tg_drafts WHERE driver_id = $1 AND kind = 'remind' AND draft LIKE '%contract from our safety team%'`, [zed])).rows.length === 1, 15000), 'the contract was sent a day ago, not signed: a reminder for him');
  ok((await web('/api/tg/drafts?driverId=' + zed)).drafts.some((x) => x.kind === 'remind'), 'shown on his lead page as Reply ready to send');

  // ---------- All groups: every group, connected or not, changed in the row ----------
  const RC = { id: -100803, type: 'supergroup', title: 'Random chat' }; added(RC, RITA);
  const agN = await until(async () => ((await web('/api/tg/all-groups')).groups || []).find((g) => g.chat_id === String(RC.id) && !g.kind), 15000);
  const agZ = (await web('/api/tg/all-groups')).groups.find((g) => g.chat_id === String(ZE.id));
  ok(agN && agN.active && agN.guess && agZ && agZ.kind === 'eld' && agZ.driver === 'Zed Zulu', 'All groups: the new group is listed as not connected, the others with their type and driver');
  ok((await web(`/api/tg/chats/${RC.id}/link`, { method: 'PATCH', body: { kind: 'management' } })).ok && (await pg.query(`SELECT kind FROM tg_chats WHERE chat_id = $1`, [RC.id])).rows[0].kind === 'management'
    && !(await pg.query(`SELECT 1 FROM tg_waiting WHERE chat_id = $1 AND done_at IS NULL`, [RC.id])).rows.length, 'connected right there as a management group (no longer waiting)');
  ok((await web(`/api/tg/chats/${RC.id}/link`, { method: 'PATCH', body: { kind: 'none' } })).ok && (await pg.query(`SELECT kind FROM tg_chats WHERE chat_id = $1`, [RC.id])).rows[0].kind === null, 'and disconnected');

  // ---------- dropping out ----------
  const dora = (await web('/api/drivers', { method: 'POST', body: { name: 'Dora Drop', source: 'Indeed', phone: '6105550777', ownerId: rita } })).id;
  await web('/api/drivers/' + dora, { method: 'PATCH', body: { status: 'Onboarding' } });
  const DCH = { id: -100750, type: 'supergroup', title: 'Dora Drop 610 555 0777' };
  added(DCH, RITA);
  await until(async () => (await pg.query(`SELECT 1 FROM onb_cases WHERE driver_id = $1`, [dora])).rows[0]);
  const DORA = { id: 77, is_bot: false, first_name: 'Dora', last_name: 'Drop' };
  say(DORA, 'Sorry guys, I will not be able to come, found a local job', DCH);
  ok(await until(async () => ((await pg.query(`SELECT drop_flag FROM onb_cases WHERE driver_id = $1`, [dora])).rows[0] || {}).drop_flag, 15000), 'the driver writes he is not coming: flagged (the status is not changed)');
  ok((await pg.query(`SELECT status FROM drivers WHERE id = $1`, [dora])).rows[0].status === 'Onboarding', 'still in onboarding until the team confirms');
  ok((await pg.query(`SELECT 1 FROM notices WHERE user_id = $1 AND text LIKE 'Dora Drop says he is not coming%'`, [rita])).rows.length === 1, 'Rita is told');
  let dz = await web('/api/dropouts');
  ok(dz.dropping.some((x) => x.id === dora && /local job/.test(x.quote) && x.reason === 'Found another job'), 'the dashboard: "says he is not coming", to confirm');
  ok((await web('/api/onboarding')).drivers.find((x) => x.id === dora).drop && (await web('/api/drivers/' + dora)).reach.score <= 5, 'the onboarding page flags the row; the chance drops to almost 0');
  ok((await web(`/api/drivers/${dora}/drop-dismiss`, { method: 'POST' })).ok && !(await web('/api/dropouts')).dropping.some((x) => x.id === dora), 'Still with us: the flag is set aside');
  ok((await web('/api/drivers/' + dora, { method: 'PATCH', body: { status: 'Rejected' } })).status === 400, 'Dropped out needs a reason');
  ok((await web('/api/drivers/' + dora, { method: 'PATCH', body: { status: 'Rejected', lostReason: 'Found another job', lostNote: 'local job' } })).status === 200, 'Dropped out: Rejected with the reason');
  dz = await web('/api/dropouts');
  ok(dz.dropped.some((x) => x.id === dora && x.reason === 'Found another job' && x.note === 'local job') && !(await web('/api/onboarding')).drivers.some((x) => x.id === dora), 'the dashboard: dropped out this week, with why; off the onboarding list');

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
