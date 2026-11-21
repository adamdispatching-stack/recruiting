// The driver's profile for dispatchers: rebuilt by the AI from the notes the bot keeps (and the team's own
// pinned lines, which always win), once a day or when enough new notes come in. Never shown in the driver's groups.
const db = require('../db');
const bot = require('./bot');
const ai = require('./ai');
const { q } = db;
const { esc } = bot;

const EVERY_NOTES = 8;
async function build(driverId) {
  if (!ai.on()) return null;
  const d = (await q(`SELECT d.*, co.name company, t.unit, t.details FROM drivers d LEFT JOIN companies co ON co.id = d.company_id LEFT JOIN trucks t ON t.driver_id = d.id WHERE d.id = $1`, [driverId])).rows[0]; if (!d) return null;
  const p = (await q(`SELECT * FROM driver_profiles WHERE driver_id = $1`, [driverId])).rows[0];
  const notes = (await q(`SELECT kind, text, to_char(at, 'YYYY-MM-DD') AS day FROM driver_notes WHERE driver_id = $1 ORDER BY at DESC LIMIT 300`, [driverId])).rows.reverse();
  const sums = (await q(`SELECT s.day::text, s.summary FROM tg_summaries s JOIN tg_chats c ON c.chat_id = s.chat_id WHERE c.driver_id = $1 ORDER BY s.day DESC LIMIT 10`, [driverId])).rows.reverse();
  const basics = `${d.name}, ${d.mode === 'Owner-operators' ? 'owner-operator' : 'company driver'}${d.company ? `, ${d.company}` : ''}${d.unit ? `, truck ${d.unit} ${d.details || ''}` : ''}${d.weeks_out ? `, works ${d.weeks_out} weeks out` : ''}${d.days_home ? ` and ${d.days_home} days home` : ''}`;
  const pr = (await q(`SELECT count(*) FILTER (WHERE state = 'kept')::int kept, count(*) FILTER (WHERE state = 'broken')::int broken FROM tg_promises WHERE driver_id = $1 AND at > now() - interval '60 days'`, [driverId])).rows[0];
  const word = pr.kept + pr.broken >= 3 ? ` Keeps his word: ${pr.kept} of ${pr.kept + pr.broken} times he said he would do something by a time (last 60 days).` : '';
  const prof = await ai.profile({ driver: basics + word, previous: p ? p.profile : null, pins: p ? p.pins : null, notes: notes.map((n) => `${n.day} [${n.kind}] ${n.text}`), summaries: sums.map((s) => `${s.day}: ${s.summary}`) });
  const count = +(await q(`SELECT count(*)::int n FROM driver_notes WHERE driver_id = $1`, [driverId])).rows[0].n;
  await q(`INSERT INTO driver_profiles (driver_id, profile, notes_used, built_at) VALUES ($1, $2, $3, now()) ON CONFLICT (driver_id) DO UPDATE SET profile = $2, notes_used = $3, built_at = now()`, [driverId, JSON.stringify(prof), count]);
  return prof;
}
const LABEL = { high: 'high', medium: 'medium', low: 'low', unknown: 'not known yet', self_driven: 'self-driven', light_check_ins: 'light check-ins', needs_close_follow_up: 'needs close follow-up' };
// As text, for a new dispatcher (Telegram private chat, or copied from the website)
async function profileText(driverId, html = true) {
  const r = (await q(`SELECT p.*, d.name FROM drivers d LEFT JOIN driver_profiles p ON p.driver_id = d.id WHERE d.id = $1`, [driverId])).rows[0];
  if (!r || (!r.profile && !r.pins)) return null;
  const b = (s) => (html ? `<b>${esc(s)}</b>` : s); const e = (s) => (html ? esc(s) : s);
  const p = r.profile || {}; const list = (t, a) => (a && a.length ? `\n${b(t)}\n${a.map((x) => '• ' + e(x)).join('\n')}` : '');
  return `${html ? '🚚 ' : ''}${b(r.name)}${p.summary ? `\n${e(p.summary)}` : ''}${p.reliability ? `\n${b('Reliability:')} ${LABEL[p.reliability]} · ${b('Supervision:')} ${LABEL[p.supervision]}` : ''}${p.work_style ? `\n${b('Work style:')} ${e(p.work_style)}` : ''}`
    + list('Routines', p.routines) + list('Requests', p.requests) + list('Likes', p.likes_loads) + list('Does not like', p.dislikes_loads)
    + (p.home_time ? `\n${b('Home time:')} ${e(p.home_time)}` : '') + (p.communication ? `\n${b('Talking to him:')} ${e(p.communication)}` : '')
    + list('Tips for dispatchers', p.tips_for_dispatchers) + list('Watch out for', p.watch_outs) + (r.pins ? `\n${b('From the team')}\n${e(r.pins)}` : '');
}
async function tick() {
  if (!bot.state.me || !ai.on()) return;
  const due = (await q(`SELECT n.driver_id FROM driver_notes n LEFT JOIN driver_profiles p ON p.driver_id = n.driver_id GROUP BY n.driver_id, p.notes_used, p.built_at
    HAVING count(*) - coalesce(p.notes_used, 0) >= $1 OR (count(*) > coalesce(p.notes_used, 0) AND (p.built_at IS NULL OR p.built_at < now() - interval '1 day'))`, [EVERY_NOTES])).rows;
  for (const d of due) await build(d.driver_id).catch((e) => console.error('tg profile', e.message));
}
function start() { setInterval(() => tick().catch((e) => console.error('profile tick', e.message)), +process.env.TG_PROFILE_MS || 10 * 60000); }
bot.handlers.profileText = (id) => profileText(id, true);
module.exports = { start, tick, build, profileText };
