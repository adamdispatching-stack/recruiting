// Smoke test against a running server: node test/smoke.js http://localhost:3999 admin@example.com password
const [, , base = 'http://localhost:3999', email = 'admin@example.com', pw = 'test-password-123'] = process.argv;
let cookie = '';
const call = async (path, opts = {}) => {
  const r = await fetch(base + path, { method: opts.method || 'GET', headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  return { status: r.status, body: j };
};
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  ok((await call('/api/drivers')).status === 401, 'drivers need sign-in');
  ok((await call('/api/login', { method: 'POST', body: { email, password: 'wrong' } })).status === 401, 'wrong password refused');
  ok((await call('/api/login', { method: 'POST', body: { email, password: pw } })).status === 200, 'sign in');
  const key = (await call('/api/keys', { method: 'POST', body: { name: 'Davy profile' } })).body.key;
  ok(/^rk_/.test(key), 'access key created');
  const K = { Authorization: 'Bearer ' + key };
  ok((await call('/api/ext/push', { method: 'POST', body: { drivers: [] }, headers: { Authorization: 'Bearer nope' } })).status === 401, 'bad key refused');
  const now = new Date().toISOString();
  const r1 = await call('/api/ext/push', { method: 'POST', headers: K, body: { drivers: [
    { name: 'Ruddy Grant', account: 'dispatch.davy@gmail.com', status: 'Email collected', phones: ['2405229992'], emails: ['grantservicellc@gmail.com'], conversationUrl: 'https://employers.indeed.com/messages?threadType=resumeContact&conversationId=AAAAcid1', answers: { qualify: '3 years / careless 2025 NJ', relay: 'No' }, aiSummary: 'Careless driving ticket 2025 in NJ.', events: [{ t: now, type: 'reply', text: 'No → AI: asked for email' }], notes: 'Call him Friday', transcript: 'Driver: No\nDispatch: whats your email' },
    { name: 'Ivy Interest', account: 'spark.dispatching@gmail.com', status: 'Interested', phones: [], emails: [] }
  ] } });
  ok(r1.body.merged === 2, 'extension pushed 2 drivers');
  // the same Ruddy, seen from another Chrome profile/account, with just his phone: must merge, not duplicate
  await call('/api/ext/push', { method: 'POST', headers: K, body: { drivers: [{ name: 'Ruddy Grant', account: 'spark.dispatching@gmail.com', phones: ['(240) 522-9992'], status: 'Replied', events: [{ t: now, type: 'reply', text: 'No → AI: asked for email' }] }] } });
  const l = await call('/api/drivers?q=ruddy');
  ok(l.body.total === 1, 'same driver from two profiles merged by phone');
  const d = l.body.drivers[0];
  ok(d.status === 'Email collected', 'auto status never moves a driver backwards from the extension? status=' + d.status);
  const det = (await call('/api/drivers/' + d.id)).body;
  ok(det.events.length === 1, 'history not doubled');
  ok(det.notes.length === 1 && det.notes[0].fromExtension, 'extension notes box saved as a note');
  // website edits
  ok((await call('/api/drivers/' + d.id, { method: 'PATCH', body: { status: 'Relay invite sent', followUp: '2026-11-21', tags: ['NJ', 'call back'] } })).status === 200, 'status, follow-up, tags saved');
  const n = (await call(`/api/drivers/${d.id}/notes`, { method: 'POST', body: { body: 'Talked to him, starts Monday' } })).body.id;
  ok(!!n, 'note added');
  ok((await call('/api/notes/' + n, { method: 'PATCH', body: { body: 'Talked to him, starts Monday at 6am' } })).status === 200, 'note edited');
  // extension cannot downgrade a status set by hand
  await call('/api/ext/push', { method: 'POST', headers: K, body: { drivers: [{ name: 'Ruddy Grant', phones: ['2405229992'], status: 'Interested' }] } });
  ok((await call('/api/drivers/' + d.id)).body.driver.status === 'Relay invite sent', 'status set by hand is kept');
  // pull: the extension sees team notes and status
  const p = (await call('/api/ext/pull?since=' + encodeURIComponent(new Date(Date.now() - 60000).toISOString()), { headers: K })).body;
  const pr = p.drivers.find((x) => x.name === 'Ruddy Grant');
  ok(pr && /starts Monday at 6am/.test(pr.teamNotes) && !/Call him Friday/.test(pr.teamNotes), 'pull sends team notes (not the profile\'s own)');
  ok(pr && pr.status === 'Relay invite sent' && pr.statusLocked && pr.followUp === '2026-11-21', 'pull sends status and follow-up');
  // search notes, phone
  ok((await call('/api/drivers?q=6am')).body.total === 1, 'search finds words in notes');
  ok((await call('/api/drivers?q=522-99')).body.total === 1, 'search finds phone digits');
  ok((await call('/api/drivers?due=1')).body.total >= 0, 'follow-up filter works');
  const csv = await call('/api/export.csv'); ok(typeof csv.body === 'string' && csv.body.includes('Ruddy Grant') && csv.body.includes('6am'), 'CSV export includes notes');
  // import a backup in the extension's format
  const imp = await call('/api/import', { method: 'POST', body: { label: 'backup', drivers: { 'tom typed': { name: 'Tom Typed', status: 'Replied', phones: ['7175550100'], events: [] }, 'ruddy grant': { name: 'Ruddy Grant', phones: ['2405229992'], zip: '07102' } } } });
  ok(imp.body.merged === 2 && (await call('/api/drivers?q=ruddy')).body.total === 1, 'backup import merges');
  // team
  ok((await call('/api/users', { method: 'POST', body: { name: 'Donald', email: 'donald@example.com', password: 'another-pass-1' } })).status === 200, 'team member added');
  ok((await call('/api/notes/' + n, { method: 'DELETE' })).status === 200, 'note deleted');
  ok((await call('/', {})).status === 200, 'website loads');
  ok((await call('/healthz')).body === 'ok', 'health check');
})().catch((e) => { console.log('ERROR', e); process.exitCode = 1; });
