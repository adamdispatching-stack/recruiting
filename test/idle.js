// Test of idle time: stretches of 15+ minutes with no activity in working hours, and the alert after an hour.
// Needs DATABASE_URL (it moves the last activity time back instead of waiting).
//   DATABASE_URL=... node test/idle.js http://localhost:3999 admin@example.com password
const [, , base = 'http://localhost:3999', email = 'admin@example.com', pw = 'test-password-123'] = process.argv;
const db = require('../src/db');
const idle = require('../src/idle');
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
  // the test needs a working day that began over 70 minutes ago: just after midnight in the team's time zone it uses
  // a zone where it is the middle of the day (the idle time is counted inside working hours only)
  const hourIn = (z) => +new Date().toLocaleString('en-US', { timeZone: z, hour: 'numeric', hourCycle: 'h23' });
  const zone = [db.settings.tz, 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Asia/Kolkata', 'America/Los_Angeles'].find((z) => hourIn(z) >= 3 && hourIn(z) < 21);
  if (zone !== db.settings.tz) { await A('/api/settings', { method: 'PUT', body: { tz: zone } }); db.settings.tz = zone; }
  const em = `idle${u}@example.com`;
  const id = (await A('/api/users', { method: 'POST', body: { name: `Ivy Idle${u}`, email: em, password: 'idle-pass-1234' } })).body.id;
  await A(`/api/team/${id}/hours`, { method: 'PUT', body: { week: Array.from({ length: 7 }, () => ({ s: '00:00', e: '23:59' })) } });
  const R = session(); await R('/api/login', { method: 'POST', body: { email: em, password: 'idle-pass-1234' } });
  await R('/api/beat', { method: 'POST', body: { active: true, visible: true } });
  const spells = async () => (await db.q(`SELECT * FROM idle_spells WHERE user_id = $1 ORDER BY started_at`, [id])).rows;
  // 10 minutes quiet: not idle yet
  await db.q(`UPDATE users SET last_active_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
  await idle.tick();
  ok((await spells()).length === 0, '10 minutes without activity is not counted');
  // 25 minutes quiet: an idle stretch, no alert yet
  await db.q(`UPDATE users SET last_active_at = now() - interval '25 minutes' WHERE id = $1`, [id]);
  await idle.tick();
  let s = await spells();
  ok(s.length === 1 && s[0].open && !s[0].notified_at, '25 minutes: idle, still going, no alert yet');
  // 70 minutes quiet: alert to the person and the admins
  await db.q(`UPDATE users SET last_active_at = now() - interval '70 minutes' WHERE id = $1`, [id]);
  await db.q(`DELETE FROM idle_spells WHERE user_id = $1`, [id]);
  await idle.tick(); await idle.tick();
  s = await spells();
  ok(s.length === 1 && s[0].notified_at, '70 minutes: the alert went out once');
  const mine = (await db.q(`SELECT * FROM notices WHERE user_id = $1`, [id])).rows;
  const adminN = (await A('/api/notices')).body.notices.filter((n) => n.text.includes(`Ivy Idle${u}`));
  ok(mine.length === 1 && /1 hour 10 min/.test(mine[0].text), 'the person got an alert: ' + (mine[0] || {}).text);
  ok(adminN.length === 1 && /Ivy Idle/.test(adminN[0].text) && adminN[0].link === `#/team/${id}`, 'the admin got an alert with a link to the person');
  // back to work: the stretch closes, and the beat brings the alert to the page
  const b = await R('/api/beat', { method: 'POST', body: { active: true, visible: true } });
  s = await spells();
  ok(!s[0].open && Math.abs((new Date(s[0].ended_at) - new Date(s[0].started_at)) / 60000 - 70) < 2, 'activity again: the 70-minute stretch is closed');
  ok(b.body.notices && b.body.notices.length === 1, 'the page gets the alert with the next beat');
  await R('/api/notices/seen', { method: 'POST', body: { ids: [b.body.notices[0].id] } });
  ok(((await R('/api/beat', { method: 'POST', body: { active: true, visible: true } })).body.notices || []).length === 0, 'dismissed alerts do not come back');
  // the report
  const rep = (await A(`/api/team/${id}/month`)).body;
  const today = rep.days.find((d) => d.date === rep.today);
  ok(today && today.idle >= 69 * 60 && today.idles.length === 1 && today.idles[0].alerted && rep.totals.idle === today.idle, 'monthly report: idle time and the stretch on today');
  const team = (await A('/api/team?period=today')).body.people.find((p) => p.id === id);
  ok(team.att.idle >= 69 * 60, 'team table: idle time');
  // not started today: nothing counts
  await db.q(`UPDATE users SET last_active_at = now() - interval '2 days' WHERE id = $1`, [id]);
  const before = (await spells()).length; await idle.tick();
  ok((await spells()).length === before, 'someone who has not started today is not idle (that is a late start)');
  // a day off: nothing counts
  await A(`/api/team/${id}/days/${rep.today}`, { method: 'PUT', body: { reason: 'test' } });
  await db.q(`UPDATE users SET last_active_at = now() - interval '30 minutes' WHERE id = $1`, [id]);
  await idle.tick();
  ok((await spells()).length === before, 'nothing counts on an approved day off');
  // settings
  ok((await A('/api/settings', { method: 'PUT', body: { hours: { ...rep.hours, week: rep.teamWeek, idleMinutes: 3 } } })).status === 400, 'idle after less than 5 minutes is refused');
  const r2 = await A('/api/settings', { method: 'PUT', body: { hours: { ...rep.hours, week: rep.teamWeek, idleMinutes: 20, idleAlert: 90 } } });
  ok(r2.status === 200 && r2.body.hours.idleMinutes === 20 && r2.body.hours.idleAlert === 90, 'idle and alert minutes saved');
  await A('/api/settings', { method: 'PUT', body: { hours: { ...rep.hours, week: rep.teamWeek, idleMinutes: 15, idleAlert: 60 } } });
  await db.pool.end();
})().catch((e) => { console.log('ERROR', e); process.exitCode = 1; });
