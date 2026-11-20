// Shared pieces for the API: sign-in checks, who may see what, the activity log, and day ranges.
const db = require('./db');
const { q, sha } = db;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

// ---------- who may see which leads ----------
// People whose access was removed. Their leads count as up for grabs: listed as "no recruiter", and anyone may take them.
const gone = new Set();
async function loadGone() { gone.clear(); for (const r of (await q(`SELECT id FROM users WHERE NOT active`)).rows) gone.add(r.id); }
const unowned = (d) => !d.owner_id || gone.has(d.owner_id);
const unownedSql = (alias = 'd') => `(${alias}.owner_id IS NULL OR ${alias}.owner_id IN (SELECT id FROM users WHERE NOT active))`;
const seesAll = (u) => u.role === 'admin' || db.settings.visibility !== 'own';
// Adds the "only my own and unassigned leads" condition for recruiters when that setting is on.
function visSql(u, params, alias = 'd') {
  if (seesAll(u)) return null;
  params.push(u.id);
  return `(${alias}.owner_id = $${params.length} OR ${unownedSql(alias)})`;
}
const canSee = (u, d) => seesAll(u) || unowned(d) || d.owner_id === u.id;
async function loadDriver(req, res, id = req.params.id) {
  const d = (await q(`SELECT * FROM drivers WHERE id = $1`, [+id || 0])).rows[0];
  if (!d || !canSee(req.user, d)) { res.status(404).json({ error: 'Driver not found' }); return null; }
  return d;
}

// A note as one line of text; a logged call, text or email reads "Call, no answer: ...".
const NOTE_TEXT = `CASE WHEN n.kind IS NULL THEN n.body ELSE initcap(n.kind) || ', ' || lower(coalesce(n.outcome, '')) || CASE WHEN n.body <> '' THEN ': ' || n.body ELSE '' END END`;

// ---------- the activity log ----------
// act: one line in the person's own feed (what the admin reads on the Team page).
async function act(user, type, driver, detail) {
  await q(`INSERT INTO activity (user_id, type, driver_id, driver_name, detail) VALUES ($1, $2, $3, $4, $5)`,
    [user.id, type, driver && driver.id ? driver.id : null, driver ? driver.name : null, detail ? String(detail).slice(0, 300) : null]);
}
// history: one line in the driver's own timeline.
async function history(driverId, text, who, type = 'web') {
  await q(`INSERT INTO driver_events (driver_id, type, text, who, fp) VALUES ($1, $2, $3, $4, $5)`, [driverId, type, String(text).slice(0, 2000), who, sha(Date.now() + text + Math.random())]);
}
// record: both at once.
async function record(req, type, driver, text) { await act(req.user, type, driver, text); await history(driver.id, text, req.user.name); }

// ---------- days ----------
// Reports count days in the team's time zone (Settings), so a shift that crosses midnight elsewhere stays one day.
const PERIODS = { today: [0, 0], yesterday: [1, 1], '7d': [6, 0], '30d': [29, 0] };
async function range(period) {
  const key = PERIODS[period] ? period : 'today'; const [a, b] = PERIODS[key];
  const r = await q(`SELECT t.today::text today, ((t.today - $2::int)::timestamp AT TIME ZONE $1) from_ts, ((t.today - $3::int + 1)::timestamp AT TIME ZONE $1) to_ts
    FROM (SELECT (now() AT TIME ZONE $1)::date today) t`, [db.settings.tz, a, b]);
  return { period: key, today: r.rows[0].today, from: r.rows[0].from_ts, to: r.rows[0].to_ts, days: a - b + 1, tz: db.settings.tz };
}
const today = async () => (await q(`SELECT (now() AT TIME ZONE $1)::date::text d`, [db.settings.tz])).rows[0].d;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T00:00:00Z'));
const niceDate = (v) => new Date(v + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const validTz = (v) => { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true; } catch (e) { return false; } };

module.exports = { wrap, cookieOf, sessionUser, needUser, needAdmin, needKey, seesAll, visSql, canSee, loadGone, unowned, unownedSql, loadDriver, act, history, record, range, today, isDate, niceDate, validTz, PERIODS, NOTE_TEXT };
