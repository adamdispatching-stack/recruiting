// Shops & services on the website: the list (filter by kind, state, words), add, edit, mark trusted, hide; and what
// happened each time we used one.
const db = require('./db');
const lib = require('./lib');
const P = require('./places');
const { q } = db;
const { wrap, needUser } = lib;

module.exports = (app) => {
  app.get('/api/places', needUser, wrap(async (req, res) => {
    const rows = (await q(`SELECT p.*, (SELECT count(*)::int FROM tg_cases c WHERE c.place_id = p.id) cases FROM places p WHERE ${req.query.hidden ? 'hidden' : 'NOT hidden'} ORDER BY p.state NULLS LAST, p.verified DESC, (p.good - p.bad) DESC, p.uses DESC, p.name`)).rows;
    res.json({ places: rows, kinds: P.KINDS, states: P.STATES });
  }));
  app.get('/api/places/:id/events', needUser, wrap(async (req, res) => res.json({ events: (await q(`SELECT e.at, e.what, e.outcome, e.cost, e.by, d.name driver FROM place_events e LEFT JOIN drivers d ON d.id = e.driver_id WHERE e.place_id = $1 ORDER BY e.at DESC LIMIT 50`, [+req.params.id || 0])).rows })));
  const clean = (b) => ({ name: String(b.name || '').trim().slice(0, 120), kind: P.KINDS[b.kind] ? b.kind : 'other', services: String(b.services || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 15),
    phone: P.digits(b.phone) ? P.fmt(P.digits(b.phone)) : (String(b.phone || '').trim().slice(0, 30) || null), address: String(b.address || '').trim().slice(0, 200) || null, city: String(b.city || '').trim().slice(0, 60) || null,
    state: P.st(b.state), area: String(b.area || '').trim().slice(0, 60) || null, notes: String(b.notes || '').trim().slice(0, 500) || null });
  app.post('/api/places', needUser, wrap(async (req, res) => {
    const x = clean(req.body || {}); if (!x.name) return res.status(400).json({ error: 'Give it a name' });
    const id = (await q(`INSERT INTO places (name, kind, services, phone, address, city, state, area, notes, source, verified) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'team', true) RETURNING id`, [x.name, x.kind, x.services, x.phone, x.address, x.city, x.state, x.area, x.notes])).rows[0].id;
    res.json({ ok: true, id });
  }));
  app.put('/api/places/:id', needUser, wrap(async (req, res) => {
    const b = req.body || {}; const id = +req.params.id || 0;
    if (Object.keys(b).every((k) => ['verified', 'hidden', 'rate'].includes(k))) {
      if (b.verified !== undefined) await q(`UPDATE places SET verified = $2, updated_at = now() WHERE id = $1`, [id, !!b.verified]);
      if (b.hidden !== undefined) await q(`UPDATE places SET hidden = $2, updated_at = now() WHERE id = $1`, [id, !!b.hidden]);
      if (b.rate === 'good' || b.rate === 'bad') { await q(`UPDATE places SET ${b.rate} = ${b.rate} + 1, updated_at = now() WHERE id = $1`, [id]); await q(`INSERT INTO place_events (place_id, outcome, by) VALUES ($1, $2, $3)`, [id, b.rate, req.user.name]); }
      return res.json({ ok: true });
    }
    const x = clean(b); if (!x.name) return res.status(400).json({ error: 'Give it a name' });
    await q(`UPDATE places SET name = $2, kind = $3, services = $4, phone = $5, address = $6, city = $7, state = $8, area = $9, notes = $10, updated_at = now() WHERE id = $1`, [id, x.name, x.kind, x.services, x.phone, x.address, x.city, x.state, x.area, x.notes]);
    res.json({ ok: true });
  }));
};
