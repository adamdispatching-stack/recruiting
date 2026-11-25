// A driver who reached us through two or three Indeed accounts is highlighted: for sure when the same phone or
// email came in through each account, "maybe" when only the name is the same.
//   bash test/all.sh multi-account
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const q = db.q;
(async () => {
  const r0 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }) });
  const cookie = (r0.headers.get('set-cookie') || '').split(';')[0];
  const web = async (p) => { const x = await fetch(BASE + p, { headers: { cookie } }); return { http: x.status, ...(await x.json().catch(() => ({}))) }; };
  const push = async (rec) => { const c = await db.pool.connect(); try { return await db.mergeFromExtension(c, rec, 'ext:test'); } finally { c.release(); } };
  const row = async (name) => (await q(`SELECT id, account, accounts FROM drivers WHERE name = $1 ORDER BY id`, [name])).rows;

  // the same phone comes in through three accounts: one lead, three accounts
  await push({ name: 'Mona Multi', account: 'a@example.com', phones: ['2155550170'] });
  await push({ name: 'Mona Multi', account: 'b@example.com', phones: ['2155550170'] });
  await push({ name: 'Mona M.', account: 'c@example.com', phones: ['(215) 555-0170'] });
  await push({ name: 'Mona Multi', account: 'a@example.com', phones: ['2155550170'] });
  let m = await row('Mona Multi');
  ok(m.length === 1 && m[0].accounts.join() === 'a@example.com,b@example.com,c@example.com', 'the same phone through three Indeed accounts: one lead that keeps all three accounts, each once');

  // one account only
  await push({ name: 'Otto Once', account: 'a@example.com', phones: ['2155550171'] });
  ok((await row('Otto Once'))[0].accounts.join() === 'a@example.com', 'a driver from one account has that one account');

  // the same name in two accounts, nothing else in common: two leads, each pointing at the other as "maybe"
  await push({ name: 'Nate Namesake', account: 'a@example.com' });
  await push({ name: 'Nate Namesake', account: 'b@example.com' });
  const n = await row('Nate Namesake');
  ok(n.length === 2 && n[0].accounts.length === 1, 'the same name in two accounts with no phone or email in common stays two leads');

  const list = await web('/api/drivers?stage=&limit=500&q=');
  const by = (name) => list.drivers.filter((d) => d.name === name);
  ok(by('Mona Multi')[0].accounts.length === 3 && by('Mona Multi')[0].sameName === 0, 'the leads list gives the three accounts of the driver');
  ok(by('Otto Once')[0].accounts.length === 1 && by('Otto Once')[0].sameName === 0, 'and one account, nothing to highlight, for the other');
  ok(by('Nate Namesake').length === 2 && by('Nate Namesake').every((d) => d.sameName === 1), 'the two same-name leads each say: same name in 1 other account');

  // the filter and the account filter
  const multi = await web('/api/drivers?stage=&limit=500&multi=1');
  const names = multi.drivers.map((d) => d.name);
  ok(names.includes('Mona Multi') && names.filter((x) => x === 'Nate Namesake').length === 2 && !names.includes('Otto Once'), '"In 2 or more Indeed accounts" shows the sure ones and the same-name ones, not the others');
  const inB = await web('/api/drivers?stage=&limit=500&account=' + encodeURIComponent('b@example.com'));
  ok(inB.drivers.some((d) => d.name === 'Mona Multi'), 'filtering on an account finds a driver who also came through that account, not only by the latest one');

  // the lead page: who else has this name
  const sn = await web(`/api/drivers/${n[0].id}/same-name`);
  ok(sn.leads.length === 1 && sn.leads[0].id === n[1].id && sn.leads[0].account === 'b@example.com', 'the lead page lists the lead with the same name in the other account');
  ok((await web(`/api/drivers/${m[0].id}/same-name`)).leads.length === 0, 'and nothing for a driver whose name is nowhere else');
  ok((await web(`/api/drivers/${m[0].id}`)).driver.accounts.length === 3, 'the lead itself carries its accounts');
  // what every Chrome profile is told with its pull: the names that are in several accounts
  const key = 'rk_test_multi_account';
  await q(`INSERT INTO api_keys (name, key_hash, user_id) VALUES ('multi test', $1, (SELECT id FROM users ORDER BY id LIMIT 1))`, [db.sha(key)]);
  const pull = await (await fetch(BASE + '/api/ext/pull?since=' + encodeURIComponent(new Date().toISOString()), { headers: { authorization: 'Bearer ' + key } })).json();
  const sh = pull.shared || {};
  ok(sh['mona multi'] && sh['mona multi'].sure === true && sh['mona multi'].accounts.length === 3, 'the extension is told: Mona is in three accounts, for sure');
  ok(sh['nate namesake'] && sh['nate namesake'].sure === false && sh['nate namesake'].accounts.slice().sort().join() === 'a@example.com,b@example.com', 'and Nate\'s name is in two accounts, maybe the same person');
  ok(!sh['otto once'], 'a driver in one account is not in that list');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
