// The dispatcher review links each situation to its messages: "See the messages" and "Open in Telegram".
//   bash test/all.sh disp-links
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const ai = require('../src/tg/ai');
const D = require('../src/tg/dispatchers');
const q = db.q;
(async () => {
  const r0 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }) });
  const cookie = (r0.headers.get('set-cookie') || '').split(';')[0];
  const A = async (p) => { const x = await fetch(BASE + p, { headers: { cookie } }); return { status: x.status, ...(await x.json().catch(() => ({}))) }; };
  const SUPER = '-1001234567890', BASIC = '-4455667';
  const did = (await q("INSERT INTO drivers (name, name_key, status) VALUES ('Linky Driver', 'linky driver', 'Hired') RETURNING id")).rows[0].id;
  await q("INSERT INTO tg_chats (chat_id, title, kind, driver_id, active) VALUES ($1, 'Linky 1', 'dispatch', $3, true), ($2, 'Linky 2', 'dispatch', $3, true)", [SUPER, BASIC, did]);
  const DISP = 660001, DRV = 660002;
  await q("INSERT INTO tg_people (tg_id, name, role) VALUES ($1, 'Dana Disp', 'dispatch'), ($2, 'Linky Driver', 'driver')", [DISP, DRV]);
  await q('UPDATE tg_people SET driver_id = $1 WHERE tg_id = $2', [did, DRV]);
  const say = (chat, msg, from, text, minAgo) => q('INSERT INTO tg_messages (chat_id, msg_id, from_id, text, at) VALUES ($1, $2, $3, $4, $5)', [chat, msg, from, text, new Date(Date.now() - minAgo * 60000)]);
  await say(SUPER, 10, DRV, 'where do I deliver?', 300); await say(SUPER, 11, DRV, 'hello??', 210); await say(SUPER, 12, DISP, 'Dock 4, sorry for the wait', 200);
  for (let i = 0; i < 5; i++) await say(SUPER, 20 + i, DISP, 'Send the BOL please ' + i, 150 - i);
  await say(BASIC, 5, DRV, 'flat tire', 100); await say(BASIC, 6, DISP, 'calling the shop now', 95);

  // the AI is faked: it gets the numbered lines and cites them
  let seen = '';
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test';
  ai.dispatcherProfile = async ({ lines }) => {
    seen = lines.join('\n');
    const num = (t) => +(seen.split('\n').find((l) => l.includes(t)) || '').match(/\[#(\d+)/)[1];
    return { summary: 'ok', scores: [{ area: 'speed', score: 2, seen: 'slow', example: 'Dock 4', ref: num('Dock 4') }], issues: [{ situation: 'The driver waited 100 minutes and asked twice', what_he_did: 'Answered late', verdict: 'poor', ref: num('Dock 4') }, { situation: 'Flat tire', what_he_did: 'Called the shop', verdict: 'good', ref: num('calling the shop') }, { situation: 'made up', what_he_did: 'x', verdict: 'ok', ref: 999 }],
      red_flags: ['Left the driver waiting'], red_flag_refs: [num('Dock 4')], feedback: { praise_first: 'a', main_point: 'b', how_to_say_it: 'c', goal: 'd', show_example: 'e', show_example_ref: num('calling the shop') } };
  };
  const prof = await D.build(DISP, { force: true });
  ok(/\[#\d+ group \d/.test(seen) && seen.split('\n').filter((l) => /^\[#/.test(l)).length === 7, 'every one of his messages is numbered for the AI');
  const iss = prof.issues[0], ref = prof.refs[iss.ref];
  ok(ref && ref.chat === SUPER && ref.msg === 12 && ref.driverMsg === 11, 'the situation points at his reply and the driver message before it');
  ok(prof.refs[prof.issues[1].ref].chat === BASIC && prof.refs[prof.issues[1].ref].msg === 6, 'a situation in another group points there');
  ok(!prof.refs[999], 'a number the AI made up is dropped');
  ok(prof.refs[prof.red_flag_refs[0]] && prof.refs[prof.feedback.show_example_ref], 'red flags and the example to show him are linked too');
  ok(Object.keys(prof.refs).length === 2, 'only the cited messages are kept');

  // the page gets them, and the moment of the chat
  let r = await A('/api/tg/dispatchers/' + DISP);
  ok(r.profile && r.profile.refs && r.profile.refs[iss.ref].msg === 12, 'the review page gets the links');
  r = await A(`/api/tg/chats/${SUPER}/around?msg=12`);
  ok(r.status === 200 && r.msgs.map((m) => m.msgId).join() === '10,11,12,20,21,22,23,24', 'See the messages: before and after, in order: ' + (r.msgs || []).map((m) => m.msgId).join());
  ok(r.msgs[1].who === 'Linky Driver' && r.msgs[1].role === 'driver' && r.msgs[2].who === 'Dana Disp', 'with who wrote each');
  r = await A(`/api/tg/chats/${SUPER}/around`);
  ok(r.status === 400, 'a message is needed');
  const u = await fetch(BASE + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Linkrec', email: 'linkrec@example.com', password: 'linkrec-pass-123' }) });
  ok(u.status === 200, 'a recruiter is made');
  const r1 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'linkrec@example.com', password: 'linkrec-pass-123' }) });
  const c2 = (r1.headers.get('set-cookie') || '').split(';')[0];
  ok((await fetch(`${BASE}/api/tg/chats/${SUPER}/around?msg=12`, { headers: { cookie: c2 } })).status === 403, 'only admins, like the review');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
