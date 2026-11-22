// The knowledge base on the website: everything the team knows, by topic, with search across the knowledge base, the
// team's words, shops & services and road case playbooks. Recruiters and admins approve, edit, merge; dispatchers read.
const db = require('./db');
const lib = require('./lib');
const kb = require('./kb');
const { q } = db;
const { wrap, needUser, needAdmin } = lib;

const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const mayEdit = (req, res) => { if (req.user.role === 'dispatcher') { res.status(403).json({ error: 'Only recruiters and admins change the knowledge base' }); return false; } return true; };

module.exports = (app) => {
  app.get('/api/kb', needUser, wrap(async (req, res) => {
    const reader = req.user.role === 'dispatcher';
    const rows = (await q(`SELECT k.id, k.kind, k.topic, k.question, k.answer, k.source, k.added_by, k.approved_by, k.uses, k.seen, k.active, k.review, k.variants, k.conflict_note,
        k.place_key, k.city, k.state, k.created_at, coalesce(k.last_seen, k.created_at) last_seen, k.updated_at, k.locked, k.tidied,
        (SELECT array_agg(DISTINCT coalesce(d.name, c.title)) FROM tg_chats c LEFT JOIN drivers d ON d.id = c.driver_id WHERE c.chat_id = ANY(k.chats)) groups,
        cardinality(k.chats) ngroups
      FROM tg_knowledge k ${reader ? 'WHERE k.active' : ''} ORDER BY k.active DESC, k.seen DESC, k.id DESC LIMIT 3000`)).rows;
    const more = (await q(`SELECT (SELECT count(*)::int FROM tg_terms WHERE active) terms, (SELECT count(*)::int FROM places WHERE NOT hidden) places, (SELECT count(*)::int FROM tg_playbooks WHERE active) playbooks`)).rows[0];
    res.json({ entries: rows, topics: kb.TOPICS, kinds: kb.KINDS, auto: (db.settings.tg || {}).kbAuto !== false, autoGroups: kb.AUTO_GROUPS, more,
      untidied: reader ? 0 : rows.filter((r) => r.tidied === false).length, canEdit: !reader, admin: req.user.role === 'admin' });
  }));
  app.get('/api/kb/search', needUser, wrap(async (req, res) => {
    res.json({ results: await kb.search(clean(req.query.q, 200), { all: req.user.role !== 'dispatcher' }) });
  }));
  app.post('/api/kb', needUser, wrap(async (req, res) => {
    if (!mayEdit(req, res)) return;
    const b = req.body || {}; const kind = kb.KINDS[b.kind] ? b.kind : 'general';
    const question = clean(b.question, 600), answer = clean(b.answer, 1500);
    if (!question || !answer) return res.status(400).json({ error: kind === 'site' ? 'Write the place and the fact' : kind === 'dispatch' ? 'Write the situation and what to do' : 'Write the question and the answer' });
    const r = await q(`INSERT INTO tg_knowledge (question, answer, source, added_by, kind, topic, active, review, place_key, city, state, tidied, locked, last_seen)
      VALUES ($1, $2, 'added', $3, $4, $5, true, false, $6, $7, $8, false, true, now()) RETURNING id`,
    [question, answer, req.user.name, kind, kb.TOPICS[b.topic] ? b.topic : kb.guess(question + ' ' + answer, kind), kind === 'site' ? kb.placeKey(question) : null, clean(b.city, 60) || null, /^[A-Za-z]{2}$/.test(b.state || '') ? b.state.toUpperCase() : null]);
    res.json({ id: r.rows[0].id });
  }));
  app.patch('/api/kb/:id', needUser, wrap(async (req, res) => {
    if (!mayEdit(req, res)) return;
    const id = +req.params.id || 0; const b = req.body || {};
    const k = (await q(`SELECT * FROM tg_knowledge WHERE id = $1`, [id])).rows[0]; if (!k) return res.status(404).json({ error: 'Not found' });
    const set = ['updated_at = now()']; const vals = [id];
    const put = (sql, v) => { vals.push(v); set.push(sql.replace('?', '$' + vals.length)); };
    if (b.question !== undefined) { const v = clean(b.question, 600); if (!v) return res.status(400).json({ error: 'Write the question' }); put('question = ?', v); set.push('locked = true'); if (k.kind === 'site') put('place_key = ?', kb.placeKey(v)); }
    if (b.answer !== undefined) { const v = clean(b.answer, 1500); if (!v) return res.status(400).json({ error: 'Write the answer' }); put('answer = ?', v); set.push('locked = true'); }
    if (b.useVariant !== undefined) { // one of the other answers becomes the answer; the old one becomes the other answer
      const vs = Array.isArray(k.variants) ? [...k.variants] : []; const i = +b.useVariant; if (!vs[i]) return res.status(400).json({ error: 'No such answer' });
      const [v] = vs.splice(i, 1); vs.push({ answer: k.answer, by: k.added_by, at: String(k.created_at).slice(0, 10) });
      put('answer = ?', v.answer); put('variants = ?::jsonb', JSON.stringify(vs)); set.push('locked = true');
    }
    if (b.dropVariant !== undefined) { const vs = Array.isArray(k.variants) ? [...k.variants] : []; vs.splice(+b.dropVariant, 1); put('variants = ?::jsonb', JSON.stringify(vs)); }
    if (b.topic !== undefined && kb.TOPICS[b.topic]) put('topic = ?', b.topic);
    if (b.kind !== undefined && kb.KINDS[b.kind]) put('kind = ?', b.kind);
    if (b.resolved) set.push('conflict_note = NULL');
    if (b.active !== undefined) { put('active = ?', !!b.active); if (b.active) { set.push('review = false'); put('approved_by = ?', req.user.name); } }
    await q(`UPDATE tg_knowledge SET ${set.join(', ')} WHERE id = $1`, vals);
    res.json({ ok: true });
  }));
  // two entries that say the same thing: one stays (with both counts and groups), the other's answer is kept as another way it was said
  app.post('/api/kb/:id/merge', needUser, wrap(async (req, res) => {
    if (!mayEdit(req, res)) return;
    const id = +req.params.id || 0, into = +(req.body || {}).into || 0;
    if (!into || into === id) return res.status(400).json({ error: 'Pick the entry to merge it into' });
    const [a, t] = await Promise.all([id, into].map(async (x) => (await q(`SELECT * FROM tg_knowledge WHERE id = $1`, [x])).rows[0]));
    if (!a || !t) return res.status(404).json({ error: 'Not found' });
    const chats = [...new Set([...(t.chats || []), ...(a.chats || [])].map(String))];
    const variants = [...(t.variants || []), ...(a.variants || [])]; if (kb.sim(kb.toks(a.answer), kb.toks(t.answer)) < 0.6) variants.push({ answer: a.answer, by: a.added_by, at: String(a.created_at).slice(0, 10) });
    await q(`UPDATE tg_knowledge SET seen = seen + $2, uses = uses + $3, chats = $4::bigint[], variants = $5::jsonb, active = active OR $6, review = CASE WHEN active OR $6 THEN false ELSE review END, updated_at = now() WHERE id = $1`,
      [t.id, a.seen || 1, a.uses || 0, chats, JSON.stringify(variants.slice(-8)), a.active]);
    await q(`DELETE FROM tg_knowledge WHERE id = $1`, [a.id]);
    res.json({ ok: true });
  }));
  app.delete('/api/kb/:id', needUser, needAdmin, wrap(async (req, res) => { await q(`DELETE FROM tg_knowledge WHERE id = $1`, [+req.params.id || 0]); res.json({ ok: true }); }));
  app.put('/api/kb/settings', needUser, needAdmin, wrap(async (req, res) => {
    await db.saveSetting('tg', { ...db.settings.tg, kbAuto: !!(req.body || {}).auto });
    res.json({ ok: true });
  }));
  // tidy now (normally a few times a day by itself)
  app.post('/api/kb/tidy', needUser, needAdmin, wrap(async (req, res) => {
    if (!require('./tg/ai').on()) return res.status(400).json({ error: 'The AI is not connected' });
    try { res.json(await kb.tidy()); } catch (e) { res.status(502).json({ error: 'The AI could not tidy it: ' + e.message }); }
  }));
};
