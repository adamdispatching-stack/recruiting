// AI for the Telegram bot (Claude). Works only when the server has ANTHROPIC_API_KEY.
// Pictures are read and forgotten: only what they are (a CDL, a registration…) is kept, never the numbers on them.
const on = () => !!process.env.ANTHROPIC_API_KEY;
const MODEL = () => process.env.TG_AI_MODEL || 'claude-haiku-5-5';
const SUMMARY_MODEL = () => process.env.TG_SUMMARY_MODEL || 'claude-sonnet-5-5'; // deep work: driver profiles, dispatcher reviews
// reading the groups and the daily summaries: simple work, done with the cheap model (about 20 times cheaper)
const DIGEST_MODEL = () => process.env.TG_DIGEST_MODEL || MODEL();
const DAY_MODEL = () => process.env.TG_DAY_MODEL || MODEL();

// cache: the form and the fixed instructions are kept by Anthropic for a few minutes, so the next calls pay about a tenth for them
async function ask({ model, system, content, tool, maxTokens = 800, cache = false }) {
  const sys = cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
  const tools = [cache ? { ...tool, cache_control: { type: 'ephemeral' } } : tool];
  const j = await require('../claude').call({ source: 'bot', feature: tool.name, model,
    body: { max_tokens: maxTokens, system: sys, tools, tool_choice: { type: 'tool', name: tool.name }, messages: [{ role: 'user', content }] } });
  const use = (j.content || []).find((c) => c.type === 'tool_use'); if (!use) throw Object.assign(new Error('The AI gave no answer'), { kind: 'bad' });
  return use.input;
}

// topics of the knowledge base (src/kb.js)
const KB_TOPIC = { type: 'string', enum: Object.keys(require('../kb').TOPICS), description: 'What it is about.' };

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
  return ask({ model: DAY_MODEL(), system, content: [{ type: 'text', text: lines.join('\n').slice(-60000) }], tool: SUM_TOOL, maxTokens: 900 });
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
  mood: { type: 'string', enum: ['good', 'neutral', 'unhappy', 'angry'] },
  topic: KB_TOPIC,
  needs_reply: { type: 'boolean', description: 'Someone from the company should answer this message: a question, a worry, news (a date, a problem, "I cannot come"), something left open. False for "ok", "thanks", a plain yes.' },
  reply: { type: 'string', description: 'When needs_reply: the message a good recruiter would send now, 1 to 3 short friendly sentences. Use only the facts; when a person must decide, say who will come back and when (for example "Let me check with the team and get back to you today."). Never promise pay, dates or exceptions. Empty when no reply is needed.' } },
  required: ['is_question', 'confident', 'answer', 'progress', 'mood', 'topic', 'needs_reply', 'reply'] } };
async function driverReply({ facts, knowledge, context, recent, text, role }) {
  const system = `${role || 'You are the onboarding assistant of a US trucking company, in a Telegram group with a new driver and the recruiters.'}
Answer the driver only from the facts and knowledge below. If they do not fully answer the question, or it needs a person's decision (exceptions, pay advances, dates, personal matters, complaints), set confident=false and leave answer empty: a recruiter will answer.
Never ask for or repeat SSN, license numbers, dates of birth or bank details; tell the driver to enter those only on Amazon's or Accurate's own website.
Keep answers short, warm and simple. Do not promise anything that is not in the facts.

COMPANY FACTS:
${facts.map((f) => '- ' + f).join('\n')}

KNOWLEDGE (questions the team answered before):
${knowledge.map((k) => `Q: ${k.question}\nA: ${k.answer}`).join('\n') || '(none yet)'}
`;
  return ask({ model: MODEL(), system, content: [{ type: 'text', text: `THIS DRIVER:\n${context}\n\nRecent messages:\n${recent.join('\n')}\n\nThe driver's new message:\n${text}` }], tool: REPLY_TOOL, maxTokens: 600, cache: true });
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
  load_updates: { type: 'array', description: 'ONLY in a WORKING driver\'s dispatch group: each load update in the NEW messages (where the driver is with a load). One per message that says it.', items: { type: 'object', properties: {
    msg_id: { type: 'integer', description: 'The #number of the message that says it.' },
    status: { type: 'string', enum: ['assigned', 'to_pickup', 'at_pickup', 'loaded', 'rolling', 'at_delivery', 'delivered', 'delayed', 'waiting', 'issue'] },
    place: { type: 'string', description: 'City or facility, if said.' }, eta: { type: 'string', description: 'The ETA as said (for example "4 PM" or "Tue 6 AM"), if said.' },
    load_ref: { type: 'string', description: 'Load, trip or container number, if said.' }, by: { type: 'string', enum: ['driver', 'dispatcher', 'other'] } }, required: ['msg_id', 'status'] } },
  promises: { type: 'array', description: 'ONLY in a WORKING group: what the DRIVER says he will do, with a time (for example "I will be at the shipper by 6 AM", "ETA 4 PM", "I will send the BOL tonight", "I can take the load Monday"). From the NEW messages.', items: { type: 'object', properties: {
    msg_id: { type: 'integer' }, what: { type: 'string', description: 'Short, in the third person: "Be at the shipper by 6 AM".' }, due: { type: 'string', description: 'When, as said.' } }, required: ['msg_id', 'what'] } },
  promise_results: { type: 'array', description: 'ONLY for the OPEN PROMISES listed: the ones the NEW messages show he kept or did not keep (late, did not do it, changed it without telling).', items: { type: 'object', properties: {
    id: { type: 'integer' }, result: { type: 'string', enum: ['kept', 'broken'] }, evidence: { type: 'string', description: 'Short, what shows it.' } }, required: ['id', 'result'] } },
  shift_note: { type: 'object', description: 'ONLY when one of our dispatchers wrote an update note in the NEW messages for the next shift (where the driver is, the load, the next plan): who wrote it.', properties: { by: { type: 'string' } }, required: ['by'] },
  desk_asks: { type: 'array', description: 'ONLY in a WORKING driver\'s group: what the dispatcher on shift should confirm or act on, from the NEW messages, when nobody from our team already answered it in them. rest = the driver will sleep or rest until a time (until: HH:MM, 24-hour, in the times shown); needs_load = he is empty now or asks for a load (place: where he is); prebook = he is on a load and will deliver soon (today or by tomorrow) and the messages show no next load yet (place: where he delivers); problem = a hard situation that needs a senior dispatcher: breakdown, accident, load refused or rejected, he will be late or miss the appointment, wrong place or wrong trailer, a dispute, an angry driver (ask: what happened and what needs deciding, one sentence); question = he asked our team something and nobody answered; other = anything else to double check (ask: the question for the dispatcher, one sentence).', items: { type: 'object', properties: {
    kind: { type: 'string', enum: ['rest', 'needs_load', 'prebook', 'problem', 'question', 'other'] }, quote: { type: 'string', description: 'His words, short.' }, until: { type: 'string' }, place: { type: 'string' }, ask: { type: 'string' } }, required: ['kind'] } },
  leaving_signs: { type: 'array', description: 'ONLY in a WORKING driver\'s group: signs in the NEW messages that the driver may leave us. strong = he has another offer or job, says he will quit or is looking; weak = complaints about pay, miles, home time, the truck, the dispatcher, family pressure. Empty when there are none.', items: { type: 'object', properties: {
    kind: { type: 'string', enum: ['other_offer', 'quitting', 'pay', 'home_time', 'truck', 'dispatcher', 'family', 'miles', 'other'] }, strength: { type: 'string', enum: ['strong', 'weak'] }, quote: { type: 'string', description: 'His words, short.' } }, required: ['kind', 'strength', 'quote'] } },
  home_time: { type: 'object', description: 'ONLY in a WORKING driver\'s group, when the NEW messages talk about the driver\'s home time: going home (and when), at home, when he comes back, back on the road, or it is called off. Dates as YYYY-MM-DD (Today is given). Leave out when not mentioned.', properties: {
    event: { type: 'string', enum: ['going_home', 'at_home', 'coming_back', 'back_on_road', 'cancelled'] }, leave_on: { type: 'string' }, back_on: { type: 'string' },
    needs_ticket: { type: 'boolean', description: 'He needs a bus or plane ticket to come back.' }, quote: { type: 'string', description: 'His words, short.' } }, required: ['event'] },
  places: { type: 'array', description: 'Businesses that fix or serve trucks, when the NEW messages share one (name, address, phone, location) or say how one did: truck shops, tire service, towing, road service, mobile mechanics, truck wash, detailing, locksmiths, parts, and their phone numbers. NOT a place we take loads to: an Amazon facility or site code (KBWI, BWI2, KRB1...), a customer, warehouse, airport hub, yard or drop lot goes in site_notes instead. Never a private person\'s details, never the driver\'s.', items: { type: 'object', properties: {
    name: { type: 'string' }, kind: { type: 'string', enum: ['shop', 'tire', 'tow', 'roadside', 'mobile_mechanic', 'truck_wash', 'detailing', 'locksmith', 'parts', 'trailer', 'glass', 'dealer', 'other'] },
    services: { type: 'array', items: { type: 'string' }, description: 'What they fix or do, short (for example "DPF cleaning", "air leaks", "steer tires", "lockout").' },
    phone: { type: 'string' }, address: { type: 'string' }, city: { type: 'string' }, state: { type: 'string', description: 'Two letters, like NJ.' }, area: { type: 'string', description: 'For example "Baltimore area".' },
    outcome: { type: 'string', enum: ['good', 'ok', 'bad', 'unknown'], description: 'How it went when we used them in these messages; unknown when only shared.' }, cost: { type: 'number' }, note: { type: 'string', description: 'What was done or said about them, one short line.' } }, required: ['name', 'kind'] } },
  orientation_done: { type: 'array', items: { type: 'string' }, description: 'ONLY the keys of the ORIENTATION DAY steps listed that the NEW messages clearly show done (for example "ELD works, I am logged in" → or_eld).' },
  cases_opened: { type: 'array', description: 'ONLY in a WORKING driver\'s group: a case from the CASE PLAYBOOK that the NEW messages show starting (not one already in OPEN CASES).', items: { type: 'object', properties: {
    playbook_id: { type: 'integer' }, msg_id: { type: 'integer', description: 'The message (#id) where it starts.' }, city: { type: 'string' }, state: { type: 'string', description: 'Two letters, where it happened, if said.' }, summary: { type: 'string', description: 'One sentence: what happened and where (no phone or load numbers).' } }, required: ['playbook_id', 'summary'] } },
  case_updates: { type: 'array', description: 'ONLY for the OPEN CASES listed: the steps the NEW messages show done (or clearly not needed, like the "cannot move" step when the truck moved), a short note, and resolved=true when the problem is over (the truck is rolling again, the load is delivered or settled).', items: { type: 'object', properties: {
    case_id: { type: 'integer' }, steps_done: { type: 'array', items: { type: 'integer' } }, note: { type: 'string' }, resolved: { type: 'boolean' },
    cost: { type: 'number', description: 'What the repair, tow or service cost, if said.' }, shop: { type: 'string', description: 'The shop or service that did it, if said.' }, state: { type: 'string', description: 'Two letters, if now known.' },
    lesson: { type: 'string', description: 'When resolved: what to do better or the same next time in a case like this, as general practice. Empty if nothing new.' } }, required: ['case_id', 'steps_done', 'resolved'] } },
  dispatch_lessons: { type: 'array', description: 'ONLY in a WORKING driver\'s dispatch group: how OUR dispatchers handle things, as general practice a new dispatcher (or a bot doing updates) can follow. Only when the NEW messages clearly show it. No names, numbers, places or dates.', items: { type: 'object', properties: {
    situation: { type: 'string', description: 'When this happens, for example "The driver says he will be late to the delivery".' },
    practice: { type: 'string', description: 'What the dispatcher does or says, for example "Asks for the new ETA right away and tells the driver he will update the broker".' },
    topic: KB_TOPIC }, required: ['situation', 'practice'] } },
  people: { type: 'array', description: 'ONLY for the people listed as "role not known yet": what each one is, when what they write makes it clear. Leave a person out when unsure.', items: { type: 'object', properties: {
    name: { type: 'string', description: 'Exactly as listed.' }, role: { type: 'string', enum: ['driver', 'dispatcher', 'eld', 'accounting', 'other'], description: 'driver = the driver of this group; dispatcher = gives loads, times, addresses, follows up; eld = logs and ELD; accounting = pay and settlements.' } }, required: ['name', 'role'] } },
  learned: { type: 'array', description: 'When a person from our team (not the bot) answered a question the driver asked in the NEW messages, or clearly stated a company rule or how something works with us (pay, fuel cards, tolls, logs, home time, paperwork, equipment): the general question and the answer, reworded so they help any future driver (no names, dates, phone numbers or personal details). Leave out answers that only fit this driver or this one load.', items: { type: 'object', properties: {
    question: { type: 'string' }, answer: { type: 'string' }, topic: KB_TOPIC }, required: ['question', 'answer'] } },
  site_notes: { type: 'array', description: 'In ANY group: lasting facts the NEW messages teach about a place or a road that will help any driver or dispatcher going there later. Amazon sites and customers (gate or check-in rules, which door or lane, parking, usual waits, hours, what to show), yards and drop lots, truck parking, weigh stations, low bridges, roads trucks must avoid, tolls. Not one-time events (today\'s traffic, one late load) and no people\'s names, phone numbers or load numbers.', items: { type: 'object', properties: {
    place: { type: 'string', description: 'The facility code or name as the team calls it, for example "KRB1", "Amazon Hazleton", "Chambersburg drop yard", "I-78 Pennsylvania".' },
    city: { type: 'string' }, state: { type: 'string', description: 'Two letters.' },
    fact: { type: 'string', description: 'One short, concrete fact, for example "Check-in at gate 3; trucks wait on the right shoulder, not on the street".' }, topic: KB_TOPIC }, required: ['place', 'fact'] } },
  onboarding: { type: 'object', description: 'ONLY when ONBOARDING STEPS are listed in the instructions: where this driver\'s onboarding stands after all messages (earlier and new).', properties: {
    summary: { type: 'string', description: '2 or 3 sentences: where things stand, what was done, what is next.' },
    waiting_on: { type: 'string', enum: ['driver', 'recruiter', 'amazon', 'company', 'nobody'], description: 'Who has to act next.' },
    next_step: { type: 'string', description: 'The next concrete step, a few words.' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'Problems holding it up (a failed check, a missing document, the driver unsure...).' },
    open_questions: { type: 'array', items: { type: 'string' }, description: 'Questions the driver asked that nobody answered yet.' },
    driver_mood: { type: 'string', enum: ['good', 'neutral', 'unhappy', 'angry', 'unknown'] },
    dropping_out: { type: 'object', description: 'ONLY when the DRIVER clearly says in the NEW messages that he is not coming, quits, took another job, cannot make it, or changed his mind. Leave out when unsure or when it is only a delay.', properties: {
      quote: { type: 'string', description: 'His words, short.' }, reason: { type: 'string', enum: ['Pay', 'Home time', 'Found another job', 'No response', 'Not qualified', 'Driving record', 'Failed background check', 'Failed drug test', 'Location', 'Equipment', 'Changed their mind', 'Other'] } }, required: ['quote'] },
    amazon_step: { type: 'string', enum: ['none', 'invite', 'account', 'profile', 'accurate', 'waiting'], description: 'The furthest Amazon Relay step the NEW messages clearly show as DONE, whoever says it: invite = our team says the Relay invite was sent to him; account = he created his Amazon account; profile = he signed up and finished the Relay profile; accurate = his background check at Accurate was started or submitted; waiting = everything is submitted and he waits for Amazon. none when the new messages do not clearly say one, or it is only planned, asked about or promised. Never guess. Amazon verifying him is NOT reported here: a person confirms that.' },
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
async function digest({ kind, driver, truck, openIssues, unpaid = [], context, fresh, images, onb = null, unknown = [], working = false, promises = [], playbook = '', cases = '', orientation = '', today = '', words = '' }) {
  // the same for every group (cached); what is special about this group goes with the messages
  const system = `You read one truck driver's Telegram group for a US trucking company, and pull out what the managers must know.
Only report what the NEW messages say; the earlier ones are context. Compare container, trailer and load numbers in the messages with the ones in the pictures: a different number is a container_mismatch.
Flag unprofessional_dispatcher only for clear rudeness, insults, or telling the driver to break rules. Appointment or pickup/delivery time changes are appointment_change.
Never include passwords, SSN, license or account numbers. Be factual and short.
Oil changes, shop visits and repairs are truck_events. "Oil change done" is an oil_change with status fixed; say paid=true when they say it is paid, and give the cost, shop and mileage when said. Do not repeat an event already listed in OPEN TRUCK ISSUES: mark it fixed (fixed_issue_ids) or paid (paid_ids) instead.
In a WORKING driver's dispatch group (the driver hauls loads for us) also fill load_updates (each message is numbered #id), promises, promise_results and dispatch_lessons: the bot is learning how our dispatchers run updates and whether the driver keeps his word. Leave them empty in other groups.
In any group, when the messages teach something lasting (an answer, a company rule, a fact about a site or a road), fill learned or site_notes: the company is building its knowledge base from the groups.
When the driver is ONBOARDING (not driving for us yet), fill "onboarding" every time. Mark a step done only when a message or a picture clearly shows it is done (a result, a confirmation, a ticket, "done", "passed"), never when it is only planned or asked for.${words}${playbook}`;
  const about = `ABOUT THIS GROUP: the ${kind} group of ${driver}${truck ? `, truck ${truck}` : ''}.
OPEN TRUCK ISSUES (id: title): ${openIssues.length ? openIssues.map((i) => `${i.id}: ${i.title}`).join('; ') : 'none'}
${orientation}${working ? 'This is a WORKING driver\'s dispatch group. Today is ' + (today || '') + '.' + cases + '\n' + (promises.length ? `OPEN PROMISES (id: what, due): ${promises.map((x) => `${x.id}: ${x.what}${x.due ? ', ' + x.due : ''}`).join('; ')}\n` : '') : ''}${unknown.length ? `People whose role is not known yet: ${unknown.join('; ')}.
` : ''}Truck services not marked paid yet (id: title, cost): ${unpaid.length ? unpaid.map((i) => `${i.id}: ${i.title}${i.cost !== null ? ' $' + i.cost : ''}`).join('; ') : 'none'}${onb ? `

This driver is ONBOARDING (not driving for us yet).
Today is ${onb.today}. Start date on the website: ${onb.start || 'not set'}.${onb.travel ? ` Travel details on the website: ${onb.travel}.` : ''}
Amazon Relay step: ${onb.amazon || 'invite not sent yet'}.${onb.last ? ` Last known status: ${onb.last}` : ''}${onb.indeed ? `\nWhat he told us on Indeed before this group (already known, not news; do not list it as an open question):\n${onb.indeed}` : ''}
ONBOARDING STEPS still open (id: step): ${onb.steps.length ? onb.steps.map((x) => `${x.id}: ${x.label}`).join('; ') : 'none'}` : ''}`;
  const content = [...images.map((im) => (im.mime === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: im.data } } : { type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })),
    { type: 'text', text: `${about}\n\nEARLIER MESSAGES (context):\n${context.join('\n') || '(none)'}\n\nNEW MESSAGES:\n${fresh.join('\n')}${images.length ? `\n\n(The ${images.length} picture(s) above are the photos in the new messages, in order.)` : ''}` }];
  return ask({ model: DIGEST_MODEL(), system, content, tool: DIGEST_TOOL, maxTokens: 3000, cache: true });
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
// How one of our dispatchers works, from his messages in the drivers' groups (for the managers, and for the future updater)
// how one dispatcher works: a review the managers use to coach him (the old short fields stay for the cards and his own coaching)
const AREAS = ['communication', 'clarity', 'speed', 'problem_solving', 'follow_through', 'updates', 'driver_care', 'professionalism'];
const DISP_TOOL = { name: 'dispatcher_profile', description: 'A detailed, fair review of how this dispatcher works with the drivers, for coaching.', input_schema: { type: 'object', properties: {
  summary: { type: 'string', description: '3 to 5 sentences: how he works, what he is good at, the one thing that matters most to fix.' },
  tone: { type: 'string', enum: ['friendly', 'neutral', 'firm', 'harsh'] }, clarity: { type: 'string', enum: ['clear', 'mostly_clear', 'unclear'] },
  professionalism: { type: 'string', enum: ['high', 'medium', 'low'] },
  scores: { type: 'array', description: 'One per area. communication = how he talks to drivers; clarity = instructions easy to follow; speed = how fast he answers; problem_solving = breakdowns, delays, wrong locations, upset drivers; follow_through = does what he says, calls back, closes issues; updates = ETA, BOL, check calls, keeps loads tracked; driver_care = respect, home time, hours of service, safety, the driver\'s mood; professionalism = language, calm, no blame.',
    items: { type: 'object', properties: { area: { type: 'string', enum: AREAS }, score: { type: 'integer', description: '1 poor, 2 weak, 3 OK, 4 good, 5 excellent' }, seen: { type: 'string', description: 'What the messages show, one or two sentences.' },
      example: { type: 'string', description: 'A short example of his own words (under 20 words), without names, phone, load or truck numbers. Empty if none.' }, ref: { type: 'integer', description: 'The [#n] number of the message the example is from; 0 if none.' },
      improve: { type: 'string', description: 'How to get better in this area: one concrete thing to do or write differently from now on, in one sentence, taken from what the messages show (not general advice). For a score of 5: what to keep doing.' },
      say_instead: { type: 'string', description: 'When the example could be written better: the same message rewritten the way a great dispatcher would write it (under 25 words, no names or numbers). Empty when the example is already good or there is none.' } }, required: ['area', 'score', 'seen', 'improve'] } },
  issues: { type: 'array', description: 'Up to 8 real situations from the messages (a breakdown, a late load, a lost driver, an upset driver, a question left open...).', items: { type: 'object', properties: {
    situation: { type: 'string' }, what_he_did: { type: 'string' }, verdict: { type: 'string', enum: ['good', 'ok', 'poor'] }, better_way: { type: 'string', description: 'What a great dispatcher would have done or written. Empty when he did well.' }, ref: { type: 'integer', description: 'The [#n] number of his message where this happened (his reply, or his first message in it).' } }, required: ['situation', 'what_he_did', 'verdict', 'ref'] } },
  thinking: { type: 'string', description: 'How he thinks and decides: plans ahead or reacts, what he puts first, how he weighs the driver against the load.' },
  drivers_view: { type: 'string', description: 'How the drivers react to him: trust, mood, complaints, ignoring him.' },
  update_habits: { type: 'array', items: { type: 'string' }, description: 'How he runs updates: what he asks for and when (ETA, BOL photo, seal, check calls...).' },
  phrases: { type: 'array', items: { type: 'string' }, description: 'Typical short messages he sends, as patterns, without names or numbers (for example "Send me the BOL once loaded").' },
  strengths: { type: 'array', items: { type: 'string' } }, improve: { type: 'array', items: { type: 'string' }, description: 'What would make him better, concrete and respectful.' },
  red_flags: { type: 'array', items: { type: 'string' }, description: 'Only serious things a manager must act on: rude or insulting, misleading a driver, pushing a driver past hours of service or to drive unsafe, ignoring a breakdown or safety problem. Empty if none.' },
  red_flag_refs: { type: 'array', items: { type: 'integer' }, description: 'For each red flag, in the same order, the [#n] number of the message it is about.' },
  feedback: { type: 'object', description: 'How the manager should give him feedback this time.', properties: {
    praise_first: { type: 'string', description: 'A real thing to praise, to open with.' }, main_point: { type: 'string', description: 'The one most important thing to change.' },
    show_example: { type: 'string', description: 'The situation from the messages to show him, and the better message he could have written.' }, show_example_ref: { type: 'integer', description: 'The [#n] number of that message.' },
    how_to_say_it: { type: 'string', description: 'What the manager can say, 2 to 4 sentences, respectful and direct.' },
    goal: { type: 'string', description: 'One goal for the next 2 weeks that can be checked in the groups.' }, check_how: { type: 'string', description: 'How to see in the groups if he reached it.' } },
    required: ['praise_first', 'main_point', 'how_to_say_it', 'goal'] },
  tip: { type: 'string', description: 'One tip for him for this week, 1 or 2 short sentences, practical, in plain words he can use tomorrow (for example "Ask for the ETA as soon as the driver says loaded.").' },
  trend: { type: 'object', properties: { direction: { type: 'string', enum: ['first', 'better', 'same', 'worse'] }, what_changed: { type: 'string' } }, required: ['direction'] },
  confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'low when there are few messages or few real situations.' } },
  required: ['summary', 'tone', 'clarity', 'professionalism', 'scores', 'issues', 'thinking', 'drivers_view', 'update_habits', 'phrases', 'strengths', 'improve', 'red_flags', 'feedback', 'tip', 'trend', 'confidence'] } };
async function dispatcherProfile({ name, stats, lines, previous }) {
  const system = `You review how one dispatcher of a US trucking company works with the drivers in their Telegram groups, so the managers can coach him and a bot can learn to run updates the same way. Be fair, specific and factual: everything must come from the messages and numbers given, never invented. Give credit where it is due. When there is little to go on, say so and set confidence low. Never include phone numbers, addresses, load or truck numbers, or anyone's full name.`;
  const prev = previous ? `\nTHE LAST REVIEW (${previous.at}): ${previous.summary || ''}\nScores then: ${(previous.scores || []).map((s) => `${s.area} ${s.score}`).join(', ')}\nGoal given then: ${(previous.feedback || {}).goal || 'none'}\nSay in trend whether he got better, and whether he reached that goal.\n` : '\nThis is his first review: trend.direction = first.\n';
  return ask({ model: SUMMARY_MODEL(), system, content: [{ type: 'text', text: `Dispatcher: ${name}\n${stats}${prev}\nMESSAGES (oldest first; each of his messages starts with its number [#n], with the driver's message before it when it was a reply. Give that number as ref for every situation, example and red flag):\n${lines.join('\n').slice(-90000)}` }], tool: DISP_TOOL, maxTokens: 4000 });
}
// every job the bot does, with its model (for the Test button: one real call each)
// The knowledge base tidy (a few times a day, new entries only): clear wording, topic, duplicates, answers that disagree
const KB_TOOL = { name: 'kb_tidy', description: 'Tidy entries of the company knowledge base.', input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
  id: { type: 'integer' },
  question: { type: 'string', description: 'Short and general: what a driver or dispatcher would ask, or the situation (for a place: the place name as the team calls it). Empty = keep.' },
  answer: { type: 'string', description: 'The best single answer, short and concrete, combining the other answers when they agree. Empty = keep.' },
  topic: KB_TOPIC,
  duplicate_of: { type: 'integer', description: 'The id of another entry (in ENTRIES or OTHER ENTRIES, same kind) that says the same thing; 0 if none.' },
  conflict: { type: 'string', description: 'Only when the answers of this entry disagree with each other, or with another entry: one sentence saying how (for example "One group says pay is Friday, another says Monday"). Empty if they agree.' } },
  required: ['id', 'topic'] } } }, required: ['items'] } };
async function kbTidy({ items, others }) {
  const T = require('../kb').TOPICS;
  const system = `You keep the knowledge base of a US trucking company tidy (Amazon Relay loads, Northeast hubs: Chambersburg, Baltimore, Hazleton, Kearny). The entries come from the team's Telegram groups with drivers and dispatchers.
For every entry in ENTRIES give: a short clear question (or situation), the best answer, its topic, duplicate_of, and conflict. Keep the meaning: never add facts that are not in the entry. Plain words, no names of people, phone numbers, load, license or account numbers.
Kinds: general/accounting = answers for drivers; dispatch = what our dispatchers do in a situation; site = a fact about a place or road (the question is the place).
Entries marked LOCKED were written by a manager: do not reword them (leave question and answer empty); still give topic, duplicate_of and conflict.
TOPICS: ${Object.entries(T).map(([k, v]) => `${k} = ${v}`).join('; ')}`;
  const line = (r) => `[${r.id}] (${r.kind}${r.source === 'added' || r.locked ? ', LOCKED' : ''}) Q: ${String(r.question).slice(0, 300)} | A: ${String(r.answer).slice(0, 600)}${(r.variants || []).length ? ` | Other answers: ${(r.variants || []).map((v) => String(v.answer).slice(0, 200)).join(' / ')}` : ''}`;
  const text = `ENTRIES:\n${items.map(line).join('\n')}\n\nOTHER ENTRIES (already tidy; for duplicates and conflicts):\n${others.map((o) => `[${o.id}] (${o.kind}, ${o.topic || '-'}) ${String(o.question).slice(0, 160)} -> ${String(o.answer).slice(0, 160)}`).join('\n') || '(none)'}`;
  return ask({ model: MODEL(), system, content: [{ type: 'text', text }], tool: KB_TOOL, maxTokens: 6000 });
}
const jobs = () => [[KB_TOOL, MODEL()], [DOC_TOOL, MODEL()], [SUM_TOOL, DAY_MODEL()], [ONB_TOOL, MODEL()], [REPLY_TOOL, MODEL()], [DIGEST_TOOL, DIGEST_MODEL()], [PROFILE_TOOL, SUMMARY_MODEL()], [DISP_TOOL, SUMMARY_MODEL()]];
// The bot grades itself: the reply it drafted for a driver against what our team really wrote
const GRADE_TOOL = { name: 'grade_draft', description: 'Compare the assistant\'s drafted reply with what the team member really wrote to the driver.', input_schema: { type: 'object', properties: {
  verdict: { type: 'string', enum: ['same', 'partly', 'wrong', 'unrelated'], description: 'same: the draft says the same thing in substance (wording may differ) and would have been fine to send. partly: right direction but it misses or adds something that matters. wrong: it says something different, incorrect, or promises what the team did not. unrelated: the team message is not an answer to this driver message (another topic, a greeting, a note to a colleague), so they cannot be compared.' },
  note: { type: 'string', description: 'One short sentence: what the draft missed or got wrong, or why it matches. No personal details.' } }, required: ['verdict', 'note'] } };
async function gradeDraft({ driverText, draft, teamText }) {
  const system = 'You check an onboarding assistant of a US trucking company. It drafted a reply to a driver; a recruiter then answered the driver themselves. Judge only the substance: facts, the decision, the next step. Ignore tone, length and greetings. Be strict about facts, numbers, dates and promises.';
  return ask({ model: MODEL(), system, content: [{ type: 'text', text: `The driver wrote:\n${driverText || '(not saved)'}\n\nThe assistant drafted:\n${draft}\n\nThe recruiter really wrote:\n${teamText}` }], tool: GRADE_TOOL, maxTokens: 200 });
}
// Once a week: the bot reads its own mistakes and proposes fixes for an admin to approve
const REVIEW_TOOL = { name: 'weekly_review', description: 'Fixes the assistant proposes after reading its week.', input_schema: { type: 'object', properties: {
  proposals: { type: 'array', maxItems: 8, items: { type: 'object', properties: {
    kind: { type: 'string', enum: ['knowledge', 'wording', 'rule', 'site'], description: 'knowledge: an answer the assistant should know (give question and answer, taken from what the team really wrote). wording: a message of the assistant that should be worded differently. rule: a follow-up or timing rule to add or change. site: a change to the website that would have prevented the problem or saved the team work.' },
    title: { type: 'string', description: 'One short line a manager understands.' },
    detail: { type: 'string', description: 'What to change and why, 1 to 4 sentences, with the evidence from this week (how often, which case). For site: precise enough for a developer to build.' },
    question: { type: 'string', description: 'knowledge only: the driver question, in general words.' },
    answer: { type: 'string', description: 'knowledge only: the answer to give, as the team gave it. Never anything about pay amounts, contracts or legal matters unless the team wrote exactly that.' } }, required: ['kind', 'title', 'detail'] } } }, required: ['proposals'] } };
async function weeklyReview(text) {
  const system = 'You are the onboarding assistant of a US trucking company, reviewing your own last week to get better. Below: your drafts that did not match what the team wrote, steps you wrongly thought were done, follow-ups nobody answered, your score by topic and which wordings drivers answered. Propose only fixes the evidence supports, the most useful first, at most 8. No personal details, no driver names. If the week gives nothing worth changing, return an empty list.';
  return ask({ model: SUMMARY_MODEL(), system, content: [{ type: 'text', text }], tool: REVIEW_TOOL, maxTokens: 2500 });
}
module.exports = { weeklyReview, gradeDraft, AREAS, jobs, on, docKind, summarize, onbDoc, driverReply, digest, profile, dispatcherProfile, kbTidy };
