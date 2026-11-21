// The FleetHire Telegram bot, running inside the website.
// It needs TELEGRAM_BOT_TOKEN (from @BotFather) in the Railway variables; without it the bot stays off.
// It reads updates by long polling, keeps the groups, people and messages, and hands each group to its job
// (ELD now; accounting and dispatch later). Recruiters link a group to a driver with a code from the website.
const db = require('../db');
const { q } = db;

const API = () => (process.env.TG_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const state = { running: false, me: null, lastError: null, lastUpdateAt: null, startedAt: null };
const handlers = { eld: null }; // set by the job modules
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
  await q(`INSERT INTO tg_messages (chat_id, msg_id, from_id, from_name, is_bot, text, media, media_note, reply_to, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10))
    ON CONFLICT (chat_id, msg_id) DO UPDATE SET text = EXCLUDED.text`,
  [m.chat.id, m.message_id, m.from ? m.from.id : null, m.from ? nameOf(m.from) : null, !!(m.from && m.from.is_bot), text, media, extra.note || null, m.reply_to_message ? m.reply_to_message.message_id : null, m.date || Date.now() / 1000]);
  await q(`UPDATE tg_chats SET last_at = now() WHERE chat_id = $1`, [m.chat.id]);
}
const noteMedia = (chatId, msgId, note) => q(`UPDATE tg_messages SET media_note = $3 WHERE chat_id = $1 AND msg_id = $2`, [chatId, msgId, note]);

// ---------- groups and linking ----------
async function chatOf(c) {
  const r = await q(`INSERT INTO tg_chats (chat_id, title) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET title = coalesce($2, tg_chats.title) RETURNING *`, [c.id, c.title || null]);
  return r.rows[0];
}
const KINDS = { eld: 'ELD', accounting: 'Accounting', updates: 'Updates', dispatch: 'Dispatch' };
async function link(m, code, who) {
  const L = (await q(`SELECT l.*, d.name FROM tg_links l JOIN drivers d ON d.id = l.driver_id WHERE l.code = $1 AND l.used_at IS NULL AND l.created_at > now() - interval '7 days'`, [code])).rows[0];
  if (!L) return send(m.chat.id, 'That link code is not valid (or already used). Make a new one on the driver\'s page on the website.', { replyTo: m.message_id });
  // one group per driver and kind: an older one is let go
  await q(`UPDATE tg_chats SET kind = NULL, driver_id = NULL WHERE driver_id = $1 AND kind = $2 AND chat_id <> $3`, [L.driver_id, L.kind, m.chat.id]);
  await q(`UPDATE tg_chats SET kind = $2, driver_id = $3, linked_by = $4, linked_at = now(), active = true WHERE chat_id = $1`, [m.chat.id, L.kind, L.driver_id, L.user_id]);
  await q(`UPDATE tg_links SET used_at = now() WHERE code = $1`, [code]);
  await q(`UPDATE tg_people SET role = coalesce(role, 'staff'), user_id = coalesce(user_id, $2) WHERE tg_id = $1`, [who.tg_id, L.user_id]);
  const step = { eld: 'eld_group', accounting: 'acct_group' }[L.kind];
  if (step) await q(`UPDATE checklist SET done = true, done_at = coalesce(done_at, now()), done_by = coalesce(done_by, $3) WHERE driver_id = $1 AND key = $2 AND NOT done`, [L.driver_id, step, L.user_id]);
  await q(`UPDATE drivers SET updated_at = now() WHERE id = $1`, [L.driver_id]);
  await send(m.chat.id, `✅ This is now the <b>${KINDS[L.kind]}</b> group for <b>${esc(L.name)}</b>.${state.me && !(await isAdmin(m.chat.id)) ? '\n\nPlease make me an admin of this group, so I can read every message (Group settings → Administrators → Add admin).' : ''}`);
  if (L.kind === 'eld' && handlers.eld) await handlers.eld.begin(m.chat.id, L.driver_id);
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
    try { if (chat && chat.kind === 'eld' && handlers.eld && /^eld:/.test(cq.data)) answer = (await handlers.eld.onButton(chat, cq, who)) || ''; }
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
    if (/^\/start/.test(m.text || '')) await send(m.chat.id, 'Hi! I work in the driver groups. Add me to a group and send the link code from the website there.');
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
  if (cmd && (cmd[1] === 'status' || cmd[1] === 'help')) {
    if (chat.kind === 'eld' && handlers.eld) return handlers.eld.status(chat);
    return send(chat.chat_id, chat.kind ? `This is the ${KINDS[chat.kind]} group.` : 'This group is not linked to a driver yet. Send the link code from the driver\'s page on the website, like /link 482913.');
  }
  if (chat.kind === 'eld' && handlers.eld && who && !u.edited_message) await handlers.eld.onMessage(chat, m, who);
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
  loop();
}
module.exports = { start, call, send, edit, dropButtons, download, noteMedia, tag, esc, redact, state, handlers, handle, KINDS, on: () => !!TOKEN() };
