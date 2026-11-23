// The shift desk: the bot works with the dispatchers on shift, one to one (a private chat with the bot), so nothing
// slips between shifts. While reading a working driver's group the AI notes what a dispatcher should confirm or act on:
// - rest: the driver sleeps or rests until a time ("I will wake up at 10:30") → "Got it? No calls until then"; at that
//   time the bot checks back ("he should be up now, did he check in?")
// - needs_load: the driver is empty or asks for a load → "Do you have a load? If not, send the best option you see now
//   and why it is good or not" (his text answer is saved)
// - question: the driver asked something and nobody on our side answered → "Did someone answer him?"
// - other: anything else to double check (the AI writes the question)
// Who is asked: the truck's dispatcher if he is on shift now, else the dispatchers on the shift now (Settings: 3 shifts).
// No answer in a while: the other dispatchers on shift are asked, then the admins are told on the website.
// Nothing is written in the driver's group (unless Settings say to ask in the group).
// Dispatcher levels: each dispatcher has a level (1 updates, 2 booking, 3 senior). Each kind of question goes to a level
// (Shift desk): "where is he rolling to" to level 1, "is his next load pre-booked" to level 2, a hard situation (breakdown,
// refused load, late, upset driver) to level 3. The truck's own dispatcher is asked when he is on shift and his level is
// high enough; else the shift's dispatchers of that level (none: the next level up, then down). No answer: the level up.
// Level 1 also gets a regular "where is he rolling to?" for working drivers with no update in a while.
const db = require('../db');
const { q } = db;
const LEVELS = { 1: 'Level 1 · Updates', 2: 'Level 2 · Booking', 3: 'Level 3 · Senior' };
const LEVEL_HELP = { 1: 'Where the driver is and where he is rolling to, ETA, rest and wake-up, simple questions', 2: 'Loads: empty drivers, pre-booked next loads, load options', 3: 'Hard situations: breakdowns, refused or late loads, wrong place, upset drivers' };
const KIND_LEVEL = { rolling: 1, rest: 1, wake: 1, question: 1, needs_load: 2, prebook: 2, other: 2, problem: 3 };
const KINDS = ['rolling', 'rest', 'question', 'needs_load', 'prebook', 'problem', 'other'];
const cfg = () => { const c = { on: true, where: 'private', answerMin: 15, shifts: [], ...((db.settings.tg || {}).desk || {}) }; return { ...c, levels: { ...KIND_LEVEL, ...(c.levels || {}) }, rolling: { on: true, hours: 6, ...(c.rolling || {}) } }; };
const levelFor = (kind) => Math.max(1, Math.min(3, +cfg().levels[kind] || KIND_LEVEL[kind] || 2));
const hm = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const TZS = { 'America/New_York': 'Eastern time', 'Asia/Tashkent': 'Tashkent time' };
async function nowMin(tz) { return +(await q(`SELECT extract(hour FROM now() AT TIME ZONE $1) * 60 + extract(minute FROM now() AT TIME ZONE $1) m`, [tz || db.settings.tz])).rows[0].m; }
// the shift now: each shift's hours are in its own time zone (Eastern or Tashkent); a night shift runs past midnight
async function shiftNow() {
  for (const s of cfg().shifts) { const n = await nowMin(s.tz); const a = hm(s.start), b = hm(s.end); if (a <= b ? n >= a && n < b : n >= a || n < b) return s; }
  return null;
}
// a shift's Telegram groups, each for some companies (none = every company); the old single group still works
const groupsOf = (s) => (s && Array.isArray(s.groups) ? s.groups : s && s.chatId ? [{ chatId: s.chatId, companies: [] }] : []).filter((g) => g.chatId);
function groupFor(s, companyId) {
  const gs = groupsOf(s);
  return gs.find((g) => (g.companies || []).map(Number).includes(Number(companyId))) || gs.find((g) => !(g.companies || []).length) || null;
}
async function driverCo(driverId) { return ((await q(`SELECT company_id FROM drivers WHERE id = $1`, [driverId])).rows[0] || {}).company_id || null; }
// the people to ask for this driver now: [{ user_id, name, tg_id }]
async function whoFor(driverId, skip = [], level = null) {
  const sh = await shiftNow(); let ids = sh ? (sh.people || []).map(Number) : [];
  // the shift has a group for this driver's company: only the shift's dispatchers who are in that group
  const g = sh ? groupFor(sh, await driverCo(driverId)) : null;
  if (g && ids.length) { const inG = (await q(`SELECT p.user_id FROM tg_members m JOIN tg_people p ON p.tg_id = m.tg_id WHERE m.chat_id = $1 AND p.user_id IS NOT NULL`, [g.chatId])).rows.map((r) => r.user_id); const both = ids.filter((x) => inG.includes(x)); if (both.length) ids = both; }
  const t = (await q(`SELECT dispatcher_id FROM trucks WHERE driver_id = $1 AND dispatcher_id IS NOT NULL LIMIT 1`, [driverId])).rows[0];
  let pick;
  if (level) {
    const lv = Object.fromEntries((await q(`SELECT id, coalesce(dispatch_level, 2) l FROM users WHERE id = ANY($1::int[])`, [[...ids, ...(t ? [t.dispatcher_id] : [])]])).rows.map((r) => [r.id, r.l]));
    const own = t && (!sh || ids.includes(t.dispatcher_id)) && !skip.includes(t.dispatcher_id) && (lv[t.dispatcher_id] || 2) >= level ? [t.dispatcher_id] : [];
    const free = ids.filter((x) => !skip.includes(x));
    // that level; none on shift: the closest level up, then the closest level down
    const order = [level, ...[1, 2, 3].filter((l) => l > level), ...[3, 2, 1].filter((l) => l < level)];
    pick = own;
    for (const l of order) { if (pick.length) break; pick = free.filter((x) => (lv[x] || 2) === l); }
  } else {
    pick = t && (!sh || ids.includes(t.dispatcher_id)) ? [t.dispatcher_id] : ids;
    pick = pick.filter((x) => !skip.includes(x));
  }
  if (!pick.length) return [];
  return (await q(`SELECT u.id user_id, u.name, (SELECT tg_id FROM tg_people p WHERE p.user_id = u.id ORDER BY seen_at DESC NULLS LAST LIMIT 1) tg_id FROM users u WHERE u.id = ANY($1::int[]) AND u.active`, [pick])).rows;
}
// the shift's own Telegram group (Settings: a group per shift), when the bot asks there
async function shiftGroup(driverId) { const sh = await shiftNow(); const g = sh ? groupFor(sh, await driverCo(driverId)) : null; return g ? g.chatId : null; }
async function tagOf(p) { const t = (await q(`SELECT tg_id, username, name FROM tg_people WHERE tg_id = $1`, [p.tg_id])).rows[0]; return require('./bot').tag(t || { tg_id: p.tg_id, name: p.name }); }
// "register shift Day" in a group, or the Shift desk page: this group is that shift's group
async function linkShift(chatId, name, by) {
  const c = cfg(); const i = c.shifts.findIndex((s) => s.name.toLowerCase() === String(name || '').trim().toLowerCase()); if (i < 0) return false;
  // added to that shift's groups (for every company until a company is picked on the Shift desk); taken off any other shift
  const shifts = c.shifts.map((s, k) => { const gs = groupsOf(s).filter((g) => String(g.chatId) !== String(chatId)); if (k === i) gs.push({ chatId: String(chatId), companies: [] }); const { chatId: _old, ...rest } = s; return { ...rest, groups: gs }; });
  await db.saveSetting('tg', { ...db.settings.tg, desk: { ...c, shifts } });
  await q(`UPDATE tg_chats SET kind = 'shift', driver_id = NULL, mode = 'watch', linked_at = now(), active = true WHERE chat_id = $1`, [chatId]);
  await q(`UPDATE tg_waiting SET done_at = now() WHERE chat_id = $1 AND done_at IS NULL`, [chatId]).catch(() => {});
  await require('./bot').log('connect', `Connected as the ${shifts[i].name} shift group: the bot asks the dispatchers on shift here (by ${by})`, { chatId });
  return true;
}
const BTN = {
  rest: [['✅ Got it', 'ok'], ['🙅 Not my driver', 'notmine']],
  needs_load: [['📦 Load booked', 'booked'], ['⏳ Still looking', 'looking'], ['🙅 Not my driver', 'notmine']],
  question: [['✅ Answered', 'ok'], ['👀 On it', 'onit'], ['🙅 Not my driver', 'notmine']],
  other: [['✅ Done', 'ok'], ['👀 On it', 'onit'], ['🙅 Not my driver', 'notmine']],
  rolling: [['😴 Resting', 'resting'], ['🅿️ Empty, no load', 'empty'], ['🙅 Not my driver', 'notmine']],
  prebook: [['✅ Pre-booked', 'booked'], ['⏳ Still looking', 'looking'], ['🙅 Not my driver', 'notmine']],
  problem: [['👀 On it', 'onit'], ['✅ Solved', 'ok'], ['🙅 Not my driver', 'notmine']],
  wake: [['✅ He is up', 'up'], ['📞 Calling him', 'calling']]
};
function question(k, d, a) {
  const who = `<b>${a.esc(d.name)}</b>${d.unit ? ` (truck ${a.esc(d.unit)})` : ''}`;
  if (k.kind === 'rest') return `${who} says he will be up at <b>${a.esc(k.until_text)}</b>.${k.quote ? ` "${a.esc(k.quote)}"` : ''}\nGot it? No calls until then. I will check with you at ${a.esc(k.until_text)}.`;
  if (k.kind === 'needs_load') return `${who} needs a load${k.place ? ` (${a.esc(k.place)})` : ''}.${k.quote ? ` "${a.esc(k.quote)}"` : ''}\nDo you have a load for him? If not, send me the best option you see now, and why it is good or not.`;
  if (k.kind === 'question') return `${who} asked: "${a.esc(k.quote || '')}"\nNobody answered him yet. Did someone answer him?`;
  if (k.kind === 'rolling') return `Where is ${who} rolling to now? Reply with the place and his ETA (for example "Hazleton, 3:30 PM").${k.ask ? `\n${a.esc(k.ask)}` : ''}`;
  if (k.kind === 'prebook') return `${who} ${k.place ? `finishes near <b>${a.esc(k.place)}</b>` : 'will be empty soon'}.${k.quote ? ` "${a.esc(k.quote)}"` : ''}\nIs his next load pre-booked? If yes, reply with it; if not, send me the best option you see and why.`;
  if (k.kind === 'problem') return `⚠️ ${who}: ${a.esc(k.ask || k.quote || '')}${k.quote && k.ask ? `\n"${a.esc(k.quote)}"` : ''}\nWhat is the plan? Reply with it.`;
  return `${who}: ${a.esc(k.ask || k.quote || '')}`;
}
async function ask(check, people) {
  const bot = require('./bot'); const c = cfg();
  const d = (await q(`SELECT d.name, (SELECT unit FROM trucks WHERE driver_id = d.id LIMIT 1) unit FROM drivers d WHERE d.id = $1`, [check.driver_id])).rows[0];
  const text = question(check, d, bot);
  let asked = 0;
  for (const p of people) {
    const buttons = [(BTN[check.kind] || BTN.other).map(([l, act]) => [l, `desk:${check.id}:${act}`])];
    try {
      let msg;
      const sg = c.where === 'shift' ? await shiftGroup(check.driver_id) : null; const mention = p.tg_id ? await tagOf(p) : bot.esc(p.name);
      let to;
      if (c.where === 'group') { to = check.chat_id; msg = await bot.send(to, `${mention}, ${text}`, { buttons }); }
      else if (sg) { to = sg; msg = await bot.send(to, `${mention}, ${text}`, { buttons }); }
      else { if (!p.tg_id) throw new Error('no Telegram'); to = p.tg_id; msg = await bot.send(to, text, { buttons }); }
      await q(`INSERT INTO tg_check_asks (check_id, user_id, tg_id, msg_id, chat_id) VALUES ($1, $2, $3, $4, $5)`, [check.id, p.user_id, p.tg_id || null, msg && msg.message_id, to]);
      asked++;
    } catch (e) {
      await bot.log('desk', `Could not ask ${p.name} privately (${p.tg_id ? 'he has not opened a chat with the bot: he sends /start to the bot once' : 'his Telegram is not connected: /me CODE'})`, { chatId: check.chat_id, driverId: check.driver_id });
    }
  }
  await q(`UPDATE tg_checks SET asked_at = coalesce(asked_at, now()), asked_n = asked_n + $2 WHERE id = $1`, [check.id, asked]);
  await bot.log('desk', `Asked ${people.map((p) => p.name).join(', ') || 'nobody (no one on shift)'}: ${bot.stripHtml(text).slice(0, 160)}`, { chatId: check.chat_id, driverId: check.driver_id });
  return asked;
}
async function open({ chatId, driverId, kind, quote = null, until = null, untilText = null, place = null, ask: askText = null }) {
  return (await q(`INSERT INTO tg_checks (chat_id, driver_id, kind, quote, until_at, until_text, place, ask, level) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [chatId, driverId, kind, quote, until, untilText, place ? String(place).slice(0, 100) : null, askText ? String(askText).slice(0, 300) : null, levelFor(kind)])).rows[0];
}
// from the AI: [{ kind: rolling | rest | question | needs_load | prebook | problem | other, quote, until (HH:MM), place, ask }]
async function fromGroup(chat, asks) {
  if (!cfg().on || !chat.driver_id) return;
  const bot = require('./bot');
  for (const a of (asks || []).slice(0, 3)) {
    const kind = KINDS.includes(a.kind) ? a.kind : 'other';
    if ((await q(`SELECT 1 FROM tg_checks WHERE chat_id = $1 AND kind = $2 AND state IN ('open', 'ok', 'onit', 'looking') AND created_at > now() - interval '3 hours'`, [chat.chat_id, kind])).rows[0]) continue;
    let until = null, untilText = null;
    if (kind === 'rest') { const m = /^(\d{1,2}):(\d{2})$/.exec(String(a.until || '').trim()); if (!m) continue;
      const r = (await q(`SELECT (date_trunc('day', now() AT TIME ZONE $1) + make_interval(hours => $2, mins => $3)) AT TIME ZONE $1 t`, [db.settings.tz, +m[1], +m[2]])).rows[0].t;
      until = new Date(r) < Date.now() - 5 * 60e3 ? new Date(new Date(r).getTime() + 864e5) : r; // a time already past today: tomorrow
      untilText = new Date(until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: db.settings.tz }); }
    const ch = await open({ chatId: chat.chat_id, driverId: chat.driver_id, kind, quote: a.quote ? bot.redact(String(a.quote)).slice(0, 300) : null, until, untilText, place: a.place, ask: a.ask });
    const people = await whoFor(chat.driver_id, [], ch.level);
    await ask(ch, people);
    if (!people.length) for (const id of (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id)) await db.notify(db.pool, id, 'desk', `Nobody on shift to ask about ${chat.driver}: ${bot.stripHtml(question(ch, { name: chat.driver }, bot)).slice(0, 200)}`, '#/telegram?tab=desk', { driverId: chat.driver_id });
  }
}
const SAID = { ok: 'Got it', booked: 'Load booked', looking: 'Still looking', notmine: 'Not my driver', onit: 'On it', up: 'He is up', calling: 'Calling him', empty: 'Empty, no load', resting: 'Resting' };
// a tap on the private question
async function onButton(cq, who) {
  const bot = require('./bot');
  const [, id, act] = cq.data.split(':'); const ch = (await q(`SELECT * FROM tg_checks WHERE id = $1`, [+id])).rows[0]; if (!ch) return 'This is no longer open.';
  const by = who ? who.name : 'someone';
  if (act === 'notmine') {
    await q(`UPDATE tg_check_asks SET said = 'notmine', said_at = now() WHERE check_id = $1 AND tg_id = $2`, [ch.id, cq.from.id]);
    const others = await whoFor(ch.driver_id, (await q(`SELECT user_id FROM tg_check_asks WHERE check_id = $1`, [ch.id])).rows.map((r) => r.user_id), ch.level || levelFor(ch.kind));
    if (others.length) await ask(ch, others); else await q(`UPDATE tg_checks SET state = 'open' WHERE id = $1`, [ch.id]);
    await bot.edit(cq.message.chat.id, cq.message.message_id, `${cq.message.text ? bot.esc(cq.message.text) : ''}\n\n🙅 Not your driver: ${others.length ? 'asked ' + others.map((o) => bot.esc(o.name)).join(', ') : 'nobody else on shift; the admins see it'}.`).catch(() => {});
    return 'Thanks';
  }
  // "where is he rolling?": empty → the booking level is asked for a load; resting → no more rolling checks for a while
  if (ch.kind === 'rolling' && (act === 'empty' || act === 'resting')) {
    await q(`UPDATE tg_checks SET state = 'done', answer = $2, answered_at = now(), answered_by = $3 WHERE id = $1`, [ch.id, act === 'empty' ? 'Empty, no load' : 'Resting', by]);
    await q(`UPDATE tg_check_asks SET said = $3, said_at = now() WHERE check_id = $1 AND tg_id = $2`, [ch.id, cq.from.id, act]);
    let next = '';
    if (act === 'empty' && !(await q(`SELECT 1 FROM tg_checks WHERE driver_id = $1 AND kind IN ('needs_load', 'prebook') AND state IN ('open', 'looking', 'onit') AND created_at > now() - interval '3 hours'`, [ch.driver_id])).rows[0]) {
      const nl = await open({ chatId: ch.chat_id, driverId: ch.driver_id, kind: 'needs_load', quote: null, place: null });
      const people = await whoFor(ch.driver_id, [], nl.level); await ask(nl, people);
      next = people.length ? `\nAsked ${people.map((o) => bot.esc(o.name)).join(', ')} for a load.` : '';
    }
    await bot.edit(cq.message.chat.id, cq.message.message_id, `${cq.message.text ? bot.esc(cq.message.text) : ''}\n\n${act === 'empty' ? '🅿️ Empty, no load' : '😴 Resting'} (${bot.esc(by)})${next}`).catch(() => {});
    await bot.log('desk', `${by}: ${act === 'empty' ? 'empty, no load' : 'resting'}`, { chatId: ch.chat_id, driverId: ch.driver_id, who });
    return act === 'empty' ? 'Empty: asking for a load' : 'Resting';
  }
  const wake = act === 'up' || act === 'calling';
  await q(`UPDATE tg_checks SET state = $2, answered_at = coalesce(answered_at, now()), answered_by = coalesce(answered_by, $3) WHERE id = $1`, [ch.id, wake ? (act === 'up' ? 'done' : 'calling') : act === 'ok' && ch.kind !== 'rest' ? 'done' : act, by]);
  await q(`UPDATE tg_check_asks SET said = $3, said_at = now() WHERE check_id = $1 AND tg_id = $2`, [ch.id, cq.from.id, act]);
  await bot.edit(cq.message.chat.id, cq.message.message_id, `${cq.message.text ? bot.esc(cq.message.text) : ''}\n\n${bot.esc(SAID[act] || act)} (${bot.esc(by)})${act === 'looking' ? '\nSend me the best option you see now, and why it is good or not.' : ''}`).catch(() => {});
  await bot.log('desk', `${by}: ${SAID[act] || act}`, { chatId: ch.chat_id, driverId: ch.driver_id, who });
  return SAID[act] || 'Saved';
}
// his text reply in the private chat: the answer to the open question (a load option and why, or anything)
async function privateText(m, who) {
  if (!who || !m.text || m.text.startsWith('/')) return false;
  const bot = require('./bot');
  const rep = m.reply_to_message ? (await q(`SELECT c.* FROM tg_check_asks a JOIN tg_checks c ON c.id = a.check_id WHERE a.chat_id = $1 AND a.msg_id = $2 LIMIT 1`, [m.chat.id, m.reply_to_message.message_id])).rows[0] : null;
  if (!rep && m.chat.type !== 'private') return false; // in a shift group only a reply to the bot's question counts
  const ch = rep || (await q(`SELECT c.* FROM tg_check_asks a JOIN tg_checks c ON c.id = a.check_id WHERE a.tg_id = $1 AND a.asked_at > now() - interval '90 minutes' AND c.kind IN ('needs_load', 'other', 'question', 'rolling', 'prebook', 'problem') AND c.answer IS NULL ORDER BY a.asked_at DESC LIMIT 1`, [m.from.id])).rows[0];
  if (!ch) return false;
  const text = bot.redact(m.text).slice(0, 1500);
  await q(`UPDATE tg_checks SET answer = $2, answered_at = coalesce(answered_at, now()), answered_by = coalesce(answered_by, $3), state = CASE WHEN state IN ('open', 'looking') THEN 'answered' ELSE state END WHERE id = $1`, [ch.id, text, who.name]);
  await q(`UPDATE tg_check_asks SET said = coalesce(said, 'answer'), said_at = coalesce(said_at, now()) WHERE check_id = $1 AND tg_id = $2`, [ch.id, m.from.id]);
  await bot.log('desk', `${who.name} answered (${({ needs_load: 'load', prebook: 'next load', rolling: 'rolling to', problem: 'plan' })[ch.kind] || ch.kind}): ${text.slice(0, 160)}`, { chatId: ch.chat_id, driverId: ch.driver_id, who });
  const LBL = { needs_load: 'Load option', prebook: 'Next load', rolling: 'Rolling to', problem: 'Plan' };
  await require('../lib').history(ch.driver_id, `${LBL[ch.kind] || 'Dispatcher'} from ${who.name}: ${text.slice(0, 300)}`, who.name, 'telegram').catch(() => {});
  if (ch.kind === 'rolling') await q(`INSERT INTO tg_updates (chat_id, driver_id, status, text, by_role) VALUES ($1, $2, 'rolling', $3, 'dispatch')`, [ch.chat_id, ch.driver_id, text.slice(0, 500)]).catch(() => {});
  await bot.react(m.chat.id, m.message_id, '👍');
  return true;
}
// no answer in time: ask the others on shift, then the admins; the wake-up check at his time
async function tick() {
  const c = cfg(); if (!c.on) return; const bot = require('./bot');
  if (bot.paused()) return; // paused everywhere
  const late = (await q(`SELECT ch.*, d.name driver FROM tg_checks ch LEFT JOIN drivers d ON d.id = ch.driver_id WHERE ch.state = 'open' AND ch.asked_at < now() - ($1 || ' minutes')::interval AND ch.escalated < 2`, [String(c.answerMin)])).rows;
  for (const ch of late) {
    // no answer: the next level up (a level 3 question: the other seniors, then anyone on shift)
    const asked = (await q(`SELECT user_id FROM tg_check_asks WHERE check_id = $1`, [ch.id])).rows.map((r) => r.user_id);
    const others = ch.escalated === 0 ? await whoFor(ch.driver_id, asked, Math.min(3, (ch.level || levelFor(ch.kind)) + 1)) : [];
    if (others.length) await ask(ch, others);
    else for (const id of (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id)) await db.notify(db.pool, id, 'desk', `No dispatcher answered about ${ch.driver} for ${c.answerMin}+ min: ${bot.stripHtml(question(ch, { name: ch.driver }, bot)).slice(0, 200)}`, '#/telegram?tab=desk', { driverId: ch.driver_id });
    await q(`UPDATE tg_checks SET escalated = escalated + ${others.length ? 1 : 2} WHERE id = $1`, [ch.id]);
  }
  const wake = (await q(`SELECT ch.*, d.name driver FROM tg_checks ch LEFT JOIN drivers d ON d.id = ch.driver_id WHERE ch.kind = 'rest' AND ch.until_at <= now() AND NOT ch.followed_up AND ch.state <> 'cancelled' AND ch.until_at > now() - interval '3 hours'`)).rows;
  for (const ch of wake) {
    await q(`UPDATE tg_checks SET followed_up = true WHERE id = $1`, [ch.id]);
    const w = await open({ chatId: ch.chat_id, driverId: ch.driver_id, kind: 'wake', quote: ch.quote, untilText: ch.until_text });
    const people = await whoFor(ch.driver_id, [], w.level);
    const text = `It is ${bot.esc(ch.until_text)}: <b>${bot.esc(ch.driver)}</b> should be up now. Did he check in?`;
    for (const p of people) { if (!p.tg_id) continue;
      const sg = c.where === 'shift' ? await shiftGroup(ch.driver_id) : null; const to = sg || p.tg_id;
      const msg = await bot.send(to, sg ? `${await tagOf(p)}, ${text}` : text, { buttons: [BTN.wake.map(([l, a]) => [l, `desk:${w.id}:${a}`])] }).catch(() => null);
      if (msg) await q(`INSERT INTO tg_check_asks (check_id, user_id, tg_id, msg_id, chat_id) VALUES ($1, $2, $3, $4, $5)`, [w.id, p.user_id, p.tg_id, msg.message_id, to]); }
    await q(`UPDATE tg_checks SET asked_at = now() WHERE id = $1`, [w.id]);
    await bot.log('desk', `Wake-up check: ${ch.driver} should be up (${ch.until_text})`, { chatId: ch.chat_id, driverId: ch.driver_id });
  }
}
// Level 1's regular question: working drivers with no update in a while (not resting, not at home): where is he rolling to?
// Only while a shift is on; a few at a time.
async function rollingTick() {
  const c = cfg(); if (!c.on || !c.rolling.on) return 0;
  if (!(await shiftNow())) return 0;
  const hours = Math.max(2, Math.min(24, +c.rolling.hours || 6));
  const due = (await q(`SELECT ch.chat_id, ch.driver_id FROM tg_chats ch JOIN drivers d ON d.id = ch.driver_id
      WHERE ch.active AND ch.kind = 'dispatch' AND d.status = 'Hired'
        AND NOT EXISTS (SELECT 1 FROM tg_updates u WHERE u.driver_id = ch.driver_id AND u.at > now() - make_interval(hours => $1))
        AND NOT EXISTS (SELECT 1 FROM tg_checks k WHERE k.driver_id = ch.driver_id AND (k.created_at > now() - make_interval(hours => $1) OR (k.kind = 'rest' AND k.until_at > now())))
        AND NOT EXISTS (SELECT 1 FROM home_time h WHERE h.driver_id = ch.driver_id AND h.status = 'home')
      ORDER BY ch.driver_id LIMIT 5`, [hours])).rows;
  for (const x of due) {
    const ch = await open({ chatId: x.chat_id, driverId: x.driver_id, kind: 'rolling' });
    await ask(ch, await whoFor(x.driver_id, [], ch.level));
  }
  return due.length;
}
async function tickAll() { await tick(); await rollingTick(); }
module.exports = { TZS, LEVELS, LEVEL_HELP, KIND_LEVEL, KINDS, levelFor, groupsOf, groupFor, linkShift, cfg, shiftNow, whoFor, fromGroup, onButton, privateText, tick: tickAll, rollingTick, question };
