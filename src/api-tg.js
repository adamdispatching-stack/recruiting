// The Telegram manager on the website: is the bot on, which groups it is in, what happened in each (summaries,
// ELD steps and checks, messages), who is who, and link codes for a driver's groups.
const crypto = require('crypto');
const db = require('./db');
const lib = require('./lib');
const bot = require('./tg/bot');
const eld = require('./tg/eld');
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
        (SELECT row_to_json(k) FROM (SELECT slot, answer, answered_by FROM eld_checks WHERE chat_id = c.chat_id ORDER BY asked_at DESC LIMIT 1) k) last_check
      FROM tg_chats c LEFT JOIN drivers d ON d.id = c.driver_id LEFT JOIN eld_cases e ON e.driver_id = c.driver_id AND e.chat_id = c.chat_id
      WHERE c.active ${req.user.role === 'admin' ? '' : `AND c.driver_id IS NOT NULL${vis ? ' AND ' + vis : ''}`} ORDER BY c.kind IS NULL, c.last_at DESC NULLS LAST`, params)).rows;
    res.json({ chats: rows.map((c) => ({ chatId: c.chat_id, title: c.title, kind: c.kind, driverId: c.driver_id, driver: c.driver, ownerId: c.owner_id, botAdmin: c.bot_admin, lastAt: c.last_at, todayMsgs: c.today_msgs,
      eld: c.kind === 'eld' && c.steps ? eldView(c) : null, openChecks: c.open_checks, lastCheck: c.last_check, lastSummary: c.last_summary })) });
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
    res.json({ chat: { chatId: c.chat_id, title: c.title, kind: c.kind, driverId: c.driver_id, driver: c.driver, botAdmin: c.bot_admin, linkedAt: c.linked_at }, eld: c.kind === 'eld' ? eldView(e) : null, checks, summaries: sums, messages: msgs, people, ai: ai.on() });
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

  // a driver's groups, and a code to link one
  app.get('/api/drivers/:id/tg', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const chats = (await q(`SELECT c.chat_id, c.title, c.kind, c.bot_admin, c.last_at, e.steps, e.wait, e.setup_done_at, e.stopped_at FROM tg_chats c LEFT JOIN eld_cases e ON e.chat_id = c.chat_id AND e.driver_id = c.driver_id WHERE c.driver_id = $1 AND c.active`, [d.id])).rows;
    res.json({ botOn: bot.on(), bot: bot.state.me ? bot.state.me.username : null, groups: chats.map((c) => ({ chatId: c.chat_id, title: c.title, kind: c.kind, botAdmin: c.bot_admin, lastAt: c.last_at, eld: c.kind === 'eld' && c.steps ? eldView(c) : null })) });
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
