// Backups you own: every table of the database in one compressed file (JSON lines, gzip).
// - Download it any time (Settings → Backups, admins).
// - Every night it can be sent to the admins in Telegram (a private chat with the bot), when turned on.
// Sign-in sessions and access keys are never in it. Uploaded files (driver papers, pictures) are in the download when
// asked for; never in the Telegram one. Restore: node scripts/restore.js <file> (into an empty database).
const zlib = require('zlib');
const db = require('./db');
const { q } = db;
const SKIP = new Set(['sessions', 'api_keys']);

async function tables() {
  return (await q(`SELECT table_name t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t).filter((t) => !SKIP.has(t));
}
// { buffer, name, tables, rows }
async function make({ files = false } = {}) {
  const gz = zlib.createGzip({ level: 6 }); const chunks = []; gz.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { gz.on('end', res); gz.on('error', rej); });
  const day = await require('./lib').today(); let rows = 0; const ts = await tables();
  gz.write(JSON.stringify({ fleethire: 1, madeAt: new Date().toISOString(), version: require('../package.json').version, files, tables: ts }) + '\n');
  for (const t of ts) {
    const cols = (await q(`SELECT column_name c, data_type d FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t])).rows;
    const bytea = cols.filter((c) => c.d === 'bytea').map((c) => c.c);
    const sel = cols.map((c) => (c.d === 'bytea' ? (files ? `encode("${c.c}", 'base64') AS "${c.c}"` : `NULL AS "${c.c}"`) : `"${c.c}"`)).join(', ');
    gz.write(JSON.stringify({ table: t, bytea }) + '\n');
    const total = +(await q(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
    for (let off = 0; off < total; off += 2000) {
      const r = await q(`SELECT to_jsonb(x) j FROM (SELECT ${sel} FROM "${t}" ORDER BY 1 LIMIT 2000 OFFSET ${off}) x`);
      for (const row of r.rows) { gz.write(JSON.stringify(row.j) + '\n'); rows++; }
    }
  }
  gz.end(); await done;
  return { buffer: Buffer.concat(chunks), name: `fleethire-backup-${day}${files ? '-with-files' : ''}.jsonl.gz`, tables: ts.length, rows };
}
const cfg = () => ({ tg: false, hour: 3, ...(db.settings.backup || {}) });
// every night (team time zone), once: to each admin who can be reached privately in Telegram
async function tick() {
  const c = cfg(); if (!c.tg) return;
  const bot = require('./tg/bot'); if (!bot.on()) return;
  const now = (await q(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') d, extract(hour FROM now() AT TIME ZONE $1)::int h`, [db.settings.tz])).rows[0];
  if (now.h < c.hour) return;
  if (!(await q(`INSERT INTO tg_state (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`, ['backup:' + now.d])).rows[0]) return;
  await sendNow();
}
async function sendNow() {
  const bot = require('./tg/bot'); const b = await make({ files: false });
  const admins = (await q(`SELECT u.id, u.name, (SELECT tg_id FROM tg_people p WHERE p.user_id = u.id ORDER BY seen_at DESC NULLS LAST LIMIT 1) tg_id FROM users u WHERE u.active AND u.role = 'admin'`)).rows;
  let sent = 0, why = '';
  if (b.buffer.length > 45e6) why = 'it is over 45 MB, too big for Telegram: download it on the website (Settings → Backups)';
  else for (const a of admins) { if (!a.tg_id) continue;
    try { await bot.sendFile(a.tg_id, { data: b.buffer, name: b.name, mime: 'application/gzip' }, `🗄 Nightly backup: ${b.rows} rows in ${b.tables} tables. Keep it somewhere safe.`); sent++; } catch (e) { why = e.message; } }
  if (!sent && !why) why = 'no admin has connected Telegram and opened a chat with the bot (/me CODE, then /start)';
  await db.saveSetting('backup', { ...cfg(), last: { at: new Date().toISOString(), bytes: b.buffer.length, rows: b.rows, sent, error: sent ? null : why } });
  if (!sent) for (const a of admins) await db.notify(db.pool, a.id, 'admin', `The nightly backup was not sent: ${why}`, '#/settings');
  return { sent, bytes: b.buffer.length, rows: b.rows, error: sent ? null : why };
}
module.exports = { make, tick, sendNow, cfg, tables };
