// AI usage and cost: the website's calls (tokens, model, purpose), the extension's daily totals, prices, the budget.
//   node test/ai-usage.js
const http = require('http');
const { execSync, spawn } = require('child_process');
const BASE = 'http://localhost:3999', DB = 'postgresql://postgres@localhost:5433/recruiting_test?host=/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
  const j = JSON.parse(b); res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ content: [{ type: 'tool_use', name: j.tools[0].name, input: { opener: 'Hi', questions: [{ ask: 'How long have you driven?', why: 'experience' }], watch: [] } }], usage: { input_tokens: 2000000, output_tokens: 400000 } }));
}); }).listen(4998);
(async () => {
  execSync(`pkill -f "node src/serve[r].js" || true; sleep 0.4; su postgres -c "psql -q -h /tmp -p 5433 -c 'DROP DATABASE IF EXISTS recruiting_test' -c 'CREATE DATABASE recruiting_test'"`, { stdio: 'ignore' });
  spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env: { ...process.env, DATABASE_URL: DB, PGSSL: 'off', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-password-123', PORT: '3999', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4998' }, stdio: ['ignore', require('fs').openSync('/tmp/ai.log', 'w'), require('fs').openSync('/tmp/ai.log', 'a')], detached: true }).unref();
  let cookie = '';
  const web = async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(opts.key ? { Authorization: 'Bearer ' + opts.key } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (e) { /* starting */ } await sleep(250); }
  await web('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  const d = (await web('/api/drivers', { method: 'POST', body: { name: 'Al Usage', source: 'Indeed', phone: '2155550100' } })).id;
  const cp = await web(`/api/drivers/${d}/callprep`, { method: 'POST', body: {} });
  ok(cp.status === 200, 'the call guide used the AI');
  let r = await web('/api/ai-usage');
  // haiku 5.5: 2M in x $0.10 (over 100k tokens: $0.50) + 0.4M out x $0.50 ($2.50 long) = 2M*0.5 + 0.4M*2.5 = $1 + $1 = $2
  ok(r.today.calls === 1 && Math.abs(r.today.cost - 2) < 0.001, `the website's call: 1 call, $2 (a long prompt on Haiku 5.5): ${r.today.cost}`);
  ok(r.byFeature[0].name === 'Call guide on a lead' && r.bySource[0].key === 'website', 'by purpose and part');
  const key = (await web('/api/keys', { method: 'POST', body: { name: 'Chrome: Bobtail Indeed' } })).key;
  const today = r.days[r.days.length - 1].day;
  ok((await web('/api/ext/ai-usage', { method: 'POST', key, body: { rows: [{ day: today, model: 'claude-haiku-5-5', feature: 'reply_decision', calls: 40, failed: 1, in: 1000000, out: 200000 }] } })).ok, 'the extension sends its daily totals');
  r = await web('/api/ai-usage');
  const ar = r.byFeature.find((x) => x.key === 'reply_decision');
  ok(ar && ar.name === 'Indeed auto-reply' && ar.calls === 40 && Math.abs(ar.cost - 0.2) < 0.001 && r.bySource.some((x) => x.key === 'extension'), 'Indeed auto-reply: 40 calls, $0.20 (1M in x $0.10 + 0.2M out x $0.50)');
  ok(r.week.calls === 41 && r.week.failed === 1, '7 days: 41 calls, 1 failed');
  ok(r.days.length === 30 && r.projected >= r.month.cost, 'day by day; the month heading to more');
  ok((await web('/api/ext/ai-usage', { method: 'POST', key, body: { rows: [{ day: today, model: 'claude-mystery-9', feature: 'reply', calls: 2, in: 1000, out: 10 }] } })).ok, 'a model with no price');
  ok((await web('/api/ai-usage')).unknownModels.includes('claude-mystery-9'), 'is pointed out');
  ok((await web('/api/ai-usage/settings', { method: 'PUT', body: { prices: { 'claude-mystery-9': { in: 1, out: 2 } } } })).ok && !(await web('/api/ai-usage')).unknownModels.length, 'its price added on the page');
  ok((await web('/api/ai-usage/settings', { method: 'PUT', body: { prices: { 'claude-haiku-5-5': { in: 'x', out: 1 } } } })).status === 400, 'a wrong price is refused');
  ok((await web('/api/ai-usage/settings', { method: 'PUT', body: { budget: 2 } })).ok, 'a $2 monthly budget');
  await web(`/api/drivers/${d}/callprep`, { method: 'POST', body: {} }); await sleep(800);
  const nt = await web('/api/notices');
  ok((nt.notices || nt.items || []).some((n) => /AI cost this month: \$\d+\.\d\d, 100% of the \$2 budget/.test(n.text)), 'over the budget: the admins are told');
  ok((await web('/api/ai-usage')).budget === 2, 'the budget shows');
  execSync('pkill -f "node src/serve[r].js" || true');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
