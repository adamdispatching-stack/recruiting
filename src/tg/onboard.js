// Onboarding group: the bot walks the driver through the Amazon Relay steps, reads the screenshots and
// background reports the driver sends, answers the driver's questions from the company facts and what the
// team taught it, asks the recruiter when it does not know (and learns the answer), reminds the driver when a
// step stalls, and the day before arrival sends the arrival details. Everything shows on the website.
const db = require('../db');
const bot = require('./bot');
const ai = require('./ai');
const { q } = db;
const { send, edit, esc, tag } = bot;

const GUIDE = {
  none: { text: 'Your recruiter will send you the <b>Amazon Relay invite</b> by email soon. I will tell you here what to do next.' },
  invite: { text: '📧 Amazon sent you an <b>invite to Amazon Relay</b> by email (check spam too). Open it and create your Amazon account with that same email.', btn: ['✅ I created my Amazon account', 'account'] },
  account: { text: '📱 Now sign in to the <b>Amazon Relay app</b> (or relay.amazon.com) and finish your driver profile: your CDL, a photo and your contact details.', btn: ['✅ My Relay profile is done', 'profile'] },
  profile: { text: '🔎 Amazon emails you a <b>background check from Accurate</b> (accurate.com). Fill it out completely on Accurate\'s website. It asks for your SSN and history: enter those only there, never in this chat.', btn: ['✅ I submitted the background check', 'waiting'] },
  waiting: { text: '⏳ Now Amazon checks everything, usually <b>2 to 7 days</b>. If Accurate or Amazon emails you for anything, answer fast and tell us here. You can send a screenshot of the Relay app any time.' },
  verified: { text: '🎉 <b>Amazon verified you!</b> Your recruiter will now set your start date, truck and travel.' }
};
GUIDE.accurate = GUIDE.profile;
const REPORT = { background_report: 'background check', mvr: 'MVR', psp: 'PSP report', drug_test: 'drug test', clearinghouse: 'Clearinghouse result' };
const RESULT = { clear: 'clear', issues: 'needs a look', pending: 'not finished yet', unknown: 'could not tell' };
const STAGE_TO = { invite_email: 'invite', account_created: 'account', profile_incomplete: 'account', background_check_pending: 'waiting' };
const PROGRESS_TO = { account_created: 'account', profile_done: 'profile', background_submitted: 'waiting' };

// ---------- people ----------
const isStaff = (p) => p && (p.role === 'staff' || !!p.user_id);
async function driverPerson(driverId) { return (await q(`SELECT * FROM tg_people WHERE role = 'driver' AND driver_id = $1 ORDER BY seen_at DESC LIMIT 1`, [driverId])).rows[0] || null; }
async function recruiterTag(c) {
  const p = (await q(`SELECT p.* FROM tg_people p LEFT JOIN tg_members m ON m.tg_id = p.tg_id AND m.chat_id = $2 WHERE p.user_id = $1 ORDER BY (m.tg_id IS NOT NULL) DESC LIMIT 1`, [c.owner_id || 0, c.chat_id])).rows[0]
    || (await q(`SELECT p.* FROM tg_people p JOIN tg_members m ON m.tg_id = p.tg_id AND m.chat_id = $1 WHERE p.role = 'staff' OR p.user_id IS NOT NULL ORDER BY p.seen_at DESC LIMIT 1`, [c.chat_id])).rows[0];
  return p ? tag(p) : (c.owner_name ? `<b>${esc(c.owner_name)}</b>` : 'our team');
}
const driverTag = async (c) => { const p = await driverPerson(c.driver_id); return p ? tag(p) : `<b>${esc(c.name.split(/\s+/)[0])}</b>`; };

// ---------- the case ----------
async function caseOf(driverId) {
  return (await q(`SELECT c.*, c.mode bot_mode, d.name, d.mode, d.status, d.owner_id, d.amazon_step, d.amazon_log, d.company_id, u.name owner_name, co.name company, t.unit, t.details,
      to_char(o.expected_arrival, 'YYYY-MM-DD') arrive, o.arrival_note, o.arrived_on
    FROM onb_cases c JOIN drivers d ON d.id = c.driver_id LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN companies co ON co.id = d.company_id
    LEFT JOIN trucks t ON t.driver_id = d.id LEFT JOIN onboarding o ON o.driver_id = d.id WHERE c.driver_id = $1`, [driverId])).rows[0];
}
const nice = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
async function cardHtml(c) {
  const at = db.amazonIdx(c.amazon_step);
  const reps = (await q(`SELECT kind, result, review FROM tg_reports WHERE driver_id = $1 AND kind = ANY($2::text[]) ORDER BY at DESC`, [c.driver_id, Object.keys(REPORT)])).rows;
  const seen = new Set(); const rl = reps.filter((r) => !seen.has(r.kind) && seen.add(r.kind));
  return `🚚 <b>Onboarding: ${esc(c.name)}</b>\n\n<b>Amazon Relay</b>\n${db.AMAZON.map((s, i) => `${i <= at ? '✅' : '⬜'} ${s.label}`).join('\n')}`
    + (rl.length ? `\n\n<b>Reports</b>\n${rl.map((r) => `${r.review === 'ok' ? '✅' : r.result === 'issues' || r.review === 'look' ? '⚠️' : '🕓'} ${REPORT[r.kind]}: ${RESULT[r.result] || r.result}${r.review === 'ok' ? ', approved' : ''}`).join('\n')}` : '')
    + `\n\n<b>Start</b>: ${c.arrive ? nice(c.arrive) : 'date not set yet'}${c.unit ? `\n<b>Truck</b>: ${esc(c.unit)}${c.details ? ` (${esc(c.details)})` : ''}` : ''}${c.owner_name ? `\n<b>Recruiter</b>: ${esc(c.owner_name)}` : ''}`;
}
async function refreshCard(c) { if (c.card_msg_id) await edit(c.chat_id, c.card_msg_id, await cardHtml(c)).catch(() => {}); }
async function tell(c, text, merge = true) {
  const to = c.owner_id ? [c.owner_id] : (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id);
  for (const id of to) await db.notify(db.pool, id, 'tg', text, '#/telegram/' + c.chat_id, { driverId: c.driver_id, merge });
}
async function guide(c, { remind = false } = {}) {
  const g = GUIDE[c.amazon_step || 'none']; if (!g) return;
  const who = await driverTag(c);
  await send(c.chat_id, `${remind ? '⏰ Reminder: ' : ''}${who} ${g.text}`, g.btn ? { buttons: [[[g.btn[0], `onb:${c.driver_id}:amz:${g.btn[1]}`]]] } : {});
}
async function moveAmazon(c, key, by) {
  const moved = await db.amazonTo(db.pool, c.driver_id, key, null);
  if (!moved) return false;
  await q(`UPDATE drivers SET updated_at = now() WHERE id = $1`, [c.driver_id]);
  await require('../lib').history(c.driver_id, `Amazon: ${db.AMAZON.find((s) => s.key === key).long} (Telegram)`, by, 'telegram').catch(() => {});
  // the next step right away
  const n = await caseOf(c.driver_id);
  await q(`UPDATE onb_cases SET last_amazon = $2, nudge = NULL WHERE driver_id = $1`, [c.driver_id, n.amazon_step]);
  await refreshCard(n); await guide(n);
  if (n.amazon_step === 'verified') await require('../needed').check(c.driver_id).catch(() => {});
  return true;
}

// ---------- start ----------
const MODES = { watch: 'Watch and learn', assist: 'Answer questions', run: 'Run the onboarding' };
async function begin(chatId, driverId, opts = {}) {
  const d = (await q(`SELECT amazon_step, status, name FROM drivers WHERE id = $1`, [driverId])).rows[0];
  if (d.status === 'Hired') return; // an active driver's group: read along quietly (summaries, truck issues, notes on the website)
  const mode = MODES[opts.mode] ? opts.mode : MODES[(db.settings.tg || {}).onbMode] ? db.settings.tg.onbMode : 'watch';
  await q(`INSERT INTO onb_cases (driver_id, chat_id, last_amazon, mode) VALUES ($1, $2, $3, $4) ON CONFLICT (driver_id) DO UPDATE SET chat_id = $2, last_amazon = $3, nudge = NULL, mode = $4`, [driverId, chatId, d.amazon_step, mode]);
  if (mode === 'watch') return; // reads along silently: summaries, notes and learning on the website
  if (mode === 'assist') return send(chatId, `👋 Hi <b>${esc(d.name.split(/\s+/)[0])}</b>! I am the FleetHire assistant. Ask me anything about the job, pay, trucks or the next steps; what I don't know, I ask the team.`);
  return welcome(driverId);
}
// the full start: welcome, the status card, the driver's button, the next step
async function welcome(driverId) {
  const c = await caseOf(driverId); const chatId = c.chat_id;
  await send(chatId, `👋 Welcome, <b>${esc(c.name.split(/\s+/)[0])}</b>! This is your onboarding group${c.owner_name ? ` with ${esc(c.owner_name)}` : ''}.\nI am the FleetHire assistant: ask me anything about the job, pay, trucks or the next steps, any time. If I don't know, I'll get your recruiter.`);
  const card = await send(chatId, await cardHtml(c));
  await q(`UPDATE onb_cases SET card_msg_id = $2 WHERE driver_id = $1`, [driverId, card.message_id]); c.card_msg_id = card.message_id;
  await send(chatId, 'So I know who is who, the driver please tap:', { buttons: [[['🚚 I am the driver', `onb:${driverId}:iam`]]] });
  await guide(c);
}
// The team switches how the bot works (in Telegram or on the website). Run sends the welcome if it never went out.
async function setMode(driverId, mode, by, who = null) {
  if (!MODES[mode]) return false;
  const c0 = await caseOf(driverId); if (!c0) return false;
  await q(`UPDATE onb_cases SET mode = $2 WHERE driver_id = $1`, [driverId, mode]);
  await require('../lib').history(driverId, `Telegram bot: ${MODES[mode]}`, by || 'Website', 'telegram').catch(() => {});
  await bot.log('mode', `Mode: ${MODES[mode]}${who ? '' : ` (${by || 'website'})`}`, { chatId: c0.chat_id, driverId, who });
  if (mode === 'run' && !c0.card_msg_id) await welcome(driverId);
  else if (mode === 'run') await guide(await caseOf(driverId));
  return true;
}
async function status(chat) {
  const c = await caseOf(chat.driver_id); if (!c) return;
  const card = await send(chat.chat_id, await cardHtml(c));
  await q(`UPDATE onb_cases SET card_msg_id = $2 WHERE driver_id = $1`, [c.driver_id, card.message_id]);
}

// ---------- buttons ----------
async function onButton(chat, cq, who) {
  const [, did, act, arg] = cq.data.split(':'); const driverId = +did;
  const c = await caseOf(driverId); if (!c || c.driver_id !== chat.driver_id) return 'This button is from an old group.';
  const isDriver = who.role === 'driver' && who.driver_id === driverId;
  if (act === 'iam') {
    const cur = await driverPerson(driverId);
    if (cur && cur.tg_id !== who.tg_id && !isStaff(who)) return `${cur.name} is already the driver here.`;
    if (isStaff(who)) return 'You are with our team here.';
    await q(`UPDATE tg_people SET role = 'driver', driver_id = $2 WHERE tg_id = $1`, [who.tg_id, driverId]);
    return `Thanks ${who.name}, you are the driver ✓`;
  }
  if (act === 'amz') {
    if (!isDriver && !isStaff(who)) return 'Only the driver can tap this.';
    if (!['account', 'profile', 'waiting'].includes(arg)) return '';
    const moved = await moveAmazon(c, arg, who.name);
    await bot.dropButtons(chat.chat_id, cq.message.message_id);
    return moved ? 'Thanks ✓' : 'Already done ✓';
  }
  if (act === 'verify' || act === 'notyet') {
    if (!isStaff(who)) return 'Only our team can confirm this.';
    await bot.dropButtons(chat.chat_id, cq.message.message_id);
    if (act === 'verify') { await moveAmazon(c, 'verified', who.name); return 'Marked verified ✓'; }
    await send(chat.chat_id, `👍 Not verified yet. ${await driverTag(c)}, we will let you know as soon as Amazon approves you.`);
    return 'OK';
  }
  if (act === 'rep_ok' || act === 'rep_look') {
    if (!isStaff(who)) return 'Only our team can review reports.';
    const r = (await q(`UPDATE tg_reports SET review = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1 AND driver_id = $2 RETURNING *`, [+arg, driverId, act === 'rep_ok' ? 'ok' : 'look', who.name])).rows[0];
    await bot.dropButtons(chat.chat_id, cq.message.message_id);
    if (r && act === 'rep_ok' && r.kind === 'mvr') await q(`UPDATE checklist SET done = true, done_at = coalesce(done_at, now()) WHERE driver_id = $1 AND key = 'mvr' AND NOT done`, [driverId]);
    await refreshCard(await caseOf(driverId));
    return act === 'rep_ok' ? 'Approved ✓' : 'Marked for a closer look';
  }
  return '';
}

// ---------- messages ----------
// What the bot may tell the driver: the call guide's points for their kind of job, and how the Relay steps go
function companyFacts(c) {
  const cp = db.settings.callPoints || {};
  return [...((c.mode === 'Owner-operators' ? cp.owner : cp.company) || []),
    'Amazon Relay steps: invite by email, create the Amazon account, finish the Relay profile, the Accurate background check, then Amazon verifies (usually 2 to 7 days).',
    'Never send SSN, license numbers or bank details in Telegram; enter them only on Amazon\'s or Accurate\'s own website.'];
}
// Our team (or, in the accounting group, accounting): an answer to a question the bot could not answer is learned
async function learnFrom(chat, m, who, text) {
  if (!text || text.startsWith('/')) return;
  await q(`UPDATE tg_drafts SET state = 'answered', decided_at = now(), sent_by = $2 WHERE chat_id = $1 AND state = 'open'`, [chat.chat_id, who.name]);
  const qn = (await q(`SELECT * FROM tg_questions WHERE chat_id = $1 AND answer IS NULL AND asked_at > now() - interval '24 hours'
    AND ($2::bigint IN (msg_id, bot_msg_id) OR ($2::bigint IS NULL AND asked_at > now() - interval '3 hours')) ORDER BY asked_at DESC LIMIT 1`, [chat.chat_id, m.reply_to_message ? m.reply_to_message.message_id : null])).rows[0];
  if (qn) await learn(qn, bot.redact(text), who.name, chat.kind === 'accounting' ? 'accounting' : 'general');
}
async function onMessage(chat, m, who) {
  const text = (m.text || m.caption || '').trim();
  if (isStaff(who)) return learnFrom(chat, m, who, text);
  const st = (await q(`SELECT status FROM drivers WHERE id = $1`, [chat.driver_id])).rows[0];
  if (!st || st.status === 'Hired' || chat.member_count > 10) return; // an active driver's group (or more than 10 people): the team handles it, the bot reads along (digest)
  let c = await caseOf(chat.driver_id);
  if (!c || c.chat_id !== chat.chat_id) { await q(`INSERT INTO onb_cases (driver_id, chat_id, last_amazon) SELECT id, $2, amazon_step FROM drivers WHERE id = $1 ON CONFLICT (driver_id) DO UPDATE SET chat_id = $2`, [chat.driver_id, chat.chat_id]); c = await caseOf(chat.driver_id); }
  if (who.role && who.role !== 'driver') return; // ELD, accounting, dispatch people: not the driver
  await require('./mvr').fromGroup(c, m, m.text || m.caption || '').catch((e) => console.error('mvr', e.message)); // the last 4 of the SSN, the ZIP, the CDL state
  const watch = c.bot_mode === 'watch'; // watch and learn: the bot says nothing in the group; the reply it would send waits on the website
  // a driver nobody named yet: whoever writes with the driver's first name
  if (!who.role && !(await driverPerson(c.driver_id)) && who.name.split(/\s+/)[0].toLowerCase() === c.name.split(/\s+/)[0].toLowerCase()) {
    await q(`UPDATE tg_people SET role = 'driver', driver_id = $2 WHERE tg_id = $1`, [who.tg_id, c.driver_id]); who.role = 'driver';
  }
  const file = m.photo ? { id: m.photo[m.photo.length - 1].file_id, mime: 'image/jpeg' } : m.document && /^(image\/|application\/pdf)/.test(m.document.mime_type || '') ? { id: m.document.file_id, mime: m.document.mime_type } : null;
  if (file && ai.on()) return watch ? null : readFile(c, m, who, file); // pictures: the digest reads them
  if (!text || !ai.on() || bot.trivial(m)) return; // "ok", "thanks", 👍: nothing to answer
  const context = `Name: ${c.name}. ${c.mode === 'Owner-operators' ? 'Owner-operator' : 'Company driver'}. Amazon Relay step: ${c.amazon_step ? db.AMAZON.find((s) => s.key === c.amazon_step).long : 'invite not sent yet'}. Start date: ${c.arrive ? nice(c.arrive) : 'not set yet'}.${c.unit ? ` Truck: ${c.unit} ${c.details || ''}.` : ''}${c.arrival_note ? ` Travel: ${c.arrival_note}.` : ''}${c.company ? ` Company: ${c.company}.` : ''}`;
  return qa(c, chat, m, who, text, { context, mode: c.bot_mode, escalate: () => recruiterTag(c), kinds: ['general'], onProgress: (k) => moveAmazon(c, k, who.name) });
}
// Answer a driver's message from the facts and knowledge; if unsure, ask a person and remember their answer.
// c: { name, driver_id, chat_id, owner_id, mode }; opts: { context, escalate() -> tag, kinds, onProgress(key), who: 'recruiter' }
// the reply waits on the website (Send / Not needed); a newer one replaces it
async function draft(c, chat, m, text, kind, reply) {
  if (!String(reply || '').trim()) return;
  await q(`UPDATE tg_drafts SET state = 'replaced', decided_at = now() WHERE chat_id = $1 AND state = 'open'`, [chat.chat_id]);
  await q(`INSERT INTO tg_drafts (chat_id, driver_id, msg_id, driver_text, draft, kind) VALUES ($1, $2, $3, $4, $5, $6)`, [chat.chat_id, c.driver_id, m.message_id, bot.redact(text).slice(0, 1000), String(reply).slice(0, 1500), kind]);
  await bot.log('draft', `Reply ready on the website for ${c.name}: "${String(reply).slice(0, 120)}"`, { chatId: chat.chat_id, driverId: c.driver_id });
}
// Answer a driver's message. watch: every reply waits on the website. assist: questions it is sure about are answered, the rest waits.
// run: it answers what it is sure about (questions and other messages); a question it cannot answer goes to a person.
async function qa(c, chat, m, who, text, opts) {
  const mode = opts.mode || 'run';
  // someone from the team is talking with the driver right now: let them (a draft is still fine in watch)
  const busy = mode !== 'watch' && (await q(`SELECT 1 FROM tg_messages x JOIN tg_people p ON p.tg_id = x.from_id WHERE x.chat_id = $1 AND x.at > now() - interval '10 minutes' AND (p.role IN ('staff', 'accounting') OR p.user_id IS NOT NULL) AND x.text NOT LIKE '/%' AND x.text !~* '^register\\y' LIMIT 1`, [chat.chat_id])).rows[0];
  const knowledge = (await q(`SELECT question, answer FROM tg_knowledge WHERE active AND kind = ANY($1::text[]) ORDER BY uses DESC, created_at DESC LIMIT 80`, [opts.kinds])).rows;
  const recent = (await q(`SELECT from_name, is_bot, text FROM tg_messages WHERE chat_id = $1 AND text IS NOT NULL ORDER BY at DESC LIMIT 12`, [chat.chat_id])).rows.reverse().map((x) => `${x.is_bot ? 'Bot' : x.from_name}: ${String(x.text).slice(0, 300)}`);
  let plan;
  try { plan = await ai.driverReply({ facts: companyFacts(c), knowledge, context: opts.context, recent, text, role: opts.role }); } catch (e) { console.error('tg qa ai', e.message); return; }
  if (plan.progress && PROGRESS_TO[plan.progress] && opts.onProgress) await opts.onProgress(PROGRESS_TO[plan.progress]);
  const upset = plan.mood === 'angry' || plan.mood === 'unhappy';
  const sure = plan.is_question ? plan.confident && plan.answer : plan.confident && plan.reply;
  const words = plan.is_question && plan.confident && plan.answer ? plan.answer : plan.reply;
  if (mode === 'watch' || busy) { if (upset || plan.is_question || plan.needs_reply) await draft(c, chat, m, text, upset ? 'upset' : plan.is_question && plan.confident ? 'answer' : 'reply', words); return; }
  if (upset) { // a person, not the bot: tag someone, nothing to learn
    await send(chat.chat_id, `${await opts.escalate()}, ${esc(c.name.split(/\s+/)[0])} needs you here.`, { replyTo: m.message_id });
    await draft(c, chat, m, text, 'upset', plan.reply);
    return tell(c, `${c.name} seems ${plan.mood} in the ${bot.KINDS[chat.kind] || ''} group: "${bot.redact(text).slice(0, 140)}"`);
  }
  if (plan.is_question) {
    if (sure) {
      await send(chat.chat_id, esc(plan.answer), { replyTo: m.message_id });
      // counted: how often the bot could answer without the team (autopilot readiness)
      await q(`INSERT INTO tg_questions (chat_id, driver_id, msg_id, text, answer, answered_by, answered_at) VALUES ($1, $2, $3, $4, $5, 'Bot', now())`, [chat.chat_id, c.driver_id, m.message_id, bot.redact(text).slice(0, 1000), String(plan.answer).slice(0, 1500)]);
    }
    else {
      const b = await send(chat.chat_id, `Good question. Let me check with ${await opts.escalate()}.`, { replyTo: m.message_id });
      await q(`INSERT INTO tg_questions (chat_id, driver_id, msg_id, bot_msg_id, text) VALUES ($1, $2, $3, $4, $5)`, [chat.chat_id, c.driver_id, m.message_id, b.message_id, bot.redact(text).slice(0, 1000)]);
      await draft(c, chat, m, text, 'reply', plan.reply);
    }
    return;
  }
  if (plan.needs_reply && plan.reply) {
    if (mode === 'run' && sure) { await send(chat.chat_id, esc(plan.reply), { replyTo: m.message_id }); await bot.log('reply', `Answered ${c.name}: "${String(plan.reply).slice(0, 120)}"`, { chatId: chat.chat_id, driverId: c.driver_id }); }
    else await draft(c, chat, m, text, 'reply', plan.reply);
  }
}
async function learn(qn, answer, by, kind = 'general') {
  await q(`UPDATE tg_questions SET answer = $2, answered_by = $3, answered_at = now() WHERE id = $1`, [qn.id, answer.slice(0, 1500), by]);
  await q(`INSERT INTO tg_knowledge (question, answer, source, added_by, chat_id, kind) VALUES ($1, $2, 'learned', $3, $4, $5)`, [qn.text, answer.slice(0, 1500), by, qn.chat_id, kind]);
}
async function readFile(c, m, who, file) {
  let r;
  try { const buf = await bot.download(file.id); r = await ai.onbDoc(buf, file.mime); } catch (e) { console.error('tg onb doc', e.message); return; }
  await bot.noteMedia(c.chat_id, m.message_id, `${r.kind}${r.result ? ' ' + r.result : ''}: ${r.note}`);
  if (r.kind === 'relay_screen') {
    if (r.relay_stage === 'approved') {
      await send(c.chat_id, `This looks like Amazon approved ${esc(c.name.split(/\s+/)[0])}! ${await recruiterTag(c)}, please confirm in Relay:`, { replyTo: m.message_id, buttons: [[['✅ Confirm verified', `onb:${c.driver_id}:verify`], ['Not yet', `onb:${c.driver_id}:notyet`]]] });
      return tell(c, `${c.name} sent a Relay screenshot that looks approved. Please confirm.`);
    }
    if (r.relay_stage === 'not_approved') { await send(c.chat_id, `Thanks. ${await recruiterTag(c)}, please look at this.`, { replyTo: m.message_id }); return tell(c, `${c.name}'s Relay screenshot looks not approved.`); }
    const key = STAGE_TO[r.relay_stage];
    if (key && await moveAmazon(c, key, who.name)) return;
    return send(c.chat_id, `Thanks, I see your Amazon Relay screen (${esc(r.note)}).`, { replyTo: m.message_id });
  }
  if (REPORT[r.kind]) {
    const findings = (r.findings || []).map((x) => bot.redact(String(x)).slice(0, 200)).slice(0, 8);
    const ins = (await q(`INSERT INTO tg_reports (driver_id, chat_id, msg_id, kind, result, findings, note, from_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [c.driver_id, c.chat_id, m.message_id, r.kind, r.result || 'unknown', JSON.stringify(findings), String(r.note || '').slice(0, 200), who.name])).rows[0];
    await send(c.chat_id, `Thanks, I got your ${REPORT[r.kind]}: <b>${RESULT[r.result] || 'could not tell'}</b>.${findings.length ? '\n' + findings.map((x) => '• ' + esc(x)).join('\n') : ''}\n${await recruiterTag(c)}, please review:`,
      { replyTo: m.message_id, buttons: [[['✅ Approve', `onb:${c.driver_id}:rep_ok:${ins.id}`], ['⚠️ Needs a look', `onb:${c.driver_id}:rep_look:${ins.id}`]]] });
    await refreshCard(c);
    return tell(c, `${c.name} sent a ${REPORT[r.kind]}: ${RESULT[r.result] || 'could not tell'}${findings.length ? ' (' + findings.slice(0, 2).join('; ') + ')' : ''}`, false);
  }
  if (r.kind === 'cdl' && r.state) await require('./mvr').setFacts(c.driver_id, { state: r.state }, 'AI', { onlyEmpty: true }).catch(() => {});
  if ((r.kind === 'cdl' || r.kind === 'medical_card') && /^\d{4}-\d{2}-\d{2}$/.test(r.expires || '')) {
    await q(`UPDATE drivers SET ${r.kind === 'cdl' ? 'cdl_expires' : 'med_expires'} = $2, updated_at = now() WHERE id = $1`, [c.driver_id, r.expires]);
    const soon = new Date(r.expires) < new Date(Date.now() + 60 * 864e5);
    await send(c.chat_id, `Got your ${r.kind === 'cdl' ? 'CDL' : 'medical card'} ✓ It expires ${nice(r.expires)}.${soon ? ' That is soon: please renew it before you start.' : ''}`, { replyTo: m.message_id });
    if (soon) await tell(c, `${c.name}'s ${r.kind === 'cdl' ? 'CDL' : 'medical card'} expires ${nice(r.expires)}.`);
  }
}

// ---------- every minute ----------
async function tick() {
  if (!bot.state.me) return;
  const tz = db.settings.tz;
  const L = (await q(`SELECT extract(hour FROM now() AT TIME ZONE $1)::int h, (now() AT TIME ZONE $1)::date::text d, ((now() AT TIME ZONE $1)::date + 1)::text tmr`, [tz])).rows[0];
  const day = !!process.env.TG_NO_QUIET || (L.h >= 9 && L.h < 20); // reminders in the daytime only (TG_NO_QUIET: tests only)
  const cases = (await q(`SELECT c.driver_id FROM onb_cases c JOIN tg_chats ch ON ch.chat_id = c.chat_id AND ch.active AND ch.kind = 'dispatch' AND ch.driver_id = c.driver_id
    JOIN drivers d ON d.id = c.driver_id WHERE c.mode = 'run' AND d.status NOT IN ('Hired', 'Rejected', 'Not interested', 'No CDL', 'Declined on Indeed') AND d.left_on IS NULL`)).rows;
  await require('./mvr').purge().catch(() => {});
  for (const { driver_id: id } of cases) {
    const c = await caseOf(id); if (!c) continue;
    if (day) await require('./mvr').ask(id).catch((e) => console.error('mvr ask', e.message)); // CDL state, ZIP, the last 4 for a PA MVR
    // the Amazon step moved (here, on the website or in the extension)
    if ((c.amazon_step || null) !== (c.last_amazon || null)) {
      await q(`UPDATE onb_cases SET last_amazon = $2, nudge = NULL WHERE driver_id = $1`, [id, c.amazon_step]);
      await refreshCard(c);
      if (db.amazonIdx(c.amazon_step) > db.amazonIdx(c.last_amazon)) await guide(c);
      if (c.amazon_step === 'verified') await require('../needed').check(id).catch(() => {});
      continue;
    }
    // a step that stalls: remind the driver (daytime, once a day, 3 times), then tell the recruiter
    const since = c.amazon_log && c.amazon_step && c.amazon_log[c.amazon_step] ? new Date(c.amazon_log[c.amazon_step]) : new Date(c.started_at);
    const n = c.nudge || { count: 0 }; const hrs = (Date.now() - Math.max(since.getTime(), n.at ? new Date(n.at).getTime() : 0)) / 36e5;
    if (day && ['invite', 'account', 'profile', 'accurate'].includes(c.amazon_step) && hrs >= 24) {
      if (n.count < 3) { await guide(c, { remind: true }); await q(`UPDATE onb_cases SET nudge = $2 WHERE driver_id = $1`, [id, JSON.stringify({ count: n.count + 1, at: new Date() })]); }
      else if (!n.told) { await tell(c, `${c.name} has been stuck at the Amazon step "${db.AMAZON.find((s) => s.key === c.amazon_step).label}" for days, after 3 reminders.`); await q(`UPDATE onb_cases SET nudge = $2 WHERE driver_id = $1`, [id, JSON.stringify({ ...n, told: true })]); }
    }
    const sent = c.sent || {};
    if (c.amazon_step === 'waiting' && (Date.now() - since.getTime()) > 7 * 864e5 && !sent.wait7) {
      await tell(c, `${c.name} has been waiting for Amazon for 7 days. Worth checking in Relay or with Amazon.`);
      await q(`UPDATE onb_cases SET sent = sent || '{"wait7": true}' WHERE driver_id = $1`, [id]);
    }
    // the day before the start: the arrival details
    if (c.arrive === L.tmr && !c.arrived_on && L.h >= 10 && !sent['arr_' + c.arrive]) {
      await send(c.chat_id, `🗓 ${await driverTag(c)}, tomorrow is your start day!${c.arrival_note ? `\n${esc(c.arrival_note)}` : ''}${c.unit ? `\nYour truck: <b>${esc(c.unit)}</b>${c.details ? ` (${esc(c.details)})` : ''}` : ''}\nIf anything changes, write here right away.`);
      await q(`UPDATE onb_cases SET sent = sent || $2::jsonb WHERE driver_id = $1`, [id, JSON.stringify({ ['arr_' + c.arrive]: true })]);
    }
  }
  // questions nobody answered for 2 hours (daytime): the recruiter hears again
  if (day) {
    const qs = (await q(`SELECT q.*, c.driver_id cd FROM tg_questions q JOIN onb_cases c ON c.chat_id = q.chat_id WHERE q.answer IS NULL AND q.asked_at < now() - interval '2 hours' AND q.asked_at > now() - interval '3 days' AND NOT coalesce((SELECT (sent ->> ('q' || q.id))::boolean FROM onb_cases WHERE driver_id = c.driver_id), false)`)).rows;
    for (const x of qs) {
      const c = await caseOf(x.cd); if (!c) continue;
      await tell(c, `${c.name}'s question is still waiting for an answer: "${x.text.slice(0, 140)}"`, false);
      await q(`UPDATE onb_cases SET sent = sent || $2::jsonb WHERE driver_id = $1`, [x.cd, JSON.stringify({ ['q' + x.id]: true })]);
    }
  }
}
// An answer written on the website: the bot posts it in the group and learns it
// a reply the bot wrote, sent from the website (as written or changed). A changed one is also learned (to approve in Knowledge)
async function sendDraft(dr, text, user) {
  const sent = await send(dr.chat_id, esc(text), { replyTo: dr.msg_id || undefined });
  const edited = text.trim() !== String(dr.draft).trim();
  await q(`UPDATE tg_drafts SET state = 'sent', sent_text = $2, sent_by = $3, decided_at = now() WHERE id = $1`, [dr.id, text.slice(0, 1500), user.name]);
  await bot.log('reply', `${user.name} sent the bot's reply${edited ? ' (changed)' : ''}: "${text.slice(0, 120)}"`, { chatId: dr.chat_id, driverId: dr.driver_id, who: user.name });
  if (edited && dr.driver_text) {
    const qn = (await q(`INSERT INTO tg_questions (chat_id, driver_id, msg_id, text) VALUES ($1, $2, $3, $4) RETURNING *`, [dr.chat_id, dr.driver_id, dr.msg_id, dr.driver_text])).rows[0];
    const k = (await q(`SELECT kind FROM tg_chats WHERE chat_id = $1`, [dr.chat_id])).rows[0];
    await learn(qn, text, user.name, k && k.kind === 'accounting' ? 'accounting' : 'general');
  }
  return sent;
}
async function answerFromWebsite(qid, answer, user) {
  const qn = (await q(`SELECT * FROM tg_questions WHERE id = $1`, [qid])).rows[0]; if (!qn) return null;
  await send(qn.chat_id, `${esc(answer)}\n<i>(${esc(user.name)})</i>`, { replyTo: qn.msg_id });
  const k = (await q(`SELECT kind FROM tg_chats WHERE chat_id = $1`, [qn.chat_id])).rows[0];
  await learn(qn, answer, user.name, k && k.kind === 'accounting' ? 'accounting' : 'general');
  return true;
}
function start() { setInterval(() => tick().catch((e) => console.error('onb tick', e.message)), +process.env.TG_TICK_MS || 60000); }
bot.handlers.dispatch = { begin, onButton, onMessage, status, setMode };
module.exports = { sendDraft, draft, start, tick, caseOf, setMode, MODES, answerFromWebsite, qa, learnFrom, tell, companyFacts, REPORT, RESULT };
