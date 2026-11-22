// One way to call Claude for the whole server (Telegram bot, call guide, the test button on the AI usage page).
// - temporary problems (busy, rate limit, network, timeout) are tried again, up to 4 times, waiting a little longer each time
// - a model this key cannot use is swapped for the next one in its list, and the swap is remembered
// - every failure is saved with the reason in plain words (ai_errors), shown on the AI usage page
// - when the key or the account is the problem (wrong key, no credit, no access) the AI is paused for 10 minutes so the bot
//   does not keep making failed calls, and the admins are told once what to fix
const BACKUP = {
  'claude-haiku-5-5': ['claude-sonnet-5-5', 'claude-haiku-4-5'],
  'claude-sonnet-5-5': ['claude-sonnet-5', 'claude-haiku-5-5', 'claude-haiku-4-5'],
  'claude-opus-5-5': ['claude-sonnet-5-5', 'claude-sonnet-5']
};
const swap = {}; // model asked for -> model that works with this key
// models that do not take a forced tool call (tool_choice "tool"/"any", e.g. Sonnet 5.5): they get tool_choice "auto"
// and are told to answer with the tool; if one still answers in words, it is asked once more
const noForce = new Set();
const unforced = (body) => {
  const name = body.tool_choice.name || (body.tools[0] || {}).name;
  return { ...body, tool_choice: { type: 'auto' }, system: `${body.system ? body.system + '\n\n' : ''}Answer ONLY by calling the ${name} tool, once. Do not write any text.` };
};
let pausedUntil = 0, pauseWhy = null, toldAt = 0;
let lastOk = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const on = () => !!process.env.ANTHROPIC_API_KEY;

// what went wrong, in plain words, and what to do about it
function explain(status, type, message) {
  const m = String(message || '');
  if (status === 0) return { kind: 'retry', why: 'Could not reach Anthropic (network or timeout).' };
  if (status === 401 || type === 'authentication_error') return { kind: 'account', why: 'The API key is wrong or was deleted. Make a new key at console.anthropic.com → API keys and put it in ANTHROPIC_API_KEY on Railway (Variables).' };
  if (/credit balance|billing|purchase credits|plans & billing/i.test(m)) return { kind: 'account', why: 'The Anthropic account has no credit. Add credit at console.anthropic.com → Billing. Nothing else needs changing.' };
  if (status === 403 || type === 'permission_error') return { kind: 'account', why: 'This key is not allowed to do this (the workspace or organization blocks it). Check the key\'s workspace at console.anthropic.com.' };
  if (status === 404 || type === 'not_found_error' || /model/i.test(m) && /not found|does not exist|not available|invalid model/i.test(m)) return { kind: 'model', why: 'This key cannot use this model.' };
  if (status === 429 || type === 'rate_limit_error') return { kind: 'retry', why: 'Too many calls at once (rate limit). Tried again later.' };
  if (status === 529 || type === 'overloaded_error' || status >= 500) return { kind: 'retry', why: 'Anthropic was busy. Tried again later.' };
  if (status === 413 || type === 'request_too_large') return { kind: 'bad', why: 'The request was too big.' };
  return { kind: 'bad', why: 'The AI could not use this request: ' + m.slice(0, 200) };
}

async function saveError(x) {
  try {
    const db = require('./db');
    await db.q(`INSERT INTO ai_errors (source, feature, model, status, kind, message, why, tries) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [x.source, x.feature, x.model, x.status || null, x.kind, String(x.message || '').slice(0, 500), x.why, x.tries || 1]);
    await db.q(`DELETE FROM ai_errors WHERE id < (SELECT min(id) FROM (SELECT id FROM ai_errors ORDER BY id DESC LIMIT 300) k)`);
  } catch (e) { console.error('ai error save', e.message); }
}
async function tellAdmins(why) {
  if (Date.now() - toldAt < 6 * 3600e3) return; toldAt = Date.now();
  try {
    const db = require('./db');
    const admins = (await db.q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows;
    for (const a of admins) await db.notify(db.pool, a.id, 'ai', `The AI is not working: ${why}`, '#/ai');
  } catch (e) { console.error('ai tell', e.message); }
}

// body: the Messages API body without model. Returns the API answer (JSON). Throws an Error with .kind and .why.
async function call({ source = 'bot', feature = 'other', model, body, timeout = 60000, force = false }) {
  const usage = require('./ai-usage');
  if (!on()) { const e = new Error('AI is off: add ANTHROPIC_API_KEY on Railway'); e.kind = 'account'; e.why = e.message; throw e; }
  if (!force && Date.now() < pausedUntil) { const e = new Error('AI paused: ' + pauseWhy); e.kind = 'paused'; e.why = pauseWhy; throw e; }
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const models = [swap[model] || model, ...(BACKUP[model] || [])].filter((m, i, a) => a.indexOf(m) === i);
  let mi = 0, tries = 0, last = null, nudged = false;
  const forced = body.tool_choice && ['tool', 'any'].includes(body.tool_choice.type);
  let extra = null; // a second ask when the model answered in words
  const send = (use) => { let b = forced && noForce.has(use) ? unforced(body) : body; if (extra) b = { ...b, messages: [...b.messages, ...extra] }; return { ...b, model: use }; };
  const waits = [2000, 6000, 15000];
  for (;;) {
    const use = models[mi]; tries++;
    let status = 0, j = {}, retryAfter = 0;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(base + '/v1/messages', { method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(send(use)) });
      status = r.status; retryAfter = +(r.headers.get('retry-after') || 0);
      j = await r.json().catch(() => ({}));
      if (r.ok && forced && noForce.has(use) && !(j.content || []).some((c) => c.type === 'tool_use') && !nudged) {
        nudged = true; await usage.record({ source, feature, model: use, usage: j.usage, ok: true });
        extra = [{ role: 'assistant', content: j.content && j.content.length ? j.content : [{ type: 'text', text: '...' }] }, { role: 'user', content: `Answer with the ${body.tool_choice.name} tool now.` }];
        continue;
      }
      if (r.ok) {
        if (use !== model) swap[model] = use;
        lastOk = { at: new Date().toISOString(), model: use };
        await usage.record({ source, feature, model: use, usage: j.usage, ok: true });
        return j;
      }
    } catch (e) { status = 0; j = { error: { message: e.name === 'AbortError' ? 'timed out' : e.message } }; }
    finally { clearTimeout(t); }
    const err = j.error || {};
    if (status === 400 && forced && !noForce.has(use) && /tool_choice/i.test(err.message || '') && /not supported/i.test(err.message || '')) { noForce.add(use); tries--; continue; }
    const x = explain(status, err.type, err.message);
    last = { status, type: err.type, message: err.message || `HTTP ${status}`, ...x, model: use };
    if (x.kind === 'model' && mi < models.length - 1) { mi++; continue; }
    if (x.kind === 'retry' && tries <= waits.length) { await sleep(Math.min(Math.max(retryAfter * 1000, waits[tries - 1]), 30000)); continue; }
    break;
  }
  // failed for good: count it once, save why
  await usage.record({ source, feature, model: last.model, usage: null, ok: false });
  if (last.kind === 'model') last.why = `This key cannot use ${models.join(' or ')}. Check the models your key has at console.anthropic.com.`;
  await saveError({ source, feature, model: last.model, status: last.status, kind: last.kind, message: last.message, why: last.why, tries });
  if (last.kind === 'account' || last.kind === 'model') { pausedUntil = Date.now() + 10 * 60e3; pauseWhy = last.why; await tellAdmins(last.why); }
  const e = new Error(last.message); e.kind = last.kind; e.why = last.why; e.status = last.status; throw e;
}
const state = () => ({ noForce: [...noForce], on: on(), paused: Date.now() < pausedUntil ? { until: new Date(pausedUntil).toISOString(), why: pauseWhy } : null, lastOk, swapped: { ...swap } });
function unpause() { pausedUntil = 0; pauseWhy = null; }

// the Test button: a tiny call to each model, then one real call for each job the AI does (same tool, same model)
async function test() {
  unpause();
  const out = [], jobs = [];
  for (const model of [...new Set([process.env.TG_AI_MODEL || 'claude-haiku-5-5', process.env.TG_SUMMARY_MODEL || 'claude-sonnet-5-5'])]) {
    try {
      const j = await call({ source: 'website', feature: 'test', model, force: true, timeout: 30000,
        body: { max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the word OK.' }] } });
      out.push({ model, ok: true, used: j.model || swap[model] || model });
    } catch (e) { out.push({ model, ok: false, why: e.why || e.message, status: e.status || null }); }
  }
  const list = [...require('./tg/ai').jobs(), [require('./api-call').TOOL, process.env.CALL_PREP_MODEL || 'claude-haiku-5-5']];
  const names = require('./ai-usage').NAMES;
  await Promise.all(list.map(async ([tool, model]) => {
    try {
      const j = await call({ source: 'website', feature: 'test', model, force: true, timeout: 90000,
        body: { max_tokens: 1500, system: 'This is a test of a trucking company tool. Fill the tool with short made-up test values.', tools: [tool], tool_choice: { type: 'tool', name: tool.name },
          messages: [{ role: 'user', content: '[#1 Sun Nov 22 08:00] Driver: Hi, I will be ready to start Monday, truck 118 needs an oil change.' }] } });
      const ok = (j.content || []).some((c) => c.type === 'tool_use');
      jobs.push({ job: names[tool.name] || tool.name, model: j.model || model, ok, why: ok ? '' : 'The AI did not fill the form.' });
    } catch (e) { jobs.push({ job: names[tool.name] || tool.name, model, ok: false, why: e.why || e.message }); }
  }));
  return { models: out, jobs };
}
module.exports = { call, on, state, test, unpause, explain };
