// The case playbook on the website: open cases (what happened, the steps, what is next, the message for the driver),
// closed ones with what was learned, and the playbooks themselves (admins edit them).
const db = require('./db');
const lib = require('./lib');
const { q } = db;
const { wrap, needUser, needAdmin, visSql } = lib;

module.exports = (app) => {
  app.get('/api/cases', needUser, wrap(async (req, res) => {
    const params = []; const w = [];
    const closed = req.query.status === 'closed';
    w.push(closed ? `c.status IN ('resolved', 'stale', 'dismissed') AND c.closed_at > now() - interval '7 days'` : `c.status = 'open'`);
    if (req.query.driverId) { params.push(+req.query.driverId); w.push(`c.driver_id = $${params.length}`); }
    if (req.query.chatId) { params.push(String(req.query.chatId)); w.push(`c.chat_id = $${params.length}::bigint`); }
    if (req.user.role !== 'dispatcher') { const vis = visSql(req.user, params); if (vis) w.push(vis); }
    const cases = (await q(`SELECT c.id, c.chat_id::text chat_id, c.driver_id, c.summary, c.opened_at, c.done, c.step_since, c.status, c.closed_at, c.closed_by, c.note, c.lesson,
        p.id playbook_id, p.title, p.steps, p.rules, d.name driver, d.status driver_status, t.unit, u.name dispatcher,
        (SELECT json_build_object('id', x.id, 'text', x.draft) FROM tg_drafts x WHERE x.chat_id = c.chat_id AND x.state = 'open' AND x.kind = 'case' ORDER BY x.id DESC LIMIT 1) draft,
        (SELECT mode FROM tg_chats WHERE chat_id = c.chat_id) chat_mode
      FROM tg_cases c JOIN tg_playbooks p ON p.id = c.playbook_id LEFT JOIN drivers d ON d.id = c.driver_id LEFT JOIN LATERAL (SELECT unit, dispatcher_id FROM trucks WHERE driver_id = c.driver_id ORDER BY id LIMIT 1) t ON true LEFT JOIN users u ON u.id = t.dispatcher_id
      WHERE ${w.join(' AND ')} ORDER BY ${closed ? 'c.closed_at DESC' : 'c.opened_at'} LIMIT 100`, params)).rows;
    const next = require('./tg/cases').nextStep;
    res.json({ cases: cases.map((c) => { const n = next(c, c.steps || []); const s = n ? c.steps[n - 1] : null;
      return { ...c, next: n, waitMin: s ? s.wait : null, waiting: n ? Math.round((Date.now() - new Date(c.step_since || c.opened_at)) / 60000) : null }; }) });
  }));
  const loadCase = async (req, res) => {
    const c = (await q(`SELECT c.*, p.title, p.steps FROM tg_cases c JOIN tg_playbooks p ON p.id = c.playbook_id WHERE c.id = $1`, [+req.params.id || 0])).rows[0];
    if (!c) { res.status(404).json({ error: 'Case not found' }); return null; }
    if (req.user.role !== 'dispatcher' && c.driver_id && !(await lib.loadDriver(req, res, c.driver_id))) return null;
    return c;
  };
  // a person marks a step done (or undone); the next message for the driver is written (Watch) or sent (Updater)
  app.post('/api/cases/:id/step', needUser, wrap(async (req, res) => {
    const c = await loadCase(req, res); if (!c) return;
    const n = +(req.body || {}).step; if (!(n >= 1 && n <= c.steps.length)) return res.status(400).json({ error: 'No such step' });
    const C = require('./tg/cases');
    const was = C.nextStep(c, c.steps);
    const done = (req.body || {}).done === false ? (c.done || []).filter((x) => x !== n) : [...new Set([...(c.done || []), n])].sort((a, b) => a - b);
    const now = C.nextStep({ done }, c.steps);
    await q(`UPDATE tg_cases SET done = $2, last_at = now(), step_since = CASE WHEN $3 THEN now() ELSE step_since END, warned_step = CASE WHEN $3 THEN NULL ELSE warned_step END WHERE id = $1`, [c.id, done, now !== was]);
    await require('./tg/bot').log('case', `Case "${c.title}": step ${n} ${(req.body || {}).done === false ? 'not done' : 'done'} (${req.user.name})`, { chatId: c.chat_id, driverId: c.driver_id, who: req.user.name });
    if (now && now !== was && c.status === 'open') {
      const mode = ((await q(`SELECT mode FROM tg_chats WHERE chat_id = $1`, [c.chat_id])).rows[0] || {}).mode === 'updater' ? 'updater' : 'watch';
      const s = c.steps[now - 1]; if (s && s.driver) {
        if (mode === 'updater') await require('./tg/bot').send(c.chat_id, require('./tg/bot').esc(s.driver)).catch(() => {});
        else { await q(`UPDATE tg_drafts SET state = 'replaced', decided_at = now() WHERE chat_id = $1 AND state = 'open' AND kind = 'case'`, [c.chat_id]);
          await q(`INSERT INTO tg_drafts (chat_id, driver_id, driver_text, draft, kind) VALUES ($1, $2, $3, $4, 'case')`, [c.chat_id, c.driver_id, `${c.title}: step ${now}`, s.driver]); }
      }
    }
    res.json({ ok: true });
  }));
  app.post('/api/cases/:id/close', needUser, wrap(async (req, res) => {
    const c = await loadCase(req, res); if (!c) return;
    const b = req.body || {}; const st = b.notACase ? 'dismissed' : 'resolved';
    await q(`UPDATE tg_cases SET status = $2, closed_at = now(), closed_by = $3, note = coalesce($4, note) WHERE id = $1`, [c.id, st, req.user.name, b.note ? String(b.note).slice(0, 500) : null]);
    await q(`UPDATE tg_drafts SET state = 'dismissed', decided_at = now() WHERE chat_id = $1 AND state = 'open' AND kind = 'case'`, [c.chat_id]);
    await require('./tg/bot').log('case', `Case "${c.title}" ${st === 'dismissed' ? 'was not a case' : 'resolved'} (${req.user.name})`, { chatId: c.chat_id, driverId: c.driver_id, who: req.user.name });
    if (b.lesson && String(b.lesson).trim()) await q(`INSERT INTO tg_knowledge (question, answer, source, added_by, chat_id, kind, active, review) VALUES ($1, $2, 'conversation', $3, $4, 'dispatch', false, true)`,
      [`Case: ${c.title}`, String(b.lesson).slice(0, 1000), req.user.name, c.chat_id]);
    res.json({ ok: true });
  }));
  // the message for the driver: sent in the group by the bot (as written or changed), or not needed
  app.post('/api/cases/drafts/:id/:act', needUser, wrap(async (req, res) => {
    const dr = (await q(`SELECT * FROM tg_drafts WHERE id = $1 AND kind = 'case'`, [+req.params.id || 0])).rows[0];
    if (!dr || dr.state !== 'open') return res.status(400).json({ error: 'This message is no longer waiting' });
    if (req.params.act === 'send') {
      const text = String((req.body || {}).text || dr.draft).trim().slice(0, 1500); if (!text) return res.status(400).json({ error: 'Write the message first' });
      const bot = require('./tg/bot');
      try { await bot.send(dr.chat_id, bot.esc(text)); } catch (e) { return res.status(502).json({ error: 'Telegram did not take it: ' + e.message }); }
      await q(`UPDATE tg_drafts SET state = 'sent', sent_text = $2, sent_by = $3, decided_at = now() WHERE id = $1`, [dr.id, text, req.user.name]);
      await bot.log('reply', `${req.user.name} sent the case message: "${text.slice(0, 120)}"`, { chatId: dr.chat_id, driverId: dr.driver_id, who: req.user.name });
    } else await q(`UPDATE tg_drafts SET state = 'dismissed', sent_by = $2, decided_at = now() WHERE id = $1`, [dr.id, req.user.name]);
    res.json({ ok: true });
  }));

  // the playbooks: everyone reads them, admins change them
  app.get('/api/playbooks', needUser, wrap(async (req, res) => res.json({ playbooks: (await q(`SELECT p.*, (SELECT count(*)::int FROM tg_cases c WHERE c.playbook_id = p.id AND c.opened_at > now() - interval '30 days' AND c.status <> 'dismissed') cases30 FROM tg_playbooks p ORDER BY p.active DESC, p.id`)).rows })));
  const clean = (b) => {
    const title = String(b.title || '').trim().slice(0, 120), when = String(b.when || '').trim().slice(0, 600);
    const steps = (Array.isArray(b.steps) ? b.steps : []).map((s) => ({ text: String(s.text || '').trim().slice(0, 500), driver: String(s.driver || '').trim().slice(0, 500), wait: Math.max(0, Math.min(10080, Math.round(+s.wait || 0))) })).filter((s) => s.text).slice(0, 15);
    const rules = (Array.isArray(b.rules) ? b.rules : []).map((r) => String(r).trim().slice(0, 400)).filter(Boolean).slice(0, 15);
    return { title, when, steps, rules };
  };
  app.post('/api/playbooks', needUser, needAdmin, wrap(async (req, res) => {
    const x = clean(req.body || {}); if (!x.title || !x.when || !x.steps.length) return res.status(400).json({ error: 'Give it a name, when it applies, and at least one step' });
    const id = (await q(`INSERT INTO tg_playbooks (title, when_text, steps, rules, source, updated_by) VALUES ($1, $2, $3, $4, 'team', $5) RETURNING id`, [x.title, x.when, JSON.stringify(x.steps), JSON.stringify(x.rules), req.user.name])).rows[0].id;
    res.json({ ok: true, id });
  }));
  app.put('/api/playbooks/:id', needUser, needAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.active !== undefined && Object.keys(b).length === 1) { await q(`UPDATE tg_playbooks SET active = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [+req.params.id, !!b.active, req.user.name]); return res.json({ ok: true }); }
    const x = clean(b); if (!x.title || !x.when || !x.steps.length) return res.status(400).json({ error: 'Give it a name, when it applies, and at least one step' });
    await q(`UPDATE tg_playbooks SET title = $2, when_text = $3, steps = $4, rules = $5, updated_at = now(), updated_by = $6 WHERE id = $1`, [+req.params.id, x.title, x.when, JSON.stringify(x.steps), JSON.stringify(x.rules), req.user.name]);
    res.json({ ok: true });
  }));
};
