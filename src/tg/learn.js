// How the bot teaches itself. Everything here is measured from real work, nobody has to press anything:
// 1. skills    - its drafts are graded against what the team really wrote (onboard.grade), by topic. A topic it gets
//                right often enough is "proven"; with "answer proven topics alone" on, it answers those by itself, one
//                in five still goes to the team so the score keeps being measured, and a topic that slips steps back.
// 2. outcomes  - every message it sends a driver is followed: did he write back within a day? The wording that gets
//                more replies is used more.
// 3. predict   - how long drivers who made it took on each Amazon step: someone slower than three in four of them is
//                slipping, and the team hears before the fixed deadlines (journey.js).
// 4. people    - the hours each driver is usually active (he hears from the bot then), and how fast each of us answers it.
// 5. review    - once a week the AI reads its own mistakes and proposes fixes: a new answer, a wording, a rule, or a
//                change to the website. An admin approves or rejects each; an approved answer goes into the knowledge base.
//                An approved website change waits as a ready task (and becomes a GitHub issue when GITHUB_TOKEN is set).
const db = require('../db');
const { q } = db;

const HUMAN_ONLY = ['pay', 'safety']; // money, DOT and accidents: always a person
const BAR = { min: 10, acc: 0.85, recent: 5 }; // proven: 85% over 10+ graded drafts, and none wrong in the last 5
const SAMPLE = 5; // one in five answers on a proven topic still goes to the team
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// ---------- 1. skills ----------
async function skills() {
  const TOPICS = require('../kb').TOPICS;
  const rows = (await q(`SELECT topic, grade, auto, graded_at FROM tg_drafts WHERE grade IS NOT NULL AND graded_at > now() - interval '60 days' ORDER BY graded_at DESC LIMIT 5000`)).rows;
  const alone = (await q(`SELECT topic FROM tg_drafts WHERE auto AND created_at > now() - interval '60 days' LIMIT 5000`)).rows;
  const by = {};
  for (const r of rows) {
    if (!['same', 'partly', 'wrong'].includes(r.grade)) continue;
    const t = TOPICS[r.topic] ? r.topic : 'other'; const s = by[t] = by[t] || { topic: t, label: TOPICS[t], same: 0, partly: 0, wrong: 0, last: [] };
    s[r.grade]++; if (s.last.length < BAR.recent) s.last.push(r.grade);
  }
  return Object.values(by).map((s) => {
    const total = s.same + s.partly + s.wrong; const accuracy = (s.same + s.partly * 0.5) / total; const humanOnly = HUMAN_ONLY.includes(s.topic);
    const slipping = s.last.includes('wrong');
    return { topic: s.topic, label: s.label, same: s.same, partly: s.partly, wrong: s.wrong, total, accuracy, humanOnly, slipping,
      proven: !humanOnly && total >= BAR.min && accuracy >= BAR.acc && !slipping, alone: alone.filter((a) => (a.topic || 'other') === s.topic).length };
  }).sort((a, b) => b.total - a.total);
}
// May the bot answer this topic by itself right now? (the setting is on, the topic is proven, and this is not the one in five)
async function mayAnswerAlone(topic, roll = Math.random()) {
  if (!(db.settings.tg || {}).skillAuto || !topic || HUMAN_ONLY.includes(topic)) return false;
  const s = (await skills()).find((x) => x.topic === topic);
  return !!(s && s.proven) && roll >= 1 / SAMPLE;
}

// ---------- 2. outcomes ----------
async function record({ driverId, kind, variant = 0, who = null }) {
  return (await q(`INSERT INTO bot_outcomes (driver_id, kind, variant, who) VALUES ($1, $2, $3, $4) RETURNING id`, [driverId || null, kind, variant, who])).rows[0].id;
}
// the driver wrote back within a day of a message to him
async function markReplies() {
  const open = (await q(`SELECT id, driver_id, sent_at FROM bot_outcomes WHERE replied_at IS NULL AND driver_id IS NOT NULL AND kind NOT LIKE 'team:%' AND sent_at > now() - interval '48 hours'`)).rows;
  for (const o of open) {
    const m = (await q(`SELECT min(m.at) at FROM tg_chats c JOIN tg_messages m ON m.chat_id = c.chat_id JOIN tg_people p ON p.tg_id = m.from_id AND p.role = 'driver' AND p.driver_id = c.driver_id
      WHERE c.driver_id = $1 AND m.at > $2 AND m.at < $2::timestamptz + interval '24 hours'`, [o.driver_id, o.sent_at])).rows[0];
    if (m && m.at) await q(`UPDATE bot_outcomes SET replied_at = $2 WHERE id = $1`, [o.id, m.at]);
  }
}
async function outcomeStats() {
  const rows = (await q(`SELECT kind, variant, replied_at, sent_at FROM bot_outcomes WHERE kind NOT LIKE 'team:%' AND sent_at > now() - interval '90 days' AND (replied_at IS NOT NULL OR sent_at < now() - interval '24 hours') LIMIT 20000`)).rows;
  const by = {};
  for (const r of rows) { const k = r.kind + '#' + r.variant; const s = by[k] = by[k] || { kind: r.kind, variant: r.variant, sent: 0, replied: 0 }; s.sent++; if (r.replied_at) s.replied++; }
  return Object.values(by).map((s) => ({ ...s, rate: s.replied / s.sent })).sort((a, b) => a.kind.localeCompare(b.kind) || a.variant - b.variant);
}
// Which wording to use: the least tried until each has 8 results, then the one drivers answer most (4 times in 5)
async function choose(kind, n, roll = Math.random()) {
  if (n <= 1) return 0;
  const st = (await outcomeStats()).filter((s) => s.kind === kind); const of = (i) => st.find((s) => s.variant === i) || { sent: 0, replied: 0, rate: 0 };
  const all = [...Array(n).keys()];
  const least = all.reduce((a, b) => (of(b).sent < of(a).sent ? b : a), 0);
  if (all.some((i) => of(i).sent < 8) || roll < 0.2) return least;
  return all.reduce((a, b) => (of(b).rate > of(a).rate ? b : a), 0);
}

// ---------- 3. predict ----------
let typ = null, typAt = 0;
// How long drivers who got verified spent on each Amazon step (hours): the middle one, and the slow quarter
async function typical(force) {
  if (typ && !force && Date.now() - typAt < 3600e3) return typ;
  const keys = db.AMAZON.map((a) => a.key); const dur = {};
  for (const d of (await q(`SELECT amazon_log FROM drivers WHERE amazon_step = 'verified' AND amazon_log IS NOT NULL LIMIT 3000`)).rows) {
    const log = typeof d.amazon_log === 'string' ? JSON.parse(d.amazon_log) : d.amazon_log || {};
    const seen = keys.filter((k) => log[k]).map((k) => [k, +new Date(log[k])]).filter(([, t]) => t);
    for (let i = 0; i < seen.length - 1; i++) { const h = (seen[i + 1][1] - seen[i][1]) / 36e5; if (h > 0 && h < 24 * 60) (dur[seen[i][0]] = dur[seen[i][0]] || []).push(h); }
  }
  typ = Object.fromEntries(Object.entries(dur).filter(([, a]) => a.length >= 8).map(([k, a]) => [k, { n: a.length, median: med(a), slow: pct(a, 0.75) }])); typAt = Date.now();
  return typ;
}

// ---------- 4. people ----------
// The hours (team time zone) this driver usually writes; null when we do not know him yet
async function activeHours(driverId) {
  const rows = (await q(`SELECT m.at FROM tg_chats c JOIN tg_messages m ON m.chat_id = c.chat_id JOIN tg_people p ON p.tg_id = m.from_id AND p.role = 'driver' AND p.driver_id = c.driver_id
    WHERE c.driver_id = $1 ORDER BY m.at DESC LIMIT 200`, [driverId])).rows;
  if (rows.length < 5) return null;
  const tz = db.settings.tz || 'America/Chicago'; const n = {};
  for (const r of rows) { const h = +new Date(r.at).toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }); n[h] = (n[h] || 0) + 1; }
  return Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => +h);
}
// Is now a good time to write to him? Within two hours of when he usually writes (anyone we do not know: yes)
async function goodTime(driverId, hourNow) {
  const hs = await activeHours(driverId); if (!hs) return true;
  return hs.some((h) => Math.min(Math.abs(h - hourNow), 24 - Math.abs(h - hourNow)) <= 2);
}
// How each of us answers the bot's follow-ups
async function teamStats() {
  const rows = (await q(`SELECT who, sent_at, replied_at FROM bot_outcomes WHERE kind LIKE 'team:%' AND sent_at > now() - interval '30 days' LIMIT 20000`)).rows;
  const by = {}; let waiting = 0;
  for (const r of rows) { if (!r.replied_at) { waiting++; continue; } const s = by[r.who || 'Someone'] = by[r.who || 'Someone'] || { who: r.who || 'Someone', answered: 0, mins: [] }; s.answered++; s.mins.push((new Date(r.replied_at) - new Date(r.sent_at)) / 60000); }
  return { people: Object.values(by).map((s) => ({ who: s.who, answered: s.answered, medianMin: Math.round(med(s.mins)) })).sort((a, b) => b.answered - a.answered), asked: rows.length, waiting };
}
// a follow-up to the team was answered (a button or a reply)
async function teamAnswered(driverId, key, who) {
  await q(`UPDATE bot_outcomes SET replied_at = now(), who = $3 WHERE id = (SELECT id FROM bot_outcomes WHERE driver_id = $1 AND kind = $2 AND replied_at IS NULL ORDER BY sent_at DESC LIMIT 1)`, [driverId, 'team:' + key, who || null]);
}

// ---------- 5. the weekly review ----------
async function material() {
  const misses = (await q(`SELECT topic, driver_text, draft, coalesce(team_text, sent_text) team, grade, grade_note FROM tg_drafts WHERE grade IN ('wrong', 'partly') AND graded_at > now() - interval '7 days' ORDER BY graded_at DESC LIMIT 25`)).rows;
  const steps = (await q(`SELECT label, evidence FROM onb_ai_steps WHERE state IN ('rejected', 'undone') AND decided_at > now() - interval '7 days' LIMIT 15`)).rows;
  const ignored = (await q(`SELECT key, count(*)::int n FROM journey_asks WHERE done_at > now() - interval '7 days' GROUP BY key`)).rows;
  const drafts = (await q(`SELECT state, count(*)::int n FROM tg_drafts WHERE created_at > now() - interval '7 days' GROUP BY state`)).rows;
  return { misses, steps, ignored, drafts, skills: await skills(), outcomes: await outcomeStats(), team: await teamStats() };
}
async function review({ force = false } = {}) {
  const ai = require('./ai'); if (!ai.on()) return { skipped: 'The AI is off' };
  const m = await material();
  if (!force && !m.misses.length && !m.steps.length && !m.ignored.length) return { skipped: 'Nothing went wrong this week' };
  const lines = [
    'DRAFTS THAT WERE OFF (driver wrote / the bot drafted / the team really wrote / why):', ...m.misses.map((x) => `- [${x.topic || 'other'}, ${x.grade}] "${x.driver_text}" / "${x.draft}" / "${x.team}" / ${x.grade_note}`),
    'STEPS THE BOT THOUGHT WERE DONE BUT WERE NOT:', ...m.steps.map((x) => `- ${x.label}: "${x.evidence || ''}"`),
    'FOLLOW-UPS THE TEAM NEVER ANSWERED (kind, times):', ...m.ignored.map((x) => `- ${x.key}: ${x.n}`),
    'DRAFTS THIS WEEK BY WHAT HAPPENED TO THEM:', ...m.drafts.map((x) => `- ${x.state}: ${x.n}`),
    'SCORE BY TOPIC:', ...m.skills.map((s) => `- ${s.label}: ${Math.round(s.accuracy * 100)}% of ${s.total}${s.proven ? ' (proven)' : ''}`),
    'REPLY RATE BY MESSAGE AND WORDING:', ...m.outcomes.map((o) => `- ${o.kind} #${o.variant}: ${o.replied} of ${o.sent}`),
    `TEAM: ${m.team.asked} follow-ups asked, ${m.team.waiting} not answered.`];
  const r = await ai.weeklyReview(lines.join('\n').slice(0, 30000));
  let saved = 0;
  for (const p of (r.proposals || []).slice(0, 10)) {
    if (!['knowledge', 'wording', 'rule', 'site'].includes(p.kind) || !String(p.title || '').trim()) continue;
    if ((await q(`SELECT 1 FROM bot_proposals WHERE lower(title) = lower($1) AND created_at > now() - interval '60 days'`, [p.title])).rows[0]) continue; // said before
    await q(`INSERT INTO bot_proposals (kind, title, detail, data) VALUES ($1, $2, $3, $4)`, [p.kind, String(p.title).slice(0, 200), String(p.detail || '').slice(0, 1500), JSON.stringify({ question: p.question || null, answer: p.answer || null })]);
    saved++;
  }
  if (saved) for (const u of (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows) await db.notify(db.pool, u.id, 'telegram', `The bot reviewed its week and has ${saved} idea${saved === 1 ? '' : 's'} for you to approve.`, '#/telegram');
  return { saved };
}
// An admin's answer to a proposal
async function decide(id, decision, user) {
  const p = (await q(`SELECT * FROM bot_proposals WHERE id = $1 AND status = 'open'`, [id])).rows[0]; if (!p) return null;
  let status = decision === 'approve' ? 'approved' : 'rejected', note = null;
  if (decision === 'approve' && p.kind === 'knowledge' && p.data && p.data.question && p.data.answer) {
    await require('../kb').add({ kind: 'general', question: p.data.question, answer: p.data.answer, by: user.name, sure: true, source: 'review' });
    status = 'done'; note = 'Added to the knowledge base';
  }
  if (decision === 'approve' && p.kind === 'site') note = await siteTask(p).catch((e) => 'Could not open the GitHub issue: ' + e.message);
  await q(`UPDATE bot_proposals SET status = $2, decided_by = $3, decided_at = now(), note = $4 WHERE id = $1`, [id, status, user.name, note]);
  return { status, note };
}
// 6. an approved change to the website becomes a task for the builder: a GitHub issue when the token is set
async function siteTask(p) {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO; // owner/name
  if (!token || !repo) return 'Approved. Waiting to be built: ask Claude Code to "build the approved site ideas".';
  const r = await fetch(`https://api.github.com/repos/${repo}/issues`, { method: 'POST', headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'fleethire-bot', 'content-type': 'application/json' },
    body: JSON.stringify({ title: p.title, body: `${p.detail}\n\nProposed by the bot's weekly review and approved by an admin on the website.`, labels: ['bot-approved'] }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || 'GitHub answered ' + r.status);
  return 'Approved. GitHub issue: ' + j.html_url;
}

async function tick() {
  await markReplies().catch((e) => console.error('learn replies', e.message));
  // the review: once a week
  const week = Math.floor(Date.now() / (7 * 864e5));
  const first = (await q(`INSERT INTO tg_state (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`, ['review:' + week])).rows[0];
  if (first) await review().catch((e) => console.error('learn review', e.message));
}
function start() { setInterval(() => tick().catch((e) => console.error('learn tick', e.message)), +process.env.TG_LEARN_MS || 10 * 60000); }
module.exports = { start, tick, skills, mayAnswerAlone, record, markReplies, outcomeStats, choose, typical, activeHours, goodTime, teamStats, teamAnswered, material, review, decide, HUMAN_ONLY, BAR, SAMPLE };
