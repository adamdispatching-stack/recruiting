// How each of our dispatchers works: the AI reads their messages in the drivers' groups (with the driver's message they
// answered) and writes a short profile: tone, clarity, how they run updates, typical messages, strengths, what to improve.
// Rebuilt once a day for dispatchers with enough new messages. Admins see it (Telegram → Knowledge → Dispatch autopilot).
const db = require('../db');
const bot = require('./bot');
const ai = require('./ai');
const { q } = db;

const MIN_MSGS = +process.env.TG_DISP_MIN_MSGS || 20;
// his numbers, last 30 days: messages, groups, how fast he answers the drivers (first one of our side to answer), nights
async function stats(tgId, { from = null, to = null } = {}) {
  const tz = db.settings.tz;
  const a = (await q(`SELECT count(*)::int msgs, count(DISTINCT chat_id)::int groups, round(avg(length(text)))::int avg_len,
      count(*) FILTER (WHERE extract(hour FROM at AT TIME ZONE $2) >= 22 OR extract(hour FROM at AT TIME ZONE $2) < 6)::int night
    FROM tg_messages WHERE from_id = $1 AND at >= coalesce($3::timestamptz, now() - interval '30 days') AND at < coalesce($4::timestamptz, now())`, [tgId, tz, from, to])).rows[0];
  const r = (await q(`WITH g AS (SELECT DISTINCT chat_id FROM tg_messages WHERE from_id = $1 AND at >= coalesce($2::timestamptz, now() - interval '30 days') AND at < coalesce($3::timestamptz, now())),
    dm AS (SELECT m.chat_id, m.at FROM tg_messages m JOIN g ON g.chat_id = m.chat_id JOIN tg_people p ON p.tg_id = m.from_id WHERE p.role = 'driver' AND m.at >= coalesce($2::timestamptz, now() - interval '30 days') AND m.at < least(coalesce($3::timestamptz, now()), now() - interval '2 hours')
      AND NOT EXISTS (SELECT 1 FROM tg_messages b JOIN tg_people bp ON bp.tg_id = b.from_id WHERE b.chat_id = m.chat_id AND bp.role = 'driver' AND b.at < m.at AND b.at > m.at - interval '10 minutes')),
    x AS (SELECT dm.at d_at, y.from_id, extract(epoch FROM y.at - dm.at) / 60 gap FROM dm LEFT JOIN LATERAL (SELECT m2.from_id, m2.at FROM tg_messages m2 LEFT JOIN tg_people p2 ON p2.tg_id = m2.from_id
      WHERE m2.chat_id = dm.chat_id AND m2.at > dm.at AND m2.at < dm.at + interval '12 hours' AND NOT m2.is_bot AND coalesce(p2.role, '') <> 'driver' ORDER BY m2.at LIMIT 1) y ON true)
    SELECT count(*)::int driver_msgs, count(*) FILTER (WHERE from_id = $1)::int his, round((percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE from_id = $1))::numeric)::int med,
      count(*) FILTER (WHERE from_id = $1 AND gap <= 15)::int fast, count(*) FILTER (WHERE from_id IS NULL OR gap > 120)::int slow FROM x`, [tgId, from, to])).rows[0];
  return { ...a, ...r };
}
const statsText = (s) => `Last 30 days: ${s.msgs} messages in ${s.groups} driver groups, about ${s.avg_len || 0} characters each, ${s.night} sent between 10 PM and 6 AM.
Driver messages in his groups: ${s.driver_msgs}. He answered first ${s.his} of them${s.his ? `, half within ${s.med} min, ${s.fast} within 15 min` : ''}. ${s.slow} driver messages waited over 2 hours or got no answer from anyone on our side.`;

// the numbers the review cites, with where each message is (only those, so the review stays small)
function refsOf(prof, at) {
  const used = [...(prof.issues || []).map((x) => x.ref), ...(prof.scores || []).map((x) => x.ref), (prof.feedback || {}).show_example_ref, ...(prof.red_flag_refs || [])];
  const out = {}; for (const r of used) if (Number.isInteger(r) && at[r]) out[r] = at[r];
  return out;
}
async function build(tgId, { force = false } = {}) {
  if (!ai.on()) return null;
  const p = (await q(`SELECT * FROM tg_people WHERE tg_id = $1`, [tgId])).rows[0]; if (!p) return null;
  const rows = (await q(`SELECT m.text, m.at, m.chat_id::text chat_id, m.msg_id, to_char(m.at AT TIME ZONE $2, 'Dy HH24:MI') hm,
      (SELECT json_build_object('text', b.text, 'at', b.at, 'msg_id', b.msg_id) FROM tg_messages b JOIN tg_people bp ON bp.tg_id = b.from_id WHERE b.chat_id = m.chat_id AND bp.role = 'driver' AND b.at < m.at AND b.at > m.at - interval '12 hours' ORDER BY b.at DESC LIMIT 1) before
    FROM tg_messages m WHERE m.from_id = $1 AND m.text IS NOT NULL AND m.at > now() - interval '30 days' ORDER BY m.at DESC LIMIT 400`, [tgId, db.settings.tz])).rows.reverse();
  if (rows.length < (force ? 3 : Math.min(5, MIN_MSGS))) return null;
  const st = await stats(tgId);
  // groups by number, not their title (titles hold the driver's name and phone)
  // each line is numbered [#n], the AI names the numbers it talks about, and the review keeps where they are in Telegram
  const gn = {}; let n = 0; const at = {};
  const lines = rows.map((r, k) => { gn[r.chat_id] = gn[r.chat_id] || ++n; const b = r.before; at[k + 1] = { chat: r.chat_id, msg: +r.msg_id, driverMsg: b && b.msg_id ? +b.msg_id : null, at: r.at };
    const gap = b ? Math.round((new Date(r.at) - new Date(b.at)) / 60000) : null;
    return `${b ? `  driver: ${bot.redact(b.text || '').slice(0, 200)}\n` : ''}[#${k + 1} group ${gn[r.chat_id]} ${r.hm}${gap !== null ? `, ${gap} min after the driver` : ''}] ${bot.redact(r.text).slice(0, 400)}`; });
  const last = (await q(`SELECT profile, at FROM tg_disp_reviews WHERE tg_id = $1 ORDER BY at DESC LIMIT 1`, [tgId])).rows[0];
  const previous = last ? { ...last.profile, at: new Date(last.at).toISOString().slice(0, 10) } : null;
  const prof = await ai.dispatcherProfile({ name: p.name, stats: statsText(st), lines, previous });
  if (!prof) return null;
  prof.refs = refsOf(prof, at);
  await q(`UPDATE tg_people SET profile = $2, profile_at = now(), profile_msgs = $3 WHERE tg_id = $1`, [tgId, JSON.stringify(prof), st.msgs]);
  await q(`INSERT INTO tg_disp_reviews (tg_id, profile, stats) VALUES ($1, $2, $3)`, [tgId, JSON.stringify(prof), JSON.stringify(st)]);
  await bot.log('fact', `Dispatcher review updated: ${p.name}`, {});
  // serious things: the admins are told (never the dispatcher, never in a group)
  const flags = (prof.red_flags || []).filter(Boolean);
  const before = new Set(((previous || {}).red_flags || []));
  if (flags.length && flags.some((f) => !before.has(f))) for (const a of (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows)
    await db.notify(db.pool, a.id, 'tg', `Dispatcher ${p.name}: ${flags.slice(0, 2).join('; ').slice(0, 300)}`, '#/dispatcher/' + tgId);
  return prof;
}
async function tick() {
  await require('./accounts').tick().catch((e) => console.error('tg accounts', e.message));
  if (!bot.state.me || !ai.on()) return;
  await q(`UPDATE tg_promises SET state = 'unknown', closed_at = now() WHERE state = 'open' AND at < now() - interval '10 days'`); // nobody could tell
  const due = (await q(`SELECT p.tg_id FROM tg_people p WHERE (p.role = 'dispatch' OR EXISTS (SELECT 1 FROM users du WHERE du.id = p.user_id AND du.role = 'dispatcher')) AND (SELECT count(*) FROM tg_messages m WHERE m.from_id = p.tg_id AND m.at > now() - interval '30 days') >= $1
    AND (p.profile_at IS NULL OR (p.profile_at < now() - interval '3 days' AND (SELECT count(*) FROM tg_messages m WHERE m.from_id = p.tg_id AND m.at > p.profile_at) >= 10))`, [MIN_MSGS])).rows;
  for (const d of due) await build(d.tg_id).catch((e) => console.error('tg dispatcher', e.message));
}
function start() { setInterval(() => tick().catch((e) => console.error('dispatcher tick', e.message)), +process.env.TG_PROFILE_MS || 10 * 60000); }
module.exports = { start, tick, build, stats, statsText, refsOf };
