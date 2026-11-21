// AI for the Telegram bot (Claude). Works only when the server has ANTHROPIC_API_KEY.
// Pictures are read and forgotten: only what they are (a CDL, a registration…) is kept, never the numbers on them.
const on = () => !!process.env.ANTHROPIC_API_KEY;
const MODEL = () => process.env.TG_AI_MODEL || 'claude-haiku-5-5';
const SUMMARY_MODEL = () => process.env.TG_SUMMARY_MODEL || 'claude-sonnet-5-5';

async function ask({ model, system, content, tool, maxTokens = 800 }) {
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(base + '/v1/messages', { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, tools: [tool], tool_choice: { type: 'tool', name: tool.name }, messages: [{ role: 'user', content }] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || `AI error ${r.status}`);
    const use = (j.content || []).find((c) => c.type === 'tool_use'); if (!use) throw new Error('The AI gave no answer');
    return use.input;
  } finally { clearTimeout(t); }
}

// What document is in this picture or PDF?
const DOC_TOOL = { name: 'document_kind', description: 'Say what document this is.', input_schema: { type: 'object', properties: {
  kind: { type: 'string', enum: ['cdl', 'registration', 'eld_manual', 'paper_logs', 'eld_screen', 'bol', 'other'], description: 'cdl = commercial driver license; registration = truck or trailer registration (cab card); eld_manual = ELD instruction card or manual; paper_logs = blank or filled paper log book; eld_screen = an ELD app or tablet screen; bol = bill of lading or shipping paper' },
  note: { type: 'string', description: 'A few words on what it shows, WITHOUT any numbers, names or personal details (for example "front of a CDL" or "ELD app login screen").' } }, required: ['kind', 'note'] } };
async function docKind(buf, mime) {
  const block = mime === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: /png/.test(mime) ? 'image/png' : /webp/.test(mime) ? 'image/webp' : 'image/jpeg', data: buf.toString('base64') } };
  return ask({ model: MODEL(), system: 'You sort documents sent in a trucking company\'s Telegram group. Never repeat any number, name, address or ID from the document.', content: [block, { type: 'text', text: 'What is this?' }], tool: DOC_TOOL, maxTokens: 200 });
}

// The day of one group, in a few lines, with what is still open
const SUM_TOOL = { name: 'day_summary', description: 'Summary of one day in a group.', input_schema: { type: 'object', properties: {
  summary: { type: 'string', description: '2 to 6 short lines: what happened, what was decided, who did what. Plain sentences.' },
  issues: { type: 'array', items: { type: 'string' }, description: 'Things still open or going wrong that someone must act on. Empty if none.' },
  mood: { type: 'string', enum: ['good', 'neutral', 'unhappy', 'angry', 'unknown'], description: 'The driver\'s mood today.' } }, required: ['summary', 'issues', 'mood'] } };
async function summarize({ kind, driver, lines }) {
  const system = `You read the ${kind} Telegram group of a trucking company for one driver (${driver || 'unknown driver'}) and write the day's summary for the managers. Be short and concrete. Never include passwords, login details, license or account numbers.`;
  return ask({ model: SUMMARY_MODEL(), system, content: [{ type: 'text', text: lines.join('\n').slice(-60000) }], tool: SUM_TOOL, maxTokens: 900 });
}
module.exports = { on, docKind, summarize };
