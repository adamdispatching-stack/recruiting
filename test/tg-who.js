// Which Telegram account is the driver's: the picker on the lead, "Who is the driver?", and likely team members.
//   bash test/all.sh tg-who
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const whois = require('../src/tg/whois');
const q = db.q;
async function session(email, password) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return async (path, body, method) => { const x = await fetch(BASE + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) }); return { status: x.status, ...(await x.json().catch(() => ({}))) }; };
}
(async () => {
  const admin = await session('admin@example.com', 'test-password-123');
  const rita = await admin('/api/users', { name: 'Whorita', email: 'whorita@example.com', password: 'whorita-pass-123' });
  const R = await session('whorita@example.com', 'whorita-pass-123');
  const driver = async (name) => (await q("INSERT INTO drivers (name, name_key, status, owner_id) VALUES ($1, lower($1), 'Onboarding', $2) RETURNING id", [name, rita.id])).rows[0].id;
  const tom = await driver('Tom Whotest'), ann = await driver('Ann Whotest');
  for (const id of [tom, ann]) await q('INSERT INTO onboarding (driver_id) VALUES ($1)', [id]);
  const TOM_CHAT = -770001, ANN_CHAT = -770002;
  await q("INSERT INTO tg_chats (chat_id, title, kind, driver_id, active) VALUES ($1, 'Tom Whotest', 'dispatch', $2, true), ($3, 'Ann Whotest', 'dispatch', $4, true)", [TOM_CHAT, tom, ANN_CHAT, ann]);
  const P = { tommy: 771001, wife: 771002, staff: 771003, disp: 771004, web: 771005, busy: 771006, quiet: 771007, bot: 771008, ann: 771009 };
  await q(`INSERT INTO tg_people (tg_id, name, username, role, driver_id, user_id) VALUES
    (${P.tommy}, 'Tommy W', 'tommyw', NULL, NULL, NULL), (${P.wife}, 'Mary W', NULL, NULL, NULL, NULL), (${P.staff}, 'Sam Staff', NULL, 'staff', NULL, NULL),
    (${P.disp}, 'Dan Disp', NULL, 'dispatch', NULL, NULL), (${P.web}, 'Rita on web', NULL, NULL, NULL, $1), (${P.busy}, 'Busy Bee', NULL, NULL, NULL, NULL),
    (${P.quiet}, 'Quiet Q', NULL, NULL, NULL, NULL), (${P.bot}, 'Some Bot', NULL, NULL, NULL, NULL), (${P.ann}, 'Ann W', NULL, 'driver', $2, NULL)`, [rita.id, ann]);
  for (const t of Object.values(P)) await q('INSERT INTO tg_members (chat_id, tg_id) VALUES ($1, $2)', [t === P.ann ? ANN_CHAT : TOM_CHAT, t]);
  for (let i = 0; i < 5; i++) await q('INSERT INTO tg_members (chat_id, tg_id) VALUES ($1, $2)', [-779000 - i, P.busy]); // in 6 groups: probably our team
  let mid = 0;
  const say = (chat, from, text, hours, isBot = false) => q('INSERT INTO tg_messages (chat_id, msg_id, from_id, is_bot, text, at) VALUES ($1, $2, $3, $4, $5, $6)', [chat, ++mid, from, isBot, text, new Date(Date.now() - hours * 36e5)]);
  await say(TOM_CHAT, P.tommy, 'hi I am on my way', 5); await say(TOM_CHAT, P.tommy, 'uploaded my CDL', 2); await say(TOM_CHAT, P.wife, 'he forgot his phone', 3);
  await say(TOM_CHAT, P.staff, 'welcome', 4); await say(TOM_CHAT, P.disp, 'load ready', 4); await say(TOM_CHAT, P.web, 'note', 4); await say(TOM_CHAT, P.busy, 'hello', 4); await say(TOM_CHAT, P.bot, 'reminder', 1, true);
  await say(ANN_CHAT, P.ann, 'ready', 2);

  // who is listed
  let c = (await whois.candidates([tom, ann]));
  const names = (d) => c[d].people.map((p) => p.name);
  ok(names(tom).includes('Tommy W') && names(tom).includes('Mary W') && names(tom).includes('Quiet Q'), 'people in the group who are not our team are listed: ' + names(tom).join(', '));
  ok(!names(tom).some((n) => ['Sam Staff', 'Dan Disp', 'Rita on web', 'Some Bot'].includes(n)), 'our team, a dispatcher, a website user and bots are left out');
  const busy = c[tom].people.find((p) => p.name === 'Busy Bee');
  ok(busy && busy.likelyTeam && busy.groups === 6, 'someone in 6 groups is listed as probably our team');
  ok(c[tom].people[0].name === 'Tommy W' && c[tom].people.find((p) => p.name === 'Tommy W').messages === 2 && /CDL/.test(c[tom].people[0].last.text), 'the newest writer first, with the count and last message');
  ok(c[ann].linked.length === 1 && c[ann].linked[0].name === 'Ann W', 'an account already linked shows as the driver');
  ok(whois.toAsk(c[tom]).map((p) => p.name).join() === 'Tommy W,Mary W', '"Who is the driver?" asks about those who wrote, not the silent one or likely team');
  ok(whois.toAsk(c[ann]).length === 0, 'nothing is asked when the driver is already linked');

  // the lead page
  let r = await R(`/api/drivers/${tom}/tg-people`);
  ok(r.status === 200 && r.people.length === 4 && r.ask.length === 2, 'the recruiter gets the list for their lead');
  r = await R(`/api/drivers/${tom}/tg-people`, { tgId: String(P.staff), is: 'driver' });
  ok(r.status === 400, 'someone from our team cannot be picked');
  r = await R(`/api/drivers/${tom}/tg-people`, { tgId: String(P.wife), is: 'driver' });
  ok(r.status === 200 && (await q('SELECT role, driver_id FROM tg_people WHERE tg_id = $1', [P.wife])).rows[0].driver_id === tom, 'picking an account makes it the driver');
  r = await R(`/api/drivers/${tom}/tg-people`, { tgId: String(P.tommy), is: 'driver' });
  const wife = (await q('SELECT role, driver_id FROM tg_people WHERE tg_id = $1', [P.wife])).rows[0];
  ok(r.unlinked === 1 && !wife.role && !wife.driver_id && await whois.ruledOut(tom, P.wife), 'picking another one unlinks the first and rules them out');
  ok((await q("SELECT 1 FROM driver_events WHERE driver_id = $1 AND text LIKE 'Telegram: Tommy W is the driver%'", [tom])).rows.length === 1, "the choice is in the driver's history");
  r = await R(`/api/drivers/${tom}/tg-people`);
  ok(r.people[0].linked && r.people[0].name === 'Tommy W' && r.ask.length === 0, 'the picker shows the driver, and nothing is asked');
  r = await R(`/api/drivers/${tom}/tg-people`, { tgId: String(P.tommy), is: 'not' });
  ok(r.status === 200 && !(await q('SELECT role FROM tg_people WHERE tg_id = $1', [P.tommy])).rows[0].role, '"Not the driver" unlinks');
  r = await R(`/api/drivers/${tom}/tg-people`);
  ok(r.ask.length === 0 && r.people.find((p) => p.name === 'Tommy W').notDriver, 'people ruled out are no longer asked about');
  await q('UPDATE tg_people SET role = NULL, driver_id = NULL WHERE tg_id = ANY($1::bigint[])', [[P.tommy, P.wife]]);
  await q('DELETE FROM tg_not_driver WHERE driver_id = $1', [tom]);
  r = await R(`/api/drivers/${tom}/tg-people`, { none: true });
  ok(r.status === 200 && await whois.ruledOut(tom, P.tommy) && await whois.ruledOut(tom, P.wife) && !(await whois.ruledOut(tom, P.quiet)), '"None of them" rules out everyone asked about');

  // the bot's own guesses respect it
  const onbSql = "UPDATE tg_people SET role = 'driver', driver_id = $2 WHERE tg_id = $1 AND role IS NULL AND NOT EXISTS (SELECT 1 FROM tg_not_driver n WHERE n.tg_id = $1 AND n.driver_id = $2) RETURNING tg_id";
  const src = require('fs').readFileSync(__dirname + '/../src/tg/onboard.js', 'utf8') + require('fs').readFileSync(__dirname + '/../src/tg/acct.js', 'utf8');
  ok((src.match(/NOT EXISTS \(SELECT 1 FROM tg_not_driver n WHERE n\.tg_id = \$1 AND n\.driver_id = \$2\)/g) || []).length === 2, 'both first-name guesses check "not the driver"');
  ok(!(await q(onbSql, [P.tommy, tom])).rows.length && (await q(onbSql, [P.quiet, tom])).rows.length === 1, 'a guess skips someone ruled out, and still links someone who is not');

  // the onboarding board
  await q('UPDATE tg_people SET role = NULL, driver_id = NULL WHERE tg_id = $1', [P.quiet]);
  await q('DELETE FROM tg_not_driver WHERE driver_id = $1', [tom]);
  r = await R('/api/onboarding');
  const row = (r.drivers || []).find((d) => d.id === tom), annRow = (r.drivers || []).find((d) => d.id === ann);
  ok(row && row.whoDriver.map((p) => p.name).join() === 'Tommy W,Mary W' && /CDL/.test(row.whoDriver[0].last.text), 'the onboarding board asks "Who is the driver?" with their last words');
  ok(annRow && annRow.whoDriver.length === 0, 'not for a driver already linked');

  // likely team on the People tab
  r = await admin('/api/tg/people');
  ok((r.likelyTeam || []).some((x) => x.name === 'Busy Bee' && x.groups === 6), 'People lists Busy Bee as probably our team');
  r = await R('/api/tg/people/' + P.busy + '/not-team', {});
  ok(r.status === 403, 'only an admin dismisses');
  await admin('/api/tg/people/' + P.busy + '/not-team', {});
  r = await admin('/api/tg/people');
  ok(!(r.likelyTeam || []).some((x) => x.name === 'Busy Bee'), '"Not our team" stops suggesting them');
  c = await whois.candidates([tom]);
  ok(!c[tom].people.find((p) => p.name === 'Busy Bee').likelyTeam, 'and they can be asked about as a driver again');
  await admin('/api/tg/people/' + P.quiet, { role: 'staff' }, 'PATCH');
  c = await whois.candidates([tom]);
  ok(!c[tom].people.some((p) => p.name === 'Quiet Q'), 'someone marked our team leaves the list');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
