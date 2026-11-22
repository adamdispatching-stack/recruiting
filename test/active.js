// Test of active drivers: working period, CDL and medical card expiry, home time, leaving.
//   node test/active.js http://localhost:3999 admin@example.com password
const [, , base = 'http://localhost:3999', email = 'admin@example.com', pw = 'test-password-123'] = process.argv;
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
const uniq = Date.now().toString().slice(-6);
const add = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

(async () => {
  const A = session(); await A('/api/login', { method: 'POST', body: { email, password: pw } });
  const today = (await A('/api/me')).body.today;
  // working period on a new lead
  let r = await A('/api/drivers', { method: 'POST', body: { name: `Wes Period ${uniq}`, source: 'Referral', mode: 'Company drivers', weeksOut: '3', daysHome: '4' } });
  const id = r.body.id; let d = (await A('/api/drivers/' + id)).body.driver;
  ok(d.weeksOut === 3 && d.daysHome === 4, 'working period saved with the lead: 3 weeks out, 4 days home');
  ok((await A('/api/drivers', { method: 'POST', body: { name: 'X', source: 'Referral', weeksOut: '40', force: true } })).status === 400, '40 weeks out is refused');
  ok((await A('/api/drivers/' + id, { method: 'PATCH', body: { daysHome: '2.5' } })).status === 400, 'days home must be a whole number');
  ok((await A('/api/drivers/' + id, { method: 'PATCH', body: { leftOn: today } })).status === 400, 'a driver not hired cannot be marked as left');

  // hire, with a fleet truck
  const truck = (await A('/api/trucks', { method: 'POST', body: { unit: `A${uniq}` } })).body.id;
  await A('/api/drivers/' + id, { method: 'PATCH', body: { status: 'Onboarding' } });
  await A(`/api/drivers/${id}/onboarding`, { method: 'PATCH', body: { truckId: truck } });
  await A('/api/drivers/' + id, { method: 'PATCH', body: { status: 'Hired' } });
  r = await A('/api/active'); let a = r.body.drivers.find((x) => x.id === id);
  ok(!!a && a.truck && a.truck.unit === `A${uniq}` && a.weeksOut === 3, 'hired driver is on the active list with truck and working period');

  // documents and home time
  ok((await A('/api/drivers/' + id, { method: 'PATCH', body: { cdlExpires: '2027-02-30' } })).status === 400, 'an impossible date is refused');
  r = await A('/api/drivers/' + id, { method: 'PATCH', body: { cdlExpires: add(today, 12), medExpires: add(today, -3), outSince: add(today, -19) } });
  ok(r.status === 200, 'CDL, medical card and out-since dates saved');
  a = (await A('/api/active')).body.drivers.find((x) => x.id === id);
  ok(a.cdlExpires === add(today, 12) && a.medExpires === add(today, -3) && a.outSince === add(today, -19), 'dates read back as entered');
  r = await A('/api/drivers/' + id); ok(r.body.events.some((e) => /^CDL expires [A-Z][a-z]{2} \d+, \d{4}$/.test(e.text)) && r.body.events.some((e) => /^Medical card expires/.test(e.text)), 'history says which date changed, with the year');
  r = await A('/api/dashboard'); const att = r.body.attention;
  ok(att.activeDrivers >= 1 && att.expiring >= 1 && att.dueHome >= 1, `dashboard counts: ${att.activeDrivers} active, ${att.expiring} expiring, ${att.dueHome} due home, ${att.missingDocs} missing dates`);

  // leaving
  r = await A('/api/drivers/' + id, { method: 'PATCH', body: { leftOn: today, leftReason: 'Went to another carrier' } });
  ok(r.status === 200, 'marked as left');
  r = await A('/api/active');
  ok(!r.body.drivers.some((x) => x.id === id) && r.body.left.some((x) => x.id === id && x.leftReason === 'Went to another carrier'), 'off the active list, on the recently left list with the reason');
  const t = (await A('/api/trucks')).body.trucks.find((x) => x.id === truck); ok(t.state === 'empty', 'their fleet truck is free again');
  r = await A('/api/drivers/' + id, { method: 'PATCH', body: { leftOn: null } });
  ok((await A('/api/active')).body.drivers.some((x) => x.id === id), 'active again');

  // a recruiter limited to their own leads sees only their own active drivers
  await A('/api/settings', { method: 'PUT', body: { visibility: 'own' } });
  const mail = `act${uniq}@example.com`;
  await A('/api/users', { method: 'POST', body: { name: 'Act Rec', email: mail, password: 'act-password-123', role: 'member' } });
  const R = session(); await R('/api/login', { method: 'POST', body: { email: mail, password: 'act-password-123' } });
  r = await R('/api/active'); ok(r.status === 403, 'active drivers are the dispatch team\'s: a recruiter cannot open them');
  await A('/api/settings', { method: 'PUT', body: { visibility: 'all' } });
  console.log(failed ? `\n${failed} failed` : '\nAll passed');
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
