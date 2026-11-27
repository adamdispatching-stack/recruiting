// An active driver's week in money: Sunday to Saturday, read from his Telegram groups (truck expenses and other money
// cases, not the loads), kept week by week and picked from a drop-down on his page.
//   bash test/all.sh tg-weeks
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const q = db.q;
(async () => {
  const lg = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }) });
  const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
  const A = async (p, method, body) => { const x = await fetch(BASE + p, { method: method || 'GET', headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) }); return { http: x.status, ...(await x.json().catch(() => ({}))) }; };
  const weekly = require('../src/tg/weekly');
  const ai = require('../src/tg/ai');

  ok(weekly.sunday('2026-11-18') === '2026-11-15' && weekly.sunday('2026-11-15') === '2026-11-15' && weekly.sunday('2026-11-21') === '2026-11-15' && weekly.sunday('2026-11-22') === '2026-11-22', 'a week runs from Sunday to Saturday');

  const did = (await q(`INSERT INTO drivers (name, name_key, status) VALUES ('Wally Week', 'wally week', 'Hired') RETURNING id`)).rows[0].id;
  const DISP = -770101, ACC = -770102;
  await q(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active) VALUES ($1, 'Wally dispatch', 'dispatch', $2, true), ($3, 'Wally accounting', 'accounting', $2, true)`, [DISP, did, ACC]);
  const tz = db.settings.tz;
  const today = (await q(`SELECT (now() AT TIME ZONE $1)::date::text d`, [tz])).rows[0].d;
  const now = weekly.sunday(today), last = weekly.plus(now, -7), older = weekly.plus(now, -21);
  let n = 0;
  const say = (chat, day, hm, text) => q(`INSERT INTO tg_messages (chat_id, msg_id, from_id, from_name, text, at) VALUES ($1, $2, 55, 'Wally', $3, ($4::text || ' ' || $5::text)::timestamp AT TIME ZONE $6)`, [chat, ++n, text, day, hm, tz]);
  await say(DISP, older, '10:00', 'hello, first day');
  await say(DISP, last, '00:30', 'tire blew out, road service wants 480');               // Sunday, first hour: in the week
  await say(ACC, weekly.plus(last, 3), '12:00', 'can I get a 200 advance');
  await say(DISP, weekly.plus(last, 6), '23:30', 'paid 35 for parking');                 // Saturday, last hour: in the week
  await say(DISP, now, '00:10', 'picked up the load in Dallas');                         // the next Sunday: not in it

  let r = await A(`/api/drivers/${did}/weeks`);
  ok(r.http === 200 && r.now === now && r.weeks[0].week === now && r.weeks[0].to === weekly.plus(now, 6), 'the drop-down starts with this week, Sunday to Saturday');
  ok(r.weeks.length === 4 && r.weeks[3].week === older && r.weeks.every((w) => w.none), 'it goes back to the week of his first message, and nothing is written yet');
  r = await A(`/api/drivers/${did}/weeks/build`, 'POST', { week: 'last' });
  ok(r.http === 400, 'a week that is not a date is refused');

  // the AI's part is played here: it gets the lines of the week and answers with the money cases
  let got = null;
  process.env.ANTHROPIC_API_KEY = 'test';
  ai.weekMoney = async (a) => { got = a; return { summary: 'A blown tire cost $480 on the road. He asked for a $200 advance. Account 123456789 was mentioned.', open: ['Advance of $200 not answered'],
    items: [{ day: last, kind: 'tires', what: 'Blown tire, road service', amount: 480, paid_by: 'company', status: 'settled' },
      { day: weekly.plus(last, 3), kind: 'advance', what: 'Asked for an advance', amount: 200, paid_by: 'company', status: 'open' },
      { day: weekly.plus(last, 6), kind: 'tolls_parking', what: 'Parking', amount: 35, paid_by: 'driver', status: 'settled' },
      { day: '2020-01-01', kind: 'nonsense', what: 'Shop visit, price not said', paid_by: 'someone', status: 'whatever' }] }; };
  const w = await weekly.buildWeek(did, weekly.plus(last, 4));
  ok(got && got.lines.length === 3 && got.from === last && got.to === weekly.plus(last, 6), 'the AI reads only that week: from the first hour of Sunday to the last of Saturday, all his groups together');
  ok(got.lines.some((l) => /Accounting/.test(l)) && got.lines.some((l) => /Dispatch/.test(l)), 'each line says which group it came from');
  ok(w.week === last && w.total === 715 && w.items.length === 4 && w.messages === 3, 'the week is kept under its Sunday, with the cases and the sum of the amounts that were said');
  ok(w.items[3].amount === null && w.items[3].kind === 'other' && w.items[3].day === null && w.items[3].paidBy === 'unknown', 'a case with no amount stays without one, and anything odd from the AI is made plain');
  ok(!/123456789/.test(w.summary), 'an account number never reaches the summary');

  ai.weekMoney = async () => ({ summary: 'Nothing about money this week.', items: [], open: [] });
  ok((await weekly.buildWeek(did, older)).total === 0, 'a week with nothing about money is kept too');
  ok((await weekly.buildWeek(did, weekly.plus(now, -14))) === null, 'a week with no messages is not written');
  ai.weekMoney = async () => ({ summary: 'Tire: $480 in all.', items: [{ day: last, kind: 'tires', what: 'Blown tire', amount: 480, paid_by: 'company', status: 'settled' }], open: [] });
  await weekly.buildWeek(did, last);
  ok(+(await q(`SELECT count(*)::int n FROM tg_weeks WHERE driver_id = $1`, [did])).rows[0].n === 2, 'writing a week again replaces it: one row for each week');

  r = await A(`/api/drivers/${did}/weeks`);
  const byW = Object.fromEntries(r.weeks.map((x) => [x.week, x]));
  ok(byW[last].total === 480 && byW[last].items.length === 1 && byW[older].summary === 'Nothing about money this week.' && byW[now].none && byW[weekly.plus(now, -14)].none, 'the page gets every week: the written ones with their content, the others marked as not written');

  // Sunday: the week that just ended is written for active drivers, once
  await q(`DELETE FROM tg_weeks WHERE driver_id = $1 AND week = $2`, [did, last]);
  const gone = (await q(`INSERT INTO drivers (name, name_key, status) VALUES ('Larry Lead', 'larry lead', 'Onboarding') RETURNING id`)).rows[0].id;
  await q(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active) VALUES (-770103, 'Larry onboarding', 'dispatch', $1, true)`, [gone]);
  await say(-770103, weekly.plus(last, 2), '09:00', 'when do I start');
  let calls = 0; ai.weekMoney = async () => { calls++; return { summary: 'Written on Sunday.', items: [], open: [] }; };
  await weekly.tick(); await weekly.tick();
  ok(calls === 1 && (await q(`SELECT summary FROM tg_weeks WHERE driver_id = $1 AND week = $2`, [did, last])).rows[0].summary === 'Written on Sunday.', 'the finished week is written by itself, one time');
  ok(!(await q(`SELECT 1 FROM tg_weeks WHERE driver_id = $1`, [gone])).rows.length, 'only for active drivers');
  process.exit();
})().catch((e) => { console.log('FAIL crashed: ' + e.message); process.exitCode = 1; });
