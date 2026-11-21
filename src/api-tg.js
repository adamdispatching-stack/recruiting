// The Telegram manager on the website: is the bot on, which groups it is in, what happened in each (summaries,
// ELD steps and checks, messages), who is who, and link codes for a driver's groups.
const crypto = require('crypto');
const db = require('./db');
const lib = require('./lib');
const bot = require('./tg/bot');
const eld = require('./tg/eld');
const onb = require('./tg/onboard');
const summary = require('./tg/summary');
const ai = require('./tg/ai');
const { q } = db;
const { wrap, needUser, needAdmin, visSql, loadDriver } = lib;

const ROLES = ['driver', 'eld', 'accounting', 'dispatch', 'staff'];
function eldView(c) {
  if (!c) return null;
  const s = c.steps || {};
  return { steps: eld.STEPS.map((x) => ({ key: x.k, label: x.label, done: !!s[x.k], by: s[x.k] ? s[x.k].by : null, at: s[x.k] ? s[x.k].at : null })),
    phase: eld.phaseOf(s), setupDoneAt: c.setup_done_at, stoppedAt: c.stopped_at, waiting: c.wait && !c.setup_done_at ? { phase: c.wait.phase, since: c.wait.at, reminders: c.wait.count || 0, stuck: !!c.wait.escalated } : null,
    problem: s.problem || null };
}

async function onbView(driverId) {
  const d = (await q(`SELECT amazon_step, amazon_log FROM drivers WHERE id = $1`, [driverId])).rows[0]; if (!d) return null;
  const at = db.amazonIdx(d.amazon_step);
  const reports = (await q(`SELECT id, kind, result, findings, note, from_name, at, review, reviewed_by FROM tg_reports WHERE driver_id = $1 ORDER BY at DESC LIMIT 30`, [driverId])).rows;
  const questions = (await q(`SELECT id, text, asked_at, answer, answered_by, answered_at FROM tg_questions WHERE driver_id = $1 ORDER BY asked_at DESC LIMIT 40`, [driverId])).rows;
  return { amazon: db.AMAZON.map((x, i) => ({ key: x.key, label: x.label, done: i <= at, at: d.amazon_log ? d.amazon_log[x.key] || null : null })), amazonStep: d.amazon_step,
    reports: reports.map((r) => ({ ...r, label: onb.REPORT[r.kind] || r.kind, resultText: onb.RESULT[r.result] || r.result })), questions };
}
module.exports = (app) => {
  app.get('/api/tg/status', needUser, wrap(async (req, res) => {
    const st = bot.state;
    res.json({ on: bot.on(), running: st.running, bot: st.me ? { username: st.me.username, name: st.me.first_name } : null, lastError: st.lastError, lastUpdateAt: st.lastUpdateAt, ai: ai.on(), settings: db.settings.tg });
  }));

  // groups, with what needs attention first
  app.get('/api/tg/chats', needUser, wrap(async (req, res) => {
    const params = [db.settings.tz]; const vis = visSql(req.user, params);
    const rows = (await q(`SELECT c.*, d.name driver, d.owner_id, e.steps, e.wait, e.setup_done_at, e.stopped_at,
        (SELECT row_to_json(s) FROM (SELECT day::text, summary, issues, mood FROM tg_summaries WHERE chat_id = c.chat_id ORDER BY day DESC LIMIT 1) s) last_summary,
        (SELECT count(*)::int FROM tg_messages m WHERE m.chat_id = c.chat_id AND (m.at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date) today_msgs,
        (SELECT count(*)::int FROM eld_checks k WHERE k.chat_id = c.chat_id AND ((k.answer = 'problem' AND k.fixed_at IS NULL) OR (k.answer IS NULL AND k.escalated_at IS NOT NULL))) open_checks,
        (SELECT row_to_json(k) FROM (SELECT slot, answer, answered_by FROM eld_checks WHERE chat_id = c.chat_id ORDER BY asked_at DESC LIMIT 1) k) last_check,
        d.amazon_step, (SELECT count(*)::int FROM tg_questions x WHERE x.chat_id = c.chat_id AND x.answer IS NULL AND x.asked_at > now() - interval '7 days') open_questions,
        (SELECT count(*)::int FROM tg_reports r WHERE r.chat_id = c.chat_id AND r.review IS NULL) reports_to_review
      FROM tg_chats c LEFT JOIN drivers d ON d.id = c.driver_id LEFT JOIN eld_cases e ON e.driver_id = c.driver_id AND e.chat_id = c.chat_id
      WHERE c.active ${req.user.role === 'admin' ? '' : `AND c.driver_id IS NOT NULL${vis ? ' AND ' + vis : ''}`} ORDER BY c.kind IS NULL, c.last_at DESC NULLS LAST`, params)).rows;
    res.json({ chats: rows.map((c) => ({ chatId: c.chat_id, title: c.title, kind: c.kind, driverId: c.driver_id, driver: c.driver, ownerId: c.owner_id, botAdmin: c.bot_admin, lastAt: c.last_at, todayMsgs: c.today_msgs,
      eld: c.kind === 'eld' && c.steps ? eldView(c) : null, openChecks: c.open_checks, lastCheck: c.last_check, lastSummary: c.last_summary,
      onb: c.kind === 'onboarding' ? { amazonStep: c.amazon_step, amazonLabel: c.amazon_step ? db.AMAZON.find((x) => x.key === c.amazon_step).label : null, openQuestions: c.open_questions, reportsToReview: c.reports_to_review } : null })) });
  }));

  async function loadChat(req, res) {
    const c = (await q(`SELECT c.*, d.name driver, d.owner_id FROM tg_chats c LEFT JOIN drivers d ON d.id = c.driver_id WHERE c.chat_id = $1`, [req.params.id])).rows[0];
    if (!c) { res.status(404).json({ error: 'Group not found' }); return null; }
    if (req.user.role !== 'admin') { if (!c.driver_id) { res.status(404).json({ error: 'Group not found' }); return null; } if (!(await loadDriver(req, res, c.driver_id))) return null; }
    return c;
  }
  app.get('/api/tg/chats/:id', needUser, wrap(async (req, res) => {
    const c = await loadChat(req, res); if (!c) return;
    const e = (await q(`SELECT * FROM eld_cases WHERE driver_id = $1 AND chat_id = $2`, [c.driver_id, c.chat_id])).rows[0];
    const checks = (await q(`SELECT id, slot, answer, problem, answered_by, answered_at, fixed_at, reminded, escalated_at FROM eld_checks WHERE chat_id = $1 ORDER BY asked_at DESC LIMIT 60`, [c.chat_id])).rows
      .map((k) => ({ ...k, answered_by: /^tg:/.test(k.answered_by || '') ? null : k.answered_by }));
    const sums = (await q(`SELECT day::text, summary, issues, mood, messages, created_at FROM tg_summaries WHERE chat_id = $1 ORDER BY day DESC LIMIT 30`, [c.chat_id])).rows;
    const msgs = (await q(`SELECT m.msg_id, m.from_name, m.is_bot, m.text, m.media, m.media_note, m.at, p.role FROM tg_messages m LEFT JOIN tg_people p ON p.tg_id = m.from_id WHERE m.chat_id = $1 ORDER BY m.at DESC LIMIT 300`, [c.chat_id])).rows.reverse();
    const people = (await q(`SELECT p.tg_id::text tg_id, p.name, p.username, p.role, p.driver_id, d.name driver FROM tg_members m JOIN tg_people p ON p.tg_id = m.tg_id LEFT JOIN drivers d ON d.id = p.driver_id WHERE m.chat_id = $1 ORDER BY p.name`, [c.chat_id])).rows;
    res.json({ chat: { chatId: c.chat_id, title: c.title, kind: c.kind, driverId: c.driver_id, driver: c.driver, botAdmin: c.bot_admin, linkedAt: c.linked_at }, eld: c.kind === 'eld' ? eldView(e) : null,
      onb: c.kind === 'onboarding' && c.driver_id ? await onbView(c.driver_id) : null, checks, summaries: sums, messages: msgs, people, ai: ai.on() });
  }));
  app.post('/api/tg/chats/:id/summary', needUser, wrap(async (req, res) => {
    const c = await loadChat(req, res); if (!c) return;
    const day = lib.isDate((req.body || {}).day) ? req.body.day : await lib.today();
    const s = await summary.summarizeChat(c.chat_id, day);
    if (!s) return res.status(400).json({ error: 'No messages in this group that day' });
    res.json({ ok: true });
  }));
  // let a group go (it stays in Telegram; the bot just stops treating it as the driver's group)
  app.delete('/api/tg/chats/:id/link', needUser, needAdmin, wrap(async (req, res) => {
    const c = await loadChat(req, res); if (!c) return;
    await q(`UPDATE tg_chats SET kind = NULL, driver_id = NULL WHERE chat_id = $1`, [c.chat_id]);
    await q(`UPDATE eld_cases SET stopped_at = now() WHERE chat_id = $1 AND stopped_at IS NULL`, [c.chat_id]);
    res.json({ ok: true });
  }));

  // ---------- questions the bot could not answer, reports, and what the bot knows ----------
  app.get('/api/tg/questions', needUser, wrap(async (req, res) => {
    const params = []; const vis = visSql(req.user, params);
    const r = (await q(`SELECT x.id, x.chat_id, x.text, x.asked_at, d.id driver_id, d.name driver FROM tg_questions x JOIN drivers d ON d.id = x.driver_id
      WHERE x.answer IS NULL AND x.asked_at > now() - interval '7 days' ${vis ? 'AND ' + vis : ''} ORDER BY x.asked_at DESC LIMIT 100`, params)).rows;
    res.json({ questions: r });
  }));
  app.post('/api/tg/questions/:id/answer', needUser, wrap(async (req, res) => {
    const x = (await q(`SELECT * FROM tg_questions WHERE id = $1`, [+req.params.id || 0])).rows[0];
    if (!x) return res.status(404).json({ error: 'Question not found' });
    if (!(await loadDriver(req, res, x.driver_id))) return;
    if (x.answer) return res.status(400).json({ error: `${x.answered_by} already answered it` });
    const a = String((req.body || {}).answer || '').trim().slice(0, 1500); if (!a) return res.status(400).json({ error: 'Write the answer' });
    if (!bot.state.me) return res.status(400).json({ error: 'The Telegram bot is not on' });
    await onb.answerFromWebsite(x.id, a, req.user);
    res.json({ ok: true });
  }));
  app.patch('/api/tg/reports/:id', needUser, wrap(async (req, res) => {
    const r = (await q(`SELECT * FROM tg_reports WHERE id = $1`, [+req.params.id || 0])).rows[0];
    if (!r) return res.status(404).json({ error: 'Report not found' });
    if (!(await loadDriver(req, res, r.driver_id))) return;
    const v = (req.body || {}).review; if (!['ok', 'look', null].includes(v)) return res.status(400).json({ error: 'Approve or mark for a look' });
    await q(`UPDATE tg_reports SET review = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [r.id, v, req.user.name]);
    if (v === 'ok' && r.kind === 'mvr') await q(`UPDATE checklist SET done = true, done_at = coalesce(done_at, now()), done_by = coalesce(done_by, $2) WHERE driver_id = $1 AND key = 'mvr' AND NOT done`, [r.driver_id, req.user.id]);
    res.json({ ok: true });
  }));
  app.get('/api/tg/knowledge', needUser, wrap(async (req, res) => {
    const r = (await q(`SELECT k.id, k.question, k.answer, k.source, k.added_by, k.uses, k.active, k.created_at, d.name driver FROM tg_knowledge k LEFT JOIN tg_chats c ON c.chat_id = k.chat_id LEFT JOIN drivers d ON d.id = c.driver_id ORDER BY k.created_at DESC LIMIT 500`)).rows;
    res.json({ knowledge: r });
  }));
  app.post('/api/tg/knowledge', needUser, wrap(async (req, res) => {
    const b = req.body || {}; const qq = String(b.question || '').trim().slice(0, 600), a = String(b.answer || '').trim().slice(0, 1500);
    if (!qq || !a) return res.status(400).json({ error: 'Write the question and the answer' });
    const r = await q(`INSERT INTO tg_knowledge (question, answer, source, added_by) VALUES ($1, $2, 'added', $3) RETURNING id`, [qq, a, req.user.name]);
    res.json({ id: r.rows[0].id });
  }));
  app.patch('/api/tg/knowledge/:id', needUser, wrap(async (req, res) => {
    const b = req.body || {}; const set = []; const vals = [+req.params.id || 0];
    if (b.question !== undefined) { const v = String(b.question).trim().slice(0, 600); if (!v) return res.status(400).json({ error: 'Write the question' }); vals.push(v); set.push(`question = $${vals.length}`); }
    if (b.answer !== undefined) { const v = String(b.answer).trim().slice(0, 1500); if (!v) return res.status(400).json({ error: 'Write the answer' }); vals.push(v); set.push(`answer = $${vals.length}`); }
    if (b.active !== undefined) { vals.push(!!b.active); set.push(`active = $${vals.length}`); }
    if (!set.length) return res.json({ ok: true });
    const r = await q(`UPDATE tg_knowledge SET ${set.join(', ')} WHERE id = $1 RETURNING id`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }));
  app.delete('/api/tg/knowledge/:id', needUser, needAdmin, wrap(async (req, res) => { await q(`DELETE FROM tg_knowledge WHERE id = $1`, [+req.params.id || 0]); res.json({ ok: true }); }));

  // people the bot has seen, and their role
  app.get('/api/tg/people', needUser, needAdmin, wrap(async (req, res) => {
    const r = (await q(`SELECT p.tg_id::text tg_id, p.name, p.username, p.role, p.driver_id, d.name driver, p.user_id, u.name user_name, p.seen_at,
      (SELECT count(*)::int FROM tg_members m WHERE m.tg_id = p.tg_id) groups FROM tg_people p LEFT JOIN drivers d ON d.id = p.driver_id LEFT JOIN users u ON u.id = p.user_id ORDER BY p.seen_at DESC NULLS LAST LIMIT 500`)).rows;
    res.json({ people: r, roles: ROLES });
  }));
  app.patch('/api/tg/people/:id', needUser, needAdmin, wrap(async (req, res) => {
    const b = req.body || {}; const role = b.role || null;
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
    const r = await q(`UPDATE tg_people SET role = $2, driver_id = CASE WHEN $2 = 'driver' THEN coalesce($3, driver_id) ELSE NULL END WHERE tg_id = $1 RETURNING tg_id`, [req.params.id, role, b.driverId ? +b.driverId : null]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Person not found' });
    res.json({ ok: true });
  }));

  // ---------- for the Chrome extension, when it uses the same bot ----------
  // Telegram lets only one program read a bot's messages. When the website runs the bot, the extension reads
  // your replies to its alerts from here instead of from Telegram.
  app.get('/api/ext/tg/info', lib.needKey, wrap(async (req, res) => {
    res.json({ on: bot.on(), botId: bot.state.me ? String(bot.state.me.id) : null, username: bot.state.me ? bot.state.me.username : null });
  }));
  app.get('/api/ext/tg/messages', lib.needKey, wrap(async (req, res) => {
    const chat = String(req.query.chat || ''); if (!/^-?\d+$/.test(chat)) return res.status(400).json({ error: 'Which chat?' });
    if (req.query.latest) return res.json({ last: +((await q(`SELECT max(msg_id) m FROM tg_messages WHERE chat_id = $1`, [chat])).rows[0].m || 0) });
    const r = (await q(`SELECT msg_id, text, reply_to FROM tg_messages WHERE chat_id = $1 AND msg_id > $2 AND NOT is_bot AND text IS NOT NULL ORDER BY msg_id LIMIT 50`, [chat, +req.query.after || 0])).rows;
    res.json({ msgs: r.map((m) => ({ msgId: +m.msg_id, text: m.text, replyTo: m.reply_to ? +m.reply_to : null })) });
  }));
  app.get('/api/ext/tg/recent-chat', lib.needKey, wrap(async (req, res) => {
    const m = (await q(`SELECT m.chat_id, c.title, m.from_name FROM tg_messages m LEFT JOIN tg_chats c ON c.chat_id = m.chat_id WHERE NOT m.is_bot ORDER BY m.at DESC LIMIT 1`)).rows[0];
    res.json(m ? { chatId: String(m.chat_id), title: m.title || m.from_name } : {});
  }));

  // a driver's groups, and a code to link one
  app.get('/api/drivers/:id/tg', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const chats = (await q(`SELECT c.chat_id, c.title, c.kind, c.bot_admin, c.last_at, e.steps, e.wait, e.setup_done_at, e.stopped_at FROM tg_chats c LEFT JOIN eld_cases e ON e.chat_id = c.chat_id AND e.driver_id = c.driver_id WHERE c.driver_id = $1 AND c.active`, [d.id])).rows;
    const open = +(await q(`SELECT count(*)::int n FROM tg_questions WHERE driver_id = $1 AND answer IS NULL AND asked_at > now() - interval '7 days'`, [d.id])).rows[0].n;
    res.json({ botOn: bot.on(), bot: bot.state.me ? bot.state.me.username : null, openQuestions: open, groups: chats.map((c) => ({ chatId: c.chat_id, title: c.title, kind: c.kind, botAdmin: c.bot_admin, lastAt: c.last_at, eld: c.kind === 'eld' && c.steps ? eldView(c) : null })) });
  }));
  app.post('/api/drivers/:id/tg-link', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const kind = (req.body || {}).kind;
    if (!bot.KINDS[kind]) return res.status(400).json({ error: 'Pick the kind of group' });
    let code; for (let i = 0; i < 5; i++) { code = String(crypto.randomInt(100000, 1000000)); if (!(await q(`SELECT 1 FROM tg_links WHERE code = $1`, [code])).rows[0]) break; }
    await q(`INSERT INTO tg_links (code, driver_id, kind, user_id) VALUES ($1, $2, $3, $4)`, [code, d.id, kind, req.user.id]);
    res.json({ code, bot: bot.state.me ? bot.state.me.username : null, botOn: bot.on() });
  }));
};
