// The Chrome extension's own Telegram alerts (job rotation, a driver needs you) are for the team. When the extension
// uses the website's bot, the website tells it where they go: the management group, else a private chat. It never
// offers a driver's group, and it says so when the chat the extension uses now is one.
//   bash test/all.sh ext-alert-chat
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const q = db.q;
(async () => {
  const key = 'rk_test_alert_chat';
  await q(`INSERT INTO api_keys (name, key_hash, user_id) VALUES ('alert chat test', $1, (SELECT id FROM users ORDER BY id LIMIT 1))`, [db.sha(key)]);
  const ext = async (p) => (await fetch(BASE + p, { headers: { authorization: 'Bearer ' + key } })).json();
  const did = (await q(`INSERT INTO drivers (name, name_key, status) VALUES ('Gina Group', 'gina group', 'Onboarding') RETURNING id`)).rows[0].id;
  const DRV = -770201, ELD = -770202, MGMT = -770203, RITA = 770204;
  await q(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active) VALUES ($1, 'Gina Group dispatch', 'dispatch', $2, true), ($3, 'Gina ELD', 'eld', $2, true)`, [DRV, did, ELD]);
  const say = (chat, id, name, mins) => q(`INSERT INTO tg_messages (chat_id, msg_id, from_id, from_name, is_bot, text, at) VALUES ($1, $2, 9, $3, false, 'hello', now() - ($4 || ' minutes')::interval)`, [chat, id, name, String(mins)]);
  await say(RITA, 1, 'Rita', 30);   // a person wrote to the bot privately half an hour ago
  await say(DRV, 2, 'Gina', 1);     // the newest message anywhere is in a driver's group

  let r = await ext('/api/ext/tg/recent-chat');
  ok(r.chatId === String(RITA) && r.title === 'Rita', 'with no management group, the alerts go to the private chat of who wrote to the bot, not to the driver\'s group with the newest message');

  await q(`INSERT INTO tg_chats (chat_id, title, kind, active, linked_at) VALUES ($1, 'FleetHire Management', 'management', true, now())`, [MGMT]);
  r = await ext('/api/ext/tg/recent-chat');
  ok(r.chatId === String(MGMT) && r.title === 'FleetHire Management', 'with a management group, the alerts go there');

  // a profile that was connected to a driver's group before: the website says so, and where the alerts belong
  let i = await ext('/api/ext/tg/info?chat=' + DRV);
  ok(i.chat && i.chat.driverGroup === true && i.chat.kind === 'dispatch' && i.alertChat.chatId === String(MGMT), 'the extension is told its chat is a driver\'s group, and gets the team\'s group to use');
  i = await ext('/api/ext/tg/info?chat=' + ELD);
  ok(i.chat.driverGroup === true, 'a driver\'s ELD group counts as a driver\'s group too');
  i = await ext('/api/ext/tg/info?chat=' + MGMT);
  ok(i.chat.driverGroup === false && i.chat.kind === 'management', 'the management group is fine');
  i = await ext('/api/ext/tg/info?chat=' + RITA);
  ok(i.chat.driverGroup === false, 'a private chat is fine');
  i = await ext('/api/ext/tg/info');
  ok(i.chat === undefined && 'botId' in i, 'asking without a chat still answers as before');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
