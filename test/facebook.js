// Test of Facebook work: entries with links and pictures, daily targets, duplicates, admin review, leads.
//   node test/facebook.js http://localhost:3999 admin@example.com password
const [, , base = 'http://localhost:3999', email = 'admin@example.com', pw = 'test-password-123'] = process.argv;
function session() {
  let cookie = '';
  return async (path, opts = {}) => {
    const r = await fetch(base + path, { method: opts.method || 'GET', headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || ''; const t = ct.startsWith('image/') ? Buffer.from(await r.arrayBuffer()) : await r.text(); let j; try { j = typeof t === 'string' ? JSON.parse(t) : t; } catch (e) { j = t; }
    return { status: r.status, body: j, type: ct };
  };
}
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const u = Date.now().toString().slice(-6);
// a tiny different PNG each time (1x1 pixel, colour from a number)
const png = (n) => { const zlib = require('zlib'); const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, n % 256, (n >> 8) % 256, (n >> 16) % 256]);
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64'); };
(async () => {
  const A = session(); await A('/api/login', { method: 'POST', body: { email, password: pw } });
  await A('/api/settings', { method: 'PUT', body: { fbTargets: { post: 2, comment: 3, contact: 2, chat: 1, ppost: 0, pcomment: 0 } } });
  const id = (await A('/api/users', { method: 'POST', body: { name: `Fay Facebook ${u}`, email: `fay${u}@example.com`, password: 'fay-pass-12345' } })).body.id;
  const R = session(); await R('/api/login', { method: 'POST', body: { email: `fay${u}@example.com`, password: 'fay-pass-12345' } });
  const pic = async (n) => (await R('/api/fb/images', { method: 'POST', body: { data: png(+u + n) } })).body.id;
  const add = (b) => R('/api/fb/entries', { method: 'POST', body: b });
  let r = await add({ kind: 'post', groupName: 'CDL Drivers USA', link: `https://www.facebook.com/groups/111/posts/${u}1/` });
  ok(r.status === 400 && /picture/.test(r.body.error), 'a post needs its picture');
  r = await add({ kind: 'post', groupName: 'CDL Drivers USA', link: 'https://example.com/x', imageId: await pic(1) });
  ok(r.status === 400 && /Facebook/.test(r.body.error), 'a post link must be a Facebook link');
  const p1 = await pic(2);
  r = await add({ kind: 'post', groupName: 'CDL Drivers USA', groupLink: 'https://www.facebook.com/groups/111', link: `https://www.facebook.com/groups/111/posts/${u}1/?mibextid=abc`, imageId: p1 });
  ok(r.status === 200, 'post saved with its group, link and picture');
  const e1 = r.body.id;
  r = await add({ kind: 'post', groupName: 'CDL Drivers USA', link: `https://m.facebook.com/groups/111/posts/${u}1`, imageId: await pic(3) });
  ok(r.status === 400 && /already recorded/.test(r.body.error), 'the same post twice is caught (even with another link form)');
  r = await R('/api/fb/images', { method: 'POST', body: { data: png(+u + 2) } });
  ok(r.status === 409 && /already used/.test(r.body.error), 'the same picture twice is caught');
  r = await add({ kind: 'post', groupName: 'OTR Drivers', link: `https://www.facebook.com/groups/222/posts/${u}2`, imageId: p1 });
  ok(r.status === 400, 'a picture already on an entry cannot be used again');
  ok((await add({ kind: 'post', groupName: 'OTR Drivers', link: `https://www.facebook.com/groups/222/posts/${u}2`, imageId: await pic(4) })).status === 200, 'second post');
  for (let i = 0; i < 2; i++) ok((await add({ kind: 'comment', link: `https://www.facebook.com/${u}c${i}/posts/9${i}`, imageId: await pic(10 + i) })).status === 200, `comment ${i + 1} with its screenshot`);
  ok((await add({ kind: 'comment', link: `https://www.facebook.com/${u}c9/posts/99` })).status === 400, 'a comment needs a screenshot');
  r = await add({ kind: 'contact', link: `https://www.facebook.com/profile.php?id=${u}77&ref=xyz`, personName: 'Tom Trucker', otr: 'yes', cdlA: 'yes', outcome: 'interested', phone: '(267) 555-0' + u.slice(-3) });
  ok(r.status === 200, 'driver messaged, with OTR and Class A CDL answers');
  const c1 = r.body.id;
  ok((await add({ kind: 'contact', link: `https://facebook.com/profile.php?id=${u}77` })).status === 400, 'the same driver messaged twice is caught');
  ok((await add({ kind: 'chat', groupName: 'NJ CDL drivers chat', link: `https://m.me/j/${u}` })).status === 200, 'group chat joined');
  let d = (await R('/api/fb/day')).body;
  ok(d.counts.post === 2 && d.counts.comment === 2 && d.counts.contact === 1 && d.counts.chat === 1 && d.score.done === 6 && d.score.target === 8 && !d.score.met, 'today: 6 of 8 done');
  ok((await R(`/api/fb/images/${p1}`)).type.startsWith('image/'), 'the recruiter sees their picture');
  // a lead from the driver
  r = await R(`/api/fb/entries/${c1}/lead`, { method: 'POST', body: {} });
  const lead = (await R('/api/drivers/' + r.body.id)).body.driver;
  ok(r.status === 200 && lead.source === 'Facebook' && lead.ownerId === id && lead.status === 'Interested' && lead.phones.length === 1, 'the interested driver became her lead (source Facebook, with the phone)');
  ok((await R(`/api/fb/entries/${c1}/lead`, { method: 'POST', body: {} })).body.id === r.body.id, 'asking twice gives the same lead');
  // admin review
  const T = (await A('/api/fb/team')).body.people.find((p) => p.id === id);
  ok(T && T.counts.post === 2 && T.counts.unreviewed === 6, 'admin sees her on the team day, 6 to check');
  ok((await R('/api/fb/entries/' + e1, { method: 'PATCH', body: { review: 'ok' } })).status === 403, 'a recruiter cannot review');
  ok((await A('/api/fb/entries/' + e1, { method: 'PATCH', body: { review: 'problem' } })).status === 400, 'a problem needs a note');
  ok((await A('/api/fb/entries/' + e1, { method: 'PATCH', body: { review: 'problem', reviewNote: 'The link does not open' } })).status === 200, 'admin flags a problem');
  d = (await R('/api/fb/day')).body;
  ok(d.entries.find((x) => x.id === e1).reviewNote === 'The link does not open', 'the recruiter sees the note');
  r = await R('/api/fb/entries/' + e1, { method: 'PATCH', body: { link: `https://www.facebook.com/groups/111/posts/${u}5` } });
  d = (await R('/api/fb/day')).body;
  ok(r.status === 200 && d.entries.find((x) => x.id === e1).review === null, 'she fixes the link and it goes back to the admin');
  await A('/api/fb/entries/' + e1, { method: 'PATCH', body: { review: 'ok' } });
  ok((await R('/api/fb/entries/' + e1, { method: 'DELETE' })).status === 403 && (await R('/api/fb/entries/' + e1, { method: 'PATCH', body: { note: 'x' } })).status === 400, 'a checked entry cannot be changed or removed by her');
  ok((await R('/api/fb/day?user=' + (id + 1000))).status === 403, 'recruiters see only their own day');
  ok((await A('/api/fb/groups')).body.groups.some((g) => g.name === 'CDL Drivers USA' && g.posts === 1), 'groups the team posts in');
  const team = (await A('/api/team?period=today')).body.people.find((p) => p.id === id);
  ok(team.fb && team.fb.done === 6 && team.fb.target === 8, 'Team page today: 6 of 8');
  // the team's group list
  const G = (b) => R('/api/fb/groups', { method: 'POST', body: b });
  ok((await G({ name: 'Bad link', link: 'https://www.facebook.com/someone' })).status === 400, 'a group needs a group link');
  r = await G({ name: `Owner Operators NE ${u}`, link: `https://www.facebook.com/groups/oone${u}/?ref=share`, audience: 'owner operators', members: '45.2K', privacy: 'private', approval: 'yes', mine: 'requested' });
  ok(r.status === 200, 'recruiter adds a group (members 45.2K, private, posts checked first)');
  const gid = r.body.id;
  r = await A('/api/fb/groups', { method: 'POST', body: { name: 'Same one', link: `https://m.facebook.com/groups/oone${u}/about`, mine: 'joined' } });
  ok(r.status === 409 && /already on the list/.test(r.body.error), 'the same group twice is caught (other link form)');
  let L = (await A('/api/fb/groups')).body.groups.find((g) => g.id === gid);
  ok(L.members === 45200 && L.privacy === 'private' && L.approval === 'yes' && L.audience === 'owner operators', 'facts saved');
  ok(L.team.some((m) => m.id === id && m.status === 'requested') && L.mine === 'joined', 'everyone sees who is in it; the admin is now in it too');
  await R(`/api/fb/groups/${gid}/me`, { method: 'PUT', body: { status: 'joined' } });
  L = (await R('/api/fb/groups')).body.groups.find((g) => g.id === gid);
  ok(L.mine === 'joined', 'she was accepted and marks it');
  ok((await R(`/api/fb/groups/${gid}`, { method: 'PATCH', body: { members: '46,000' } })).status === 200 && (await R('/api/fb/groups')).body.groups.find((g) => g.id === gid).members === 46000, 'anyone updates the member count');
  ok((await R(`/api/fb/groups/${gid}`, { method: 'DELETE' })).status === 403, 'only an admin removes a group');
  // a post with a group link puts the group on the list, with the poster in it
  await add({ kind: 'post', groupName: 'Brand New Group', groupLink: `https://www.facebook.com/groups/bng${u}`, link: `https://www.facebook.com/groups/bng${u}/posts/1`, imageId: await pic(40) });
  L = (await R('/api/fb/groups')).body.groups.find((g) => g.name === 'Brand New Group');
  ok(L && L.mine === 'joined' && L.posts === 1, 'posting in a new group puts it on the list');
  const day = (await R('/api/fb/day')).body;
  ok(day.groups[0] && day.groups.some((g) => g.name === `Owner Operators NE ${u}`), 'the post form suggests the listed groups');
})().catch((e) => { console.log('ERROR', e); process.exitCode = 1; });
