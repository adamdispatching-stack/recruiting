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
  const rows = (await q(`SELECT d.id, d.amazon_step, d.amazon_log, d.callback_state, o.expected_arrival::text start, c.ai_status, ch.chat_id, ch.linked_at,
      (SELECT max(m.at) FROM tg_messages m JOIN tg_people p ON p.tg_id = m.from_id WHERE m.chat_id = ch.chat_id AND NOT m.is_bot AND (p.role = 'driver' OR (p.role IS NULL AND p.user_id IS NULL)) AND NOT m.imported) drv_last,
      (SELECT count(*)::int FROM tg_messages m JOIN tg_people p ON p.tg_id = m.from_id WHERE m.chat_id = ch.chat_id AND NOT m.is_bot AND (p.role = 'driver' OR (p.role IS NULL AND p.user_id IS NULL)) AND m.at > now() - interval '7 days') drv7,
      (SELECT count(*)::int FROM tg_messages m LEFT JOIN tg_people p ON p.tg_id = m.from_id WHERE m.chat_id = ch.chat_id AND NOT coalesce((p.role = 'driver' OR (p.role IS NULL AND p.user_id IS NULL)), false)
         AND m.at > coalesce((SELECT max(m2.at) FROM tg_messages m2 JOIN tg_people p2 ON p2.tg_id = m2.from_id WHERE m2.chat_id = ch.chat_id AND NOT m2.is_bot AND (p2.role = 'driver' OR (p2.role IS NULL AND p2.user_id IS NULL))), ch.linked_at, 'epoch')) unanswered,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x.mins) FROM (
         SELECT extract(epoch FROM (SELECT min(r.at) FROM tg_messages r JOIN tg_people rp ON rp.tg_id = r.from_id WHERE r.chat_id = ch.chat_id AND NOT r.is_bot AND (rp.role = 'driver' OR (rp.role IS NULL AND rp.user_id IS NULL)) AND r.at > t.at AND r.at < t.at + interval '48 hours') - t.at) / 60 mins
         FROM tg_messages t LEFT JOIN tg_people tp ON tp.tg_id = t.from_id WHERE t.chat_id = ch.chat_id AND NOT coalesce(tp.role = 'driver' OR (tp.role IS NULL AND tp.user_id IS NULL), false) AND t.at > now() - interval '14 days' AND NOT t.imported) x WHERE x.mins IS NOT NULL) reply_min,
      (SELECT count(*)::int FROM notes n WHERE n.driver_id = d.id AND n.kind = 'call' AND n.outcome IN ('No answer', 'Left voicemail') AND n.created_at > now() - interval '7 days') no_answer,
      (SELECT count(*)::int FROM notes n WHERE n.driver_id = d.id AND n.kind = 'call' AND n.outcome = 'Talked' AND n.created_at > now() - interval '7 days') talked,
      (SELECT max(n.created_at) FROM notes n WHERE n.driver_id = d.id AND n.kind = 'call' AND n.outcome = 'Talked') talked_last
    FROM drivers d LEFT JOIN onboarding o ON o.driver_id = d.id LEFT JOIN onb_cases c ON c.driver_id = d.id
    LEFT JOIN tg_chats ch ON ch.driver_id = d.id AND ch.kind = 'dispatch' AND ch.active WHERE d.id = ANY($1::int[])`, [ids])).rows;
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
    s = Math.max(0, Math.min(100, Math.round(s)));
    out[r.id] = { score: s, level: LEVEL(s), icon: ICON[LEVEL(s)], silentDays, unanswered: r.unanswered || 0, replyMin: r.reply_min === null ? null : Math.round(+r.reply_min),
      calls: { noAnswer: r.no_answer, talked: r.talked }, reasons: why.sort((a, b) => Math.abs(b.n) - Math.abs(a.n)).map((x) => ({ up: x.n > 0, text: x.t })) };
  }
  return out;
}
const scoreOne = async (id) => (await scoreMany([id]))[id] || null;
module.exports = { scoreMany, scoreOne, ICON };
