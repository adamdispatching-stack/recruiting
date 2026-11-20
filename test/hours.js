// Test of working hours, days off and the monthly report, against a running server.
// Needs DATABASE_URL (it writes back-dated activity straight into the database).
//   node test/hours.js http://localhost:3999 admin@example.com password
const [, , base = 'http://localhost:3999', email = 'admin@example.com', pw = 'test-password-123'] = process.argv;
const { Client } = require('pg');
function session() {
  let cookie = '';
  return async (path, opts = {}) => {
    const r = await fetch(base + path, { method: opts.method || 'GET', headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, body: j };
  };
}
let failed = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) { failed++; process.exitCode = 1; } };

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: false }); await db.connect();
  const A = session(); await A('/api/login', { method: 'POST', body: { email, password: pw } });
  const TZ = 'America/New_York';
  await A('/api/settings', { method: 'PUT', body: { tz: TZ } });

  // ---------- team hours ----------
  const wk = (s, e) => [null, { s, e }, { s, e }, { s, e }, { s, e }, { s, e }, null];
  let r = await A('/api/settings', { method: 'PUT', body: { hours: { week: wk('09:00', '08:00'), minMinutes: 30, grace: 15 } } });
  ok(r.status === 400 && /after the start/.test(r.body.error), 'end before start is refused');
  r = await A('/api/settings', { method: 'PUT', body: { hours: { week: [null, null], minMinutes: 30, grace: 15 } } });
  ok(r.status === 400, 'a week without 7 days is refused');
  r = await A('/api/settings', { method: 'PUT', body: { hours: { week: wk('09:00', '18:00'), minMinutes: 0, grace: 15 } } });
  ok(r.status === 400, 'a zero minimum is refused');
  r = await A('/api/settings', { method: 'PUT', body: { hours: { week: wk('09:00', '18:00'), minMinutes: 30, grace: 15 } } });
  ok(r.status === 200 && r.body.hours.week[1].s === '09:00' && r.body.hours.week[0] === null, 'team hours saved: Mon to Fri 9 to 6');
  ok((await A('/api/settings')).body.hours.grace === 15, 'and read back');

  // ---------- a recruiter with a history ----------
  const mail = `hana${Date.now()}@example.com`;
  r = await A('/api/users', { method: 'POST', body: { name: 'Hana Test', email: mail, password: 'hana-password-1', role: 'member' } });
  const hid = r.body.id; ok(!!hid, 'recruiter created');
  await db.query(`UPDATE users SET created_at = now() - interval '90 days' WHERE id = $1`, [hid]);
  // last month, worked out in the team time zone
  const lm = (await db.query(`SELECT to_char(date_trunc('month', (now() AT TIME ZONE $1)::date) - interval '1 month', 'YYYY-MM') m`, [TZ])).rows[0].m;
  const days = (await db.query(`SELECT g::date::text d, extract(dow FROM g)::int dow FROM generate_series($1::date, ($1::date + interval '1 month' - interval '1 day'), interval '1 day') g`, [lm + '-01'])).rows;
  const wd = days.filter((x) => x.dow >= 1 && x.dow <= 5);
  const pick = (dow, nth = 0) => days.filter((x) => x.dow === dow)[nth].d;
  const dA = pick(1), dB = pick(2), dC = pick(3), dD = pick(4), dF = pick(5), dE = pick(6);
  // hours h1..h2-1 local with `sec` active each; first and last seen times local
  async function work(d, h1, h2, sec, first, last) {
    for (let h = h1; h < h2; h++) {
      await db.query(`INSERT INTO activity_hours (user_id, hour, active_seconds, open_seconds, clicks, views, first_at, last_at)
        VALUES ($1, ($2::date + make_interval(hours => $3))::timestamp AT TIME ZONE $4, $5, $5, 10, 2,
          ($2::date + (CASE WHEN $3 = $6 THEN $7 ELSE make_interval(hours => $3)::text END)::interval)::timestamp AT TIME ZONE $4,
          ($2::date + (CASE WHEN $3 = $8 - 1 THEN $9 ELSE make_interval(hours => $3, mins => 59)::text END)::interval)::timestamp AT TIME ZONE $4)`,
      [hid, d, h, TZ, sec, h1, first, h2, last]);
    }
  }
  await work(dA, 9, 18, 3000, '09:05', '17:50');   // normal day
  await work(dB, 10, 18, 3000, '10:20', '18:10');  // late start
  await work(dC, 11, 12, 600, '11:00', '11:10');   // 10 minutes: not a worked day
  await work(dF, 9, 15, 3000, '09:00', '15:00');   // left early
  await work(dE, 10, 12, 3000, '10:00', '11:59');  // Saturday: extra day
  await db.query(`INSERT INTO activity (user_id, at, type, detail) VALUES ($1, ($2::date + interval '10 hours')::timestamp AT TIME ZONE $3, 'note', 'x'),
    ($1, ($2::date + interval '11 hours')::timestamp AT TIME ZONE $3, 'contact', 'Call, answered'), ($1, ($2::date + interval '12 hours')::timestamp AT TIME ZONE $3, 'lead_add', 'y')`, [hid, dA, TZ]);

  // approved day off
  r = await A(`/api/team/${hid}/days/${dD}`, { method: 'PUT', body: { reason: 'Doctor' } });
  ok(r.status === 200, 'admin approves a day off');
  ok((await A(`/api/team/${hid}/days/not-a-date`, { method: 'PUT', body: {} })).status === 400, 'a bad date is refused');

  // ---------- the month ----------
  r = await A(`/api/team/${hid}/month?m=${lm}`);
  ok(r.status === 200 && r.body.month === lm && r.body.days.length === days.length, `month report for ${lm} has every day`);
  const t = r.body.totals; const st = (d) => r.body.days.find((x) => x.date === d);
  ok(t.scheduled === wd.length, `working days: ${t.scheduled} = ${wd.length} weekdays`);
  ok(t.worked === 4 && t.extra === 1, `days worked 4 (one of them the Saturday): ${t.worked}, extra ${t.extra}`);
  ok(t.approved === 1 && st(dD).status === 'approved' && st(dD).offReason === 'Doctor', 'approved day off counted on its own, with the reason');
  ok(t.off === wd.length - 3 - 1, `days off: ${t.off} = weekdays without work, minus the approved one`);
  ok(st(dC).status === 'off' && st(dC).active === 600, '10 minutes on a working day is a day off, minutes still shown');
  ok(st(dA).status === 'worked' && !st(dA).late && !st(dA).early && st(dA).first === '09:05', 'normal day: worked, on time, first seen 9:05');
  ok(st(dB).late && t.late === 1, 'started 10:20: late start');
  ok(st(dF).early && t.early === 1, 'left at 3 PM: left early');
  ok(st(dE).status === 'extra' && st(dE).inHours === 0, 'Saturday work is an extra day, none of it inside working hours');
  ok(st(dA).inHours === 27000 && st(dB).inHours === 24000, `active time inside working hours: ${st(dA).inHours}, ${st(dB).inHours}`);
  ok(t.active === 27000 + 24000 + 600 + 18000 + 6000, 'active time adds up');
  ok(t.avgActive === Math.round(t.active / 4), 'average active time per worked day');
  ok(t.notes === 1 && t.calls === 1 && t.added === 1 && st(dA).notes === 1, 'work done is counted per day');
  ok(r.body.weekText === 'Mon to Fri, 9 AM to 6 PM' && r.body.own === false, `hours shown as "${r.body.weekText}"`);
  const before = days[0].d < (await db.query(`SELECT ((now() - interval '90 days') AT TIME ZONE $1)::date::text d`, [TZ])).rows[0].d;
  ok(!before || r.body.days[0].status === 'before', 'days before the account existed are not counted');

  // own hours: Saturday becomes a working day
  r = await A(`/api/team/${hid}/hours`, { method: 'PUT', body: { week: [null, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, { s: '10:00', e: '14:00' }] } });
  ok(r.status === 200, 'admin sets own hours for one person');
  r = await A(`/api/team/${hid}/month?m=${lm}`);
  const sats = days.filter((x) => x.dow === 6).length;
  ok(r.body.own && r.body.totals.scheduled === wd.length + sats && r.body.days.find((x) => x.date === dE).status === 'worked', 'with own hours, Saturdays are working days and that Saturday is worked');
  ok((await A(`/api/team/${hid}/hours`, { method: 'PUT', body: { week: [null, null, null, null, null, null, { s: '14:00', e: '10:00' }] } })).status === 400, 'bad own hours refused');
  await A(`/api/team/${hid}/hours`, { method: 'PUT', body: { week: null } });
  ok((await A(`/api/team/${hid}/month?m=${lm}`)).body.own === false, 'back to the team hours');

  // take back the day off
  await A(`/api/team/${hid}/days/${dD}`, { method: 'DELETE' });
  r = await A(`/api/team/${hid}/month?m=${lm}`);
  ok(r.body.totals.approved === 0 && r.body.days.find((x) => x.date === dD).status === 'off', 'approved day off taken back: it is a day off again');

  // ---------- team table with month periods ----------
  r = await A('/api/team?period=lastmonth');
  const hp = r.body.people.find((p) => p.id === hid);
  ok(r.status === 200 && r.body.days === days.length && hp.att.worked === 4 && hp.att.off === wd.length - 3, `team table, last month: worked ${hp.att.worked}, off ${hp.att.off}`);
  r = await A('/api/team?period=month'); ok(r.status === 200 && r.body.period === 'month', 'team table, this month');
  r = await A('/api/team?period=today'); ok(r.status === 200 && r.body.people.every((p) => p.day && p.day.status), 'team table, today: each person has a day status');

  // ---------- what a recruiter may do ----------
  const H = session(); await H('/api/login', { method: 'POST', body: { email: mail, password: 'hana-password-1' } });
  r = await H(`/api/team/me/month?m=${lm}`); ok(r.status === 200 && r.body.totals.worked === 4, 'recruiter sees their own month');
  ok((await H('/api/team/1/month')).status === 403, "recruiter cannot see someone else's month");
  ok((await H(`/api/team/${hid}/days/${dC}`, { method: 'PUT', body: {} })).status === 403, 'recruiter cannot approve days off');
  ok((await H(`/api/team/${hid}/hours`, { method: 'PUT', body: { week: null } })).status === 403, 'recruiter cannot change hours');
  r = await H('/api/team/me/month?m=garbage'); ok(r.status === 200 && r.body.month === r.body.today.slice(0, 7), 'a bad month falls back to this month');

  await db.end();
  console.log(failed ? `\n${failed} failed` : '\nAll passed');
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
