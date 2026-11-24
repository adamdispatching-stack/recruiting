// When one of us writes in the driver's group that the Amazon Relay invite was sent (in Telegram, or from the lead
// page through the bot), the lead's Amazon step moves to "Invite sent" right away.
//   bash test/all.sh amazon-said
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const fs = require('fs');
const db = require('../src/db');
const bot = require('../src/tg/bot');
const q = db.q;
(async () => {
  bot.log = async () => {};
  const onboard = require('../src/tg/onboard');
  const RITA = { tg_id: 1, name: 'Rita', user_id: null };
  const mk = async (name, step) => { const id = (await q(`INSERT INTO drivers (name, name_key, status, amazon_step, amazon_log) VALUES ($1, lower($1), 'Interested', $2, '{}'::jsonb) RETURNING id`, [name, step])).rows[0].id; return { id, chat: { chat_id: -990000 - id, kind: 'dispatch', driver_id: id } }; };
  const step = async (id) => (await q(`SELECT amazon_step FROM drivers WHERE id = $1`, [id])).rows[0].amazon_step;

  const a = await mk('Robert Invite', null);
  ok(await onboard.teamSaid(a.chat, RITA, 'I will send the invite tomorrow') === null && await step(a.id) === null, 'a plan to send it changes nothing');
  ok(await onboard.teamSaid(a.chat, RITA, 'Did you get the invite sent?') === null, 'a question changes nothing');
  ok(await onboard.teamSaid(a.chat, RITA, 'An invitation has been sent to robert@example.com') === 'invite' && await step(a.id) === 'invite', '"An invitation has been sent to ...": the Amazon step moves to Invite sent');
  ok((await q(`SELECT 1 FROM driver_events WHERE driver_id = $1 AND text LIKE 'Amazon: Relay invite sent%Rita said so in the Telegram group%'`, [a.id])).rows.length === 1, 'it is in the lead\'s history, with who said it');
  ok(await onboard.teamSaid(a.chat, RITA, 'Invite is sent') === null, 'saying it again changes nothing');

  const b = await mk('Paula Profile', 'profile');
  ok(await onboard.teamSaid(b.chat, RITA, 'Relay invite sent, check your spam') === null && await step(b.id) === 'profile', 'a driver already further along is never moved back');

  // the usual path: a message from our team in the group (also what a message sent from the lead page goes through)
  const c = await mk('Liam Learnfrom', null);
  await onboard.learnFrom(c.chat, {}, RITA, 'Invite is sent, let me know once you sign up');
  ok(await step(c.id) === 'invite', 'a team message in the group, or one sent from the lead page, does it');
  const d = await mk('Elda Eldgroup', null);
  await onboard.learnFrom({ ...d.chat, kind: 'eld' }, {}, RITA, 'Invite is sent');
  ok(await step(d.id) === null, 'only in the driver\'s main group, not his ELD or accounting group');

  // a few minutes later the AI reading the group reports the step too (never "verified")
  const ai = fs.readFileSync(__dirname + '/../src/tg/ai.js', 'utf8'), dg = fs.readFileSync(__dirname + '/../src/tg/digest.js', 'utf8');
  ok(/amazon_step: \{ type: 'string', enum: \['none', 'invite', 'account', 'profile', 'accurate', 'waiting'\]/.test(ai) && !/enum: \['none', 'invite'[^\]]*'verified'/.test(ai), 'the AI reading the group can report every step except verified');
  ok(/\['invite', 'account', 'profile', 'accurate', 'waiting'\]\.includes\(o\.amazon_step\)/.test(dg), 'and the step it reports is saved, only forward');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
