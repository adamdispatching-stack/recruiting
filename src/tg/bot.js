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
async function send(chatId, html, { buttons, replyTo, forceReply } = {}) {
  const params = { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true };
  if (buttons) params.reply_markup = { inline_keyboard: buttons.map((row) => row.map(([text, data]) => ({ text, callback_data: data }))) };
  if (forceReply) params.reply_markup = { force_reply: true, selective: true };
  if (replyTo) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  for (let i = 0; i < 3; i++) {
    try {
      const m = await call('sendMessage', params);
      await saveMessage({ chat: { id: chatId }, message_id: m.message_id, from: { id: state.me ? state.me.id : 0, is_bot: true, first_name: state.me ? state.me.first_name : 'Bot' }, date: m.date, text: stripHtml(html) });
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
const dropButtons = (chatId, msgId) => call('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }).catch(() => {});

// ---------- keeping what was said ----------
// Passwords, PINs and account numbers are hidden before anything is saved.
function redact(t) {
  if (!t) return t;
  return String(t)
    .replace(/\b(pass(?:word)?|pwd|pin|passcode)\b(\s*[:=-]?\s*)(\S+)/gi, (m, k, sep) => `${k}${sep}[hidden]`)
    .replace(/\b(routing|account|acct|ssn|social security)(\s*(?:number|no\.?|#)?\s*[:=-]?\s*)([\d -]{4,})/gi, (m, k, sep) => `${k}${sep}[hidden]`)
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[hidden]');
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
const noteMedia = (chatId, msgId, note) => q(`UPDATE tg_messages SET media_note = $3 WHERE chat_id = $1 AND msg_id = $2`, [chatId, msgId, note]);

// ---------- groups and linking ----------
async function chatOf(c) {
  const r = await q(`INSERT INTO tg_chats (chat_id, title) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET title = coalesce($2, tg_chats.title) RETURNING *`, [c.id, c.title || null]);
  return r.rows[0];
}
const KINDS = { dispatch: 'Dispatch', eld: 'ELD', accounting: 'Accounting' };
const PREFIX = { dispatch: 'onb', eld: 'eld', accounting: 'acc' }; // button data starts with this per kind
// Make a group the driver's dispatch, ELD or accounting group
async function linkChat(chatId, kind, driverId, userId, who, opts = {}) {
  const d = (await q(`SELECT id, name FROM drivers WHERE id = $1`, [driverId])).rows[0];
  await q(`UPDATE tg_chats SET kind = NULL, driver_id = NULL WHERE driver_id = $1 AND kind = $2 AND chat_id <> $3`, [driverId, kind, chatId]); // one group per driver and kind
  await q(`UPDATE tg_chats SET kind = $2, driver_id = $3, linked_by = $4, linked_at = now(), active = true WHERE chat_id = $1`, [chatId, kind, driverId, userId || null]);
  if (who) await q(`UPDATE tg_people SET role = coalesce(role, 'staff'), user_id = coalesce(user_id, $2) WHERE tg_id = $1`, [who.tg_id, userId || null]);
  // keep an invite link when the bot may make one
  const inv = await call('exportChatInviteLink', { chat_id: chatId }).catch(() => null);
  if (inv) await q(`UPDATE tg_chats SET invite_link = $2 WHERE chat_id = $1`, [chatId, inv]);
  if (inv && kind === 'dispatch') await q(`UPDATE onboarding SET telegram_link = coalesce(telegram_link, $2) WHERE driver_id = $1`, [driverId, inv]);
  await db.syncAuto(db.pool, driverId, userId || null); // "Telegram group created", "ELD group set up", "Accounting group set up"
  await q(`UPDATE drivers SET updated_at = now() WHERE id = $1`, [driverId]);
  await require('../lib').history(driverId, `${KINDS[kind]} Telegram group linked`, who ? who.name : 'Telegram', 'telegram').catch(() => {});
  await send(chatId, `✅ This is now the <b>${KINDS[kind]}</b> group for <b>${esc(d.name)}</b>.${state.me && !(await isAdmin(chatId)) ? '\n\nPlease make me an admin of this group, so I can read every message (Group settings → Administrators → Add admin).' : ''}`);
  if (handlers[kind]) await handlers[kind].begin(chatId, driverId, opts);
  // an onboarding group starts in 👀 Watch and learn (the default): say so once, and how to change it
  if (kind === 'dispatch' && (await q(`SELECT 1 FROM onb_cases WHERE driver_id = $1 AND chat_id = $2 AND mode = 'watch'`, [driverId, chatId])).rows[0])
    await send(chatId, '👀 Watch and learn: I read along, sum it up on the website and learn from the team. I won\'t write here.\nTo change: /mode');
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
const KIND_WORD = { dispatch: 'dispatch', updates: 'dispatch', onboarding: 'dispatch', eld: 'eld', accounting: 'accounting', acct: 'accounting', accounts: 'accounting' };
async function register(m, args, who) {
  if (!isStaff(who)) return send(m.chat.id, 'I don\'t know you yet. On the website, open Telegram and use "Connect my Telegram" (or an admin marks you as "Our team" under Telegram → People), then send register again.', { replyTo: m.message_id });
  const [w, ...rest] = String(args || '').trim().split(/\s+/);
  const kind = KIND_WORD[(w || '').toLowerCase()];
  if (!kind) return send(m.chat.id, 'Which group is this?', { replyTo: m.message_id, buttons: [[['🚚 Dispatch (onboarding)', 'regk:dispatch'], ['📋 ELD', 'regk:eld'], ['💵 Accounting', 'regk:accounting']]] });
  let mode = null; if (rest.length && MODE_WORD[rest[rest.length - 1].toLowerCase()]) mode = MODE_WORD[rest.pop().toLowerCase()];
  let name = rest.join(' ').trim();
  if (!name) name = String(m.chat.title || '').replace(/\b(eld|dispatch|accounting|acct|group|chat|updates?|onboarding|fleethire)\b/gi, ' ').replace(/[^\p{L}\p{N}' -]+/gu, ' ').trim();
  const words = name.split(/\s+/).filter((x) => x.length > 1);
  const cand = words.length ? (await q(`SELECT id, name, status FROM drivers WHERE ${words.map((_, i) => `name ILIKE $${i + 1}`).join(' AND ')} AND status NOT IN ('Not interested', 'Declined on Indeed', 'No CDL')
      ORDER BY (status = 'Hired') DESC, (status = 'Onboarding') DESC, updated_at DESC LIMIT 6`, words.map((x) => `%${x}%`))).rows : [];
  const rows = cand.map((d) => [[`${d.name} (${d.status === 'Hired' ? 'active' : d.status.toLowerCase()})`, `reg:${kind}:${d.id}`]]);
  if (name) rows.push([[`➕ Add "${name.slice(0, 40)}" as an active driver`, `reg:${kind}:new`]]);
  await q(`INSERT INTO tg_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, ['reg:' + m.chat.id, JSON.stringify({ name, kind, by: who.tg_id, mode })]);
  if (!rows.length) return send(m.chat.id, 'Whose group is this? Send <code>register ' + kind + ' Driver Name</code>.', { replyTo: m.message_id });
  return send(m.chat.id, `Which driver is this <b>${KINDS[kind]}</b> group for?`, { replyTo: m.message_id, buttons: rows });
}
async function registerButton(cq, who) {
  if (!isStaff(who)) return 'Only our team can register a group.';
  const [, kind, did] = cq.data.split(':'); const chatId = cq.message.chat.id;
  let driverId = +did;
  if (did === 'new') {
    const st = ((await q(`SELECT value FROM tg_state WHERE key = $1`, ['reg:' + chatId])).rows[0] || {}).value || {};
    if (!st.name) return 'Send register again with the driver\'s name.';
    const ins = await q(`INSERT INTO drivers (name, name_key, status, source, owner_id, created_by, status_at, status_locked) VALUES ($1, $2, 'Hired', 'Telegram', NULL, $3, now(), true) RETURNING id`, [st.name, db.keyOf(st.name), who.user_id || null]);
    driverId = ins.rows[0].id;
    await require('../lib').history(driverId, 'Added as an active driver from Telegram', who.name, 'telegram').catch(() => {});
  }
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
  if (linked && handlers.dispatch && handlers.dispatch.setMode) await handlers.dispatch.setMode(+did, mode, who.name);
  else await linkChat(chatId, 'dispatch', +did, who.user_id || null, who, { mode });
  return MODES.find(([m]) => m === mode)[1] + ' ✓';
}
// /me 123456: a website user connects their Telegram
async function connectMe(m, code, who) {
  const c = (await q(`UPDATE tg_me_codes SET used_at = now() WHERE code = $1 AND used_at IS NULL AND created_at > now() - interval '1 day' RETURNING user_id`, [String(code || '').trim()])).rows[0];
  if (!c) return send(m.chat.id, 'That code is not valid. Make a new one on the website: Telegram → Connect my Telegram.', { replyTo: m.message_id });
  await q(`UPDATE tg_people SET user_id = $2, role = 'staff' WHERE tg_id = $1`, [who.tg_id, c.user_id]);
  const u = (await q(`SELECT name FROM users WHERE id = $1`, [c.user_id])).rows[0];
  return send(m.chat.id, `✅ Connected: you are <b>${esc(u.name)}</b> on the website. You can now register groups and tap the team's buttons.`, { replyTo: m.message_id });
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
async function handle(u) {
  state.lastUpdateAt = new Date();
  if (u.my_chat_member) {
    const c = u.my_chat_member; const st = c.new_chat_member.status; await chatOf(c.chat);
    if (st === 'left' || st === 'kicked') { await q(`UPDATE tg_chats SET active = false WHERE chat_id = $1`, [c.chat.id]); return; }
    await q(`UPDATE tg_chats SET active = true, bot_admin = $2 WHERE chat_id = $1`, [c.chat.id, st === 'administrator']);
    if (c.old_chat_member.status === 'left' || c.old_chat_member.status === 'kicked') {
      await send(c.chat.id, '👋 Hi, I am the FleetHire assistant.\n\nTo connect this group to a driver, send the link code from the driver\'s page on the website, like <code>/link 482913</code>.\nPlease also make me an admin, so I can read the messages.');
    }
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
      else if (cq.data.startsWith('regk:')) { if (!isStaff(who)) answer = 'Only our team can register a group.'; else { await dropButtons(cq.message.chat.id, cq.message.message_id); await register({ chat: cq.message.chat, message_id: cq.message.message_id }, cq.data.split(':')[1], who); answer = 'OK'; } }
      else { const job = chat && handlers[chat.kind]; if (job && cq.data.startsWith(PREFIX[chat.kind] + ':')) answer = (await job.onButton(chat, cq, who)) || ''; }
    }
    catch (e) { console.error('tg button', e.message); answer = 'Something went wrong. Try again.'; }
    await call('answerCallbackQuery', { callback_query_id: cq.id, text: answer.slice(0, 190) }).catch(() => {});
    return;
  }
  const m = u.message || u.edited_message || u.channel_post; if (!m) return;
  if (m.migrate_to_chat_id) { // the group became a supergroup: it has a new id
    for (const t of ['tg_chats', 'tg_messages', 'tg_members', 'tg_summaries', 'eld_checks', 'eld_cases']) await q(`UPDATE ${t} SET chat_id = $2 WHERE chat_id = $1`, [m.chat.id, m.migrate_to_chat_id]).catch(() => {});
    return;
  }
  if (m.chat.type === 'private') {
    // kept, so the Chrome extension (same bot) can read your replies to its alerts through the website
    if (m.text) await saveMessage(m);
    const pc = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(m.text || ''); const me = m.from ? await person(m.from) : null;
    if (pc && pc[1] === 'me') return connectMe(m, pc[2], me);
    if (pc && pc[1] === 'driver') return driverCard(m, pc[2], me);
    if (pc && pc[1] === 'help') return send(m.chat.id, helpText(false));
    if (/^\/start/.test(m.text || '')) await send(m.chat.id, 'Hi! I work in the driver groups. Add me to a group and send the link code from the website there. Alerts from the Indeed extension also come here.');
    return;
  }
  const chat = await chatOf(m.chat); const who = m.from && !m.from.is_bot ? await person(m.from) : null;
  if (who) await q(`INSERT INTO tg_members (chat_id, tg_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [chat.chat_id, who.tg_id]);
  for (const nm of m.new_chat_members || []) { if (nm.is_bot) continue; const p = await person(nm); await q(`INSERT INTO tg_members (chat_id, tg_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [chat.chat_id, p.tg_id]); }
  if (m.left_chat_member && !m.left_chat_member.is_bot) await q(`DELETE FROM tg_members WHERE chat_id = $1 AND tg_id = $2`, [chat.chat_id, m.left_chat_member.id]);
  if (!m.text && !m.caption && !m.photo && !m.document && !m.location && !m.voice) return;
  await saveMessage(m);
  const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(m.text || '');
  if (cmd && cmd[1] === 'link') return link(m, cmd[2].trim(), who);
  if (cmd && cmd[1] === 'me') return connectMe(m, cmd[2], who);
  const reg = /^\/?register(?:@\w+)?\b\s*(.*)$/is.exec((m.text || '').trim());
  if (reg && who) return register(m, reg[1], who);
  if (cmd && cmd[1] === 'help') return send(chat.chat_id, helpText(true), { replyTo: m.message_id });
  if (cmd && cmd[1] === 'mode') return modeCmd(m, chat, cmd[2], who);
  if (cmd && cmd[1] === 'sum') return sumCmd(m, chat, who);
  if (cmd && cmd[1] === 'status') {
    if (handlers[chat.kind]) return handlers[chat.kind].status(chat);
    return send(chat.chat_id, chat.kind ? `This is the ${KINDS[chat.kind]} group.` : 'This group is not linked to a driver yet. Send the link code from the driver\'s page on the website, like /link 482913.');
  }
  if (handlers[chat.kind] && who && !u.edited_message) await handlers[chat.kind].onMessage(chat, m, who);
}

// ---------- the command list in Telegram's / menu ----------
const GROUP_CMDS = [['register', 'Connect this group to a driver (dispatch, ELD or accounting)'], ['mode', 'Onboarding: how I work here (watch, answer, run)'], ['status', 'The driver\'s status card'],
  ['sum', 'Sum up today on the website now'], ['help', 'What I do and the commands']];
const PRIVATE_CMDS = [['me', 'Connect your website account: /me CODE'], ['driver', 'A driver\'s profile for dispatchers: /driver Name'], ['help', 'What I do and the commands']];
async function setCommands() {
  const list = (a) => a.map(([command, description]) => ({ command, description }));
  await call('setMyCommands', { commands: list(GROUP_CMDS), scope: { type: 'all_group_chats' } });
  await call('setMyCommands', { commands: list(PRIVATE_CMDS), scope: { type: 'all_private_chats' } });
  await call('setMyCommands', { commands: list(PRIVATE_CMDS) });
}
const helpText = (group) => group
  ? '<b>FleetHire assistant</b>\nI read this group and keep the team informed on the website.\n\n/register: connect this group to a driver\n/mode: onboarding groups: 👀 watch and learn, 💬 answer questions, or 🚀 run the onboarding\n/status: the driver\'s status card\n/sum: sum up today on the website now\n\nThe commands are for our team (connect your account first: in a private chat with me, /me CODE from the website).'
  : '<b>FleetHire assistant</b>\n/me CODE: connect your website account (the code is on the website: Telegram → Connect my Telegram)\n/driver Name: a driver\'s profile for dispatchers\n\nAdd me to a driver\'s group and send /register there.';
// /mode in an onboarding group: buttons, or "/mode watch"
async function modeCmd(m, chat, arg, who) {
  if (!isStaff(who)) return send(m.chat.id, 'Only our team can change this.', { replyTo: m.message_id });
  const d = chat.driver_id ? (await q(`SELECT status, name FROM drivers WHERE id = $1`, [chat.driver_id])).rows[0] : null;
  if (chat.kind !== 'dispatch' || !d || d.status === 'Hired') return send(m.chat.id, 'Modes are for onboarding groups (a dispatch group of a driver who is not hired yet).', { replyTo: m.message_id });
  const w = MODE_WORD[String(arg || '').trim().toLowerCase()];
  if (w && handlers.dispatch.setMode) { await handlers.dispatch.setMode(chat.driver_id, w, who.name); return send(m.chat.id, `${MODES.find(([x]) => x === w)[1]} ✓`, { replyTo: m.message_id }); }
  const cur = ((await q(`SELECT mode FROM onb_cases WHERE driver_id = $1`, [chat.driver_id])).rows[0] || {}).mode;
  return send(m.chat.id, `How should I work in <b>${esc(d.name)}</b>'s group?${cur ? ` Now: ${MODES.find(([x]) => x === cur)[1]}.` : ''}`, { replyTo: m.message_id, buttons: MODES.map(([x, l]) => [[(x === cur ? '✓ ' : '') + l, `regm:${chat.driver_id}:${x}`]]) });
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
      const ups = await call('getUpdates', { offset, timeout: +process.env.TG_POLL_SECONDS || 25, allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'] });
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
  loop();
}
module.exports = { start, call, send, edit, dropButtons, download, noteMedia, tag, esc, redact, state, handlers, handle, KINDS, isStaff, linkChat, on: () => !!TOKEN() };
