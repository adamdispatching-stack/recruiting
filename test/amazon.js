// Test of lost-lead reasons and the Amazon Relay steps.
//   node test/amazon.js http://localhost:3999 admin@example.com password
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
  const me = (await A('/api/me')).body;
  ok(me.amazon.length === 6 && me.amazon[3].label === 'Background check' && me.needReason.includes('Rejected') && me.needReason.includes('Stalled') && !me.needReason.includes('Declined on Indeed'), 'steps and reason lists reach the browser');
  const add = async (n, phone) => (await A('/api/drivers', { method: 'POST', body: { name: `${n} ${u}`, source: 'Indeed', mode: 'Company drivers', phone } })).body.id;
  const get = async (id) => (await A('/api/drivers/' + id)).body;
  const P = (id, body) => A('/api/drivers/' + id, { method: 'PATCH', body });
  // reasons
  const r1 = await add('Rex Reject', '301555' + u.slice(-4));
  let r = await P(r1, { status: 'Rejected' });
  ok(r.status === 400 && r.body.needsReason && (await get(r1)).driver.status === 'Interested', 'Rejected without a reason is refused, status unchanged');
  ok((await P(r1, { status: 'Rejected', lostReason: 'Other' })).status === 400, '"Other" needs a few words');
  r = await P(r1, { status: 'Rejected', lostReason: 'Pay', lostNote: 'Wants $2,000 a week' });
  let d = await get(r1);
  ok(r.status === 200 && d.driver.status === 'Rejected' && d.driver.lostReason === 'Pay' && d.driver.lostNote === 'Wants $2,000 a week', 'rejected with the reason and the details saved');
  ok(d.events.some((e) => /Reason: Pay/.test(e.text)) && d.events.some((e) => /Why: Wants \$2,000/.test(e.text)), 'the reason is in the lead history');
  ok((await P(r1, { status: 'Stalled' })).status === 200, 'moving between lost statuses keeps the saved reason');
  await P(r1, { status: 'Interested' }); d = await get(r1);
  ok(!d.driver.lostReason && !d.driver.lostNote, 'back in progress: the reason is cleared');
  ok((await P(r1, { status: 'Stalled' })).status === 400, 'Stalled also needs a reason');
  // Amazon steps
  const a1 = await add('Amy Amazon', '302555' + u.slice(-4));
  r = await P(a1, { amazonStep: 'account' }); d = await get(a1);
  ok(r.status === 200 && d.driver.amazonStep === 'account' && d.driver.status === 'Relay invite sent' && d.driver.amazonLog.account, 'Amazon account: status moves to Relay invite sent, time kept');
  await P(a1, { amazonStep: 'accurate' }); d = await get(a1);
  ok(d.driver.amazonStep === 'accurate' && d.driver.status === 'Signed up on Relay', 'background check at Accurate: status moves to Signed up on Relay');
  ok((await P(a1, { amazonStep: 'nope' })).status === 400, 'unknown step refused');
  await P(a1, { status: 'Onboarding' }); d = await get(a1);
  const relay = () => d.onboarding.items.find((i) => i.key === 'relay');
  ok(relay() && !relay().done && relay().auto === 'amazon', 'onboarding: "Amazon Relay verified" is not done yet and ticks itself');
  ok((await A('/api/checklist/' + relay().id, { method: 'PATCH', body: { done: true } })).status === 400, 'it cannot be ticked by hand');
  await P(a1, { amazonStep: 'verified' }); d = await get(a1);
  ok(d.driver.amazonStep === 'verified' && relay().done && d.driver.status === 'Onboarding', 'verified: the checklist step ticks itself, onboarding stays');
  const board = (await A('/api/onboarding')).body.drivers.find((x) => x.id === a1);
  ok(board && board.amazonStep === 'verified', 'the onboarding list knows the driver is verified');
  await P(a1, { amazonStep: 'waiting' }); d = await get(a1);
  ok(d.driver.amazonStep === 'waiting' && !relay().done, 'a step put back by mistake unticks it');
  // the status sets the step when a recruiter uses the status instead
  const s1 = await add('Sid Status', '303555' + u.slice(-4));
  await P(s1, { status: 'Relay invite sent' }); d = await get(s1);
  ok(d.driver.amazonStep === 'invite', 'status Relay invite sent sets the Invite sent step');
  await P(s1, { status: 'Signed up on Relay' }); d = await get(s1);
  ok(d.driver.amazonStep === 'profile', 'status Signed up on Relay sets Profile done');
})().catch((e) => { console.log('ERROR', e); process.exitCode = 1; });
