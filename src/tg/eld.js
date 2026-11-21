// ELD group: the bot walks the driver and the ELD team through the setup, then asks the ELD team to check
// the driver's logs at set times every day, tags them again when nobody answers, and tells the recruiter
// (and the admins) on the website when something is stuck or wrong.
//
// Setup, in order:
//   info          the bot posts the driver's name, phone, email, company, truck and start date
//   cdl, registration    the driver (or recruiter) sends a photo of the CDL and the truck registration
//   login         the ELD team sends the ELD login
//   logged_in, manual, paper    the driver logs in, keeps the printed ELD manual and blank paper logs in the truck
//   checked       the ELD team checks the setup
const db = require('../db');
const bot = require('./bot');
const ai = require('./ai');
const { q } = db;
const { send, edit, esc, tag } = bot;

const STEPS = [
  { k: 'info', label: 'Driver info shared with the ELD team', who: 'bot' },
  { k: 'cdl', label: 'CDL photo shared', who: 'driver' },
  { k: 'registration', label: 'Truck registration shared', who: 'driver' },
  { k: 'login', label: 'ELD login sent by the ELD team', who: 'eld' },
  { k: 'logged_in', label: 'Driver logged in to the ELD app', who: 'driver' },
  { k: 'manual', label: 'Printed ELD manual in the truck', who: 'driver' },
  { k: 'paper', label: 'Blank paper logs in the truck', who: 'driver' },
  { k: 'checked', label: 'ELD team checked the setup', who: 'eld' }
];
const PHASES = [['docs', ['cdl', 'registration']], ['login', ['login']], ['driver', ['logged_in', 'manual', 'paper']], ['checked', ['checked']]];
const phaseOf = (steps) => { for (const [p, ks] of PHASES) if (ks.some((k) => !steps[k])) return p; return 'done'; };
const BTN = { cdl: '✅ CDL sent', registration: '✅ Registration sent', login: '✅ Login sent', logged_in: '✅ I logged in', manual: '✅ ELD manual in the truck', paper: '✅ Paper logs in the truck' };

// ---------- who is who ----------
async function driverPerson(driverId) { return (await q(`SELECT * FROM tg_people WHERE role = 'driver' AND driver_id = $1 ORDER BY seen_at DESC LIMIT 1`, [driverId])).rows[0] || null; }
async function eldPeople(chatId) {
  const r = (await q(`SELECT p.* FROM tg_people p JOIN tg_members m ON m.tg_id = p.tg_id AND m.chat_id = $1 WHERE p.role = 'eld'`, [chatId])).rows;
  const known = new Set(r.map((p) => (p.username || '').toLowerCase()));
  const extra = (db.settings.tg.eldTeam || []).filter((u) => !known.has(u.slice(1).toLowerCase())).map((u) => ({ username: u.slice(1) }));
  return [...r, ...extra];
}
const eldTags = async (chatId) => { const p = await eldPeople(chatId); return p.length ? p.map(tag).join(' ') : 'ELD team'; };
const driverTag = async (c) => { const p = await driverPerson(c.driver_id); return p ? tag(p) : `<b>${esc(c.name)}</b>`; };
const isStaff = (who) => who && (who.role === 'staff' || !!who.user_id);
const can = (who, side, driverId) => isStaff(who) || (side === 'driver' ? who.role === 'driver' && who.driver_id === driverId : who.role === 'eld');

// ---------- the case ----------
async function caseOf(driverId) {
  return (await q(`SELECT c.*, d.name, d.owner_id, d.status FROM eld_cases c JOIN drivers d ON d.id = c.driver_id WHERE c.driver_id = $1`, [driverId])).rows[0];
}
async function setSteps(c, steps, wait) {
  await q(`UPDATE eld_cases SET steps = $2, wait = $3 WHERE driver_id = $1`, [c.driver_id, JSON.stringify(steps), wait === undefined ? (c.wait ? JSON.stringify(c.wait) : null) : wait && JSON.stringify(wait)]);
  c.steps = steps; if (wait !== undefined) c.wait = wait;
}
function cardHtml(c) {
  const s = c.steps || {}; const t = db.settings.tg;
  return `🛠 <b>ELD setup: ${esc(c.name)}</b>\n${STEPS.map((x) => `${s[x.k] ? '✅' : '⬜'} ${x.label}${s[x.k] && s[x.k].by && x.k !== 'info' ? ` <i>(${esc(s[x.k].by)})</i>` : ''}`).join('\n')}`
    + (c.setup_done_at ? `\n\n✅ <b>Setup complete.</b> Daily checks: ${t.eldTimes.join(', ')}${t.eldDays ? `, for ${t.eldDays} days` : ''}.` : `\n\nDaily checks start after the setup: ${t.eldTimes.join(', ')}${t.eldDays ? `, for ${t.eldDays} days` : ''}.`);
}
async function refreshCard(c) {
  const ch = (await q(`SELECT card_msg_id FROM tg_chats WHERE chat_id = $1`, [c.chat_id])).rows[0];
  if (ch && ch.card_msg_id) await edit(c.chat_id, ch.card_msg_id, cardHtml(c)).catch(() => {});
}
async function driverInfo(driverId) {
  const d = (await q(`SELECT d.*, co.name company, t.unit, t.details, to_char(o.expected_arrival, 'Dy, Mon FMDD') arrive FROM drivers d LEFT JOIN companies co ON co.id = d.company_id
    LEFT JOIN trucks t ON t.driver_id = d.id LEFT JOIN onboarding o ON o.driver_id = d.id WHERE d.id = $1`, [driverId])).rows[0];
  const oo = d.mode === 'Owner-operators';
  const phone = (d.phones || [])[0]; const nice = phone && /^\d{10}$/.test(phone) ? `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}` : phone;
  const truck = d.unit ? `${d.unit}${d.details ? ` (${d.details})` : ''}` : oo && (d.truck_year || d.truck_model) ? `own truck, ${[d.truck_year, d.truck_model].filter(Boolean).join(' ')}` : 'not set yet';
  return `🪪 <b>Driver for the ELD account</b>\nName: <b>${esc(d.name)}</b>\nPhone: ${esc(nice || 'not given')}\nEmail: ${esc((d.emails || [])[0] || 'not given')}\nCompany: ${esc(d.company || 'not set yet')}\nTruck: ${esc(truck)}\nType: ${oo ? 'Owner-operator' : 'Company driver'}${d.arrive ? `\nStarts: ${esc(d.arrive)}` : ''}`;
}

// ---------- start, after the group is linked ----------
async function begin(chatId, driverId) {
  await q(`INSERT INTO eld_cases (driver_id, chat_id, steps) VALUES ($1, $2, $3) ON CONFLICT (driver_id) DO UPDATE SET chat_id = $2, stopped_at = NULL`, [driverId, chatId, JSON.stringify({ info: { at: new Date().toISOString(), by: 'bot' } })]);
  const c = await caseOf(driverId);
  if (!c.steps.info) await setSteps(c, { ...c.steps, info: { at: new Date().toISOString(), by: 'bot' } });
  await send(chatId, await driverInfo(driverId));
  const card = await send(chatId, cardHtml(c));
  await q(`UPDATE tg_chats SET card_msg_id = $2 WHERE chat_id = $1`, [chatId, card.message_id]);
  await send(chatId, '👋 So I know who is who, please tap one:', { buttons: [[['🚚 I am the driver', `eld:${driverId}:iam:driver`], ['🛠 I am with the ELD team', `eld:${driverId}:iam:eld`]]] });
  await next(c, { force: true });
}
// Ask whoever is due for the next step (or remind them)
async function next(c, { force = false, remind = false } = {}) {
  const ph = phaseOf(c.steps);
  if (!force && !remind && c.wait && c.wait.phase === ph) return; // already asked
  const s = c.steps; const pre = remind ? '⏰ Reminder: ' : '';
  let m = null;
  if (ph === 'docs') {
    const need = ['cdl', 'registration'].filter((k) => !s[k]);
    m = await send(c.chat_id, `${pre}📄 ${await driverTag(c)}, please send here ${need.map((k) => (k === 'cdl' ? 'a photo of your <b>CDL</b> (front)' : 'the truck <b>registration</b> (cab card)')).join(' and ')}. A photo or a PDF is fine.`, { buttons: [need.map((k) => [BTN[k], `eld:${c.driver_id}:mark:${k}`])] });
  } else if (ph === 'login') {
    m = await send(c.chat_id, `${pre}🛠 ${await eldTags(c.chat_id)}, the documents for <b>${esc(c.name)}</b> are above. Please create the ELD account and send the <b>login</b> (user name and password) in this group.`, { buttons: [[[BTN.login, `eld:${c.driver_id}:mark:login`]]] });
  } else if (ph === 'driver') {
    const need = ['logged_in', 'manual', 'paper'].filter((k) => !s[k]);
    const say = { logged_in: 'Log in to the ELD app with the login above', manual: 'Print the ELD manual (instruction card) and keep it in the truck', paper: 'Keep blank paper logs (for at least 8 days) in the truck' };
    m = await send(c.chat_id, `${pre}🚚 ${await driverTag(c)}, please:\n${need.map((k, i) => `${i + 1}. ${say[k]}`).join('\n')}\nTap each one when it is done.`, { buttons: need.map((k) => [[BTN[k], `eld:${c.driver_id}:mark:${k}`]]) });
  } else if (ph === 'checked') {
    m = await send(c.chat_id, `${pre}🛠 ${await eldTags(c.chat_id)}, <b>${esc(c.name)}</b> is logged in and has the manual and paper logs. Please check the setup in your system (driver profile, truck, trailer, documents) and tap one:`, { buttons: [[['✅ Setup is good', `eld:${c.driver_id}:mark:checked`], ['⚠️ Problem', `eld:${c.driver_id}:setup_problem`]]] });
  } else if (!c.setup_done_at) return finishSetup(c);
  if (m) await setSteps(c, c.steps, { phase: ph, at: new Date().toISOString(), count: remind ? ((c.wait && c.wait.count) || 0) + 1 : 0, msg: m.message_id });
}
async function finishSetup(c) {
  await q(`UPDATE eld_cases SET setup_done_at = now(), wait = NULL WHERE driver_id = $1`, [c.driver_id]); c.setup_done_at = new Date(); c.wait = null;
  await q(`UPDATE checklist SET done = true, done_at = coalesce(done_at, now()) WHERE driver_id = $1 AND key = 'eld_profile' AND NOT done`, [c.driver_id]);
  await q(`UPDATE drivers SET updated_at = now() WHERE id = $1`, [c.driver_id]);
  const t = db.settings.tg;
  await send(c.chat_id, `✅ <b>ELD setup for ${esc(c.name)} is complete.</b>\nFrom now on I will ask the ELD team to check the logs every day at ${t.eldTimes.join(' and ')}${t.eldDays ? ` for ${t.eldDays} days` : ''}.`);
  await refreshCard(c);
  await tell(c, `ELD setup for ${c.name} is complete. Daily ELD checks have started.`);
}
async function mark(c, k, by) {
  if (c.steps[k]) return false;
  const was = phaseOf(c.steps);
  await setSteps(c, { ...c.steps, [k]: { at: new Date().toISOString(), by } });
  await refreshCard(c);
  if (phaseOf(c.steps) !== was) await next(c, { force: true });
  return true;
}
// The recruiter and the admins on the website
async function tell(c, text) {
  const to = new Set((await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id)); if (c.owner_id) to.add(c.owner_id);
  for (const id of to) await db.notify(db.pool, id, 'tg', text, '#/telegram/' + c.chat_id, { driverId: c.driver_id, merge: true });
}

// ---------- buttons ----------
async function onButton(chat, cq, who) {
  const [, did, act, arg] = cq.data.split(':'); const driverId = +did;
  const c = await caseOf(driverId); if (!c || c.driver_id !== chat.driver_id) return 'This button is from an old setup.';
  if (act === 'iam') {
    if (arg === 'driver') {
      const cur = await driverPerson(driverId);
      if (cur && cur.tg_id !== who.tg_id && !isStaff(who)) return `${cur.name} is already the driver here.`;
      if (who.role === 'eld') return 'You are with the ELD team.';
      await q(`UPDATE tg_people SET role = 'driver', driver_id = $2 WHERE tg_id = $1`, [who.tg_id, driverId]);
      return `Thanks ${who.name}, you are the driver ✓`;
    }
    if (who.role === 'driver') return 'You are the driver here.';
    await q(`UPDATE tg_people SET role = 'eld' WHERE tg_id = $1 AND (role IS NULL OR role IN ('eld', 'dispatch', 'accounting'))`, [who.tg_id]);
    return `Thanks ${who.name}, you are with the ELD team ✓`;
  }
  if (act === 'mark') {
    const st = STEPS.find((x) => x.k === arg); if (!st) return '';
    if (!can(who, st.who, driverId)) return st.who === 'driver' ? 'Only the driver can tap this.' : 'Only the ELD team can tap this.';
    const done = await mark(c, arg, who.name);
    // keep the buttons still to tap on that message
    const rest = (cq.message.reply_markup && cq.message.reply_markup.inline_keyboard || []).map((row) => row.filter((b) => b.callback_data !== cq.data && !(b.callback_data.startsWith(`eld:${driverId}:mark:`) && c.steps[b.callback_data.split(':')[3]]))).filter((row) => row.length);
    await bot.call('editMessageReplyMarkup', { chat_id: chat.chat_id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: rest } }).catch(() => {});
    return done ? `${st.label} ✓` : 'Already done ✓';
  }
  if (act === 'setup_problem') {
    if (!can(who, 'eld', driverId)) return 'Only the ELD team can tap this.';
    await setSteps(c, c.steps, { ...(c.wait || {}), problemFrom: who.tg_id, problemFor: 'setup' });
    await send(chat.chat_id, `${tag(who)}, what is wrong with the setup? Reply here and I will pass it on.`, { forceReply: true });
    return '';
  }
  if (act === 'check_ok' || act === 'check_problem') {
    if (!can(who, 'eld', driverId)) return 'Only the ELD team can tap this.';
    const ck = (await q(`SELECT * FROM eld_checks WHERE id = $1 AND driver_id = $2`, [+arg, driverId])).rows[0]; if (!ck) return '';
    if (ck.answer && ck.answer !== 'waiting_problem') return 'Already answered ✓';
    if (act === 'check_ok') {
      await q(`UPDATE eld_checks SET answer = 'ok', answered_by = $2, answered_at = now() WHERE id = $1`, [ck.id, who.name]);
      await bot.dropButtons(chat.chat_id, cq.message.message_id);
      await send(chat.chat_id, `✅ ${esc(ck.slot.slice(11))} check done by ${esc(who.name)}: all good.`, { replyTo: cq.message.message_id });
      return 'Thanks ✓';
    }
    await q(`UPDATE eld_checks SET answer = 'waiting_problem', answered_by = $2 WHERE id = $1`, [ck.id, 'tg:' + who.tg_id]);
    await bot.dropButtons(chat.chat_id, cq.message.message_id);
    await send(chat.chat_id, `${tag(who)}, what is wrong? Reply here and I will tell the driver.`, { forceReply: true });
    return '';
  }
  if (act === 'fixed') {
    if (!can(who, 'driver', driverId)) return 'Only the driver can tap this.';
    const ck = (await q(`UPDATE eld_checks SET fixed_at = now() WHERE id = $1 AND driver_id = $2 AND fixed_at IS NULL RETURNING *`, [+arg, driverId])).rows[0];
    await bot.dropButtons(chat.chat_id, cq.message.message_id);
    if (ck) await send(chat.chat_id, `👍 ${esc(who.name)} says it is fixed. ${await eldTags(chat.chat_id)}, please take another look.`);
    return 'Thanks ✓';
  }
  return '';
}

// ---------- messages ----------
const CRED = /\b(log\s?in|user\s?name|user\s?id|user|email|password|pass|pwd)\b\s*[:=-]/i;
async function onMessage(chat, m, who) {
  const c = await caseOf(chat.driver_id); if (!c || c.chat_id !== chat.chat_id) return;
  const text = m.text || m.caption || '';
  // a problem someone was asked to describe
  if (text && c.wait && c.wait.problemFrom === who.tg_id && c.wait.problemFor === 'setup') {
    await setSteps(c, { ...c.steps, problem: { text: bot.redact(text).slice(0, 500), by: who.name, at: new Date().toISOString() } }, { ...c.wait, problemFrom: null, problemFor: null });
    await send(chat.chat_id, `⚠️ ${await driverTag(c)}, the ELD team found a problem with the setup:\n“${esc(bot.redact(text).slice(0, 400))}”\nPlease fix it. ${await eldTags(chat.chat_id)}, tap "Setup is good" above when it is right.`);
    await tell(c, `ELD setup problem for ${c.name}: ${bot.redact(text).slice(0, 200)}`);
    return;
  }
  const waiting = (await q(`SELECT * FROM eld_checks WHERE driver_id = $1 AND answer = 'waiting_problem' AND answered_by = $2 ORDER BY id DESC LIMIT 1`, [c.driver_id, 'tg:' + who.tg_id])).rows[0];
  if (text && waiting) {
    const p = bot.redact(text).slice(0, 500);
    await q(`UPDATE eld_checks SET answer = 'problem', problem = $2, answered_by = $3, answered_at = now() WHERE id = $1`, [waiting.id, p, who.name]);
    await send(chat.chat_id, `⚠️ ${await driverTag(c)}, the ELD team found a problem in your logs:\n“${esc(p.slice(0, 400))}”\nPlease fix it and tap Fixed.`, { buttons: [[['✅ Fixed', `eld:${c.driver_id}:fixed:${waiting.id}`]]] });
    await tell(c, `ELD problem for ${c.name} (${waiting.slot.slice(11)} check): ${p.slice(0, 200)}`);
    return;
  }
  // the ELD login, from someone who is not the driver
  if (!c.steps.login && text && CRED.test(text) && /\b(password|pass|pwd)\b/i.test(text) && who.role !== 'driver') {
    if (!who.role) await q(`UPDATE tg_people SET role = 'eld' WHERE tg_id = $1`, [who.tg_id]);
    await mark(c, 'login', who.name);
    return;
  }
  // a document: what is it?
  const file = m.photo ? { id: m.photo[m.photo.length - 1].file_id, mime: 'image/jpeg' } : m.document && /^(image\/|application\/pdf)/.test(m.document.mime_type || '') ? { id: m.document.file_id, mime: m.document.mime_type } : null;
  if (!file) return;
  const open = ['cdl', 'registration', 'manual', 'paper'].filter((k) => !c.steps[k]);
  if (!open.length) return;
  let kind = null, note = null;
  if (ai.on()) {
    try { const buf = await bot.download(file.id); const r = await ai.docKind(buf, file.mime); kind = r.kind; note = r.note; await bot.noteMedia(chat.chat_id, m.message_id, `${r.kind}: ${r.note}`); }
    catch (e) { console.error('tg doc', e.message); }
  }
  const step = { cdl: 'cdl', registration: 'registration', eld_manual: 'manual', paper_logs: 'paper' }[kind];
  const sideOk = (k) => can(who, STEPS.find((x) => x.k === k).who === 'eld' ? 'eld' : 'driver', c.driver_id) || who.role !== 'eld';
  if (step && open.includes(step) && sideOk(step)) {
    await mark(c, step, who.name);
    await send(chat.chat_id, `Got it: ${STEPS.find((x) => x.k === step).label.replace(/ shared$/, '')} ✓`, { replyTo: m.message_id });
    return;
  }
  const ask = open.filter((k) => k === 'cdl' || k === 'registration');
  if (ask.length && phaseOf(c.steps) === 'docs') {
    await send(chat.chat_id, `What is this${note ? ` (${esc(note)})` : ''}?`, { replyTo: m.message_id, buttons: [[...ask.map((k) => [k === 'cdl' ? 'It is the CDL' : 'It is the registration', `eld:${c.driver_id}:mark:${k}`])]] });
  }
}
async function status(chat) {
  const c = await caseOf(chat.driver_id); if (!c) return;
  const card = await send(chat.chat_id, cardHtml(c));
  await q(`UPDATE tg_chats SET card_msg_id = $2 WHERE chat_id = $1`, [chat.chat_id, card.message_id]);
}

// ---------- every minute: reminders, daily checks ----------
function local(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, min: +p.hour * 60 + +p.minute };
}
const minOf = (hm) => +hm.slice(0, 2) * 60 + +hm.slice(3);
async function tick() {
  if (!bot.state.me) return;
  const t = db.settings.tg; const L = local(db.settings.tz);
  const quiet = !process.env.TG_NO_QUIET && (L.min < 7 * 60 || L.min >= 22 * 60); // no reminders at night (TG_NO_QUIET: tests only)
  // setup waiting on someone
  const open = (await q(`SELECT c.*, d.name, d.owner_id, d.status FROM eld_cases c JOIN drivers d ON d.id = c.driver_id JOIN tg_chats ch ON ch.chat_id = c.chat_id AND ch.active
    WHERE c.setup_done_at IS NULL AND c.stopped_at IS NULL AND c.wait IS NOT NULL`)).rows;
  for (const c of open) {
    const w = c.wait; const age = (Date.now() - new Date(w.at).getTime()) / 60000;
    if (quiet || age < t.remindMin) continue;
    if ((w.count || 0) < 2) await next(c, { remind: true });
    else if (!w.escalated) {
      const who = { docs: 'the driver (CDL and registration)', login: 'the ELD team (login)', driver: 'the driver (log in, manual, paper logs)', checked: 'the ELD team (setup check)' }[w.phase] || 'someone';
      await setSteps(c, c.steps, { ...w, escalated: true });
      await tell(c, `ELD setup for ${c.name} is stuck: waiting on ${who} after 3 reminders.`);
    }
  }
  // daily checks after the setup
  const live = (await q(`SELECT c.*, d.name, d.owner_id, d.status, ((now() AT TIME ZONE $1)::date - (c.setup_done_at AT TIME ZONE $1)::date + 1) dayn FROM eld_cases c JOIN drivers d ON d.id = c.driver_id
    JOIN tg_chats ch ON ch.chat_id = c.chat_id AND ch.active WHERE c.setup_done_at IS NOT NULL AND c.stopped_at IS NULL AND d.status IN ('Onboarding', 'Hired') AND d.left_on IS NULL`, [db.settings.tz])).rows;
  for (const c of live) {
    if (t.eldDays && c.dayn > t.eldDays) {
      await q(`UPDATE eld_cases SET stopped_at = now() WHERE driver_id = $1`, [c.driver_id]);
      await send(c.chat_id, `✅ ${t.eldDays} days of daily ELD checks for <b>${esc(c.name)}</b> are done. The ELD team keeps an eye on the logs as usual.`).catch(() => {});
      continue;
    }
    for (const hm of t.eldTimes) {
      const d = L.min - minOf(hm); if (d < 0 || d > 180) continue;
      const slot = `${L.date} ${hm}`;
      if (c.setup_done_at && new Date(c.setup_done_at) > new Date(Date.now() - d * 60000)) continue; // finished after this time today
      const ins = (await q(`INSERT INTO eld_checks (driver_id, chat_id, slot) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`, [c.driver_id, c.chat_id, slot])).rows[0];
      if (!ins) continue;
      const m = await send(c.chat_id, checkText(c, await eldTags(c.chat_id), false), { buttons: [[['✅ All good', `eld:${c.driver_id}:check_ok:${ins.id}`], ['⚠️ Problem', `eld:${c.driver_id}:check_problem:${ins.id}`]]] }).catch((e) => { console.error('tg check', e.message); return null; });
      if (m) await q(`UPDATE eld_checks SET msg_id = $2 WHERE id = $1`, [ins.id, m.message_id]);
    }
  }
  // checks nobody answered
  const late = (await q(`SELECT k.*, d.name, d.owner_id, c.chat_id cchat, c.setup_done_at, ((now() AT TIME ZONE $1)::date - (c.setup_done_at AT TIME ZONE $1)::date + 1) dayn FROM eld_checks k JOIN eld_cases c ON c.driver_id = k.driver_id JOIN drivers d ON d.id = k.driver_id
    WHERE k.answer IS NULL AND k.escalated_at IS NULL AND k.asked_at < now() - ($2 || ' minutes')::interval * (k.reminded + 1)`, [db.settings.tz, String(t.remindMin)])).rows;
  for (const k of late) {
    if (quiet) continue;
    const c = { ...k, chat_id: k.chat_id || k.cchat };
    if (k.reminded < 1) {
      await send(c.chat_id, `⏰ Reminder: ${checkText(c, await eldTags(c.chat_id), true)}`, { replyTo: k.msg_id, buttons: [[['✅ All good', `eld:${k.driver_id}:check_ok:${k.id}`], ['⚠️ Problem', `eld:${k.driver_id}:check_problem:${k.id}`]]] }).catch(() => {});
      await q(`UPDATE eld_checks SET reminded = reminded + 1 WHERE id = $1`, [k.id]);
    } else {
      await q(`UPDATE eld_checks SET escalated_at = now() WHERE id = $1`, [k.id]);
      await tell(c, `The ELD team has not done the ${k.slot.slice(11)} check for ${k.name}.`);
    }
  }
}
function checkText(c, tags, short) {
  const t = db.settings.tg;
  return `📋 <b>ELD check: ${esc(c.name)}</b>${c.dayn ? ` (day ${c.dayn}${t.eldDays ? ` of ${t.eldDays}` : ''})` : ''}\n${tags}, please check today's logs${short ? '.' : ':\n• logs signed\n• documents (BOL) uploaded\n• trailer number filled in\n• hours look right, no violations'}\nTap one:`;
}
function start() { setInterval(() => tick().catch((e) => console.error('eld tick', e.message)), +process.env.TG_TICK_MS || 60000); }
bot.handlers.eld = { begin, onButton, onMessage, status };
module.exports = { start, tick, STEPS, phaseOf, caseOf };
