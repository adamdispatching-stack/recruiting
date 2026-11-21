// Call-backs: a driver asks to be called at a certain time ("call me around 3 pm", "after 4 hours").
// The AI in the Chrome extension finds it in the chat; a recruiter can also set or change it on the lead.
// The lead gets that time, its follow-up day, and the recruiter is reminded 10 minutes before. If no call is
// logged 15 minutes after the time, the recruiter is told; an hour after, the admins too.
const db = require('./db');
const { q } = db;

const fmt = (at, tz = db.settings.tz, withDay = true) => {
  const d = new Date(at); const zone = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName').value;
  const day = d.toLocaleDateString('en-CA', { timeZone: tz }) === new Date().toLocaleDateString('en-CA', { timeZone: tz }) ? 'today' : d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  return `${d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })} ${zone}${withDay ? ' ' + day : ''}`;
};
// "3:00 PM EST today (2:00 PM CST his time)"
const when = (at, tz) => fmt(at) + (tz && tz !== db.settings.tz && fmt(at, tz, false) !== fmt(at, db.settings.tz, false) ? ` (${fmt(at, tz, false)} his time)` : '');
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; } };
const event = (c, id, text, who) => c.query(`INSERT INTO driver_events (driver_id, type, text, who, fp) VALUES ($1, 'web', $2, $3, $4)`, [id, text, who, require('crypto').randomBytes(12).toString('hex')]);
async function tell(c, userIds, kind, text, driverId) {
  for (const id of [...new Set(userIds.filter(Boolean))]) {
    await db.notify(c, id, kind, text, `#/driver/${driverId}`, { driverId });
    // also in Telegram, to team members who connected their Telegram with /me
    try {
      const bot = require('./tg/bot');
      if (bot.on() && bot.state.me) { const p = (await c.query(`SELECT tg_id FROM tg_people WHERE user_id = $1 ORDER BY seen_at DESC LIMIT 1`, [id])).rows[0]; if (p) await bot.send(p.tg_id, '📞 ' + bot.esc(text)); }
    } catch (e) { /* Telegram is a bonus */ }
  }
}

// Set the call-back time. by: 'AI' (from the extension) or a person's name.
async function set(c, d, { at, said = null, tz = null, by }) {
  const t = new Date(at); if (isNaN(t)) return false;
  tz = tz && validTz(tz) ? tz : null;
  const day = t.toLocaleDateString('en-CA', { timeZone: db.settings.tz });
  await c.query(`UPDATE drivers SET callback_at = $2, callback_said = $3, callback_tz = $4, callback_by = $5, callback_key = $6, callback_state = 'due', callback_reminded = 0,
    follow_up = $7::date, updated_at = now(), web_updated_at = now() WHERE id = $1`,
    [d.id, t.toISOString(), said ? String(said).slice(0, 200) : null, tz, by, t.toISOString(), day]);
  await event(c, d.id, `Call back at ${when(t, tz)}${said ? `: "${String(said).slice(0, 160)}"` : ''}${by === 'AI' ? ' (the AI found it in the chat)' : ''}`, by === 'AI' ? 'AI' : by);
  if (by === 'AI') await tell(c, [d.owner_id], 'callback', `${d.name} asked for a call at ${when(t, tz)}${said ? `: "${String(said).slice(0, 120)}"` : ''}`, d.id);
  return true;
}
// From the Chrome extension: a new request the AI found (the same one again is ignored, and one already past by 2 hours)
async function fromExtension(c, d, rec) {
  if (!rec.callbackAt) return;
  const t = new Date(rec.callbackAt); if (isNaN(t)) return;
  if (t.toISOString() === d.callback_key) return;
  if (t < Date.now() - 2 * 3600000 || t > Date.now() + 21 * 86400000) return;
  const cur = (await c.query(`SELECT * FROM drivers WHERE id = $1`, [d.id])).rows[0];
  await set(c, cur, { at: t, said: rec.callbackSaid, tz: rec.callbackTz, by: 'AI' });
}
async function done(c, id, who, why = 'called') {
  const r = await c.query(`UPDATE drivers SET callback_state = 'done' WHERE id = $1 AND callback_state = 'due' RETURNING callback_at`, [id]);
  if (r.rows[0] && why !== 'called') await event(c, id, `Call-back ${why}`, who);
  return !!r.rows[0];
}
// A call logged on the lead from an hour before the time on counts as the call-back
async function onCall(c, id, who) {
  const r = await c.query(`SELECT 1 FROM drivers WHERE id = $1 AND callback_state = 'due' AND callback_at <= now() + interval '60 minutes'`, [id]);
  if (r.rows[0]) await done(c, id, who);
}

async function tick() {
  const admins = (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id);
  // 10 minutes before
  for (const d of (await q(`SELECT * FROM drivers WHERE callback_state = 'due' AND callback_reminded < 1 AND callback_at <= now() + interval '10 minutes' AND callback_at > now() - interval '15 minutes'`)).rows) {
    await q(`UPDATE drivers SET callback_reminded = 1 WHERE id = $1`, [d.id]);
    await tell(db.pool, d.owner_id ? [d.owner_id] : admins, 'callback', `Call ${d.name} at ${when(d.callback_at, d.callback_tz)}: he asked for it${d.callback_said ? ` ("${d.callback_said.slice(0, 100)}")` : ''}`, d.id);
  }
  // 15 minutes late, no call logged: the recruiter
  for (const d of (await q(`SELECT * FROM drivers WHERE callback_state = 'due' AND callback_reminded < 2 AND callback_at <= now() - interval '15 minutes'`)).rows) {
    await q(`UPDATE drivers SET callback_reminded = 2 WHERE id = $1`, [d.id]);
    await tell(db.pool, d.owner_id ? [d.owner_id] : admins, 'callback', `Not called yet: ${d.name} asked for a call at ${when(d.callback_at, d.callback_tz)}. Call him and log the call.`, d.id);
  }
  // an hour late: the admins too
  for (const d of (await q(`SELECT d.*, u.name owner FROM drivers d LEFT JOIN users u ON u.id = d.owner_id WHERE d.callback_state = 'due' AND d.callback_reminded < 3 AND d.callback_at <= now() - interval '60 minutes'`)).rows) {
    await q(`UPDATE drivers SET callback_reminded = 3 WHERE id = $1`, [d.id]);
    await tell(db.pool, admins.filter((a) => a !== d.owner_id), 'callback', `${d.name} asked for a call at ${when(d.callback_at, d.callback_tz)} and nobody has called yet${d.owner ? ` (${d.owner}'s lead)` : ''}`, d.id);
  }
  // a day later still open: it is missed
  await q(`UPDATE drivers SET callback_state = 'missed' WHERE callback_state = 'due' AND callback_at < now() - interval '1 day'`);
}
function start() {
  const run = () => tick().catch((e) => console.error('callback tick', e.message));
  setTimeout(run, 15000); setInterval(run, +process.env.CALLBACK_TICK_MS || 60000);
}
module.exports = { set, fromExtension, done, onCall, tick, start, when };
