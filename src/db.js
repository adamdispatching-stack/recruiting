// Database: connection, schema, and the rules for merging driver records from every Chrome profile.
const { Pool, types } = require('pg');
const crypto = require('crypto');
types.setTypeParser(1082, (v) => v); // dates (follow-up, arrival) stay plain 'YYYY-MM-DD' text, whatever the server's time zone

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set. On Railway, add a Postgres database and link it to this service.'); process.exit(1); }
const pool = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1|\/tmp|railway\.internal/.test(url) || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false }
});
const q = (text, params) => pool.query(text, params);

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT UNIQUE NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS drivers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Invited',
      status_locked BOOLEAN NOT NULL DEFAULT FALSE,
      phones TEXT[] NOT NULL DEFAULT '{}',
      emails TEXT[] NOT NULL DEFAULT '{}',
      conv_ids TEXT[] NOT NULL DEFAULT '{}',
      location TEXT, zip TEXT, mode TEXT, source TEXT, job TEXT, account TEXT,
      answers JSONB NOT NULL DEFAULT '{}',
      ai_summary TEXT, red_flags TEXT, transcript TEXT,
      conversation_url TEXT, last_message TEXT, profile_summary TEXT, last_active TEXT,
      invited_at TIMESTAMPTZ, last_contact_at TIMESTAMPTZ,
      follow_up DATE,
      tags TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      web_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS status_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS drivers_name_key ON drivers(name_key);
    CREATE INDEX IF NOT EXISTS drivers_phones ON drivers USING GIN(phones);
    CREATE INDEX IF NOT EXISTS drivers_emails ON drivers USING GIN(emails);
    CREATE INDEX IF NOT EXISTS drivers_conv ON drivers USING GIN(conv_ids);
    CREATE INDEX IF NOT EXISTS drivers_updated ON drivers(updated_at DESC);
    CREATE TABLE IF NOT EXISTS driver_events (
      id BIGSERIAL PRIMARY KEY,
      driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      t TIMESTAMPTZ NOT NULL DEFAULT now(),
      type TEXT,
      text TEXT NOT NULL,
      who TEXT,
      fp TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS driver_events_fp ON driver_events(driver_id, fp);
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      source TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS notes_driver ON notes(driver_id);
    CREATE UNIQUE INDEX IF NOT EXISTS notes_source ON notes(driver_id, source) WHERE source IS NOT NULL;
  `);
  // ----- recruiting pipeline: who owns a lead, where it came from, what each person did, onboarding, trucks -----
  await q(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_visible_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS hours JSONB; -- own working hours; empty = the team's hours
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS assign_to INT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS owner_id INT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS source_detail TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS lost_reason TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS lead_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS drivers_lead_at ON drivers(lead_at) WHERE lead_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS drivers_owner ON drivers(owner_id);
    CREATE INDEX IF NOT EXISTS drivers_status ON drivers(status);
    CREATE INDEX IF NOT EXISTS drivers_follow ON drivers(follow_up) WHERE follow_up IS NOT NULL;
    ALTER TABLE notes ADD COLUMN IF NOT EXISTS kind TEXT;
    ALTER TABLE notes ADD COLUMN IF NOT EXISTS outcome TEXT;
    CREATE TABLE IF NOT EXISTS logins (
      id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      kind TEXT NOT NULL DEFAULT 'in',
      ip TEXT, ua TEXT
    );
    CREATE INDEX IF NOT EXISTS logins_user ON logins(user_id, at DESC);
    CREATE TABLE IF NOT EXISTS activity_hours (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hour TIMESTAMPTZ NOT NULL,
      active_seconds INT NOT NULL DEFAULT 0,
      open_seconds INT NOT NULL DEFAULT 0,
      clicks INT NOT NULL DEFAULT 0,
      views INT NOT NULL DEFAULT 0,
      first_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, hour)
    );
    CREATE TABLE IF NOT EXISTS activity (
      id BIGSERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      type TEXT NOT NULL,
      driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,
      driver_name TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id, at DESC);
    CREATE INDEX IF NOT EXISTS activity_at ON activity(at DESC);
    CREATE TABLE IF NOT EXISTS status_log (
      id BIGSERIAL PRIMARY KEY,
      driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      from_status TEXT,
      to_status TEXT NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      via TEXT
    );
    CREATE INDEX IF NOT EXISTS status_log_at ON status_log(at DESC);
    CREATE INDEX IF NOT EXISTS status_log_driver ON status_log(driver_id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS trucks (
      id SERIAL PRIMARY KEY,
      unit TEXT NOT NULL,
      details TEXT, location TEXT,
      out_of_service BOOLEAN NOT NULL DEFAULT FALSE,
      driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,
      driver_name TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS trucks_unit ON trucks(lower(unit));
    CREATE UNIQUE INDEX IF NOT EXISTS trucks_driver ON trucks(driver_id) WHERE driver_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS onboarding (
      driver_id INT PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_by INT REFERENCES users(id) ON DELETE SET NULL,
      expected_arrival DATE, arrival_note TEXT, arrived_on DATE,
      telegram_link TEXT,
      completed_at TIMESTAMPTZ,
      progress_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS checklist (
      id SERIAL PRIMARY KEY,
      driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      position INT NOT NULL DEFAULT 0,
      auto TEXT,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      done_by INT REFERENCES users(id) ON DELETE SET NULL,
      done_at TIMESTAMPTZ,
      note TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS checklist_key ON checklist(driver_id, key);
    CREATE TABLE IF NOT EXISTS days_off (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      reason TEXT,
      set_by INT REFERENCES users(id) ON DELETE SET NULL,
      set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, day)
    );
    -- the carriers the drivers are dispatched for; each truck and each driver belongs to one
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      mc TEXT, dot TEXT, notes TEXT,
      color INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS companies_name ON companies(lower(name));
    ALTER TABLE trucks ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE SET NULL;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE SET NULL;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS exp_years NUMERIC(4,1); -- years of CDL-A driving
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS experience TEXT;        -- what they drove: freight, routes, past carriers
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS truck_year INT;         -- owner-operators: their own truck
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS truck_model TEXT;
  `);
  // One-time clean-up of rows from before this version. It must never run again: later, a lead added by hand
  // (say from Facebook) can also pick up an Indeed account, and must keep its own source.
  const ran = (await q(`SELECT value FROM settings WHERE key = 'upgrades'`)).rows[0];
  const up = ran ? ran.value : {};
  if (!up.sources) {
    // Where a lead came from is now a short list (Indeed, Facebook, Referral…). Older rows kept the
    // extension's wording there; move that wording to the detail and file them under Indeed.
    await q(`UPDATE drivers SET source_detail = COALESCE(source_detail, source), source = 'Indeed'
      WHERE source IS NOT NULL AND source <> 'Indeed' AND (source ILIKE '%indeed%' OR source ILIKE '%matched candidate%' OR account IS NOT NULL OR cardinality(conv_ids) > 0)`);
    await q(`UPDATE drivers SET source = 'Indeed' WHERE source IS NULL AND (account IS NOT NULL OR cardinality(conv_ids) > 0)`);
    await q(`UPDATE drivers SET source = 'Other', source_detail = COALESCE(source_detail, 'Added by hand') WHERE source = 'Added by hand'`);
    // An invite with no reply is not a lead yet. lead_at = when someone first answered or was added by hand.
    await q(`UPDATE drivers SET lead_at = created_at WHERE lead_at IS NULL AND status <> 'Invited'`);
    up.sources = true;
    await q(`INSERT INTO settings (key, value) VALUES ('upgrades', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(up)]);
  }
  await loadSettings();
}

// ---------- settings (kept in memory, saved in the database) ----------
const DEFAULTS = {
  tz: 'America/New_York',     // the business day: "today" on every report starts at midnight here
  visibility: 'all',          // 'all' = recruiters see every lead; 'own' = only their own and unassigned ones
  sources: ['Indeed', 'Facebook', 'Referral', 'Craigslist', 'TruckersReport', 'Phone call', 'Walk-in', 'Other'],
  checklist: [
    { key: 'telegram', label: 'Telegram group created', auto: 'telegram' },
    { key: 'relay', label: 'Amazon Relay verified' },
    { key: 'insurance', label: 'Insurance approved' },
    { key: 'mvr', label: 'MVR checked' },
    { key: 'truck', label: 'Truck assigned', auto: 'truck' },
    { key: 'arrival_date', label: 'Arrival date set', auto: 'arrival' },
    { key: 'arrived', label: 'Driver arrived', auto: 'arrived' },
    { key: 'eld_group', label: 'ELD group set up' },
    { key: 'eld_profile', label: 'ELD profile set up' },
    { key: 'acct_group', label: 'Accounting group set up' },
    { key: 'bank', label: 'Bank details taken by accounting' }
  ],
  // Working hours in the team time zone. week[0] is Sunday; null = not a working day.
  // A working day counts as worked with at least minMinutes of active time; starting more than grace minutes late is a late start.
  hours: { week: [null, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, null], minMinutes: 30, grace: 15 }
};
const settings = { ...DEFAULTS };
async function loadSettings() {
  const r = await q(`SELECT key, value FROM settings`);
  Object.assign(settings, DEFAULTS);
  for (const row of r.rows) if (row.key in DEFAULTS) settings[row.key] = row.value;
}
async function saveSetting(key, value) {
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
  settings[key] = value;
}

// ---------- passwords and tokens ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${h}`;
}
function checkPassword(pw, stored) {
  const [, salt, h] = String(stored || '').split('$');
  if (!salt || !h) return false;
  const got = crypto.scryptSync(String(pw), salt, 64);
  const want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const token = (prefix = '') => prefix + crypto.randomBytes(24).toString('base64url');

// ---------- driver records ----------
const LOCKING = ['Relay invite sent', 'Onboarding', 'Hired', 'Rejected']; // set by a person: the auto-reply must not change these
const ROUTE = ['Invited', 'Replied', 'Interested', 'Email collected', 'Relay invite sent', 'Signed up on Relay', 'Onboarding', 'Hired'];
const OTHER = ['Review', 'Stalled', 'No CDL', 'Not interested', 'Declined on Indeed', 'Rejected'];
const ORDER = ROUTE.concat(OTHER);
const ACTIVE = ['Replied', 'Interested', 'Email collected', 'Relay invite sent', 'Signed up on Relay', 'Review']; // leads a recruiter should be working
const LOST = ['No CDL', 'Not interested', 'Declined on Indeed', 'Rejected'];
const COLD_DAYS = 3; // an active lead nobody has touched for this long is "going cold"
const keyOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const digits = (p) => { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? d : null; };
const cidOf = (u) => { try { const c = new URL(u).searchParams.get('conversationId'); return c && c.length > 12 && !/\s/.test(c) ? c : null; } catch (e) { return null; } }; // real Indeed chat ids only
const clean = (v) => (v === undefined || v === null || (typeof v === 'string' && !v.trim()) ? null : v);
const isoOrNull = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };

// Find the same person, however they reached us: the Indeed chat, a phone, an email, then name + account.
async function findDriver(c, p) {
  const tries = [];
  if (p.convIds.length) tries.push(['conv_ids && $1', [p.convIds]]);
  if (p.phones.length) tries.push(['phones && $1', [p.phones]]);
  if (p.emails.length) tries.push(['emails && $1', [p.emails]]);
  if (p.nameKey && p.account) tries.push(['name_key = $1 AND (account = $2 OR account IS NULL)', [p.nameKey, p.account]]);
  if (p.nameKey && !p.account) tries.push(['name_key = $1', [p.nameKey]]);
  for (const [where, params] of tries) {
    const r = await c.query(`SELECT * FROM drivers WHERE ${where} ORDER BY updated_at DESC LIMIT 1`, params);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

// Merge one record coming from the extension (a whole local driver record or a partial one).
// Lists are combined, answers merged, history added without duplicates. A status set by a person
// on the website or in the extension is never overwritten by the auto-reply.
async function mergeFromExtension(c, rec, sourceLabel, opts = {}) {
  const name = clean(rec.name); if (!name) return null;
  const p = {
    nameKey: keyOf(name), account: clean(rec.account),
    phones: [...new Set((rec.phones || []).map(digits).filter(Boolean))],
    emails: [...new Set((rec.emails || []).map((e) => String(e).toLowerCase().trim()).filter((e) => e.includes('@')))],
    convIds: [cidOf(rec.conversationUrl)].filter(Boolean)
  };
  let d = await findDriver(c, p);
  if (!d) {
    const at0 = isoOrNull(rec.updatedAt);
    // a new lead belongs to the recruiter this Chrome profile's key is set up for (or to nobody yet)
    const r = await c.query(`INSERT INTO drivers (name, name_key, account, created_at, updated_at, owner_id, assigned_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), LEAST(COALESCE($5::timestamptz, now()), now()), $6::int, CASE WHEN $6::int IS NULL THEN NULL ELSE now() END) RETURNING *`, [name, p.nameKey, p.account, isoOrNull(rec.createdAt), at0, opts.assignTo || null]);
    d = r.rows[0];
  }
  const set = {}; const fields = { location: 'location', zip: 'zip', mode: 'mode', job: 'job', account: 'account', aiSummary: 'ai_summary', redFlags: 'red_flags', transcript: 'transcript', conversationUrl: 'conversation_url', lastMessage: 'last_message', profileSummary: 'profile_summary', lastActive: 'last_active' };
  for (const [k, col] of Object.entries(fields)) { const v = clean(rec[k]); if (v !== null && v !== d[col]) set[col] = String(v); }
  // everything the extension finds comes from Indeed; how we first found someone is never overwritten
  if (!d.source) set.source = 'Indeed';
  const how = clean(rec.source); if (how && !d.source_detail && how !== 'Indeed') set.source_detail = String(how).slice(0, 200);
  for (const [k, col] of [['invitedAt', 'invited_at'], ['lastContactAt', 'last_contact_at']]) { const v = isoOrNull(rec[k]); if (v && (!d[col] || new Date(v) > new Date(d[col]))) set[col] = v; }
  const phones = [...new Set([...d.phones, ...p.phones])], emails = [...new Set([...d.emails, ...p.emails])], conv = [...new Set([...d.conv_ids, ...p.convIds])];
  if (phones.length !== d.phones.length) set.phones = phones;
  if (emails.length !== d.emails.length) set.emails = emails;
  if (conv.length !== d.conv_ids.length) set.conv_ids = conv;
  if (rec.answers && typeof rec.answers === 'object' && Object.keys(rec.answers).length) {
    const merged = { ...d.answers, ...rec.answers };
    if (JSON.stringify(merged) !== JSON.stringify(d.answers)) set.answers = JSON.stringify(merged);
    // "2019 Freightliner Cascadia" from the chat fills the owner-operator's truck when nobody has yet
    const eq = clean(rec.answers.equipment);
    if (eq && !d.truck_model && !d.truck_year) {
      const y = String(eq).match(/\b(19[89]\d|20\d\d)\b/); const model = String(eq).replace(/\b(19[89]\d|20\d\d)\b/, '').replace(/^[\s,.-]+|[\s,.-]+$/g, '').slice(0, 80);
      if (y && +y[1] <= new Date().getFullYear() + 1) set.truck_year = +y[1];
      if (model && model.length > 2) set.truck_model = model;
    }
  }
  // Status: several Chrome profiles can know the same driver, each with its own view. Along the hiring
  // steps a status only moves forward; a status off the steps (Not interested, No CDL, Review…) wins only
  // when it is newer news. A status a person set by hand on the website is kept.
  const st = clean(rec.status);
  if (st && st !== d.status) {
    const byHand = !!rec.statusLocked && LOCKING.includes(st);
    const recAt = isoOrNull(rec.updatedAt) || new Date().toISOString();
    const newer = !d.status_at || new Date(recAt) > new Date(d.status_at);
    const a = ROUTE.indexOf(st), b = ROUTE.indexOf(d.status);
    const forward = a >= 0 && b >= 0 ? a > b : newer;
    if ((byHand && !d.status_locked) || (!d.status_locked && forward)) { set.status = st; set.status_locked = byHand || LOCKING.includes(st); set.status_at = recAt; }
  }
  // a lead nobody owns goes to the recruiter whose Chrome profile is working it
  if (!d.owner_id && opts.assignTo && Object.keys(set).length) { set.owner_id = opts.assignTo; set.assigned_at = new Date().toISOString(); }
  if (Object.keys(set).length) {
    const cols = Object.keys(set);
    const at = isoOrNull(rec.updatedAt); // keep the real time of the activity (matters for imported backups)
    await c.query(`UPDATE drivers SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = GREATEST(updated_at, LEAST(COALESCE($2::timestamptz, now()), now())) WHERE id = $1`, [d.id, at, ...cols.map((k) => set[k])]);
    if (set.status) {
      // when it happened, not when it reached the website: an old backup must not look like this week's leads
      const firstReply = (rec.events || []).map((e) => (e && e.type === 'reply' ? isoOrNull(e.t) : null)).filter(Boolean).sort()[0];
      await statusChanged(c, d, set.status, { via: 'extension', at, leadAt: firstReply || at });
    }
  }
  // history
  const events = [...(rec.events || []), ...(rec.event ? [{ ...rec.event, t: rec.event.t || new Date().toISOString() }] : [])];
  for (const e of events.slice(-80)) {
    if (!e || !e.text) continue;
    const t = isoOrNull(e.t) || new Date().toISOString();
    await c.query(`INSERT INTO driver_events (driver_id, t, type, text, fp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [d.id, t, e.type || null, String(e.text).slice(0, 2000), sha(`${t}|${e.text}`)]);
  }
  // the extension's own notes box: kept as one note per Chrome profile, updated in place
  if (typeof rec.notes === 'string' && sourceLabel) {
    const src = `ext:${sourceLabel}`;
    if (rec.notes.trim()) await c.query(`INSERT INTO notes (driver_id, source, body) VALUES ($1, $2, $3) ON CONFLICT (driver_id, source) WHERE source IS NOT NULL DO UPDATE SET body = EXCLUDED.body, updated_at = now() WHERE notes.body <> EXCLUDED.body`, [d.id, src, rec.notes.trim()]);
    else await c.query(`DELETE FROM notes WHERE driver_id = $1 AND source = $2`, [d.id, src]);
  }
  return d.id;
}

// ---------- onboarding ----------
// The checklist a driver gets when onboarding starts is a copy of the template in Settings.
async function ensureOnboarding(c, driverId, userId) {
  await c.query(`INSERT INTO onboarding (driver_id, started_by) VALUES ($1, $2) ON CONFLICT (driver_id) DO UPDATE SET completed_at = NULL`, [driverId, userId || null]);
  let i = 0;
  for (const it of settings.checklist) await c.query(`INSERT INTO checklist (driver_id, key, label, position, auto) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (driver_id, key) DO NOTHING`, [driverId, it.key, it.label, i++, it.auto || null]);
  await syncAuto(c, driverId, userId);
}
// Steps that tick themselves: a truck is chosen, the arrival date is set, the driver arrived, the group link is saved.
async function syncAuto(c, driverId, userId) {
  const o = (await c.query(`SELECT o.*, (SELECT t.id FROM trucks t WHERE t.driver_id = o.driver_id) truck_id FROM onboarding o WHERE o.driver_id = $1`, [driverId])).rows[0];
  if (!o) return;
  const state = { truck: !!o.truck_id, arrival: !!o.expected_arrival, arrived: !!o.arrived_on };
  for (const [auto, v] of Object.entries(state)) {
    await c.query(`UPDATE checklist SET done = $3, done_at = CASE WHEN $3 THEN now() END, done_by = CASE WHEN $3 THEN $4::int END WHERE driver_id = $1 AND auto = $2 AND done <> $3`, [driverId, auto, v, userId || null]);
  }
  if (o.telegram_link) await c.query(`UPDATE checklist SET done = TRUE, done_at = now(), done_by = $2::int WHERE driver_id = $1 AND auto = 'telegram' AND NOT done`, [driverId, userId || null]);
}
async function releaseTruck(c, driverId) {
  const r = await c.query(`UPDATE trucks SET driver_id = NULL, updated_at = now() WHERE driver_id = $1 RETURNING unit`, [driverId]);
  return r.rows[0] ? r.rows[0].unit : null;
}
// Every status change goes through here: it is logged (who, from, to) and onboarding follows the status.
async function statusChanged(c, d, to, { userId = null, via = 'web', at = null, leadAt = null } = {}) {
  await c.query(`INSERT INTO status_log (driver_id, from_status, to_status, user_id, via, at) VALUES ($1, $2, $3, $4, $5, LEAST(COALESCE($6::timestamptz, now()), now()))`, [d.id, d.status, to, userId, via, at]);
  if (to !== 'Invited') await c.query(`UPDATE drivers SET lead_at = LEAST(COALESCE($2::timestamptz, now()), now()) WHERE id = $1 AND lead_at IS NULL`, [d.id, leadAt]);
  if (!LOST.includes(to) && to !== 'Stalled') await c.query(`UPDATE drivers SET lost_reason = NULL WHERE id = $1 AND lost_reason IS NOT NULL`, [d.id]);
  const notes = [];
  if (to === 'Onboarding') await ensureOnboarding(c, d.id, userId);
  if (to === 'Hired') await c.query(`UPDATE onboarding SET completed_at = COALESCE(completed_at, now()) WHERE driver_id = $1`, [d.id]);
  if (LOST.includes(to)) { const unit = await releaseTruck(c, d.id); if (unit) { notes.push(`Truck ${unit} is free again`); await syncAuto(c, d.id, userId); } }
  return notes;
}

module.exports = { pool, q, migrate, hashPassword, checkPassword, sha, token, keyOf, digits, mergeFromExtension, LOCKING, ROUTE, OTHER, ORDER, ACTIVE, LOST, COLD_DAYS,
  settings, DEFAULTS, saveSetting, ensureOnboarding, syncAuto, releaseTruck, statusChanged };
