// Test of the Indeed message after a missed call: queued on the website, taken and reported back by the extension.
//   DATABASE_URL=... node test/outbox.js http://localhost:3999 admin@example.com password  (it clears old messages straight in the database)
const [, , base = 'http://localhost:3999', email = 'admin@example.com', pw = 'test-password-123'] = process.argv;
function session(bearer) {
  let cookie = '';
  return async (path, opts = {}) => {
    const r = await fetch(base + path, { method: opts.method || 'GET', headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, body: j };
  };
}
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const u = Date.now().toString().slice(-5);
const w = u.replace(/\d/g, (x) => 'abcdefghij'[x]); // for names, so a search does not hit phone digits
(async () => {
  const A = session(); await A('/api/login', { method: 'POST', body: { email, password: pw } });
  const X = session((await A('/api/keys', { method: 'POST', body: { name: 'Outbox test ' + u } })).body.key);
  const conv = `https://employers.indeed.com/messages?threadType=resumeContact&conversationId=AAAAAcenxPout${u}zQ`;
  await X('/api/ext/push', { method: 'POST', body: { drivers: [
    { id: 'olga' + u, name: `Olga Out${w}`, status: 'Interested', phones: ['21555' + u], emails: [], answers: {}, events: [], conversationUrl: conv, account: 'a@example.com' },
    { id: 'pete' + u, name: `Pete Plain${w}`, status: 'Interested', phones: ['61055' + u], emails: [], answers: {}, events: [] }] } });
  const olga = (await A('/api/drivers?q=' + encodeURIComponent('Olga Out' + w))).body.drivers[0];
  const pete = (await A('/api/drivers?q=' + encodeURIComponent('Pete Plain' + w))).body.drivers[0];
  let r = await A(`/api/drivers/${olga.id}/notes`, { method: 'POST', body: { kind: 'call', outcome: 'No answer' } });
  ok(r.body.indeed && r.body.indeed.queued, 'no answer on a lead with an Indeed chat: queued');
  r = await A(`/api/drivers/${pete.id}/notes`, { method: 'POST', body: { kind: 'call', outcome: 'No answer' } }); ok(r.body.indeed.skip === 'this lead has no Indeed chat', 'no chat: not queued ' + JSON.stringify(r.body));
  ok((await A(`/api/drivers/${olga.id}/notes`, { method: 'POST', body: { kind: 'call', outcome: 'Left voicemail', indeed: false } })).body.indeed === null, 'can be left out for one call');
  let d = (await A('/api/drivers/' + olga.id)).body;
  ok(d.indeedChat && d.indeedMsgs.length === 1 && d.indeedMsgs[0].status === 'pending' && /^Hi Olga, this is Admin/.test(d.indeedMsgs[0].text), 'the lead shows it waiting, with the names filled in');
  const items = (await X('/api/ext/outbox')).body.items; const it = items.find((x) => x.name === `Olga Out${w}`);
  ok(it && it.conversationUrl === conv && it.account === 'a@example.com', 'the extension gets it with the chat link and account');
  ok((await X(`/api/ext/outbox/${it.id}/claim`, { method: 'POST', body: {} })).status === 200, 'one profile takes it');
  ok((await X(`/api/ext/outbox/${it.id}/claim`, { method: 'POST', body: {} })).status === 409, 'nobody else can take it');
  ok(!(await X('/api/ext/outbox')).body.items.some((x) => x.id === it.id), 'taken: not offered again');
  await X(`/api/ext/outbox/${it.id}/done`, { method: 'POST', body: { ok: true } });
  d = (await A('/api/drivers/' + olga.id)).body;
  ok(d.indeedMsgs[0].status === 'sent' && d.events.some((e) => /missed call/.test(e.text)), 'sent: on the lead and in its history');
  ok((await A(`/api/drivers/${olga.id}/notes`, { method: 'POST', body: { kind: 'call', outcome: 'No answer' } })).body.indeed.skip.includes('12 hours'), 'not twice in 12 hours');
  // a failure goes back to the caller
  const rec = session(); const em = `rita${u}@example.com`;
  await A('/api/users', { method: 'POST', body: { name: `Rita Rec${w}`, email: em, password: 'rita-pass-1234' } });
  await A(`/api/drivers/${olga.id}`, { method: 'PATCH', body: { ownerId: (await A('/api/me')).body.people.find((p) => p.name === `Rita Rec${w}`).id } });
  await rec('/api/login', { method: 'POST', body: { email: em, password: 'rita-pass-1234' } });
  const pg = require('../src/db'); await pg.q(`DELETE FROM indeed_outbox WHERE driver_id = $1`, [olga.id]); // as if a day passed
  r = await rec(`/api/drivers/${olga.id}/notes`, { method: 'POST', body: { kind: 'call', outcome: 'No answer' } });
  ok(r.body.indeed.queued && /this is Rita/.test((await rec('/api/drivers/' + olga.id)).body.indeedMsgs[0].text), 'the recruiter who called is named in the message');
  const id2 = (await rec('/api/drivers/' + olga.id)).body.indeedMsgs[0].id;
  await X(`/api/ext/outbox/${id2}/claim`, { method: 'POST', body: {} });
  await X(`/api/ext/outbox/${id2}/done`, { method: 'POST', body: { ok: false, error: 'Indeed shows no message box in this chat' } });
  ok((await rec('/api/drivers/' + olga.id)).body.indeedMsgs[0].status === 'failed', 'not sent: shown as failed');
  ok((await rec('/api/notices')).body.notices.some((n) => /not sent: Indeed shows no message box/.test(n.text)), 'the recruiter is told why');
  ok((await rec('/api/indeed-outbox/' + id2, { method: 'POST', body: { action: 'retry' } })).body.ok && (await X('/api/ext/outbox')).body.items.some((x) => x.id === id2), 'try again: offered to the extension again');
  // turned off in Settings
  const before = (await A('/api/settings')).body.noAnswer;
  ok((await A('/api/settings', { method: 'PUT', body: { noAnswer: { on: true, text: '' } } })).status === 400, 'an empty message is refused');
  await A('/api/settings', { method: 'PUT', body: { noAnswer: { on: false, text: before.text } } });
  await pg.q(`DELETE FROM indeed_outbox WHERE driver_id = $1`, [olga.id]);
  ok(/turned off/.test((await A(`/api/drivers/${olga.id}/notes`, { method: 'POST', body: { kind: 'call', outcome: 'No answer' } })).body.indeed.skip), 'turned off: nothing queued');
  await A('/api/settings', { method: 'PUT', body: { noAnswer: before } });
  await pg.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
