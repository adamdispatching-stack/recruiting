// Test of the call guide: talking points in settings, and the optional AI call suggestions.
//   node test/callguide.js http://localhost:3999 admin@example.com password [http://localhost:4011 stand-in AI]
const [, , base = 'http://localhost:3999', email = 'admin@example.com', pw = 'test-password-123', mock = ''] = process.argv;
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
const uniq = Date.now().toString().slice(-6);
(async () => {
  const A = session(); await A('/api/login', { method: 'POST', body: { email, password: pw } });
  let me = (await A('/api/me')).body;
  ok(me.callPoints && me.callPoints.company.length >= 3 && me.callPoints.owner.length >= 3, 'default talking points for company drivers and owner operators');
  ok(me.ai === !!mock, `AI suggestions flag is ${!!mock}`);
  const keep = me.callPoints;
  let r = await A('/api/settings', { method: 'PUT', body: { callPoints: { company: ['  Pay 30% from day one  ', '', 'x'.repeat(900)], owner: ['Fee 10%'] } } });
  ok(r.status === 200 && r.body.callPoints.company[0] === 'Pay 30% from day one' && r.body.callPoints.company.length === 2 && r.body.callPoints.company[1].length === 400, 'talking points saved, trimmed, blank lines dropped, long lines cut');
  ok((await A('/api/me')).body.callPoints.owner[0] === 'Fee 10%', 'recruiters get the new points');
  await A('/api/settings', { method: 'PUT', body: { callPoints: keep } });

  const id = (await A('/api/drivers', { method: 'POST', body: { name: `Dana Call ${uniq}`, source: 'Facebook', mode: 'Company drivers', location: 'Camden, NJ', phone: '201555' + uniq.slice(-4) } })).body.id;
  ok(!!id, 'lead added');
  // a recruiter who cannot see the lead cannot ask for suggestions
  r = await A(`/api/drivers/${id}/callprep`, { method: 'POST' });
  if (!mock) { ok(r.status === 400 && /ANTHROPIC_API_KEY/.test(r.body.error), 'without a key, a clear message says how to turn AI suggestions on'); return; }
  await fetch(mock + '/mode/ok');
  await A(`/api/drivers/${id}/notes`, { method: 'POST', body: { body: 'Wants to be home most weekends', kind: 'call', outcome: 'talked' } });
  r = await A(`/api/drivers/${id}/callprep`, { method: 'POST' });
  ok(r.status === 200 && r.body.callPrep.questions.length === 2 && r.body.callPrep.watchOut === 'Wants home every weekend.', 'AI suggestions prepared');
  const sent = await (await fetch(mock + '/last')).json();
  ok(sent.headers['x-api-key'] === 'test-key' && sent.body.tool_choice.name === 'call_prep', 'sent with the server key, as a call_prep tool call');
  const txt = sent.body.messages[0].content;
  ok(/Camden, NJ/.test(txt) && /home most weekends/.test(txt) && /25% of each load/.test(txt), 'the AI got the lead, the notes and the company driver talking points');
  ok(!/Dispatch fee by weekly gross/.test(txt), 'owner operator points are left out for a company driver');
  const d = (await A('/api/drivers/' + id)).body.driver;
  ok(d.callPrep && d.callPrep.close === 'Get her email for the Relay invite.' && d.callPrepAt, 'suggestions kept on the lead');
  await fetch(mock + '/mode/err');
  r = await A(`/api/drivers/${id}/callprep`, { method: 'POST' });
  ok(r.status === 502 && /invalid x-api-key/.test(r.body.error), 'an AI service error is shown plainly');
  ok((await A('/api/drivers/999999/callprep', { method: 'POST' })).status === 404, 'unknown lead: 404');
})();
