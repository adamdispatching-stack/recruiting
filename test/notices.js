// Test of notifications: new leads, news on a lead, changes and notes by others, follow-ups due, reading them.
//   node test/notices.js http://localhost:3999 admin@example.com password
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
  const nid = (await A('/api/users', { method: 'POST', body: { name: `Nora Notice ${u}`, email: `nora${u}@example.com`, password: 'nora-pass-1234' } })).body.id;
  await A('/api/settings', { method: 'PUT', body: { share: { on: true, people: [nid] } } }); // she gets every shared lead in this test
  const R = session(); await R('/api/login', { method: 'POST', body: { email: `nora${u}@example.com`, password: 'nora-pass-1234' } });
  const beat = async () => (await R('/api/beat', { method: 'POST', body: { active: true, visible: true } })).body;
  const list = async () => (await R('/api/notices')).body.notices;
  let b = await beat(); ok(b.unread === 0, 'nothing to start with');
  // a new lead from the extension, shared to her
  const key = (await A('/api/keys', { method: 'POST', body: { name: 'N ' + u } })).body.key; const K = { Authorization: 'Bearer ' + key };
  const push = (d) => A('/api/ext/push', { method: 'POST', headers: K, body: { drivers: [{ updatedAt: new Date().toISOString(), ...d }] } });
  await push({ name: `Lee Lead ${u}`, phones: ['484555' + u.slice(-4)], status: 'Replied' });
  b = await beat(); let n = await list();
  ok(b.unread === 1 && n[0].kind === 'lead_new' && /New lead for you: Lee Lead/.test(n[0].text) && /#\/driver\/\d+/.test(n[0].link), 'a lead shared to her: one notification with a link');
  const leadId = +n[0].link.split('/').pop();
  // the driver writes back twice (the extension sends the whole history each time): a notification for each new message
  const t1 = new Date(Date.now() - 60000).toISOString(), t2 = new Date().toISOString(), old = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const e1 = { t: t1, type: 'reply', text: 'yes I am interested → AI: Great! How long have you had your CDL-A?' };
  const e2 = { t: t2, type: 'reply', text: 'my email is lee@example.com → sent relay' };
  const eOld = { t: old, type: 'reply', text: 'an old message from a backup' };
  await push({ name: `Lee Lead ${u}`, phones: ['484555' + u.slice(-4)], lastMessage: 'yes I am interested', status: 'Interested', events: [eOld, e1] });
  let msgs = (await list()).filter((x) => x.kind === 'message');
  ok(msgs.length === 1 && msgs[0].text === `Lee Lead ${u} wrote on Indeed: "yes I am interested"` && msgs[0].link === `#/driver/${leadId}`, 'a new message: a notification with what the driver wrote (not the old one): ' + (msgs[0] || {}).text);
  await push({ name: `Lee Lead ${u}`, phones: ['484555' + u.slice(-4)], emails: ['lee@example.com'], lastMessage: 'my email is lee@example.com', status: 'Email collected', events: [eOld, e1, e2] });
  msgs = (await list()).filter((x) => x.kind === 'message');
  ok(msgs.length === 2 && /my email is lee@example.com"$/.test(msgs[0].text), 'the second message is its own notification');
  await push({ name: `Lee Lead ${u}`, phones: ['484555' + u.slice(-4)], emails: ['lee@example.com'], status: 'Email collected', events: [eOld, e1, e2] });
  ok((await list()).filter((x) => x.kind === 'message').length === 2, 'the same history sent again: nothing new');
  n = await list(); const up = n.filter((x) => x.kind === 'lead_update');
  ok(up.length === 1 && /new email/.test(up[0].text) && /now Email collected/.test(up[0].text) && !/message/.test(up[0].text), 'other news on her lead: one notification, brought up to date: ' + (up[0] || {}).text);
  // someone else changes her lead and leaves a note
  await A('/api/drivers/' + leadId, { method: 'PATCH', body: { followUp: new Date().toISOString().slice(0, 10) } });
  await A(`/api/drivers/${leadId}/notes`, { method: 'POST', body: { body: 'Call him after 5pm' } });
  n = await list();
  ok(n.some((x) => x.kind === 'note' && /on Lee Lead .*Call him after 5pm/.test(x.text)), 'a note someone else left on her lead');
  ok(n.some((x) => x.kind === 'lead_update' && /changed Lee Lead/.test(x.text) && /Follow-up/.test(x.text)), 'a change someone else made');
  // her own changes do not notify her
  const before = (await beat()).unread;
  await R(`/api/drivers/${leadId}/notes`, { method: 'POST', body: { body: 'my own note' } });
  ok((await beat()).unread === before, 'her own notes do not notify her');
  // opening the lead reads its notifications
  await R('/api/drivers/' + leadId);
  b = await beat(); n = await list();
  ok(n.filter((x) => x.link === `#/driver/${leadId}` && !x.seen_at).length === 0, 'opening the lead marks its notifications read');
  // admin gives her a lead, then moves it away
  const other = (await A('/api/drivers', { method: 'POST', body: { name: `Max Moved ${u}`, source: 'Indeed', phone: '215555' + u.slice(-4), ownerId: null } })).body.id;
  await A('/api/drivers/' + other, { method: 'PATCH', body: { ownerId: nid } });
  n = await list(); ok(n.some((x) => x.kind === 'lead_new' && /gave you the lead Max Moved/.test(x.text)), 'admin gives her a lead');
  await A('/api/drivers/' + other, { method: 'PATCH', body: { ownerId: null } });
  n = await list(); ok(n.some((x) => x.kind === 'lead_moved' && /Max Moved .* was given to nobody/.test(x.text)), 'and tells her when it is moved away');
  // read all
  await R('/api/notices/seen', { method: 'POST', body: {} });
  ok((await beat()).unread === 0, 'Mark all as read');
  ok((await A('/api/beat', { method: 'POST', body: { active: true, visible: true } })).body.notices.every((x) => !/for you: Lee Lead/.test(x.text)), 'the admin does not get her notifications');
  await A('/api/settings', { method: 'PUT', body: { share: { on: true, people: null } } });
})().catch((e) => { console.log('ERROR', e); process.exitCode = 1; });
