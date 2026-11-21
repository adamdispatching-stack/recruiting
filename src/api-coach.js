// Habits that keep recruiters effective:
//  - a plan for the day, written in the morning: a goal and the calls to make, with times
//  - coaching: one concrete tip from a manager about a lead or a call, acknowledged by the recruiter
//  - calls started from the website must get their outcome logged (with a note when they talked)
const db = require('./db');
const lib = require('./lib');
const { q } = db;
const { wrap, needUser, needAdmin, act, loadDriver } = lib;

const today = () => lib.today();
const TALK_MIN = 20; // characters a "talked" call note needs at least

// ---------- the plan ----------
// an item is done when the person logged a contact with that lead today (call, text, email or a note)
async function planOf(userId, day) {
  const p = (await q(`SELECT * FROM day_plans WHERE user_id = $1 AND day = $2::date`, [userId, day])).rows[0];
  if (!p) return null;
  const ids = (p.items || []).map((i) => i.driverId);
  const names = ids.length ? Object.fromEntries((await q(`SELECT id, name, phones FROM drivers WHERE id = ANY($1::int[])`, [ids])).rows.map((d) => [d.id, d])) : {};
  const done = ids.length ? new Set((await q(`SELECT DISTINCT driver_id FROM activity WHERE user_id = $1 AND driver_id = ANY($2::int[]) AND type IN ('contact', 'note')
    AND (at AT TIME ZONE $4)::date = $3::date`, [userId, ids, day, db.settings.tz])).rows.map((r) => r.driver_id)) : new Set();
  const items = (p.items || []).filter((i) => names[i.driverId]).map((i) => ({ driverId: i.driverId, name: names[i.driverId].name, phones: names[i.driverId].phones, time: i.time || null, done: done.has(i.driverId) }));
  return { day, goal: p.goal, items, done: items.filter((i) => i.done).length, createdAt: p.created_at };
}
async function suggestions(userId, day) {
  return (await q(`SELECT id, name, status, follow_up::text follow_up, callback_at, callback_state FROM drivers d WHERE d.owner_id = $1 AND (
      (d.callback_state = 'due' AND (d.callback_at AT TIME ZONE $3)::date <= $2::date) OR (d.follow_up IS NOT NULL AND d.follow_up <= $2::date) OR d.status = ANY($4::text[]))
    ORDER BY (d.callback_state = 'due') DESC, d.callback_at, d.follow_up NULLS LAST, d.updated_at DESC LIMIT 30`, [userId, day, db.settings.tz, db.ACTIVE])).rows
    .map((d) => ({ id: d.id, name: d.name, status: d.status, followUp: d.follow_up, callback: d.callback_state === 'due' ? d.callback_at : null }));
}

module.exports = (app) => {
  app.get('/api/plan', needUser, wrap(async (req, res) => {
    const uid = req.user.role === 'admin' && +req.query.user ? +req.query.user : req.user.id; const day = await today();
    res.json({ day, plan: await planOf(uid, day), suggestions: uid === req.user.id ? await suggestions(uid, day) : [], needed: req.user.role === 'member' });
  }));
  app.post('/api/plan', needUser, wrap(async (req, res) => {
    const b = req.body || {}; const goal = String(b.goal || '').trim();
    if (goal.length < 10) return res.status(400).json({ error: 'Write your goal for today in a sentence, like "Get 2 drivers to the Relay invite"' });
    const ids = new Set((await q(`SELECT id FROM drivers WHERE owner_id = $1`, [req.user.id])).rows.map((r) => r.id));
    const items = (Array.isArray(b.items) ? b.items : []).filter((i) => i && ids.has(+i.driverId)).slice(0, 40)
      .map((i) => ({ driverId: +i.driverId, time: /^\d{2}:\d{2}$/.test(i.time || '') ? i.time : null }));
    const day = await today();
    await q(`INSERT INTO day_plans (user_id, day, goal, items) VALUES ($1, $2::date, $3, $4) ON CONFLICT (user_id, day) DO UPDATE SET goal = $3, items = $4`, [req.user.id, day, goal.slice(0, 300), JSON.stringify(items)]);
    await act(req.user, 'plan', null, `Plan for today: ${goal.slice(0, 120)}${items.length ? ` (${items.length} call${items.length > 1 ? 's' : ''})` : ''}`);
    res.json({ plan: await planOf(req.user.id, day) });
  }));

  // ---------- coaching ----------
  const tipOut = (t) => ({ id: t.id, userId: t.user_id, user: t.user_name, by: t.by_name, driverId: t.driver_id, driver: t.driver_name, tip: t.tip, at: t.at, seenAt: t.seen_at, reply: t.reply });
  const TIPS = `SELECT c.*, u.name user_name, b.name by_name, d.name driver_name FROM coaching c JOIN users u ON u.id = c.user_id LEFT JOIN users b ON b.id = c.by_id LEFT JOIN drivers d ON d.id = c.driver_id`;
  app.get('/api/coaching', needUser, wrap(async (req, res) => {
    const uid = req.user.role === 'admin' ? (+req.query.user || null) : req.user.id;
    const lead = +req.query.driver || null;
    const r = await q(`${TIPS} WHERE ($1::int IS NULL OR c.user_id = $1) AND ($2::int IS NULL OR c.driver_id = $2) ORDER BY c.at DESC LIMIT 60`, [uid, lead]);
    res.json({ tips: r.rows.map(tipOut) });
  }));
  app.post('/api/coaching', needUser, needAdmin, wrap(async (req, res) => {
    const b = req.body || {}; const tip = String(b.tip || '').trim();
    const u = (await q(`SELECT id, name FROM users WHERE id = $1 AND active`, [+b.userId || 0])).rows[0];
    if (!u) return res.status(400).json({ error: 'Pick the recruiter' });
    if (tip.length < 10) return res.status(400).json({ error: 'Write one concrete tip, like "Ask about home time before pay"' });
    const r = await q(`INSERT INTO coaching (user_id, by_id, driver_id, tip) VALUES ($1, $2, $3, $4) RETURNING id`, [u.id, req.user.id, +b.driverId || null, tip.slice(0, 1000)]);
    const d = b.driverId ? (await q(`SELECT name FROM drivers WHERE id = $1`, [+b.driverId])).rows[0] : null;
    await db.notify(db.pool, u.id, 'coaching', `Tip from ${req.user.name}${d ? ` (on ${d.name})` : ''}: ${tip.slice(0, 160)}`, '#/');
    await act(req.user, 'coach', b.driverId ? { id: +b.driverId, name: d && d.name } : null, `Coached ${u.name}: ${tip.slice(0, 120)}`);
    res.json({ id: r.rows[0].id });
  }));
  app.patch('/api/coaching/:id', needUser, wrap(async (req, res) => {
    const t = (await q(`${TIPS} WHERE c.id = $1`, [+req.params.id || 0])).rows[0];
    if (!t || t.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
    const reply = String((req.body || {}).reply || '').trim().slice(0, 500) || null;
    await q(`UPDATE coaching SET seen_at = COALESCE(seen_at, now()), reply = COALESCE($2, reply) WHERE id = $1`, [t.id, reply]);
    if (t.by_id) await db.notify(db.pool, t.by_id, 'coaching', `${req.user.name} got your tip${reply ? `: ${reply.slice(0, 140)}` : ''}`, `#/team/${req.user.id}`);
    res.json({ ok: true });
  }));
  // a lead to review: one of theirs they worked in the last week (a chat or a call), not reviewed recently
  app.get('/api/coaching/pick', needUser, needAdmin, wrap(async (req, res) => {
    const r = (await q(`SELECT d.id, d.name FROM drivers d WHERE d.owner_id = $1 AND EXISTS (SELECT 1 FROM activity a WHERE a.user_id = $1 AND a.driver_id = d.id AND a.type IN ('contact', 'note') AND a.at > now() - interval '7 days')
      AND NOT EXISTS (SELECT 1 FROM coaching c WHERE c.driver_id = d.id AND c.at > now() - interval '30 days') ORDER BY random() LIMIT 1`, [+req.query.user || 0])).rows[0];
    res.json({ lead: r || null });
  }));

  // ---------- calls started from the website ----------
  app.post('/api/drivers/:id/call-start', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    // a second tap within 2 minutes is the same call
    const open = (await q(`SELECT id FROM call_starts WHERE user_id = $1 AND driver_id = $2 AND logged_at IS NULL AND at > now() - interval '2 minutes'`, [req.user.id, d.id])).rows[0];
    if (!open) await q(`INSERT INTO call_starts (user_id, driver_id) VALUES ($1, $2)`, [req.user.id, d.id]);
    res.json({ ok: true });
  }));
  app.get('/api/calls/unlogged', needUser, wrap(async (req, res) => {
    const r = await q(`SELECT DISTINCT ON (c.driver_id) c.id, c.driver_id, c.at, d.name, d.phones FROM call_starts c JOIN drivers d ON d.id = c.driver_id
      WHERE c.user_id = $1 AND c.logged_at IS NULL AND c.at > now() - interval '3 days' ORDER BY c.driver_id, c.at DESC`, [req.user.id]);
    res.json({ calls: r.rows.sort((a, b) => b.at - a.at).map((c) => ({ id: c.id, driverId: c.driver_id, name: c.name, phones: c.phones, at: c.at })) });
  }));
  app.post('/api/calls/:id/skip', needUser, wrap(async (req, res) => {
    await q(`UPDATE call_starts SET logged_at = now() WHERE id = $1 AND user_id = $2`, [+req.params.id || 0, req.user.id]);
    res.json({ ok: true });
  }));
};

// A call logged (or a note written) on a lead closes the calls started on it
async function callLogged(userId, driverId) {
  await q(`UPDATE call_starts SET logged_at = now() WHERE user_id = $1 AND driver_id = $2 AND logged_at IS NULL`, [userId, driverId]);
}

// Every minute: the planned call times, calls left without an outcome, and once a week who needs coaching
async function tick() {
  const tz = db.settings.tz; const day = await today();
  const now = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  for (const p of (await q(`SELECT * FROM day_plans WHERE day = $1::date`, [day])).rows) {
    let changed = false; const items = p.items || [];
    for (const i of items) {
      if (!i.time || i.reminded || i.time > now) continue;
      i.reminded = true; changed = true;
      const done = (await q(`SELECT 1 FROM activity WHERE user_id = $1 AND driver_id = $2 AND type IN ('contact', 'note') AND (at AT TIME ZONE $4)::date = $3::date LIMIT 1`, [p.user_id, i.driverId, day, tz])).rows[0];
      if (done) continue;
      const d = (await q(`SELECT name FROM drivers WHERE id = $1`, [i.driverId])).rows[0]; if (!d) continue;
      await db.notify(db.pool, p.user_id, 'plan', `Your plan: call ${d.name} at ${i.time}`, `#/driver/${i.driverId}`, { driverId: i.driverId });
    }
    if (changed) await q(`UPDATE day_plans SET items = $3 WHERE user_id = $1 AND day = $2`, [p.user_id, p.day, JSON.stringify(items)]);
  }
  for (const c of (await q(`UPDATE call_starts c SET nudged_at = now() FROM drivers d WHERE d.id = c.driver_id AND c.logged_at IS NULL AND c.nudged_at IS NULL AND c.at < now() - interval '20 minutes' AND c.at > now() - interval '1 day' RETURNING c.user_id, c.driver_id, d.name`)).rows) {
    await db.notify(db.pool, c.user_id, 'call_log', `You called ${c.name}: log how the call went`, `#/driver/${c.driver_id}`, { driverId: c.driver_id });
  }
  // Monday from 9 AM: tell the admins who has had no coaching tip for 7 days
  const wd = new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
  const week = (await q(`SELECT to_char(now() AT TIME ZONE $1, 'IYYY-IW') w`, [tz])).rows[0].w;
  if (wd === 'Mon' && now >= '09:00' && (db.settings.coachNudge || '') !== week) {
    await db.saveSetting('coachNudge', week);
    const due = (await q(`SELECT u.id, u.name, (SELECT max(at) FROM coaching c WHERE c.user_id = u.id) last FROM users u WHERE u.active AND u.role = 'member'`)).rows.filter((u) => !u.last || u.last < new Date(Date.now() - 7 * 86400000));
    if (due.length) for (const a of (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows) {
      await db.notify(db.pool, a.id, 'coaching', `Coach this week: ${due.map((u) => `${u.name} (${u.last ? 'last tip ' + Math.floor((Date.now() - new Date(u.last)) / 86400000) + ' days ago' : 'no tip yet'})`).join(', ')}. Open a recent chat or call of theirs and give one tip.`, '#/team');
    }
  }
}
function start() {
  const run = () => tick().catch((e) => console.error('coach tick', e.message));
  setTimeout(run, 20000); setInterval(run, +process.env.COACH_TICK_MS || 60000);
}
module.exports.callLogged = callLogged;
module.exports.start = start;
module.exports.tick = tick;
module.exports.planOf = planOf;
module.exports.TALK_MIN = TALK_MIN;
