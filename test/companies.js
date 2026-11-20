// Test of companies, trucks by company, and the new lead fields (driver type, experience, own truck).
//   node test/companies.js http://localhost:3999 admin@example.com password
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

(async () => {
  const A = session(); await A('/api/login', { method: 'POST', body: { email, password: pw } });
  // ---------- companies ----------
  let r = await A('/api/companies', { method: 'POST', body: { name: '' } }); ok(r.status === 400, 'a company needs a name');
  r = await A('/api/companies', { method: 'POST', body: { name: `Bobtail Trucking ${uniq}`, mc: 'MC 123-456', dot: '4036185' } });
  const bob = r.body.id; ok(!!bob, 'company added');
  r = await A('/api/companies', { method: 'POST', body: { name: `bobtail trucking ${uniq}` } }); ok(r.status === 400 && /already/.test(r.body.error), 'the same name twice is refused');
  const cmj = (await A('/api/companies', { method: 'POST', body: { name: `CMJ CO ${uniq}`, color: 3 } })).body.id;
  r = await A('/api/me'); ok(r.body.companies.some((c) => c.id === bob) && r.body.companies.find((c) => c.id === cmj).color === 3, 'companies come with /api/me, with their color');
  r = await A('/api/companies/' + bob); ok(r.body.company.mc === 'MC123-456' && r.body.company.dot === '4036185', 'MC and DOT kept as typed, without spaces');

  // ---------- trucks by company ----------
  const t1 = (await A('/api/trucks', { method: 'POST', body: { unit: `B${uniq}1`, details: '2021 Freightliner Cascadia', companyId: bob } })).body.id;
  const t2 = (await A('/api/trucks', { method: 'POST', body: { unit: `C${uniq}2`, companyId: cmj } })).body.id;
  ok((await A('/api/trucks', { method: 'POST', body: { unit: `X${uniq}`, companyId: 999999 } })).status === 400, 'a truck cannot get a company that does not exist');
  r = await A('/api/trucks'); ok(r.body.trucks.find((t) => t.id === t1).companyId === bob, 'trucks list their company');

  // ---------- a lead with the new fields ----------
  r = await A('/api/drivers', { method: 'POST', body: { name: `Oscar Owner ${uniq}`, phone: `609555${uniq.slice(-4)}`, source: 'Facebook', mode: 'Owner-operators', location: 'Trenton, NJ', zip: '08608', expYears: '7.5', experience: 'Dry van OTR, Amazon loads', truckYear: '2019', truckModel: 'Volvo VNL 860', companyId: cmj } });
  const oo = r.body.id; ok(!!oo, 'owner operator added with experience, own truck and company');
  let d = (await A('/api/drivers/' + oo)).body.driver;
  ok(d.mode === 'Owner-operators' && d.expYears === 7.5 && d.experience === 'Dry van OTR, Amazon loads' && d.truckYear === 2019 && d.truckModel === 'Volvo VNL 860' && d.companyId === cmj && d.zip === '08608', 'all saved and read back');
  r = await A('/api/drivers', { method: 'POST', body: { name: `Carl Company ${uniq}`, source: 'Referral', mode: 'Company drivers', expYears: '2', truckYear: '2020', truckModel: 'Should not stay' } });
  const cd = r.body.id; d = (await A('/api/drivers/' + cd)).body.driver;
  ok(d.truckYear === null && d.truckModel === null && d.expYears === 2, 'a company driver keeps no own truck');
  ok((await A('/api/drivers', { method: 'POST', body: { name: 'Bad Year', source: 'Referral', mode: 'Owner-operators', truckYear: '1955', force: true } })).status === 400, 'a truck year from 1955 is refused');
  ok((await A('/api/drivers', { method: 'POST', body: { name: 'Bad Exp', source: 'Referral', expYears: '99', force: true } })).status === 400, '99 years of experience is refused');
  ok((await A('/api/drivers', { method: 'POST', body: { name: 'Bad Co', source: 'Referral', companyId: 999999, force: true } })).status === 400, 'an unknown company is refused');
  r = await A(`/api/drivers?company=${cmj}`); ok(r.body.drivers.length === 1 && r.body.drivers[0].id === oo, 'lead list filters by company');
  r = await A(`/api/drivers?q=${encodeURIComponent('volvo vnl')}`); ok(r.body.drivers.some((x) => x.id === oo), 'search finds the truck model');

  // edit
  r = await A('/api/drivers/' + cd, { method: 'PATCH', body: { expYears: '', experience: 'Local reefer' } });
  d = (await A('/api/drivers/' + cd)).body.driver; ok(r.status === 200 && d.expYears === null && d.experience === 'Local reefer', 'experience edited, years cleared');
  ok((await A('/api/drivers/' + cd, { method: 'PATCH', body: { truckYear: 'abc' } })).status === 400, 'a bad truck year is refused on edit');

  // ---------- company follows the truck ----------
  await A('/api/drivers/' + cd, { method: 'PATCH', body: { status: 'Onboarding' } });
  r = await A(`/api/drivers/${cd}/onboarding`, { method: 'PATCH', body: { truckId: t1 } });
  d = (await A('/api/drivers/' + cd)).body.driver; ok(r.status === 200 && d.companyId === bob, "giving the driver Bobtail's truck makes them a Bobtail driver");
  r = await A('/api/drivers/' + cd, { method: 'PATCH', body: { companyId: cmj } });
  ok(r.status === 400 && /belongs to/.test(r.body.error), "the company cannot be changed while the driver has another company's truck");
  r = await A('/api/trucks/' + t1, { method: 'PATCH', body: { companyId: cmj } });
  d = (await A('/api/drivers/' + cd)).body.driver; ok(r.status === 200 && d.companyId === cmj, 'moving the truck to CMJ takes its driver along');
  r = await A(`/api/drivers/${cd}/onboarding`, { method: 'PATCH', body: { truckId: null } });
  r = await A('/api/drivers/' + cd, { method: 'PATCH', body: { companyId: bob } }); ok(r.status === 200, 'without a truck, the company can change');
  r = await A('/api/drivers/' + cd, { method: 'PATCH', body: { companyId: null } }); d = (await A('/api/drivers/' + cd)).body.driver; ok(d.companyId === null, 'and be removed');

  // ---------- company page ----------
  r = await A('/api/companies');
  const c = r.body.companies.find((x) => x.id === cmj);
  ok(c.trucks === 2 && c.empty === 2 && c.inProgress >= 1, `company list counts: ${c.trucks} trucks, ${c.empty} empty`);
  r = await A('/api/companies/' + cmj); ok(r.body.trucks.length === 2 && r.body.drivers.some((x) => x.id === oo && x.ownTruck === '2019 Volvo VNL 860'), "company page lists its trucks and drivers, with an owner operator's own truck");

  // ---------- recruiters ----------
  const mail = `rec${uniq}@example.com`;
  await A('/api/users', { method: 'POST', body: { name: 'Rec Test', email: mail, password: 'rec-password-123', role: 'member' } });
  const R = session(); await R('/api/login', { method: 'POST', body: { email: mail, password: 'rec-password-123' } });
  ok((await R('/api/companies')).status === 200 && (await R('/api/companies/' + bob)).status === 200, 'recruiters can see companies');
  ok((await R('/api/companies', { method: 'POST', body: { name: 'Nope' } })).status === 403 && (await R('/api/companies/' + bob, { method: 'DELETE' })).status === 403, 'but not add or remove them');
  r = await R('/api/drivers', { method: 'POST', body: { name: `Rita Rec ${uniq}`, source: 'Referral', mode: 'Company drivers', companyId: bob } });
  ok(r.status === 200, 'a recruiter can pick the company on a lead');

  // ---------- removing a company ----------
  r = await A('/api/companies/' + cmj, { method: 'DELETE' });
  d = (await A('/api/drivers/' + oo)).body.driver; const tr = (await A('/api/trucks')).body.trucks.find((t) => t.id === t2);
  ok(r.status === 200 && d.companyId === null && tr && tr.companyId === null, 'removing a company keeps its trucks and drivers, without a company');

  console.log(failed ? `\n${failed} failed` : '\nAll passed');
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
