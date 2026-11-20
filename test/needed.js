// Test: a driver verified on Amazon needs an arrival date; arriving within 3 days, a company and a truck. The recruiter is told.
//   node test/needed.js http://localhost:3999 admin@example.com password
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
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const u = Date.now().toString().slice(-5); const w = u.replace(/\d/g, (x) => 'abcdefghij'[x]);
(async () => {
  const A = session(); await A('/api/login', { method: 'POST', body: { email, password: pw } });
  await A('/api/settings', { method: 'PUT', body: { share: { on: false, people: null } } });
  const rid = (await A('/api/users', { method: 'POST', body: { name: `Nina Need ${w}`, email: `nina${u}@example.com`, password: 'nina-pass-1234' } })).body.id;
  const R = session(); await R('/api/login', { method: 'POST', body: { email: `nina${u}@example.com`, password: 'nina-pass-1234' } });
  const add = async (name, mode, owner) => { const r = await A('/api/drivers', { method: 'POST', body: { name, source: 'Indeed', phone: '215555' + String(Math.floor(Math.random() * 9000) + 1000), mode, ownerId: owner } }); return r.body.id; };
  const today = (await A('/api/onboarding')).body.today;
  const plus = (n) => new Date(Date.parse(today + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const ruby = await add(`Ruby Ready ${w}`, 'Company drivers', rid);
  const olly = await add(`Olly Owner ${w}`, 'Owner-operators', rid);
  const pat = await add(`Pat Pending ${w}`, 'Company drivers', rid);
  for (const x of [ruby, olly, pat]) await A('/api/drivers/' + x, { method: 'PATCH', body: { status: 'Onboarding' } });
  await A('/api/drivers/' + pat, { method: 'PATCH', body: { amazonStep: 'profile' } });
  const need = async (id) => (await R('/api/onboarding')).body.drivers.find((d) => d.id === id).needed;
  const mine = async () => (await R('/api/notices')).body.notices.filter((n) => n.kind === 'needed');
  ok((await need(ruby)).length === 0, 'not verified yet: nothing asked');
  await A('/api/drivers/' + ruby, { method: 'PATCH', body: { amazonStep: 'verified' } });
  ok(JSON.stringify(await need(ruby)) === '["arrival date"]', 'verified on Amazon with no arrival date: the arrival date is needed');
  let n = await mine();
  ok(n.length === 1 && n[0].text === `Ruby Ready ${w} is verified on Amazon: set the arrival date` && n[0].link === `#/driver/${ruby}`, 'her recruiter is told: ' + (n[0] || {}).text);
  const list = (await R('/api/onboarding')).body.drivers.map((d) => d.id);
  ok(list.indexOf(ruby) < list.indexOf(pat) && list.indexOf(ruby) < list.indexOf(olly), 'verified drivers come first in the onboarding list');
  // arriving in 2 days: company and truck
  await A(`/api/drivers/${ruby}/onboarding`, { method: 'PATCH', body: { expectedArrival: plus(2) } });
  ok(JSON.stringify(await need(ruby)) === '["company","truck"]', 'arriving in 2 days: the company and the truck are needed');
  n = await mine();
  ok(n.length === 1 && /arrives .*: set the company and truck$/.test(n[0].text), 'the notification is brought up to date (one, not two): ' + (n[0] || {}).text);
  await R('/api/notices/seen', { method: 'POST', body: {} });
  await A('/api/drivers/' + ruby, { method: 'PATCH', body: { followUp: plus(1) } });
  ok((await mine()).filter((x) => !x.seen_at).length === 0, 'not told again the same day for the same thing');
  // arriving in 10 days: nothing yet
  await A(`/api/drivers/${ruby}/onboarding`, { method: 'PATCH', body: { expectedArrival: plus(10) } });
  ok((await need(ruby)).length === 0, 'arriving in 10 days: nothing needed yet');
  await A(`/api/drivers/${ruby}/onboarding`, { method: 'PATCH', body: { expectedArrival: plus(1) } });
  const co = (await A('/api/companies', { method: 'POST', body: { name: `Need Co ${w}` } })).body.id;
  await A('/api/drivers/' + ruby, { method: 'PATCH', body: { companyId: co } });
  ok(JSON.stringify(await need(ruby)) === '["truck"]', 'company set: only the truck left');
  const tk = (await A('/api/trucks', { method: 'POST', body: { unit: `N${u}` } })).body.id;
  await A(`/api/drivers/${ruby}/onboarding`, { method: 'PATCH', body: { truckId: tk } });
  ok((await need(ruby)).length === 0, 'truck set: nothing needed');
  ok(((await R('/api/drivers/' + ruby)).body.needed || []).length === 0, 'the lead page agrees');
  // owner-operator: their own truck
  await A('/api/drivers/' + olly, { method: 'PATCH', body: { amazonStep: 'verified', companyId: co } });
  await A(`/api/drivers/${olly}/onboarding`, { method: 'PATCH', body: { expectedArrival: today } });
  ok(JSON.stringify(await need(olly)) === '["their truck (year and model)"]', 'owner-operator arriving today: their truck must be noted');
  ok(JSON.stringify((await R('/api/drivers/' + olly)).body.needed) === '["their truck (year and model)"]', 'and the lead page shows it');
  await A('/api/drivers/' + olly, { method: 'PATCH', body: { truckYear: '2021', truckModel: 'Freightliner Cascadia' } });
  ok((await need(olly)).length === 0, 'their truck noted: nothing needed');
  // nobody has the lead: the admins are told
  const nob = await add(`Nobo Dee ${w}`, 'Company drivers', null);
  await A('/api/drivers/' + nob, { method: 'PATCH', body: { status: 'Onboarding' } });
  await A('/api/drivers/' + nob, { method: 'PATCH', body: { amazonStep: 'verified' } });
  ok((await A('/api/notices')).body.notices.some((x) => x.kind === 'needed' && x.text.startsWith(`Nobo Dee ${w}`)), 'no recruiter on the lead: the admin is told');
})().catch((e) => { console.error(e); process.exit(1); });
