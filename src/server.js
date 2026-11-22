// Recruiting pipeline server: the website, sign-in, and the API the Chrome extension syncs with.
const path = require('path');
const express = require('express');
const db = require('./db');
const lib = require('./lib');
const { q, sha, token, hashPassword, checkPassword } = db;
const { wrap, cookieOf, needUser, act } = lib;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api/ext', (req, res, next) => { // the extension calls from chrome-extension:// pages
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const DAYS30 = 30 * 864e5;
const uaOf = (req) => String(req.headers['user-agent'] || '').slice(0, 300);

// ---------- sign-in ----------
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
  await q(`INSERT INTO logins (user_id, kind, ip, ua) VALUES ($1, 'in', $2, $3)`, [u.id, ip, uaOf(req)]);
  await act(u, 'login', null, 'Signed in');
  res.set('Set-Cookie', `sid=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS30 / 1000}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}));
app.post('/api/logout', wrap(async (req, res) => {
  const t = cookieOf(req, 'sid');
  if (t) {
    const u = await lib.sessionUser(req);
    if (u) { await q(`INSERT INTO logins (user_id, kind, ip, ua) VALUES ($1, 'out', $2, $3)`, [u.id, req.ip, uaOf(req)]); await act(u, 'logout', null, 'Signed out'); }
    await q(`DELETE FROM sessions WHERE token_hash = $1`, [sha(t)]);
  }
  res.set('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); res.json({ ok: true });
}));
// Who I am, plus what every screen needs: the team's time zone, lead sources, and the people leads can belong to.
// a dispatcher's own coaching: how the AI sees the way he writes to drivers (from the driver groups). Only his own.
app.get('/api/me/coaching', needUser, wrap(async (req, res) => {
  const p = (await db.q(`SELECT profile, profile_at FROM tg_people WHERE user_id = $1 AND profile IS NOT NULL ORDER BY profile_at DESC NULLS LAST LIMIT 1`, [req.user.id])).rows[0];
  if (!p) return res.json({ coaching: null });
  const x = p.profile || {};
  res.json({ coaching: { summary: x.summary || '', strengths: x.strengths || [], improve: x.improve || [], updates: x.update_habits || '', goal: (x.feedback || {}).goal || '', at: p.profile_at } });
}));
app.get('/api/me', needUser, wrap(async (req, res) => {
  const people = await q(`SELECT id, name, role, active FROM users ORDER BY lower(name)`);
  const companies = await q(`SELECT id, name, color FROM companies ORDER BY lower(name)`);
  res.json({ id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role, tz: db.settings.tz, visibility: db.settings.visibility, sources: db.settings.sources,
    fbTargets: db.settings.fbTargets, noAnswerOn: !!(db.settings.noAnswer || {}).on, amazon: db.AMAZON, lostReasons: require('./api-drivers').LOST_REASONS, needReason: [...db.LOST.filter((x) => x !== 'Declined on Indeed'), 'Stalled'],
    idleMinutes: db.settings.hours.idleMinutes, callPoints: db.settings.callPoints, ai: !!process.env.ANTHROPIC_API_KEY, share: !!(db.settings.share && db.settings.share.on),
    people: people.rows, companies: companies.rows, route: db.ROUTE, other: db.OTHER, active: db.ACTIVE, lost: db.LOST, coldDays: db.COLD_DAYS, today: await lib.today() });
}));
app.post('/api/me/password', needUser, wrap(async (req, res) => {
  const { current, next: nw } = req.body || {};
  if (!checkPassword(current, req.user.pass_hash)) return res.status(400).json({ error: 'Your current password is wrong' });
  if (String(nw || '').length < 10) return res.status(400).json({ error: 'Use at least 10 characters' });
  await q(`UPDATE users SET pass_hash = $2 WHERE id = $1`, [req.user.id, hashPassword(nw)]);
  res.json({ ok: true });
}));

require('./api-team')(app);
require('./api-hours')(app);
require('./api-companies')(app);
require('./api-active')(app);
require('./api-call')(app);
require('./api-fb')(app);
require('./challenge')(app);
require('./indeed-outbox')(app);
require('./badges')(app);
require('./api-tg')(app);
require('./api-drivers')(app);
require('./api-ops')(app);
require('./api-fleet')(app);
require('./api-docs')(app);
require('./api-ai')(app);
require('./api-coach')(app);
require('./api-admin')(app);

// ---------- website ----------
app.get('/healthz', (req, res) => res.send('ok'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', setHeaders: (res, file) => res.set('Cache-Control', /\.(woff2|webp|jpg)$/.test(file) ? 'public, max-age=604800' : 'no-cache') }));
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
  await lib.loadGone();
  // the Telegram bot (only with TELEGRAM_BOT_TOKEN), its ELD reminders and checks, and the evening summaries
  require('./fleet').start();
  require('./share').start();
  require('./callback').start();
  require('./api-coach').start();
  if (require('./tg/bot').on()) { require('./tg/bot').start(); require('./tg/eld').start(); require('./tg/onboard').start(); require('./tg/acct'); require('./tg/summary').start(); require('./tg/digest').start(); require('./tg/profile').start(); require('./tg/dispatchers').start(); require('./tg/team').start(); }
  require('./needed').start(); // verified drivers missing the arrival date, company or truck
  await q(`DELETE FROM sessions WHERE expires_at < now()`);
  await q(`DELETE FROM activity WHERE at < now() - interval '400 days'`); // the activity log keeps about 13 months
  await q(`DELETE FROM activity_hours WHERE hour < now() - interval '400 days'`);
  await q(`DELETE FROM logins WHERE at < now() - interval '400 days'`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Recruiting pipeline on port ${port}`));
  require('./idle').start(); // idle time and idle alerts, checked every minute
})().catch((e) => { console.error(e); process.exit(1); });
