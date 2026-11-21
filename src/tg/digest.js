// The bot reads every message in the drivers' groups (dispatch, ELD, accounting), a few minutes after a
// conversation settles, with the pictures. From each batch it keeps:
//   truck issues and service   -> the truck's history on the Trucks page (and marks fixed ones)
//   notes about the driver     -> the driver's profile for dispatchers (rebuilt from them)
//   alerts                     -> the Telegram manager; important ones notify the admins and the recruiter.
//                                 A container or location that does not match: the bot asks the driver right away.
//                                 An appointment change: the bot confirms it in the group.
const db = require('../db');
const bot = require('./bot');
const ai = require('./ai');
const { q } = db;
const { send, esc, tag } = bot;

const SETTLE_MIN = process.env.TG_DIGEST_SETTLE_MIN ? +process.env.TG_DIGEST_SETTLE_MIN : 2;  // wait this long after the last message
const BATCH = 60;
const ROLE = { driver: 'driver', eld: 'ELD team', accounting: 'accounting', dispatch: 'dispatcher', staff: 'our team' };

async function tellTeam(driverId, chatId, text, ownerToo = true) {
  const d = (await q(`SELECT owner_id FROM drivers WHERE id = $1`, [driverId])).rows[0];
  const to = new Set((await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id)); if (ownerToo && d && d.owner_id) to.add(d.owner_id);
  for (const id of to) await db.notify(db.pool, id, 'tg', text, '#/telegram/' + chatId, { driverId });
}
async function digestChat(chatId) {
  const chat = (await q(`SELECT c.*, d.name driver, t.id truck_id, t.unit FROM tg_chats c LEFT JOIN drivers d ON d.id = c.driver_id LEFT JOIN trucks t ON t.driver_id = c.driver_id WHERE c.chat_id = $1`, [chatId])).rows[0];
  const fresh = (await q(`SELECT m.*, p.role, to_char(m.at AT TIME ZONE $2, 'Mon DD HH24:MI') hm FROM tg_messages m LEFT JOIN tg_people p ON p.tg_id = m.from_id WHERE m.chat_id = $1 AND NOT m.digested ORDER BY m.at LIMIT ${BATCH}`, [chatId, db.settings.tz])).rows;
  if (!fresh.length) return null;
  const done = () => q(`UPDATE tg_messages SET digested = true WHERE chat_id = $1 AND id = ANY($2::bigint[])`, [chatId, fresh.map((m) => m.id)]);
  if (!chat || !chat.driver_id || !chat.kind || !ai.on()) { await done(); return null; }
  const before = (await q(`SELECT m.*, p.role, to_char(m.at AT TIME ZONE $3, 'Mon DD HH24:MI') hm FROM tg_messages m LEFT JOIN tg_people p ON p.tg_id = m.from_id WHERE m.chat_id = $1 AND m.at < $2 ORDER BY m.at DESC LIMIT 20`, [chatId, fresh[0].at, db.settings.tz])).rows.reverse();
  const line = (m) => `[${m.hm}] ${m.is_bot ? 'Bot' : `${m.from_name || 'Someone'} (${ROLE[m.role] || 'unknown'})`}: ${m.text || ''}${m.media ? ` [${m.media}${m.media_note ? ': ' + m.media_note : ''}]` : ''}`;
  // the pictures in the new messages (a few), so numbers can be checked
  const images = [];
  for (const m of fresh.filter((x) => x.file_id && !x.is_bot).slice(-4)) {
    try { const buf = await bot.download(m.file_id, 5 * 1024 * 1024); images.push({ data: buf.toString('base64'), mime: m.media === 'pdf' ? 'application/pdf' : 'image/jpeg' }); } catch (e) { /* too big or gone */ }
  }
  const openIssues = chat.truck_id ? (await q(`SELECT id, title FROM truck_events WHERE truck_id = $1 AND status <> 'fixed' ORDER BY at DESC LIMIT 20`, [chat.truck_id])).rows : [];
  let r;
  try { r = await ai.digest({ kind: bot.KINDS[chat.kind], driver: chat.driver, truck: chat.unit, openIssues, context: before.map(line), fresh: fresh.map(line), images }); }
  catch (e) { console.error('tg digest', e.message); if (/400|invalid/i.test(e.message)) await done(); return null; } // a bad batch is skipped; a network error is tried again
  await done();
  const out = { truck: 0, notes: 0, alerts: 0 };
  // truck issues
  for (const ev of r.truck_events || []) {
    if (!chat.truck_id && !ev.title) continue;
    await q(`INSERT INTO truck_events (truck_id, driver_id, chat_id, kind, title, details, status, odometer, cost, shop, fixed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $7 = 'fixed' THEN now() END)`,
      [chat.truck_id || null, chat.driver_id, chatId, ev.kind || 'other', String(ev.title).slice(0, 120), ev.details ? bot.redact(String(ev.details)).slice(0, 800) : null, ['open', 'scheduled', 'fixed'].includes(ev.status) ? ev.status : 'open',
        Number.isInteger(ev.odometer) ? ev.odometer : null, typeof ev.cost === 'number' ? ev.cost : null, ev.shop ? String(ev.shop).slice(0, 120) : null]);
    out.truck++;
    if (['breakdown', 'damage', 'warning_light'].includes(ev.kind) && ev.status !== 'fixed') await tellTeam(chat.driver_id, chatId, `Truck ${chat.unit || '(no truck set)'} of ${chat.driver}: ${ev.title}${ev.details ? ' (' + String(ev.details).slice(0, 120) + ')' : ''}`);
  }
  if ((r.fixed_issue_ids || []).length && chat.truck_id) await q(`UPDATE truck_events SET status = 'fixed', fixed_at = now() WHERE truck_id = $1 AND id = ANY($2::int[]) AND status <> 'fixed'`, [chat.truck_id, r.fixed_issue_ids.map(Number).filter(Boolean)]);
  // notes about the driver
  for (const n of r.driver_notes || []) {
    if (!n.text) continue;
    await q(`INSERT INTO driver_notes (driver_id, chat_id, kind, text) VALUES ($1, $2, $3, $4)`, [chat.driver_id, chatId, n.kind || 'other', bot.redact(String(n.text)).slice(0, 500)]);
    out.notes++;
  }
  // alerts
  for (const a of r.alerts || []) {
    if (!a.text) continue;
    const text = bot.redact(String(a.text)).slice(0, 500);
    await q(`INSERT INTO tg_alerts (chat_id, driver_id, kind, severity, text) VALUES ($1, $2, $3, $4, $5)`, [chatId, chat.driver_id, a.kind || 'other', a.severity === 'high' ? 'high' : 'low', text]);
    out.alerts++;
    const driver = (await q(`SELECT * FROM tg_people WHERE role = 'driver' AND driver_id = $1 ORDER BY seen_at DESC LIMIT 1`, [chat.driver_id])).rows[0];
    if (['container_mismatch', 'wrong_location'].includes(a.kind) && a.ask_driver) await send(chatId, `🔎 ${driver ? tag(driver) : `<b>${esc(chat.driver.split(/\s+/)[0])}</b>`}, ${esc(a.ask_driver)}`).catch(() => {});
    else if (a.kind === 'appointment_change' && chat.kind === 'dispatch') await send(chatId, `📌 Noted: ${esc(text)}`).catch(() => {});
    if (a.kind === 'unprofessional_dispatcher') await tellTeam(chat.driver_id, chatId, `Dispatcher conduct in ${chat.driver}'s group: ${text}`, false); // admins only
    else if (a.severity === 'high' || ['driver_upset', 'safety', 'container_mismatch', 'wrong_location'].includes(a.kind)) await tellTeam(chat.driver_id, chatId, `${chat.driver}: ${text}`);
  }
  return out;
}
async function tick() {
  if (!bot.state.me) return;
  const due = (await q(`SELECT chat_id FROM tg_messages WHERE NOT digested GROUP BY chat_id HAVING max(at) < now() - ($1 || ' minutes')::interval OR count(*) >= 40`, [String(SETTLE_MIN)])).rows;
  for (const d of due) await digestChat(d.chat_id).catch((e) => console.error('tg digest', e.message));
}
function start() { setInterval(() => tick().catch((e) => console.error('digest tick', e.message)), +process.env.TG_DIGEST_MS || 5 * 60000); }
module.exports = { start, tick, digestChat };
