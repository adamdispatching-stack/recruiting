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
  return { today, week, month, projected: t.dom ? (month.cost / t.dom) * t.dim : 0, budget, days,
    byFeature: group('feature', d30).map((x) => ({ ...x, name: NAMES[x.key] || x.key })), byModel: group('model', d30), bySource: group('source', d30),
    unknownModels: [...unknown], prices: prices(), serverKey: !!process.env.ANTHROPIC_API_KEY };
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
module.exports = { recheck: () => { lastCheck = 0; }, report, checkBudget, addExtension, record, cost, priceOf, prices, PRICES, NAMES };
