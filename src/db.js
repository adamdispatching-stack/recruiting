// Database: connection, schema, and the rules for merging driver records from every Chrome profile.
const { Pool } = require('pg');
const crypto = require('crypto');

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
const LOCKING = ['Relay invite sent', 'Hired', 'Rejected']; // set by a person: the auto-reply must not change these
const ROUTE = ['Invited', 'Replied', 'Interested', 'Email collected', 'Relay invite sent', 'Signed up on Relay', 'Hired'];
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
async function mergeFromExtension(c, rec, sourceLabel) {
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
    const r = await c.query(`INSERT INTO drivers (name, name_key, account, created_at, updated_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), LEAST(COALESCE($5::timestamptz, now()), now())) RETURNING *`, [name, p.nameKey, p.account, isoOrNull(rec.createdAt), at0]);
    d = r.rows[0];
  }
  const set = {}; const fields = { location: 'location', zip: 'zip', mode: 'mode', source: 'source', job: 'job', account: 'account', aiSummary: 'ai_summary', redFlags: 'red_flags', transcript: 'transcript', conversationUrl: 'conversation_url', lastMessage: 'last_message', profileSummary: 'profile_summary', lastActive: 'last_active' };
  for (const [k, col] of Object.entries(fields)) { const v = clean(rec[k]); if (v !== null && v !== d[col]) set[col] = String(v); }
  if (clean(rec.source) && d.source) delete set.source; // keep how we first found them
  for (const [k, col] of [['invitedAt', 'invited_at'], ['lastContactAt', 'last_contact_at']]) { const v = isoOrNull(rec[k]); if (v && (!d[col] || new Date(v) > new Date(d[col]))) set[col] = v; }
  const phones = [...new Set([...d.phones, ...p.phones])], emails = [...new Set([...d.emails, ...p.emails])], conv = [...new Set([...d.conv_ids, ...p.convIds])];
  if (phones.length !== d.phones.length) set.phones = phones;
  if (emails.length !== d.emails.length) set.emails = emails;
  if (conv.length !== d.conv_ids.length) set.conv_ids = conv;
  if (rec.answers && typeof rec.answers === 'object' && Object.keys(rec.answers).length) {
    const merged = { ...d.answers, ...rec.answers };
    if (JSON.stringify(merged) !== JSON.stringify(d.answers)) set.answers = JSON.stringify(merged);
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
  if (Object.keys(set).length) {
    const cols = Object.keys(set);
    const at = isoOrNull(rec.updatedAt); // keep the real time of the activity (matters for imported backups)
    await c.query(`UPDATE drivers SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = GREATEST(updated_at, LEAST(COALESCE($2::timestamptz, now()), now())) WHERE id = $1`, [d.id, at, ...cols.map((k) => set[k])]);
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

module.exports = { pool, q, migrate, hashPassword, checkPassword, sha, token, keyOf, digits, mergeFromExtension, LOCKING };
