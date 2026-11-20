// Leads: the list, one driver, notes and contact log, who owns a lead.
const db = require('./db');
const lib = require('./lib');
const { q } = db;
const { wrap, needUser, needAdmin, act, history, record, loadDriver, visSql, canSee, isDate, niceDate } = lib;

const CONTACT = { call: ['Talked', 'No answer', 'Left voicemail', 'Wrong number'], text: ['Sent'], email: ['Sent'] };
const CONTACT_WORD = { call: 'Call', text: 'Text', email: 'Email' };
const LOST_REASONS = ['Pay', 'Home time', 'Found another job', 'No response', 'Not qualified', 'Location', 'Equipment', 'Other'];

function toClient(d) {
  return { id: d.id, name: d.name, status: d.status, statusLocked: d.status_locked, phones: d.phones, emails: d.emails, location: d.location, zip: d.zip,
    mode: d.mode, source: d.source, sourceDetail: d.source_detail, job: d.job, account: d.account, answers: d.answers, aiSummary: d.ai_summary, redFlags: d.red_flags, transcript: d.transcript,
    conversationUrl: d.conversation_url, lastMessage: d.last_message, profileSummary: d.profile_summary, lastActive: d.last_active, invitedAt: d.invited_at,
    lastContactAt: d.last_contact_at, followUp: d.follow_up || null, tags: d.tags, ownerId: d.owner_id, createdBy: d.created_by, lostReason: d.lost_reason, leadAt: d.lead_at,
    weeksOut: d.weeks_out === null || d.weeks_out === undefined ? null : +d.weeks_out, daysHome: d.days_home ?? null, cdlExpires: d.cdl_expires || null, medExpires: d.med_expires || null,
    outSince: d.out_since || null, leftOn: d.left_on || null, leftReason: d.left_reason || null,
    callPrep: d.call_prep || null, callPrepAt: d.call_prep_at || null,
    expYears: d.exp_years === null || d.exp_years === undefined ? null : +d.exp_years, experience: d.experience, truckYear: d.truck_year, truckModel: d.truck_model, companyId: d.company_id,
    createdAt: d.created_at, updatedAt: d.updated_at, noteCount: d.note_count !== undefined ? +d.note_count : undefined, lastNote: d.last_note };
}
const cleanPhones = (list) => [...new Set((list || []).map(db.digits).filter(Boolean))];
const cleanEmails = (list) => [...new Set((list || []).map((e) => String(e || '').trim().toLowerCase()).filter((e) => /^\S+@\S+\.\S+$/.test(e)))];
// Experience and an owner-operator's own truck, from the add-lead form or the details form. Returns { set, error }.
const MODES = ['Company drivers', 'Owner-operators'];
const fullDate = (v) => new Date(v + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
function profileFields(b) {
  const set = {};
  if (b.expYears !== undefined) {
    const s = String(b.expYears ?? '').trim();
    if (!s) set.exp_years = null;
    else { const n = Math.round(Number(s) * 2) / 2; if (!(n >= 0 && n <= 60)) return { error: 'Years of experience: a number from 0 to 60' }; set.exp_years = n; }
  }
  if (b.experience !== undefined) set.experience = String(b.experience || '').trim().slice(0, 1000) || null;
  if (b.truckYear !== undefined) {
    const s = String(b.truckYear ?? '').trim(); const max = new Date().getFullYear() + 1;
    if (!s) set.truck_year = null;
    else { const n = +s; if (!Number.isInteger(n) || n < 1980 || n > max) return { error: `Truck year: from 1980 to ${max}` }; set.truck_year = n; }
  }
  if (b.truckModel !== undefined) set.truck_model = String(b.truckModel || '').trim().slice(0, 80) || null;
  // working period: weeks on the road, then days at home
  if (b.weeksOut !== undefined) {
    const s = String(b.weeksOut ?? '').trim();
    if (!s) set.weeks_out = null; else { const n = Math.round(Number(s) * 2) / 2; if (!(n >= 0.5 && n <= 26)) return { error: 'Weeks out: from 0.5 to 26' }; set.weeks_out = n; }
  }
  if (b.daysHome !== undefined) {
    const s = String(b.daysHome ?? '').trim();
    if (!s) set.days_home = null; else { const n = +s; if (!Number.isInteger(n) || n < 0 || n > 60) return { error: 'Days home: a whole number from 0 to 60' }; set.days_home = n; }
  }
  for (const [k, col, label] of [['cdlExpires', 'cdl_expires', 'CDL expiry'], ['medExpires', 'med_expires', 'Medical card expiry'], ['outSince', 'out_since', 'Out since']]) {
    if (b[k] === undefined) continue;
    const v = String(b[k] || '').trim();
    if (v && !isDate(v)) return { error: `${label}: not a valid date` };
    set[col] = v || null;
  }
  return { set };
}
async function companyOf(id) { return id ? (await q(`SELECT id, name FROM companies WHERE id = $1`, [+id || 0])).rows[0] || null : null; }
const personName = async (id) => { const r = await q(`SELECT name FROM users WHERE id = $1`, [id]); return r.rows[0] ? r.rows[0].name : 'someone'; };

module.exports = (app) => {
  // ---------- list ----------
  app.get('/api/drivers', needUser, wrap(async (req, res) => {
    const { q: text = '', status = '', account = '', mode = '', due = '', cold = '', working = '', owner = '', source = '', company = '', sort = 'updated', limit = '100', offset = '0' } = req.query;
    const where = []; const params = [];
    const P = (v) => { params.push(v); return '$' + params.length; };
    const vis = visSql(req.user, params); if (vis) where.push(vis);
    if (account) where.push(`d.account = ${P(account)}`);
    if (mode) where.push(`d.mode = ${P(mode)}`);
    if (source) where.push(`d.source = ${P(source)}`);
    if (company === 'none') where.push('d.company_id IS NULL'); else if (+company) where.push(`d.company_id = ${P(+company)}`);
    if (owner === 'none') where.push(lib.unownedSql());
    else if (owner === 'me') where.push(`d.owner_id = ${P(req.user.id)}`);
    else if (+owner) where.push(`d.owner_id = ${P(+owner)}`);
    if (String(text).trim()) {
      const t = String(text).trim(); const dg = t.replace(/\D/g, ''); const i = P('%' + t.toLowerCase() + '%');
      let s = `(lower(d.name) LIKE ${i} OR lower(coalesce(d.location,'')) LIKE ${i} OR lower(coalesce(d.experience,'') || ' ' || coalesce(d.truck_model,'')) LIKE ${i} OR lower(array_to_string(d.emails,' ')) LIKE ${i} OR lower(coalesce(d.ai_summary,'')) LIKE ${i} OR lower(coalesce(d.red_flags,'')) LIKE ${i} OR lower(d.answers::text) LIKE ${i} OR lower(array_to_string(d.tags,' ')) LIKE ${i} OR lower(coalesce(d.source_detail,'')) LIKE ${i} OR EXISTS (SELECT 1 FROM notes n WHERE n.driver_id = d.id AND lower(n.body) LIKE ${i})`;
      if (dg.length >= 3) s += ` OR array_to_string(d.phones,' ') LIKE ${P('%' + dg + '%')}`;
      where.push(s + ')');
    }
    const dueSql = `(d.follow_up IS NOT NULL AND d.follow_up <= ${P(await lib.today())}::date)`;
    const workSql = `(d.status = ANY(${P(db.ACTIVE)}::text[]))`; // in progress: someone should be working these
    const coldSql = `(${workSql} AND d.follow_up IS NULL AND d.updated_at < now() - make_interval(days => ${P(db.COLD_DAYS)}::int))`;
    const base = where.length ? 'WHERE ' + where.join(' AND ') : '';
    // the counts on the status strip follow search and the dropdown filters, not the strip itself
    const counts = await q(`SELECT d.status, count(*)::int n, count(*) FILTER (WHERE ${dueSql})::int due, count(*) FILTER (WHERE ${coldSql})::int cold, count(*) FILTER (WHERE ${workSql})::int working FROM drivers d ${base} GROUP BY d.status`, params);
    const w = [...where]; const p2 = [...params];
    if (due === '1') w.push(dueSql);
    if (cold === '1') w.push(coldSql);
    if (working === '1') w.push(workSql);
    if (status) { p2.push(status); w.push(`d.status = $${p2.length}`); }
    const sortSql = { updated: 'd.updated_at DESC', name: 'lower(d.name) ASC', followup: 'd.follow_up ASC NULLS LAST, d.updated_at DESC', created: 'd.created_at DESC' }[sort] || 'd.updated_at DESC';
    const rows = await q(`SELECT d.*, count(*) OVER() total_n, ${dueSql} is_due, ${coldSql} is_cold, (SELECT count(*) FROM notes n WHERE n.driver_id = d.id) note_count,
        (SELECT ${lib.NOTE_TEXT} FROM notes n WHERE n.driver_id = d.id ORDER BY n.updated_at DESC LIMIT 1) last_note
      FROM drivers d ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${sortSql}, d.id LIMIT ${Math.min(500, Math.max(1, +limit || 100))} OFFSET ${Math.max(0, +offset || 0)}`, p2);
    const pv = []; const v2 = visSql(req.user, pv);
    const accounts = await q(`SELECT DISTINCT account FROM drivers d WHERE account IS NOT NULL ${v2 ? 'AND ' + v2 : ''} ORDER BY 1`, pv);
    res.json({ total: rows.rows[0] ? +rows.rows[0].total_n : 0, drivers: rows.rows.map((d) => ({ ...toClient(d), cold: d.is_cold })), counts: counts.rows, accounts: accounts.rows.map((r) => r.account) });
  }));

  // ---------- one driver ----------
  app.get('/api/drivers/:id', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const notes = await q(`SELECT n.*, u.name author FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.driver_id = $1 ORDER BY n.created_at DESC`, [d.id]);
    const ev = await q(`SELECT t, type, text, who FROM driver_events WHERE driver_id = $1 ORDER BY t DESC LIMIT 200`, [d.id]);
    const ops = require('./api-ops');
    res.json({ driver: toClient(d),
      notes: notes.rows.map((n) => ({ id: n.id, body: n.body, kind: n.kind, outcome: n.outcome, author: n.author || (n.source ? 'Chrome extension (' + n.source.slice(4) + ')' : 'Unknown'), mine: n.user_id === req.user.id, fromExtension: !!n.source, createdAt: n.created_at, updatedAt: n.updated_at })),
      events: ev.rows, onboarding: await ops.onboardingOf(d.id), lostReasons: LOST_REASONS });
  }));

  // Add a lead by hand. The source is required, and someone already in the list is not added twice.
  app.post('/api/drivers', needUser, wrap(async (req, res) => {
    const b = req.body || {}; const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const source = String(b.source || '').trim();
    if (!db.settings.sources.includes(source)) return res.status(400).json({ error: 'Choose where this lead came from' });
    if (b.followUp && !isDate(b.followUp)) return res.status(400).json({ error: 'The follow-up date is not a valid date' });
    const phones = cleanPhones([b.phone]); const emails = cleanEmails([b.email]);
    if (String(b.phone || '').trim() && !phones.length) return res.status(400).json({ error: 'The phone number needs 10 digits' });
    if (String(b.email || '').trim() && !emails.length) return res.status(400).json({ error: 'That email address does not look right' });
    // someone with the same phone or email is the same person; the same name alone may be a coincidence
    const strong = phones.length || emails.length ? (await q(`SELECT id, name, status, owner_id FROM drivers WHERE phones && $1::text[] OR emails && $2::text[] ORDER BY updated_at DESC LIMIT 5`, [phones, emails])).rows : [];
    const weak = strong.length || b.force ? [] : (await q(`SELECT id, name, status, owner_id FROM drivers WHERE name_key = $1 ORDER BY updated_at DESC LIMIT 5`, [db.keyOf(name)])).rows;
    if (strong.length || weak.length) {
      const people = Object.fromEntries((await q(`SELECT id, name FROM users`)).rows.map((u) => [u.id, u.name]));
      return res.status(409).json({ error: strong.length ? 'This person is already in the list' : 'Someone with this name is already in the list', canForce: !strong.length,
        duplicates: (strong.length ? strong : weak).map((x) => ({ id: canSee(req.user, x) ? x.id : null, name: x.name, status: x.status, owner: x.owner_id ? people[x.owner_id] || null : null })) });
    }
    const status = db.ORDER.includes(b.status) ? b.status : 'Interested';
    let ownerId = req.user.id;
    if (req.user.role === 'admin' && b.ownerId !== undefined) ownerId = b.ownerId ? +b.ownerId : null;
    if (ownerId && !(await q(`SELECT 1 FROM users WHERE id = $1 AND active`, [ownerId])).rows[0]) return res.status(400).json({ error: 'That person cannot take leads' });
    const mode = MODES.includes(b.mode) ? b.mode : null;
    const pf = profileFields(b); if (pf.error) return res.status(400).json({ error: pf.error });
    if (mode !== 'Owner-operators') { pf.set.truck_year = null; pf.set.truck_model = null; } // only owner-operators bring a truck
    const co = b.companyId ? await companyOf(b.companyId) : null;
    if (b.companyId && !co) return res.status(400).json({ error: 'That company is not in the list' });
    const r = await q(`INSERT INTO drivers (name, name_key, phones, emails, location, zip, mode, source, source_detail, status, status_locked, status_at, owner_id, created_by, assigned_at, follow_up, lead_at,
        exp_years, experience, truck_year, truck_model, company_id, weeks_out, days_home)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$13,$14,now(),$10::int,$11,CASE WHEN $10::int IS NULL THEN NULL ELSE now() END,$12::date,now(),$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [name, db.keyOf(name), phones, emails, String(b.location || '').trim() || null, String(b.zip || '').trim().slice(0, 10) || null, mode, source, String(b.sourceDetail || '').trim().slice(0, 200) || null, ownerId, req.user.id, b.followUp || null, status,
        db.LOCKING.includes(status), pf.set.exp_years ?? null, pf.set.experience ?? null, pf.set.truck_year ?? null, pf.set.truck_model ?? null, co ? co.id : null, pf.set.weeks_out ?? null, pf.set.days_home ?? null]); // the starting status is a first guess: if the same person also chats on Indeed, the extension may move them forward
    const d = r.rows[0];
    await db.statusChanged(db.pool, { id: d.id, status: null }, status, { userId: req.user.id });
    await record(req, 'lead_add', d, `Added the lead (${source}${b.sourceDetail ? ': ' + String(b.sourceDetail).trim().slice(0, 80) : ''})`);
    const note = String(b.note || '').trim();
    if (note) { await q(`INSERT INTO notes (driver_id, user_id, body) VALUES ($1, $2, $3)`, [d.id, req.user.id, note.slice(0, 5000)]); await act(req.user, 'note', d, note.slice(0, 140)); }
    res.json({ id: d.id });
  }));

  // Give several leads to one recruiter at once.
  app.post('/api/drivers/assign', needUser, needAdmin, wrap(async (req, res) => {
    const ids = [...new Set((Array.isArray((req.body || {}).ids) ? req.body.ids : []).map((x) => +x).filter(Boolean))].slice(0, 2000);
    const ownerId = (req.body || {}).ownerId ? +req.body.ownerId : null;
    if (!ids.length) return res.status(400).json({ error: 'Select at least one lead' });
    if (ownerId && !(await q(`SELECT 1 FROM users WHERE id = $1 AND active`, [ownerId])).rows[0]) return res.status(400).json({ error: 'That person cannot take leads' });
    const who = ownerId ? await personName(ownerId) : null;
    const r = await q(`UPDATE drivers SET owner_id = $2::int, assigned_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() END WHERE id = ANY($1::int[]) AND owner_id IS DISTINCT FROM $2::int RETURNING id`, [ids, ownerId]);
    const text = who ? `Assigned to ${who}` : 'Set to no recruiter';
    for (const row of r.rows) await history(row.id, text, req.user.name);
    if (r.rows.length) await act(req.user, 'assign', null, who ? `Assigned ${r.rows.length} lead${r.rows.length > 1 ? 's' : ''} to ${who}` : `Removed the recruiter from ${r.rows.length} lead${r.rows.length > 1 ? 's' : ''}`);
    res.json({ ok: true, changed: r.rows.length });
  }));

  app.patch('/api/drivers/:id', needUser, wrap(async (req, res) => {
    const cur = await loadDriver(req, res); if (!cur) return;
    const id = cur.id; const b = req.body || {}; const u = req.user;
    const set = {}; const log = []; // log: [type, text]
    let newStatus = null;
    if (b.status !== undefined && db.ORDER.includes(b.status) && b.status !== cur.status) { newStatus = b.status; set.status = b.status; set.status_locked = true; set.status_at = new Date().toISOString(); log.push(['status', `Status: ${cur.status} to ${b.status}`]); }
    if (b.statusLocked === false) set.status_locked = false;
    if (b.followUp !== undefined && (b.followUp || null) !== (cur.follow_up || null)) {
      if (b.followUp && !isDate(b.followUp)) return res.status(400).json({ error: 'The follow-up date is not a valid date' });
      set.follow_up = b.followUp || null; log.push(['followup', b.followUp ? `Follow-up set for ${niceDate(b.followUp)}` : 'Follow-up cleared']);
    }
    if (Array.isArray(b.tags)) set.tags = [...new Set(b.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
    let edited = false;
    for (const [k, col] of [['name', 'name'], ['location', 'location'], ['zip', 'zip'], ['aiSummary', 'ai_summary'], ['redFlags', 'red_flags'], ['sourceDetail', 'source_detail']]) {
      if (b[k] !== undefined) { const v = String(b[k]).trim() || null; if (v !== cur[col]) { set[col] = v; edited = true; } }
    }
    if (set.name === null) delete set.name; if (set.name) set.name_key = db.keyOf(set.name);
    if (b.mode !== undefined) { const v = MODES.includes(b.mode) ? b.mode : null; if (v !== cur.mode) { set.mode = v; log.push(['edit', `Driver type: ${v ? v.replace(/s$/, '') : 'not set'}`]); } }
    {
      const pf = profileFields(b); if (pf.error) return res.status(400).json({ error: pf.error });
      const SAY = { cdl_expires: 'CDL expires', med_expires: 'Medical card expires', out_since: 'Out on the road since' };
      for (const [col, v] of Object.entries(pf.set)) {
        if (String(v ?? '') === String(cur[col] ?? '')) continue;
        set[col] = v;
        if (SAY[col]) log.push(['edit', v ? `${SAY[col]} ${fullDate(v)}` : `${SAY[col]}: cleared`]); else edited = true;
      }
    }
    // a hired driver who left: no longer an active driver, and a fleet truck is freed
    if (b.leftOn !== undefined) {
      const v = String(b.leftOn || '').trim() || null;
      if (v && !isDate(v)) return res.status(400).json({ error: 'The date they left is not a valid date' });
      if (v && cur.status !== 'Hired') return res.status(400).json({ error: 'Only a hired driver can be marked as left' });
      if (v !== (cur.left_on || null)) {
        set.left_on = v; set.left_reason = v ? String(b.leftReason || '').trim().slice(0, 200) || null : null;
        log.push(['edit', v ? `Left the company on ${niceDate(v)}${set.left_reason ? `: ${set.left_reason}` : ''}` : 'Active driver again']);
        if (v) { const t = (await q(`SELECT unit FROM trucks WHERE driver_id = $1`, [id])).rows[0]; if (t) { await db.releaseTruck(db.pool, id); log.push(['truck', `Truck ${t.unit} released`]); } }
      }
    }
    // the company the driver works for. A driver in one of the fleet's trucks belongs to that truck's company.
    if (b.companyId !== undefined) {
      const to = b.companyId ? +b.companyId : null;
      if (to !== cur.company_id) {
        const co = to ? await companyOf(to) : null;
        if (to && !co) return res.status(400).json({ error: 'That company is not in the list' });
        const t = (await q(`SELECT t.unit, t.company_id, c.name FROM trucks t LEFT JOIN companies c ON c.id = t.company_id WHERE t.driver_id = $1`, [id])).rows[0];
        if (t && t.company_id && t.company_id !== to) return res.status(400).json({ error: `This driver has truck ${t.unit}, which belongs to ${t.name}. Pick a truck of the other company first, or release the truck.` });
        set.company_id = to; log.push(['edit', co ? `Company: ${co.name}` : 'Company removed']);
      }
    }
    if (b.source && b.source !== cur.source) {
      if (!db.settings.sources.includes(b.source)) return res.status(400).json({ error: 'Choose a source from the list' });
      set.source = b.source; log.push(['edit', `Source changed to ${b.source}`]);
    }
    if (Array.isArray(b.phones)) { const v = cleanPhones(b.phones); if (v.join() !== cur.phones.join()) { set.phones = v; edited = true; } }
    if (Array.isArray(b.emails)) { const v = cleanEmails(b.emails); if (v.join() !== cur.emails.join()) { set.emails = v; edited = true; } }
    if (b.answers && typeof b.answers === 'object') set.answers = JSON.stringify(b.answers);
    if (b.lostReason !== undefined) { const v = LOST_REASONS.includes(b.lostReason) ? b.lostReason : null; if (v !== cur.lost_reason) { set.lost_reason = v; if (v) log.push(['edit', `Reason: ${v}`]); } }
    if (edited) log.push(['edit', 'Edited contact details']);
    // who owns the lead: an admin decides; a recruiter can take a lead nobody has, or let go of their own
    if (b.ownerId !== undefined) {
      const to = b.ownerId ? +b.ownerId : null;
      if (to !== cur.owner_id) {
        if (u.role !== 'admin' && !((to === u.id && lib.unowned(cur)) || (to === null && cur.owner_id === u.id))) return res.status(403).json({ error: 'Only an admin can move a lead between recruiters' });
        if (to && !(await q(`SELECT 1 FROM users WHERE id = $1 AND active`, [to])).rows[0]) return res.status(400).json({ error: 'That person cannot take leads' });
        set.owner_id = to; set.assigned_at = to ? new Date().toISOString() : null;
        log.push(['assign', to === u.id ? 'Took the lead' : to === null ? (cur.owner_id === u.id ? 'Released the lead' : 'Set to no recruiter') : `Assigned to ${await personName(to)}`]);
      }
    }
    if (!Object.keys(set).length) return res.json({ ok: true });
    const cols = Object.keys(set);
    const ownerOnly = cols.every((c) => c === 'owner_id' || c === 'assigned_at'); // handing a lead over is not work on the lead
    await q(`UPDATE drivers SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}${ownerOnly ? '' : ', updated_at = now(), web_updated_at = now()'} WHERE id = $1`, [id, ...cols.map((k) => set[k])]);
    if (newStatus) for (const text of await db.statusChanged(db.pool, cur, newStatus, { userId: u.id })) log.push(['truck', text]);
    const named = { id, name: set.name || cur.name };
    for (const [type, text] of log) await record(req, type, named, text);
    res.json({ ok: true });
  }));

  app.delete('/api/drivers/:id', needUser, needAdmin, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    await q(`DELETE FROM drivers WHERE id = $1`, [d.id]);
    await act(req.user, 'delete', { name: d.name }, 'Deleted this driver and their notes');
    res.json({ ok: true });
  }));

  // ---------- notes and the contact log ----------
  const touch = (id, contact) => q(`UPDATE drivers SET updated_at = now(), web_updated_at = now()${contact ? ', last_contact_at = now()' : ''} WHERE id = $1`, [id]);
  app.post('/api/drivers/:id/notes', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const b = req.body || {}; const body = String(b.body || '').trim().slice(0, 5000);
    const kind = CONTACT[b.kind] ? b.kind : null;
    const outcome = kind ? (CONTACT[kind].includes(b.outcome) ? b.outcome : CONTACT[kind][0]) : null;
    if (!kind && !body) return res.status(400).json({ error: 'Write something first' });
    const r = await q(`INSERT INTO notes (driver_id, user_id, body, kind, outcome) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [d.id, req.user.id, body, kind, outcome]);
    await touch(d.id, !!kind);
    if (kind) await act(req.user, 'contact', d, `${CONTACT_WORD[kind]}, ${outcome.toLowerCase()}${body ? ': ' + body.slice(0, 140) : ''}`);
    else await act(req.user, 'note', d, body.slice(0, 140));
    res.json({ id: r.rows[0].id });
  }));
  async function ownNote(req, res) {
    const n = (await q(`SELECT * FROM notes WHERE id = $1`, [+req.params.id || 0])).rows[0];
    if (!n) { res.status(404).json({ error: 'Note not found' }); return null; }
    if (n.user_id !== req.user.id && req.user.role !== 'admin') { res.status(403).json({ error: 'You can only change your own notes' }); return null; }
    return n;
  }
  app.patch('/api/notes/:id', needUser, wrap(async (req, res) => {
    const n = await ownNote(req, res); if (!n) return;
    const body = String((req.body || {}).body || '').trim(); if (!body && !n.kind) return res.status(400).json({ error: 'A note cannot be empty. Delete it instead.' });
    await q(`UPDATE notes SET body = $2, updated_at = now() WHERE id = $1`, [n.id, body.slice(0, 5000)]); await touch(n.driver_id);
    const d = (await q(`SELECT id, name FROM drivers WHERE id = $1`, [n.driver_id])).rows[0];
    await act(req.user, 'note_edit', d, 'Edited a note');
    res.json({ ok: true });
  }));
  app.delete('/api/notes/:id', needUser, wrap(async (req, res) => {
    const n = await ownNote(req, res); if (!n) return;
    await q(`DELETE FROM notes WHERE id = $1`, [n.id]); await touch(n.driver_id);
    const d = (await q(`SELECT id, name FROM drivers WHERE id = $1`, [n.driver_id])).rows[0];
    await act(req.user, 'note_delete', d, n.kind ? 'Deleted a contact log entry' : 'Deleted a note');
    res.json({ ok: true });
  }));
};
module.exports.toClient = toClient;
module.exports.LOST_REASONS = LOST_REASONS;
