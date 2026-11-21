// How each of our dispatchers works: the AI reads their messages in the drivers' groups (with the driver's message they
// answered) and writes a short profile: tone, clarity, how they run updates, typical messages, strengths, what to improve.
// Rebuilt once a day for dispatchers with enough new messages. Admins see it (Telegram → Knowledge → Dispatch autopilot).
const db = require('../db');
const bot = require('./bot');
const ai = require('./ai');
const { q } = db;

const MIN_MSGS = +process.env.TG_DISP_MIN_MSGS || 20;
async function build(tgId) {
  if (!ai.on()) return null;
  const p = (await q(`SELECT * FROM tg_people WHERE tg_id = $1`, [tgId])).rows[0]; if (!p) return null;
  const rows = (await q(`SELECT m.text, m.at, c.title, (SELECT b.text FROM tg_messages b JOIN tg_people bp ON bp.tg_id = b.from_id WHERE b.chat_id = m.chat_id AND bp.role = 'driver' AND b.at < m.at AND b.at > m.at - interval '12 hours' ORDER BY b.at DESC LIMIT 1) before
    FROM tg_messages m JOIN tg_chats c ON c.chat_id = m.chat_id WHERE m.from_id = $1 AND m.text IS NOT NULL AND m.at > now() - interval '30 days' ORDER BY m.at DESC LIMIT 300`, [tgId])).rows.reverse();
  if (rows.length < Math.min(5, MIN_MSGS)) return null;
  const st = (await q(`SELECT count(DISTINCT chat_id)::int groups, count(*)::int msgs FROM tg_messages WHERE from_id = $1 AND at > now() - interval '30 days'`, [tgId])).rows[0];
  const lines = rows.map((r) => `${r.before ? `  driver: ${bot.redact(r.before).slice(0, 200)}\n` : ''}[${r.title}] ${bot.redact(r.text).slice(0, 400)}`);
  const prof = await ai.dispatcherProfile({ name: p.name, stats: `${st.msgs} messages in ${st.groups} groups, last 30 days.`, lines });
  if (!prof) return null;
  await q(`UPDATE tg_people SET profile = $2, profile_at = now(), profile_msgs = $3 WHERE tg_id = $1`, [tgId, JSON.stringify(prof), st.msgs]);
  await bot.log('fact', `Dispatcher profile updated: ${p.name}`, {});
  return prof;
}
async function tick() {
  if (!bot.state.me || !ai.on()) return;
  await q(`UPDATE tg_promises SET state = 'unknown', closed_at = now() WHERE state = 'open' AND at < now() - interval '10 days'`); // nobody could tell
  const due = (await q(`SELECT p.tg_id FROM tg_people p WHERE p.role = 'dispatch' AND (SELECT count(*) FROM tg_messages m WHERE m.from_id = p.tg_id AND m.at > now() - interval '30 days') >= $1
    AND (p.profile_at IS NULL OR (p.profile_at < now() - interval '1 day' AND (SELECT count(*) FROM tg_messages m WHERE m.from_id = p.tg_id AND m.at > p.profile_at) >= 10))`, [MIN_MSGS])).rows;
  for (const d of due) await build(d.tg_id).catch((e) => console.error('tg dispatcher', e.message));
}
function start() { setInterval(() => tick().catch((e) => console.error('dispatcher tick', e.message)), +process.env.TG_PROFILE_MS || 10 * 60000); }
module.exports = { start, tick, build };
