// Telegram → All groups: where the team's messages go is set by hand, one chat for each kind of message, and only a
// Management or Shift group (or a private chat) can be picked. The Chrome extension's alerts follow that choice.
// The bot's mode in each driver's group is set by hand in the same place.
//   bash test/all.sh tg-routes
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const q = db.q;
(async () => {
  const key = 'rk_test_tg_routes';
  await q(`INSERT INTO api_keys (name, key_hash, user_id) VALUES ('routes test', $1, (SELECT id FROM users ORDER BY id LIMIT 1))`, [db.sha(key)]);
  const ext = async (p) => (await fetch(BASE + p, { headers: { authorization: 'Bearer ' + key } })).json();
  const lg = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }) });
  const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
  const A = async (p, method, body) => { const x = await fetch(BASE + p, { method: method || 'GET', headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) }); return { http: x.status, ...(await x.json().catch(() => ({}))) }; };
  const route = (k, chatId) => A('/api/tg/routes', 'PUT', { key: k, chatId });

  const did = (await q(`INSERT INTO drivers (name, name_key, status) VALUES ('Rory Route', 'rory route', 'Hired') RETURNING id`)).rows[0].id;
  const DRV = -880101, UNK = -880102, MGMT = -880103, REC = -880104, SHIFT = -880105, PRIV = 880106;
  await q(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active) VALUES ($1, 'Rory Route dispatch', 'dispatch', $2, true)`, [DRV, did]);
  await q(`INSERT INTO tg_chats (chat_id, title, kind, active) VALUES ($1, 'Some new group', NULL, true)`, [UNK]);
  await q(`INSERT INTO tg_chats (chat_id, title, kind, active, linked_at) VALUES ($1, 'FleetHire Management', 'management', true, now() - interval '2 days')`, [MGMT]);
  await q(`INSERT INTO tg_chats (chat_id, title, kind, active, linked_at) VALUES ($1, 'Recruiting team', 'management', true, now())`, [REC]);
  await q(`INSERT INTO tg_chats (chat_id, title, kind, active) VALUES ($1, 'Night shift', 'shift', true)`, [SHIFT]);
  await q(`INSERT INTO tg_people (tg_id, name, user_id) VALUES ($1, 'Admin on Telegram', (SELECT id FROM users ORDER BY id LIMIT 1))`, [PRIV]);

  let i = await ext('/api/ext/tg/info');
  ok(i.alertChat && i.alertChat.chatId === String(MGMT) && !i.alertChat.routed, 'nothing set: the extension\'s alerts go to the first management group, as before');

  let r = await route('recruiting', String(DRV));
  ok(r.http === 400, 'a driver\'s group cannot be picked for the recruiting alerts');
  r = await route('recruiting', String(UNK));
  ok(r.http === 400, 'a group nobody has connected yet cannot be picked either (it may be a driver\'s)');
  r = await route('nonsense', String(REC));
  ok(r.http === 400, 'an unknown kind of message is refused');
  r = await route('recruiting', String(REC));
  ok(r.http === 200 && r.ok, 'a management group can be picked');

  i = await ext('/api/ext/tg/info?chat=' + MGMT);
  ok(i.alertChat.chatId === String(REC) && i.alertChat.routed === true && i.alertChat.title === 'Recruiting team', 'the extension is told the chat that was picked, and that it was picked by hand');
  r = await ext('/api/ext/tg/recent-chat');
  ok(r.chatId === String(REC), 'connecting the extension again offers the picked chat');

  r = await route('recruiting', String(PRIV));
  i = await ext('/api/ext/tg/info');
  ok(r.http === 200 && i.alertChat.chatId === String(PRIV) && i.alertChat.title === 'Admin on Telegram', 'the recruiting alerts can go to a private chat with the bot');
  r = await route('team', String(PRIV));
  ok(r.http === 400, 'the morning report needs a group, not a private chat');
  r = await route('team', String(SHIFT));
  ok(r.http === 200, 'a shift group can be picked for the morning report');
  await route('recruiting', String(REC));

  const ag = await A('/api/tg/all-groups');
  ok(ag.http === 200 && Array.isArray(ag.routeKinds) && ag.routeKinds.length === 3 && ag.routes.recruiting && ag.routes.recruiting.chatId === String(REC) && ag.routes.team.chatId === String(SHIFT) && ag.routes.followups === null, 'the page gets the kinds of message and where each goes now');
  ok((ag.drivers || []).some((d) => d.id === did) && (ag.privates || []).some((p) => p.chat_id === String(PRIV)), 'the page gets the drivers and the private chats that can be picked');
  const g = (ag.groups || []).find((x) => x.chat_id === String(DRV));
  ok(g && g.driver_id === did && g.mode === 'watch', 'each driver\'s group comes with how the bot works in it');

  // the mode is set by hand, in the row
  r = await A(`/api/tg/chats/${DRV}/mode`, 'PATCH', { mode: 'updater' });
  ok(r.http === 200 && (await q(`SELECT mode FROM tg_chats WHERE chat_id = $1`, [DRV])).rows[0].mode === 'updater', 'the bot\'s mode in a driver\'s group is changed from the page');
  r = await A(`/api/tg/chats/${DRV}/mode`, 'PATCH', { mode: 'watch' });
  ok(r.http === 200 && (await q(`SELECT mode FROM tg_chats WHERE chat_id = $1`, [DRV])).rows[0].mode === 'watch', 'and set back to silent');

  // the picked group is later connected to a driver: it is no longer used, and the page says so
  await q(`UPDATE tg_chats SET kind = 'dispatch', driver_id = $2 WHERE chat_id = $1`, [REC, did]);
  i = await ext('/api/ext/tg/info?chat=' + REC);
  ok(i.alertChat.chatId === String(MGMT) && !i.alertChat.routed && i.chat.driverGroup === true, 'a picked group that became a driver\'s group is dropped: the alerts fall back to the management group');
  const ag2 = await A('/api/tg/all-groups');
  ok(ag2.routes.recruiting && ag2.routes.recruiting.broken === true, 'the page shows that the picked chat can no longer be used');
  r = await route('recruiting', '');
  const ag3 = await A('/api/tg/all-groups');
  ok(r.http === 200 && ag3.routes.recruiting === null, 'the choice can be cleared: back to the default');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
