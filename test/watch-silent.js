// Watch means silent: in a driver's group that is in Watch the bot never writes on its own, whichever feature tries.
// What a person sends through it, and its answer to something just written in that group, still go out.
//   bash test/all.sh watch-silent
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const bot = require('../src/tg/bot');
const q = db.q;
(async () => {
  // a stand-in for Telegram: it only notes what the bot sends
  const OUT = [];
  const tg = require('http').createServer((req, res) => { let t = ''; req.on('data', (c) => { t += c; }); req.on('end', () => { const p = JSON.parse(t || '{}'); OUT.push({ method: req.url.split('/').pop(), chat: String(p.chat_id), text: p.text }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { message_id: OUT.length, date: Math.floor(Date.now() / 1000) } })); }); });
  await new Promise((r) => tg.listen(4987, '127.0.0.1', r));
  process.env.TG_API_BASE = 'http://127.0.0.1:4987'; process.env.TELEGRAM_BOT_TOKEN = '123:test';
  const mk = async (name, status, chatId, kind, mode, onb) => {
    const id = (await q(`INSERT INTO drivers (name, name_key, status) VALUES ($1, lower($1), $2) RETURNING id`, [name, status])).rows[0].id;
    await q(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active, mode) VALUES ($1, $2, $3, $4, true, $5)`, [chatId, name, kind, id, mode]);
    if (onb) await q(`INSERT INTO onb_cases (driver_id, chat_id, mode) VALUES ($1, $2, $3)`, [id, chatId, onb]);
    return id;
  };
  const W = -880001, RUN = -880002, UPD = -880003, HW = -880004, ELD = -880005;
  await mk('Wanda Watch', 'Onboarding', W, 'dispatch', 'watch', 'watch');
  await mk('Rita Run', 'Onboarding', RUN, 'dispatch', 'watch', 'run');
  await mk('Ugo Updater', 'Hired', UPD, 'dispatch', 'updater', 'run');
  await mk('Hank Hired', 'Hired', HW, 'dispatch', 'watch', 'run'); // hired: his old onboarding mode no longer counts
  await mk('Edna Eld', 'Hired', ELD, 'eld', 'watch', null);
  const sent = (chat) => OUT.filter((o) => o.method === 'sendMessage' && o.chat === String(chat)).length;
  const held = async (chat) => (await q(`SELECT count(*)::int n FROM tg_log WHERE chat_id = $1 AND kind = 'held'`, [chat])).rows[0].n;

  // on its own (a timer, a follow-up): nothing in a Watch group, and the log says what was held
  let r = await bot.send(W, 'Reminder: please send your CDL');
  ok(r.held === true && sent(W) === 0 && await held(W) === 1, 'a message of its own to a driver\'s group in Watch is not sent, and the log notes it');
  r = await bot.send(HW, 'How many miles on the truck?');
  ok(r.held === true && sent(HW) === 0, 'the same for a working driver\'s group in Watch, whatever his onboarding mode was');

  // groups that are not in Watch, and other kinds of group, are as before
  await bot.send(RUN, 'Please sign up on Relay'); await bot.send(UPD, 'Truck update'); await bot.send(ELD, 'ELD check');
  ok(sent(RUN) === 1 && sent(UPD) === 1 && sent(ELD) === 1, 'onboarding in Run, a working group in updater, and an ELD group still get the bot\'s own messages');
  await bot.send(-880099, 'Good morning, team');
  ok(sent(-880099) === 1, 'a group that is not a driver\'s group (the team\'s) is not touched by this');

  // a person through the bot, and an answer to something just written there
  await bot.send(W, 'Hi, this is Rita from the office', { human: true });
  ok(sent(W) === 1, 'what a person sends through the bot goes into a Watch group');
  await bot.inChat(W, () => bot.send(W, 'This is the Dispatch group.'));
  ok(sent(W) === 2, 'an answer to a command or button in that same group goes out');
  r = await bot.inChat(RUN, () => bot.send(W, 'something for another group'));
  ok(r.held === true && sent(W) === 2, 'but handling one group does not open another group in Watch');

  // a private chat is never held
  await bot.send(5551234, 'Your code is ready');
  ok(sent(5551234) === 1, 'private chats are not held');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
