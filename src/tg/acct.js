// Accounting group: the bot answers the driver's pay and settlement questions from the company facts and what
// accounting taught it; when it is not sure it tags the accounting person (role "Accounting"), and learns the answer.
const db = require('../db');
const bot = require('./bot');
const ai = require('./ai');
const onb = require('./onboard');
const { q } = db;
const { send, esc, tag } = bot;

const ROLE = 'You are the accounting assistant of a US trucking company, in a Telegram group with one driver and the accounting team. You answer questions about pay, settlements, deductions, escrow, fuel cards, tolls and paperwork.';
async function ctxOf(driverId, chatId) {
  return (await q(`SELECT d.id driver_id, $2::bigint chat_id, d.name, d.mode, d.owner_id, d.status, co.name company FROM drivers d LEFT JOIN companies co ON co.id = d.company_id WHERE d.id = $1`, [driverId, chatId])).rows[0];
}
async function accountingTag(chatId) {
  const p = (await q(`SELECT p.* FROM tg_people p JOIN tg_members m ON m.tg_id = p.tg_id AND m.chat_id = $1 WHERE p.role = 'accounting' ORDER BY p.seen_at DESC`, [chatId])).rows;
  if (p.length) return p.map(tag).join(' ');
  const s = (await q(`SELECT p.* FROM tg_people p JOIN tg_members m ON m.tg_id = p.tg_id AND m.chat_id = $1 WHERE p.role = 'staff' OR p.user_id IS NOT NULL ORDER BY p.seen_at DESC LIMIT 1`, [chatId])).rows[0];
  return s ? tag(s) : 'accounting';
}
async function begin(chatId, driverId) {
  const c = await ctxOf(driverId, chatId);
  await send(chatId, `👋 This is the <b>accounting</b> group for <b>${esc(c.name)}</b>. Ask here about pay, settlements and deductions. I answer what I can, and get accounting for the rest.\n\nAccounting team: please tap below so I know whom to ask.`, { buttons: [[['🧾 I am with accounting', `acc:${driverId}:iam`]]] });
}
async function onButton(chat, cq, who) {
  const [, , act] = cq.data.split(':');
  if (act === 'iam') {
    if (who.role === 'driver') return 'You are the driver here.';
    await q(`UPDATE tg_people SET role = 'accounting' WHERE tg_id = $1 AND (role IS NULL OR role IN ('accounting', 'eld', 'dispatch'))`, [who.tg_id]);
    return `Thanks ${who.name}, you are with accounting ✓`;
  }
  return '';
}
async function onMessage(chat, m, who) {
  const text = (m.text || m.caption || '').trim();
  if (bot.isStaff(who) || who.role === 'accounting') return onb.learnFrom(chat, m, who, text);
  if (who.role && who.role !== 'driver') return;
  const c = await ctxOf(chat.driver_id, chat.chat_id); if (!c) return;
  if (!who.role && who.name.split(/\s+/)[0].toLowerCase() === c.name.split(/\s+/)[0].toLowerCase()) await q(`UPDATE tg_people SET role = 'driver', driver_id = $2 WHERE tg_id = $1 AND role IS NULL AND NOT EXISTS (SELECT 1 FROM tg_not_driver n WHERE n.tg_id = $1 AND n.driver_id = $2)`, [who.tg_id, c.driver_id]);
  if (!text || !ai.on()) return;
  return onb.qa(c, chat, m, who, text, { context: `Name: ${c.name}. ${c.mode === 'Owner-operators' ? 'Owner-operator' : 'Company driver'}.${c.company ? ` Company: ${c.company}.` : ''}`, escalate: () => accountingTag(chat.chat_id), kinds: ['accounting', 'general'], role: ROLE });
}
async function status(chat) { const c = await ctxOf(chat.driver_id, chat.chat_id); if (c) await send(chat.chat_id, `This is the accounting group for <b>${esc(c.name)}</b>.`); }
bot.handlers.accounting = { begin, onButton, onMessage, status };
module.exports = { begin };
