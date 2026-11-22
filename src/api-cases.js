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
    const cases = (await q(`SELECT c.id, c.chat_id::text chat_id, c.driver_id, c.summary, c.opened_at, c.done, c.step_since, c.status, c.closed_at, c.closed_by, c.note, c.lesson, c.cost, c.city, c.state,
        (SELECT name FROM places WHERE id = c.place_id) shop, p.key pkey, p.id playbook_id, p.title, p.steps, p.rules, d.name driver, d.status driver_status, t.unit, u.name dispatcher,
        (SELECT json_build_object('id', x.id, 'text', x.draft) FROM tg_drafts x WHERE x.chat_id = c.chat_id AND x.state = 'open' AND x.kind = 'case' ORDER BY x.id DESC LIMIT 1) draft,
        (SELECT mode FROM tg_chats WHERE chat_id = c.chat_id) chat_mode
      FROM tg_cases c JOIN tg_playbooks p ON p.id = c.playbook_id LEFT JOIN drivers d ON d.id = c.driver_id LEFT JOIN LATERAL (SELECT unit, dispatcher_id FROM trucks WHERE driver_id = c.driver_id ORDER BY id LIMIT 1) t ON true LEFT JOIN users u ON u.id = t.dispatcher_id
      WHERE ${w.join(' AND ')} ORDER BY ${closed ? 'c.closed_at DESC' : 'c.opened_at'} LIMIT 100`, params)).rows;
    const next = require('./tg/cases').nextStep; const P = require('./places');
    for (const c of cases) c.nearby = c.status === 'open' ? await P.nearby(c.state, c.pkey) : [];
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
    const cost = +b.cost > 0 ? +b.cost : null; const pid = +b.placeId || null;
    await q(`UPDATE tg_cases SET status = $2, closed_at = now(), closed_by = $3, note = coalesce($4, note), cost = coalesce($5, cost), place_id = coalesce($6, place_id) WHERE id = $1`, [c.id, st, req.user.name, b.note ? String(b.note).slice(0, 500) : null, cost, pid]);
    if (pid && st === 'resolved') { await q(`UPDATE places SET uses = uses + 1, last_used_at = now(), last_cost = coalesce($2, last_cost), good = good + $3, bad = bad + $4 WHERE id = $1`, [pid, cost, b.rate === 'good' ? 1 : 0, b.rate === 'bad' ? 1 : 0]);
      await q(`INSERT INTO place_events (place_id, driver_id, chat_id, what, outcome, cost, by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [pid, c.driver_id, c.chat_id, c.title, b.rate || null, cost, req.user.name]); }
    await q(`UPDATE tg_drafts SET state = 'dismissed', decided_at = now() WHERE chat_id = $1 AND state = 'open' AND kind = 'case'`, [c.chat_id]);
    await require('./tg/bot').log('case', `Case "${c.title}" ${st === 'dismissed' ? 'was not a case' : 'resolved'} (${req.user.name})`, { chatId: c.chat_id, driverId: c.driver_id, who: req.user.name });
    if (b.lesson && String(b.lesson).trim()) await require('./kb').add({ kind: 'dispatch', topic: 'breakdowns', question: `Case: ${c.title}`, answer: String(b.lesson).slice(0, 1000), by: req.user.name, chatId: c.chat_id });
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

  // case times and costs: per kind of case, per driver, per truck, per dispatcher (last 30 or 90 days)
  app.get('/api/cases/stats', needUser, wrap(async (req, res) => {
    const days = req.query.days === '90' ? 90 : 30;
    const base = `FROM tg_cases c JOIN tg_playbooks p ON p.id = c.playbook_id LEFT JOIN drivers d ON d.id = c.driver_id LEFT JOIN LATERAL (SELECT unit, dispatcher_id FROM trucks WHERE driver_id = c.driver_id ORDER BY id LIMIT 1) t ON true
      LEFT JOIN users u ON u.id = t.dispatcher_id WHERE c.opened_at > now() - ($1 || ' days')::interval AND c.status NOT IN ('dismissed', 'old')`;
    const agg = `count(*)::int cases, count(*) FILTER (WHERE c.status = 'open')::int open, round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM c.closed_at - c.opened_at) / 3600) FILTER (WHERE c.status = 'resolved'))::numeric, 1) hours,
      coalesce(sum(c.cost), 0)::numeric cost, count(c.cost)::int priced`;
    const by = async (key, label) => (await q(`SELECT ${key} k, ${label} label, ${agg} ${base} GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 20`, [String(days)])).rows;
    res.json({ days, kinds: await by('p.id', 'p.title'), drivers: await by('d.id', 'd.name'), trucks: await by('t.unit', 't.unit'), dispatchers: await by('u.id', `coalesce(u.name, 'No dispatcher')`),
      places: (await q(`SELECT pl.id k, pl.name label, count(*)::int cases, coalesce(sum(c.cost), 0)::numeric cost FROM tg_cases c JOIN places pl ON pl.id = c.place_id WHERE c.opened_at > now() - ($1 || ' days')::interval GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15`, [String(days)])).rows });
  }));
  // Home time planner: who is home and comes back when, who is going home, whose weeks out are nearly up
  app.get('/api/hometime', needUser, wrap(async (req, res) => res.json(await require('./hometime').planner())));
  app.post('/api/hometime', needUser, wrap(async (req, res) => {
    const b = req.body || {}; const d = (await q(`SELECT id FROM drivers WHERE id = $1`, [+b.driverId || 0])).rows[0]; if (!d) return res.status(400).json({ error: 'Pick the driver' });
    const ok = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null);
    const cur = (await q(`SELECT id FROM home_time WHERE driver_id = $1 AND status IN ('planned', 'home') ORDER BY id DESC LIMIT 1`, [d.id])).rows[0];
    if (b.status === 'back') {
      if (cur) await q(`UPDATE home_time SET status = 'back', updated_at = now() WHERE id = $1`, [cur.id]);
      await q(`UPDATE drivers SET out_since = (now() AT TIME ZONE $2)::date, updated_at = now() WHERE id = $1`, [d.id, db.settings.tz]);
      await lib.history(d.id, 'Back on the road after home time', req.user.name, 'web').catch(() => {});
      return res.json({ ok: true });
    }
    const st = b.status === 'home' ? 'home' : b.status === 'cancelled' ? 'cancelled' : 'planned';
    if (cur) await q(`UPDATE home_time SET status = $2, leave_on = coalesce($3, leave_on), back_on = $4, needs_ticket = $5, confirmed_at = CASE WHEN $6 THEN now() ELSE confirmed_at END, confirm_asked_at = CASE WHEN $6 THEN coalesce(confirm_asked_at, now()) ELSE confirm_asked_at END, updated_at = now() WHERE id = $1`,
      [cur.id, st, ok(b.leaveOn), ok(b.backOn), b.needsTicket === true, !!b.confirmed]);
    else await q(`INSERT INTO home_time (driver_id, status, leave_on, back_on, needs_ticket, confirmed_at) VALUES ($1, $2, $3, $4, $5, $6)`, [d.id, st, ok(b.leaveOn), ok(b.backOn), b.needsTicket === true, b.confirmed ? new Date() : null]);
    await lib.history(d.id, `Home time: ${st === 'home' ? 'at home' : st === 'cancelled' ? 'called off' : 'planned'}${ok(b.backOn) ? ', back ' + require('./hometime').nice(b.backOn) : ''}`, req.user.name, 'web').catch(() => {});
    res.json({ ok: true });
  }));
  // Orientation day: tick a step (dispatchers too)
  app.post('/api/orientation/:driverId/:key', needUser, wrap(async (req, res) => {
    const d = (await q(`SELECT id, owner_id FROM drivers WHERE id = $1`, [+req.params.driverId || 0])).rows[0]; if (!d) return res.status(404).json({ error: 'Driver not found' });
    if (req.user.role !== 'dispatcher' && !(await lib.loadDriver(req, res, d.id))) return;
    await require('./orientation').ensure(d.id);
    await require('./orientation').tick(d.id, req.params.key, (req.body || {}).done !== false, req.user.name);
    res.json({ ok: true, orientation: await require('./orientation').list(d.id) });
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
