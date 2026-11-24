// The bot tags a recruiter in the management group only in that recruiter's working hours; outside them the
// follow-up waits and goes out when they are back.
//   bash test/all.sh working-hours
delete process.env.TG_NO_QUIET;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const bot = require('../src/tg/bot');
const { working, localNow } = require('../src/working');
const J = require('../src/tg/journey');
const q = db.q;
(async () => {
  const SENT = []; bot.send = async (chat, text) => { SENT.push({ chat: String(chat), text }); return { message_id: 700 + SENT.length }; };
  bot.call = async () => ({}); bot.log = async () => {}; bot.state.me = bot.state.me || { id: 1, username: 'testbot' };
  const now = localNow();
  const all = (s, e) => JSON.stringify(Array(7).fill({ s, e }));
  const IN = all('00:00', '23:59'), OUT = now.min < 720 ? all('13:00', '23:00') : all('01:00', '11:00');
  const rita = (await q(`INSERT INTO users (name, email, pass_hash, role) VALUES ('Rita Hours', 'ritah@example.com', 'x', 'recruiter') RETURNING id`)).rows[0].id;
  const setHours = (h) => q(`UPDATE users SET hours = $2::jsonb WHERE id = $1`, [rita, h]);

  await setHours(IN); ok(await working(rita), 'in her own working hours: yes');
  await setHours(OUT); ok(!(await working(rita)), 'outside her own hours: no');
  await setHours(IN); await q(`INSERT INTO days_off (user_id, day) VALUES ($1, $2::date)`, [rita, now.date]);
  ok(!(await working(rita)), 'on her day off: no');
  await q(`DELETE FROM days_off WHERE user_id = $1`, [rita]);
  await setHours(null);
  const team = db.settings.hours.week[now.dow];
  const inTeam = !!team && now.min >= (+team.s.split(':')[0] * 60 + +team.s.split(':')[1]) && now.min < (+team.e.split(':')[0] * 60 + +team.e.split(':')[1]);
  ok(await working(rita) === inTeam && await working(null) === inTeam, 'no hours of her own, or no recruiter on the lead: the team\'s hours');
  ok(!(await working(999999)), 'someone who is gone is not tagged');
  process.env.TG_NO_QUIET = '1'; ok(await working(999999), '(the other test suites run at any hour)'); delete process.env.TG_NO_QUIET;

  // the follow-up in the management group waits for her hours
  const MG = '-330000';
  await q(`INSERT INTO tg_people (tg_id, name, username, user_id) VALUES (331001, 'Rita H', 'rita_h', $1)`, [rita]);
  await q(`INSERT INTO tg_chats (chat_id, title, kind, active) VALUES ($1, 'Team', 'management', true)`, [MG]);
  const did = (await q(`INSERT INTO drivers (name, name_key, status, owner_id, amazon_step) VALUES ('Owen Offhours', 'owen offhours', 'Onboarding', $1, 'verified') RETURNING id`, [rita])).rows[0].id;
  await q(`INSERT INTO onboarding (driver_id, started_at) VALUES ($1, now() - interval '3 days')`, [did]);
  await setHours(OUT); await J.tick();
  ok(!SENT.some((s) => s.chat === MG) && !(await q(`SELECT 1 FROM journey_asks WHERE driver_id = $1`, [did])).rows.length, 'outside her hours the bot does not tag her, and nothing is counted as asked');
  await setHours(IN); await J.tick();
  ok(SENT.some((s) => s.chat === MG && /@rita_h, Owen Offhours is in onboarding but has no Telegram group yet/.test(s.text)), 'back in her hours: the follow-up goes out');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
