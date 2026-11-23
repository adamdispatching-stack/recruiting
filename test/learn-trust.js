// Keeping the self-learning honest: a person checks a sample of the bot's grades, its "slipping" warnings are scored
// against what really happened, the admins hear when a topic slips, and one switch pauses the bot everywhere.
//   bash test/all.sh learn-trust
process.env.TG_NO_QUIET = '1';
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const bot = require('../src/tg/bot');
const learn = require('../src/tg/learn');
const J = require('../src/tg/journey');
const q = db.q;
(async () => {
  const CALLS = []; const realSend = bot.send; bot.call = async () => ({}); bot.log = async () => {};
  bot.state.me = bot.state.me || { id: 1, username: 'testbot', first_name: 'Bot' };
  const said = (chat) => CALLS.filter((c) => c.method === 'sendMessage' && c.chat === String(chat));
  const r0 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }) });
  const cookie = (r0.headers.get('set-cookie') || '').split(';')[0];
  const web = async (p, body, method) => { const x = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) }); return { http: x.status, ...(await x.json().catch(() => ({}))) }; };
  const adminId = (await q(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`)).rows[0].id;
  const did = (await q("INSERT INTO drivers (name, name_key, status) VALUES ('Tess Trust', 'tess trust', 'Onboarding') RETURNING id")).rows[0].id;
  const CHAT = -440001;
  await q("INSERT INTO tg_chats (chat_id, title, kind, driver_id, active) VALUES ($1, 'Tess', 'dispatch', $2, true)", [CHAT, did]);
  const graded = async (topic, grade, n, note = 'Both say the same.') => { const ids = []; for (let i = 0; i < n; i++) ids.push((await q(`INSERT INTO tg_drafts (chat_id, driver_id, driver_text, draft, team_text, kind, state, topic, grade, grade_note, graded_at) VALUES ($1, $2, 'q', 'a', 'b', 'answer', 'answered', $3, $4, $5, now() - ($6 || ' minutes')::interval) RETURNING id`, [CHAT, did, topic, grade, note, String(10 + i)])).rows[0].id); return ids; };

  // ---- the grader is checked by a person ----
  const same = await graded('hiring', 'same', 12); await graded('hiring', 'wrong', 1, 'The draft gave the wrong day.');
  await q(`UPDATE tg_drafts SET graded_at = now() - interval '2 days' WHERE grade = 'wrong'`); // an old miss: not among the last 5
  ok((await learn.skills()).find((s) => s.topic === 'hiring').proven, 'before any check, a topic can be proven on the bot\'s own grades');
  let ln = await web('/api/tg/learning');
  ok(ln.audit.length === 4 && ln.audit.filter((a) => a.grade === 'same').length === 3 && ln.audit.some((a) => a.grade === 'wrong'), 'the admin gets a few grades to check: matches and misses');
  ok(ln.grader.total === 0 && ln.grader.trusted === true, 'no checks yet: the grades are taken as they are');
  let r = await web(`/api/tg/drafts/${same[0]}/audit`, { fair: true });
  ok(r.http === 200 && r.grade === 'same' && r.trust.fair === 1, '"Fair" confirms a grade');
  r = await web(`/api/tg/drafts/${same[1]}/audit`, { fair: false });
  ok(r.http === 400, '"Not fair" needs the right grade');
  r = await web(`/api/tg/drafts/${same[1]}/audit`, { fair: false, grade: 'wrong' });
  const fixed = (await q('SELECT grade, grade_note, audit FROM tg_drafts WHERE id = $1', [same[1]])).rows[0];
  ok(r.http === 200 && fixed.grade === 'wrong' && fixed.audit === 'unfair' && /Corrected by/.test(fixed.grade_note), '"No: wrong" corrects the grade');
  ok(!(await web('/api/tg/learning')).audit.some((a) => a.id === same[0] || a.id === same[1]), 'a checked grade leaves the list');
  // many unfair grades: the grader is not trusted, nothing is proven
  for (const id of same.slice(2, 5)) await q(`UPDATE tg_drafts SET audit = 'fair', audit_at = now() WHERE id = $1`, [id]);
  for (const id of same.slice(5, 11)) await q(`UPDATE tg_drafts SET audit = 'unfair', audit_at = now() WHERE id = $1`, [id]);
  const tr = await learn.graderTrust();
  ok(tr.total === 11 && tr.trusted === false && Math.round(tr.agreement * 100) === 36, 'under 80% fair over 10 or more checks: the grader is not trusted (' + Math.round(tr.agreement * 100) + '%)');
  await graded('equipment', 'same', 12);
  ok(!(await learn.skills()).some((s) => s.proven), 'then no topic counts as proven, whatever its score');
  await q(`UPDATE tg_drafts SET audit = 'fair' WHERE audit = 'unfair' AND id <> $1`, [same[1]]);
  ok((await learn.graderTrust()).trusted && (await learn.skills()).find((s) => s.topic === 'equipment').proven, 'once the checks look fair again, topics can be proven');

  // ---- the admins hear when a topic slips ----
  await q(`DELETE FROM tg_state WHERE key = 'skills:proven'`); await q(`DELETE FROM notices WHERE user_id = $1`, [adminId]);
  ok((await learn.watchSkills()).slipped.length === 0, 'the first look only remembers which topics are proven');
  await graded('equipment', 'wrong', 1, 'Wrong trailer type.'); // a miss just now
  const w = await learn.watchSkills();
  const note = (await q(`SELECT text FROM notices WHERE user_id = $1 AND text LIKE 'The bot slipped on%'`, [adminId])).rows[0];
  ok(w.slipped.join() === 'equipment' && note && /Trucks & trailers.*a recent draft was wrong.*back to learning/.test(note.text), 'a proven topic slips: the admins get a notice: ' + (note || {}).text);
  ok((await learn.watchSkills()).slipped.length === 0, 'told once, not every 10 minutes');

  // ---- did the warnings come true? ----
  const mk = async (name, status, step) => (await q(`INSERT INTO drivers (name, name_key, status, amazon_step) VALUES ($1, lower($1), $2, $3) RETURNING id`, [name, status, step])).rows[0].id;
  const flagged = [];
  for (let i = 0; i < 8; i++) { const id = await mk('Flag Drop ' + i, 'Onboarding', 'profile'); await learn.flag(id); flagged.push(id); }
  for (let i = 0; i < 4; i++) { const id = await mk('Flag Made ' + i, 'Onboarding', 'profile'); await learn.flag(id); flagged.push(id); }
  await learn.flag(flagged[0]);
  ok((await q(`SELECT count(*)::int n FROM bot_predictions`)).rows[0].n === 12, 'each warning is kept once per driver');
  for (const id of flagged.slice(0, 8)) await q(`UPDATE drivers SET status = 'Not interested' WHERE id = $1`, [id]);
  for (const id of flagged.slice(8, 11)) await q(`UPDATE drivers SET amazon_step = 'verified' WHERE id = $1`, [id]);
  for (let i = 0; i < 10; i++) { const id = await mk('Quiet ' + i, i < 2 ? 'Rejected' : 'Hired', 'verified'); await q(`INSERT INTO onboarding (driver_id, started_at) VALUES ($1, now() - interval '20 days')`, [id]); }
  await learn.resolvePredictions();
  const ps = await learn.predictionStats();
  ok(ps.flagged === 12 && ps.dropped === 8 && ps.madeIt === 3 && ps.open === 1, 'later each warning is marked with what happened: ' + JSON.stringify([ps.dropped, ps.madeIt, ps.open]));
  ok(Math.round(ps.hitRate * 100) === 73 && Math.round(ps.baseRate * 100) === 20 && ps.useful === true, '73% of the drivers it warned about dropped out, 20% of the others: the warnings are useful');
  ok((await web('/api/tg/learning')).predictions.dropped === 8, 'the Autopilot page shows it');

  // ---- pause the bot everywhere ----
  const MG = -440900; await q(`INSERT INTO tg_chats (chat_id, title, kind, active) VALUES ($1, 'Team', 'management', true)`, [MG]);
  const lone = await mk('Nell Nogroup', 'Onboarding', null); await q(`INSERT INTO onboarding (driver_id, started_at) VALUES ($1, now() - interval '3 days')`, [lone]);
  db.settings.tg = { ...(db.settings.tg || {}), paused: true };
  CALLS.length = 0;
  const tried = (p) => p.then((m) => !(m && m.paused), () => true); // true: it went to Telegram (or tried to), not held back
  ok((await realSend(CHAT, 'hello driver')).paused === true, 'paused: the bot writes nothing by itself in a group');
  ok(await tried(realSend(CHAT, 'from the website', { human: true })), 'what a person sends from the website still goes out');
  ok(await tried(realSend(777, 'private alert')), 'private alerts to our team still go out');
  bot.send = async (chat, text) => { CALLS.push({ method: 'sendMessage', chat: String(chat), text }); return { message_id: 900 + CALLS.length }; };
  await J.tick();
  ok(!said(MG).length && !(await q(`SELECT 1 FROM journey_asks WHERE driver_id = $1`, [lone])).rows.length, 'the follow-ups wait, and nothing is marked as asked');
  await q(`DELETE FROM tg_drafts WHERE topic = 'equipment' AND grade = 'wrong'`); db.settings.tg = { ...db.settings.tg, skillAuto: true };
  ok((await learn.skills()).find((x) => x.topic === 'equipment').proven && !(await learn.mayAnswerAlone('equipment', 0.9)), 'a proven topic is not answered alone while paused');
  db.settings.tg = { ...db.settings.tg, paused: false, skillAuto: false };
  await J.tick();
  ok(said(MG).some((c) => /Nell Nogroup is in onboarding but has no Telegram group yet/.test(c.text)), 'resumed: the follow-ups go out again');
  r = await web('/api/tg/autopilot', { paused: true }, 'PUT');
  ok(r.http === 200 && (await web('/api/tg/learning')).paused === true, 'an admin pauses from the website');
  await web('/api/tg/autopilot', { paused: false }, 'PUT');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
