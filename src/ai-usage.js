// What the AI costs: every call the website and the Telegram bot make to Claude (tokens, model, what it was for),
// and the daily totals the Chrome extension reports for its own key. Prices per million tokens are in Settings
// (aiPrices) and can be changed; the cost is worked out from the tokens with today's prices.
const db = require('./db');
const { q } = db;

// USD per million tokens: input, output, cache read, cache write (Anthropic's list prices, November 2026)
const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cr: 0.01, cw: 0.125, longIn: 0.50, longOut: 2.50 },
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.10, cw: 2.50 },
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.20, cw: 5 },
  'claude-sonnet-5': { in: 3, out: 15, cr: 0.30, cw: 3.75 },
  'claude-haiku-4-5': { in: 1, out: 5, cr: 0.10, cw: 1.25 }
};
const NAMES = {
  group_digest: 'Reading the driver groups', day_summary: 'Daily group summaries', driver_profile: 'Driver profiles for dispatchers', dispatcher_profile: 'Dispatcher profiles',
  reply_plan: 'Answering drivers in onboarding', onboarding_doc: 'Reading onboarding screenshots and reports', document_kind: 'Sorting documents (ELD groups)', call_prep: 'Call guide on a lead',
  reply_decision: 'Indeed auto-reply', reply: 'Indeed reply drafts (side panel)', update_lessons: 'Auto-reply lessons'
};
const prices = () => ({ ...PRICES, ...((db.settings || {}).aiPrices || {}) });
const priceOf = (model) => { const p = prices(); return p[model] || p[Object.keys(p).find((k) => String(model || '').startsWith(k))] || null; };
function cost(r) {
  const p = priceOf(r.model); if (!p) return null;
  const long = p.longIn && r.calls === 1 && +r.input_tokens > 100000;
  return (+r.input_tokens * (long ? p.longIn : p.in) + +r.output_tokens * (long ? p.longOut : p.out) + +r.cache_read * (p.cr || 0) + +r.cache_write * (p.cw || 0)) / 1e6;
}
// one call from the server (never throws)
async function record({ source, feature, model, usage, ok = true }) {
  try {
    const u = usage || {};
    await q(`INSERT INTO ai_usage (day, source, feature, model, calls, failed, input_tokens, output_tokens, cache_read, cache_write)
      VALUES ((now() AT TIME ZONE $9)::date, $1, $2, $3, 1, $4, $5, $6, $7, $8)`,
    [source, feature || 'other', model || 'unknown', ok ? 0 : 1, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0, db.settings.tz]);
  } catch (e) { console.error('ai usage', e.message); }
  checkBudget().catch(() => {});
}
// the Chrome extension's daily totals: { day, model, feature, calls, failed, in, out, cr, cw } per row; adds to what is there
async function addExtension(rows, account) {
  for (const r of (rows || []).slice(0, 500)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.day || ''))) continue;
    await q(`INSERT INTO ai_usage (day, source, feature, model, account, calls, failed, input_tokens, output_tokens, cache_read, cache_write) VALUES ($1, 'extension', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [r.day, String(r.feature || 'other').slice(0, 40), String(r.model || 'unknown').slice(0, 60), account || null, +r.calls || 0, +r.failed || 0, +r.in || 0, +r.out || 0, +r.cr || 0, +r.cw || 0]);
    // why the extension's calls failed (extension 1.28.0+): "status|type|message"
    if (+r.failed > 0 && r.err) {
      const [st, type, ...m] = String(r.err).split('|'); const message = m.join('|').slice(0, 500);
      const x = require('./claude').explain(+st || 0, type, message);
      await q(`INSERT INTO ai_errors (source, feature, model, status, kind, message, why, tries) VALUES ('extension', $1, $2, $3, $4, $5, $6, $7)`,
        [String(r.feature || 'other').slice(0, 40), String(r.model || 'unknown').slice(0, 60), +st || null, x.kind, message,
          (x.kind === 'model' ? 'The extension\'s key cannot use this model.' : x.why).replace('ANTHROPIC_API_KEY on Railway (Variables)', 'the extension (AI settings)') + (account ? ` (Chrome profile: ${account})` : ''), +r.failed]);
    }
  }
}
// the report for admins: today, 7 days, this month (and where it is heading), by purpose, model, part, day by day
async function report() {
  const tz = db.settings.tz;
  const t = (await q(`SELECT (now() AT TIME ZONE $1)::date::text today, date_trunc('month', now() AT TIME ZONE $1)::date::text m0, extract(day FROM now() AT TIME ZONE $1)::int dom,
    extract(day FROM (date_trunc('month', now() AT TIME ZONE $1) + interval '1 month - 1 day'))::int dim`, [tz])).rows[0];
  const rows = (await q(`SELECT day::text AS day, source, feature, model, sum(calls)::int calls, sum(failed)::int failed, sum(input_tokens)::bigint input_tokens, sum(output_tokens)::bigint output_tokens,
      sum(cache_read)::bigint cache_read, sum(cache_write)::bigint cache_write FROM ai_usage WHERE day > (now() AT TIME ZONE $1)::date - 60 GROUP BY 1, 2, 3, 4`, [tz])).rows;
  // calls over 100k input tokens are priced on their own (Haiku 5.5 long prompts)
  const long = (await q(`SELECT day::text AS day, model, sum(input_tokens)::bigint i, sum(output_tokens)::bigint o FROM ai_usage WHERE calls = 1 AND input_tokens > 100000 AND day > (now() AT TIME ZONE $1)::date - 60 GROUP BY 1, 2`, [tz])).rows;
  const unknown = new Set();
  const c = (r) => { const v = cost({ ...r, calls: 2 }); if (v === null) { unknown.add(r.model); return 0; } return v; };
  let extra = 0; const extraBy = {};
  for (const l of long) { const p = priceOf(l.model); if (p && p.longIn) { const add = (+l.i * (p.longIn - p.in) + +l.o * (p.longOut - p.out)) / 1e6; extraBy[l.day] = (extraBy[l.day] || 0) + add; extra += add; } }
  const sum = (f) => rows.filter(f).reduce((a, r) => ({ cost: a.cost + c(r), calls: a.calls + r.calls, failed: a.failed + r.failed, tokens: a.tokens + +r.input_tokens + +r.output_tokens }), { cost: 0, calls: 0, failed: 0, tokens: 0 });
  const d7 = new Date(new Date(t.today + 'T12:00:00Z') - 6 * 864e5).toISOString().slice(0, 10), d30 = new Date(new Date(t.today + 'T12:00:00Z') - 29 * 864e5).toISOString().slice(0, 10);
  const xs = (from) => Object.entries(extraBy).filter(([d]) => d >= from).reduce((a, [, v]) => a + v, 0);
  const today = sum((r) => r.day === t.today); today.cost += extraBy[t.today] || 0;
  const week = sum((r) => r.day >= d7); week.cost += xs(d7);
  const month = sum((r) => r.day >= t.m0); month.cost += xs(t.m0);
  const group = (key, from) => { const g = {}; for (const r of rows.filter((x) => x.day >= from)) { const k = r[key]; g[k] = g[k] || { key: k, cost: 0, calls: 0, failed: 0, in: 0, out: 0 }; g[k].cost += c(r); g[k].calls += r.calls; g[k].failed += r.failed; g[k].in += +r.input_tokens; g[k].out += +r.output_tokens; }
    return Object.values(g).sort((a, b) => b.cost - a.cost || b.calls - a.calls); };
  const days = []; for (let i = 29; i >= 0; i--) { const d = new Date(new Date(t.today + 'T12:00:00Z') - i * 864e5).toISOString().slice(0, 10); const s2 = sum((r) => r.day === d); days.push({ day: d, cost: s2.cost + (extraBy[d] || 0), calls: s2.calls }); }
  const budget = +((db.settings.ai || {}).budget || 0);
  return { dailyCap: +((db.settings.ai || {}).dailyCap || 0), today, week, month, projected: t.dom ? (month.cost / t.dom) * t.dim : 0, budget, days,
    byFeature: group('feature', d30).map((x) => ({ ...x, name: NAMES[x.key] || x.key })), byModel: group('model', d30), bySource: group('source', d30),
    unknownModels: [...unknown], prices: prices(), serverKey: !!process.env.ANTHROPIC_API_KEY, state: require('./claude').state(),
    jobs: (await q(`WITH x AS (SELECT feature, source, max(at) FILTER (WHERE failed = 0 AND calls > 0) ok_at, max(at) FILTER (WHERE failed > 0) bad_at FROM ai_usage WHERE feature <> 'test' AND day > (now() AT TIME ZONE $1)::date - 30 GROUP BY 1, 2)
      SELECT x.*, (SELECT coalesce(sum(failed), 0)::int FROM ai_usage u WHERE u.feature = x.feature AND u.source = x.source AND u.day > (now() AT TIME ZONE $1)::date - 30 AND (x.ok_at IS NULL OR u.at > x.ok_at)) since FROM x ORDER BY greatest(ok_at, bad_at) DESC NULLS LAST`, [tz])).rows.map((x) => ({ ...x, name: NAMES[x.feature] || x.feature })),
    day: (await q(`SELECT coalesce(sum(calls - failed), 0)::int ok, coalesce(sum(failed), 0)::int failed FROM ai_usage WHERE at > now() - interval '24 hours' AND source <> 'extension' AND feature <> 'test'`)).rows[0],
    errors: (await q(`SELECT why, kind, max(status) status, sum(CASE WHEN source = 'extension' THEN tries ELSE 1 END)::int n, max(at) last, string_agg(DISTINCT feature, ', ') features, string_agg(DISTINCT model, ', ') models, (array_agg(message ORDER BY id DESC))[1] message
      FROM ai_errors WHERE at > now() - interval '7 days' GROUP BY why, kind ORDER BY max(at) DESC LIMIT 10`)).rows };
}
// over the monthly budget (80% and 100%): the admins are told once each month
let lastCheck = 0;
async function checkBudget() {
  const budget = +((db.settings.ai || {}).budget || 0); if (!budget) return;
  if (Date.now() - lastCheck < 10 * 60000) return; lastCheck = Date.now();
  const r = await report(); const m = (await q(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM') m`, [db.settings.tz])).rows[0].m;
  for (const lvl of [100, 80]) {
    if (r.month.cost < budget * lvl / 100) continue;
    const key = `aibudget:${m}:${lvl}`;
    if (!(await q(`INSERT INTO tg_state (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`, [key])).rows[0]) break;
    for (const a of (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows) await db.notify(db.pool, a.id, 'admin', `AI cost this month: $${r.month.cost.toFixed(2)}, ${lvl}% of the $${budget} budget (heading to about $${r.projected.toFixed(0)}).`, '#/ai');
    break;
  }
}
// The daily cap: what the server's own AI calls cost today (checked at most once a minute). Over the cap the AI stops
// until midnight (team time zone); the admins are told once that day. The Chrome extension's calls use its own key.
let capAt = 0, capCost = 0;
async function todayCost(fresh = false) {
  if (!fresh && Date.now() - capAt < 60000) return capCost;
  const rows = (await q(`SELECT model, calls, input_tokens, output_tokens, cache_read, cache_write FROM ai_usage WHERE day = (now() AT TIME ZONE $1)::date AND source <> 'extension'`, [db.settings.tz])).rows;
  capCost = rows.reduce((a, r) => a + (cost(r) || 0), 0); capAt = Date.now();
  return capCost;
}
async function overCap() {
  const cap = +((db.settings.ai || {}).dailyCap || 0); if (!cap) return null;
  const c = await todayCost(); if (c < cap) return null;
  const day = (await q(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') d`, [db.settings.tz])).rows[0].d;
  if ((await q(`INSERT INTO tg_state (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`, ['aicap:' + day])).rows[0])
    for (const a of (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows) await db.notify(db.pool, a.id, 'admin', `The AI stopped for today: it reached the daily cap of $${cap} ($${c.toFixed(2)} spent). It starts again at midnight. Raise the cap on the AI usage page if this is normal use.`, '#/ai');
  return `The daily AI cap of $${cap} is reached ($${c.toFixed(2)} spent today). It starts again at midnight, or raise the cap on the AI usage page.`;
}
module.exports = { todayCost, overCap, recheck: () => { lastCheck = 0; }, report, checkBudget, addExtension, record, cost, priceOf, prices, PRICES, NAMES };
