// A truck's own profile: who drove it and for which company, every shop visit and oil change, mileage, costs.
const db = require('./db');
const lib = require('./lib');
const fl = require('./fleet');
const { q } = db;
const { wrap, needUser, needAdmin, act, canSee } = lib;

const KINDS = ['oil_change', 'maintenance', 'repair', 'tires', 'inspection', 'breakdown', 'damage', 'warning_light', 'other'];
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s));
const num = (v) => (v === undefined || v === null || v === '' || isNaN(+v) ? null : +v);
const evOut = (e) => ({ id: e.id, kind: e.kind, title: e.title, details: e.details, status: e.status, odometer: e.odometer, cost: e.cost === null ? null : +e.cost, shop: e.shop,
  paid: e.paid, paidAt: e.paid_at, doneOn: e.done_on, source: e.source, addedBy: e.added_by, at: e.at, fixedAt: e.fixed_at, driver: e.driver || null, chatId: e.chat_id ? String(e.chat_id) : null });
const canEdit = (u) => ['admin', 'dispatcher', 'member'].includes(u.role);

module.exports = (app) => {
  app.get('/api/fleet/settings', needUser, (req, res) => res.json(fl.fleet()));
  app.put('/api/fleet/settings', needUser, wrap(async (req, res) => {
    if (!['admin', 'dispatcher'].includes(req.user.role)) return res.status(403).json({ error: 'Only an admin or a dispatcher can change this' });
    const b = req.body || {}; const cur = fl.fleet(); const v = { ...cur };
    for (const [k, lo, hi] of [['oilMiles', 1000, 200000], ['oilDays', 7, 730], ['warnMiles', 0, 50000], ['warnDays', 0, 120]]) {
      if (b[k] === undefined) continue; const n = Math.round(+b[k]);
      if (!(n >= lo && n <= hi)) return res.status(400).json({ error: `${{ oilMiles: 'Miles between oil changes', oilDays: 'Days between oil changes', warnMiles: 'Warning miles', warnDays: 'Warning days' }[k]}: ${lo.toLocaleString('en-US')} to ${hi.toLocaleString('en-US')}` });
      v[k] = n;
    }
    if (b.askDriver !== undefined) v.askDriver = !!b.askDriver;
    await db.saveSetting('fleet', v);
    await act(req.user, 'truck', null, `Oil changes: every ${v.oilMiles.toLocaleString('en-US')} miles or ${v.oilDays} days`);
    res.json(v);
  }));
  app.get('/api/fleet/dispatchers', needUser, wrap(async (req, res) => res.json({ people: (await q(`SELECT id, name, role FROM users WHERE active AND role IN ('dispatcher', 'admin') ORDER BY role = 'admin', lower(name)`)).rows })));

  // the profile
  app.get('/api/trucks/:id', needUser, wrap(async (req, res) => {
    const t = (await q(`SELECT t.*, d.name d_name, d.status d_status, d.owner_id d_owner, c.name company, u.name dispatcher FROM trucks t LEFT JOIN drivers d ON d.id = t.driver_id
      LEFT JOIN companies c ON c.id = t.company_id LEFT JOIN users u ON u.id = t.dispatcher_id WHERE t.id = $1`, [+req.params.id || 0])).rows[0];
    if (!t) return res.status(404).json({ error: 'Truck not found' });
    const ev = (await q(`SELECT e.*, e.done_on::text done_on, d.name driver FROM truck_events e LEFT JOIN drivers d ON d.id = e.driver_id WHERE e.truck_id = $1 ORDER BY coalesce(e.done_on, (coalesce(e.fixed_at, e.at) AT TIME ZONE $2)::date) DESC, e.at DESC LIMIT 500`, [t.id, db.settings.tz])).rows;
    const hist = (await q(`SELECT * FROM truck_history WHERE truck_id = $1 ORDER BY at DESC, id DESC LIMIT 300`, [t.id])).rows;
    const last = (await fl.lastOils([t.id]))[t.id];
    const group = t.driver_id ? (await q(`SELECT chat_id::text id FROM tg_chats WHERE driver_id = $1 AND kind = 'dispatch'`, [t.driver_id])).rows[0] : null;
    res.json({
      truck: { id: t.id, unit: t.unit, details: t.details, location: t.location, notes: t.notes, vin: t.vin, plate: t.plate, outOfService: t.out_of_service, companyId: t.company_id, company: t.company,
        dispatcherId: t.dispatcher_id, dispatcher: t.dispatcher, oilMiles: t.oil_miles, oilDays: t.oil_days, driverName: t.driver_name, createdAt: t.created_at,
        driver: t.driver_id ? { id: canSee(req.user, { owner_id: t.d_owner }) ? t.driver_id : null, name: t.d_name, status: t.d_status, group: group ? group.id : null } : null },
      oil: fl.oilStatus(t, last), costs: await fl.costs(t.id), events: ev.map(evOut),
      history: hist.map((h) => ({ kind: h.kind, from: h.from_text, to: h.to_text, fromId: h.from_id, toId: h.to_id, at: h.at })),
      fleet: fl.fleet(), canEdit: canEdit(req.user)
    });
  }));
  app.post('/api/trucks/:id/miles', needUser, wrap(async (req, res) => {
    const t = (await q(`SELECT * FROM trucks WHERE id = $1`, [+req.params.id || 0])).rows[0]; if (!t) return res.status(404).json({ error: 'Truck not found' });
    const m = Math.round(+(req.body || {}).odometer);
    if (!(m > 0 && m < 5000000)) return res.status(400).json({ error: 'Enter the mileage, like 412500' });
    if (t.odometer && m < t.odometer && !(req.body || {}).fix) return res.status(400).json({ error: `That is less than the ${t.odometer.toLocaleString('en-US')} miles on record. Tick "correct the mileage" to set it lower.` });
    await q(`UPDATE trucks SET odometer = $2, odometer_at = now() WHERE id = $1`, [t.id, m]);
    await act(req.user, 'truck', null, `Truck ${t.unit}: ${m.toLocaleString('en-US')} miles`);
    res.json({ ok: true });
  }));

  // issues and service
  app.get('/api/trucks/:id/events', needUser, wrap(async (req, res) => {
    const r = (await q(`SELECT e.*, e.done_on::text done_on, d.name driver FROM truck_events e LEFT JOIN drivers d ON d.id = e.driver_id WHERE e.truck_id = $1 ORDER BY (e.status <> 'fixed') DESC, coalesce(e.done_on, (coalesce(e.fixed_at, e.at) AT TIME ZONE $2)::date) DESC, e.at DESC LIMIT 200`, [+req.params.id || 0, db.settings.tz])).rows;
    res.json({ events: r.map(evOut) });
  }));
  const evFields = (b, set = {}) => {
    if (b.title !== undefined) set.title = String(b.title || '').trim().slice(0, 120);
    if (b.kind !== undefined) set.kind = KINDS.includes(b.kind) ? b.kind : 'other';
    if (b.details !== undefined) set.details = String(b.details || '').trim().slice(0, 800) || null;
    if (b.shop !== undefined) set.shop = String(b.shop || '').trim().slice(0, 120) || null;
    if (b.odometer !== undefined) { const n = num(b.odometer); set.odometer = n !== null && n > 0 && n < 5000000 ? Math.round(n) : null; }
    if (b.cost !== undefined) { const n = num(b.cost); set.cost = n !== null && n >= 0 && n < 1000000 ? Math.round(n * 100) / 100 : null; }
    if (b.paid !== undefined) set.paid = b.paid === null || b.paid === '' ? null : b.paid === true || b.paid === 'true' || b.paid === 'yes';
    if (b.doneOn !== undefined) set.done_on = isDay(b.doneOn) ? b.doneOn : null;
    if (b.status !== undefined && ['open', 'scheduled', 'fixed'].includes(b.status)) set.status = b.status;
    return set;
  };
  app.post('/api/trucks/:id/events', needUser, wrap(async (req, res) => {
    const t = (await q(`SELECT * FROM trucks WHERE id = $1`, [+req.params.id || 0])).rows[0]; if (!t) return res.status(404).json({ error: 'Truck not found' });
    const b = req.body || {}; const set = evFields({ status: 'open', kind: 'other', ...b });
    if (!set.title) set.title = set.kind === 'oil_change' ? 'Oil change' : '';
    if (!set.title) return res.status(400).json({ error: 'What was done, or what is wrong?' });
    if (set.done_on && set.done_on > new Date().toLocaleDateString('en-CA', { timeZone: db.settings.tz }) && set.status === 'fixed') return res.status(400).json({ error: 'A day in the future cannot be done yet. Choose Scheduled.' });
    const cols = ['truck_id', 'driver_id', 'source', 'added_by', ...Object.keys(set)];
    const vals = [t.id, t.driver_id, 'manual', req.user.name, ...Object.values(set)];
    if (set.status === 'fixed') { cols.push('fixed_at'); vals.push(new Date()); }
    if (set.paid) { cols.push('paid_at'); vals.push(new Date()); }
    const r = await q(`INSERT INTO truck_events (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, vals);
    if (set.odometer) await fl.setOdometer(t.id, set.odometer, set.done_on ? new Date(set.done_on + 'T12:00:00Z') : new Date());
    await act(req.user, 'truck', null, `Truck ${t.unit}: ${set.title}${set.status === 'fixed' ? ' (done)' : set.status === 'scheduled' ? ' (scheduled)' : ''}${set.cost !== undefined && set.cost !== null ? `, $${set.cost.toLocaleString('en-US')}` : ''}`);
    res.json({ ok: true, id: r.rows[0].id });
  }));
  app.patch('/api/truck-events/:id', needUser, wrap(async (req, res) => {
    const e = (await q(`SELECT e.*, t.unit FROM truck_events e LEFT JOIN trucks t ON t.id = e.truck_id WHERE e.id = $1`, [+req.params.id || 0])).rows[0];
    if (!e) return res.status(404).json({ error: 'Not found' });
    const set = evFields(req.body || {});
    if (set.title === '') return res.status(400).json({ error: 'What was done, or what is wrong?' });
    if (set.status !== undefined) set.fixed_at = set.status === 'fixed' ? (e.fixed_at || new Date()) : null;
    if (set.paid !== undefined) set.paid_at = set.paid ? (e.paid_at || new Date()) : null;
    const cols = Object.keys(set); if (!cols.length) return res.json({ ok: true });
    await q(`UPDATE truck_events SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [e.id, ...cols.map((k) => set[k])]);
    if (set.odometer && e.truck_id) await fl.setOdometer(e.truck_id, set.odometer);
    const what = set.status && set.status !== e.status ? (set.status === 'fixed' ? 'done' : set.status) : set.paid === true && !e.paid ? 'paid' : 'edited';
    await act(req.user, 'truck', null, `Truck ${e.unit || ''}: ${set.title || e.title} ${what}`);
    res.json({ ok: true });
  }));
  app.delete('/api/truck-events/:id', needUser, wrap(async (req, res) => {
    if (!['admin', 'dispatcher'].includes(req.user.role)) return res.status(403).json({ error: 'Only an admin or a dispatcher can delete this' });
    const e = (await q(`DELETE FROM truck_events e USING trucks t WHERE e.id = $1 AND t.id = e.truck_id RETURNING e.title, t.unit`, [+req.params.id || 0])).rows[0];
    if (e) await act(req.user, 'truck', null, `Truck ${e.unit}: deleted "${e.title}"`);
    res.json({ ok: true });
  }));
};
