// The Telegram conversation on the lead page (like the Indeed one), writing in it from the website, and the
// Telegram tag on the leads table.
//   bash test/all.sh tg-chat
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const q = db.q;
(async () => {
  const login = async (email, password) => { const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); return (r.headers.get('set-cookie') || '').split(';')[0]; };
  const call = (cookie) => async (p, body) => { const x = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) }); return { http: x.status, ...(await x.json().catch(() => ({}))) }; };
  const A = call(await login('admin@example.com', 'test-password-123'));
  const rita = await A('/api/users', { name: 'Chatrita', email: 'chatrita@example.com', password: 'chatrita-pass-123' });
  const other = await A('/api/users', { name: 'Chatother', email: 'chatother@example.com', password: 'chatother-pass-123' });
  const R = call(await login('chatrita@example.com', 'chatrita-pass-123'));
  const mk = async (name, owner) => (await q(`INSERT INTO drivers (name, name_key, status, owner_id, phones) VALUES ($1, lower($1), 'Onboarding', $2, ARRAY['2155550144']) RETURNING id`, [name, owner])).rows[0].id;
  const tom = await mk('Tom Chatty', rita.id), none = await mk('Nina Nochat', rita.id), gone = await mk('Gus Gonebot', rita.id), bare = await mk('Bea Basic', rita.id);
  const DG = -220001, EG = -220002;
  await q(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active, bot_admin, linked_at) VALUES ($1, 'Tom Chatty', 'dispatch', $3, true, true, now()), ($2, 'Tom Chatty ELD', 'eld', $3, true, true, now())`, [DG, EG, tom]);
  await q(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active, bot_admin) VALUES (-220003, 'Gus', 'dispatch', $1, false, true), (-220004, 'Bea', 'dispatch', $2, true, false)`, [gone, bare]);
  await q(`INSERT INTO tg_people (tg_id, name, role, driver_id, user_id) VALUES (221001, 'Tommy', 'driver', $1, NULL), (221002, 'Rita R', NULL, NULL, $2), (221003, 'Uncle Bob', NULL, NULL, NULL)`, [tom, rita.id]);
  const say = (chat, id, from, text, minAgo, bot = false) => q(`INSERT INTO tg_messages (chat_id, msg_id, from_id, from_name, is_bot, text, at) VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 || ' minutes')::interval)`, [chat, id, from, bot ? 'Bot' : 'x', bot, text, String(minAgo)]);
  await say(DG, 1, 221001, 'Hi, I signed up on Relay', 50); await say(DG, 2, 221002, 'Great, I will check', 45); await say(DG, 3, 0, 'Reminder: the contract', 40, true);
  await say(DG, 4, 0, 'Pay is every Friday\n(Chatrita)', 30, true); await say(DG, 5, 221003, 'he is my nephew', 20); await say(EG, 1, 221001, 'ELD is not logging in', 10);

  // the conversation
  let r = await R(`/api/drivers/${tom}/tg-chat`);
  const sides = r.msgs.map((m) => m.side).join();
  ok(r.http === 200 && r.msgs.length === 6 && sides === 'driver,team,bot,team,other,driver', 'the lead page gets the Telegram conversation, oldest first, with who is who: ' + sides);
  ok(r.msgs[3].who === 'Chatrita' && r.msgs[3].text === 'Pay is every Friday', 'a message sent from the website shows under the sender\'s name, without the signature');
  ok(r.msgs[5].kind === 'eld' && r.groups.length === 2, 'messages from his other groups are there too, marked');
  ok(r.msgs[0].who === 'Tommy' && r.msgs[2].who === 'Bot', 'names: the driver\'s account, the bot');
  r = await R(`/api/drivers/${none}/tg-chat`);
  ok(r.http === 200 && r.groups.length === 0 && r.canSend === false, 'no group yet: nothing to show, nothing to send to');
  const O = call(await login('chatother@example.com', 'chatother-pass-123'));
  const vis = (await A('/api/settings')).visibility;
  ok(vis !== 'own' || (await O(`/api/drivers/${tom}/tg-chat`)).http !== 200, 'another recruiter\'s lead follows the usual "who sees which leads" rule');

  // sending
  r = await R(`/api/drivers/${tom}/tg-chat`, { text: '   ' });
  ok(r.http === 400, 'an empty message is refused');
  r = await R(`/api/drivers/${tom}/tg-chat`, { text: 'Hello Tom, see you Monday' });
  ok(r.http === 400 && /not turned on/.test(r.error) || r.http === 200 || r.http === 502, 'sending needs the bot (off in this test: refused; on: it goes to Telegram): ' + r.http);
  r = await R(`/api/drivers/${none}/tg-chat`, { text: 'hi' });
  ok(r.http === 400 || r.http === 404, 'a driver with no group cannot be written to');

  // the leads table
  r = await R('/api/drivers?limit=200');
  const tg = Object.fromEntries(r.drivers.map((d) => [d.name, d.telegram]));
  ok(tg['Tom Chatty'] === 'on' && tg['Nina Nochat'] === null && tg['Gus Gonebot'] === 'removed' && tg['Bea Basic'] === 'noadmin', 'the leads table knows each lead\'s Telegram group: ' + JSON.stringify(tg));
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
