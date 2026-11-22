// The safety net: one copy runs the jobs (the other takes over when it stops), a backup downloads and restores into
// an empty database, old raw messages setting, the hard daily AI cap. Starts its own servers.
//   node test/safety.js
const { execSync, spawn } = require('child_process'); const fs = require('fs'); const zlib = require('zlib');
const DBU = (n) => `postgresql://postgres@localhost:5433/${n}?host=/tmp`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
async function until(f, ms = 15000) { for (let i = 0; i < ms / 200; i++) { const v = await f().catch(() => null); if (v) return v; await sleep(200); } return null; }
const psql = (sql) => execSync(`su postgres -c "psql -q -h /tmp -p 5433 ${sql}"`, { stdio: 'ignore' });
const start = (port, db, log, extra = {}) => { const env = { ...process.env, DATABASE_URL: DBU(db), PGSSL: 'off', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-password-123', PORT: String(port), LEAD_RETRY_MS: '1000', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4', ...extra }; delete env.TELEGRAM_BOT_TOKEN;
  return spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')] }); };
const up = (port) => until(async () => (await fetch(`http://localhost:${port}/healthz`)).ok);

(async () => {
  execSync(`pkill -f "node src/serve[r].js" || true; sleep 0.4`); psql(`-c 'DROP DATABASE IF EXISTS recruiting_test' -c 'CREATE DATABASE recruiting_test' -c 'DROP DATABASE IF EXISTS recruiting_restore' -c 'CREATE DATABASE recruiting_restore'`);
  const a = start(3999, 'recruiting_test', '/tmp/server.log'); await up(3999);
  const b = start(3998, 'recruiting_test', '/tmp/server2.log'); await up(3998);
  const B = 'http://localhost:3999'; let cookie = '';
  const web = async (path, opts = {}) => { const r = await fetch((opts.base || B) + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; if (opts.raw) return r; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  await web('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });

  // ---------- one runner ----------
  const s1 = await web('/api/admin/safety'), s2 = await web('/api/admin/safety', { base: 'http://localhost:3998' });
  ok(s1.runner === true && s2.runner === false && /Another copy of the server runs/.test(fs.readFileSync('/tmp/server2.log', 'utf8')), 'two copies of the server: only the first runs the bot and the background jobs; the second serves the website');
  a.kill('SIGTERM');
  ok(await until(async () => a.exitCode === 0), 'on a deploy (SIGTERM) the server stops cleanly');
  ok(await until(async () => (await web('/api/admin/safety', { base: 'http://localhost:3998' })).runner === true), 'the second copy takes over the jobs within seconds');
  b.kill('SIGTERM'); await until(async () => b.exitCode !== null);
  const c = start(3999, 'recruiting_test', '/tmp/server.log'); await up(3999);

  // ---------- backup and restore ----------
  const d1 = (await web('/api/drivers', { method: 'POST', body: { name: 'Backup Bob', phone: '2155550111', email: 'bob@example.com', source: 'Indeed' } })).id;
  await web(`/api/drivers/${d1}/notes`, { method: 'POST', body: { body: 'Remember this note' } });
  await web('/api/kb', { method: 'POST', body: { kind: 'general', question: 'When is pay day?', answer: 'Every Friday.' } });
  await web('/api/tg/desk', { method: 'PUT', body: { answerMin: 20 } });
  const r = await web('/api/admin/backup', { raw: true }); const buf = Buffer.from(await r.arrayBuffer());
  const lines = zlib.gunzipSync(buf).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok(r.status === 200 && /fleethire-backup-.*\.jsonl\.gz/.test(r.headers.get('content-disposition')) && lines[0].fleethire === 1 && lines[0].tables.includes('drivers') && !lines[0].tables.includes('sessions') && !lines[0].tables.includes('api_keys'), 'an admin downloads a backup: every table, no sign-in sessions or access keys');
  ok(lines.some((l) => l.name === 'Backup Bob') && lines.some((l) => l.question === 'When is pay day?'), 'the backup holds the leads and the knowledge base');
  fs.writeFileSync('/tmp/backup-test.jsonl.gz', buf);
  // an empty database: start the website once so the tables exist, stop it, restore
  const e = start(3997, 'recruiting_restore', '/tmp/server3.log', { ADMIN_EMAIL: 'other@example.com' }); await up(3997); e.kill('SIGTERM'); await until(async () => e.exitCode !== null);
  let out = ''; try { out = execSync(`node scripts/restore.js /tmp/backup-test.jsonl.gz --yes`, { cwd: __dirname + '/..', env: { ...process.env, DATABASE_URL: DBU('recruiting_restore'), PGSSL: 'off' } }).toString(); } catch (er) { out = String(er.stderr || er.message); }
  ok(/Restored \d+ rows into \d+ tables/.test(out), 'restore into an empty database: ' + out.trim().slice(0, 90));
  const f = start(3997, 'recruiting_restore', '/tmp/server3.log'); await up(3997); const save = cookie; cookie = '';
  const R = 'http://localhost:3997';
  const li = await web('/api/login', { method: 'POST', base: R, body: { email: 'admin@example.com', password: 'test-password-123' } });
  const dl = (await web('/api/drivers', { base: R })).drivers || [];
  ok(li.status === 200 && dl.length === 1 && dl[0].name === 'Backup Bob' && dl[0].noteCount == 1, 'the restored website: the same admin signs in, the lead and its note are there');
  ok((await web('/api/kb', { base: R })).entries.some((x) => x.question === 'When is pay day?') && (await web('/api/tg/desk', { base: R })).desk.answerMin === 20, 'the knowledge base and the settings came back');
  const d2 = await web('/api/drivers', { method: 'POST', base: R, body: { name: 'New After', phone: '2155550112', source: 'Indeed' } });
  ok(d2.id > d1, 'new leads continue after the highest id (no clash)');
  f.kill('SIGTERM'); cookie = save;

  // ---------- settings ----------
  ok((await web('/api/admin/safety', { method: 'PUT', body: { backup: { tg: true, hour: 2 }, data: { keepMessagesDays: 10 } } })).status === 400, 'raw messages are kept at least 30 days');
  ok((await web('/api/admin/safety', { method: 'PUT', body: { backup: { tg: true, hour: 2 }, data: { keepMessagesDays: 180 } } })).ok && (await web('/api/admin/safety')).data.keepMessagesDays === 180 && (await web('/api/admin/safety')).backup.tg === true, 'nightly Telegram backup on, raw messages kept 180 days');
  await web('/api/users', { method: 'POST', body: { name: 'Rita R', email: 'rita@example.com', password: 'rita-pass-1234' } });
  const rc = (await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rita@example.com', password: 'rita-pass-1234' }) })).headers.get('set-cookie').split(';')[0];
  ok((await fetch(B + '/api/admin/backup', { headers: { Cookie: rc } })).status === 403, 'only an admin can download a backup');

  // ---------- the daily AI cap ----------
  const { Client } = require('pg'); const pg = new Client({ connectionString: DBU('recruiting_test') }); await pg.connect();
  ok((await web('/api/ai-usage')).dailyCap === 20, 'the daily AI cap starts at $20');
  await web('/api/ai-usage/settings', { method: 'PUT', body: { budget: 0, dailyCap: 1 } });
  await pg.query(`INSERT INTO ai_usage (day, source, feature, model, calls, input_tokens, output_tokens) VALUES ((now() AT TIME ZONE 'America/New_York')::date, 'bot', 'group_digest', 'claude-sonnet-5-5', 5, 900000, 90000)`);
  await sleep(300); const c2 = start(3996, 'recruiting_test', '/tmp/server4.log', { NO_JOBS: '1' }); await up(3996); // a fresh copy: no cached cost
  const t = await web('/api/kb/tidy', { method: 'POST', base: 'http://localhost:3996' });
  ok(t.status === 502 && /daily AI cap of \$1 is reached/.test(t.error || ''), 'over the cap the AI refuses to run: ' + String(t.error || t.status).slice(0, 70));
  ok(await until(async () => ((await web('/api/notices')).notices || []).some((n) => /The AI stopped for today/.test(n.text))), 'the admins are told once');
  ok(/Background jobs are off/.test(fs.readFileSync('/tmp/server4.log', 'utf8')), 'NO_JOBS=1: a copy that only serves the website');
  await pg.end(); c2.kill(); c.kill();
  await sleep(300); execSync('pkill -f "node src/serve[r].js" || true'); process.exit();
})().catch((e) => { console.error(e); execSync('pkill -f "node src/serve[r].js" || true'); process.exit(1); });
