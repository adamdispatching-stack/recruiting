// Test of sharing new leads evenly, and that only an admin changes a lead's recruiter.
//   node test/share.js http://localhost:3999 admin@example.com password
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
  const today = (await A('/api/me')).body.today;
  const all7 = Array.from({ length: 7 }, () => ({ s: '00:00', e: '23:59' }));
  const ids = [];
  for (const n of ['Ana', 'Ben', 'Cy']) {
    const id = (await A('/api/users', { method: 'POST', body: { name: `${n} Share${u}`, email: `${n.toLowerCase()}${u}@example.com`, password: 'share-pass-123' } })).body.id;
    await A(`/api/team/${id}/hours`, { method: 'PUT', body: { week: all7 } }); ids.push(id);
  }
  // only these three get leads in this test
  let r = await A('/api/settings', { method: 'PUT', body: { share: { on: true, people: ids } } });
  ok(r.status === 200 && r.body.share.on && r.body.share.people.length === 3, 'sharing saved with three recruiters');
  const key = (await A('/api/keys', { method: 'POST', body: { name: 'Share test ' + u, assignTo: ids[0] } })).body.key;
  const K = { Authorization: 'Bearer ' + key };
  const push = (drivers) => A('/api/ext/push', { method: 'POST', body: { drivers }, headers: K });
  const lead = (i) => ({ name: `Share Lead ${u} ${i}`, account: 'x@gmail.com', phones: [`(301) 55${String(i).padStart(1, '0')}-${u.slice(-4)}`.replace(/\D/g, '').slice(0, 10)], status: 'Replied', updatedAt: new Date().toISOString() });
  r = await push(Array.from({ length: 9 }, (_, i) => lead(i)));
  ok(r.status === 200, 'nine leads pushed by the extension');
  const list = (await A(`/api/drivers?q=${encodeURIComponent('Share Lead ' + u)}&limit=100`)).body;
  const rows = (list.drivers || list.rows || list).filter((d) => String(d.name).includes('Share Lead ' + u));
  const count = (id) => rows.filter((d) => d.ownerId === id).length;
  ok(rows.length === 9 && ids.every((id) => count(id) === 3), `shared 3 / 3 / 3, not all to the key's recruiter: ${ids.map(count).join(' / ')}`);
  const ev = (await A('/api/drivers/' + rows[0].id)).body.events || [];
  ok(ev.some((e) => /leads shared evenly/.test(e.text)), 'the lead history says it was shared evenly');
  // a day off: skipped
  await A(`/api/team/${ids[1]}/days/${today}`, { method: 'PUT', body: { reason: 'test' } });
  r = await push([lead(10), lead(11)].map((x, i) => ({ ...x, phones: [`240555${u.slice(-3)}${i}`] })));
  const sh = (await A('/api/share')).body;
  const st = Object.fromEntries(sh.people.map((p) => [p.id, p]));
  ok(st[ids[1]].today === 3 && st[ids[0]].today === 4 && st[ids[2]].today === 4 && st[ids[1]].off, 'someone on a day off gets no new leads: ' + ids.map((id) => st[id].today).join(' / '));
  await A(`/api/team/${ids[1]}/days/${today}`, { method: 'DELETE' });
  ok((await A('/api/share')).body.next === ids[1], 'back from the day off: next lead goes to them');
  // admin adds a lead with "next in line"
  r = await A('/api/drivers', { method: 'POST', body: { name: `Admin Added ${u}`, source: 'Indeed', ownerId: 'share' } });
  ok((await A('/api/drivers/' + r.body.id)).body.driver.ownerId === ids[1], 'an admin-added lead can go to the next in line');
  // a recruiter's own lead doesn't count against them
  const B = session(); await B('/api/login', { method: 'POST', body: { email: `ana${u}@example.com`, password: 'share-pass-123' } });
  const own = (await B('/api/drivers', { method: 'POST', body: { name: `Ana Own ${u}`, source: 'Indeed', phone: '410555' + u.slice(-4) } })).body.id;
  ok((await A('/api/drivers/' + own)).body.driver.ownerId === ids[0], "a recruiter's own lead stays theirs");
  ok((await A('/api/share')).body.people.find((p) => p.id === ids[0]).today === 4, "and doesn't count as a shared lead");
  // recruiters cannot change the recruiter
  ok((await B('/api/drivers/' + own, { method: 'PATCH', body: { ownerId: null } })).status === 403, 'a recruiter cannot let go of a lead');
  ok((await B('/api/drivers/' + own, { method: 'PATCH', body: { ownerId: ids[2] } })).status === 403, 'a recruiter cannot hand a lead to someone else');
  const unowned = (await A('/api/drivers', { method: 'POST', body: { name: `Nobody Yet ${u}`, source: 'Indeed', ownerId: null, phone: '443555' + u.slice(-4) } })).body.id;
  ok((await B('/api/drivers/' + unowned, { method: 'PATCH', body: { ownerId: ids[0] } })).status === 403, 'a recruiter cannot take an unassigned lead');
  ok((await A('/api/drivers/' + own, { method: 'PATCH', body: { ownerId: ids[2] } })).status === 200, 'an admin can');
  // share the waiting ones
  const before = (await A('/api/share')).body;
  ok(before.waiting >= 1, `${before.waiting} unassigned lead(s) waiting`);
  r = await A('/api/share/now', { method: 'POST' });
  ok(r.status === 200 && r.body.shared === before.waiting && (await A('/api/share')).body.waiting === 0, 'Share now gives them out');
  ok((await A('/api/drivers/' + unowned)).body.driver.ownerId, 'the unassigned lead has a recruiter now');
  // turned off: the key's recruiter again
  await A('/api/settings', { method: 'PUT', body: { share: { on: false, people: ids } } });
  await push([{ ...lead(20), phones: ['202555' + u.slice(-4)] }]);
  const off = ((await A(`/api/drivers?q=${encodeURIComponent('Share Lead ' + u + ' 20')}`)).body.drivers || []).find((d) => d.name.endsWith(' 20'));
  ok(off && off.ownerId === ids[0], 'sharing off: the key decides again');
  await A('/api/settings', { method: 'PUT', body: { share: { on: true, people: null } } });
  ok(!(await B('/api/share')).body.people, 'a recruiter cannot see the sharing standings');
})();
