// The Telegram manager on the website: is the bot on, which groups it is in, what happened in each (summaries,
// ELD steps and checks, messages), who is who, and link codes for a driver's groups.
const crypto = require('crypto');
const db = require('./db');
const lib = require('./lib');
const bot = require('./tg/bot');
const eld = require('./tg/eld');
const onb = require('./tg/onboard');
require('./tg/acct');
const profile = require('./tg/profile');
const digest = require('./tg/digest');
const summary = require('./tg/summary');
const ai = require('./tg/ai');
const whois = require('./tg/whois');
const { q } = db;
const { wrap, needUser, needAdmin, visSql, loadDriver } = lib;

const ROLES = ['driver', 'eld', 'accounting', 'dispatch', 'staff'];
// messages and reply time per person in a window ($1, like '7 days'): median minutes from a driver's first message to the first reply, within 12 hours
const REPLY_SQL = `WITH dm AS (SELECT m.chat_id, m.at FROM tg_messages m JOIN tg_people p ON p.tg_id = m.from_id WHERE p.role = 'driver' AND m.at > now() - $1::interval AND NOT m.imported
    AND NOT EXISTS (SELECT 1 FROM tg_messages b JOIN tg_people bp ON bp.tg_id = b.from_id WHERE b.chat_id = m.chat_id AND bp.role = 'driver' AND b.at < m.at AND b.at > m.at - interval '10 minutes')),
  rep AS (SELECT x.from_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM x.at - dm.at) / 60) med, count(*)::int n FROM dm
    CROSS JOIN LATERAL (SELECT m2.from_id, m2.at FROM tg_messages m2 LEFT JOIN tg_people p2 ON p2.tg_id = m2.from_id WHERE m2.chat_id = dm.chat_id AND m2.at > dm.at AND m2.at < dm.at + interval '12 hours' AND NOT m2.is_bot AND coalesce(p2.role, '') <> 'driver' ORDER BY m2.at LIMIT 1) x GROUP BY x.from_id),
  cnt AS (SELECT from_id, count(*)::int n FROM tg_messages WHERE at > now() - $1::interval AND NOT is_bot AND NOT imported GROUP BY from_id)`;
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
  const questions = (await q(`SELECT id, text, asked_at, answer, answered_by, answered_at FROM tg_questions WHERE driver_id = $1 AND answered_by IS DISTINCT FROM 'Bot' ORDER BY asked_at DESC LIMIT 40`, [driverId])).rows;
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
    const rows = (await q(`SELECT c.*, d.name driver, d.owner_id, d.status driver_status, e.steps, e.wait, e.setup_done_at, e.stopped_at,
        (SELECT row_to_json(s) FROM (SELECT day::text, summary, issues, mood FROM tg_summaries WHERE chat_id = c.chat_id ORDER BY day DESC LIMIT 1) s) last_summary,
        (SELECT count(*)::int FROM tg_messages m WHERE m.chat_id = c.chat_id AND (m.at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date) today_msgs,
        (SELECT count(*)::int FROM eld_checks k WHERE k.chat_id = c.chat_id AND ((k.answer = 'problem' AND k.fixed_at IS NULL) OR (k.answer IS NULL AND k.escalated_at IS NOT NULL))) open_checks,
        (SELECT row_to_json(k) FROM (SELECT slot, answer, answered_by FROM eld_checks WHERE chat_id = c.chat_id ORDER BY asked_at DESC LIMIT 1) k) last_check,
        d.amazon_step, (SELECT count(*)::int FROM tg_questions x WHERE x.chat_id = c.chat_id AND x.answer IS NULL AND x.asked_at > now() - interval '7 days') open_questions,
        (SELECT count(*)::int FROM tg_reports r WHERE r.chat_id = c.chat_id AND r.review IS NULL) reports_to_review,
        (SELECT row_to_json(u) FROM (SELECT status, place, eta, at FROM tg_updates WHERE chat_id = c.chat_id ORDER BY at DESC LIMIT 1) u) last_update,
        (SELECT count(*)::int FROM tg_alerts a WHERE a.chat_id = c.chat_id AND a.resolved_at IS NULL AND a.at > now() - interval '14 days' ${req.user.role === 'admin' ? '' : "AND a.kind <> 'unprofessional_dispatcher'"}) open_alerts
      FROM tg_chats c LEFT JOIN drivers d ON d.id = c.driver_id LEFT JOIN eld_cases e ON e.driver_id = c.driver_id AND e.chat_id = c.chat_id
      WHERE c.active ${req.user.role === 'admin' ? '' : `AND c.driver_id IS NOT NULL${vis ? ' AND ' + vis : ''}${lib.groupScopeSql(req.user)}`} ORDER BY c.kind IS NULL, c.last_at DESC NULLS LAST`, params)).rows;
    res.json({ chats: rows.map((c) => ({ lastUpdate: c.last_update || null, mode: c.mode, chatId: c.chat_id, title: c.title, kind: c.kind, driverId: c.driver_id, driver: c.driver, ownerId: c.owner_id, botAdmin: c.bot_admin, lastAt: c.last_at, todayMsgs: c.today_msgs,
      eld: c.kind === 'eld' && c.steps ? eldView(c) : null, openChecks: c.open_checks, lastCheck: c.last_check, lastSummary: c.last_summary,
      onb: c.kind === 'dispatch' && c.driver_status !== 'Hired' ? { amazonStep: c.amazon_step, amazonLabel: c.amazon_step ? db.AMAZON.find((x) => x.key === c.amazon_step).label : null, openQuestions: c.open_questions, reportsToReview: c.reports_to_review } : null,
      active: c.driver_status === 'Hired', openAlerts: c.open_alerts, openQuestions: c.open_questions })) });
  }));

  async function loadChat(req, res) {
    const c = (await q(`SELECT c.*, d.name driver, d.owner_id, d.status driver_status FROM tg_chats c LEFT JOIN drivers d ON d.id = c.driver_id WHERE c.chat_id = $1`, [req.params.id])).rows[0];
    if (!c) { res.status(404).json({ error: 'Group not found' }); return null; }
    if (req.user.role !== 'admin') { if (!c.driver_id || !lib.groupScopeOk(req.user, c.driver_status)) { res.status(404).json({ error: 'Group not found' }); return null; } if (!(await loadDriver(req, res, c.driver_id))) return null; }
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
    const lr = (await q(`SELECT (SELECT count(*)::int FROM tg_messages WHERE chat_id = $1 AND NOT is_bot) msgs, (SELECT min(at) FROM tg_messages WHERE chat_id = $1) since,
      (SELECT count(*)::int FROM driver_notes WHERE chat_id = $1) notes, (SELECT count(*)::int FROM truck_events WHERE chat_id = $1) truck,
      (SELECT count(*)::int FROM tg_alerts WHERE chat_id = $1) alerts, (SELECT count(*)::int FROM tg_knowledge WHERE chat_id = $1 AND kind <> 'dispatch') learned,
      (SELECT count(*)::int FROM tg_knowledge WHERE chat_id = $1 AND kind = 'dispatch') lessons, (SELECT count(*)::int FROM tg_updates WHERE chat_id = $1) updates,
      (SELECT count(DISTINCT m.tg_id)::int FROM tg_members m JOIN tg_people p ON p.tg_id = m.tg_id WHERE m.chat_id = $1 AND p.role = 'dispatch') dispatchers`, [c.chat_id]).catch((e) => { console.error('tg learning', e.message); return { rows: [{}] }; })).rows[0];
    const working = c.kind === 'dispatch' && (c.driver_status === 'Hired' || c.member_count > 10);
    const eldish = c.kind === 'eld' || c.kind === 'accounting';
    const updates = (await q(`SELECT id, checked, status, place, eta, load_ref, by_role, at, text FROM tg_updates WHERE chat_id = $1 ORDER BY at DESC LIMIT 15`, [c.chat_id])).rows;
    res.json({ updates, chat: { chatId: c.chat_id, title: c.title, kind: c.kind, driverId: c.driver_id, driver: c.driver, driverStatus: c.driver_status, botAdmin: c.bot_admin, linkedAt: c.linked_at, members: c.member_count, working, eldish, team: c.kind === 'management' ? { at: (db.settings.tg || {}).teamReportAt || '09:00', report: (db.settings.tg || {}).teamReport !== false, followups: (db.settings.tg || {}).teamFollowups !== false } : null, mode: c.mode || 'watch', learning: lr }, eld: c.kind === 'eld' ? eldView(e) : null,
      onb: c.kind === 'dispatch' && c.driver_id && c.driver_status !== 'Hired' ? await onbView(c.driver_id) : null,
      alerts: (await q(`SELECT id, kind, severity, text, at, resolved_at, resolved_by FROM tg_alerts WHERE chat_id = $1 ${req.user.role === 'admin' ? '' : "AND kind <> 'unprofessional_dispatcher'"} ORDER BY at DESC LIMIT 40`, [c.chat_id])).rows,
      truckEvents: (await q(`SELECT e.id, e.kind, e.title, e.details, e.status, e.at, t.unit FROM truck_events e LEFT JOIN trucks t ON t.id = e.truck_id WHERE e.chat_id = $1 ORDER BY e.at DESC LIMIT 30`, [c.chat_id])).rows,
      notes: (await q(`SELECT kind, text, at FROM driver_notes WHERE chat_id = $1 ORDER BY at DESC LIMIT 30`, [c.chat_id])).rows, checks, summaries: sums, messages: msgs, people, ai: ai.on() });
  }));
  app.post('/api/tg/chats/:id/summary', needUser, wrap(async (req, res) => {
    const c = await loadChat(req, res); if (!c) return;
    const day = lib.isDate((req.body || {}).day) ? req.body.day : await lib.today();
    const s = await summary.summarizeChat(c.chat_id, day);
    if (!s) return res.status(400).json({ error: 'No messages in this group that day' });
    res.json({ ok: true });
  }));
  // let a group go (it stays in Telegram; the bot just stops treating it as the driver's group)
  // a group linked as the wrong type or to the wrong driver: changed here. What the wrong type started is undone
  // (onboarding conversation, replies waiting, road cases), the group pushed out by the mistake gets its place back,
  // and the last 14 days are read again as the right type (quietly: nobody is told about old messages)
  // the shift desk: the shifts, who is on now, who can be reached privately, and what the bot asked and was answered
  app.get('/api/tg/desk', needUser, needAdmin, wrap(async (req, res) => {
    const D = require('./tg/desk'); const sh = await D.shiftNow();
    const people = (await q(`SELECT u.id, u.name, u.role, coalesce(u.dispatch_level, 2) level, p.tg_id::text tg_id, (SELECT count(*) > 0 FROM tg_messages m WHERE m.chat_id = p.tg_id) private_ok, p.profile
      FROM users u LEFT JOIN LATERAL (SELECT tg_id, profile FROM tg_people WHERE user_id = u.id ORDER BY profile_at DESC NULLS LAST, seen_at DESC NULLS LAST LIMIT 1) p ON true WHERE u.active AND u.role IN ('dispatcher', 'admin') ORDER BY (u.role = 'dispatcher') DESC, u.name`)).rows
      .map(({ profile, ...x }) => { // the AI review's average score suggests a level: 4+ senior, 3+ booking, else updates
        const sc = profile && Array.isArray(profile.scores) && profile.scores.length ? profile.scores.reduce((a, y) => a + (+y.score || 0), 0) / profile.scores.length : null;
        return { ...x, score: sc === null ? null : Math.round(sc * 10) / 10, suggest: sc === null ? null : sc >= 4 ? 3 : sc >= 3 ? 2 : 1 };
      });
    const checks = (await q(`SELECT c.id, c.kind, c.level, c.quote, c.until_text, c.place, c.ask, c.state, c.asked_at, c.answered_at, c.answered_by, c.answer, c.escalated, c.created_at, c.chat_id::text chat_id, d.id driver_id, d.name driver,
        (SELECT string_agg(u.name, ', ') FROM tg_check_asks a JOIN users u ON u.id = a.user_id WHERE a.check_id = c.id) asked
      FROM tg_checks c LEFT JOIN drivers d ON d.id = c.driver_id WHERE c.created_at > now() - interval '7 days' ORDER BY c.created_at DESC LIMIT 100`)).rows;
    const speed = (await q(`SELECT a.user_id, u.name, count(*)::int asked, count(a.said_at)::int answered, round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.said_at - a.asked_at) / 60) FILTER (WHERE a.said_at IS NOT NULL))::numeric)::int med
      FROM tg_check_asks a JOIN users u ON u.id = a.user_id WHERE a.asked_at > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 3 DESC`)).rows;
    const groups = (await q(`SELECT chat_id::text chat_id, title, kind FROM tg_chats WHERE active AND driver_id IS NULL AND (kind IS NULL OR kind IN ('shift', 'management')) ORDER BY (kind = 'shift') DESC NULLS LAST, title`)).rows;
    const companies = (await q(`SELECT id, name FROM companies ORDER BY lower(name)`)).rows;
    res.json({ desk: D.cfg(), tzs: D.TZS, now: sh ? sh.name : null, people, checks, speed, groups, companies, levels: D.LEVELS, levelHelp: D.LEVEL_HELP, kinds: D.KINDS });
  }));
  app.put('/api/tg/desk', needUser, needAdmin, wrap(async (req, res) => {
    const b = req.body || {}; const cur = require('./tg/desk').cfg(); const hm = (x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
    const D = require('./tg/desk');
    const shifts = (Array.isArray(b.shifts) ? b.shifts : cur.shifts).slice(0, 4).map((s) => ({ name: String(s.name || '').trim().slice(0, 30) || 'Shift', start: String(s.start || '').trim(), end: String(s.end || '').trim(),
      tz: D.TZS[s.tz] ? s.tz : db.settings.tz, people: [...new Set((s.people || []).map(Number).filter(Boolean))],
      groups: D.groupsOf(s).filter((g) => /^-?\d+$/.test(String(g.chatId || ''))).slice(0, 6).map((g) => ({ chatId: String(g.chatId), companies: [...new Set((g.companies || []).map(Number).filter(Boolean))] })) }));
    if (shifts.some((s) => !hm(s.start) || !hm(s.end))) return res.status(400).json({ error: 'Write the shift times like 06:00 and 14:00' });
    const hubs = Array.isArray(b.hubs) ? [...new Set(b.hubs.map((h) => String(h).trim().slice(0, 40)).filter(Boolean))].slice(0, 10) : cur.hubs;
    const R = { ...(cur.routines || {}), ...(b.routines || {}) }; const routines = { board: R.board !== false, boardMin: Math.max(10, Math.min(240, Math.round(+R.boardMin || 45))), notes: R.notes !== false, notesMin: Math.max(10, Math.min(180, Math.round(+R.notesMin || 45))) };
    // which question goes to which level, the regular "where is he rolling to?", and each person's level
    const levels = { ...cur.levels }; for (const k of D.KINDS) if (b.levels && [1, 2, 3].includes(+b.levels[k])) levels[k] = +b.levels[k];
    const rolling = b.rolling ? { on: !!b.rolling.on, hours: Math.max(2, Math.min(24, Math.round(+b.rolling.hours || 6))) } : cur.rolling;
    if (b.peopleLevels && typeof b.peopleLevels === 'object') for (const [id, l] of Object.entries(b.peopleLevels)) if ([1, 2, 3].includes(+l)) await q(`UPDATE users SET dispatch_level = $2 WHERE id = $1`, [+id, +l]);
    const v = { ...cur, levels, rolling, hubs, routines, on: b.on === undefined ? cur.on : !!b.on, where: ['group', 'shift'].includes(b.where) ? b.where : 'private', answerMin: Math.max(5, Math.min(120, Math.round(+b.answerMin || cur.answerMin))), shifts };
    await db.saveSetting('tg', { ...db.settings.tg, desk: v });
    // the shift groups: marked as such (not a driver's group); a group no longer used for a shift is let go
    const ids = [...new Set(shifts.flatMap((s) => s.groups.map((g) => g.chatId)))];
    if (ids.length) await q(`UPDATE tg_chats SET kind = 'shift', driver_id = NULL, mode = 'watch' WHERE chat_id = ANY($1::bigint[])`, [ids]);
    await q(`UPDATE tg_chats SET kind = NULL WHERE kind = 'shift' AND NOT (chat_id = ANY($1::bigint[]))`, [ids]);
    for (const id of ids) await q(`UPDATE tg_waiting SET done_at = now() WHERE chat_id = $1 AND done_at IS NULL`, [id]).catch(() => {});
    res.json({ ok: true, desk: v });
  }));
  // the shift routines: today's booking lists, the update notes of each shift, the words our team uses
  app.get('/api/tg/routines', needUser, needAdmin, wrap(async (req, res) => {
    const R = require('./tg/routines'); const D = require('./tg/desk');
    const shifts = [];
    for (const s of D.cfg().shifts) {
      const st = await R.notesStatus(s);
      shifts.push({ name: s.name, start: st.window.start, end: st.window.end, drivers: await Promise.all(st.drivers.map(async (d) => ({ ...d, suggest: d.note ? null : await R.suggestNote(d.id, s.name) }))) });
    }
    res.json({ boards: await R.boards(), shifts, now: ((await D.shiftNow()) || {}).name || null, terms: (await q(`SELECT id, term, meaning, active, source FROM tg_terms ORDER BY id`)).rows });
  }));
  app.post('/api/tg/notes/:driverId', needUser, wrap(async (req, res) => {
    const d = (await q(`SELECT d.id, d.name, c.chat_id FROM drivers d JOIN tg_chats c ON c.driver_id = d.id AND c.kind = 'dispatch' AND c.active WHERE d.id = $1 ORDER BY c.last_at DESC NULLS LAST LIMIT 1`, [+req.params.driverId || 0])).rows[0];
    if (!d) return res.status(404).json({ error: 'No dispatch group for this driver' });
    const text = String((req.body || {}).text || '').trim().slice(0, 1500); if (!text) return res.status(400).json({ error: 'Write the note first' });
    try { await bot.send(d.chat_id, `${bot.esc(text)}\n<i>(${bot.esc(req.user.name)})</i>`); } catch (e) { return res.status(502).json({ error: 'Telegram did not take it: ' + e.message }); }
    await require('./tg/routines').noteFromGroup({ chat_id: d.chat_id, driver_id: d.id }, req.user.name);
    await bot.log('reply', `${req.user.name} posted the shift update note`, { chatId: d.chat_id, driverId: d.id, who: req.user.name });
    res.json({ ok: true });
  }));
  app.post('/api/tg/terms', needUser, needAdmin, wrap(async (req, res) => {
    const term = String((req.body || {}).term || '').trim().slice(0, 60), meaning = String((req.body || {}).meaning || '').trim().slice(0, 400);
    if (!term || !meaning) return res.status(400).json({ error: 'Write the words and what they mean' });
    await q(`INSERT INTO tg_terms (term, meaning) VALUES ($1, $2) ON CONFLICT (lower(term)) DO UPDATE SET meaning = EXCLUDED.meaning, active = true`, [term, meaning]);
    res.json({ ok: true });
  }));
  app.delete('/api/tg/terms/:id', needUser, needAdmin, wrap(async (req, res) => { await q(`DELETE FROM tg_terms WHERE id = $1`, [+req.params.id || 0]); res.json({ ok: true }); }));
  // every group the bot is in, connected or not, with a guess from the title for the ones not connected (admins: All groups tab)
  app.get('/api/tg/all-groups', needUser, needAdmin, wrap(async (req, res) => {
    const rows = (await q(`SELECT c.chat_id::text chat_id, c.title, c.kind, c.driver_id, d.name driver, d.status driver_status, c.member_count, c.bot_admin, c.active, c.mode, c.linked_at, c.last_at, u.name linked_by,
        (SELECT count(*)::int FROM tg_messages m WHERE m.chat_id = c.chat_id AND m.at > now() - interval '7 days') msgs7,
        EXISTS (SELECT 1 FROM tg_waiting w WHERE w.chat_id = c.chat_id AND w.done_at IS NULL) waiting,
        (SELECT title FROM tg_chats x WHERE x.chat_id = c.displaced_by) pushed_by
      FROM tg_chats c LEFT JOIN drivers d ON d.id = c.driver_id LEFT JOIN users u ON u.id = c.linked_by ORDER BY c.active DESC, c.kind IS NOT NULL, c.last_at DESC NULLS LAST`)).rows;
    for (const r of rows) if (!r.kind && r.active) { const t = bot.titleInfo(r.title); const f = await bot.findDrivers({ ...t, big: r.member_count > 10 }).catch(() => ({}));
      r.guess = { kind: t.kind || 'dispatch', driverId: f.sure ? f.sure.id : null, driver: f.sure ? f.sure.name : null, status: f.sure ? ((await q(`SELECT status FROM drivers WHERE id = $1`, [f.sure.id])).rows[0] || {}).status : null }; }
    res.json({ groups: rows });
  }));
  app.get('/api/tg/driver-options', needUser, wrap(async (req, res) => res.json({ drivers: (await q(`SELECT id, name, status FROM drivers WHERE status IN ('Hired', 'Onboarding') OR updated_at > now() - interval '60 days' ORDER BY (status = 'Hired') DESC, (status = 'Onboarding') DESC, name LIMIT 600`)).rows })));
  app.patch('/api/tg/chats/:id/link', needUser, needAdmin, wrap(async (req, res) => {
    const c = await loadChat(req, res); if (!c) return;
    const kind = String((req.body || {}).kind || ''); const driverId = +(req.body || {}).driverId || c.driver_id;
    if (!['dispatch', 'eld', 'accounting', 'management', 'none', 'shift'].includes(kind)) return res.status(400).json({ error: 'Pick Dispatch, ELD, Accounting or Management' });
    const d = ['management', 'none', 'shift'].includes(kind) ? { id: null, name: '' } : (await q(`SELECT id, name FROM drivers WHERE id = $1`, [driverId])).rows[0]; if (!d) return res.status(400).json({ error: 'Pick the driver' });
    if (c.kind === kind && c.driver_id === d.id) return res.json({ ok: true, same: true });
    const bot = require('./tg/bot'); const old = { kind: c.kind, driver: c.driver_id };
    // undo what the wrong type started in this group
    await q(`UPDATE tg_drafts SET state = 'replaced', decided_at = now() WHERE chat_id = $1 AND state = 'open'`, [c.chat_id]);
    await q(`UPDATE tg_cases SET status = 'dismissed', closed_at = now(), closed_by = $2 WHERE chat_id = $1 AND status = 'open'`, [c.chat_id, `${req.user.name} (group type changed)`]);
    await q(`UPDATE eld_cases SET stopped_at = now() WHERE chat_id = $1 AND stopped_at IS NULL`, [c.chat_id]).catch(() => {});
    if (old.kind === 'dispatch') await q(`UPDATE onb_cases SET chat_id = NULL WHERE chat_id = $1`, [c.chat_id]);
    await q(`UPDATE tg_chats SET kind = NULL, driver_id = NULL WHERE chat_id = $1`, [c.chat_id]);
    // the group the mistake pushed out gets its place back
    const back = old.kind ? (await q(`UPDATE tg_chats SET kind = prev_kind, driver_id = prev_driver_id, prev_kind = NULL, prev_driver_id = NULL, displaced_by = NULL
      WHERE displaced_by = $1 AND prev_kind = $2 AND prev_driver_id = $3 AND kind IS NULL AND NOT (prev_kind = $4 AND prev_driver_id = $5) RETURNING chat_id, title, kind, driver_id`, [c.chat_id, old.kind, old.driver, kind, d.id])).rows : [];
    for (const b of back) {
      if (b.kind === 'dispatch') await q(`UPDATE onb_cases SET chat_id = $2 WHERE driver_id = $1 AND chat_id IS NULL`, [b.driver_id, b.chat_id]);
      await bot.log('connect', `Back as the ${bot.KINDS[b.kind]} group (it was pushed out by mistake)`, { chatId: b.chat_id, driverId: b.driver_id, who: req.user.name });
    }
    if (kind === 'management') await bot.linkTeam(c.chat_id, null, req.user.name);
    else if (kind === 'shift') await q(`UPDATE tg_chats SET kind = 'shift', mode = 'watch', active = true WHERE chat_id = $1`, [c.chat_id]); // which shift: Telegram → Shift desk
    else if (kind !== 'none') { await bot.linkChat(c.chat_id, kind, d.id, req.user.id, null, { by: req.user.name }); await q(`UPDATE tg_messages SET digested = false WHERE chat_id = $1 AND at > now() - interval '14 days'`, [c.chat_id]); }
    await q(`UPDATE tg_waiting SET done_at = now() WHERE chat_id = $1 AND done_at IS NULL`, [c.chat_id]).catch(() => {});
    await bot.log('connect', kind === 'none' ? `${req.user.name} disconnected this group${old.kind ? ` (it was the ${bot.KINDS[old.kind]} group)` : ''}` : kind === 'management' ? `${req.user.name} made this a management group` : `${req.user.name} changed this group${old.kind ? ` from ${bot.KINDS[old.kind]}` : ''} to the ${bot.KINDS[kind]} group of ${d.name}; the last 14 days are read again as ${bot.KINDS[kind]}`, { chatId: c.chat_id, driverId: d.id, who: req.user.name });
    for (const id of new Set([old.driver, d.id].filter(Boolean))) await db.syncAuto(db.pool, id, req.user.id).catch(() => {});
    res.json({ ok: true, restored: back.map((b) => ({ chatId: String(b.chat_id), title: b.title, kind: b.kind })) });
  }));
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
    const r = (await q(`SELECT k.id, k.kind, k.question, k.answer, k.source, k.added_by, k.uses, k.active, k.review, k.created_at, d.name driver FROM tg_knowledge k LEFT JOIN tg_chats c ON c.chat_id = k.chat_id LEFT JOIN drivers d ON d.id = c.driver_id ORDER BY k.created_at DESC LIMIT 500`)).rows;
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
    if (b.active !== undefined) { vals.push(!!b.active); set.push(`active = $${vals.length}`); if (b.active) set.push('review = false'); }
    if (!set.length) return res.json({ ok: true });
    const r = await q(`UPDATE tg_knowledge SET ${set.join(', ')} WHERE id = $1 RETURNING id`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }));
  app.delete('/api/tg/knowledge/:id', needUser, needAdmin, wrap(async (req, res) => { await q(`DELETE FROM tg_knowledge WHERE id = $1`, [+req.params.id || 0]); res.json({ ok: true }); }));

  // ---------- a website user connects their Telegram (/me 123456) ----------
  app.post('/api/tg/me-code', needUser, wrap(async (req, res) => {
    const code = String(crypto.randomInt(100000, 1000000));
    await q(`INSERT INTO tg_me_codes (code, user_id) VALUES ($1, $2)`, [code, req.user.id]);
    const me = (await q(`SELECT name, username FROM tg_people WHERE user_id = $1 ORDER BY seen_at DESC LIMIT 1`, [req.user.id])).rows[0];
    res.json({ code, bot: bot.state.me ? bot.state.me.username : null, connected: me || null });
  }));

  // ---------- alerts from the groups ----------
  app.get('/api/tg/alerts', needUser, wrap(async (req, res) => {
    const params = []; const vis = visSql(req.user, params);
    const r = (await q(`SELECT a.*, d.name driver FROM tg_alerts a JOIN drivers d ON d.id = a.driver_id WHERE a.resolved_at IS NULL AND a.at > now() - interval '14 days'
      ${req.user.role === 'admin' ? '' : `AND a.kind <> 'unprofessional_dispatcher'${vis ? ' AND ' + vis : ''}${lib.groupScopeSql(req.user)}`} ORDER BY (a.severity = 'high') DESC, a.at DESC LIMIT 100`, params)).rows;
    res.json({ alerts: r.map((a) => ({ id: a.id, chatId: a.chat_id, driverId: a.driver_id, driver: a.driver, kind: a.kind, severity: a.severity, text: a.text, at: a.at })) });
  }));
  app.patch('/api/tg/alerts/:id', needUser, wrap(async (req, res) => {
    const a = (await q(`SELECT * FROM tg_alerts WHERE id = $1`, [+req.params.id || 0])).rows[0];
    if (!a) return res.status(404).json({ error: 'Alert not found' });
    if (!(await loadDriver(req, res, a.driver_id))) return;
    await q(`UPDATE tg_alerts SET resolved_at = now(), resolved_by = $2 WHERE id = $1`, [a.id, req.user.name]);
    res.json({ ok: true });
  }));

  // ---------- the driver's profile for dispatchers ----------
  app.get('/api/drivers/:id/profile', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const p = (await q(`SELECT * FROM driver_profiles WHERE driver_id = $1`, [d.id])).rows[0];
    const notes = (await q(`SELECT kind, text, at FROM driver_notes WHERE driver_id = $1 ORDER BY at DESC LIMIT 40`, [d.id])).rows;
    const count = +(await q(`SELECT count(*)::int n FROM driver_notes WHERE driver_id = $1`, [d.id])).rows[0].n;
    res.json({ profile: p ? p.profile : null, pins: p ? p.pins : null, builtAt: p ? p.built_at : null, notes, notesCount: count, ai: ai.on(), text: await profile.profileText(d.id, false) });
  }));
  app.put('/api/drivers/:id/profile', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const pins = String((req.body || {}).pins || '').trim().slice(0, 3000) || null;
    await q(`INSERT INTO driver_profiles (driver_id, pins) VALUES ($1, $2) ON CONFLICT (driver_id) DO UPDATE SET pins = $2`, [d.id, pins]);
    await lib.history(d.id, pins ? 'Dispatcher notes updated' : 'Dispatcher notes cleared', req.user.name);
    res.json({ ok: true });
  }));
  app.post('/api/drivers/:id/profile/build', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    if (!ai.on()) return res.status(400).json({ error: 'AI is off: add ANTHROPIC_API_KEY on Railway' });
    await profile.build(d.id);
    res.json({ ok: true });
  }));

  // ---------- truck issues and service ----------
  // read the waiting messages now (admin; for checking)
  app.post('/api/tg/chats/:id/digest', needUser, needAdmin, wrap(async (req, res) => { const c = await loadChat(req, res); if (!c) return; res.json({ ok: true, found: await digest.digestChat(c.chat_id) }); }));

  // people the bot has seen, and their role
  // ---------- the bot's history: what it did and how people reacted ----------
  app.get('/api/tg/log', needUser, wrap(async (req, res) => {
    const chat = req.query.chat ? String(req.query.chat) : null; const kinds = req.query.kinds ? String(req.query.kinds).split(',').filter(Boolean) : null;
    const before = req.query.before ? +req.query.before : null;
    // not an admin: only his drivers' groups (recruiters: not hired yet; dispatchers: working), never the shift desk (who was asked, who answered)
    const scope = req.user.role === 'admin' ? '' : ` AND l.driver_id IS NOT NULL AND l.kind <> 'desk'${lib.groupScopeSql(req.user)}`;
    const r = await q(`SELECT l.id, l.at, l.chat_id, l.driver_id, l.kind, l.text, l.who, ch.title, d.name driver, d.status FROM tg_log l LEFT JOIN tg_chats ch ON ch.chat_id = l.chat_id LEFT JOIN drivers d ON d.id = l.driver_id
      WHERE ($1::bigint IS NULL OR l.chat_id = $1) AND ($2::text[] IS NULL OR l.kind = ANY($2)) AND ($3::int IS NULL OR l.id < $3)${scope} ORDER BY l.id DESC LIMIT 100`, [chat, kinds, before]);
    const counts = (await q(`SELECT l.kind, count(*)::int n FROM tg_log l LEFT JOIN drivers d ON d.id = l.driver_id WHERE l.at > now() - interval '7 days' AND ($1::bigint IS NULL OR l.chat_id = $1)${scope} GROUP BY l.kind`, [chat])).rows;
    res.json({ log: r.rows.map((x) => ({ id: x.id, at: x.at, chatId: x.chat_id, driverId: x.driver_id, driver: x.driver, hired: x.status === 'Hired', kind: x.kind, text: x.text, who: x.who, title: x.title })),
      week: Object.fromEntries(counts.map((c) => [c.kind, c.n])), more: r.rows.length === 100 });
  }));
  // ---------- the dispatch autopilot: how far the bot is with learning dispatching and updates ----------
  // replies the bot wrote for drivers in onboarding, waiting for someone to send them (Watch and learn)
  const draftOk = async (req, res, id) => { const dr = (await q(`SELECT * FROM tg_drafts WHERE id = $1`, [+id || 0])).rows[0]; if (!dr) { res.status(404).json({ error: 'Not found' }); return null; }
    if (dr.driver_id && !(await lib.loadDriver(req, res, dr.driver_id))) return null; return dr; };
  app.get('/api/tg/drafts', needUser, wrap(async (req, res) => {
    const params = []; const w = [`x.state = 'open'`, `x.created_at > now() - interval '3 days'`];
    if (req.query.driverId) { params.push(+req.query.driverId); w.push(`x.driver_id = $${params.length}`); }
    if (req.query.chatId) { params.push(String(req.query.chatId)); w.push(`x.chat_id = $${params.length}::bigint`); }
    const vis = visSql(req.user, params); if (vis) w.push(vis);
    const drafts = (await q(`SELECT x.id, x.chat_id::text chat_id, x.driver_id, x.driver_text, x.draft, x.kind, x.created_at, d.name FROM tg_drafts x LEFT JOIN drivers d ON d.id = x.driver_id WHERE ${w.join(' AND ')} ORDER BY x.created_at DESC LIMIT 50`, params)).rows;
    const st = (await q(`SELECT count(*) FILTER (WHERE state = 'sent' AND sent_text = draft)::int as_is, count(*) FILTER (WHERE state = 'sent' AND sent_text <> draft)::int changed,
      count(*) FILTER (WHERE state = 'dismissed')::int not_needed, count(*) FILTER (WHERE state = 'answered')::int team FROM tg_drafts WHERE created_at > now() - interval '30 days'`)).rows[0];
    res.json({ drafts, stats: st });
  }));
  app.post('/api/tg/drafts/:id/send', needUser, wrap(async (req, res) => {
    const dr = await draftOk(req, res, req.params.id); if (!dr) return;
    if (dr.state !== 'open') return res.status(400).json({ error: dr.state === 'sent' ? 'Already sent' : 'This reply is no longer waiting' });
    const text = String((req.body || {}).text || dr.draft).trim().slice(0, 1500); if (!text) return res.status(400).json({ error: 'Write the reply first' });
    try { await require('./tg/onboard').sendDraft(dr, text, req.user); } catch (e) { return res.status(502).json({ error: 'Telegram did not take it: ' + e.message }); }
    await lib.history(dr.driver_id, `Sent in Telegram: "${text.slice(0, 200)}"`, req.user.name, 'telegram').catch(() => {});
    res.json({ ok: true });
  }));
  app.post('/api/tg/drafts/:id/dismiss', needUser, wrap(async (req, res) => {
    const dr = await draftOk(req, res, req.params.id); if (!dr) return;
    await q(`UPDATE tg_drafts SET state = 'dismissed', sent_by = $2, decided_at = now() WHERE id = $1 AND state = 'open'`, [dr.id, req.user.name]);
    res.json({ ok: true });
  }));
  // one dispatcher's work review (admins): by Telegram id, or u<user id> from the Team page
  const dispRef = async (ref) => (await q(String(ref).startsWith('u') ? `SELECT * FROM tg_people WHERE user_id = $1 ORDER BY profile_at DESC NULLS LAST LIMIT 1` : `SELECT * FROM tg_people WHERE tg_id = $1`, [String(ref).replace(/^u/, '')])).rows[0];
  app.get('/api/tg/dispatchers/:ref', needUser, needAdmin, wrap(async (req, res) => {
    const p = await dispRef(req.params.ref);
    if (!p) return res.status(404).json({ error: String(req.params.ref).startsWith('u') ? 'His Telegram is not known to the bot yet. He links it by sending /me with his code to the bot, or the bot learns him from the driver groups.' : 'Not found' });
    const D = require('./tg/dispatchers');
    const st = await D.stats(p.tg_id);
    const user = p.user_id ? (await q(`SELECT id, name, email, active FROM users WHERE id = $1`, [p.user_id])).rows[0] : null;
    const history = (await q(`SELECT at, profile->'scores' scores, profile->>'summary' summary, profile->'trend' trend, profile->'feedback'->>'goal' goal FROM tg_disp_reviews WHERE tg_id = $1 ORDER BY at DESC LIMIT 12`, [p.tg_id])).rows;
    const groups = (await q(`SELECT c.chat_id::text chat_id, c.title, count(*)::int n, max(m.at) last FROM tg_messages m JOIN tg_chats c ON c.chat_id = m.chat_id WHERE m.from_id = $1 AND m.at > now() - interval '30 days' GROUP BY 1, 2 ORDER BY n DESC LIMIT 30`, [p.tg_id])).rows;
    res.json({ person: { tg_id: String(p.tg_id), name: p.name, username: p.username, role: p.role }, user: user && { ...user, noLogin: require('./tg/accounts').noLogin(user.email) }, profile: p.profile, at: p.profile_at, stats: st, history, groups });
  }));
  // one moment of a group's chat: the messages before and after one message (links from the dispatcher review)
  app.get('/api/tg/chats/:id/around', needUser, needAdmin, wrap(async (req, res) => {
    const chat = (await q(`SELECT chat_id::text chat_id, title FROM tg_chats WHERE chat_id = $1`, [String(req.params.id)])).rows[0];
    if (!chat) return res.status(404).json({ error: 'Group not found' });
    const msg = +req.query.msg || 0; if (!msg) return res.status(400).json({ error: 'Which message?' });
    const cols = `SELECT m.msg_id, coalesce(p.name, m.from_name) who, p.role, m.is_bot, m.text, m.media, m.media_note, m.at FROM tg_messages m LEFT JOIN tg_people p ON p.tg_id = m.from_id WHERE m.chat_id = $1`;
    const before = (await q(`${cols} AND m.msg_id <= $2 ORDER BY m.msg_id DESC LIMIT 12`, [chat.chat_id, msg])).rows.reverse();
    const after = (await q(`${cols} AND m.msg_id > $2 ORDER BY m.msg_id LIMIT 8`, [chat.chat_id, msg])).rows;
    res.json({ chatId: chat.chat_id, title: chat.title, msgs: [...before, ...after].map((m) => ({ msgId: +m.msg_id, who: m.is_bot ? 'Bot' : m.who || 'Someone', role: m.role, text: m.text, media: m.media, mediaNote: m.media_note, at: m.at })) });
  }));
  app.post('/api/tg/dispatchers/:ref/review', needUser, needAdmin, wrap(async (req, res) => {
    const p = await dispRef(req.params.ref); if (!p) return res.status(404).json({ error: 'Not found' });
    if (!ai.on()) return res.status(400).json({ error: 'AI is off: add ANTHROPIC_API_KEY on Railway' });
    let prof; try { prof = await require('./tg/dispatchers').build(p.tg_id, { force: true }); } catch (e) { return res.status(502).json({ error: e.why || e.message }); }
    if (!prof) return res.status(400).json({ error: 'Too few messages from him in the last 30 days to review.' });
    res.json({ ok: true });
  }));
  app.get('/api/tg/dispatch-readiness', needUser, needAdmin, wrap(async (req, res) => {
    const W = `c.active AND c.kind = 'dispatch' AND c.driver_id IS NOT NULL AND (d.status = 'Hired' OR c.member_count > 10)`;
    const g = (await q(`SELECT count(*)::int groups, count(*) FILTER (WHERE (SELECT min(at) FROM tg_messages m WHERE m.chat_id = c.chat_id) < now() - interval '14 days')::int watched,
      count(*) FILTER (WHERE c.mode = 'updater')::int updater FROM tg_chats c JOIN drivers d ON d.id = c.driver_id WHERE ${W}`)).rows[0];
    const m = (await q(`SELECT count(*)::int n FROM tg_messages m JOIN tg_chats c ON c.chat_id = m.chat_id JOIN drivers d ON d.id = c.driver_id WHERE ${W} AND NOT m.is_bot AND m.at > now() - interval '30 days'`)).rows[0].n;
    const u = (await q(`SELECT count(*)::int total, count(*) FILTER (WHERE checked = 'ok')::int ok, count(*) FILTER (WHERE checked = 'wrong')::int wrong FROM tg_updates`)).rows[0];
    const k = (await q(`SELECT count(*) FILTER (WHERE active)::int approved, count(*) FILTER (WHERE review AND NOT active)::int waiting FROM tg_knowledge WHERE kind = 'dispatch'`)).rows[0];
    const p = (await q(`SELECT count(*) FILTER (WHERE state = 'kept')::int kept, count(*) FILTER (WHERE state = 'broken')::int broken, count(*) FILTER (WHERE state = 'open')::int open FROM tg_promises WHERE at > now() - interval '60 days'`)).rows[0];
    const accuracy = u.ok + u.wrong ? u.ok / (u.ok + u.wrong) : null;
    const ready = g.watched >= 3 && k.approved >= 10 && u.ok + u.wrong >= 20 && accuracy >= 0.9;
    let dispatchers = [];
    if (req.user.role === 'admin') {
      dispatchers = (await q(`${REPLY_SQL} SELECT p.tg_id::text tg_id, p.name, p.profile, p.profile_at, coalesce(cnt.n, 0) msgs30, (SELECT count(DISTINCT m.chat_id)::int FROM tg_messages m WHERE m.from_id = p.tg_id AND m.at > now() - interval '30 days') groups,
        round(rep.med::numeric, 0)::int reply_min, rep.n replies FROM tg_people p LEFT JOIN cnt ON cnt.from_id = p.tg_id LEFT JOIN rep ON rep.from_id = p.tg_id WHERE (p.role = 'dispatch' OR EXISTS (SELECT 1 FROM users du WHERE du.id = p.user_id AND du.role = 'dispatcher')) ORDER BY coalesce(cnt.n, 0) DESC`, ['30 days'])).rows;
    }
    res.json({ groups: g, messages30: m, updates: { ...u, accuracy }, practices: k, promises: p, ready, dispatchers, settings: { workMode: (db.settings.tg || {}).workMode || 'watch' } });
  }));
  // the team checks a load update the AI read: right or wrong (that is the accuracy above)
  app.post('/api/tg/updates/:id', needUser, wrap(async (req, res) => {
    const r = await q(`UPDATE tg_updates SET checked = $2 WHERE id = $1 RETURNING id`, [+req.params.id || 0, (req.body || {}).ok ? 'ok' : 'wrong']);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }));
  // a management group: the onboarding list now (the AI reads the newest messages first)
  app.post('/api/tg/chats/:id/report', needUser, wrap(async (req, res) => {
    if (req.user.role === 'dispatcher') return res.status(403).json({ error: 'Not for dispatchers' });
    const c = (await q(`SELECT kind FROM tg_chats WHERE chat_id = $1 AND active`, [req.params.id])).rows[0];
    if (!c || c.kind !== 'management') return res.status(400).json({ error: 'Only for a management group' });
    if (!bot.on()) return res.status(409).json({ error: 'The Telegram bot is not running' });
    const team = require('./tg/team'); await team.refresh();
    for (const t of await team.onboardText({ tagRecruiters: true })) await bot.send(req.params.id, t);
    await bot.log('said', `Onboarding list sent from the website (${req.user.name})`, { chatId: req.params.id, driverId: null });
    res.json({ ok: true });
  }));
  // a working driver's group: watch and learn, or updater
  app.patch('/api/tg/chats/:id/mode', needUser, wrap(async (req, res) => {
    if (req.user.role === 'dispatcher') return res.status(403).json({ error: 'Not for dispatchers' });
    if (!bot.CMODES[(req.body || {}).mode]) return res.status(400).json({ error: 'Pick watch or updater' });
    await bot.setChatMode(req.params.id, req.body.mode, req.user.name);
    res.json({ ok: true });
  }));
  // ---------- waiting for someone to connect their Telegram ----------
  app.get('/api/tg/waiting', needUser, wrap(async (req, res) => {
    const r = await q(`SELECT w.*, ch.title, ch.invite_link, ch.member_count, d.name driver, d.status FROM tg_waiting w JOIN tg_chats ch ON ch.chat_id = w.chat_id LEFT JOIN drivers d ON d.id = w.driver_id
      WHERE w.done_at IS NULL AND ch.active ORDER BY w.created_at DESC`);
    const out = [];
    for (const w of r.rows) {
      const f = await bot.findDrivers(bot.titleInfo(w.title));
      // everyone else working with us, so any driver can be picked (active first for ELD / accounting groups)
      const others = (await q(`SELECT id, name, status FROM drivers WHERE status IN ('Onboarding', 'Hired') AND left_on IS NULL AND NOT (id = ANY($1::int[])) ORDER BY (status = $2) DESC, name LIMIT 300`,
        [[...f.list.map((d) => d.id), w.driver_id || 0], (w.kind || 'dispatch') === 'dispatch' && !(w.member_count > 10) ? 'Onboarding' : 'Hired'])).rows;
      const ti = bot.titleInfo(w.title);
      out.push({ big: w.member_count > 10, members: w.member_count, newName: ti.name || null, newPhone: ti.phone || null, id: w.id, chatId: w.chat_id, title: w.title, who: w.who, what: w.what, kind: w.kind || bot.titleInfo(w.title).kind, driverId: w.driver_id, driver: w.driver, at: w.created_at, link: w.invite_link,
        options: f.list.filter((d) => d.id !== w.driver_id).map((d) => ({ id: d.id, name: d.name, status: d.status })), others: others.map((d) => ({ id: d.id, name: d.name, status: d.status })) });
    }
    res.json({ waiting: out });
  }));
  app.post('/api/tg/waiting/:id', needUser, wrap(async (req, res) => {
    if (req.user.role === 'dispatcher') return res.status(403).json({ error: 'Not for dispatchers' });
    const w = (await q(`SELECT * FROM tg_waiting WHERE id = $1 AND done_at IS NULL`, [+req.params.id])).rows[0]; if (!w) return res.status(404).json({ error: 'Already done' });
    const b = req.body || {};
    if (b.team) { // the person who added the bot is on our team: marked, and everything waiting for them is connected
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin' });
      if (!w.tg_id) return res.status(400).json({ error: 'Nobody to mark' });
      await q(`UPDATE tg_people SET role = 'staff', driver_id = NULL WHERE tg_id = $1`, [w.tg_id]);
      await bot.log('me', `${w.who || 'Someone'} marked as our team on the website (${req.user.name})`, {});
      const did = await bot.resolveWaiting(w.tg_id);
      return res.json({ ok: true, connected: did.length });
    }
    if (b.dismiss) { await q(`UPDATE tg_waiting SET done_at = now(), done_by = $2, done_how = 'dismissed' WHERE id = $1`, [w.id, req.user.name]); await bot.log('wait', `Dismissed on the website: ${w.what}`, { chatId: w.chat_id }); return res.json({ ok: true }); }
    if (b.newDriver) { // nobody on the website: add the driver from the title (name and phone), then connect
      const t = bot.titleInfo((await q(`SELECT title FROM tg_chats WHERE chat_id = $1`, [w.chat_id])).rows[0].title);
      if (!t.name) return res.status(400).json({ error: 'The group title has no name. Add the driver on the website first.' });
      const onbd = b.newDriver === 'onboarding';
      const ins = await q(`INSERT INTO drivers (name, name_key, status, source, owner_id, created_by, status_at, status_locked, phones) VALUES ($1, $2, $3, 'Telegram', $4, $4, now(), true, $5) RETURNING id`,
        [t.name, db.keyOf(t.name), onbd ? 'Onboarding' : 'Hired', req.user.role === 'admin' && !onbd ? null : req.user.id, t.phone ? [t.phone] : []]);
      if (onbd) await db.ensureOnboarding(db.pool, ins.rows[0].id, req.user.id);
      await lib.history(ins.rows[0].id, onbd ? 'Added from a Telegram group, in onboarding' : 'Added from a Telegram group as an active driver', req.user.name, 'web');
      b.driverId = ins.rows[0].id;
    }
    if (b.kind === 'management' || (!b.kind && !b.driverId && w.kind === 'management')) { await bot.linkTeam(w.chat_id, null, req.user.name); return res.json({ ok: true }); }
    const driverId = +b.driverId || w.driver_id; const kind = ['dispatch', 'eld', 'accounting'].includes(b.kind) ? b.kind : w.kind || 'dispatch';
    if (!driverId) return res.status(400).json({ error: 'Pick the driver' });
    if (!bot.on()) return res.status(409).json({ error: 'The Telegram bot is not running' });
    await bot.linkChat(w.chat_id, kind, driverId, req.user.id, null, { by: req.user.name });
    const dn = (await q(`SELECT id, name FROM drivers WHERE id = $1`, [driverId])).rows[0];
    await lib.act(req.user, 'telegram', dn, `Connected the Telegram group "${w.title || ''}" (waiting for ${w.who || 'someone'})`).catch(() => {});
    res.json({ ok: true });
  }));
  app.get('/api/tg/people', needUser, needAdmin, wrap(async (req, res) => {
    // last 7 days: messages, and how fast each person answers a driver (median minutes from the driver's first message to the first reply, within 12 hours)
    const r = (await q(`${REPLY_SQL}
      SELECT p.tg_id::text tg_id, p.name, p.username, p.role, p.driver_id, d.name driver, p.user_id, u.name user_name, p.seen_at, coalesce(cnt.n, 0) msgs7, round(rep.med::numeric, 0)::int reply_min, rep.n replies,
      (SELECT count(*)::int FROM tg_members m WHERE m.tg_id = p.tg_id) groups FROM tg_people p LEFT JOIN drivers d ON d.id = p.driver_id LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN cnt ON cnt.from_id = p.tg_id LEFT JOIN rep ON rep.from_id = p.tg_id ORDER BY (p.role = 'dispatch') DESC NULLS LAST, coalesce(cnt.n, 0) DESC, p.seen_at DESC NULLS LAST LIMIT 500`, ['7 days'])).rows;
    res.json({ people: r, roles: ROLES, likelyTeam: await whois.likelyTeam() });
  }));
  app.patch('/api/tg/people/:id', needUser, needAdmin, wrap(async (req, res) => {
    const b = req.body || {}; const role = b.role || null;
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
    const r = await q(`UPDATE tg_people SET role = $2, driver_id = CASE WHEN $2 = 'driver' THEN coalesce($3, driver_id) ELSE NULL END WHERE tg_id = $1 RETURNING tg_id`, [req.params.id, role, b.driverId ? +b.driverId : null]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Person not found' });
    if (role === 'staff') await bot.resolveWaiting(req.params.id).catch((e) => console.error('tg waiting', e.message));
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
    const oc = (await q(`SELECT mode, ai_status, ai_status_at FROM onb_cases WHERE driver_id = $1`, [d.id])).rows[0];
    const sugg = (await q(`SELECT s.id, s.label, s.evidence, s.state, s.at, s.decided_by FROM onb_ai_steps s JOIN checklist c ON c.id = s.checklist_id WHERE s.driver_id = $1 AND (s.state = 'suggested' AND NOT c.done OR (s.state = 'auto' AND s.at > now() - interval '7 days')) ORDER BY s.at DESC`, [d.id])).rows;
    const onb = oc ? { mode: oc.mode, status: oc.ai_status, statusAt: oc.ai_status_at, steps: sugg } : null;
    res.json({ onb, botOn: bot.on(), bot: bot.state.me ? bot.state.me.username : null, openQuestions: open, groups: chats.map((c) => ({ chatId: c.chat_id, title: c.title, kind: c.kind, botAdmin: c.bot_admin, lastAt: c.last_at, eld: c.kind === 'eld' && c.steps ? eldView(c) : null })) });
  }));
  // ---------- which Telegram account is the driver's: the people in the driver's groups who are not our team ----------
  const pick = (p) => ({ tgId: p.tgId, name: p.name, username: p.username, linked: p.linked, otherDriver: p.otherDriver, notDriver: p.notDriver, groups: p.groups, likelyTeam: p.likelyTeam, messages: p.messages, last: p.last });
  app.get('/api/drivers/:id/tg-people', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const c = (await whois.candidates([d.id]))[d.id];
    res.json({ people: c.people.map(pick), ask: whois.toAsk(c).map((p) => p.tgId) });
  }));
  app.post('/api/drivers/:id/tg-people', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const b = req.body || {}; const c = (await whois.candidates([d.id]))[d.id];
    const list = b.none ? whois.toAsk(c) : c.people.filter((p) => p.tgId === String(b.tgId));
    if (!list.length) return res.status(400).json({ error: b.none ? 'Nobody to rule out' : "That person is not in this driver's groups" });
    const is = b.none ? 'not' : b.is;
    if (!['driver', 'not'].includes(is)) return res.status(400).json({ error: 'Pick the driver or not the driver' });
    let unlinked = 0;
    for (const p of list) unlinked += await whois.answer(d.id, p.tgId, is);
    const names = list.map((p) => p.name).join(', ');
    const text = is === 'driver' ? `Telegram: ${names} is the driver's account` : `Telegram: ${names} ${list.length > 1 ? 'are' : 'is'} not the driver`;
    await lib.history(d.id, text, req.user.name);
    await bot.log('fact', `${text} (${d.name}, set by ${req.user.name} on the website)`, { driverId: d.id }).catch(() => {});
    res.json({ ok: true, unlinked });
  }));
  // a likely team member who is not on the team: stop suggesting them
  app.post('/api/tg/people/:id/not-team', needUser, needAdmin, wrap(async (req, res) => {
    const r = await q(`UPDATE tg_people SET team_dismissed_at = now() WHERE tg_id = $1 RETURNING tg_id`, [String(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Person not found' });
    res.json({ ok: true });
  }));
  // ---------- onboarding groups: how the bot works, what the AI saw done, and learning ----------
  app.patch('/api/drivers/:id/tg-mode', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const onb = require('./tg/onboard'); const mode = (req.body || {}).mode;
    if (!onb.MODES[mode]) return res.status(400).json({ error: 'Pick watch, assist or run' });
    if (!(await q(`SELECT 1 FROM tg_chats WHERE driver_id = $1 AND kind = 'dispatch' AND active`, [d.id])).rows[0]) return res.status(400).json({ error: 'This driver has no dispatch (onboarding) group yet' });
    if (!(await q(`SELECT 1 FROM onb_cases WHERE driver_id = $1`, [d.id])).rows[0]) await q(`INSERT INTO onb_cases (driver_id, chat_id, mode) SELECT $1, chat_id, 'watch' FROM tg_chats WHERE driver_id = $1 AND kind = 'dispatch' AND active LIMIT 1`, [d.id]);
    if (mode !== 'watch' && !bot.on()) return res.status(400).json({ error: 'The bot is not running (no TELEGRAM_BOT_TOKEN)' });
    await onb.setMode(d.id, mode, req.user.name);
    res.json({ ok: true });
  }));
  // a step the AI saw done: confirm (ticks it) or reject; this is how its accuracy is measured
  app.post('/api/onb-ai-steps/:id', needUser, wrap(async (req, res) => {
    const s = (await q(`SELECT * FROM onb_ai_steps WHERE id = $1`, [+req.params.id || 0])).rows[0];
    if (!s) return res.status(404).json({ error: 'Not found' });
    const d = await loadDriver(req, res, s.driver_id); if (!d) return;
    const okd = !!(req.body || {}).ok;
    if (s.state === 'auto' && okd) return res.json({ ok: true });
    await q(`UPDATE onb_ai_steps SET state = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [s.id, s.state === 'auto' ? 'undone' : okd ? 'confirmed' : 'rejected', req.user.name]);
    if (okd) await q(`UPDATE checklist SET done = true, done_by = $2, done_at = now(), note = coalesce(note, $3) WHERE id = $1 AND NOT done`, [s.checklist_id, req.user.id, ('From Telegram: ' + (s.evidence || '')).slice(0, 500)]);
    else if (s.state === 'auto') await q(`UPDATE checklist SET done = false, done_by = NULL, done_at = NULL WHERE id = $1`, [s.checklist_id]);
    await lib.history(d.id, okd ? `Done: ${s.label} (the AI saw it in Telegram, ${req.user.name} confirmed)` : `${s.label}: not done after all (the AI was wrong)`, req.user.name, 'check');
    await q(`UPDATE onboarding SET progress_at = now() WHERE driver_id = $1`, [d.id]);
    res.json({ ok: true });
  }));
  // earlier messages from a Telegram export (Telegram Desktop: Export chat history, JSON), parsed in the browser
  app.post('/api/tg/chats/:id/import', needUser, wrap(async (req, res) => {
    const chatId = String(req.params.id);
    const chat = (await q(`SELECT * FROM tg_chats WHERE chat_id = $1`, [chatId])).rows[0]; if (!chat) return res.status(404).json({ error: 'Group not found' });
    if (chat.driver_id) { const d = await loadDriver(req, res, chat.driver_id); if (!d) return; } else if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can do this' });
    const b = req.body || {}; const msgs = Array.isArray(b.messages) ? b.messages.slice(0, 3000) : [];
    if (!msgs.length) return res.status(400).json({ error: 'No messages found in the file' });
    for (const p of (Array.isArray(b.people) ? b.people : []).slice(0, 50)) {
      const id = +p.tgId; if (!id || !['driver', 'staff', 'other'].includes(p.role)) continue;
      await q(`INSERT INTO tg_people (tg_id, name, role, driver_id, seen_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (tg_id) DO UPDATE SET name = coalesce(tg_people.name, $2), role = CASE WHEN tg_people.role IS NULL OR $3 <> 'other' THEN $3 ELSE tg_people.role END, driver_id = coalesce($4, tg_people.driver_id)`,
        [id, String(p.name || '').slice(0, 80), p.role === 'other' ? null : p.role, p.role === 'driver' ? chat.driver_id : null]);
    }
    let n = 0;
    for (const m of msgs) {
      const at = new Date(+m.date * 1000); if (isNaN(at) || !+m.id) continue;
      const text = m.text ? bot.redact(String(m.text)).slice(0, 4000) : null; if (!text && !m.media) continue;
      const r = await q(`INSERT INTO tg_messages (chat_id, msg_id, from_id, from_name, is_bot, text, media, reply_to, at, imported, digested) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, false) ON CONFLICT (chat_id, msg_id) DO NOTHING RETURNING id`,
        [chatId, +m.id, +m.fromId || null, String(m.from || '').slice(0, 80) || null, !!m.bot, text, m.media ? String(m.media).slice(0, 20) : null, +m.replyTo || null, at]);
      if (r.rows[0]) n++;
    }
    await lib.act(req.user, 'telegram', chat.driver_id ? { id: chat.driver_id } : null, `Imported ${n} earlier Telegram messages`);
    // read them now, batch after batch, in the background
    (async () => { const dg = require('./tg/digest'); for (let i = 0; i < 80; i++) { const out = await dg.digestChat(chatId).catch(() => null); if (!out) break; } })().catch(() => {});
    res.json({ ok: true, imported: n, skipped: msgs.length - n });
  }));
  // How close the bot is to running onboarding alone
  app.get('/api/tg/readiness', needUser, wrap(async (req, res) => {
    const st = (await q(`SELECT state, count(*)::int n FROM onb_ai_steps WHERE at > now() - interval '60 days' GROUP BY state`)).rows; const c = (k) => (st.find((x) => x.state === k) || {}).n || 0;
    const judged = c('confirmed') + c('rejected') + c('undone'); const right = c('confirmed');
    const kn = (await q(`SELECT count(*) FILTER (WHERE active)::int approved, count(*) FILTER (WHERE review AND NOT active)::int waiting FROM tg_knowledge`)).rows[0];
    const qa = (await q(`SELECT count(*) FILTER (WHERE answered_by = 'Bot')::int bot, count(*)::int total FROM tg_questions WHERE asked_at > now() - interval '30 days'`)).rows[0];
    const modes = (await q(`SELECT o.mode, count(*)::int n FROM onb_cases o JOIN drivers d ON d.id = o.driver_id WHERE d.status <> 'Hired' AND d.left_on IS NULL GROUP BY 1`)).rows;
    const stepAcc = judged ? right / judged : null; const botShare = qa.total ? qa.bot / qa.total : null;
    const ready = judged >= 15 && stepAcc >= 0.9 && qa.total >= 20 && botShare >= 0.7;
    res.json({ steps: { confirmed: right, rejected: c('rejected') + c('undone'), auto: c('auto'), waiting: c('suggested'), accuracy: stepAcc }, knowledge: kn, questions: { byBot: qa.bot, total: qa.total, share: botShare },
      modes: Object.fromEntries(modes.map((m) => [m.mode, m.n])), ready, settings: { onbMode: (db.settings.tg || {}).onbMode || 'watch', autoTick: !!(db.settings.tg || {}).autoTick } });
  }));
  app.put('/api/tg/autopilot', needUser, needAdmin, wrap(async (req, res) => {
    const b = req.body || {}; const v = { ...(db.settings.tg || {}) };
    if (b.teamReportAt !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.teamReportAt))) return res.status(400).json({ error: 'A time like 09:00' }); v.teamReportAt = b.teamReportAt; }
    if (b.teamReport !== undefined) v.teamReport = !!b.teamReport;
    if (b.eldAuto !== undefined) v.eldAuto = !!b.eldAuto; // new ELD groups run the setup by themselves (off: silent, /info on request)
    if (b.acctAuto !== undefined) v.acctAuto = !!b.acctAuto;
    if (b.teamFollowups !== undefined) v.teamFollowups = !!b.teamFollowups;
    if (b.workMode !== undefined) { if (!['watch', 'updater'].includes(b.workMode)) return res.status(400).json({ error: 'Pick watch or updater' }); v.workMode = b.workMode; }
    if (b.onbMode !== undefined) { if (!['watch', 'assist', 'run'].includes(b.onbMode)) return res.status(400).json({ error: 'Pick watch, assist or run' }); v.onbMode = b.onbMode; }
    if (b.autoTick !== undefined) v.autoTick = !!b.autoTick;
    await db.saveSetting('tg', v);
    await lib.act(req.user, 'admin', null, `${b.workMode !== undefined ? `Working drivers' groups start in "${v.workMode}". ` : ''}Onboarding bot: new groups start in "${v.onbMode}"${v.autoTick ? ', the AI ticks steps itself' : ''}`);
    res.json({ ok: true, ...v });
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
