// The day of each group in a few lines (AI), kept on the website. Written every evening at the set time,
// or on demand from the Telegram manager page. Without ANTHROPIC_API_KEY it keeps a plain count instead.
const db = require('../db');
const ai = require('./ai');
const bot = require('./bot');
const { q } = db;

async function summarizeChat(chatId, day) {
  const tz = db.settings.tz;
  const chat = (await q(`SELECT c.*, d.name driver FROM tg_chats c LEFT JOIN drivers d ON d.id = c.driver_id WHERE c.chat_id = $1`, [chatId])).rows[0]; if (!chat) return null;
  const msgs = (await q(`SELECT m.*, to_char(m.at AT TIME ZONE $3, 'HH24:MI') hm, p.role FROM tg_messages m LEFT JOIN tg_people p ON p.tg_id = m.from_id
    WHERE m.chat_id = $1 AND (m.at AT TIME ZONE $3)::date = $2::date ORDER BY m.at`, [chatId, day, tz])).rows;
  if (!msgs.length) return null;
  const lines = msgs.map((m) => `[${m.hm}] ${m.is_bot ? 'Bot' : m.from_name || 'Someone'}${m.role ? ` (${m.role})` : ''}: ${m.text || ''}${m.media ? ` [${m.media}${m.media_note ? ': ' + m.media_note : ''}]` : ''}`);
  let s;
  if (ai.on()) {
    try { s = await ai.summarize({ kind: bot.KINDS[chat.kind] || 'driver', driver: chat.driver, lines }); }
    catch (e) { console.error('tg summary', e.message); s = null; }
  }
  if (!s) {
    const people = [...new Set(msgs.filter((m) => !m.is_bot).map((m) => m.from_name))];
    s = { summary: `${msgs.length} messages${people.length ? ` from ${people.join(', ')}` : ''}.${ai.on() ? '' : ' (Add ANTHROPIC_API_KEY on Railway for AI summaries.)'}`, issues: [], mood: 'unknown' };
  }
  await q(`INSERT INTO tg_summaries (chat_id, day, summary, issues, mood, messages) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (chat_id, day) DO UPDATE SET summary = $3, issues = $4, mood = $5, messages = $6, created_at = now()`,
  [chatId, day, String(s.summary || '').slice(0, 3000), JSON.stringify((s.issues || []).slice(0, 12).map((x) => String(x).slice(0, 300))), s.mood || 'unknown', msgs.length]);
  return s;
}
async function tick() {
  const tz = db.settings.tz; const at = db.settings.tg.summaryAt;
  const now = (await q(`SELECT to_char(now() AT TIME ZONE $1, 'HH24:MI') hm, (now() AT TIME ZONE $1)::date::text d`, [tz])).rows[0];
  if (now.hm < at) return;
  const due = (await q(`SELECT c.chat_id FROM tg_chats c WHERE c.active AND c.kind IS NOT NULL
    AND EXISTS (SELECT 1 FROM tg_messages m WHERE m.chat_id = c.chat_id AND (m.at AT TIME ZONE $1)::date = $2::date)
    AND NOT EXISTS (SELECT 1 FROM tg_summaries s WHERE s.chat_id = c.chat_id AND s.day = $2::date AND s.created_at AT TIME ZONE $1 >= ($2::date + $3::time))`, [tz, now.d, at])).rows;
  for (const c of due) await summarizeChat(c.chat_id, now.d).catch((e) => console.error('tg summary', e.message));
}
function start() { setInterval(() => tick().catch((e) => console.error('summary tick', e.message)), +process.env.TG_TICK_MS || 60000); }
module.exports = { summarizeChat, tick, start };
