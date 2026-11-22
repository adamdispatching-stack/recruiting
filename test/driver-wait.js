// The team group's alert: only a driver who got no response. Recruiters and Trucks.
//   bash test/all.sh driver-wait
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const team = require('../src/tg/team');
const q = db.q;
(async () => {
  let n = 0;
  const user = async (name, role) => (await q('INSERT INTO users (email, name, pass_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name.toLowerCase() + '@wait.example.com', name, 'x', role])).rows[0].id;
  const rec = await user('Waitrita', 'member'), disp = await user('Waitdan', 'dispatcher');
  const STAFF = 880001, OTHER = 880002, ELD = 880003;
  for (const [id, name, role] of [[STAFF, 'Sam Staff', 'staff'], [OTHER, 'Pat Passerby', null], [ELD, 'Ed Eld', 'eld']]) await q('INSERT INTO tg_people (tg_id, name, role) VALUES ($1, $2, $3)', [id, name, role]);
  // msgs: [who, hours ago, text, media, imported]
  async function group(name, msgs, { status = 'Onboarding', connected = true, left = false, kind = 'dispatch' } = {}) {
    n++;
    const tg = 881000 + n, chat = -990000 - n;
    const id = (await q('INSERT INTO drivers (name, name_key, status, owner_id) VALUES ($1, $2, $3, $4) RETURNING id', [name, name.toLowerCase(), status, rec])).rows[0].id;
    if (left) await q('UPDATE drivers SET left_on = $2 WHERE id = $1', [id, '2026-11-01']);
    await q('INSERT INTO tg_chats (chat_id, title, kind, driver_id, active) VALUES ($1, $2, $3, $4, true)', [chat, name, kind, id]);
    await q('INSERT INTO tg_people (tg_id, name, role, driver_id) VALUES ($1, $2, $3, $4)', [tg, name, connected ? 'driver' : null, connected ? id : null]);
    let i = 0;
    for (const [who, hours, text, media, imported] of msgs) {
      i++;
      const from = who === 'driver' ? tg : who === 'anon' ? 1087968824 : who === 'bot' || who === 'web' ? 777 : who;
      await q('INSERT INTO tg_messages (chat_id, msg_id, from_id, is_bot, text, media, at, imported) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [chat, i, from, ['anon', 'bot', 'web'].includes(who), text, media || null, new Date(Date.now() - hours * 36e5), !!imported]);
    }
    return { id, chat };
  }
  const D = 'driver', ask = 'where do I pick up the trailer?';
  const cases = [
    ['no response for 4 hours', [[D, 4, ask]], true],
    ['only 2 hours so far', [[D, 2, ask]], false],
    ['the team answered', [[D, 5, ask], [STAFF, 4, 'Yard B']], false],
    ['ELD answered', [[D, 5, ask], [ELD, 4, 'Fixed']], false],
    ['someone not connected yet answered', [[D, 5, ask], [OTHER, 4, 'Yard B']], false],
    ['an admin writing as the group answered', [[D, 5, ask], ['anon', 4, 'Yard B']], false],
    ['a note from the website answered', [[D, 5, ask], ['web', 4, 'Yard B\n(Rita)']], false],
    ['a bot reminder is not a response', [[D, 5, ask], ['bot', 4, 'Reminder: send the papers']], true],
    ['someone joining is not a response', [[D, 5, ask], [OTHER, 4, null]], true],
    ['other people writing are not alerted', [[OTHER, 6, 'Anyone there?']], false],
    ['our message the driver did not answer', [[STAFF, 30, 'Are you there?']], false],
    ['writing again does not restart the wait', [[D, 5, ask], [D, 1, 'hello?']], true],
    ['thanks after a question still waits', [[D, 5, ask], [D, 4, 'thanks']], true],
    ['wrote again after our answer', [[D, 9, ask], [STAFF, 8, 'Yard B'], [D, 4, 'the gate is closed']], true],
    ['ok needs no answer', [[STAFF, 6, 'Send the photo'], [D, 5, 'Ok thanks bro']], false],
    ['an emoji needs no answer', [[D, 5, '👍🏽']], false],
    ['a sticker needs no answer', [[D, 5, null, 'sticker']], false],
    ['a photo waits for an answer', [[D, 5, null, 'photo']], true],
    ['no with more words waits', [[D, 5, 'no fuel card works']], true],
    ['only a question mark waits', [[D, 5, '??']], true],
    ['imported history is not alerted', [[D, 5, ask, null, true]], false],
    ['older than 3 days is not news', [[D, 80, ask]], false],
    ['not connected, same first name', [[D, 5, ask]], true, { connected: false }],
    ['not connected, another person', [[OTHER, 5, ask]], false, { connected: false }],
    ['a working driver', [[D, 5, ask]], true, { status: 'Hired' }],
    ['a driver who left', [[D, 5, ask]], false, { status: 'Hired', left: true }],
    ['a lead', [[D, 5, ask]], false, { status: 'Interested' }],
    ['the ELD group', [[D, 5, ask]], false, { kind: 'eld' }]
  ];
  const made = [];
  for (const [i, [what, msgs, want, opts]] of cases.entries()) made.push({ what, want, ...(await group('Waiter' + i + ' Test', msgs, opts)) });
  const call = await group('Called Back', [[D, 5, ask]]);
  await q('INSERT INTO notes (driver_id, user_id, body, kind, outcome) VALUES ($1, $2, $3, $4, $5)', [call.id, rec, 'Sorted it out', 'call', 'Talked']);
  const draft = await group('Draft Sent', [[D, 5, ask]]);
  await q('INSERT INTO tg_drafts (chat_id, driver_id, draft, state, decided_at) VALUES ($1, $2, $3, $4, now())', [draft.chat, draft.id, 'Yard B', 'sent']);
  const answered = await group('Question Answered', [[D, 5, ask]]);
  await q('INSERT INTO tg_questions (chat_id, driver_id, text, answer, answered_at) VALUES ($1, $2, $3, $4, now())', [answered.chat, answered.id, ask, 'Yard B']);
  const hired = await group('Working Driver', [[D, 5, ask]], { status: 'Hired' });
  await q('INSERT INTO trucks (unit, driver_id, dispatcher_id) VALUES ($1, $2, $3)', ['W-77', hired.id, disp]);

  const items = await team.followups();
  const waits = (id) => items.filter((x) => x.driverId === id && x.key.startsWith('wait:'));
  for (const c of made) ok(waits(c.id).length === (c.want ? 1 : 0), 'alert: ' + c.what);
  ok(!waits(call.id).length, 'alert: a call where they talked is a response');
  ok(!waits(draft.id).length, 'alert: a reply sent from the website is a response');
  ok(!waits(answered.id).length, 'alert: an answered question is a response');
  ok(waits(made[0].id)[0] && waits(made[0].id)[0].userId === rec && /got no response: "where do I pick up/.test(waits(made[0].id)[0].text), 'onboarding: tags the recruiter, quotes the driver');
  ok(waits(hired.id)[0] && waits(hired.id)[0].userId === disp, 'working: tags the dispatcher of the truck');
  ok(!items.some((x) => /silent|unanswered/.test(x.text)), 'no alert about drivers not answering us');

  // recruiters and trucks
  const session = () => { let c = ''; return async (p, body, method) => { const r = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', Cookie: c }, body: body && JSON.stringify(body) }); const k = r.headers.get('set-cookie'); if (k) c = k.split(';')[0]; return { status: r.status, body: await r.json().catch(() => ({})) }; }; };
  const A = session(), R = session();
  await A('/api/login', { email: 'admin@example.com', password: 'test-password-123' });
  await A('/api/users', { name: 'Tina Trucks', email: 'tina@example.com', password: 'tina-pass-12345' });
  await R('/api/login', { email: 'tina@example.com', password: 'tina-pass-12345' });
  const t = await R('/api/trucks', { unit: 'R-501', details: '2023 Cascadia' });
  ok(t.status === 200 && !!t.body.id, 'a recruiter adds a truck');
  const url = '/api/trucks/' + t.body.id;
  ok((await R(url, { location: 'Newark yard' }, 'PATCH')).status === 200, 'and edits it');
  ok((await R(url + '/miles', { odometer: 410000 })).status === 200, 'and updates the mileage');
  const free = await R('/api/fleet/free-drivers');
  ok(free.status === 200 && free.body.drivers.some((d) => d.name.startsWith('Waiter')) && free.body.drivers.every((d) => d.id !== hired.id && Object.keys(d).sort().join() === 'companyId,id,name'), 'the truck form gets free drivers, names only');
  ok((await R(url, undefined, 'DELETE')).status === 403, 'but does not remove a truck');
  ok((await R('/api/fleet/settings', { oilMiles: 20000 }, 'PUT')).status === 403, 'or change the fleet settings');
  ok((await R('/api/active')).status === 403 && (await R('/api/cases')).status === 403, 'active drivers and road cases stay closed');
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
