// The bot grades itself: when a recruiter answers a driver while the bot's draft waits, the AI compares the draft with
// what the recruiter really wrote. The score and the misses are on Telegram → Knowledge (readiness).
//   bash test/all.sh self-grade
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const bot = require('../src/tg/bot');
const ai = require('../src/tg/ai');
const onboard = require('../src/tg/onboard');
const q = db.q;
(async () => {
  bot.send = async () => ({ message_id: 1 }); bot.log = async () => {};
  const asked = [];
  ai.on = () => true;
  ai.gradeDraft = async (x) => { asked.push(x);
    if (/Friday/.test(x.teamText) && /Friday/.test(x.draft)) return { verdict: 'same', note: 'Both say pay is on Friday.' };
    if (/Friday/.test(x.teamText)) return { verdict: 'wrong', note: 'The draft said Monday; pay is on Friday.' };
    if (/bring/.test(x.teamText)) return { verdict: 'partly', note: 'The draft left out the medical card.' };
    return { verdict: 'unrelated', note: 'Not an answer to the driver.' }; };
  const r0 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }) });
  const cookie = (r0.headers.get('set-cookie') || '').split(';')[0];
  const ready = async () => (await fetch(BASE + '/api/tg/readiness', { headers: { cookie } })).json();
  const before = (await ready()).self;
  ok(before && before.total === 0 && before.accuracy === null && before.canTry === false, 'nothing graded yet: not measured');

  const did = (await q("INSERT INTO drivers (name, name_key, status) VALUES ('Greg Graded', 'greg graded', 'Onboarding') RETURNING id")).rows[0].id;
  const CHAT = -660500; const chat = { chat_id: CHAT, kind: 'dispatch', driver_id: did };
  await q("INSERT INTO tg_chats (chat_id, title, kind, driver_id, active) VALUES ($1, 'Greg', 'dispatch', $2, true)", [CHAT, did]);
  const STAFF = { tg_id: 1, name: 'Rita', user_id: 1 };
  const draft = async (kind, driverText, text) => (await q(`INSERT INTO tg_drafts (chat_id, driver_id, driver_text, draft, kind) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [CHAT, did, driverText, text, kind])).rows[0].id;
  const say = (text) => onboard.learnFrom(chat, { message_id: 9 }, STAFF, text);
  const row = async (id) => (await q('SELECT state, grade, grade_note, team_text FROM tg_drafts WHERE id = $1', [id])).rows[0];

  let id = await draft('answer', 'When do I get paid?', 'You are paid every Friday.');
  await say('Hey Greg, pay comes every Friday by direct deposit');
  let d = await row(id);
  ok(d.state === 'answered' && d.grade === 'same' && /Friday by direct deposit/.test(d.team_text), 'the recruiter said the same: graded "same", their words kept');
  ok(asked[0].driverText === 'When do I get paid?' && asked[0].draft === 'You are paid every Friday.', 'the AI got the driver message, the draft and the real answer');

  id = await draft('answer', 'When do I get paid?', 'You are paid every Monday.');
  await say('Pay is every Friday');
  d = await row(id); ok(d.grade === 'wrong' && /Monday/.test(d.grade_note), 'a different fact: graded "wrong", with why');

  id = await draft('reply', 'What do I bring?', 'Bring your CDL.');
  await say('Please bring your CDL and medical card');
  ok((await row(id)).grade === 'partly', 'something missing: graded "partly"');

  id = await draft('answer', 'Is the truck automatic?', 'Yes, all automatic.');
  await say('Dan, can you call him?');
  ok((await row(id)).grade === 'unrelated', 'the recruiter wrote about something else: "unrelated", not counted');

  id = await draft('remind', 'Reminder: contract', 'Greg, did you get the contract?');
  const n = asked.length; await say('I will send it again');
  ok((await row(id)).grade === null && asked.length === n, 'the bot\'s own reminders are not graded');

  id = await draft('answer', 'Where is the yard?', 'The yard is in Edison, NJ.');
  await onboard.grade((await q('SELECT * FROM tg_drafts WHERE id = $1', [id])).rows[0], 'The yard is in Edison, NJ.');
  ok((await row(id)).grade === 'same' && asked.length === n, 'a draft sent as written is right, with no AI call');

  const s = (await ready()).self;
  ok(s.same === 2 && s.partly === 1 && s.wrong === 1 && s.total === 4, 'readiness counts same, partly and wrong: ' + JSON.stringify([s.same, s.partly, s.wrong, s.total]));
  ok(Math.abs(s.accuracy - 0.625) < 0.001 && s.canTry === false, 'the score: same counts 1, partly a half (62.5%); not enough yet to try');
  ok(s.misses.length === 2 && s.misses[0].name === 'Greg Graded' && s.misses.some((m) => m.grade === 'wrong' && /Monday/.test(m.note) && /Friday/.test(m.team)), 'the misses are listed for the admins, with the draft and what the team wrote');
  for (let i = 0; i < 20; i++) await q(`INSERT INTO tg_drafts (chat_id, driver_id, driver_text, draft, kind, state, grade, graded_at) VALUES ($1, $2, 'q', 'a', 'answer', 'answered', 'same', now())`, [CHAT, did]);
  ok((await ready()).self.canTry === true, 'at 80% over 20 or more drafts: worth trying "Answer questions"');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
