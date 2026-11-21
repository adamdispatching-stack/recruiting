// Active drivers: hired and still with us. Their CDL and medical card expiry dates, their working period
// (weeks out, days home), and when their current stretch on the road began.
const db = require('./db');
const lib = require('./lib');
const { q } = db;
const { wrap, needUser, visSql } = lib;

module.exports = (app) => {
  app.get('/api/active', needUser, wrap(async (req, res) => {
    const params = []; const vis = visSql(req.user, params);
    const cols = `d.id, d.name, d.phones, d.mode, d.location, d.company_id, d.owner_id, d.truck_year, d.truck_model, d.cdl_expires, d.med_expires, d.weeks_out, d.days_home, d.out_since,
      d.left_on, d.left_reason, COALESCE(o.completed_at, d.status_at) hired_at, t.id truck_id, t.unit truck_unit, t.details truck_details`;
    const from = `FROM drivers d LEFT JOIN onboarding o ON o.driver_id = d.id LEFT JOIN trucks t ON t.driver_id = d.id WHERE d.status = 'Hired'${vis ? ' AND ' + vis : ''}`;
    const active = await q(`SELECT ${cols} ${from} AND d.left_on IS NULL ORDER BY lower(d.name)`, params);
    const left = await q(`SELECT ${cols} ${from} AND d.left_on IS NOT NULL AND d.left_on > now() - interval '180 days' ORDER BY d.left_on DESC`, params);
    const row = (d) => ({ id: d.id, name: d.name, phone: (d.phones || [])[0] || null, mode: d.mode, location: d.location, companyId: d.company_id, ownerId: d.owner_id,
      truck: d.truck_unit ? { id: d.truck_id, unit: d.truck_unit, details: d.truck_details } : null, ownTruck: [d.truck_year, d.truck_model].filter(Boolean).join(' ') || null,
      cdlExpires: d.cdl_expires, medExpires: d.med_expires, weeksOut: d.weeks_out === null ? null : +d.weeks_out, daysHome: d.days_home, outSince: d.out_since,
      hiredAt: d.hired_at, leftOn: d.left_on, leftReason: d.left_reason });
    const ids = active.rows.map((d) => d.id);
    const groups = ids.length ? (await q(`SELECT driver_id, kind, chat_id::text FROM tg_chats WHERE active AND driver_id = ANY($1::int[]) AND kind IS NOT NULL`, [ids])).rows : [];
    const tg = {}; for (const g of groups) (tg[g.driver_id] = tg[g.driver_id] || {})[g.kind] = g.chat_id;
    res.json({ today: await lib.today(), drivers: active.rows.map((d) => ({ ...row(d), groups: tg[d.id] || {} })), left: left.rows.map(row) });
  }));
};
