// Onboarding (per-driver checklist, arrival, truck) and the truck list.
const db = require('./db');
const lib = require('./lib');
const { q, token } = db;
const { wrap, needUser, needAdmin, act, record, loadDriver, visSql, canSee, isDate, niceDate } = lib;

const AUTO_HINT = { truck: 'This step ticks itself when a truck is chosen for the driver', arrival: 'This step ticks itself when the expected arrival date is set', arrived: 'This step ticks itself when the arrival date is filled in', amazon: 'This step ticks itself when the Amazon steps on the driver\'s page reach Verified' };
const truckOut = (t) => ({ id: t.id, unit: t.unit, details: t.details, location: t.location, companyId: t.company_id });

// Everything the driver page shows about onboarding, or null when it has not started.
async function onboardingOf(driverId) {
  const o = (await q(`SELECT o.*, u.name started_name FROM onboarding o LEFT JOIN users u ON u.id = o.started_by WHERE o.driver_id = $1`, [driverId])).rows[0];
  if (!o) return null;
  const items = await q(`SELECT c.*, u.name done_name FROM checklist c LEFT JOIN users u ON u.id = c.done_by WHERE c.driver_id = $1 ORDER BY c.position, c.id`, [driverId]);
  const truck = (await q(`SELECT * FROM trucks WHERE driver_id = $1`, [driverId])).rows[0];
  const free = await q(`SELECT * FROM trucks WHERE driver_id IS NULL AND driver_name IS NULL AND NOT out_of_service ORDER BY length(unit), unit`);
  return { startedAt: o.started_at, startedBy: o.started_name, expectedArrival: o.expected_arrival, arrivalNote: o.arrival_note, arrivedOn: o.arrived_on, telegramLink: o.telegram_link, completedAt: o.completed_at,
    truck: truck ? truckOut(truck) : null, freeTrucks: free.rows.map(truckOut),
    items: items.rows.map((c) => ({ id: c.id, key: c.key, label: c.label, auto: c.auto, done: c.done, doneBy: c.done_name, doneAt: c.done_at, note: c.note, custom: c.key.startsWith('custom_') })) };
}
const progress = (driverId) => q(`UPDATE onboarding SET progress_at = now() WHERE driver_id = $1`, [driverId]).then(() => q(`UPDATE drivers SET updated_at = now() WHERE id = $1`, [driverId]));

module.exports = (app) => {
  // ---------- the onboarding board: every driver being set up, with every step ----------
  app.get('/api/onboarding', needUser, wrap(async (req, res) => {
    const params = []; const vis = visSql(req.user, params);
    const rows = await q(`SELECT d.id, d.name, d.owner_id, d.phones, d.mode, d.location, d.company_id, d.amazon_step, d.truck_year, d.truck_model, d.exp_years, d.weeks_out, d.days_home, o.started_at, o.expected_arrival, o.arrival_note, o.arrived_on, o.telegram_link, o.progress_at, t.unit truck_unit, t.details truck_details
      FROM drivers d JOIN onboarding o ON o.driver_id = d.id LEFT JOIN trucks t ON t.driver_id = d.id
      WHERE d.status = 'Onboarding' ${vis ? 'AND ' + vis : ''} ORDER BY o.expected_arrival NULLS LAST, o.started_at`, params);
    const ids = rows.rows.map((r) => r.id);
    const items = ids.length ? (await q(`SELECT id, driver_id, key, label, auto, done, note FROM checklist WHERE driver_id = ANY($1::int[]) ORDER BY position, id`, [ids])).rows : [];
    const p2 = []; const v2 = visSql(req.user, p2);
    const hired = await q(`SELECT d.id, d.name, d.owner_id, d.company_id, o.completed_at, o.started_at, t.unit truck_unit FROM drivers d JOIN onboarding o ON o.driver_id = d.id LEFT JOIN trucks t ON t.driver_id = d.id
      WHERE d.status = 'Hired' AND o.completed_at > now() - interval '30 days' ${v2 ? 'AND ' + v2 : ''} ORDER BY o.completed_at DESC LIMIT 30`, p2);
    const empty = await q(`SELECT count(*)::int n FROM trucks WHERE driver_id IS NULL AND driver_name IS NULL AND NOT out_of_service`);
    res.json({ today: await lib.today(), template: db.settings.checklist, emptyTrucks: empty.rows[0].n,
      drivers: rows.rows.map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id, phones: r.phones, mode: r.mode, location: r.location, startedAt: r.started_at, expectedArrival: r.expected_arrival, arrivalNote: r.arrival_note,
        arrivedOn: r.arrived_on, telegramLink: r.telegram_link, progressAt: r.progress_at, companyId: r.company_id, truck: r.truck_unit ? { unit: r.truck_unit, details: r.truck_details } : null,
        amazonStep: r.amazon_step, ownTruck: [r.truck_year, r.truck_model].filter(Boolean).join(' ') || null, expYears: r.exp_years === null ? null : +r.exp_years, weeksOut: r.weeks_out === null ? null : +r.weeks_out, daysHome: r.days_home,
        items: items.filter((c) => c.driver_id === r.id).map((c) => ({ id: c.id, key: c.key, label: c.label, auto: c.auto, done: c.done, note: c.note })) })),
      hired: hired.rows.map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id, companyId: r.company_id, hiredAt: r.completed_at, startedAt: r.started_at, truck: r.truck_unit })) });
  }));

  // Arrival dates, the Telegram group link, and the truck.
  app.patch('/api/drivers/:id/onboarding', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const o = (await q(`SELECT * FROM onboarding WHERE driver_id = $1`, [d.id])).rows[0];
    if (!o) return res.status(400).json({ error: 'Start onboarding for this driver first' });
    const b = req.body || {}; const set = {}; const log = [];
    for (const [k, col, label] of [['expectedArrival', 'expected_arrival', 'Expected arrival'], ['arrivedOn', 'arrived_on', 'Arrived']]) {
      if (b[k] === undefined) continue;
      const v = b[k] || null;
      if (v && !isDate(v)) return res.status(400).json({ error: 'That date is not valid' });
      if (v !== (o[col] || null)) { set[col] = v; log.push(['arrival', v ? `${label}: ${niceDate(v)}` : `${label} date cleared`]); }
    }
    if (b.arrivalNote !== undefined) { const v = String(b.arrivalNote).trim().slice(0, 500) || null; if (v !== o.arrival_note) { set.arrival_note = v; log.push(['arrival', v ? `Arrival details: ${v}` : 'Arrival details cleared']); } }
    if (b.telegramLink !== undefined) {
      const v = String(b.telegramLink).trim() || null;
      if (v && !/^https:\/\/(t\.me|telegram\.me)\/\S+$/i.test(v)) return res.status(400).json({ error: 'Paste the invite link of the Telegram group. It starts with https://t.me/' });
      if (v !== o.telegram_link) { set.telegram_link = v; log.push(['onboard', v ? 'Telegram group link saved' : 'Telegram group link removed']); }
    }
    if (b.truckId !== undefined) {
      const to = b.truckId ? +b.truckId : null;
      const cur = (await q(`SELECT id, unit FROM trucks WHERE driver_id = $1`, [d.id])).rows[0];
      if ((cur ? cur.id : null) !== to) {
        if (to) {
          const t = (await q(`SELECT * FROM trucks WHERE id = $1`, [to])).rows[0];
          if (!t) return res.status(400).json({ error: 'Truck not found' });
          if (t.out_of_service) return res.status(400).json({ error: `Truck ${t.unit} is out of service` });
          if (t.driver_id || t.driver_name) return res.status(409).json({ error: `Truck ${t.unit} already has a driver. Pick another one.` });
          if (cur) await q(`UPDATE trucks SET driver_id = NULL, updated_at = now() WHERE id = $1`, [cur.id]);
          const r = await q(`UPDATE trucks SET driver_id = $2, updated_at = now() WHERE id = $1 AND driver_id IS NULL AND driver_name IS NULL`, [to, d.id]);
          if (!r.rowCount) return res.status(409).json({ error: `Truck ${t.unit} was just taken. Pick another one.` });
          log.push(['truck', `Truck ${t.unit} assigned${cur ? ` (was ${cur.unit})` : ''}`]);
          if (t.company_id && t.company_id !== d.company_id) { // the driver now works for the truck's company
            const co = (await q(`UPDATE drivers SET company_id = $2 WHERE id = $1 RETURNING (SELECT name FROM companies WHERE id = $2) n`, [d.id, t.company_id])).rows[0];
            log.push(['edit', `Company: ${co.n} (with truck ${t.unit})`]);
          }
        } else { await db.releaseTruck(db.pool, d.id); log.push(['truck', `Truck ${cur.unit} released`]); }
      }
    }
    const cols = Object.keys(set);
    if (cols.length) await q(`UPDATE onboarding SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE driver_id = $1`, [d.id, ...cols.map((k) => set[k])]);
    if (log.length) { await db.syncAuto(db.pool, d.id, req.user.id); await progress(d.id); }
    for (const [type, text] of log) await record(req, type, d, text);
    res.json({ ok: true });
  }));

  // ---------- checklist steps ----------
  async function loadItem(req, res) {
    const it = (await q(`SELECT * FROM checklist WHERE id = $1`, [+req.params.id || 0])).rows[0];
    if (!it) { res.status(404).json({ error: 'Step not found' }); return []; }
    const d = await loadDriver(req, res, it.driver_id);
    return d ? [it, d] : [];
  }
  app.patch('/api/checklist/:id', needUser, wrap(async (req, res) => {
    const [it, d] = await loadItem(req, res); if (!it) return;
    const b = req.body || {}; const log = [];
    if (b.done !== undefined && !!b.done !== it.done) {
      if (AUTO_HINT[it.auto]) return res.status(400).json({ error: AUTO_HINT[it.auto] });
      await q(`UPDATE checklist SET done = $2, done_by = CASE WHEN $2 THEN $3::int END, done_at = CASE WHEN $2 THEN now() END WHERE id = $1`, [it.id, !!b.done, req.user.id]);
      log.push([b.done ? 'check' : 'uncheck', `${b.done ? 'Done' : 'Not done after all'}: ${it.label}`]);
    }
    if (b.note !== undefined) {
      const v = String(b.note).trim().slice(0, 500) || null;
      if (v !== it.note) { await q(`UPDATE checklist SET note = $2 WHERE id = $1`, [it.id, v]); log.push(['check_note', v ? `${it.label}: ${v}` : `${it.label}: note removed`]); }
    }
    if (log.length) await progress(d.id);
    for (const [type, text] of log) await record(req, type, d, text);
    res.json({ ok: true });
  }));
  // A step only this driver needs.
  app.post('/api/drivers/:id/checklist', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    if (!(await q(`SELECT 1 FROM onboarding WHERE driver_id = $1`, [d.id])).rows[0]) return res.status(400).json({ error: 'Start onboarding for this driver first' });
    const label = String((req.body || {}).label || '').trim().slice(0, 80);
    if (!label) return res.status(400).json({ error: 'Name the step first' });
    await q(`INSERT INTO checklist (driver_id, key, label, position) VALUES ($1, $2, $3, 1000 + (SELECT count(*) FROM checklist WHERE driver_id = $1))`, [d.id, 'custom_' + token().slice(0, 10), label]);
    await progress(d.id); await record(req, 'check_note', d, `Added a step: ${label}`);
    res.json({ ok: true });
  }));
  app.delete('/api/checklist/:id', needUser, wrap(async (req, res) => {
    const [it, d] = await loadItem(req, res); if (!it) return;
    if (!it.key.startsWith('custom_') && req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can remove a standard step' });
    await q(`DELETE FROM checklist WHERE id = $1`, [it.id]);
    await record(req, 'check_note', d, `Removed the step: ${it.label}`);
    res.json({ ok: true });
  }));

  // ---------- trucks ----------
  app.get('/api/trucks', needUser, wrap(async (req, res) => {
    const r = await q(`SELECT t.*, d.name d_name, d.status d_status, d.owner_id d_owner FROM trucks t LEFT JOIN drivers d ON d.id = t.driver_id ORDER BY length(t.unit), t.unit`);
    res.json({ trucks: r.rows.map((t) => ({ id: t.id, unit: t.unit, details: t.details, location: t.location, notes: t.notes, outOfService: t.out_of_service, driverName: t.driver_name, companyId: t.company_id,
      driver: t.driver_id ? { id: canSee(req.user, { owner_id: t.d_owner }) ? t.driver_id : null, name: t.d_name, status: t.d_status } : null,
      state: t.out_of_service ? 'out' : t.driver_id || t.driver_name ? 'assigned' : 'empty', updatedAt: t.updated_at })) });
  }));
  const truckFields = (b) => {
    const set = {};
    if (b.unit !== undefined) set.unit = String(b.unit).trim().slice(0, 30);
    for (const [k, col, max] of [['details', 'details', 120], ['location', 'location', 120], ['notes', 'notes', 500], ['driverName', 'driver_name', 80]]) if (b[k] !== undefined) set[col] = String(b[k]).trim().slice(0, max) || null;
    if (b.outOfService !== undefined) set.out_of_service = !!b.outOfService;
    if (b.companyId !== undefined) set.company_id = b.companyId ? +b.companyId : null;
    return set;
  };
  app.post('/api/trucks', needUser, needAdmin, wrap(async (req, res) => {
    const set = truckFields(req.body || {});
    if (!set.unit) return res.status(400).json({ error: 'The unit number is required' });
    if (set.company_id && !(await q(`SELECT 1 FROM companies WHERE id = $1`, [set.company_id])).rows[0]) return res.status(400).json({ error: 'That company is not in the list' });
    try {
      const cols = Object.keys(set);
      const r = await q(`INSERT INTO trucks (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, cols.map((k) => set[k]));
      await act(req.user, 'truck', null, `Added truck ${set.unit}`);
      res.json({ id: r.rows[0].id });
    } catch (e) { if (e.code === '23505') return res.status(400).json({ error: `Truck ${set.unit} is already in the list` }); throw e; }
  }));
  app.patch('/api/trucks/:id', needUser, needAdmin, wrap(async (req, res) => {
    const t = (await q(`SELECT * FROM trucks WHERE id = $1`, [+req.params.id || 0])).rows[0];
    if (!t) return res.status(404).json({ error: 'Truck not found' });
    const b = req.body || {}; const set = truckFields(b);
    if (set.unit === '') return res.status(400).json({ error: 'The unit number is required' });
    if (b.release) { set.driver_id = null; set.driver_name = null; }
    if (set.driver_name && t.driver_id && !b.release) return res.status(400).json({ error: 'This truck has a driver from the list. Release it first.' });
    if (set.company_id && !(await q(`SELECT 1 FROM companies WHERE id = $1`, [set.company_id])).rows[0]) return res.status(400).json({ error: 'That company is not in the list' });
    const cols = Object.keys(set); if (!cols.length) return res.json({ ok: true });
    try { await q(`UPDATE trucks SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [t.id, ...cols.map((k) => set[k])]); }
    catch (e) { if (e.code === '23505') return res.status(400).json({ error: `Truck ${set.unit} is already in the list` }); throw e; }
    // the truck moved to another company: its driver goes along
    if (set.company_id !== undefined && set.company_id && set.company_id !== t.company_id && t.driver_id && !b.release) {
      const d = (await q(`UPDATE drivers SET company_id = $2 WHERE id = $1 RETURNING id, name, (SELECT name FROM companies WHERE id = $2) co`, [t.driver_id, set.company_id])).rows[0];
      if (d) await record(req, 'edit', d, `Company: ${d.co} (truck ${t.unit} moved there)`);
    }
    if (b.release && t.driver_id) {
      await db.syncAuto(db.pool, t.driver_id, req.user.id);
      const d = (await q(`SELECT id, name FROM drivers WHERE id = $1`, [t.driver_id])).rows[0];
      if (d) await record(req, 'truck', d, `Truck ${t.unit} released`);
    } else await act(req.user, 'truck', null, `Edited truck ${set.unit || t.unit}${set.out_of_service === true && !t.out_of_service ? ': out of service' : set.out_of_service === false && t.out_of_service ? ': back in service' : ''}`);
    res.json({ ok: true });
  }));
  app.delete('/api/trucks/:id', needUser, needAdmin, wrap(async (req, res) => {
    const t = (await q(`DELETE FROM trucks WHERE id = $1 RETURNING *`, [+req.params.id || 0])).rows[0];
    if (!t) return res.status(404).json({ error: 'Truck not found' });
    if (t.driver_id) await db.syncAuto(db.pool, t.driver_id, req.user.id);
    await act(req.user, 'truck', null, `Removed truck ${t.unit} from the list`);
    res.json({ ok: true });
  }));
};
module.exports.onboardingOf = onboardingOf;
