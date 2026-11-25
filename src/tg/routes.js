// Where each kind of team message goes (Telegram → All groups → "Where the team's messages go").
// Set by an admin on the website, never guessed: a chat picked here is used for that kind of message and nothing
// else decides it. A driver's group can never be picked, and a route that later becomes one is ignored.
const db = require('../db');
const q = (...a) => db.pool.query(...a);

const KINDS = [
  { key: 'recruiting', label: 'Recruiting alerts', hint: 'From the Indeed extension: job rotation, "verify you are human", email collected, a driver needs you, the AI coach review. Not set: the private chat of the admin with the bot (the management group if the admin has not connected Telegram).', priv: true },
  { key: 'team', label: 'Morning report and onboarding list', hint: 'The daily team report and the onboarding follow-ups. Not set: every management group gets them.', priv: false },
  { key: 'followups', label: 'Driver journey reminders for the team', hint: 'What is still owed for a driver (papers, ELD, first load). Not set: the first management group.', priv: false },
];
const TEAM_KINDS = ['management', 'shift'];
const all = () => ({ ...((db.settings.tg || {}).routes || {}) });

// may this chat receive team messages? a private chat, or a group that belongs to no driver
async function allowed(chatId, { priv = true } = {}) {
  if (!/^-?\d+$/.test(String(chatId || ''))) return null;
  if (+chatId > 0) {
    if (!priv) return null;
    const p = (await q(`SELECT name FROM tg_people WHERE tg_id = $1`, [chatId])).rows[0];
    return { chatId: String(chatId), title: (p && p.name) || 'Private chat', priv: true };
  }
  const c = (await q(`SELECT title, kind, driver_id, active FROM tg_chats WHERE chat_id = $1`, [chatId])).rows[0];
  // only a group marked as the team's own: one nobody has connected yet may well be a driver's
  if (!c || !c.active || c.driver_id || !TEAM_KINDS.includes(c.kind)) return null;
  return { chatId: String(chatId), title: c.title || 'Group', kind: c.kind || null };
}
// the chat set for this kind of message, or null when none is set (or the one set is no longer usable)
async function chatOf(key) {
  const k = KINDS.find((x) => x.key === key); const id = all()[key];
  return k && id ? allowed(id, { priv: k.priv }) : null;
}
async function set(key, chatId) {
  const k = KINDS.find((x) => x.key === key); if (!k) return { error: 'Unknown kind of message' };
  const routes = all();
  if (!chatId) delete routes[key];
  else {
    const c = await allowed(chatId, { priv: k.priv });
    if (!c) return { error: +chatId < 0 ? 'Only a Management or Shift group can be picked (set its type in the list below first).' : 'Pick a group for this one' };
    routes[key] = c.chatId;
  }
  await db.saveSetting('tg', { ...db.settings.tg, routes });
  return { ok: true, routes };
}
module.exports = { KINDS, all, allowed, chatOf, set };
