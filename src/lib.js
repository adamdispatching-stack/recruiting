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
// A dispatcher works with the trucks and the active drivers: the recruiting screens are not theirs.
const DISPATCH_OK = [/^\/api\/(cases|playbooks|orientation|places|hometime)(\/|$)/, /^\/api\/(me|logout|beat|track)(\/|$)/, /^\/api\/notices/, /^\/api\/trucks(\/|$)/, /^\/api\/truck-events\//, /^\/api\/docs(\/|$)/, /^\/api\/fleet\//,
  /^\/api\/drivers\/\d+\/profile/, /^\/api\/team\/(\d+|me)(\/month)?$/, /^\/api\/tg\/(chats|alerts|me-code|status)(\/|$)/];
const DISPATCH_GET = [/^\/api\/companies(\/\d+)?$/, /^\/api\/active(\/\d+)?$/, /^\/api\/kb(\/search)?$/];
// A recruiter works with leads, onboarding and the trucks (not the fleet's settings, removing a truck or deleting its
// history). The other dispatching screens (active drivers, road cases, shops, the shift desk, the dispatchers'
// learning) are not theirs.
const RECRUIT_NO = [/^\/api\/(cases|playbooks|places|hometime|active)(\/|$)/, /^\/api\/fleet\/settings(\/|$)/, /^\/api\/drivers\/\d+\/profile/,
  /^\/api\/tg\/(dispatch-readiness|updates|desk|routines|notes|terms|dispatchers)(\/|$)/];
const recruiterMay = (req) => !RECRUIT_NO.some((r) => r.test(req.path));
const dispatcherMay = (req) => { const p = req.path; return DISPATCH_OK.some((r) => r.test(p)) || (req.method === 'GET' && DISPATCH_GET.some((r) => r.test(p))); };
const needUser = wrap(async (req, res, next) => {
  const u = await sessionUser(req); if (!u) return res.status(401).json({ error: 'Sign in first' });
  if (u.role === 'dispatcher' && !dispatcherMay({ method: req.method, path: (req.baseUrl || '') + req.path })) return res.status(403).json({ error: 'Dispatchers work with trucks and active drivers only' });
  if (u.role === 'member' && !recruiterMay({ path: (req.baseUrl || '') + req.path })) return res.status(403).json({ error: 'Recruiters work with leads, onboarding and trucks only' });
  req.user = u; next();
});
// Telegram groups by role: recruiters see the groups of drivers not hired yet (leads, onboarding); dispatchers the
// groups of working (hired) drivers; admins everything. statusSql is the driver's status column.
const groupScopeSql = (u, statusSql = 'd.status') => (u.role === 'member' ? ` AND ${statusSql} IS DISTINCT FROM 'Hired'` : u.role === 'dispatcher' ? ` AND ${statusSql} = 'Hired'` : '');
const groupScopeOk = (u, status) => (u.role === 'member' ? status !== 'Hired' : u.role === 'dispatcher' ? status === 'Hired' : true);
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
const seesAll = (u) => u.role === 'admin' || u.role === 'dispatcher' || db.settings.visibility !== 'own';
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
const PERIODS = { today: [0, 0], yesterday: [1, 1], '7d': [6, 0], '30d': [29, 0], month: null, lastmonth: null };
async function range(period) {
  const key = period in PERIODS ? period : 'today'; const tz = db.settings.tz;
  // first and last day (inclusive) of the period
  const r = (await q(`SELECT t.today::text today,
      (CASE $2 WHEN 'month' THEN date_trunc('month', t.today)::date WHEN 'lastmonth' THEN (date_trunc('month', t.today) - interval '1 month')::date ELSE t.today - $3::int END)::text a,
      (CASE $2 WHEN 'month' THEN t.today WHEN 'lastmonth' THEN (date_trunc('month', t.today) - interval '1 day')::date ELSE t.today - $4::int END)::text b
    FROM (SELECT (now() AT TIME ZONE $1)::date today) t`, [tz, key, (PERIODS[key] || [0, 0])[0], (PERIODS[key] || [0, 0])[1]])).rows[0];
  const ts = (await q(`SELECT ($1::date::timestamp AT TIME ZONE $3) f, (($2::date + 1)::timestamp AT TIME ZONE $3) t, ($2::date - $1::date + 1)::int n`, [r.a, r.b, tz])).rows[0];
  return { period: key, today: r.today, fromDate: r.a, toDate: r.b, from: ts.f, to: ts.t, days: ts.n, tz };
}
const today = async () => (await q(`SELECT (now() AT TIME ZONE $1)::date::text d`, [db.settings.tz])).rows[0].d;
const isDate = (v) => { const s = String(v || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; }; // Feb 30 is not a date
const niceDate = (v) => new Date(v + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const validTz = (v) => { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true; } catch (e) { return false; } };

// Phones and tablets: their time on the site is not counted (activity is the website on a computer only).
const MOBILE_UA = /Mobi|Android|iPhone|iPod|iPad|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile|Silk|Kindle/i;
const isMobile = (req) => MOBILE_UA.test(String(req.headers['user-agent'] || '')) || req.headers['sec-ch-ua-mobile'] === '?1' || !!(req.body && req.body.mobile === true);
module.exports = { groupScopeSql, groupScopeOk, isMobile, wrap, cookieOf, sessionUser, needUser, needAdmin, needKey, seesAll, visSql, canSee, loadGone, unowned, unownedSql, loadDriver, act, history, record, range, today, isDate, niceDate, validTz, PERIODS, NOTE_TEXT };
