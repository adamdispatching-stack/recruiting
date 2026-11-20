// AI call suggestions for one lead (optional). Works only when the server has ANTHROPIC_API_KEY set
// (Railway, Variables). The key stays on the server; the browser never sees it.
const db = require('./db');
const lib = require('./lib');
const { q } = db;
const { wrap, needUser, loadDriver, record } = lib;

const TOOL = {
  name: 'call_prep',
  description: 'Prepare a recruiter for a phone call with one truck driver lead.',
  input_schema: {
    type: 'object',
    properties: {
      opener: { type: 'string', description: 'One friendly first sentence for the call, using what we know about the driver. Plain words, no em dashes.' },
      questions: { type: 'array', maxItems: 6, items: { type: 'object', properties: { ask: { type: 'string', description: 'The question, as the recruiter would say it' }, why: { type: 'string', description: 'Why it matters, a few words' } }, required: ['ask', 'why'] },
        description: 'The 3 to 6 most useful questions for THIS driver, most important first. Skip anything we already know. Aim: a driver who can start soon and stay.' },
      watch_out: { type: 'string', description: 'Concerns or objections to handle on this call (record, home time, pay, doubts they raised). Empty if none.' },
      close: { type: 'string', description: 'The one next step to agree before hanging up.' }
    },
    required: ['opener', 'questions', 'close']
  }
};
const SYSTEM = `You prepare recruiters at a trucking company for a short phone call with a CDL-A driver lead. The company runs regional Amazon freight (mostly power-only drop and hook) in the Northeast and needs drivers who can start soon to fill empty trucks. Use the company facts and the talking points. Never invent pay, dates or promises that are not in them. Never suggest asking for a Social Security number, date of birth, license number or bank details. Write plain, short, friendly sentences, the way a real dispatcher talks. No em dashes.`;

module.exports = (app) => {
  app.post('/api/drivers/:id/callprep', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(400).json({ error: 'AI call suggestions are off. To turn them on, add ANTHROPIC_API_KEY to the website settings on Railway (Variables).' });
    const notes = (await q(`SELECT body, kind, outcome, created_at FROM notes WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 12`, [d.id])).rows;
    const facts = {
      name: d.name, type: d.mode === 'Owner-operators' ? 'owner-operator' : d.mode === 'Company drivers' ? 'company driver' : 'not known yet', status: d.status,
      home: [d.location, d.zip].filter(Boolean).join(' '), cdl_years: d.exp_years, drove: d.experience, own_truck: [d.truck_year, d.truck_model].filter(Boolean).join(' '),
      weeks_out: d.weeks_out, days_home: d.days_home, medical_card_expires: d.med_expires, has_email: !!(d.emails || []).length, has_phone: !!(d.phones || []).length,
      answers_from_chat: d.answers || {}, ai_summary_from_chat: d.ai_summary || '', red_flags: d.red_flags || '', follow_up: d.follow_up,
      recent_notes: notes.map((n) => `${n.created_at.toISOString().slice(0, 10)} ${n.kind ? n.kind + (n.outcome ? ' ' + n.outcome : '') + ': ' : ''}${n.body || ''}`.slice(0, 400))
    };
    const points = d.mode === 'Owner-operators' ? db.settings.callPoints.owner : d.mode === 'Company drivers' ? db.settings.callPoints.company : [...db.settings.callPoints.company, ...db.settings.callPoints.owner];
    const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 45000);
    let r;
    try {
      r = await fetch(base + '/v1/messages', { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.CALL_PREP_MODEL || 'claude-haiku-5-5', max_tokens: 900, system: SYSTEM, tools: [TOOL], tool_choice: { type: 'tool', name: 'call_prep' },
          messages: [{ role: 'user', content: `TALKING POINTS:\n- ${points.join('\n- ')}\n\nTHE LEAD (JSON):\n${JSON.stringify(facts)}` }] }) });
    } catch (e) { return res.status(502).json({ error: e.name === 'AbortError' ? 'The AI did not answer in time. Try again.' : 'Could not reach the AI service.' }); }
    finally { clearTimeout(timer); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: `The AI service said: ${(j.error && j.error.message) || r.status}` });
    const out = ((j.content || []).find((c) => c.type === 'tool_use') || {}).input;
    if (!out || !Array.isArray(out.questions)) return res.status(502).json({ error: 'The AI answer could not be read. Try again.' });
    const prep = { opener: String(out.opener || '').slice(0, 400), questions: out.questions.slice(0, 6).map((x) => ({ ask: String(x.ask || '').slice(0, 300), why: String(x.why || '').slice(0, 160) })).filter((x) => x.ask),
      watchOut: String(out.watch_out || '').slice(0, 500), close: String(out.close || '').slice(0, 300) };
    await q(`UPDATE drivers SET call_prep = $2, call_prep_at = now() WHERE id = $1`, [d.id, JSON.stringify(prep)]);
    await record(req, 'edit', d, 'AI call suggestions prepared');
    res.json({ ok: true, callPrep: prep });
  }));
};
