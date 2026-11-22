// Leaving risk: signs a working driver may leave, so someone calls him before he does.
// From the groups (the AI): another offer, saying he will quit, pay complaints, home time, the truck, the dispatcher,
// family; plus his mood the last 7 days, an upset-driver alert, home time overdue, not back from home, and silence.
// A strong sign (another offer, quitting) tells his recruiter and the admins once in 3 days. "Talked to him" clears the signs.
const db = require('./db');
const { q } = db;
const KIND = { other_offer: 'another offer', quitting: 'says he will quit', pay: 'pay', home_time: 'home time', truck: 'the truck', dispatcher: 'the dispatcher', family: 'family', miles: 'miles / loads', other: 'other' };

async function fromGroup(chat, signs) {
  const bot = require('./tg/bot');
  for (const s of (signs || []).slice(0, 4)) {
    const quote = bot.redact(String(s.quote || '')).slice(0, 300); if (!quote || !chat.driver_id) continue;
    if ((await q(`SELECT 1 FROM tg_leaving WHERE driver_id = $1 AND quote = $2`, [chat.driver_id, quote])).rows[0]) continue;
    const kind = KIND[s.kind] ? s.kind : 'other', strength = s.strength === 'strong' ? 'strong' : 'weak';
    await q(`INSERT INTO tg_leaving (driver_id, chat_id, kind, strength, quote) VALUES ($1, $2, $3, $4, $5)`, [chat.driver_id, chat.chat_id, kind, strength, quote]);
    await bot.log('fact', `Leaving sign (${strength}, ${KIND[kind]}): "${quote.slice(0, 120)}"`, { chatId: chat.chat_id, driverId: chat.driver_id });
    if (strength === 'strong' && !(await q(`SELECT 1 FROM notices WHERE driver_id = $1 AND kind = 'leaving' AND created_at > now() - interval '3 days'`, [chat.driver_id])).rows[0]) {
      const d = (await q(`SELECT name, owner_id FROM drivers WHERE id = $1`, [chat.driver_id])).rows[0];
      const to = new Set([d.owner_id, ...(await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id)].filter(Boolean));
      for (const id of to) await db.notify(db.pool, id, 'leaving', `${d.name} may leave (${KIND[kind]}): "${quote.slice(0, 160)}". Worth a call today.`, `#/active/${chat.driver_id}`, { driverId: chat.driver_id });
    }
  }
}
// the risk for active drivers: { score 0-100, level high | medium | low, reasons [] }
async function risk(ids) {
  const out = {}; if (!ids.length) return out; const tz = db.settings.tz;
  const add = (id, pts, why) => { const r = out[id] = out[id] || { score: 0, reasons: [] }; r.score += pts; r.reasons.push(why); };
  const signs = (await q(`SELECT driver_id, kind, strength, quote, at FROM tg_leaving WHERE driver_id = ANY($1::int[]) AND dismissed_at IS NULL AND at > now() - interval '14 days' ORDER BY at DESC`, [ids])).rows;
  const per = {};
  for (const s of signs) { const n = per[s.driver_id] = per[s.driver_id] || { strong: 0, weak: 0 }; if (s.strength === 'strong' && n.strong < 2) { n.strong++; add(s.driver_id, 50, `${KIND[s.kind]}: "${s.quote.slice(0, 100)}"`); } else if (s.strength !== 'strong' && n.weak < 3) { n.weak++; add(s.driver_id, 15, `${KIND[s.kind]}: "${s.quote.slice(0, 100)}"`); } }
  const moods = (await q(`SELECT c.driver_id, count(*) FILTER (WHERE s.mood IN ('unhappy', 'angry'))::int bad FROM tg_summaries s JOIN tg_chats c ON c.chat_id = s.chat_id WHERE c.driver_id = ANY($1::int[]) AND s.day > (now() AT TIME ZONE $2)::date - 7 GROUP BY 1`, [ids, tz])).rows;
  for (const m of moods) if (m.bad) add(m.driver_id, Math.min(24, m.bad * 8), `unhappy ${m.bad} of the last 7 days`);
  const up = (await q(`SELECT driver_id, count(*)::int n FROM tg_alerts WHERE driver_id = ANY($1::int[]) AND kind = 'driver_upset' AND at > now() - interval '14 days' GROUP BY 1`, [ids])).rows;
  for (const a of up) add(a.driver_id, 15, 'upset in the group');
  const home = (await q(`SELECT id, (out_since + (weeks_out * 7)::int) - (now() AT TIME ZONE $2)::date left FROM drivers WHERE id = ANY($1::int[]) AND out_since IS NOT NULL AND weeks_out IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM home_time h WHERE h.driver_id = drivers.id AND h.status IN ('planned', 'home'))`, [ids, tz])).rows;
  for (const h of home) if (+h.left < -3) add(h.id, 15, `home time ${-h.left} days overdue`);
  const late = (await q(`SELECT driver_id FROM home_time WHERE driver_id = ANY($1::int[]) AND status IN ('planned', 'home') AND back_on < (now() AT TIME ZONE $2)::date - 1`, [ids, tz])).rows;
  for (const h of late) add(h.driver_id, 20, 'not back from home time');
  const quiet = (await q(`SELECT c.driver_id, max(m.at) last FROM tg_chats c JOIN tg_messages m ON m.chat_id = c.chat_id JOIN tg_people p ON p.tg_id = m.from_id AND p.role = 'driver' WHERE c.driver_id = ANY($1::int[]) AND c.kind = 'dispatch' GROUP BY 1`, [ids])).rows;
  for (const s of quiet) if (Date.now() - new Date(s.last) > 3 * 864e5) add(s.driver_id, 10, `silent ${Math.floor((Date.now() - new Date(s.last)) / 864e5)} days in his group`);
  for (const r of Object.values(out)) { r.score = Math.min(100, r.score); r.level = r.score >= 50 ? 'high' : r.score >= 25 ? 'medium' : 'low'; }
  return out;
}
async function dismiss(driverId, by) {
  await q(`UPDATE tg_leaving SET dismissed_at = now() WHERE driver_id = $1 AND dismissed_at IS NULL`, [driverId]);
  await require('./lib').history(driverId, 'Leaving signs talked through', by, 'web').catch(() => {});
}
module.exports = { fromGroup, risk, dismiss, KIND };
