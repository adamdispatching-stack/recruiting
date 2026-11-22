// How likely a driver in onboarding is to make it: a score from 0 to 100 built from how he responds.
//   silence: days since the driver last wrote in his group (and how many of our messages since went unanswered)
//   reply speed: how fast he usually answers us in the group (last 14 days)
//   calls: calls logged in the last 7 days that he answered / did not answer
//   progress: Amazon verified or stuck on one step, a start date set, the AI's mood and issues from the group
// 70+ likely 🟢, 40-69 unsure 🟡, below 40 at risk 🔴. Each score comes with its reasons, so the team sees why.
const db = require('./db');
const { q } = db;

const DAY = 864e5;
const LEVEL = (s) => (s >= 70 ? 'likely' : s >= 40 ? 'unsure' : 'risk');
const ICON = { likely: '🟢', unsure: '🟡', risk: '🔴' };

async function scoreMany(ids) {
  if (!ids.length) return {};
  // the group's messages are read once (one pass with window functions), not once per message: this list is on the
  // Onboarding page and the bot's team list, and must stay fast with thousands of messages in a group
  const rows = (await q(`WITH ch AS (SELECT DISTINCT ON (driver_id) driver_id, chat_id, linked_at FROM tg_chats WHERE driver_id = ANY($1::int[]) AND kind = 'dispatch' AND active ORDER BY driver_id, linked_at DESC NULLS LAST),
      m AS (SELECT m.chat_id, m.at, m.imported,
          (p.tg_id IS NOT NULL AND NOT m.is_bot AND (p.role = 'driver' OR (p.role IS NULL AND p.user_id IS NULL))) isdrv,
          NOT coalesce((p.role = 'driver' OR (p.role IS NULL AND p.user_id IS NULL)), false) nondrv
        FROM tg_messages m LEFT JOIN tg_people p ON p.tg_id = m.from_id WHERE m.chat_id IN (SELECT chat_id FROM ch)),
      w AS (SELECT m.*, max(at) FILTER (WHERE isdrv) OVER (PARTITION BY chat_id) last_drv,
          min(at) FILTER (WHERE isdrv) OVER (PARTITION BY chat_id ORDER BY at RANGE BETWEEN interval '1 microsecond' FOLLOWING AND UNBOUNDED FOLLOWING) next_drv FROM m),
      st AS (SELECT w.chat_id, max(w.at) FILTER (WHERE w.isdrv AND NOT w.imported) drv_last, count(*) FILTER (WHERE w.isdrv AND w.at > now() - interval '7 days')::int drv7,
          count(*) FILTER (WHERE w.nondrv AND w.at > coalesce(w.last_drv, ch.linked_at, 'epoch'))::int unanswered,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM w.next_drv - w.at) / 60) FILTER (WHERE w.nondrv AND w.at > now() - interval '14 days' AND NOT w.imported AND w.next_drv < w.at + interval '48 hours') reply_min
        FROM w JOIN ch ON ch.chat_id = w.chat_id GROUP BY w.chat_id),
      nt AS (SELECT n.driver_id, count(*) FILTER (WHERE n.outcome IN ('No answer', 'Left voicemail') AND n.created_at > now() - interval '7 days')::int no_answer,
          count(*) FILTER (WHERE n.outcome = 'Talked' AND n.created_at > now() - interval '7 days')::int talked, max(n.created_at) FILTER (WHERE n.outcome = 'Talked') talked_last
        FROM notes n WHERE n.driver_id = ANY($1::int[]) AND n.kind = 'call' GROUP BY 1)
    SELECT d.id, CASE WHEN c.drop_dismissed_at IS NULL THEN c.drop_flag END drop_flag, d.amazon_step, d.amazon_log, d.callback_state, o.expected_arrival::text start, c.ai_status, ch.chat_id, ch.linked_at,
      st.drv_last, coalesce(st.drv7, 0) drv7, coalesce(st.unanswered, 0) unanswered, st.reply_min, coalesce(nt.no_answer, 0) no_answer, coalesce(nt.talked, 0) talked, nt.talked_last
    FROM drivers d LEFT JOIN onboarding o ON o.driver_id = d.id LEFT JOIN onb_cases c ON c.driver_id = d.id
    LEFT JOIN ch ON ch.driver_id = d.id LEFT JOIN st ON st.chat_id = ch.chat_id LEFT JOIN nt ON nt.driver_id = d.id WHERE d.id = ANY($1::int[])`, [ids])).rows;
  const out = {};
  for (const r of rows) {
    let s = 70; const why = [];
    const add = (n, t) => { s += n; why.push({ n, t }); };
    // silence: since he last wrote (or since the group was made, if never), worse when we wrote and he did not answer
    const lastSign = [r.drv_last, r.talked_last].filter(Boolean).map((x) => new Date(x)).sort((a, b) => b - a)[0] || (r.chat_id ? new Date(r.linked_at) : null);
    const silentDays = lastSign ? Math.floor((Date.now() - lastSign) / DAY) : null;
    if (silentDays !== null && silentDays >= 1) {
      const pen = Math.min(4, silentDays) * 10 * (r.unanswered ? 1 : 0.5);
      add(-Math.round(pen), `silent ${silentDays} day${silentDays === 1 ? '' : 's'}${r.unanswered ? `, ${r.unanswered} message${r.unanswered === 1 ? '' : 's'} unanswered` : ''}`);
    }
    if (r.unanswered >= 3 && !(silentDays >= 1)) add(-Math.min(15, r.unanswered * 3), `${r.unanswered} of our messages unanswered`);
    if (r.reply_min !== null && !(silentDays >= 2)) {
      const m = +r.reply_min;
      if (m <= 30) add(10, 'answers within 30 min'); else if (m <= 180) add(5, 'answers within 3 h'); else if (m > 720) add(-10, `slow to answer (about ${Math.round(m / 60)} h)`);
    }
    if (r.chat_id) { if (r.drv7 >= 10) add(5, 'active in the group'); else if (r.drv7 === 0) add(-5, 'no messages this week'); }
    if (r.talked) add(10, `answered a call this week`);
    if (r.no_answer) add(-Math.min(18, r.no_answer * 6), `${r.no_answer} call${r.no_answer === 1 ? '' : 's'} not answered this week`);
    if (r.no_answer >= 3 && !r.talked) add(-10, 'not reachable by phone');
    if (r.callback_state === 'missed') add(-5, 'a call-back he asked for was missed');
    if (r.start) { const d = (new Date(r.start + 'T12:00:00Z') - Date.now()) / DAY; if (d >= -1 && d <= 14) add(10, 'start date set'); else if (d < -1) add(-10, 'start date passed'); }
    if (r.amazon_step === 'verified') add(10, 'Amazon verified');
    else { const at = r.amazon_step && r.amazon_log ? r.amazon_log[r.amazon_step] : null; if (at && Date.now() - new Date(at) > 5 * DAY) add(-10, `Amazon stuck ${Math.floor((Date.now() - new Date(at)) / DAY)} days`); }
    const st = r.ai_status || {};
    if (['unhappy', 'angry'].includes(st.driver_mood)) add(-10, `mood: ${st.driver_mood}`);
    if ((st.blockers || []).length) add(-Math.min(10, st.blockers.length * 5), 'issues: ' + st.blockers.slice(0, 2).join('; '));
    // ghosting outweighs everything good before it: silent with our messages unanswered caps the chance
    if (silentDays >= 2 && (r.unanswered || r.no_answer)) { const cap = silentDays >= 7 ? 15 : silentDays >= 4 ? 35 : 55; if (s > cap) { s = cap; why.push({ n: -0.5, t: `capped at ${cap} while silent` }); } }
    if (r.drop_flag) { why.push({ n: -100, t: 'said he is not coming: "' + r.drop_flag.quote + '"' }); s = Math.min(s, 5); }
    s = Math.max(0, Math.min(100, Math.round(s)));
    out[r.id] = { score: s, level: LEVEL(s), icon: ICON[LEVEL(s)], silentDays, unanswered: r.unanswered || 0, replyMin: r.reply_min === null ? null : Math.round(+r.reply_min),
      calls: { noAnswer: r.no_answer, talked: r.talked }, reasons: why.sort((a, b) => Math.abs(b.n) - Math.abs(a.n)).map((x) => ({ up: x.n > 0, text: x.t })) };
  }
  return out;
}
const scoreOne = async (id) => (await scoreMany([id]))[id] || null;
module.exports = { scoreMany, scoreOne, ICON };
