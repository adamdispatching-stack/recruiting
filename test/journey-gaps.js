// Gaps from the driver journey map: groups of drivers who left are not read, the oil question follows the group's mode,
// and the driver gets the plan on orientation day.
//   bash test/all.sh journey-gaps
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const bot = require('../src/tg/bot');
const q = db.q;
(async () => {
  const SENT = []; bot.send = async (chat, text) => { SENT.push({ chat: String(chat), text }); return { message_id: SENT.length }; };
  bot.on = () => true; bot.state.me = bot.state.me || { id: 1, username: 'testbot' };
  const driver = async (name, status, extra = '') => (await q(`INSERT INTO drivers (name, name_key, status${extra ? ', left_on' : ''}) VALUES ($1, lower($1), $2${extra ? ", now()::date" : ''}) RETURNING id`, [name, status])).rows[0].id;
  const group = async (chat, id, mode = 'watch') => q(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active, mode) VALUES ($1, $2, 'dispatch', $3, true, $4)`, [chat, 'G' + id, id, mode]);

  // 1. a driver who left: his messages are no longer read by the AI
  const gone = await driver('Gone Gapper', 'Hired', 'left'), lost = await driver('Lost Gapper', 'Rejected'), here = await driver('Here Gapper', 'Hired');
  await group(-880001, gone); await group(-880002, lost); await group(-880003, here);
  for (const c of [-880001, -880002, -880003]) await q(`INSERT INTO tg_messages (chat_id, msg_id, from_id, text, at) VALUES ($1, 1, 5, 'hello', now())`, [c]);
  await require('../src/tg/digest').tick().catch((e) => console.log('tick', e.message));
  const left = Object.fromEntries((await q(`SELECT chat_id::text c, digested FROM tg_messages WHERE chat_id IN (-880001, -880002, -880003)`)).rows.map((r) => [r.c, r.digested]));
  ok(left['-880001'] === true && left['-880002'] === true, 'groups of a driver who left, or was lost, are skipped');
  ok(left['-880003'] === false, 'a working driver\'s group still waits to be read');

  // 2. the oil question: Watch leaves it on the website, Updater asks the driver
  const fleet = require('../src/fleet');
  const o = { state: 'overdue', last: { at: new Date('2026-09-01T12:00:00Z'), odometer: 120000 } };
  await fleet.askMiles({ id: 1, unit: '901', driver: 'Here Gapper', driver_id: here }, o);
  const dr = (await q(`SELECT draft, kind FROM tg_drafts WHERE chat_id = -880003 AND state = 'open'`)).rows;
  ok(!SENT.length && dr.length === 1 && dr[0].kind === 'remind' && /Here, truck 901 is due for an oil change.*120,000 mi/.test(dr[0].draft), 'Watch: the oil question waits on the website: ' + (dr[0] || {}).draft);
  await q(`UPDATE tg_chats SET mode = 'updater' WHERE chat_id = -880003`);
  await fleet.askMiles({ id: 1, unit: '901', driver: 'Here Gapper', driver_id: here }, o);
  ok(SENT.length === 1 && SENT[0].chat === '-880003' && /truck 901 is due/.test(SENT[0].text), 'Updater: the bot asks the driver');

  // 3. orientation day
  const today = (await q(`SELECT (now() AT TIME ZONE $1)::date::text d`, [db.settings.tz || 'America/Chicago'])).rows[0].d;
  const run = await driver('Run Orient', 'Onboarding'), watch = await driver('Watch Orient', 'Onboarding'), later = await driver('Later Orient', 'Onboarding');
  for (const [id, chat, mode, day] of [[run, -880011, 'run', today], [watch, -880012, 'watch', today], [later, -880013, 'run', null]]) {
    await group(chat, id); await q(`INSERT INTO onb_cases (driver_id, chat_id, mode) VALUES ($1, $2, $3)`, [id, chat, mode]);
    await q(`INSERT INTO onboarding (driver_id, arrived_on) VALUES ($1, $2)`, [id, day]);
    for (const [k, l, i] of [['truck', 'Truck handed over', 0], ['eld', 'ELD login works', 1]]) await q(`INSERT INTO orientation (driver_id, key, label, position) VALUES ($1, $2, $3, $4)`, [id, k, l, i]);
  }
  await q(`UPDATE orientation SET done = true WHERE driver_id = $1 AND key = 'truck'`, [run]);
  const pw = require('../src/tg/paperwork');
  SENT.length = 0;
  await pw.orientation(true, today);
  const msg = SENT.find((s) => s.chat === '-880011');
  ok(msg && /Welcome, Run! Today is your orientation day/.test(msg.text) && /• ELD login works/.test(msg.text) && !/Truck handed over/.test(msg.text), 'Run: the driver gets the plan, the steps still open: ' + (msg || {}).text);
  const wd = (await q(`SELECT draft FROM tg_drafts WHERE chat_id = -880012 AND state = 'open'`)).rows[0];
  ok(!SENT.some((s) => s.chat === '-880012') && wd && /Watch! Today is your orientation day/.test(wd.draft), 'Watch: it waits on the website');
  ok(!SENT.some((s) => s.chat === '-880013'), 'not for a driver who has not arrived');
  await pw.orientation(true, today);
  ok(SENT.filter((s) => s.chat === '-880011').length === 1, 'sent once');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
