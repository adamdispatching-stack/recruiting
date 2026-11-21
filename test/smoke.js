// End-to-end test of the API against a running server with an EMPTY database:
//   node test/smoke.js http://localhost:3999 admin@example.com password
// With DATABASE_URL set, it also back-dates a few rows to test "going cold" and "stuck" alerts.
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
let failed = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) { failed++; process.exitCode = 1; } };
const sql = async (text, params) => {
  if (!process.env.DATABASE_URL) return null;
  const { Client } = require('pg'); const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await c.connect(); try { return await c.query(text, params); } finally { await c.end(); }
};

(async () => {
  const admin = session(), don = session(), sam = session(), anon = session();
  const post = (s, path, body, headers) => s(path, { method: 'POST', body, headers });
  const patch = (s, path, body) => s(path, { method: 'PATCH', body });

  console.log('\n# sign-in and accounts');
  ok((await anon('/api/drivers')).status === 401, 'the lead list needs sign-in');
  ok((await post(anon, '/api/login', { email, password: 'wrong' })).status === 401, 'wrong password refused');
  ok((await post(admin, '/api/login', { email, password: pw })).status === 200, 'admin signs in');
  const meA = (await admin('/api/me')).body;
  ok(meA.role === 'admin' && meA.tz === 'America/New_York' && meA.sources.includes('Indeed') && meA.route.includes('Onboarding'), 'me: role, time zone, sources, Onboarding status');
  const donId = (await post(admin, '/api/users', { name: 'Dana', email: 'dana@example.com', password: 'another-pass-1' })).body.id;
  const samId = (await post(admin, '/api/users', { name: 'Marcus', email: 'marcus@example.com', password: 'another-pass-2' })).body.id;
  ok(donId && samId, 'admin created two recruiter accounts');
  // these checks are about a key's own recruiter; sharing leads evenly has its own test (test/share.js)
  ok((await admin('/api/settings', { method: 'PUT', body: { share: { on: false, people: null } } })).body.share.on === false, 'sharing leads evenly can be turned off');
  ok((await post(admin, '/api/users', { name: 'Dup', email: 'dana@example.com', password: 'another-pass-1' })).status === 400, 'same email twice refused');
  ok((await post(don, '/api/login', { email: 'dana@example.com', password: 'another-pass-1' })).status === 200, 'recruiter signs in');
  await post(sam, '/api/login', { email: 'marcus@example.com', password: 'another-pass-2' });
  ok((await post(don, '/api/users', { name: 'X', email: 'x@example.com', password: 'another-pass-3' })).status === 403, 'a recruiter cannot create accounts');
  ok((await post(don, '/api/keys', { name: 'mine' })).status === 403, 'a recruiter cannot create access keys');
  ok((await don('/api/export.csv')).status === 403, 'a recruiter cannot export the list');
  ok((await don('/api/team')).status === 403, 'a recruiter cannot open the Team table');

  console.log('\n# the Chrome extension');
  const key = (await post(admin, '/api/keys', { name: 'Davy profile', assignTo: donId })).body.key;
  ok(/^rk_/.test(key), 'access key created, new leads go to Dana');
  const K = { Authorization: 'Bearer ' + key };
  ok((await post(anon, '/api/ext/push', { drivers: [] }, { Authorization: 'Bearer nope' })).status === 401, 'bad key refused');
  const now = new Date().toISOString();
  const r1 = await post(anon, '/api/ext/push', { drivers: [
    { name: 'Ruddy Grant', account: 'dispatch.davy@gmail.com', status: 'Email collected', source: 'Matched candidate invite', phones: ['2405229992'], emails: ['grantservicellc@gmail.com'], conversationUrl: 'https://employers.indeed.com/messages?threadType=resumeContact&conversationId=AAAAcid1AAAAcid1', answers: { qualify: '3 years / careless 2025 NJ', relay: 'No' }, aiSummary: 'Careless driving ticket 2025 in NJ.', events: [{ t: now, type: 'reply', text: 'No → AI: asked for email' }], notes: 'Call him Friday', transcript: 'Driver: No\nDispatch: whats your email' },
    { name: 'Ivy Interest', account: 'spark.dispatching@gmail.com', status: 'Interested', phones: [], emails: [] },
    { name: 'Nora Noreply', account: 'spark.dispatching@gmail.com', status: 'Invited' }
  ] }, K);
  ok(r1.body.merged === 3, 'extension pushed 3 drivers');
  await post(anon, '/api/ext/push', { drivers: [{ name: 'Ruddy Grant', account: 'spark.dispatching@gmail.com', phones: ['(240) 522-9992'], status: 'Replied', events: [{ t: now, type: 'reply', text: 'No → AI: asked for email' }] }] }, K);
  const l = await admin('/api/drivers?q=ruddy');
  ok(l.body.total === 1, 'same driver from two profiles merged by phone');
  const d = l.body.drivers[0];
  ok(d.status === 'Email collected', 'the extension never moves a driver backwards');
  ok(d.ownerId === donId && d.source === 'Indeed' && d.sourceDetail === 'Matched candidate invite', 'extension lead: owner from the key, source Indeed, detail kept');
  const det = (await admin('/api/drivers/' + d.id)).body;
  ok(det.events.length === 1, 'history not doubled');
  ok(det.notes.length === 1 && det.notes[0].fromExtension, 'extension notes box saved as a note');
  ok(det.driver.leadAt && det.onboarding === null, 'a reply makes it a lead; no onboarding yet');
  const nora = (await admin('/api/drivers?q=nora')).body.drivers[0];
  ok(nora && !nora.leadAt, 'an invite with no reply is not counted as a lead');

  console.log('\n# adding leads by hand');
  ok((await post(don, '/api/drivers', { name: 'Frank Facebook', phone: '7175550100' })).status === 400, 'a lead needs a source');
  ok((await post(don, '/api/drivers', { name: 'Frank Facebook', phone: '555', source: 'Facebook' })).status === 400, 'bad phone refused');
  const frank = (await post(don, '/api/drivers', { name: 'Frank Facebook', phone: '(717) 555-0100', email: 'Frank@Example.com', source: 'Facebook', sourceDetail: 'CDL Drivers PA group', location: 'Harrisburg, PA', mode: 'Company drivers', note: 'Saw our post, 4 years OTR', followUp: meA.today })).body.id;
  ok(!!frank, 'recruiter added a lead with source and detail');
  const fd = (await don('/api/drivers/' + frank)).body;
  ok(fd.driver.ownerId === donId && fd.driver.status === 'Interested' && fd.driver.source === 'Facebook' && fd.driver.emails[0] === 'frank@example.com' && fd.notes.length === 1 && fd.driver.followUp === meA.today, 'new lead: owner, status, source, first note, follow-up');
  const dup = await post(sam, '/api/drivers', { name: 'F. Facebook', phone: '7175550100', source: 'Referral' });
  ok(dup.status === 409 && dup.body.canForce === false && dup.body.duplicates[0].owner === 'Dana', 'same phone: not added twice, shows whose lead it is');
  const dup2 = await post(sam, '/api/drivers', { name: 'frank facebook', phone: '7175550199', source: 'Referral' });
  ok(dup2.status === 409 && dup2.body.canForce === true, 'same name only: asks before adding');
  const frank2 = (await post(sam, '/api/drivers', { name: 'frank facebook', phone: '7175550199', source: 'Referral', sourceDetail: 'Referred by driver Mike', force: true })).body.id;
  ok(!!frank2 && frank2 !== frank, 'same name, different person, added on request');

  console.log('\n# working a lead');
  const n = (await post(don, `/api/drivers/${d.id}/notes`, { body: 'Talked to him, starts Monday' })).body.id;
  ok(!!n, 'note added');
  ok((await patch(don, '/api/notes/' + n, { body: 'Talked to him, starts Monday at 6am' })).status === 200, 'note edited by its author');
  ok((await patch(sam, '/api/notes/' + n, { body: 'hack' })).status === 403, 'someone else cannot edit it');
  ok((await post(don, `/api/drivers/${frank}/notes`, { kind: 'call', outcome: 'No answer' })).status === 200, 'call logged with no text');
  ok((await post(don, `/api/drivers/${frank}/notes`, { kind: 'text', body: 'Sent him the pay sheet' })).status === 200, 'text logged');
  const fd2 = (await don('/api/drivers/' + frank)).body;
  ok(fd2.notes[0].kind === 'text' && fd2.notes[1].kind === 'call' && fd2.notes[1].outcome === 'No answer' && fd2.driver.lastContactAt, 'contact log saved, last contact updated');
  ok((await patch(don, '/api/drivers/' + d.id, { status: 'Relay invite sent', followUp: '2030-11-21', tags: ['NJ', 'call back'] })).status === 200, 'status, follow-up, tags saved');
  ok((await patch(don, '/api/drivers/' + d.id, { followUp: 'tomorrow' })).status === 400, 'a bad date is refused');
  await post(anon, '/api/ext/push', { drivers: [{ name: 'Ruddy Grant', phones: ['2405229992'], status: 'Interested' }] }, K);
  ok((await admin('/api/drivers/' + d.id)).body.driver.status === 'Relay invite sent', 'status set by hand is kept');
  const p = (await anon('/api/ext/pull?since=' + encodeURIComponent(new Date(Date.now() - 60000).toISOString()), { headers: K })).body;
  const pr = p.drivers.find((x) => x.name === 'Ruddy Grant'); const pf = p.drivers.find((x) => x.name === 'Frank Facebook');
  ok(pr && /starts Monday at 6am/.test(pr.teamNotes) && !/Call him Friday/.test(pr.teamNotes), 'pull sends team notes (not the profile\'s own)');
  ok(pr && pr.status === 'Relay invite sent' && pr.statusLocked && pr.followUp === '2030-11-21', 'pull sends status and follow-up');
  ok(pf && /Call, no answer/.test(pf.teamNotes) && /Text, sent: Sent him the pay sheet/.test(pf.teamNotes), 'pull words the contact log');
  ok((await admin('/api/drivers?q=6am')).body.total === 1, 'search finds words in notes');
  ok((await admin('/api/drivers?q=522-99')).body.total === 1, 'search finds phone digits');
  ok((await admin('/api/drivers?q=cdl drivers pa')).body.total === 1, 'search finds the source detail');
  ok((await admin('/api/drivers?source=Facebook')).body.total === 1 && (await admin('/api/drivers?owner=' + samId)).body.total === 1 && (await admin('/api/drivers?owner=none')).body.total === 0, 'filters: source, recruiter, unassigned');
  ok((await don('/api/drivers?due=1')).body.total === 1, 'follow-ups due today are listed');

  console.log('\n# who owns a lead');
  ok((await patch(sam, '/api/drivers/' + frank, { ownerId: samId })).status === 403, 'a recruiter cannot take someone else\'s lead');
  ok((await patch(don, '/api/drivers/' + frank, { ownerId: null })).status === 403, 'a recruiter cannot let go of their own lead');
  ok((await patch(admin, '/api/drivers/' + frank, { ownerId: samId })).status === 200, 'an admin moves a lead to another recruiter');
  ok((await post(admin, '/api/drivers/assign', { ids: [frank, d.id], ownerId: donId })).body.changed === 1, 'admin assigns several leads at once');
  ok((await post(don, '/api/drivers/assign', { ids: [frank], ownerId: samId })).status === 403, 'only an admin can bulk-assign');
  await admin('/api/settings', { method: 'PUT', body: { visibility: 'own' } });
  ok((await sam('/api/drivers/' + frank)).status === 404 && (await sam('/api/drivers')).body.drivers.every((x) => !x.ownerId || x.ownerId === samId), 'private mode: a recruiter sees only their own and unassigned leads');
  ok((await post(sam, `/api/drivers/${frank}/notes`, { body: 'x' })).status === 404 && (await patch(sam, '/api/drivers/' + frank, { status: 'Hired' })).status === 404, 'private mode: cannot change other people\'s leads');
  const dupP = await post(sam, '/api/drivers', { name: 'Frank F', phone: '7175550100', source: 'Referral' });
  ok(dupP.status === 409 && dupP.body.duplicates[0].id === null && dupP.body.duplicates[0].owner === 'Dana', 'private mode: a duplicate names the owner but gives no link');
  await admin('/api/settings', { method: 'PUT', body: { visibility: 'all' } });
  ok((await sam('/api/drivers/' + frank)).status === 200, 'shared mode again: everyone sees every lead');

  console.log('\n# trucks');
  { const rt = await post(don, '/api/trucks', { unit: '300' }); // recruiters add trucks; only an admin removes one
    ok(rt.status === 200 && (await don('/api/trucks/' + rt.body.id, { method: 'DELETE' })).status === 403 && (await admin('/api/trucks/' + rt.body.id, { method: 'DELETE' })).status === 200, 'a recruiter can add a truck but not remove it'); }
  const t104 = (await post(admin, '/api/trucks', { unit: '104', details: '2021 Freightliner Cascadia', location: 'Newark yard' })).body.id;
  const t9 = (await post(admin, '/api/trucks', { unit: '9', details: '2019 Cascadia' })).body.id;
  const t220 = (await post(admin, '/api/trucks', { unit: '220', driverName: 'Mike (current driver)' })).body.id;
  ok(t104 && t9 && t220, 'admin added three trucks');
  ok((await post(admin, '/api/trucks', { unit: '104' })).status === 400, 'same unit number twice refused');
  let trucks = (await don('/api/trucks')).body.trucks;
  ok(trucks.map((t) => t.unit).join() === '9,104,220' && trucks.filter((t) => t.state === 'empty').length === 2 && trucks[2].state === 'assigned', 'truck list: sorted by number, 2 empty, 1 with a current driver');

  console.log('\n# onboarding');
  ok((await patch(don, `/api/drivers/${frank}/onboarding`, { truckId: t104 })).status === 400, 'no truck before onboarding starts');
  ok((await patch(don, '/api/drivers/' + frank, { status: 'Onboarding' })).status === 200, 'status Onboarding starts the checklist');
  let ob = (await don('/api/drivers/' + frank)).body.onboarding;
  ok(ob && ob.items.length === 11 && ob.items.every((i) => !i.done) && ob.freeTrucks.length === 2, 'checklist has the 11 standard steps, 2 trucks to pick from');
  const item = (key) => ob.items.find((i) => i.key === key);
  ok((await patch(don, '/api/checklist/' + item('truck').id, { done: true })).status === 400, 'the truck step cannot be ticked by hand');
  ok((await patch(don, '/api/checklist/' + item('mvr').id, { done: true, note: 'Clean, pulled 11/19' })).status === 200, 'step ticked with a note');
  ok((await patch(don, `/api/drivers/${frank}/onboarding`, { truckId: t104, expectedArrival: '2026-11-25', arrivalNote: 'Flying into EWR 4pm, needs pickup' })).status === 200, 'truck and arrival saved');
  ok((await patch(don, `/api/drivers/${frank}/onboarding`, { telegramLink: 'javascript:alert(1)' })).status === 400, 'only a Telegram link is accepted');
  ok((await patch(don, `/api/drivers/${frank}/onboarding`, { telegramLink: 'https://t.me/+AbCdEf123' })).status === 200, 'Telegram group link saved');
  ob = (await don('/api/drivers/' + frank)).body.onboarding;
  ok(item('truck').done && item('arrival_date').done && item('telegram').done && item('mvr').done && item('mvr').doneBy === 'Dana' && !item('arrived').done && ob.truck.unit === '104' && ob.freeTrucks.length === 1, 'truck, arrival date and Telegram steps ticked themselves');
  ok((await post(don, `/api/drivers/${frank}/checklist`, { label: 'Drug test scheduled' })).status === 200, 'a step just for this driver added');
  // a second driver cannot get the same truck; a rejected driver frees theirs
  await patch(sam, '/api/drivers/' + frank2, { status: 'Onboarding' });
  ok((await patch(sam, `/api/drivers/${frank2}/onboarding`, { truckId: t104 })).status === 409, 'a truck with a driver cannot be given twice');
  ok((await patch(sam, `/api/drivers/${frank2}/onboarding`, { truckId: t220 })).status === 409, 'a truck with a current driver cannot be given');
  ok((await patch(sam, `/api/drivers/${frank2}/onboarding`, { truckId: t9 })).status === 200, 'second driver gets the other truck');
  const board = (await admin('/api/onboarding')).body;
  ok(board.drivers.length === 2 && board.template.length === 11 && board.emptyTrucks === 0 && board.drivers.find((x) => x.id === frank).items.length === 12 && board.drivers.find((x) => x.id === frank).truck.unit === '104', 'board lists both drivers with their steps and trucks');
  ok((await patch(sam, '/api/drivers/' + frank2, { status: 'Rejected', lostReason: 'Not qualified' })).status === 200, 'driver rejected with a reason');
  trucks = (await admin('/api/trucks')).body.trucks;
  ok(trucks.find((t) => t.unit === '9').state === 'empty', 'the rejected driver\'s truck is free again');
  ok((await admin('/api/drivers/' + frank2)).body.driver.lostReason === 'Not qualified', 'reason saved');
  // template change reaches drivers in progress
  const tpl = (await admin('/api/settings')).body.checklist;
  const s2 = await admin('/api/settings', { method: 'PUT', body: { checklist: tpl.filter((x) => x.key !== 'acct_group').concat({ label: 'Fuel card issued' }) } });
  ob = (await don('/api/drivers/' + frank)).body.onboarding;
  ok(s2.status === 200 && ob.items.some((i) => i.label === 'Fuel card issued') && !ob.items.some((i) => i.key === 'acct_group') && item('mvr').done && ob.items.some((i) => i.custom), 'changed template: new step added, removed step gone, ticks and custom steps kept');
  ok((await patch(don, `/api/drivers/${frank}/onboarding`, { arrivedOn: '2026-11-25' })).status === 200, 'arrival recorded');
  ob = (await don('/api/drivers/' + frank)).body.onboarding;
  ok(item('arrived').done, 'arrived step ticked itself');
  ok((await patch(don, '/api/drivers/' + frank, { status: 'Hired' })).status === 200, 'marked as hired');
  ob = (await don('/api/drivers/' + frank)).body.onboarding;
  const board2 = (await admin('/api/onboarding')).body;
  ok(ob.completedAt && board2.drivers.length === 0 && board2.hired.length === 1 && board2.hired[0].truck === '104', 'hired: off the board, listed as hired with the truck');
  ok((await admin('/api/trucks')).body.trucks.find((t) => t.unit === '104').driver.name === 'Frank Facebook', 'the truck stays with the hired driver');
  ok((await patch(admin, '/api/trucks/' + t104, { release: true })).status === 200 && (await admin('/api/trucks')).body.trucks.find((t) => t.unit === '104').state === 'empty', 'admin can release a truck');

  console.log('\n# activity tracking');
  await post(don, '/api/beat', { start: true, visible: true });
  await post(don, '/api/beat', { active: true, visible: true, clicks: 14 });
  await post(don, '/api/beat', { active: true, visible: true, clicks: 3 }); // right after: no time to credit twice
  await post(don, '/api/track', { path: '#/leads' });
  await post(don, '/api/track', { path: '#/driver/' + frank });
  await post(don, '/api/track', { path: '#/driver/' + frank });
  const team = (await admin('/api/team?period=today')).body;
  const td = team.people.find((x) => x.id === donId); const ts = team.people.find((x) => x.id === samId);
  ok(td.activeSeconds >= 30 && td.activeSeconds <= 32 && td.clicks === 17 && td.views === 3 && td.opened === 1, `time, clicks, pages and leads opened counted (active ${td.activeSeconds}s, clicks ${td.clicks}, pages ${td.views}, opened ${td.opened})`);
  ok(td.notes === 2 && td.contacts === 2 && td.calls === 1 && td.added === 1 && td.forward >= 2 && td.checks === 1 && td.logins === 1 && td.hired === 1 && td.onboarded === 1, `work counted (notes ${td.notes}, contacts ${td.contacts}, calls ${td.calls}, added ${td.added}, moved ${td.forward}, steps ${td.checks}, hired ${td.hired})`);
  ok(td.lastActiveAt && td.firstAt && ts.activeSeconds === 0 && ts.added === 1, 'online times kept; the other recruiter has their own numbers');
  const mine = (await don('/api/team/me?period=today')).body;
  ok(mine.person.id === donId && mine.unit === 'hour' && mine.series.length === 24 && mine.series.reduce((a, x) => a + x.active, 0) === td.activeSeconds && mine.feed.length > 5 && mine.logins.length === 1 && mine.logins[0].ip === undefined, 'a recruiter sees their own page: 24 hours, feed, sign-ins');
  ok((await don('/api/team/' + samId)).status === 403, 'but not someone else\'s');
  const wk = (await admin(`/api/team/${donId}?period=7d`)).body;
  ok(wk.unit === 'day' && wk.series.length === 7 && wk.series[6].active === td.activeSeconds && wk.logins[0].ip !== undefined, 'admin sees a week by day, with sign-in addresses');
  ok((await admin('/api/team/' + donId + '?period=30d')).body.series.length === 30, '30 days by day');

  console.log('\n# dashboards');
  const dash = (await admin('/api/dashboard')).body;
  ok(dash.role === 'admin' && dash.attention.due >= 1 && dash.attention.emptyTrucks === 2 && dash.pipeline.length > 0 && dash.team.length === 3 && dash.feed.length > 5, 'admin dashboard has attention items, pipeline, team and feed');
  ok(dash.week.newLeads === 4 && dash.month.hired === 1 && dash.sources.find((s) => s.source === 'Facebook').won === 1 && dash.sources.find((s) => s.source === 'Indeed').leads === 2, `new leads, hires and sources counted (new ${dash.week.newLeads}, hired ${dash.month.hired})`);
  ok(dash.lost.some((x) => x.reason === 'Not qualified'), 'lost reasons counted');
  ok(!dash.feed.some((f) => f.type === 'open'), 'the main feed leaves out "opened a lead"');
  const my = (await don('/api/dashboard')).body;
  ok(my.role === 'member' && my.stats.id === donId && Array.isArray(my.calls) && my.attention === undefined, 'a recruiter gets their own day, not the admin dashboard');

  if (process.env.DATABASE_URL) {
    await sql(`UPDATE drivers SET updated_at = now() - interval '5 days', follow_up = NULL WHERE name = 'Ivy Interest'`);
    await patch(don, '/api/drivers/' + d.id, { status: 'Onboarding' });
    await sql(`UPDATE onboarding SET progress_at = now() - interval '5 days', expected_arrival = current_date - 2 WHERE driver_id = $1`, [d.id]);
    const d2 = (await admin('/api/dashboard')).body;
    ok(d2.attention.cold === 1 && d2.attention.stuck === 1 && d2.attention.late === 1, 'alerts: lead going cold, onboarding stuck, driver late');
    ok((await admin('/api/drivers?cold=1')).body.total === 1, 'the cold filter lists it');
    ok((await admin('/api/team')).body.people.find((x) => x.id === donId).cold === 1, 'and it counts against its recruiter');
  }

  console.log('\n# settings, export, import');
  ok((await admin('/api/settings', { method: 'PUT', body: { tz: 'Mars/Olympus' } })).status === 400, 'unknown time zone refused');
  ok((await admin('/api/settings', { method: 'PUT', body: { sources: ['Facebook', 'Job fair'] } })).body.sources.join() === 'Indeed,Facebook,Job fair', 'sources saved, Indeed always kept');
  ok((await don('/api/settings', { method: 'PUT', body: { visibility: 'own' } })).status === 403, 'a recruiter cannot change settings');
  const csv = await admin('/api/export.csv');
  ok(typeof csv.body === 'string' && csv.body.includes('Ruddy Grant') && csv.body.includes('6am') && csv.body.includes('recruiter') && csv.body.includes('Dana'), 'CSV export includes notes and the recruiter');
  const imp = await post(admin, '/api/import', { label: 'backup', drivers: { 'tom typed': { name: 'Tom Typed', status: 'Replied', phones: ['7175550111'], events: [] }, 'ruddy grant': { name: 'Ruddy Grant', phones: ['2405229992'], zip: '07102' } } });
  ok(imp.body.merged === 2 && (await admin('/api/drivers?q=ruddy')).body.total === 1, 'backup import merges');
  // an old backup keeps its own dates, so it does not look like this week's leads
  const old = new Date(Date.now() - 40 * 864e5).toISOString(); const before = (await admin('/api/dashboard')).body.week.newLeads;
  await post(admin, '/api/import', { label: 'old backup', drivers: { 'oscar old': { name: 'Oscar Old', status: 'Interested', phones: ['7175550122'], updatedAt: old, createdAt: old, events: [{ t: old, type: 'reply', text: 'yes' }] } } });
  const oscar = (await admin('/api/drivers?q=oscar')).body.drivers[0];
  ok(Math.abs(new Date(oscar.leadAt) - new Date(old)) < 5000 && (await admin('/api/dashboard')).body.week.newLeads === before, 'an imported old lead keeps its real date');
  // a lead nobody owns goes to the recruiter whose Chrome profile works on it
  const free = (await post(admin, '/api/drivers', { name: 'Nobody Yet', phone: '7175550133', source: 'Job fair', ownerId: null })).body.id;
  ok((await admin('/api/drivers/' + free)).body.driver.ownerId === null, 'admin can add a lead with no recruiter');
  await post(anon, '/api/ext/push', { drivers: [{ name: 'Nobody Yet', phones: ['7175550133'], emails: ['nobody.yet@example.com'], status: 'Email collected' }] }, K);
  const fr = (await admin('/api/drivers/' + free)).body.driver;
  ok(fr.ownerId === donId && fr.status === 'Email collected', 'the profile that works an unassigned lead gets it, and moves it forward');
  ok((await admin('/api/notes/' + n, { method: 'DELETE' })).status === 200, 'admin can delete a note');
  ok((await admin('/api/drivers/' + frank2, { method: 'DELETE' })).status === 200 && (await don('/api/drivers/' + frank2, { method: 'DELETE' })).status === 403, 'only an admin deletes drivers');
  const uma = (await post(sam, '/api/drivers', { name: 'Uma Unowned', phone: '7175550144', source: 'Facebook' })).body.id;
  ok((await patch(don, '/api/drivers/' + uma, { ownerId: donId })).status === 403, 'a lead with an active recruiter cannot be taken');
  ok((await patch(admin, '/api/users/' + samId, { active: false })).status === 200 && (await sam('/api/drivers')).status === 401, 'removing access signs the person out');
  ok((await admin('/api/drivers?owner=none')).body.drivers.some((x) => x.id === uma) && (await admin('/api/dashboard')).body.attention.unassigned >= 1, 'their leads count as having no recruiter');
  ok((await patch(don, '/api/drivers/' + uma, { ownerId: donId })).status === 403 && (await patch(admin, '/api/drivers/' + uma, { ownerId: donId })).status === 200, 'an admin gives them to another recruiter; a recruiter cannot take them');
  ok((await anon('/')).status === 200 && (await anon('/healthz')).body === 'ok' && (await anon('/api/nope')).status === 404, 'website loads, health check, unknown API path');
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
})().catch((e) => { console.log('ERROR', e); process.exitCode = 1; });
