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
// Onboarding: a screenshot or report the driver sent
const ONB_TOOL = { name: 'onboarding_doc', description: 'What this picture or PDF from a new driver shows.', input_schema: { type: 'object', properties: {
  kind: { type: 'string', enum: ['relay_screen', 'background_report', 'mvr', 'psp', 'drug_test', 'clearinghouse', 'cdl', 'medical_card', 'other'],
    description: 'relay_screen = Amazon Relay app, website or email about the Relay account or approval; background_report = a background check (for example from Accurate); mvr = motor vehicle record; psp = FMCSA Pre-employment Screening Program report; drug_test = drug test result; clearinghouse = FMCSA Drug and Alcohol Clearinghouse; cdl = driver license; medical_card = DOT medical card' },
  relay_stage: { type: 'string', enum: ['invite_email', 'account_created', 'profile_incomplete', 'background_check_pending', 'approved', 'not_approved', 'unknown'], description: 'Only for relay_screen: where the driver is with Amazon Relay.' },
  result: { type: 'string', enum: ['clear', 'issues', 'pending', 'unknown'], description: 'For reports and tests: clear = nothing against the driver; issues = something to review; pending = not finished.' },
  findings: { type: 'array', items: { type: 'string' }, description: 'For reports: what a hiring manager must know (for example "1 speeding ticket, 2024", "no accidents", "license valid"). NO names, numbers, addresses, dates of birth or IDs.' },
  expires: { type: 'string', description: 'Only for cdl or medical_card: the expiry date as YYYY-MM-DD, or empty.' },
  state: { type: 'string', description: 'Only for cdl: the 2-letter US state that issued it (like PA), or empty.' },
  note: { type: 'string', description: 'A few words on what it is, without personal details.' } }, required: ['kind', 'note'] } };
async function onbDoc(buf, mime) {
  const block = mime === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: /png/.test(mime) ? 'image/png' : /webp/.test(mime) ? 'image/webp' : 'image/jpeg', data: buf.toString('base64') } };
  return ask({ model: MODEL(), system: 'You help a trucking company onboard a new driver. You read what the driver sent and report only what matters for hiring. Never repeat any personal detail: no names, SSN, license or ID numbers, dates of birth, addresses.', content: [block, { type: 'text', text: 'What is this?' }], tool: ONB_TOOL, maxTokens: 500 });
}
// Onboarding: a message from the driver. Answer it if the facts cover it; otherwise say so.
const REPLY_TOOL = { name: 'reply_plan', description: 'How to handle the driver\'s message.', input_schema: { type: 'object', properties: {
  is_question: { type: 'boolean', description: 'The driver asks the company something or needs an answer.' },
  confident: { type: 'boolean', description: 'True only if the facts and knowledge below fully answer it.' },
  answer: { type: 'string', description: 'The answer to send, 1 to 3 short friendly sentences, plain English. Empty when not confident.' },
  progress: { type: 'string', enum: ['none', 'account_created', 'profile_done', 'background_submitted'], description: 'If the driver says they did an Amazon Relay step.' },
  mood: { type: 'string', enum: ['good', 'neutral', 'unhappy', 'angry'] } }, required: ['is_question', 'confident', 'answer', 'progress', 'mood'] } };
async function driverReply({ facts, knowledge, context, recent, text, role }) {
  const system = `${role || 'You are the onboarding assistant of a US trucking company, in a Telegram group with a new driver and the recruiters.'}
Answer the driver only from the facts and knowledge below. If they do not fully answer the question, or it needs a person's decision (exceptions, pay advances, dates, personal matters, complaints), set confident=false and leave answer empty: a recruiter will answer.
Never ask for or repeat SSN, license numbers, dates of birth or bank details; tell the driver to enter those only on Amazon's or Accurate's own website.
Keep answers short, warm and simple. Do not promise anything that is not in the facts.

COMPANY FACTS:
${facts.map((f) => '- ' + f).join('\n')}

KNOWLEDGE (questions the team answered before):
${knowledge.map((k) => `Q: ${k.question}\nA: ${k.answer}`).join('\n') || '(none yet)'}

THIS DRIVER:
${context}`;
  return ask({ model: MODEL(), system, content: [{ type: 'text', text: `Recent messages:\n${recent.join('\n')}\n\nThe driver's new message:\n${text}` }], tool: REPLY_TOOL, maxTokens: 500 });
}
// Reading a batch of new messages in a driver's group: truck issues, what to know about the driver, alerts
const DIGEST_TOOL = { name: 'group_digest', description: 'What the new messages mean for the company.', input_schema: { type: 'object', properties: {
  truck_events: { type: 'array', description: 'Truck problems, repairs and service mentioned in the NEW messages (not ones already listed as open, unless they changed).', items: { type: 'object', properties: {
    kind: { type: 'string', enum: ['breakdown', 'repair', 'maintenance', 'oil_change', 'tires', 'inspection', 'damage', 'warning_light', 'other'] },
    title: { type: 'string', description: 'A few words, like "Check engine light" or "Oil change at Speedco".' }, details: { type: 'string' },
    status: { type: 'string', enum: ['open', 'scheduled', 'fixed'], description: 'fixed = done (an oil change that was done is fixed).' }, odometer: { type: 'integer', description: 'Truck mileage at the time, if said.' }, cost: { type: 'number', description: 'Dollars, if said.' }, shop: { type: 'string' },
    paid: { type: 'boolean', description: 'true if they say it is paid, false if they say it still has to be paid; leave out if not said.' } }, required: ['kind', 'title', 'status'] } },
  fixed_issue_ids: { type: 'array', items: { type: 'integer' }, description: 'Ids of the open truck issues listed below that the new messages say are fixed or done.' },
  paid_ids: { type: 'array', items: { type: 'integer' }, description: 'Ids of the unpaid truck services listed below that the new messages say are now paid.' },
  odometer: { type: 'integer', description: 'The truck\'s current mileage (odometer), if someone says or shows it in the new messages.' },
  driver_notes: { type: 'array', description: 'Lasting things a new dispatcher must know about the driver, from the NEW messages: routines and requests (for example "wants a wake-up call at 7 AM"), loads he likes or refuses, home time wishes, how reliable he is, how he works, how to talk to him. Facts with evidence, said respectfully. Nothing about health, family, religion, politics or private life. Empty if nothing new.', items: { type: 'object', properties: {
    kind: { type: 'string', enum: ['routine', 'request', 'likes_loads', 'dislikes_loads', 'home_time', 'reliability', 'work_style', 'communication', 'other'] }, text: { type: 'string' } }, required: ['kind', 'text'] } },
  people: { type: 'array', description: 'ONLY for the people listed as "role not known yet": what each one is, when what they write makes it clear. Leave a person out when unsure.', items: { type: 'object', properties: {
    name: { type: 'string', description: 'Exactly as listed.' }, role: { type: 'string', enum: ['driver', 'dispatcher', 'eld', 'accounting', 'other'], description: 'driver = the driver of this group; dispatcher = gives loads, times, addresses, follows up; eld = logs and ELD; accounting = pay and settlements.' } }, required: ['name', 'role'] } },
  learned: { type: 'array', description: 'When a person from our team (not the bot) answered a question the driver asked in the NEW messages: the general question and the answer, reworded so they help any future driver (no names, dates, phone numbers or personal details). Leave out answers that only fit this driver.', items: { type: 'object', properties: {
    question: { type: 'string' }, answer: { type: 'string' } }, required: ['question', 'answer'] } },
  onboarding: { type: 'object', description: 'ONLY when ONBOARDING STEPS are listed in the instructions: where this driver\'s onboarding stands after all messages (earlier and new).', properties: {
    summary: { type: 'string', description: '2 or 3 sentences: where things stand, what was done, what is next.' },
    waiting_on: { type: 'string', enum: ['driver', 'recruiter', 'amazon', 'company', 'nobody'], description: 'Who has to act next.' },
    next_step: { type: 'string', description: 'The next concrete step, a few words.' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'Problems holding it up (a failed check, a missing document, the driver unsure...).' },
    open_questions: { type: 'array', items: { type: 'string' }, description: 'Questions the driver asked that nobody answered yet.' },
    driver_mood: { type: 'string', enum: ['good', 'neutral', 'unhappy', 'angry', 'unknown'] },
    start_date: { type: 'string', description: 'The day the driver will start: ready to roll, arriving, or coming in for orientation, as YYYY-MM-DD, ONLY if the messages say it (the latest one counts). Work out "Monday" or "next week Tuesday" from the date of the message that says it. Empty if not said.' },
    travel: { type: 'string', description: 'How and when the driver gets to us, a few words (for example "Greyhound, arrives Newark 6 PM Sunday" or "drives his own car"), ONLY if said. No ticket or confirmation numbers. Empty otherwise.' },
    license_state: { type: 'string', description: 'The 2-letter US state of the driver\'s CDL (like PA), ONLY if a message or a CDL picture shows it. Empty otherwise.' },
    zip: { type: 'string', description: 'The driver\'s home ZIP code (5 digits) for booking a drug test nearby, ONLY if the driver said it. Empty otherwise.' },
    done_steps: { type: 'array', description: 'Listed onboarding steps the messages clearly show are DONE (not just planned). Only ids from the list.', items: { type: 'object', properties: {
      id: { type: 'integer' }, evidence: { type: 'string', description: 'The words or picture that show it, short.' } }, required: ['id', 'evidence'] } } } },
  alerts: { type: 'array', description: 'Things the managers must know now.', items: { type: 'object', properties: {
    kind: { type: 'string', enum: ['container_mismatch', 'wrong_location', 'late_risk', 'appointment_change', 'load_refused', 'driver_upset', 'unprofessional_dispatcher', 'safety', 'other'] },
    severity: { type: 'string', enum: ['low', 'high'] }, text: { type: 'string', description: 'One clear sentence.' },
    ask_driver: { type: 'string', description: 'Only for container_mismatch or wrong_location: a short polite question to the driver to clear it up, for example "The photo shows container ABCU 102634 but the load is ABCU 102643. Is this the right one?"' } }, required: ['kind', 'severity', 'text'] } } },
  required: ['truck_events', 'driver_notes', 'alerts'] } };
async function digest({ kind, driver, truck, openIssues, unpaid = [], context, fresh, images, onb = null, unknown = [] }) {
  const system = `You read the ${kind} Telegram group of one truck driver (${driver}${truck ? `, truck ${truck}` : ''}) for a US trucking company, and pull out what the managers must know.
Only report what the NEW messages say; the earlier ones are context. Compare container, trailer and load numbers in the messages with the ones in the pictures: a different number is a container_mismatch.
Flag unprofessional_dispatcher only for clear rudeness, insults, or telling the driver to break rules. Appointment or pickup/delivery time changes are appointment_change.
Never include passwords, SSN, license or account numbers. Be factual and short.
Oil changes, shop visits and repairs are truck_events. "Oil change done" is an oil_change with status fixed; say paid=true when they say it is paid, and give the cost, shop and mileage when said. Do not repeat an event already listed below: mark it fixed (fixed_issue_ids) or paid (paid_ids) instead.
Open truck issues (id: title): ${openIssues.length ? openIssues.map((i) => `${i.id}: ${i.title}`).join('; ') : 'none'}
${unknown.length ? `People whose role is not known yet: ${unknown.join('; ')}.
` : ''}Truck services not marked paid yet (id: title, cost): ${unpaid.length ? unpaid.map((i) => `${i.id}: ${i.title}${i.cost !== null ? ' $' + i.cost : ''}`).join('; ') : 'none'}${onb ? `

This driver is ONBOARDING (not driving for us yet). Fill "onboarding" every time.
Today is ${onb.today}. Start date on the website: ${onb.start || 'not set'}.${onb.travel ? ` Travel details on the website: ${onb.travel}.` : ''}
Amazon Relay step: ${onb.amazon || 'invite not sent yet'}.${onb.last ? ` Last known status: ${onb.last}` : ''}
ONBOARDING STEPS still open (id: step): ${onb.steps.length ? onb.steps.map((x) => `${x.id}: ${x.label}`).join('; ') : 'none'}
Mark a step done only when a message or a picture clearly shows it is done (a result, a confirmation, a ticket, "done", "passed"), never when it is only planned or asked for.` : ''}`;
  const content = [...images.map((im) => (im.mime === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: im.data } } : { type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })),
    { type: 'text', text: `EARLIER MESSAGES (context):\n${context.join('\n') || '(none)'}\n\nNEW MESSAGES:\n${fresh.join('\n')}${images.length ? `\n\n(The ${images.length} picture(s) above are the photos in the new messages, in order.)` : ''}` }];
  return ask({ model: process.env.TG_DIGEST_MODEL || SUMMARY_MODEL(), system, content, tool: DIGEST_TOOL, maxTokens: 1500 });
}
// The driver's profile for dispatchers, rebuilt from the notes
const PROFILE_TOOL = { name: 'driver_profile', description: 'What a dispatcher needs to know about this driver.', input_schema: { type: 'object', properties: {
  summary: { type: 'string', description: '2 to 4 sentences: who this driver is to work with.' },
  reliability: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
  supervision: { type: 'string', enum: ['self_driven', 'light_check_ins', 'needs_close_follow_up', 'unknown'] },
  work_style: { type: 'string', description: 'For example "Runs long weeks, rarely refuses loads" or "Prefers short days".' },
  routines: { type: 'array', items: { type: 'string' } }, requests: { type: 'array', items: { type: 'string' } },
  likes_loads: { type: 'array', items: { type: 'string' } }, dislikes_loads: { type: 'array', items: { type: 'string' } },
  home_time: { type: 'string' }, communication: { type: 'string' },
  tips_for_dispatchers: { type: 'array', items: { type: 'string' }, description: 'Concrete do\'s for a new dispatcher.' },
  watch_outs: { type: 'array', items: { type: 'string' }, description: 'Things to keep an eye on.' } },
  required: ['summary', 'reliability', 'supervision', 'work_style', 'routines', 'requests', 'likes_loads', 'dislikes_loads', 'home_time', 'communication', 'tips_for_dispatchers', 'watch_outs'] } };
async function profile({ driver, previous, pins, notes, summaries }) {
  const system = `You keep the profile of one truck driver for a trucking company's dispatchers, so a new dispatcher knows how to work with him from day one.
Base it only on the evidence below. The team's own notes (PINNED) are true and come first. Newer notes win over older ones. Say "unknown" where there is no evidence.
Be fair and respectful: describe behaviour, not character. Nothing about health, family, religion, politics or private life.`;
  const text = `DRIVER: ${driver}\n\nPINNED (from the team):\n${pins || '(none)'}\n\nPREVIOUS PROFILE:\n${previous ? JSON.stringify(previous) : '(none)'}\n\nNOTES FROM THE GROUPS (oldest first):\n${notes.join('\n') || '(none)'}\n\nRECENT DAILY SUMMARIES:\n${summaries.join('\n') || '(none)'}`;
  return ask({ model: SUMMARY_MODEL(), system, content: [{ type: 'text', text: text.slice(-80000) }], tool: PROFILE_TOOL, maxTokens: 1500 });
}
module.exports = { on, docKind, summarize, onbDoc, driverReply, digest, profile };
