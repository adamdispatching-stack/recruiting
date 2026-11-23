// Home time: the AI follows it in the driver's group (he is going home on a date, he is home, he comes back on a date,
// he is back on the road). Two days before he comes back the bot asks him to confirm and whether he needs a ticket
// (Watch: the message waits on the website; Updater: the bot sends it) and tells his recruiter and his dispatcher.
// The day after he was due back and nothing says he is back, they are told again. Back on the road: his days on the
// road start again (Active drivers).
const db = require('./db');
const { q } = db;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const nice = (d) => new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// from the AI: { event: going_home | at_home | coming_back | back_on_road | cancelled, leave_on, back_on, needs_ticket, quote }
async function fromGroup(chat, h) {
  if (!h || !h.event || !chat.driver_id) return;
  const bot = require('./tg/bot'); const lib = require('./lib');
  let cur = (await q(`SELECT * FROM home_time WHERE driver_id = $1 AND status IN ('planned', 'home') ORDER BY id DESC LIMIT 1`, [chat.driver_id])).rows[0];
  const leave = isDate(h.leave_on) ? h.leave_on : null, back = isDate(h.back_on) ? h.back_on : null;
  const note = h.quote ? bot.redact(String(h.quote)).slice(0, 300) : null;
  if (h.event === 'back_on_road') {
    if (cur) await q(`UPDATE home_time SET status = 'back', back_on = coalesce(back_on, (now() AT TIME ZONE $2)::date), updated_at = now() WHERE id = $1`, [cur.id, db.settings.tz]);
    await q(`UPDATE drivers SET out_since = (now() AT TIME ZONE $2)::date, updated_at = now() WHERE id = $1`, [chat.driver_id, db.settings.tz]);
    await lib.history(chat.driver_id, 'Back on the road after home time (from the Telegram group)', 'AI', 'telegram').catch(() => {});
    return bot.log('fact', 'Back on the road after home time: his days on the road start again', { chatId: chat.chat_id, driverId: chat.driver_id });
  }
  if (h.event === 'cancelled') { if (cur) await q(`UPDATE home_time SET status = 'cancelled', updated_at = now() WHERE id = $1`, [cur.id]); return bot.log('fact', 'Home time called off', { chatId: chat.chat_id, driverId: chat.driver_id }); }
  const status = h.event === 'at_home' ? 'home' : cur ? cur.status : 'planned';
  if (!cur) cur = (await q(`INSERT INTO home_time (driver_id, status, leave_on, back_on, needs_ticket, note, chat_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [chat.driver_id, status, leave, back, h.needs_ticket === true ? true : null, note, chat.chat_id])).rows[0];
  else {
    // a new return date: asked again 2 days before it
    const moved = back && cur.back_on && String(cur.back_on.toISOString ? cur.back_on.toISOString().slice(0, 10) : cur.back_on) !== back;
    await q(`UPDATE home_time SET status = $2, leave_on = coalesce($3, leave_on), back_on = coalesce($4, back_on), needs_ticket = coalesce($5, needs_ticket), note = coalesce($6, note), updated_at = now(),
      confirm_asked_at = CASE WHEN $7 THEN NULL ELSE confirm_asked_at END, confirmed_at = CASE WHEN $7 THEN NULL ELSE confirmed_at END, late_told_at = CASE WHEN $7 THEN NULL ELSE late_told_at END WHERE id = $1`,
      [cur.id, status, leave, back, typeof h.needs_ticket === 'boolean' ? h.needs_ticket : null, note, !!moved]);
  }
  // he answered the question 2 days before: confirmed
  if (h.event === 'coming_back' && cur.confirm_asked_at && !cur.confirmed_at) await q(`UPDATE home_time SET confirmed_at = now() WHERE id = $1`, [cur.id]);
  const what = h.event === 'going_home' ? `Going home${leave ? ' ' + nice(leave) : ''}` : h.event === 'at_home' ? 'At home' : 'Coming back';
  await lib.history(chat.driver_id, `Home time: ${what}${back ? `, back ${nice(back)}` : ''}${h.needs_ticket ? ', needs a ticket' : ''} (from the Telegram group)`, 'AI', 'telegram').catch(() => {});
  await bot.log('fact', `Home time: ${what}${back ? `, back ${nice(back)}` : ''}${h.needs_ticket ? ', needs a ticket' : ''}`, { chatId: chat.chat_id, driverId: chat.driver_id });
}

async function team(driverId) {
  const d = (await q(`SELECT d.name, d.owner_id, (SELECT dispatcher_id FROM trucks WHERE driver_id = d.id AND dispatcher_id IS NOT NULL LIMIT 1) disp FROM drivers d WHERE d.id = $1`, [driverId])).rows[0];
  const admins = (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id);
  return { d, to: [...new Set([d.owner_id, d.disp].filter(Boolean))].length ? [...new Set([d.owner_id, d.disp].filter(Boolean))] : admins };
}
async function tick() {
  const tz = db.settings.tz; const bot = require('./tg/bot');
  if (bot.paused()) return; // paused everywhere
  const L = (await q(`SELECT (now() AT TIME ZONE $1)::date::text d, extract(hour FROM now() AT TIME ZONE $1)::int h`, [tz])).rows[0];
  if (!process.env.TG_NO_QUIET && (L.h < 9 || L.h >= 20)) return; // daytime only
  // 2 days before he comes back: confirm, ticket?
  const soon = (await q(`SELECT h.*, h.back_on::text back FROM home_time h WHERE h.status IN ('planned', 'home') AND h.back_on IS NOT NULL AND h.confirm_asked_at IS NULL AND h.back_on - $1::date BETWEEN 0 AND 2`, [L.d])).rows;
  for (const h of soon) {
    const { d, to } = await team(h.driver_id); const f = d.name.split(/\s+/)[0];
    const chat = (await q(`SELECT chat_id, mode FROM tg_chats WHERE driver_id = $1 AND kind = 'dispatch' AND active ORDER BY last_at DESC NULLS LAST LIMIT 1`, [h.driver_id])).rows[0];
    const text = `Hi ${f}! You are coming back on ${nice(h.back)}, right? Do you need a bus or plane ticket? If yes, send the city you leave from and what time suits you.`;
    if (chat) {
      if (chat.mode === 'updater') await bot.send(chat.chat_id, bot.esc(text)).catch(() => {});
      else { await q(`UPDATE tg_drafts SET state = 'replaced', decided_at = now() WHERE chat_id = $1 AND state = 'open' AND kind = 'remind'`, [chat.chat_id]);
        await q(`INSERT INTO tg_drafts (chat_id, driver_id, driver_text, draft, kind) VALUES ($1, $2, $3, $4, 'remind')`, [chat.chat_id, h.driver_id, 'Home time: confirm he comes back', text]); }
    }
    await q(`UPDATE home_time SET confirm_asked_at = now() WHERE id = $1`, [h.id]);
    for (const id of to) await db.notify(db.pool, id, 'home', `${d.name} comes back ${nice(h.back)}: confirm with him${h.needs_ticket ? ' and book his ticket' : ', and book a ticket if he needs one'}.`, `#/active/${h.driver_id}`, { driverId: h.driver_id });
    await bot.log('remind', `Home time: ${d.name} comes back ${nice(h.back)}; ${chat && chat.mode === 'updater' ? 'asked him' : 'the question waits on the website'}, the recruiter is told`, { chatId: chat ? chat.chat_id : null, driverId: h.driver_id });
  }
  // due back yesterday, nothing says he is back
  const late = (await q(`SELECT h.*, h.back_on::text back FROM home_time h WHERE h.status IN ('planned', 'home') AND h.back_on < $1::date AND h.late_told_at IS NULL`, [L.d])).rows;
  for (const h of late) {
    const { d, to } = await team(h.driver_id);
    await q(`UPDATE home_time SET late_told_at = now() WHERE id = $1`, [h.id]);
    for (const id of to) await db.notify(db.pool, id, 'home', `${d.name} was due back ${nice(h.back)} and nothing says he is back on the road. Check with him.`, `#/active/${h.driver_id}`, { driverId: h.driver_id });
  }
}
// the planner: who is home, who comes back and when, who is due to go home (his weeks out are up)
async function planner() {
  const tz = db.settings.tz;
  const now = (await q(`SELECT h.id, h.driver_id, d.name, h.status, h.leave_on::text leave_on, h.back_on::text back_on, h.needs_ticket, h.confirm_asked_at, h.confirmed_at, h.note,
      (SELECT unit FROM trucks WHERE driver_id = h.driver_id LIMIT 1) truck, u.name recruiter
    FROM home_time h JOIN drivers d ON d.id = h.driver_id LEFT JOIN users u ON u.id = d.owner_id WHERE h.status IN ('planned', 'home') ORDER BY coalesce(h.back_on, h.leave_on) NULLS LAST`)).rows;
  const due = (await q(`SELECT d.id driver_id, d.name, d.out_since::text out_since, d.weeks_out, (d.out_since + (d.weeks_out * 7)::int)::text home_by, ((d.out_since + (d.weeks_out * 7)::int) - (now() AT TIME ZONE $1)::date) days_left
    FROM drivers d WHERE d.status = 'Hired' AND d.left_on IS NULL AND d.out_since IS NOT NULL AND d.weeks_out IS NOT NULL AND NOT EXISTS (SELECT 1 FROM home_time h WHERE h.driver_id = d.id AND h.status IN ('planned', 'home'))
      AND (d.out_since + (d.weeks_out * 7)::int) - (now() AT TIME ZONE $1)::date <= 14 ORDER BY 5`, [tz])).rows;
  return { now, due };
}
module.exports = { fromGroup, tick, planner, nice };
