// Test of the daily challenge: progress against the Facebook targets, the streak (days off don't break it), best streak, and the Facebook badges.
// Needs DATABASE_URL (it writes back-dated entries straight into the database).
//   DATABASE_URL=... node test/challenge.js http://localhost:3999 admin@example.com password
const [, , base = 'http://localhost:3999', email = 'admin@example.com', pw = 'test-password-123'] = process.argv;
const db = require('../src/db');
function session() {
  let cookie = '';
  return async (path, opts = {}) => {
    const r = await fetch(base + path, { method: opts.method || 'GET', headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, body: j };
  };
}
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const u = Date.now().toString().slice(-5);
(async () => {
  await db.migrate();
  const A = session(); await A('/api/login', { method: 'POST', body: { email, password: pw } });
  const before = (await A('/api/settings')).body.fbTargets;
  await A('/api/settings', { method: 'PUT', body: { fbTargets: { post: 0, comment: 0, contact: 2, chat: 1, ppost: 0, pcomment: 0 } } });
  const em = `gil${u}@example.com`;
  const id = (await A('/api/users', { method: 'POST', body: { name: `Gil Goal${u}`, email: em, password: 'goal-pass-1234' } })).body.id;
  await A(`/api/team/${id}/hours`, { method: 'PUT', body: { week: Array.from({ length: 7 }, () => ({ s: '00:00', e: '23:59' })) } });
  await db.q(`UPDATE users SET created_at = now() - interval '40 days' WHERE id = $1`, [id]);
  const today = (await db.q(`SELECT (now() AT TIME ZONE $1)::date::text d`, [db.settings.tz])).rows[0].d;
  const day = (n) => (n === 0 ? today : new Date(Date.parse(today + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10));
  let k = 0;
  const met = async (n) => { // a past day with every target met
    for (const kind of ['contact', 'contact', 'chat']) { k++; await db.q(`INSERT INTO fb_entries (user_id, day, kind, link, link_key) VALUES ($1, $2, $3, $4, $4)`, [id, day(n), kind, `https://www.facebook.com/t${u}x${k}`]); }
  };
  // 10..6 days ago met (5 in a row), 5 missed, 4 met, 3 a day off, 2 and 1 met
  for (const n of [10, 9, 8, 7, 6, 4, 2, 1]) await met(n);
  await A(`/api/team/${id}/days/${day(3)}`, { method: 'PUT', body: { reason: 'Doctor' } });
  // half a day 5 days ago does not count
  await db.q(`INSERT INTO fb_entries (user_id, day, kind, link, link_key) VALUES ($1, $2, 'chat', $3, $3)`, [id, day(5), `https://m.me/j/${u}half`]);

  const R = session(); await R('/api/login', { method: 'POST', body: { email: em, password: 'goal-pass-1234' } });
  let g = (await R('/api/challenge')).body;
  ok(g.on && g.target === 3 && g.done === 0 && g.pct === 0 && !g.met, 'today: 0 of 3 done');
  ok(g.kinds.length === 2 && g.kinds.every((x) => x.k === 'contact' || x.k === 'chat'), 'only kinds with a target are in the challenge');
  ok(g.streak === 3, `streak 3: yesterday, the day before, the day off skipped, 4 days ago (got ${g.streak})`);
  ok(g.best === 5, `best streak 5 (got ${g.best})`);
  ok(g.atStake, 'the streak is at stake today');
  const bd = (await R('/api/badges')).body; const fire = bd.badges.find((x) => x.id === 'on_fire');
  ok(fire.have === 5 && fire.level === 2 && fire.levelName === 'Silver' && fire.next === 10, 'badge "On fire": best streak 5 is Silver (Bronze at 3), Gold at 10');
  ok(g.recent.length === 14 && g.recent[13].s === 'today' && g.recent[12].s === 'met' && g.recent[10].s === 'skip' && g.recent[8].s === 'miss', 'the two-week strip: met, day off, missed, today');
  ok(g.team.some((p) => p.me && p.pct === 0), 'the team list shows me at 0%');

  // today's work, logged on the site
  const add = (body) => R('/api/fb/entries', { method: 'POST', body });
  ok((await add({ kind: 'contact', link: `https://www.facebook.com/profile.php?id=${u}01`, personName: 'Ann' })).status === 200, 'driver 1 logged');
  g = (await R('/api/challenge')).body;
  ok(g.done === 1 && g.pct === 33 && !g.met && g.streak === 3, '1 of 3 done, streak not yet counted for today');
  ok((await add({ kind: 'contact', link: `https://www.facebook.com/profile.php?id=${u}02`, personName: 'Bob' })).status === 200, 'driver 2 logged');
  ok((await add({ kind: 'chat', groupName: 'NJ drivers', link: `https://m.me/j/${u}today` })).status === 200, 'group chat logged');
  g = (await R('/api/challenge')).body;
  ok(g.met && g.pct === 100 && g.streak === 4 && g.best === 5 && !g.atStake, 'all done: streak 4');
  ok(g.month.met >= 1 && g.recent[13].s === 'met', 'today shows as met');
  ok(g.team.some((p) => p.me && p.met), 'the team list shows me done');
  const beat = (await R('/api/beat', { method: 'POST', body: { active: true, visible: true } })).body;
  ok(beat.goal && beat.goal.streak === 4 && beat.goal.met && beat.goal.team === undefined, 'the heartbeat brings the ring (light)');

  // others
  ok((await R(`/api/challenge?user=${(await A('/api/me')).body.id}`)).status === 403, 'a recruiter cannot see another person');
  ok((await A(`/api/challenge?user=${id}`)).body.streak === 4, 'the admin sees her streak');
  const T = (await A('/api/fb/team')).body.people.find((p) => p.id === id);
  ok(T && T.streak === 4 && T.best === 5, 'the admin Facebook team page shows streak 4, best 5');
  ok((await A('/api/beat', { method: 'POST', body: { active: true, visible: true } })).body.goal === null, 'admins have no ring');

  // targets off: no challenge
  await A('/api/settings', { method: 'PUT', body: { fbTargets: { post: 0, comment: 0, contact: 0, chat: 0, ppost: 0, pcomment: 0 } } });
  ok((await R('/api/challenge')).body.on === false, 'no targets set: no challenge');
  await A('/api/settings', { method: 'PUT', body: { fbTargets: before } });
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
