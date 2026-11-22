// Recruiters add and edit companies and trucks (only admins remove them); "Ran Amazon Relay before".
//   node test/recruiter-edit.js http://localhost:3999 admin@example.com password
const [, , base = 'http://localhost:3999', email = 'admin@example.com', pw = 'test-password-123'] = process.argv;
function session() {
  let cookie = '';
  return async (path, opts = {}) => {
    const r = await fetch(base + path, { method: opts.method || 'GET', headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, body: j };
  };
}
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const u = Date.now().toString().slice(-5);
(async () => {
  const A = session(); await A('/api/login', { method: 'POST', body: { email, password: pw } });
  await A('/api/users', { method: 'POST', body: { name: `Rae Recruiter ${u}`, email: `rae${u}@example.com`, password: 'rae-pass-12345' } });
  const R = session(); await R('/api/login', { method: 'POST', body: { email: `rae${u}@example.com`, password: 'rae-pass-12345' } });
  let r = await R('/api/companies', { method: 'POST', body: { name: `Rae Freight ${u}`, mc: '123456' } });
  const co = r.body.id; ok(r.status === 200 && co, 'a recruiter adds a company');
  ok((await R('/api/companies/' + co, { method: 'PATCH', body: { notes: 'Pays on Fridays' } })).status === 200, 'and edits it');
  ok((await R('/api/trucks', { method: 'POST', body: { unit: `R${u}`, companyId: co } })).status === 403 && (await R('/api/trucks')).status === 403, 'trucks are the dispatch team\'s: a recruiter cannot add or open them');
  ok((await R('/api/companies/' + co, { method: 'DELETE' })).status === 403, 'removing a company is for admins only');
  // Relay before
  r = await R('/api/drivers', { method: 'POST', body: { name: `Rita Relay ${u}`, source: 'Indeed', phone: '484555' + u.slice(-4), relayBefore: 'yes' } });
  let d = (await R('/api/drivers/' + r.body.id)).body;
  ok(d.driver.relayBefore === true, 'set when the lead is added');
  await R('/api/drivers/' + r.body.id, { method: 'PATCH', body: { relayBefore: 'no' } }); d = (await R('/api/drivers/' + r.body.id)).body;
  ok(d.driver.relayBefore === false && d.events.some((e) => /Ran Amazon Relay before: no/.test(e.text)), 'changed on the lead, and logged');
  await R('/api/drivers/' + r.body.id, { method: 'PATCH', body: { relayBefore: '' } }); d = (await R('/api/drivers/' + r.body.id)).body;
  ok(d.driver.relayBefore === null, 'can be set back to not known');
  // from the chat (the extension)
  const key = (await A('/api/keys', { method: 'POST', body: { name: 'Relay test ' + u } })).body.key;
  await A('/api/ext/push', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: { drivers: [
    { name: `Yan Yes ${u}`, phones: ['267555' + u.slice(-4)], status: 'Interested', answers: { relay: 'Yeah ran relay loads for 2 years' }, updatedAt: new Date().toISOString() },
    { name: `Nia No ${u}`, phones: ['215555' + u.slice(-4)], status: 'Interested', answers: { relay: 'Never, first time' }, updatedAt: new Date().toISOString() }] } });
  const find = async (n) => ((await A('/api/drivers?q=' + encodeURIComponent(n))).body.drivers || []).find((d) => d.name === n); // by exact name: the search also matches phone digits
  ok((await find(`Yan Yes ${u}`)).relayBefore === true && (await find(`Nia No ${u}`)).relayBefore === false, 'read from the driver\'s chat answer');
})().catch((e) => { console.log('ERROR', e); process.exitCode = 1; });
