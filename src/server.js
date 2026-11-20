// Recruiting database server: the website, logins, and the API the Chrome extension syncs with.
const path = require('path');
const express = require('express');
const db = require('./db');
const { q, sha, token, hashPassword, checkPassword, LOCKING } = db;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
  next();
});
app.use('/api/ext', (req, res, next) => { // the extension calls from chrome-extension:// pages
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const DAYS30 = 30 * 864e5;

// ---------- sign-in ----------
const cookieOf = (req, name) => (String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '=')) || '').slice(name.length + 1);
async function sessionUser(req) {
  const t = cookieOf(req, 'sid'); if (!t) return null;
  const r = await q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [sha(t)]);
  return r.rows[0] || null;
}
const needUser = wrap(async (req, res, next) => { const u = await sessionUser(req); if (!u) return res.status(401).json({ error: 'Sign in first' }); req.user = u; next(); });
const needAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only an admin can do this' }));
const needKey = wrap(async (req, res, next) => {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return res.status(401).json({ error: 'Missing access key' });
  const r = await q(`UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 RETURNING *`, [sha(t)]);
  if (!r.rows[0]) return res.status(401).json({ error: 'This access key is not valid. Create a new one on the website under Settings.' });
  req.key = r.rows[0]; next();
});

const tries = new Map(); // simple brake on password guessing: 8 tries per 15 minutes per address
app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip; const now = Date.now(); const t = (tries.get(ip) || []).filter((x) => now - x < 15 * 60000);
  if (t.length >= 8) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
  const { email, password } = req.body || {};
  const r = await q(`SELECT * FROM users WHERE lower(email) = lower($1) AND active`, [String(email || '').trim()]);
  const u = r.rows[0];
  if (!u || !checkPassword(password, u.pass_hash)) { t.push(now); tries.set(ip, t); return res.status(401).json({ error: 'Wrong email or password' }); }
  tries.delete(ip);
  const tok = token();
  await q(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [sha(tok), u.id, new Date(now + DAYS30)]);
  res.set('Set-Cookie', `sid=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS30 / 1000}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}));
app.post('/api/logout', wrap(async (req, res) => {
  const t = cookieOf(req, 'sid'); if (t) await q(`DELETE FROM sessions WHERE token_hash = $1`, [sha(t)]);
  res.set('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); res.json({ ok: true });
}));
app.get('/api/me', needUser, (req, res) => res.json({ id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role }));
app.post('/api/me/password', needUser, wrap(async (req, res) => {
  const { current, next: nw } = req.body || {};
  if (!checkPassword(current, req.user.pass_hash)) return res.status(400).json({ error: 'Your current password is wrong' });
  if (String(nw || '').length < 10) return res.status(400).json({ error: 'Use at least 10 characters' });
  await q(`UPDATE users SET pass_hash = $2 WHERE id = $1`, [req.user.id, hashPassword(nw)]);
  res.json({ ok: true });
}));

// ---------- drivers ----------
const ORDER = ['Invited', 'Replied', 'Interested', 'Email collected', 'Relay invite sent', 'Signed up on Relay', 'Hired', 'Review', 'Stalled', 'No CDL', 'Not interested', 'Declined on Indeed', 'Rejected'];
function toClient(d) {
  return { id: d.id, name: d.name, status: d.status, statusLocked: d.status_locked, phones: d.phones, emails: d.emails, location: d.location, zip: d.zip,
    mode: d.mode, source: d.source, job: d.job, account: d.account, answers: d.answers, aiSummary: d.ai_summary, redFlags: d.red_flags, transcript: d.transcript,
    conversationUrl: d.conversation_url, lastMessage: d.last_message, profileSummary: d.profile_summary, lastActive: d.last_active, invitedAt: d.invited_at,
    lastContactAt: d.last_contact_at, followUp: d.follow_up ? new Date(d.follow_up).toISOString().slice(0, 10) : null, tags: d.tags,
    createdAt: d.created_at, updatedAt: d.updated_at, noteCount: d.note_count !== undefined ? +d.note_count : undefined, lastNote: d.last_note };
}
app.get('/api/drivers', needUser, wrap(async (req, res) => {
  const { q: text = '', status = '', account = '', mode = '', due = '', sort = 'updated', limit = '100', offset = '0' } = req.query;
  const where = []; const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  if (account) add('d.account = ?', account);
  if (mode) add('d.mode = ?', mode);
  if (String(text).trim()) {
    const t = String(text).trim(); const dg = t.replace(/\D/g, '');
    params.push('%' + t.toLowerCase() + '%'); const i = params.length;
    let s = `(lower(d.name) LIKE $${i} OR lower(coalesce(d.location,'')) LIKE $${i} OR lower(array_to_string(d.emails,' ')) LIKE $${i} OR lower(coalesce(d.ai_summary,'')) LIKE $${i} OR lower(coalesce(d.red_flags,'')) LIKE $${i} OR lower(d.answers::text) LIKE $${i} OR lower(array_to_string(d.tags,' ')) LIKE $${i} OR EXISTS (SELECT 1 FROM notes n WHERE n.driver_id = d.id AND lower(n.body) LIKE $${i})`;
    if (dg.length >= 3) { params.push('%' + dg + '%'); s += ` OR array_to_string(d.phones,' ') LIKE $${params.length}`; }
    where.push(s + ')');
  }
  if (due === '1') where.push(`d.follow_up IS NOT NULL AND d.follow_up <= current_date`);
  const base = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const counts = await q(`SELECT d.status, count(*)::int n, count(*) FILTER (WHERE d.follow_up IS NOT NULL AND d.follow_up <= current_date)::int due FROM drivers d ${base} GROUP BY d.status`, params);
  const w2 = status ? (base ? base + ' AND ' : 'WHERE ') + `d.status = $${params.length + 1}` : base;
  const p2 = status ? [...params, status] : params;
  const sortSql = { updated: 'd.updated_at DESC', name: 'lower(d.name) ASC', followup: 'd.follow_up ASC NULLS LAST, d.updated_at DESC', created: 'd.created_at DESC' }[sort] || 'd.updated_at DESC';
  const total = await q(`SELECT count(*)::int n FROM drivers d ${w2}`, p2);
  const rows = await q(`SELECT d.*, (SELECT count(*) FROM notes n WHERE n.driver_id = d.id) note_count,
      (SELECT body FROM notes n WHERE n.driver_id = d.id ORDER BY n.updated_at DESC LIMIT 1) last_note
    FROM drivers d ${w2} ORDER BY ${sortSql} LIMIT ${Math.min(500, +limit || 100)} OFFSET ${Math.max(0, +offset || 0)}`, p2);
  const accounts = await q(`SELECT DISTINCT account FROM drivers WHERE account IS NOT NULL ORDER BY 1`);
  res.json({ total: total.rows[0].n, drivers: rows.rows.map(toClient), counts: counts.rows, accounts: accounts.rows.map((r) => r.account), order: ORDER });
}));
app.get('/api/drivers/:id', needUser, wrap(async (req, res) => {
  const d = await q(`SELECT * FROM drivers WHERE id = $1`, [+req.params.id]);
  if (!d.rows[0]) return res.status(404).json({ error: 'Driver not found' });
  const notes = await q(`SELECT n.*, u.name author FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.driver_id = $1 ORDER BY n.created_at DESC`, [d.rows[0].id]);
  const ev = await q(`SELECT t, type, text, who FROM driver_events WHERE driver_id = $1 ORDER BY t DESC LIMIT 200`, [d.rows[0].id]);
  res.json({ driver: toClient(d.rows[0]), notes: notes.rows.map((n) => ({ id: n.id, body: n.body, author: n.author || (n.source ? 'Chrome extension (' + n.source.slice(4) + ')' : 'Unknown'), mine: n.user_id === req.user.id, fromExtension: !!n.source, createdAt: n.created_at, updatedAt: n.updated_at })), events: ev.rows });
}));
app.post('/api/drivers', needUser, wrap(async (req, res) => {
  const b = req.body || {}; const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const phones = [db.digits(b.phone)].filter(Boolean); const emails = [String(b.email || '').trim().toLowerCase()].filter((e) => e.includes('@'));
  const r = await q(`INSERT INTO drivers (name, name_key, phones, emails, location, source, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [name, db.keyOf(name), phones, emails, b.location || null, b.source || 'Added by hand', ORDER.includes(b.status) ? b.status : 'Replied']);
  await q(`INSERT INTO driver_events (driver_id, type, text, who, fp) VALUES ($1, 'manual', $2, $3, $4)`, [r.rows[0].id, 'Added on the website', req.user.name, sha(Date.now() + name)]);
  res.json({ id: r.rows[0].id });
}));
app.patch('/api/drivers/:id', needUser, wrap(async (req, res) => {
  const id = +req.params.id; const b = req.body || {};
  const cur = (await q(`SELECT * FROM drivers WHERE id = $1`, [id])).rows[0]; if (!cur) return res.status(404).json({ error: 'Driver not found' });
  const set = {}; const log = [];
  if (b.status !== undefined && ORDER.includes(b.status) && b.status !== cur.status) { set.status = b.status; set.status_locked = true; set.status_at = new Date().toISOString(); log.push(`Status set to ${b.status}`); }
  if (b.statusLocked === false) set.status_locked = false;
  if (b.followUp !== undefined) { set.follow_up = b.followUp || null; log.push(b.followUp ? `Follow-up set for ${b.followUp}` : 'Follow-up cleared'); }
  if (Array.isArray(b.tags)) set.tags = [...new Set(b.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
  for (const [k, col] of [['name', 'name'], ['location', 'location'], ['zip', 'zip'], ['aiSummary', 'ai_summary'], ['redFlags', 'red_flags'], ['mode', 'mode']]) if (b[k] !== undefined) set[col] = String(b[k]).trim() || null;
  if (set.name === null) delete set.name; if (set.name) set.name_key = db.keyOf(set.name);
  if (Array.isArray(b.phones)) set.phones = [...new Set(b.phones.map(db.digits).filter(Boolean))];
  if (Array.isArray(b.emails)) set.emails = [...new Set(b.emails.map((e) => String(e).trim().toLowerCase()).filter((e) => e.includes('@')))];
  if (b.answers && typeof b.answers === 'object') set.answers = JSON.stringify(b.answers);
  if (!Object.keys(set).length) return res.json({ ok: true });
  const cols = Object.keys(set);
  await q(`UPDATE drivers SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now(), web_updated_at = now() WHERE id = $1`, [id, ...cols.map((k) => set[k])]);
  for (const text of log) await q(`INSERT INTO driver_events (driver_id, type, text, who, fp) VALUES ($1, 'web', $2, $3, $4)`, [id, text, req.user.name, sha(Date.now() + text + Math.random())]);
  res.json({ ok: true });
}));
app.delete('/api/drivers/:id', needUser, needAdmin, wrap(async (req, res) => { await q(`DELETE FROM drivers WHERE id = $1`, [+req.params.id]); res.json({ ok: true }); }));

// notes
const touch = (id) => q(`UPDATE drivers SET updated_at = now(), web_updated_at = now() WHERE id = $1`, [id]);
app.post('/api/drivers/:id/notes', needUser, wrap(async (req, res) => {
  const body = String((req.body || {}).body || '').trim(); if (!body) return res.status(400).json({ error: 'Write something first' });
  const r = await q(`INSERT INTO notes (driver_id, user_id, body) VALUES ($1, $2, $3) RETURNING id`, [+req.params.id, req.user.id, body.slice(0, 5000)]);
  await touch(+req.params.id); res.json({ id: r.rows[0].id });
}));
async function ownNote(req, res) {
  const n = (await q(`SELECT * FROM notes WHERE id = $1`, [+req.params.id])).rows[0];
  if (!n) { res.status(404).json({ error: 'Note not found' }); return null; }
  if (n.user_id !== req.user.id && req.user.role !== 'admin') { res.status(403).json({ error: 'You can only change your own notes' }); return null; }
  return n;
}
app.patch('/api/notes/:id', needUser, wrap(async (req, res) => {
  const n = await ownNote(req, res); if (!n) return;
  const body = String((req.body || {}).body || '').trim(); if (!body) return res.status(400).json({ error: 'A note cannot be empty. Delete it instead.' });
  await q(`UPDATE notes SET body = $2, updated_at = now() WHERE id = $1`, [n.id, body.slice(0, 5000)]); await touch(n.driver_id); res.json({ ok: true });
}));
app.delete('/api/notes/:id', needUser, wrap(async (req, res) => {
  const n = await ownNote(req, res); if (!n) return;
  await q(`DELETE FROM notes WHERE id = $1`, [n.id]); await touch(n.driver_id); res.json({ ok: true });
}));

// export / import
app.get('/api/export.csv', needUser, wrap(async (req, res) => {
  const r = await q(`SELECT d.*, (SELECT string_agg(n.body, ' | ' ORDER BY n.created_at) FROM notes n WHERE n.driver_id = d.id) all_notes FROM drivers d ORDER BY d.updated_at DESC`);
  const cols = ['name', 'status', 'phones', 'emails', 'location', 'zip', 'account', 'mode', 'source', 'job', 'follow_up', 'tags', 'all_notes', 'red_flags', 'ai_summary', 'answers', 'last_contact_at', 'updated_at', 'conversation_url'];
  const cell = (v) => `"${String(Array.isArray(v) ? v.join('; ') : v && typeof v === 'object' && !(v instanceof Date) ? Object.entries(v).map(([k, x]) => `${k}: ${x}`).join('; ') : v instanceof Date ? v.toISOString() : v ?? '').replace(/"/g, '""')}"`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="drivers-${new Date().toISOString().slice(0, 10)}.csv"` });
  res.send('﻿' + [cols.join(','), ...r.rows.map((d) => cols.map((c) => cell(d[c])).join(','))].join('\r\n'));
}));
app.post('/api/import', needUser, wrap(async (req, res) => {
  const drivers = Object.values(((req.body || {}).drivers) || {});
  if (!drivers.length) return res.status(400).json({ error: 'No drivers in this file. Use "Download a backup" on the extension\'s database page.' });
  const label = String((req.body || {}).label || 'import').slice(0, 60);
  const c = await db.pool.connect(); let n = 0;
  try { await c.query('BEGIN'); for (const d of drivers) { if (await db.mergeFromExtension(c, d, label)) n++; } await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  res.json({ ok: true, merged: n });
}));

// ---------- team and access keys ----------
app.get('/api/users', needUser, needAdmin, wrap(async (req, res) => res.json((await q(`SELECT id, email, name, role, active, created_at FROM users ORDER BY id`)).rows)));
app.post('/api/users', needUser, needAdmin, wrap(async (req, res) => {
  const { email, name, password, role } = req.body || {};
  if (!String(email || '').includes('@') || !String(name || '').trim()) return res.status(400).json({ error: 'Name and email are required' });
  if (String(password || '').length < 10) return res.status(400).json({ error: 'Password needs at least 10 characters' });
  try { await q(`INSERT INTO users (email, name, pass_hash, role) VALUES ($1, $2, $3, $4)`, [String(email).trim().toLowerCase(), String(name).trim(), hashPassword(password), role === 'admin' ? 'admin' : 'member']); }
  catch (e) { if (e.code === '23505') return res.status(400).json({ error: 'Someone already uses that email' }); throw e; }
  res.json({ ok: true });
}));
app.patch('/api/users/:id', needUser, needAdmin, wrap(async (req, res) => {
  const id = +req.params.id; const b = req.body || {};
  if (id === req.user.id && (b.active === false || b.role === 'member')) return res.status(400).json({ error: "You can't remove your own admin access" });
  if (b.password !== undefined) { if (String(b.password).length < 10) return res.status(400).json({ error: 'Password needs at least 10 characters' }); await q(`UPDATE users SET pass_hash = $2 WHERE id = $1`, [id, hashPassword(b.password)]); await q(`DELETE FROM sessions WHERE user_id = $1`, [id]); }
  if (b.active !== undefined) { await q(`UPDATE users SET active = $2 WHERE id = $1`, [id, !!b.active]); if (!b.active) await q(`DELETE FROM sessions WHERE user_id = $1`, [id]); }
  if (b.role) await q(`UPDATE users SET role = $2 WHERE id = $1`, [id, b.role === 'admin' ? 'admin' : 'member']);
  res.json({ ok: true });
}));
app.get('/api/keys', needUser, wrap(async (req, res) => res.json((await q(`SELECT k.id, k.name, k.created_at, k.last_used_at, u.name owner FROM api_keys k LEFT JOIN users u ON u.id = k.user_id ORDER BY k.id`)).rows)));
app.post('/api/keys', needUser, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60); if (!name) return res.status(400).json({ error: 'Give the key a name, like the Chrome profile or Indeed account' });
  const key = token('rk_');
  await q(`INSERT INTO api_keys (name, key_hash, user_id) VALUES ($1, $2, $3)`, [name, sha(key), req.user.id]);
  res.json({ key }); // shown once
}));
app.delete('/api/keys/:id', needUser, wrap(async (req, res) => { await q(`DELETE FROM api_keys WHERE id = $1`, [+req.params.id]); res.json({ ok: true }); }));

// ---------- the Chrome extension ----------
app.get('/api/ext/ping', needKey, (req, res) => res.json({ ok: true, name: req.key.name }));
app.post('/api/ext/push', needKey, wrap(async (req, res) => {
  const items = Array.isArray((req.body || {}).drivers) ? req.body.drivers.slice(0, 500) : [];
  const c = await db.pool.connect(); let n = 0;
  try { await c.query('BEGIN'); for (const d of items) { if (await db.mergeFromExtension(c, d, req.key.name)) n++; } await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  res.json({ ok: true, merged: n });
}));
// What changed on the website since the last pull: team notes, status set by hand, follow-ups, tags.
app.get('/api/ext/pull', needKey, wrap(async (req, res) => {
  const since = new Date(String(req.query.since || 0)); const sinceIso = isNaN(since) ? new Date(0).toISOString() : since.toISOString();
  const r = await q(`SELECT d.*, (SELECT string_agg(coalesce(u.name, 'Chrome ' || substr(n.source, 5)) || ', ' || to_char(n.created_at, 'Mon DD') || ': ' || n.body, E'\\n' ORDER BY n.created_at DESC)
      FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.driver_id = d.id AND coalesce(n.source, '') <> $2) team_notes
    FROM drivers d WHERE d.web_updated_at > $1 ORDER BY d.web_updated_at LIMIT 1000`, [sinceIso, 'ext:' + req.key.name]);
  res.json({ now: new Date().toISOString(), drivers: r.rows.map((d) => ({ name: d.name, phones: d.phones, emails: d.emails, account: d.account, status: d.status, statusLocked: d.status_locked, followUp: d.follow_up ? new Date(d.follow_up).toISOString().slice(0, 10) : null, tags: d.tags, teamNotes: d.team_notes || '', url: `/#/driver/${d.id}` })) });
}));

// ---------- website ----------
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong on the server. Try again.' }); });

(async () => {
  await db.migrate();
  const n = (await q(`SELECT count(*)::int n FROM users`)).rows[0].n;
  if (!n) {
    const email = process.env.ADMIN_EMAIL, pw = process.env.ADMIN_PASSWORD;
    if (!email || !pw) console.warn('No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD, then restart, to create the first admin.');
    else { await q(`INSERT INTO users (email, name, pass_hash, role) VALUES ($1, $2, $3, 'admin')`, [email.toLowerCase(), process.env.ADMIN_NAME || 'Admin', hashPassword(pw)]); console.log('Created the first admin:', email); }
  }
  await q(`DELETE FROM sessions WHERE expires_at < now()`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Recruiting database on port ${port}`));
})().catch((e) => { console.error(e); process.exit(1); });
