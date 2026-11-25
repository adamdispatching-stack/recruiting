// The FleetHire Telegram bot, running inside the website.
// It needs TELEGRAM_BOT_TOKEN (from @BotFather) in the Railway variables; without it the bot stays off.
// It reads updates by long polling, keeps the groups, people and messages, and hands each group to its job
// (ELD now; accounting and dispatch later). Recruiters link a group to a driver with a code from the website.
const db = require('../db');
const { q } = db;

const API = () => (process.env.TG_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const state = { running: false, me: null, lastError: null, lastUpdateAt: null, startedAt: null };
const handlers = { eld: null, dispatch: null, accounting: null }; // set by the job modules
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// send a file (a photo or a PDF) from the website's papers
async function sendFile(chatId, { data, name, mime }, caption = '') {
  const fd = new FormData(); fd.append('chat_id', String(chatId));
  const photo = /^image\/(jpeg|png|webp)$/.test(mime) && data.length < 9.5e6;
  fd.append(photo ? 'photo' : 'document', new Blob([data], { type: mime }), name);
  if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
  const r = await fetch(`${API()}/bot${TOKEN()}/${photo ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || `Telegram file failed (${r.status})`);
  return j.result;
}
async function call(method, params = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), (params.timeout || 0) * 1000 + 15000);
  try {
    const r = await fetch(`${API()}/bot${TOKEN()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { const e = new Error(j.description || `Telegram ${method} failed (${r.status})`); e.code = j.error_code; e.retry = j.parameters && j.parameters.retry_after; throw e; }
    return j.result;
  } finally { clearTimeout(t); }
}
// A file someone sent (a photo or a PDF), as bytes; nothing is saved
async function download(fileId, maxBytes = 10 * 1024 * 1024) {
  const f = await call('getFile', { file_id: fileId });
  if (f.file_size && f.file_size > maxBytes) throw new Error('The file is too big to read');
  const r = await fetch(`${API()}/file/bot${TOKEN()}/${f.file_path}`);
  if (!r.ok) throw new Error('Could not download the file');
  return Buffer.from(await r.arrayBuffer());
}

// ---------- sending ----------
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const tag = (p) => (p.username ? '@' + p.username : `<a href="tg://user?id=${p.tg_id}">${esc(p.name || 'there')}</a>`);
// Paused (Telegram → Autopilot, or /pause): the bot writes nothing by itself in any group. What a person sends from the
// website (human) still goes out, and so do private alerts to our team.
const paused = () => !!(db.settings.tg || {}).paused;
// ---------- Watch means silent ----------
// In a driver's own group (kind "dispatch") that is in Watch, the bot writes only
//   - what a person sends through it (human: true: a reply from the website, a button like "ask for the CDL"), and
//   - its answer to something that was just written or tapped in that same group (a command, a button).
// Anything it would write there on its own (a reminder, a follow-up, a question from a timer) is held back and noted
// in the log, whichever feature tried. A group is in Watch unless it was set to post updates (a working driver's
// group in "updater") or the driver's onboarding is in Assist or Run.
const { AsyncLocalStorage } = require('async_hooks');
const handling = new AsyncLocalStorage(); // the chat whose message or button is being handled right now
async function watchOnly(chatId) {
  try {
    const c = (await db.q('SELECT kind, mode, driver_id FROM tg_chats WHERE chat_id = $1', [chatId])).rows[0];
    if (!c || c.kind !== 'dispatch') return false;
    if (c.mode === 'updater') return false;
    if (!c.driver_id) return true;
    const d = (await db.q('SELECT status FROM drivers WHERE id = $1', [c.driver_id])).rows[0] || {};
    if (d.status === 'Hired') return true; // a working driver: only the group's own mode counts
    const o = (await db.q('SELECT mode FROM onb_cases WHERE driver_id = $1', [c.driver_id])).rows[0];
    return ((o && o.mode) || (db.settings.tg || {}).onbMode || 'watch') === 'watch';
  } catch (e) { return false; } // if this cannot be read, the message goes as it always did
}
async function send(chatId, html, { buttons, replyTo, forceReply, human } = {}) {
  if (+chatId < 0 && !human && paused()) { await log('paused', `Not sent, the bot is paused: ${clip(html, 140)}`, { chatId }).catch(() => {}); return { message_id: null, paused: true }; }
  if (+chatId < 0 && !human) {
    const now = handling.getStore();
    if (!(now && String(now.chatId) === String(chatId)) && await watchOnly(chatId)) {
      await log('held', `Not sent, this group is in Watch: ${clip(html, 140)}`, { chatId }).catch(() => {});
      return { message_id: null, held: true };
    }
  }
  const params = { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true };
  if (buttons) params.reply_markup = { inline_keyboard: buttons.map((row) => row.map(([text, data]) => (/^https?:/.test(data) ? { text, url: data } : { text, callback_data: data }))) };
  if (forceReply) params.reply_markup = { force_reply: true, selective: true };
  if (replyTo) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  for (let i = 0; i < 3; i++) {
    try {
      const m = await call('sendMessage', params);
      await saveMessage({ chat: { id: chatId }, message_id: m.message_id, from: { id: state.me ? state.me.id : 0, is_bot: true, first_name: state.me ? state.me.first_name : 'Bot' }, date: m.date, text: stripHtml(html) });
      if (+chatId < 0) await log('said', clip(html, 160), { chatId });
      return m;
    } catch (e) { if (e.retry && i < 2) { await sleep(e.retry * 1000); continue; } throw e; }
  }
}
const stripHtml = (h) => String(h).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
async function edit(chatId, msgId, html, buttons) {
  try {
    await call('editMessageText', { chat_id: chatId, message_id: msgId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map(([text, data]) => ({ text, callback_data: data }))) } } : {}) });
  } catch (e) { if (!/not modified/i.test(e.message)) throw e; }
}
const react = (chatId, msgId, emoji) => call('setMessageReaction', { chat_id: chatId, message_id: msgId, reaction: [{ type: 'emoji', emoji }] }).catch(() => {});
const dropButtons = (chatId, msgId) => call('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }).catch(() => {});

// ---------- keeping what was said ----------
// Passwords, PINs and account numbers are hidden before anything is saved.
// nothing to read in it: "ok", "thanks", "👍", a sticker. Saves an AI call; the next real message still sees it as context.
const TRIVIAL = /^(?:ok(?:ay)?|k|kk|okey|oki|yes|yeah|yep|ya|yup|no|nope|thanks?|thank you|thank u|thx|ty|good|great|cool|nice|perfect|got it|gotcha|copy|copy that|roger|10-4|sure|alright|all right|np|no problem|on it|will do|done|sounds good|понял|ок|да|нет|спасибо|хорошо|\+|\.|[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\s]+)[\s.!,)]*$/iu;
const trivial = (m) => !m.file_id && (!m.media || m.media === 'sticker') && (!String(m.text || '').trim() || TRIVIAL.test(String(m.text).trim()));
function redact(t) {
  if (!t) return t;
  return String(t)
    .replace(/\b(pass(?:word)?|pwd|pin|passcode)\b(\s*[:=-]?\s*)(\S+)/gi, (m, k, sep) => `${k}${sep}[hidden]`)
    .replace(/\b(routing|account|acct|ssn|social security)(\s*(?:number|no\.?|#)?\s*[:=-]?\s*)([\d -]{4,})/gi, (m, k, sep) => `${k}${sep}[hidden]`)
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[hidden]')
    .replace(/(?<![\d+(-])\b\d{9}\b(?![\d)-])/g, '[hidden]'); // a bare 9-digit number (an SSN)
}
const nameOf = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Someone';
async function person(u) {
  if (!u || !u.id) return null;
  const r = await q(`INSERT INTO tg_people (tg_id, name, username, seen_at) VALUES ($1, $2, $3, now())
    ON CONFLICT (tg_id) DO UPDATE SET name = $2, username = $3, seen_at = now() RETURNING *`, [u.id, nameOf(u), u.username || null]);
  return r.rows[0];
}
async function saveMessage(m, extra = {}) {
  const media = m.photo ? 'photo' : m.document ? (m.document.mime_type === 'application/pdf' ? 'pdf' : 'file') : m.voice ? 'voice' : m.video ? 'video' : m.sticker ? 'sticker' : m.location ? 'location' : null;
  const text = redact(m.text || m.caption || (m.location ? `Location ${m.location.latitude}, ${m.location.longitude}` : '')) || null;
  const fileId = m.photo ? m.photo[m.photo.length - 1].file_id : m.document && /^(image\/|application\/pdf)/.test(m.document.mime_type || '') ? m.document.file_id : null;
  await q(`INSERT INTO tg_messages (chat_id, msg_id, from_id, from_name, is_bot, text, media, media_note, reply_to, at, digested, file_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), $5, $11)
    ON CONFLICT (chat_id, msg_id) DO UPDATE SET text = EXCLUDED.text`,
  [m.chat.id, m.message_id, m.from ? m.from.id : null, m.from ? nameOf(m.from) : null, !!(m.from && m.from.is_bot), text, media, extra.note || null, m.reply_to_message ? m.reply_to_message.message_id : null, m.date || Date.now() / 1000, fileId]);
  await q(`UPDATE tg_chats SET last_at = now() WHERE chat_id = $1`, [m.chat.id]);
}
// ---------- the bot's history ----------
async function log(kind, text, { chatId = null, driverId, who = null } = {}) {
  try {
    if (driverId === undefined && chatId) driverId = ((await q(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [chatId])).rows[0] || {}).driver_id || null;
    await q(`INSERT INTO tg_log (chat_id, driver_id, kind, text, who_tg, who) VALUES ($1, $2, $3, $4, $5, $6)`, [chatId, driverId || null, kind, String(text).slice(0, 500), who ? who.tg_id || null : null, who ? who.name || null : null]);
  } catch (e) { console.error('tg log', e.message); }
}
const clip = (t, n = 80) => { const s = stripHtml(String(t || '')).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// Someone not connected to the website did something only the team may do: keep it waiting (and tell the admins) until they connect
async function wait(chatId, who, { driverId = null, kind = null, what }) {
  const r = await q(`INSERT INTO tg_waiting (chat_id, tg_id, who, driver_id, kind, what) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (chat_id) WHERE done_at IS NULL
    DO UPDATE SET tg_id = coalesce(EXCLUDED.tg_id, tg_waiting.tg_id), who = coalesce(EXCLUDED.who, tg_waiting.who), driver_id = coalesce(EXCLUDED.driver_id, tg_waiting.driver_id), kind = coalesce(EXCLUDED.kind, tg_waiting.kind), what = EXCLUDED.what RETURNING (xmax = 0) fresh`,
  [chatId, who ? who.tg_id : null, who ? who.name : null, driverId, kind, what]);
  await log('wait', what, { chatId, who });
  if (r.rows[0].fresh) for (const id of new Set([...(await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((a) => a.id), ...(who && who.user_id ? [who.user_id] : [])])) await db.notify(db.pool, id, 'tg', `Waiting: ${what}`, '#/telegram?tab=groups');
}
const doneWaiting = (chatId, by, how) => q(`UPDATE tg_waiting SET done_at = now(), done_by = $2, done_how = $3 WHERE chat_id = $1 AND done_at IS NULL`, [chatId, by || null, how]);
const noteMedia = (chatId, msgId, note) => q(`UPDATE tg_messages SET media_note = $3 WHERE chat_id = $1 AND msg_id = $2`, [chatId, msgId, note]);

// ---------- groups and linking ----------
async function chatOf(c) {
  const r = await q(`INSERT INTO tg_chats (chat_id, title) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET title = coalesce($2, tg_chats.title) RETURNING *`, [c.id, c.title || null]);
  return r.rows[0];
}
const KINDS = { dispatch: 'Dispatch', eld: 'ELD', accounting: 'Accounting', management: 'Management', shift: 'Shift' };
const PREFIX = { dispatch: 'onb', eld: 'eld', accounting: 'acc' }; // button data starts with this per kind
// Make a group the driver's dispatch, ELD or accounting group
async function linkChat(chatId, kind, driverId, userId, who, opts = {}) {
  const d = (await q(`SELECT id, name FROM drivers WHERE id = $1`, [driverId])).rows[0];
  // one group per driver and kind: the one there before is unlinked, and remembered (Change on the group page puts it back)
  const out = (await q(`UPDATE tg_chats SET prev_kind = kind, prev_driver_id = driver_id, displaced_by = $3, kind = NULL, driver_id = NULL WHERE driver_id = $1 AND kind = $2 AND chat_id <> $3 RETURNING chat_id, title`, [driverId, kind, chatId])).rows;
  for (const o of out) await log('connect', `"${o.title || 'A group'}" was ${d.name}'s ${KINDS[kind]} group: it is unlinked now, because this group took its place. If that was a mistake, change this group's type on its page.`, { chatId: o.chat_id, driverId });
  await q(`UPDATE tg_chats SET kind = $2, driver_id = $3, linked_by = $4, linked_at = now(), active = true WHERE chat_id = $1`, [chatId, kind, driverId, userId || null]);
  if (who) await q(`UPDATE tg_people SET role = coalesce(role, 'staff'), user_id = coalesce(user_id, $2) WHERE tg_id = $1`, [who.tg_id, userId || null]);
  // keep an invite link when the bot may make one
  const inv = await call('exportChatInviteLink', { chat_id: chatId }).catch(() => null);
  if (inv) await q(`UPDATE tg_chats SET invite_link = $2 WHERE chat_id = $1`, [chatId, inv]);
  if (inv && kind === 'dispatch') await q(`UPDATE onboarding SET telegram_link = coalesce(telegram_link, $2) WHERE driver_id = $1`, [driverId, inv]);
  await db.syncAuto(db.pool, driverId, userId || null); // "Telegram group created", "ELD group set up", "Accounting group set up"
  await q(`UPDATE drivers SET updated_at = now() WHERE id = $1`, [driverId]);
  await require('../lib').history(driverId, `${KINDS[kind]} Telegram group linked`, who ? who.name : opts.by || 'Telegram', 'telegram').catch(() => {});
  // silent in the group: a 👍 on the command that asked for it (if any); the website has the rest
  if (opts.ackMsg) await react(chatId, opts.ackMsg, '👍');
  if (state.me && !(await isAdmin(chatId))) await log('join', 'Not an admin yet: make the bot an admin of the group so it reads every message', { chatId, driverId });
  await log('connect', `Connected as the ${KINDS[kind]} group for ${d.name}${who ? '' : ` (on the website${opts.by ? ', ' + opts.by : ''})`}`, { chatId, driverId, who });
  await doneWaiting(chatId, who ? who.name : opts.by || 'website', 'connected');
  // an ELD or accounting group of a driver who is already working: the bot only reads along and learns (no setup, no questions)
  if ((kind === 'eld' || kind === 'accounting') && ((await q(`SELECT status FROM drivers WHERE id = $1`, [driverId])).rows[0] || {}).status === 'Hired') {
    await q(`UPDATE tg_chats SET mode = 'watch' WHERE chat_id = $1`, [chatId]);
    await log('mode', `${d.name} is already active: the bot reads this ${KINDS[kind]} group quietly (no setup messages)`, { chatId, driverId });
    return;
  }
  // ELD / accounting groups: nothing automatic. The team types /info for the driver's papers; the ELD setup and checks run only when switched on (group page)
  if ((kind === 'eld' && (db.settings.tg || {}).eldAuto !== true) || (kind === 'accounting' && (db.settings.tg || {}).acctAuto !== true)) {
    await q(`UPDATE tg_chats SET mode = 'watch' WHERE chat_id = $1`, [chatId]);
    await log('mode', kind === 'eld' ? 'ELD group: silent. Type /info here to share the driver\'s info, CDL and truck papers' : 'Accounting group: silent (switch on answers on the group page)', { chatId, driverId });
    return;
  }
  if (kind === 'eld' || kind === 'accounting') await q(`UPDATE tg_chats SET mode = 'updater' WHERE chat_id = $1`, [chatId]); // switched on in Settings: the setup runs
  const working = kind === 'dispatch' && (opts.big || ((await q(`SELECT member_count FROM tg_chats WHERE chat_id = $1`, [chatId])).rows[0] || {}).member_count > 10 || ((await q(`SELECT status FROM drivers WHERE id = $1`, [driverId])).rows[0] || {}).status === 'Hired');
  if (working) await q(`UPDATE tg_chats SET mode = $2 WHERE chat_id = $1`, [chatId, CMODES[(db.settings.tg || {}).workMode] ? db.settings.tg.workMode : 'watch']);
  if (kind === 'dispatch' && working && ((await q(`SELECT status FROM drivers WHERE id = $1`, [driverId])).rows[0] || {}).status !== 'Hired') return; // a working driver's group: read along and learn, nothing to start
  if (handlers[kind]) await handlers[kind].begin(chatId, driverId, opts);
}
// A management group: our team only, no driver. The morning report and follow-ups go here.
async function linkTeam(chatId, who, by) {
  await q(`UPDATE tg_chats SET kind = 'management', driver_id = NULL, mode = 'watch', linked_by = $2, linked_at = now(), active = true WHERE chat_id = $1`, [chatId, who && who.user_id || null]);
  await log('connect', `Connected as a management group: the morning report and follow-ups (tagging the recruiters) go here`, { chatId, driverId: null, who });
  await doneWaiting(chatId, who ? who.name : by || 'website', 'connected');
}
// "register dispatch watch": how the bot works in an onboarding group
const MODE_WORD = { watch: 'watch', learn: 'watch', quiet: 'watch', silent: 'watch', assist: 'assist', help: 'assist', answer: 'assist', answers: 'assist', run: 'run', auto: 'run', full: 'run' };
const MODES = [['watch', '👀 Watch and learn'], ['assist', '💬 Answer questions'], ['run', '🚀 Run the onboarding']];
async function link(m, code, who) {
  const L = (await q(`SELECT * FROM tg_links WHERE code = $1 AND used_at IS NULL AND created_at > now() - interval '7 days'`, [code])).rows[0];
  if (!L) return send(m.chat.id, 'That link code is not valid (or already used). Make a new one on the driver\'s page on the website.', { replyTo: m.message_id });
  await q(`UPDATE tg_links SET used_at = now() WHERE code = $1`, [code]);
  await linkChat(m.chat.id, L.kind, L.driver_id, L.user_id, who);
}
// "register dispatch", "register eld John Smith": the team registers a group from Telegram
const isStaff = (p) => p && (p.role === 'staff' || !!p.user_id);
const KIND_WORD = { shift: 'shift', management: 'management', team: 'management', manager: 'management', managers: 'management', office: 'management', dispatch: 'dispatch', updates: 'dispatch', onboarding: 'dispatch', eld: 'eld', accounting: 'accounting', acct: 'accounting', accounts: 'accounting' };
// The group's title: "John Smith 215-555-0144", "John Smith ELD", "Accounting - John Smith"
// Cyrillic letters that look like Latin ones (a title typed on a Russian keyboard: "ЕLD", "АCCOUNTING")
const LOOK = { 'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i' };
const latin = (t) => String(t || '').toLowerCase().replace(/[авеёкмнорстухі]/g, (c) => LOOK[c]);
const ELD_W = new Set(['eld', 'elds', 'елд', 'элд', 'logs', 'logbook', 'eldgroup', 'eldteam', 'eldchat']);
const ACC_W = new Set(['accounting', 'accountant', 'accounts', 'account', 'acct', 'acc', 'payroll', 'settlement', 'settlements', 'бухгалтерия', 'бухгалтер']);
const MGMT_W = new Set(['management', 'manager', 'managers', 'recruiters', 'recruiting', 'office', 'ops', 'operations', 'staff', 'menejment', 'менеджмент', 'офис']);
const NOISE = new Set([...ELD_W, ...ACC_W, 'dispatch', 'dispatcher', 'group', 'chat', 'team', 'support', 'update', 'updates', 'onboarding', 'fleethire', 'driver', 'new', 'truck', 'unit', 'trk', 'tr', 'and', 'with', 'for']);
// The group's title: "John Smith 215-555-0144", "John Smith ELD", "ELD_John Smith", "Accounting - John Smith"
function titleInfo(title) {
  const t = String(title || '');
  const toks = [...latin(t).split(/[^\p{L}\p{N}]+/u), ...t.toLowerCase().split(/[^\p{L}\p{N}]+/u)].filter(Boolean);
  const kind = toks.some((w) => ELD_W.has(w) || /^eld(group|team|chat|s)?$/.test(w)) ? 'eld' : toks.some((w) => ACC_W.has(w) || /^account/.test(w)) ? 'accounting' : toks.some((w) => MGMT_W.has(w)) ? 'management' : 'dispatch';
  // a phone in any form: 2675550177, 267 555 0177, 267-555-0177, (267)555-0177, +1 267 5550177, 1-267-555-0177
  let pm = t.match(/(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}(?!\d)/);
  if (pm && !db.digits(pm[0])) pm = null;
  if (!pm) for (const x of t.match(/\+?\(?\d[\d\s().-]*\d/g) || []) { if (db.digits(x)) { pm = [x]; break; } }
  const phone = pm ? db.digits(pm[0]) : null;
  const um = t.match(/\b(?:truck|unit|trk|tr)\s*#?\s*([a-z]?\d{2,5}[a-z]?)\b|#\s*([a-z]?\d{2,5}[a-z]?)\b/i);
  const name = (pm ? t.replace(pm[0], ' ') : t).split(/[^\p{L}'-]+/u).filter((w) => w && !NOISE.has(latin(w)) && !NOISE.has(w.toLowerCase()) && !/^eld(group|team|chat|s)?$/.test(latin(w)) && !/^-+$/.test(w)).join(' ').replace(/^[ '-]+|[ '-]+$/g, '').trim();
  return { kind, phone, name, unit: um ? um[1] || um[2] : null };
}
// Drivers that fit: the phone number first, then the truck, then the name (the most matching words wins). sure = one clear match.
async function findDrivers({ phone, name, unit, big = false, kind = 'dispatch' }) {
  const OUT = `status NOT IN ('Not interested', 'Declined on Indeed', 'No CDL')`;
  // ELD and accounting groups are for working drivers: prefer the active one
  const pref = big || kind !== 'dispatch';
  const res = (r, by) => { const hired = r.filter((d) => d.status === 'Hired'); return r.length === 1 ? { sure: r[0], list: r, by } : pref && hired.length === 1 ? { sure: hired[0], list: r, by } : null; };
  if (phone) {
    const r = (await q(`SELECT id, name, status, phones FROM drivers WHERE $1 = ANY(phones) AND ${OUT} ORDER BY (status = 'Hired') DESC, updated_at DESC LIMIT 6`, [phone])).rows;
    if (r.length) return res(r, 'phone') || { sure: null, list: r };
  }
  if (unit) { // "Truck 140": the driver on that truck
    const r = (await q(`SELECT d.id, d.name, d.status, d.phones FROM trucks t JOIN drivers d ON d.id = t.driver_id WHERE upper(t.unit) = upper($1) AND d.${OUT}`, [unit])).rows;
    if (r.length === 1) return { sure: r[0], list: r, by: 'truck' };
  }
  const words = [...new Set(String(name || '').split(/\s+/).filter((x) => x.length > 1))].slice(0, 6);
  if (!words.length) return { sure: null, list: [] };
  const need = Math.min(2, words.length);
  const r = (await q(`SELECT * FROM (SELECT id, name, status, phones, updated_at, (${words.map((_, i) => `(name ILIKE $${i + 1})::int`).join(' + ')}) score FROM drivers WHERE ${OUT}) x
      WHERE score >= ${need} ORDER BY score DESC, (status = 'Hired') DESC, (status = 'Onboarding') DESC, updated_at DESC LIMIT 8`, words.map((x) => `%${x}%`))).rows;
  if (!r.length) return { sure: null, list: [], by: 'name' };
  const top = r.filter((d) => d.score === r[0].score);
  const n = r[0].score >= 2 ? res(top, 'name') : null;
  return n || { sure: null, list: r, by: 'name' };
}
const addPhone = (driverId, phone) => phone && q(`UPDATE drivers SET phones = array_append(phones, $2) WHERE id = $1 AND NOT ($2 = ANY(phones))`, [driverId, phone]);
// Buttons to pick the driver (or add a new one)
async function askWhich(chatId, kind, info, list, who, replyTo) {
  const rows = list.map((d) => [[`${d.name} (${d.status === 'Hired' ? 'active' : d.status.toLowerCase()})`, `reg:${kind}:${d.id}`]]);
  if (info.name) {
    if (kind === 'dispatch') rows.push([[`➕ New driver in onboarding: ${info.name.slice(0, 30)}`, `reg:${kind}:newonb`]]);
    rows.push([[`➕ Add "${info.name.slice(0, 30)}" as an active driver`, `reg:${kind}:new`]]);
  }
  await q(`INSERT INTO tg_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, ['reg:' + chatId, JSON.stringify({ name: info.name, phone: info.phone, kind, by: who && who.tg_id, mode: info.mode || null })]);
  if (!rows.length) return send(chatId, 'Whose group is this? Send <code>/register ' + kind + ' Driver Name</code>, or put the driver\'s name and phone number in the group title.', { replyTo });
  return send(chatId, `Which driver is this <b>${KINDS[kind]}</b> group for?${!list.length && (info.name || info.phone) ? `\nI found nobody on the website with ${[info.name ? `the name "${esc(info.name)}"` : '', info.phone ? `the phone ${info.phone}` : ''].filter(Boolean).join(' or ')}.` : ''}`, { replyTo, buttons: rows });
}
// The bot was added to a group (or its title changed): read the title and connect it to the driver
async function autoRegister(chat, who, { renamed = false } = {}) {
  const cur = (await q(`SELECT kind, driver_id FROM tg_chats WHERE chat_id = $1`, [chat.id])).rows[0];
  if (cur && cur.kind && cur.driver_id) {
    // renamed to say ELD or Accounting: the same driver's ELD / accounting group now
    const k = titleInfo(chat.title).kind;
    if (renamed && k !== 'dispatch' && k !== cur.kind) { await log('connect', `Renamed "${clip(chat.title, 60)}": now the ${KINDS[k]} group`, { chatId: chat.id, driverId: cur.driver_id, who }); await linkChat(chat.id, k, cur.driver_id, who && who.user_id || null, isStaff(who) ? who : null, { by: 'the new group title' }); }
    return;
  }
  const info = titleInfo(chat.title);
  // more than 10 people: a working driver's group (not onboarding)
  const count = await call('getChatMemberCount', { chat_id: chat.id }).catch(() => null);
  if (count) await q(`UPDATE tg_chats SET member_count = $2 WHERE chat_id = $1`, [chat.id, count]);
  info.big = count > 10;
  if (info.big) await log('title', `${count} people in the group: a working driver's group, the bot learns quietly (no onboarding)`, { chatId: chat.id, who });
  if (!info.name && !info.phone && !info.unit) {
    await log('title', `Title "${clip(chat.title, 60)}": no driver name or phone in it`, { chatId: chat.id, who });
    return wait(chat.id, who, { kind: info.kind, what: `The bot is in "${clip(chat.title, 60)}", but the title has no driver name or phone. Pick the driver here, or put the name and phone in the group title.` });
  }
  if (info.kind === 'management') { // our team's group: connected when someone on the team added the bot
    if (isStaff(who)) return linkTeam(chat.id, who);
    return wait(chat.id, who, { kind: 'management', what: `"${clip(chat.title, 60)}" looks like a management group (our team).${who ? ` ${who.name} added the bot but has not connected Telegram to the website.` : ''} Connect it here.` });
  }
  const f = await findDrivers(info);
  await log('title', `Title "${clip(chat.title, 60)}": ${f.sure ? `${f.sure.name} (${f.by} match)` : f.list.length ? `${f.list.length} possible drivers` : 'no driver found'}, ${KINDS[info.kind]} group`, { chatId: chat.id, driverId: f.sure ? f.sure.id : null, who });
  if (f.sure && info.big && f.sure.status !== 'Hired') {
    await log('connect', `${f.sure.name} is "${f.sure.status}" on the website, but the group has ${count} people: check if the driver is already working`, { chatId: chat.id, driverId: f.sure.id });
    for (const a of (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows) await db.notify(db.pool, a.id, 'tg', `"${clip(chat.title, 50)}" has ${count} people, so it looks like a working driver's group, but ${f.sure.name} is "${f.sure.status}" on the website.`, '#/telegram/' + chat.id, { driverId: f.sure.id });
  }
  if (f.sure && isStaff(who)) { await addPhone(f.sure.id, info.phone); return linkChat(chat.id, info.kind, f.sure.id, who.user_id || null, who, { big: info.big }); }
  // a big group, or an ELD / accounting group (a working driver), matched by the truck or the one active driver: connected
  if (f.sure && (info.big || info.kind !== 'dispatch') && (f.by === 'truck' || f.sure.status === 'Hired')) {
    await log('connect', `${f.sure.name} (${f.by} match, active driver): connected by itself`, { chatId: chat.id, driverId: f.sure.id, who });
    await addPhone(f.sure.id, info.phone); return linkChat(chat.id, info.kind, f.sure.id, null, null, { by: 'the group title', big: true });
  }
  // the phone in the title is a driver's phone: connected right away, whoever added the bot (Settings can turn this off)
  if (f.sure && f.by === 'phone' && (db.settings.tg || {}).autoPhone !== false) {
    await log('connect', `The phone in the title matches ${f.sure.name}: connected by itself${who ? ` (${who.name} is not connected to the website yet)` : ''}`, { chatId: chat.id, driverId: f.sure.id, who });
    return linkChat(chat.id, info.kind, f.sure.id, null, null, { by: 'the phone in the title', big: info.big });
  }
  // not sure, or added by someone the website does not know: waits on the website (nothing in the group)
  const by = who && !isStaff(who) ? ` ${who.name} added the bot but has not connected Telegram to the website.` : who ? ` Added by ${who.name}.` : '';
  return wait(chat.id, who, { driverId: f.sure ? f.sure.id : null, kind: info.kind,
    what: f.sure ? `"${clip(chat.title, 60)}" looks like ${f.sure.name}'s ${KINDS[info.kind]} group (by the name).${by}` : f.list.length ? `"${clip(chat.title, 60)}": ${f.list.length} drivers fit the title. Pick one.${by}` : `"${clip(chat.title, 60)}": nobody on the website with ${[info.name ? `the name "${info.name}"` : '', info.phone ? `the phone ${info.phone}` : ''].filter(Boolean).join(' or ')}.${by}` });
}
// "/register", "register dispatch", "register eld John Smith": the team registers a group from Telegram.
// With nothing after it, the group title says who and which kind.
async function register(m, args, who) {
  if (!isStaff(who)) {
    const cur = (await q(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [m.chat.id])).rows[0];
    if (!cur || !cur.driver_id) { const t = titleInfo(m.chat.title); const f = await findDrivers(t); await wait(m.chat.id, who, { driverId: f.sure ? f.sure.id : null, kind: t.kind, what: `${who.name} typed register in "${clip(m.chat.title, 60)}" but has not connected Telegram to the website${f.sure ? `. It looks like ${f.sure.name}'s ${KINDS[t.kind]} group` : ''}.` }); }
    return react(m.chat.id, m.message_id, '👀'); // kept waiting on the website, nothing written here
  }
  await log('cmd', `/register ${String(args || '').trim()}`.trim(), { chatId: m.chat.id, who });
  const [w, ...rest] = String(args || '').trim().split(/\s+/).filter(Boolean);
  const t = titleInfo(m.chat.title);
  let kind = KIND_WORD[(w || '').toLowerCase()];
  if (!kind && w) rest.unshift(w);
  let mode = null; if (rest.length && MODE_WORD[rest[rest.length - 1].toLowerCase()]) mode = MODE_WORD[rest.pop().toLowerCase()];
  const typed = rest.join(' ').trim();
  if (!kind && !typed && !t.name && !t.phone) return send(m.chat.id, 'Which group is this?', { replyTo: m.message_id, buttons: [[['🚚 Dispatch (onboarding)', 'regk:dispatch'], ['📋 ELD', 'regk:eld'], ['💵 Accounting', 'regk:accounting']]] });
  kind = kind || t.kind;
  if (kind === 'management') { await linkTeam(m.chat.id, who); return react(m.chat.id, m.message_id, '👍'); }
  if (kind === 'shift') { const ok = await require('./desk').linkShift(m.chat.id, String(args || '').trim().split(/\s+/).slice(1).join(' '), who ? who.name : 'Telegram'); return react(m.chat.id, m.message_id, ok ? '👍' : '🤷'); }
  const info = typed ? { ...titleInfo(typed), kind, mode } : { ...t, kind, mode };
  const f = await findDrivers(info);
  if (f.sure) { await addPhone(f.sure.id, info.phone); return linkChat(m.chat.id, kind, f.sure.id, who.user_id || null, who, { mode, ackMsg: m.message_id }); }
  return askWhich(m.chat.id, kind, info, f.list, who, m.message_id);
}
async function registerButton(cq, who) {
  if (!isStaff(who)) {
    const [, k, did] = cq.data.split(':'); const dn = +did ? ((await q(`SELECT name FROM drivers WHERE id = $1`, [+did])).rows[0] || {}).name : null;
    await wait(cq.message.chat.id, who, { driverId: +did || null, kind: k, what: `${who.name} tapped to connect "${clip(cq.message.chat.title || 'a group', 60)}"${dn ? ` to ${dn}` : ''} but has not connected Telegram to the website.` });
    return 'Connect your Telegram to the website first (/me CODE in a private chat with me). Kept waiting until then.';
  }
  const [, kind, did] = cq.data.split(':'); const chatId = cq.message.chat.id;
  let driverId = +did;
  if (did === 'new' || did === 'newonb') {
    const st = ((await q(`SELECT value FROM tg_state WHERE key = $1`, ['reg:' + chatId])).rows[0] || {}).value || {};
    if (!st.name) return 'Send register again with the driver\'s name.';
    const onb = did === 'newonb';
    const ins = await q(`INSERT INTO drivers (name, name_key, status, source, owner_id, created_by, status_at, status_locked, phones) VALUES ($1, $2, $4, 'Telegram', $5, $3, now(), true, $6) RETURNING id`,
      [st.name, db.keyOf(st.name), who.user_id || null, onb ? 'Onboarding' : 'Hired', onb ? who.user_id || null : null, st.phone ? [st.phone] : []]);
    driverId = ins.rows[0].id;
    if (onb) await db.ensureOnboarding(db.pool, driverId, who.user_id || null);
    await require('../lib').history(driverId, onb ? 'Added from Telegram, in onboarding' : 'Added as an active driver from Telegram', who.name, 'telegram').catch(() => {});
  } else { const st = ((await q(`SELECT value FROM tg_state WHERE key = $1`, ['reg:' + chatId])).rows[0] || {}).value || {}; await addPhone(driverId, st.phone); }
  await dropButtons(chatId, cq.message.message_id);
  // a driver still onboarding: the bot starts in the default mode (👀 Watch and learn); the team changes it with /mode
  const st = ((await q(`SELECT value FROM tg_state WHERE key = $1`, ['reg:' + chatId])).rows[0] || {}).value || {};
  await linkChat(chatId, kind, driverId, who.user_id || null, who, { mode: st.mode });
  return 'Registered ✓';
}
async function modeButton(cq, who) {
  if (!isStaff(who)) return 'Only our team can choose this.';
  const [, did, mode] = cq.data.split(':'); const chatId = cq.message.chat.id;
  if (!MODES.some(([m]) => m === mode)) return 'Unknown';
  await dropButtons(chatId, cq.message.message_id);
  const linked = (await q(`SELECT 1 FROM tg_chats WHERE chat_id = $1 AND driver_id = $2 AND kind = 'dispatch'`, [chatId, +did])).rows[0];
  if (linked && handlers.dispatch && handlers.dispatch.setMode) await handlers.dispatch.setMode(+did, mode, who.name, who);
  else await linkChat(chatId, 'dispatch', +did, who.user_id || null, who, { mode });
  return MODES.find(([m]) => m === mode)[1] + ' ✓';
}
// /me 123456: a website user connects their Telegram
async function connectMe(m, code, who) {
  const c = (await q(`UPDATE tg_me_codes SET used_at = now() WHERE code = $1 AND used_at IS NULL AND created_at > now() - interval '1 day' RETURNING user_id`, [String(code || '').trim()])).rows[0];
  if (!c) return send(m.chat.id, 'That code is not valid. Make a new one on the website: Telegram → Connect my Telegram.', { replyTo: m.message_id });
  await q(`UPDATE tg_people SET user_id = $2, role = 'staff' WHERE tg_id = $1`, [who.tg_id, c.user_id]);
  const u = (await q(`SELECT name FROM users WHERE id = $1`, [c.user_id])).rows[0];
  await log('me', `${who.name} connected Telegram to the website (${u.name})`, { who });
  await send(m.chat.id, `✅ Connected: you are <b>${esc(u.name)}</b> on the website. You can now register groups and tap the team's buttons.`, { replyTo: m.message_id });
  const did = await resolveWaiting(who.tg_id);
  if (did.length) await send(m.chat.id, `Also connected what was waiting for you: ${did.map((x) => `<b>${esc(x)}</b>`).join(', ')}.`);
}
// What was waiting for this person (now connected or marked as our team): the groups they set up are connected
async function resolveWaiting(tgId) {
  const p = (await q(`SELECT * FROM tg_people WHERE tg_id = $1`, [tgId])).rows[0]; if (!isStaff(p)) return [];
  const did = [];
  for (const w of (await q(`SELECT w.*, ch.title, ch.driver_id linked FROM tg_waiting w JOIN tg_chats ch ON ch.chat_id = w.chat_id WHERE w.tg_id = $1 AND w.done_at IS NULL AND ch.active`, [tgId])).rows) {
    if (w.linked) { await doneWaiting(w.chat_id, p.name, 'connected'); continue; }
    if (w.driver_id && w.kind) { await linkChat(w.chat_id, w.kind, w.driver_id, p.user_id || null, p); did.push(w.title || 'a group'); }
    else { await doneWaiting(w.chat_id, p.name, 'asked again'); await autoRegister({ id: w.chat_id, title: w.title }, p); }
  }
  return did;
}
// After an update: groups still waiting whose title phone matches a driver are connected
async function retryWaiting() {
  if ((db.settings.tg || {}).autoPhone === false) return;
  for (const w of (await q(`SELECT w.chat_id, ch.title FROM tg_waiting w JOIN tg_chats ch ON ch.chat_id = w.chat_id WHERE w.done_at IS NULL AND ch.active AND ch.driver_id IS NULL`)).rows) {
    const info = titleInfo(w.title); const f = await findDrivers(info);
    if (f.sure && f.by === 'phone') { await log('connect', `The phone in the title matches ${f.sure.name}: connected by itself`, { chatId: w.chat_id, driverId: f.sure.id }); await linkChat(w.chat_id, info.kind, f.sure.id, null, null, { by: 'the phone in the title' }); }
  }
}
// /driver Name, in a private chat with the bot: the driver's profile, only for the team
async function driverCard(m, name, who) {
  if (!isStaff(who)) return send(m.chat.id, 'Only our team can see driver profiles.');
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return send(m.chat.id, 'Send <code>/driver Name</code>.');
  const d = (await q(`SELECT d.id, d.name FROM drivers d WHERE ${words.map((_, i) => `d.name ILIKE $${i + 1}`).join(' AND ')} ORDER BY (d.status = 'Hired') DESC, d.updated_at DESC LIMIT 1`, words.map((x) => `%${x}%`))).rows[0];
  if (!d) return send(m.chat.id, 'No driver by that name.');
  const text = handlers.profileText ? await handlers.profileText(d.id) : null;
  return send(m.chat.id, text || `No profile yet for <b>${esc(d.name)}</b>. It builds up from the driver's groups.`);
}
async function isAdmin(chatId) {
  try { const cm = await call('getChatMember', { chat_id: chatId, user_id: state.me.id }); const a = cm.status === 'administrator' || cm.status === 'creator'; await q(`UPDATE tg_chats SET bot_admin = $2 WHERE chat_id = $1`, [chatId, a]); return a; } catch (e) { return false; }
}

// ---------- one update ----------
// every update is handled "in" its chat, so the bot's answers there are told apart from what it writes on its own
function handle(u) {
  const m = u.message || u.edited_message || (u.callback_query && u.callback_query.message) || u.my_chat_member || u.chat_member || {};
  return handling.run({ chatId: m.chat ? m.chat.id : null }, () => handleUpdate(u));
}
async function handleUpdate(u) {
  state.lastUpdateAt = new Date();
  if (u.my_chat_member) {
    const c = u.my_chat_member; const st = c.new_chat_member.status; await chatOf(c.chat);
    const by = c.from && !c.from.is_bot ? await person(c.from) : null;
    if (st === 'left' || st === 'kicked') { await q(`UPDATE tg_chats SET active = false WHERE chat_id = $1`, [c.chat.id]); await log('left', `The bot was removed from "${clip(c.chat.title, 60)}"`, { chatId: c.chat.id, who: by }); return; }
    await q(`UPDATE tg_chats SET active = true, bot_admin = $2 WHERE chat_id = $1`, [c.chat.id, st === 'administrator']);
    const joined = c.old_chat_member.status === 'left' || c.old_chat_member.status === 'kicked';
    if (joined) await log('join', `The bot was added to "${clip(c.chat.title, 60)}"${st === 'administrator' ? ' as an admin' : ''}`, { chatId: c.chat.id, who: by });
    else if (st === 'administrator' && c.old_chat_member.status !== 'administrator') await log('join', 'The bot was made an admin', { chatId: c.chat.id, who: by });
    if (joined) await autoRegister(c.chat, by);
    return;
  }
  if (u.callback_query) {
    const cq = u.callback_query; const who = await person(cq.from);
    const chat = cq.message ? (await q(`SELECT * FROM tg_chats WHERE chat_id = $1`, [cq.message.chat.id])).rows[0] : null;
    if (chat && who) await q(`INSERT INTO tg_members (chat_id, tg_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [chat.chat_id, who.tg_id]);
    let answer = '';
    try {
      if (cq.data.startsWith('reg:')) answer = await registerButton(cq, who);
      else if (cq.data.startsWith('regm:')) answer = await modeButton(cq, who);
      else if (cq.data.startsWith('regc:')) { if (!isStaff(who)) answer = 'Only our team can choose this.'; else { const [, cid, md] = cq.data.split(':'); await dropButtons(cq.message.chat.id, cq.message.message_id); if (String(cid) === String(cq.message.chat.id) && await setChatMode(cq.message.chat.id, md, who.name, who)) answer = CMODES[md] + ' ✓'; } }
      else if (cq.data.startsWith('desk:')) answer = await require('./desk').onButton(cq, who);
      else if (cq.data.startsWith('jr:')) answer = await require('./journey').onButton(cq, who);
      else if (cq.data.startsWith('regk:')) { if (!isStaff(who)) answer = 'Only our team can register a group.'; else { await dropButtons(cq.message.chat.id, cq.message.message_id); await register({ chat: cq.message.chat, message_id: cq.message.message_id }, cq.data.split(':')[1], who); answer = 'OK'; } }
      else { const job = chat && handlers[chat.kind]; if (job && cq.data.startsWith(PREFIX[chat.kind] + ':')) answer = (await job.onButton(chat, cq, who)) || ''; }
    }
    catch (e) { console.error('tg button', e.message); answer = 'Something went wrong. Try again.'; }
    // the history: who tapped what
    const btn = cq.message && cq.message.reply_markup ? (cq.message.reply_markup.inline_keyboard || []).flat().find((b) => b.callback_data === cq.data) : null;
    if (cq.message && +cq.message.chat.id < 0) await log('tap', `Tapped "${clip(btn ? btn.text : cq.data, 50)}"${answer ? ` → ${clip(answer, 80)}` : ''}`, { chatId: cq.message.chat.id, who });
    await call('answerCallbackQuery', { callback_query_id: cq.id, text: answer.slice(0, 190) }).catch(() => {});
    return;
  }
  if (u.message_reaction) { // an emoji on one of the bot's messages
    const r = u.message_reaction; const who = r.user && !r.user.is_bot ? await person(r.user) : null;
    const bm = (await q(`SELECT text FROM tg_messages WHERE chat_id = $1 AND msg_id = $2 AND is_bot`, [r.chat.id, r.message_id])).rows[0];
    const em = (r.new_reaction || []).map((x) => x.emoji || (x.type === 'custom_emoji' ? '★' : '')).filter(Boolean).join(' ');
    if (bm) await log('reaction', em ? `Reacted ${em} to the bot: "${clip(bm.text, 70)}"` : `Took back a reaction on: "${clip(bm.text, 70)}"`, { chatId: r.chat.id, who });
    return;
  }
  const m = u.message || u.edited_message || u.channel_post; if (!m) return;
  if (m.migrate_to_chat_id) { // the group became a supergroup: it has a new id
    for (const t of ['tg_chats', 'tg_messages', 'tg_members', 'tg_summaries', 'eld_checks', 'eld_cases']) await q(`UPDATE ${t} SET chat_id = $2 WHERE chat_id = $1`, [m.chat.id, m.migrate_to_chat_id]).catch(() => {});
    return;
  }
  if (m.chat.type === 'private') {
    const s4 = /^\/start\s+s4_(\S+)/.exec(m.text || '');
    if (s4) return require('./mvr').privateStart(m, s4[1]);
    if (m.text && await require('./mvr').privateMessage(m)) return; // the last 4 of the SSN: never saved as a message
    // kept, so the Chrome extension (same bot) can read your replies to its alerts through the website
    if (m.text) await saveMessage(m);
    const pc = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(m.text || ''); const me = m.from ? await person(m.from) : null;
    if (pc && pc[1] === 'me') return connectMe(m, pc[2], me);
    if (pc && pc[1] === 'driver') return driverCard(m, pc[2], me);
    if ((pc && pc[1] === 'oil') || /^\s*oil( change| changes)?\s*$/i.test(m.text || '')) return require('./team').oilCmd(m.chat.id, me);
    if ((pc && pc[1] === 'onboard') || /^\s*onboard(ing)?\s*$/i.test(m.text || '')) return require('./team').onboardCmd(m.chat.id, me);
    if ((pc && pc[1] === 'empty') || /^\s*empty( trucks)?\s*$/i.test(m.text || '')) return emptyCmd(m.chat.id, me);
    if (pc && pc[1] === 'help') return send(m.chat.id, helpText(false));
    if (pc && pc[1] === 'kb') return kbCmd(m.chat.id, pc[2], me);
    if (me && isStaff(me) && await require('./routines').fromMessage(null, m, me)) return; // a booking list sent to the bot
    if (me && isStaff(me) && await require('./desk').privateText(m, me)) return; // an answer to the shift desk (a load option and why...)
    if (/^\/start/.test(m.text || '')) await send(m.chat.id, 'Hi! I work in the driver groups. Add me to a group and send the link code from the website there. Alerts from the Indeed extension also come here.');
    return;
  }
  const chat = await chatOf(m.chat); const who = m.from && !m.from.is_bot ? await person(m.from) : null;
  if (who) await q(`INSERT INTO tg_members (chat_id, tg_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [chat.chat_id, who.tg_id]);
  for (const nm of m.new_chat_members || []) { if (nm.is_bot) continue; const p = await person(nm); await q(`INSERT INTO tg_members (chat_id, tg_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [chat.chat_id, p.tg_id]); }
  if (m.left_chat_member && !m.left_chat_member.is_bot) await q(`DELETE FROM tg_members WHERE chat_id = $1 AND tg_id = $2`, [chat.chat_id, m.left_chat_member.id]);
  if (m.new_chat_title) { await q(`UPDATE tg_chats SET title = $2 WHERE chat_id = $1`, [chat.chat_id, m.new_chat_title]); return autoRegister({ ...m.chat, title: m.new_chat_title }, who, { renamed: true }); }
  if (!m.text && !m.caption && !m.photo && !m.document && !m.location && !m.voice) return;
  await saveMessage(m);
  if (who && m.reply_to_message && m.reply_to_message.from && state.me && m.reply_to_message.from.id === state.me.id && !u.edited_message)
    await log('reply', `Replied to the bot ("${clip(m.reply_to_message.text, 50)}"): ${clip(redact(m.text || m.caption || '[' + (m.photo ? 'photo' : 'file') + ']').replace(/\d{4,}/g, '••••'), 90)}`, { chatId: chat.chat_id, who });
  const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(m.text || '');
  if (chat.kind === 'management' && who && isStaff(who) && !cmd && m.reply_to_message && await require('./journey').fromReply(chat, m, who)) return; // an answer to a follow-up, in words
  if ((chat.kind === 'shift' || chat.kind === 'management') && who && isStaff(who) && !cmd && await require('./routines').fromMessage(chat, m, who)) return; // a booking list
  if (chat.kind === 'shift' && who && isStaff(who) && !cmd) { await require('./desk').privateText(m, who); return; } // a shift group: only answers to the bot's questions
  if ((cmd && cmd[1] === 'oil') || (chat.kind === 'management' && /^\s*oil( change| changes)?\s*$/i.test(m.text || ''))) {
    if (!isStaff(who)) return;
    if (chat.driver_id) { const ok = await require('./team').oilCmd(who.tg_id, who).catch(() => null); return react(m.chat.id, m.message_id, ok ? '👌' : '🤷'); } // never in a driver's group
    return require('./team').oilCmd(m.chat.id, who);
  }
  if ((cmd && cmd[1] === 'onboard') || (chat.kind === 'management' && /^\s*onboard(ing)?\s*$/i.test(m.text || ''))) {
    if (!isStaff(who)) return;
    if (chat.driver_id) { const ok = await require('./team').onboardCmd(who.tg_id, who).catch(() => null); return react(m.chat.id, m.message_id, ok ? '👌' : '🤷'); } // never in a driver's group
    return require('./team').onboardCmd(m.chat.id, who, { tagRecruiters: chat.kind === 'management' });
  }
  if ((cmd && cmd[1] === 'empty') || /^\s*empty( trucks)?\s*$/i.test(m.text || '')) {
    if (!isStaff(who)) return; // not for drivers; nothing written
    if (chat.driver_id) { // a driver's group: never post the list there
      const ok = await emptyCmd(who.tg_id, who).catch(() => null);
      await react(m.chat.id, m.message_id, ok ? '👌' : '🤷');
      if (!ok) await log('cmd', `/empty in a driver's group: could not send it privately (${who.name} has not started a chat with the bot)`, { chatId: chat.chat_id, who });
      return;
    }
    return emptyCmd(m.chat.id, who);
  }
  if (cmd && ['help', 'mode', 'sum', 'status', 'link', 'info'].includes(cmd[1])) await log('cmd', `/${cmd[1]}${cmd[2] && cmd[1] === 'mode' ? ' ' + clip(cmd[2], 20) : ''}`, { chatId: chat.chat_id, who });
  if (cmd && cmd[1] === 'link') return link(m, cmd[2].trim(), who);
  if (cmd && cmd[1] === 'me') return connectMe(m, cmd[2], who);
  const reg = /^\/?register(?:@\w+)?\b\s*(.*)$/is.exec((m.text || '').trim());
  if (reg && who) return register(m, reg[1], who);
  if (cmd && cmd[1] === 'help') return send(chat.chat_id, helpText(true), { replyTo: m.message_id });
  if (cmd && cmd[1] === 'info' && chat.kind === 'eld') return require('./eld').infoCmd(chat, who); // the driver's info and papers, on request
  if (cmd && (cmd[1] === 'pause' || cmd[1] === 'resume')) { // an admin stops or restarts the bot everywhere
    const adm = who && who.user_id && (await q(`SELECT 1 FROM users WHERE id = $1 AND active AND role = 'admin'`, [who.user_id])).rows[0];
    if (!adm) return send(m.chat.id, 'Only an admin can pause the bot.', { replyTo: m.message_id, human: true });
    await db.saveSetting('tg', { ...(db.settings.tg || {}), paused: cmd[1] === 'pause' });
    await log('mode', cmd[1] === 'pause' ? `${who.name} paused the bot everywhere` : `${who.name} resumed the bot`, { chatId: chat.chat_id, who });
    return send(m.chat.id, cmd[1] === 'pause' ? '⏸ Paused. I will not write in any group until /resume. I keep reading and learning.' : '▶️ Back on.', { replyTo: m.message_id, human: true });
  }
  if (cmd && cmd[1] === 'mode') return modeCmd(m, chat, cmd[2], who);
  if (cmd && cmd[1] === 'sum') return sumCmd(m, chat, who);
  if (cmd && cmd[1] === 'status') {
    if (handlers[chat.kind]) return handlers[chat.kind].status(chat);
    return send(chat.chat_id, chat.kind ? `This is the ${KINDS[chat.kind]} group.` : 'This group is not linked to a driver yet. Send the link code from the driver\'s page on the website, like /link 482913.');
  }
  if (handlers[chat.kind] && who && !u.edited_message && !((chat.kind === 'eld' || chat.kind === 'accounting') && chat.mode === 'watch')) await handlers[chat.kind].onMessage(chat, m, who); // a silent ELD / accounting group: read only
}

// ---------- the command list in Telegram's / menu ----------
const GROUP_CMDS = [['info', 'ELD group: the driver\'s info, CDL and truck papers'], ['register', 'Connect this group to a driver (dispatch, ELD or accounting)'], ['mode', 'Onboarding: how I work here (watch, answer, run)'], ['status', 'The driver\'s status card'],
  ['sum', 'Sum up today on the website now'], ['help', 'What I do and the commands']];
const PRIVATE_CMDS = [['kb', 'Ask the knowledge base: /kb Kearny parking'], ['oil', 'Oil changes: every truck, overdue first'], ['onboard', 'Drivers in onboarding: Amazon verified / pending'], ['empty', 'The empty trucks, by company'], ['me', 'Connect your website account: /me CODE'], ['driver', 'A driver\'s profile for dispatchers: /driver Name'], ['help', 'What I do and the commands']];
async function setCommands() {
  const list = (a) => a.map(([command, description]) => ({ command, description }));
  await call('setMyCommands', { commands: list(GROUP_CMDS), scope: { type: 'all_group_chats' } });
  await call('setMyCommands', { commands: list(PRIVATE_CMDS), scope: { type: 'all_private_chats' } });
  await call('setMyCommands', { commands: list(PRIVATE_CMDS) });
}
const helpText = (group) => group
  ? '<b>FleetHire assistant</b>\nI read this group and keep the team informed on the website.\n\n/register: connect this group to a driver (I also do it myself when the title has the driver\'s name and phone)\n/mode: onboarding groups: 👀 watch and learn, 💬 answer questions, or 🚀 run the onboarding\n/status: the driver\'s status card\n/sum: sum up today on the website now\n\nThe commands are for our team (connect your account first: in a private chat with me, /me CODE from the website).'
  : '<b>FleetHire assistant</b>\n/me CODE: connect your website account (the code is on the website: Telegram → Connect my Telegram)\n/onboard: the drivers in onboarding (Amazon verified, pending)\n/empty: the empty trucks, by company\n/oil: oil changes for every truck\n/driver Name: a driver\'s profile for dispatchers\n/kb words: what the team knows (sites, pay, logs, breakdowns...)\n\nAdd me to a driver\'s group and send /register there.';
// /kb words: search what the team knows (no AI): the knowledge base, the team's words, shops & services, case playbooks
async function kbCmd(chatId, words, me) {
  if (!me || !isStaff(me)) return send(chatId, 'This is for our team. Connect your website account first: /me CODE');
  if (!String(words || '').trim()) return send(chatId, 'What are you looking for? For example: /kb Kearny parking, /kb pay day, /kb DPF');
  const role = me.user_id ? ((await q(`SELECT role FROM users WHERE id = $1`, [me.user_id])).rows[0] || {}).role : 'admin';
  const r = await require('../kb').search(words, { limit: 6, role });
  if (!r.length) return send(chatId, `Nothing found for "${esc(words)}". The bot keeps learning from the groups; you can also add it on the website (Knowledge base).`);
  const icon = { kb: '📘', term: '💬', place: '🔧', playbook: '🧭' };
  return send(chatId, r.map((x) => `${icon[x.type] || '•'} <b>${esc(x.title)}</b>\n${esc(String(x.text || '').slice(0, 400))}`).join('\n\n'));
}
// /mode in an onboarding group: buttons, or "/mode watch"
async function modeCmd(m, chat, arg, who) {
  if (!isStaff(who)) return send(m.chat.id, 'Only our team can change this.', { replyTo: m.message_id });
  const d = chat.driver_id ? (await q(`SELECT status, name FROM drivers WHERE id = $1`, [chat.driver_id])).rows[0] : null;
  if (chat.kind === 'dispatch' && d && (d.status === 'Hired' || chat.member_count > 10)) { // a working driver's group
    const w2 = { watch: 'watch', learn: 'watch', quiet: 'watch', updater: 'updater', update: 'updater', run: 'updater' }[String(arg || '').trim().toLowerCase()];
    if (w2) { await setChatMode(chat.chat_id, w2, who.name, who); return react(m.chat.id, m.message_id, '👍'); }
    return send(m.chat.id, `How should I work in <b>${esc(d.name)}</b>'s group? Now: ${CMODES[chat.mode || 'watch']}.`, { replyTo: m.message_id, buttons: Object.entries(CMODES).map(([x, l]) => [[(x === (chat.mode || 'watch') ? '✓ ' : '') + l, `regc:${chat.chat_id}:${x}`]]) });
  }
  if (chat.kind !== 'dispatch' || !d) return send(m.chat.id, 'Modes are for dispatch groups.', { replyTo: m.message_id });
  const w = MODE_WORD[String(arg || '').trim().toLowerCase()];
  if (w && handlers.dispatch.setMode) { await handlers.dispatch.setMode(chat.driver_id, w, who.name, who); return send(m.chat.id, `${MODES.find(([x]) => x === w)[1]} ✓`, { replyTo: m.message_id }); }
  const cur = ((await q(`SELECT mode FROM onb_cases WHERE driver_id = $1`, [chat.driver_id])).rows[0] || {}).mode;
  return send(m.chat.id, `How should I work in <b>${esc(d.name)}</b>'s group?${cur ? ` Now: ${MODES.find(([x]) => x === cur)[1]}.` : ''}`, { replyTo: m.message_id, buttons: MODES.map(([x, l]) => [[(x === cur ? '✓ ' : '') + l, `regm:${chat.driver_id}:${x}`]]) });
}
// a working driver's group: 👀 watch and learn (writes nothing) or 🚚 updater (also writes: checks mismatches with the driver, confirms appointment changes)
const CMODES = { watch: '👀 Watch and learn', updater: '🚚 Updater' };
async function setChatMode(chatId, mode, by, who = null) {
  if (!CMODES[mode]) return false;
  const was = (await q(`SELECT kind, driver_id, mode FROM tg_chats WHERE chat_id = $1`, [chatId])).rows[0] || {};
  await q(`UPDATE tg_chats SET mode = $2 WHERE chat_id = $1`, [chatId, mode]);
  const eldish = was.kind === 'eld' || was.kind === 'accounting';
  await log('mode', `Mode: ${eldish ? (mode === 'watch' ? '👀 Silent (reads only)' : '🛠 Runs the setup and checks') : CMODES[mode]}${who ? '' : ` (${by || 'website'})`}`, { chatId, who });
  // an ELD / accounting group switched on: start its setup if it never ran
  if (eldish && mode === 'updater' && was.mode === 'watch' && was.driver_id && handlers[was.kind]) {
    const ran = was.kind === 'eld' ? (await q(`SELECT 1 FROM eld_cases WHERE chat_id = $1`, [chatId])).rows[0] : null;
    if (!ran) await handlers[was.kind].begin(chatId, was.driver_id, {});
  }
  return true;
}
// /empty: the empty trucks, by company: how long, what it costs, who is coming. Team only.
// In a driver's group it is never posted there: it goes to the person privately.
async function emptyCmd(chatId, who, { inGroup = null } = {}) {
  if (!isStaff(who)) return send(chatId, 'Only our team can see this. Connect your website account first: /me CODE (the code is under Telegram → Connect my Telegram).');
  const b = await require('../fleet').emptyBoard();
  const comps = Object.fromEntries((await q(`SELECT id, name FROM companies`)).rows.map((c) => [c.id, c.name]));
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  if (!b.count) return send(chatId, '✅ No empty trucks. Every truck in service has a driver.');
  const by = {}; for (const t of b.trucks) (by[t.companyId || 0] = by[t.companyId || 0] || []).push(t);
  const lines = [`🚛 <b>${b.count} empty truck${b.count === 1 ? '' : 's'}</b>, costing about ${money(b.losingPerDay)} a day (${money(b.lost)} so far)`];
  for (const [cid, ts] of Object.entries(by).sort((x, y) => String(comps[x[0]] || 'zz').localeCompare(String(comps[y[0]] || 'zz')))) {
    lines.push('', `<b>${esc(comps[cid] || 'No company')}</b> (${ts.length})`);
    for (const t of ts) {
      const c = t.coming;
      lines.push(`• <b>${esc(t.unit)}</b>: ${t.days ? `${t.days} day${t.days === 1 ? '' : 's'} empty, ${money(t.lost)}` : 'empty since today'}${c ? `\n   ↳ coming: ${esc(c.name)} (${esc(c.status.toLowerCase())}${c.arrival ? `, starts ${esc(require('../lib').niceDate(c.arrival))}` : ''}${c.owner ? `, ${esc(c.owner)}` : ''})` : ''}`);
    }
  }
  return send(chatId, lines.join('\n'));
}
// /sum: today's summary now (on the website)
async function sumCmd(m, chat, who) {
  if (!isStaff(who)) return send(m.chat.id, 'Only our team can do this.', { replyTo: m.message_id });
  if (!chat.driver_id) return send(m.chat.id, 'Connect this group to a driver first: /register', { replyTo: m.message_id });
  const day = (await q(`SELECT (now() AT TIME ZONE $1)::date::text d`, [db.settings.tz])).rows[0].d;
  await require('./digest').digestChat(chat.chat_id).catch(() => null);
  const s = await require('./summary').summarizeChat(chat.chat_id, day).catch(() => null);
  return send(m.chat.id, s ? '📝 Summed up on the website.' : 'Nothing to sum up yet today.', { replyTo: m.message_id });
}

// ---------- running ----------
async function loop() {
  let offset = +((await q(`SELECT value FROM tg_state WHERE key = 'offset'`)).rows[0] || { value: 0 }).value || 0;
  while (state.running) {
    try {
      const ups = await call('getUpdates', { offset, timeout: +process.env.TG_POLL_SECONDS || 25, allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member', 'message_reaction'] });
      for (const u of ups) {
        try { await handle(u); } catch (e) { console.error('tg update', e.message); state.lastError = e.message; }
        offset = u.update_id + 1;
        await q(`INSERT INTO tg_state (key, value) VALUES ('offset', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [JSON.stringify(offset)]);
      }
      state.lastError = null;
    } catch (e) { state.lastError = e.message; console.error('tg poll', e.message); await sleep(e.code === 409 ? 30000 : 5000); }
  }
}
async function start() {
  if (!TOKEN() || state.running) return;
  state.running = true; state.startedAt = new Date();
  for (let i = 0; !state.me && state.running; i++) {
    try { state.me = await call('getMe'); } catch (e) { state.lastError = e.message; console.error('tg getMe', e.message); await sleep(Math.min(60000, 5000 * (i + 1))); }
  }
  console.log('Telegram bot on as @' + state.me.username);
  await setCommands().catch((e) => console.error('tg commands', e.message));
  await retryWaiting().catch((e) => console.error('tg waiting', e.message));
  loop();
}
// A link that opens the driver's Telegram group. For the team's messages about a driver (management group, private
// chats): the first time his name appears in the text it becomes this link. In a group the bot is in (a supergroup),
// a t.me/c/ link to the newest message opens the chat for anyone who is a member; else the group's invite link.
async function groupUrl(driverId) {
  const g = (await db.q(`SELECT c.chat_id::text chat_id, c.invite_link, (SELECT max(m.msg_id) FROM tg_messages m WHERE m.chat_id = c.chat_id) last
    FROM tg_chats c WHERE c.driver_id = $1 AND c.kind = 'dispatch' AND c.active ORDER BY c.linked_at DESC NULLS LAST LIMIT 1`, [driverId])).rows[0];
  if (!g) { const o = (await db.q(`SELECT telegram_link FROM onboarding WHERE driver_id = $1`, [driverId])).rows[0]; return o && /^https:\/\/t\.me\//.test(o.telegram_link || '') ? o.telegram_link : null; }
  if (/^-100\d+$/.test(g.chat_id) && g.last) return `https://t.me/c/${g.chat_id.slice(4)}/${g.last}`;
  return g.invite_link || null;
}
async function linkName(html, driverId, name) {
  if (!driverId || !name) return html;
  const n = esc(name); const at = html.indexOf(n); if (at < 0 || /<a [^>]*>[^<]*$/.test(html.slice(0, at))) return html;
  const url = await groupUrl(driverId).catch(() => null); if (!url) return html;
  return html.slice(0, at) + `<a href="${esc(url)}">${n}</a>` + html.slice(at + n.length);
}
module.exports = { watchOnly, inChat: (chatId, fn) => handling.run({ chatId }, fn), groupUrl, linkName, paused, react, isStaff, trivial, sendFile, linkTeam, stripHtml, latin, setChatMode, CMODES, resolveWaiting, log, wait, titleInfo, findDrivers, start, call, send, edit, dropButtons, download, noteMedia, tag, esc, redact, state, handlers, handle, KINDS, isStaff, linkChat, on: () => !!TOKEN() };
