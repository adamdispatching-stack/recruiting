// Restore a FleetHire backup into an EMPTY database (a new one: start the website once on it so the tables exist,
// stop it, then run this). Everything in the database's tables is replaced by the backup.
//   DATABASE_URL=postgres://... node scripts/restore.js fleethire-backup-2026-11-22.jsonl.gz --yes
const fs = require('fs'); const zlib = require('zlib'); const readline = require('readline');
const [, , file, yes] = process.argv;
if (!file || yes !== '--yes') { console.error('Usage: DATABASE_URL=... node scripts/restore.js <backup file> --yes\nThis REPLACES everything in that database.'); process.exit(1); }
const { Pool } = require('pg'); const url = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1|\/tmp|railway\.internal/.test(url) || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false } });
(async () => {
  const c = await pool.connect(); const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let head = null, table = null, bytea = [], cols = null, types = null, n = 0, per = {};
  await c.query('BEGIN'); await c.query(`SET session_replication_role = replica`); // no triggers, no foreign-key checks while loading
  for await (const line of rl) {
    if (!line) continue; const j = JSON.parse(line);
    if (!head) { head = j; if (!j.fleethire) throw new Error('Not a FleetHire backup'); const have = (await c.query(`SELECT table_name t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((r) => r.t);
      const known = j.tables.filter((t) => have.includes(t)); if (known.length) await c.query(`TRUNCATE ${known.map((t) => `"${t}"`).join(', ')} CASCADE`); head.have = have; continue; }
    if (j.table && j.bytea) { table = head.have.includes(j.table) ? j.table : null; bytea = j.bytea; cols = null;
      if (table) types = Object.fromEntries((await c.query(`SELECT column_name c, data_type d, udt_name u FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table])).rows.map((r) => [r.c, r])); else console.warn('skipped (no such table here):', j.table);
      continue; }
    if (!table) continue;
    cols = Object.keys(j).filter((k) => types[k]);
    const vals = cols.map((k) => { const v = j[k]; if (v === null) return null; const t = types[k];
      if (bytea.includes(k)) return Buffer.from(v, 'base64');
      if (t.d === 'jsonb' || t.d === 'json') return JSON.stringify(v);
      return v; });
    const ph = cols.map((k, i) => (types[k].d === 'ARRAY' ? `$${i + 1}::${types[k].u.replace(/^_/, '')}[]` : `$${i + 1}`));
    // a file column left out of the backup (no files): an empty value where the column must not be empty
    for (const k of bytea) { const i = cols.indexOf(k); if (i >= 0 && vals[i] === null) vals[i] = Buffer.alloc(0); }
    await c.query(`INSERT INTO "${table}" (${cols.map((k) => `"${k}"`).join(', ')}) VALUES (${ph.join(', ')})`, vals); n++; per[table] = (per[table] || 0) + 1;
  }
  // the counters continue after the highest id
  for (const r of (await c.query(`SELECT table_name t, column_name col, pg_get_serial_sequence(format('%I', table_name), column_name) s FROM information_schema.columns WHERE table_schema = 'public' AND column_default LIKE 'nextval%'`)).rows)
    if (r.s) await c.query(`SELECT setval($1, GREATEST((SELECT coalesce(max("${r.col}"), 0) FROM "${r.t}"), 1))`, [r.s]);
  await c.query(`SET session_replication_role = DEFAULT`); await c.query('COMMIT'); c.release(); await pool.end();
  console.log(`Restored ${n} rows into ${Object.keys(per).length} tables from the backup of ${head.madeAt} (version ${head.version}).${head.files ? '' : ' Uploaded files were not in this backup.'} Everyone signs in again.`);
})().catch((e) => { console.error('Restore failed, nothing was changed:', e.message); process.exit(1); });
