// How the bot teaches itself: topics it has proven (and answers alone when allowed), which wording drivers answer,
// drivers slipping against our own history, when a driver is usually around, how the team answers, and the weekly review.
//   bash test/all.sh learn
process.env.TG_NO_QUIET = '1';
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const bot = require('../src/tg/bot');
const ai = require('../src/tg/ai');
const learn = require('../src/tg/learn');
const onboard = require('../src/tg/onboard');
const J = require('../src/tg/journey');
const q = db.q;
(async () => {
  const SENT = []; bot.send = async (chat, text, o = {}) => { SENT.push({ chat: String(chat), text, buttons: o.buttons }); return { message_id: 500 + SENT.length }; };
  bot.log = async () => {}; bot.call = async () => ({}); bot.dropButtons = async () => {}; bot.state.me = bot.state.me || { id: 1, username: 'testbot' };
  ai.on = () => true;
  const r0 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }) });
  const cookie = (r0.headers.get('set-cookie') || '').split(';')[0];
  const web = async (p, body, method) => { const x = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) }); return { status: x.status, ...(await x.json().catch(() => ({}))) }; };
  const hoursAgo = (h) => new Date(Date.now() - h * 36e5);
  const did = (await q("INSERT INTO drivers (name, name_key, status, amazon_step, amazon_log) VALUES ('Lenny Learn', 'lenny learn', 'Onboarding', 'profile', $1) RETURNING id", [JSON.stringify({ profile: hoursAgo(80) })])).rows[0].id;
  const CHAT = -550001; const chat = { chat_id: CHAT, kind: 'dispatch', driver_id: did };
  await q("INSERT INTO tg_chats (chat_id, title, kind, driver_id, active, bot_admin, linked_at) VALUES ($1, 'Lenny', 'dispatch', $2, true, true, now() - interval '5 days')", [CHAT, did]);
  await q("INSERT INTO onboarding (driver_id, started_at) VALUES ($1, now() - interval '5 days')", [did]);
  await q("INSERT INTO onb_cases (driver_id, chat_id, mode) VALUES ($1, $2, 'watch')", [did, CHAT]);
  await q("INSERT INTO tg_people (tg_id, name, role, driver_id) VALUES (551001, 'Lenny', 'driver', $1)", [did]);
  const graded = async (topic, grade, n, minsAgo = 60) => { for (let i = 0; i < n; i++) await q(`INSERT INTO tg_drafts (chat_id, driver_id, driver_text, draft, kind, state, topic, grade, graded_at) VALUES ($1, $2, 'q', 'a', 'answer', 'answered', $3, $4, now() - ($5 || ' minutes')::interval)`, [CHAT, did, topic, grade, String(minsAgo + i)]); };

  // ---- 1. skills ----
  await graded('hiring', 'same', 11); await graded('hiring', 'partly', 1, 200);
  await graded('equipment', 'same', 9, 300); await graded('equipment', 'wrong', 1, 5); // a miss just now
  await graded('pay', 'same', 12); await graded('hometime', 'same', 4);
  const sk = Object.fromEntries((await learn.skills()).map((s) => [s.topic, s]));
  ok(sk.hiring.proven && Math.round(sk.hiring.accuracy * 100) === 96, 'a topic is proven at 85% over 10 or more graded drafts: hiring ' + Math.round(sk.hiring.accuracy * 100) + '%');
  ok(!sk.equipment.proven && sk.equipment.slipping, 'a miss among the last 5 takes the topic back to drafts');
  ok(!sk.pay.proven && sk.pay.humanOnly, 'pay always goes to a person, whatever the score');
  ok(!sk.hometime.proven, 'too few drafts: still learning');
  ok(!(await learn.mayAnswerAlone('hiring', 0.9)), 'answering alone is off until an admin turns it on');
  ok((await web('/api/tg/autopilot', { skillAuto: true }, 'PUT')).status === 200, 'an admin turns it on');
  db.settings.tg = { ...(db.settings.tg || {}), skillAuto: true };
  ok(await learn.mayAnswerAlone('hiring', 0.9) && !(await learn.mayAnswerAlone('hiring', 0.1)), 'on: a proven topic is answered alone, and one in five still goes to the team');
  ok(!(await learn.mayAnswerAlone('pay', 0.9)) && !(await learn.mayAnswerAlone('equipment', 0.9)), 'never pay, never a topic that slipped');

  // the bot answers a proven topic by itself in a Watch group, and drafts the rest
  const rnd = Math.random; Math.random = () => 0.9;
  ai.driverReply = async ({ text }) => ({ is_question: true, confident: true, answer: /bring/.test(text) ? 'Bring your CDL and medical card.' : 'Pay is every Friday.', progress: 'none', mood: 'good', topic: /bring/.test(text) ? 'hiring' : 'pay', needs_reply: true, reply: 'x' });
  const c = (await onboard.caseOf(did).catch(() => null)) || { driver_id: did, chat_id: CHAT, name: 'Lenny Learn', mode: 'Company drivers', bot_mode: 'watch' }; const opts = { context: 'x', mode: 'watch', escalate: async () => '@rita', kinds: ['general'] };
  await onboard.qa(c, chat, { message_id: 71, chat: { id: CHAT } }, { tg_id: 551001, name: 'Lenny', role: 'driver' }, 'What do I bring on day one?', opts);
  const auto = (await q(`SELECT state, auto, sent_by, topic FROM tg_drafts WHERE chat_id = $1 AND msg_id = 71`, [CHAT])).rows[0];
  ok(SENT.some((s) => s.chat === String(CHAT) && /Bring your CDL and medical card/.test(s.text)) && auto && auto.auto && auto.sent_by === 'Bot', 'Watch group, proven topic: the bot answers the driver itself');
  ok((await q(`SELECT 1 FROM bot_outcomes WHERE driver_id = $1 AND kind = 'reply:hiring'`, [did])).rows.length === 1, 'and follows whether he writes back');
  SENT.length = 0;
  await onboard.qa(c, chat, { message_id: 72, chat: { id: CHAT } }, { tg_id: 551001, name: 'Lenny', role: 'driver' }, 'When is pay day?', opts);
  const dr = (await q(`SELECT state, topic, auto FROM tg_drafts WHERE chat_id = $1 AND msg_id = 72`, [CHAT])).rows[0];
  ok(!SENT.length && dr && dr.state === 'open' && dr.topic === 'pay' && !dr.auto, 'a pay question still waits for a person, with its topic saved');
  Math.random = rnd;

  // ---- 2. outcomes: which wording drivers answer ----
  for (let i = 0; i < 9; i++) await q(`INSERT INTO bot_outcomes (driver_id, kind, variant, sent_at, replied_at) VALUES ($1, 'followup:d_test', 0, now() - interval '3 days', $2)`, [did, i < 2 ? new Date() : null]);
  for (let i = 0; i < 9; i++) await q(`INSERT INTO bot_outcomes (driver_id, kind, variant, sent_at, replied_at) VALUES ($1, 'followup:d_test', 1, now() - interval '3 days', $2)`, [did, i < 7 ? new Date() : null]);
  ok(await learn.choose('followup:d_test', 2, 0.9) === 1, 'the wording drivers answer more is used');
  ok(await learn.choose('followup:d_new', 2, 0.9) === 0 && await learn.choose('followup:d_test', 2, 0.1) !== undefined, 'a wording with too few results is tried first');
  const o1 = await learn.record({ driverId: did, kind: 'followup:d_reply' });
  await q(`UPDATE bot_outcomes SET sent_at = now() - interval '2 hours' WHERE id = $1`, [o1]);
  await q(`INSERT INTO tg_messages (chat_id, msg_id, from_id, text, at) VALUES ($1, 90, 551001, 'yes I got it', now() - interval '1 hour')`, [CHAT]);
  await learn.markReplies();
  ok(!!(await q(`SELECT replied_at FROM bot_outcomes WHERE id = $1`, [o1])).rows[0].replied_at, 'the driver wrote back within a day: counted');

  // ---- 3. predict: slipping against our own history ----
  for (let i = 0; i < 9; i++) await q(`INSERT INTO drivers (name, name_key, status, amazon_step, amazon_log) VALUES ($1, lower($1), 'Hired', 'verified', $2)`, ['Past Driver ' + i, JSON.stringify({ profile: hoursAgo(200), accurate: hoursAgo(200 - 10 - i), verified: hoursAgo(100) })]);
  const typ = await learn.typical(true);
  ok(typ.profile && typ.profile.n === 9 && Math.round(typ.profile.median) === 14 && Math.round(typ.profile.slow) === 16, 'it learns how long the drivers who made it took on a step: ' + JSON.stringify(typ.profile));
  const L = (await J.load()).find((d) => d.id === did);
  const risk = J.owed(L).find((x) => x.key === 'at_risk');
  ok(risk && /Lenny Learn has been on "Profile done" for 3 days\. Drivers who made it took about 14 hours here, so he may be slipping/.test(risk.text(0, 'Lenny')), 'a driver far slower than them is flagged as slipping: ' + (risk ? risk.text(0, 'Lenny') : ''));
  const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: db.settings.tz || 'America/Chicago' });
  await q(`UPDATE onboarding SET expected_arrival = $2 WHERE driver_id = $1`, [did, day(2)]);
  const soon = J.owed((await J.load()).find((d) => d.id === did)).find((x) => x.key === 'start_soon');
  ok(soon && /starts .* and still has no company or truck\. Can you sort it before he travels\?/.test(soon.text(0, 'Lenny')), 'acting ahead: he starts in 2 days with no truck: ' + (soon ? soon.text(0, 'Lenny') : ''));

  // ---- 4. people ----
  await q(`DELETE FROM tg_messages WHERE chat_id = $1`, [CHAT]);
  const at = (h) => { const d = new Date(); d.setUTCHours(h, 0, 0, 0); return d; };
  for (let i = 0; i < 6; i++) await q(`INSERT INTO tg_messages (chat_id, msg_id, from_id, text, at) VALUES ($1, $2, 551001, 'hi', $3)`, [CHAT, 200 + i, new Date(at(18) - i * 864e5)]);
  const hs = await learn.activeHours(did); const local = +at(18).toLocaleString('en-US', { timeZone: db.settings.tz || 'America/Chicago', hour: 'numeric', hourCycle: 'h23' });
  ok(hs && hs[0] === local, 'it learns the hour a driver usually writes: ' + JSON.stringify(hs));
  ok(await learn.goodTime(did, local + 1) && !(await learn.goodTime(did, (local + 8) % 24)), 'and writes to him around then, not 8 hours off');
  ok(await learn.goodTime(999999, 3), 'a driver it does not know yet: any time of the day');
  const t1 = await learn.record({ driverId: did, kind: 'team:verified' }); await q(`UPDATE bot_outcomes SET sent_at = now() - interval '30 minutes' WHERE id = $1`, [t1]);
  await learn.record({ driverId: did, kind: 'team:no_group' });
  await learn.teamAnswered(did, 'verified', 'Rita');
  const ts = await learn.teamStats();
  ok(ts.people[0].who === 'Rita' && ts.people[0].answered === 1 && Math.abs(ts.people[0].medianMin - 30) <= 1 && ts.waiting === 1 && ts.asked === 2, 'how the team answers the bot: who, how fast, how many wait: ' + JSON.stringify(ts));

  // ---- 5 and 6. the weekly review ----
  await q(`UPDATE tg_drafts SET grade_note = 'The draft left out the medical card.', driver_text = 'What do I bring?', draft = 'Bring your CDL.', team_text = 'Bring your CDL and medical card' WHERE id = (SELECT id FROM tg_drafts WHERE grade = 'partly' LIMIT 1)`);
  let got = '';
  ai.weeklyReview = async (text) => { got = text; return { proposals: [
    { kind: 'knowledge', title: 'What to bring on day one', detail: 'Asked twice; the draft left out the medical card.', question: 'What do I bring on the first day?', answer: 'Bring your CDL and your medical card.' },
    { kind: 'site', title: 'Show the open follow-ups on the Onboarding board', detail: 'The team never answered 3 follow-ups; a column would make them visible.' },
    { kind: 'wording', title: 'Shorter check-in', detail: 'The second wording gets more replies.' }, { kind: 'bogus', title: 'x', detail: 'y' }] }; };
  const rv = await learn.review({ force: true });
  ok(rv.saved === 3 && /left out the medical card/.test(got) && /SCORE BY TOPIC/.test(got) && !/Lenny/.test(got.split('SCORE BY TOPIC')[1] || ''), 'the weekly review reads its misses and scores, and saves the ideas (a wrong kind is dropped)');
  ok((await learn.review({ force: true })).saved === 0, 'the same idea is not proposed twice');
  const ln = await web('/api/tg/learning');
  const props = ln.proposals.filter((p) => p.status === 'open');
  ok(ln.status === 200 && props.length === 3 && ln.skills.some((s) => s.topic === 'hiring' && s.proven) && ln.typical.some((t) => t.step === 'Profile done') && ln.skillAuto === true, 'the Autopilot page gets skills, timings, and the ideas to approve');
  const kn = props.find((p) => p.kind === 'knowledge'), site = props.find((p) => p.kind === 'site');
  let r = await web('/api/tg/proposals/' + kn.id, { decision: 'approve' });
  ok(r.ok === true && (await q(`SELECT 1 FROM tg_knowledge WHERE answer LIKE '%medical card%' AND active`)).rows.length === 1, 'an approved answer goes into the knowledge base, ready to use');
  r = await web('/api/tg/proposals/' + site.id, { decision: 'approve' });
  ok(/Waiting to be built/.test(r.note || '') && (await q(`SELECT status FROM bot_proposals WHERE id = $1`, [site.id])).rows[0].status === 'approved', 'an approved website change waits as a task to build: ' + r.note);
  ok((await web('/api/tg/proposals/' + site.id, { decision: 'reject' })).status === 404, 'a decided idea cannot be decided again');
  const u = await web('/api/users', { name: 'Learnrec', email: 'learnrec@example.com', password: 'learnrec-pass-123' });
  const r1 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'learnrec@example.com', password: 'learnrec-pass-123' }) });
  const c2 = (r1.headers.get('set-cookie') || '').split(';')[0];
  ok(u.status === 200 && (await fetch(BASE + '/api/tg/proposals/' + props[2].id, { method: 'POST', headers: { 'content-type': 'application/json', cookie: c2 }, body: '{"decision":"approve"}' })).status === 403, 'only an admin approves');
  await web('/api/tg/autopilot', { skillAuto: false }, 'PUT');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
