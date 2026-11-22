// Safety net for the server.
// - Crashes: an error nobody caught is saved, the admins are told (on the website and in Telegram, at most once per
//   10 minutes for the same error); after an uncaught exception the server restarts (Railway starts it again).
// - One runner: the bot and every background job run in ONE copy of the server only. The copy that holds the
//   database lock runs them; a second copy (a deploy overlapping, or two replicas) serves the website and waits.
// - Shutdown: on a deploy the server finishes what it is doing, lets the lock go, and exits.
const db = require('./db');
const { q } = db;

const told = new Map();
async function alertAdmins(what, text) {
  const key = String(text).slice(0, 120); const now = Date.now();
  if (now - (told.get(key) || 0) < 10 * 60000) return; told.set(key, now);
  if (told.size > 200) told.clear();
  const msg = `${what}: ${String(text).slice(0, 300)}`;
  try {
    const admins = (await q(`SELECT u.id, (SELECT tg_id FROM tg_people p WHERE p.user_id = u.id ORDER BY seen_at DESC NULLS LAST LIMIT 1) tg_id FROM users u WHERE u.active AND u.role = 'admin'`)).rows;
    for (const a of admins) {
      await db.notify(db.pool, a.id, 'admin', msg, '#/settings').catch(() => {});
      const bot = require('./tg/bot');
      if (a.tg_id && bot.on()) await bot.send(a.tg_id, `⚠️ <b>FleetHire</b>\n${bot.esc(msg)}`).catch(() => {});
    }
  } catch (e) { console.error('alert admins', e.message); }
}
async function record(kind, err, where = null) {
  const text = (err && (err.stack || err.message)) || String(err);
  console.error(`[${kind}]`, where || '', text);
  try {
    await q(`INSERT INTO server_errors (kind, place, message, stack) VALUES ($1, $2, $3, $4)`, [kind, where, String((err && err.message) || err).slice(0, 500), String(text).slice(0, 4000)]);
    await q(`DELETE FROM server_errors WHERE id < (SELECT min(id) FROM (SELECT id FROM server_errors ORDER BY id DESC LIMIT 500) k)`);
  } catch (e) { /* the database itself may be the problem */ }
}

// ---------- one runner ----------
const LOCK = 7146001; // any fixed number: the name of the lock
let lockClient = null, leader = false, waitTimer = null;
async function tryLead() {
  if (leader) return true;
  let c;
  try {
    c = await db.pool.connect();
    const got = (await c.query(`SELECT pg_try_advisory_lock($1) ok`, [LOCK])).rows[0].ok;
    if (!got) { c.release(); return false; }
    lockClient = c; leader = true;
    // the connection holding the lock died (database restart): stop, so a fresh copy takes over cleanly
    c.on('error', (e) => { record('lock-lost', e).finally(() => process.exit(1)); });
    return true;
  } catch (e) { if (c) c.release(true); console.error('leader lock', e.message); return false; }
}
// run startJobs in this copy if it gets the lock; else keep trying (the other copy may stop)
async function lead(startJobs) {
  if (process.env.NO_JOBS === '1') { console.log('Background jobs are off in this copy (NO_JOBS=1)'); return false; }
  if (await tryLead()) { await startJobs(); return true; }
  console.log('Another copy of the server runs the bot and the background jobs; this one serves the website and waits');
  waitTimer = setInterval(async () => { if (await tryLead()) { clearInterval(waitTimer); console.log('This copy now runs the bot and the background jobs'); try { await startJobs(); } catch (e) { record('jobs-start', e); } } }, +process.env.LEAD_RETRY_MS || 15000);
  return false;
}

// ---------- crashes and shutdown ----------
let server = null, closing = false;
async function shutdown(why, code = 0) {
  if (closing) return; closing = true;
  console.log('Stopping:', why);
  const done = () => process.exit(code);
  setTimeout(done, 8000).unref(); // never hang
  try { if (waitTimer) clearInterval(waitTimer); if (server) await new Promise((r) => server.close(r)); } catch (e) { /* closing anyway */ }
  try { if (lockClient) { await lockClient.query(`SELECT pg_advisory_unlock($1)`, [LOCK]).catch(() => {}); lockClient.release(); } await db.pool.end(); } catch (e) { /* closing anyway */ }
  done();
}
function install() {
  process.on('unhandledRejection', (e) => { record('unhandled', e).then(() => alertAdmins('A background error on the server (it keeps running)', (e && e.message) || e)); });
  process.on('uncaughtException', (e) => { record('crash', e).then(() => alertAdmins('The server crashed and is restarting', (e && e.message) || e)).finally(() => shutdown('crash', 1)); });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
// a request that failed with a server error: saved; the admins are told when several happen in a short time
const recent = [];
function requestError(err, req) {
  record('request', err, `${req.method} ${req.path}`);
  const now = Date.now(); recent.push(now); while (recent.length && now - recent[0] > 5 * 60000) recent.shift();
  if (recent.length >= 5) alertAdmins(`${recent.length} pages failed in 5 minutes on the website, the last one`, `${req.method} ${req.path}: ${err.message}`);
}
module.exports = { install, lead, shutdown, requestError, record, alertAdmins, isLeader: () => leader, setServer: (s) => { server = s; } };
