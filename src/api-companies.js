// Companies: the carriers drivers are dispatched for. Each has its own trucks; each driver works for one company.
const db = require('./db');
const lib = require('./lib');
const { q } = db;
const { wrap, needUser, needAdmin, act, canSee } = lib;

const COLORS = 8; // tag colors on screen; the name is always shown with it

function fields(b) {
  const set = {};
  if (b.name !== undefined) set.name = String(b.name || '').trim().slice(0, 80);
  for (const k of ['mc', 'dot']) if (b[k] !== undefined) set[k] = String(b[k] || '').replace(/[^0-9A-Za-z-]/g, '').slice(0, 20) || null;
  if (b.notes !== undefined) set.notes = String(b.notes || '').trim().slice(0, 1000) || null;
  if (b.color !== undefined) set.color = Math.max(0, Math.min(COLORS - 1, parseInt(b.color, 10) || 0));
  return set;
}
const out = (c) => ({ id: c.id, name: c.name, mc: c.mc, dot: c.dot, notes: c.notes, color: c.color });

module.exports = (app) => {
  // every company with its numbers: trucks (empty, with a driver, out of service) and drivers (onboarding, hired)
  app.get('/api/companies', needUser, wrap(async (req, res) => {
    const r = await q(`SELECT c.*,
        (SELECT count(*) FROM trucks t WHERE t.company_id = c.id)::int trucks,
        (SELECT count(*) FROM trucks t WHERE t.company_id = c.id AND NOT t.out_of_service AND t.driver_id IS NULL AND t.driver_name IS NULL)::int empty,
        (SELECT count(*) FROM trucks t WHERE t.company_id = c.id AND NOT t.out_of_service AND (t.driver_id IS NOT NULL OR t.driver_name IS NOT NULL))::int with_driver,
        (SELECT count(*) FROM trucks t WHERE t.company_id = c.id AND t.out_of_service)::int out_of_service,
        (SELECT count(*) FROM drivers d WHERE d.company_id = c.id AND d.status = 'Onboarding')::int onboarding,
        (SELECT count(*) FROM drivers d WHERE d.company_id = c.id AND d.status = 'Hired')::int hired,
        (SELECT count(*) FROM drivers d WHERE d.company_id = c.id AND d.status = ANY($1::text[]))::int in_progress
      FROM companies c ORDER BY lower(c.name)`, [db.ACTIVE]);
    const loose = (await q(`SELECT (SELECT count(*) FROM trucks WHERE company_id IS NULL)::int trucks, (SELECT count(*) FROM drivers WHERE company_id IS NULL AND status IN ('Onboarding', 'Hired'))::int drivers`)).rows[0];
    res.json({ companies: r.rows.map((c) => ({ ...out(c), trucks: c.trucks, empty: c.empty, withDriver: c.with_driver, outOfService: c.out_of_service, onboarding: c.onboarding, hired: c.hired, inProgress: c.in_progress })), unassigned: loose });
  }));

  // one company: its trucks and its drivers
  app.get('/api/companies/:id', needUser, wrap(async (req, res) => {
    const c = (await q(`SELECT * FROM companies WHERE id = $1`, [+req.params.id || 0])).rows[0];
    if (!c) return res.status(404).json({ error: 'Company not found' });
    const trucks = await q(`SELECT t.*, d.name d_name, d.status d_status, d.owner_id d_owner FROM trucks t LEFT JOIN drivers d ON d.id = t.driver_id WHERE t.company_id = $1 ORDER BY length(t.unit), t.unit`, [c.id]);
    const drivers = await q(`SELECT d.id, d.name, d.status, d.mode, d.owner_id, d.phones, d.truck_year, d.truck_model, t.unit truck_unit, o.expected_arrival, o.arrived_on, o.completed_at
      FROM drivers d LEFT JOIN trucks t ON t.driver_id = d.id LEFT JOIN onboarding o ON o.driver_id = d.id WHERE d.company_id = $1
      ORDER BY array_position(ARRAY['Hired', 'Onboarding']::text[], d.status) NULLS LAST, lower(d.name)`, [c.id]);
    res.json({ company: out(c),
      trucks: trucks.rows.map((t) => ({ id: t.id, unit: t.unit, details: t.details, location: t.location, notes: t.notes, outOfService: t.out_of_service, driverName: t.driver_name, companyId: t.company_id,
        driver: t.driver_id ? { id: canSee(req.user, { owner_id: t.d_owner }) ? t.driver_id : null, name: t.d_name, status: t.d_status } : null,
        state: t.out_of_service ? 'out' : t.driver_id || t.driver_name ? 'assigned' : 'empty' })),
      drivers: drivers.rows.map((d) => ({ id: canSee(req.user, d) ? d.id : null, name: d.name, status: d.status, mode: d.mode, ownerId: d.owner_id, phone: (d.phones || [])[0] || null,
        truck: d.truck_unit, ownTruck: [d.truck_year, d.truck_model].filter(Boolean).join(' ') || null, expectedArrival: d.expected_arrival, arrivedOn: d.arrived_on, hiredAt: d.completed_at })) });
  }));

  app.post('/api/companies', needUser, needAdmin, wrap(async (req, res) => {
    const set = fields(req.body || {});
    if (!set.name) return res.status(400).json({ error: 'The company name is required' });
    if (set.color === undefined) set.color = (await q(`SELECT count(*)::int n FROM companies`)).rows[0].n % COLORS; // a different color for each new company
    const cols = Object.keys(set);
    try {
      const r = await q(`INSERT INTO companies (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, cols.map((k) => set[k]));
      await act(req.user, 'admin', null, `Added the company ${set.name}`);
      res.json({ id: r.rows[0].id });
    } catch (e) { if (e.code === '23505') return res.status(400).json({ error: `${set.name} is already in the list` }); throw e; }
  }));
  app.patch('/api/companies/:id', needUser, needAdmin, wrap(async (req, res) => {
    const c = (await q(`SELECT * FROM companies WHERE id = $1`, [+req.params.id || 0])).rows[0];
    if (!c) return res.status(404).json({ error: 'Company not found' });
    const set = fields(req.body || {});
    if (set.name === '') return res.status(400).json({ error: 'The company name is required' });
    const cols = Object.keys(set); if (!cols.length) return res.json({ ok: true });
    try { await q(`UPDATE companies SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [c.id, ...cols.map((k) => set[k])]); }
    catch (e) { if (e.code === '23505') return res.status(400).json({ error: `${set.name} is already in the list` }); throw e; }
    await act(req.user, 'admin', null, `Edited the company ${set.name || c.name}`);
    res.json({ ok: true });
  }));
  // Removing a company keeps its trucks and drivers; they just have no company afterwards.
  app.delete('/api/companies/:id', needUser, needAdmin, wrap(async (req, res) => {
    const c = (await q(`DELETE FROM companies WHERE id = $1 RETURNING *`, [+req.params.id || 0])).rows[0];
    if (!c) return res.status(404).json({ error: 'Company not found' });
    await act(req.user, 'admin', null, `Removed the company ${c.name}`);
    res.json({ ok: true });
  }));
};
