// Each active driver's week in money, Sunday to Saturday, written from what was said in his Telegram groups: what the
// truck cost (repairs, tires, tow, fuel, tolls…) and every other money case (advances, deductions, fines, claims, pay
// questions). The loads are left out. Every week is kept, so any earlier week can be opened on the driver's page.
// A finished week is written by itself on Sunday; the running week on demand from the driver's page.
const db = require('../db');
const ai = require('./ai');
const bot = require('./bot');
const { q } = db;

const plus = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sunday = (day) => plus(day, -new Date(day + 'T12:00:00Z').getUTCDay()); // the Sunday that starts the week of this day
const today = async () => (await q(`SELECT (now() AT TIME ZONE $1)::date::text d`, [db.settings.tz])).rows[0].d;
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const view = (r) => ({ week: r.week, to: plus(r.week, 6), summary: r.summary, items: r.items || [], open: r.open || [], total: r.total === null ? 0 : +r.total, messages: r.messages, at: r.created_at });

async function buildWeek(driverId, day) {
  const tz = db.settings.tz; const week = sunday(day); const end = plus(week, 7);
  const d = (await q(`SELECT id, name FROM drivers WHERE id = $1`, [driverId])).rows[0]; if (!d) return null;
  const msgs = (await q(`SELECT m.text, m.media, m.media_note, m.is_bot, m.from_name, to_char(m.at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI') hm, p.role, c.kind
    FROM tg_messages m JOIN tg_chats c ON c.chat_id = m.chat_id LEFT JOIN tg_people p ON p.tg_id = m.from_id
    WHERE c.driver_id = $1 AND (m.at AT TIME ZONE $4)::date >= $2::date AND (m.at AT TIME ZONE $4)::date < $3::date ORDER BY m.at`, [driverId, week, end, tz])).rows;
  if (!msgs.length) return null;
  const lines = msgs.map((m) => `[${m.hm}] (${bot.KINDS[m.kind] || 'group'}) ${m.is_bot ? 'Bot' : m.from_name || 'Someone'}${m.role ? ` (${m.role})` : ''}: ${m.text || ''}${m.media ? ` [${m.media}${m.media_note ? ': ' + m.media_note : ''}]` : ''}`);
  if (!ai.on()) throw Object.assign(new Error('AI is off: add ANTHROPIC_API_KEY on Railway'), { status: 400 });
  const s = await ai.weekMoney({ driver: d.name, from: week, to: plus(week, 6), lines });
  const items = (Array.isArray(s.items) ? s.items : []).slice(0, 60).map((x) => ({
    day: isDay(x.day) && x.day >= week && x.day < end ? x.day : null, kind: ai.WEEK_KINDS.includes(x.kind) ? x.kind : 'other', what: bot.redact(String(x.what || '')).slice(0, 300),
    amount: typeof x.amount === 'number' && Number.isFinite(x.amount) && x.amount > 0 && x.amount < 1e6 ? Math.round(x.amount * 100) / 100 : null,
    paidBy: ['company', 'driver'].includes(x.paid_by) ? x.paid_by : 'unknown', status: ['settled', 'open'].includes(x.status) ? x.status : 'unknown' })).filter((x) => x.what);
  const open = (Array.isArray(s.open) ? s.open : []).slice(0, 12).map((x) => bot.redact(String(x)).slice(0, 300)).filter(Boolean);
  const total = Math.round(items.reduce((n, x) => n + (x.amount || 0), 0) * 100) / 100;
  await q(`INSERT INTO tg_weeks (driver_id, week, summary, items, open, total, messages) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (driver_id, week) DO UPDATE SET summary = $3, items = $4, open = $5, total = $6, messages = $7, created_at = now()`,
  [driverId, week, bot.redact(String(s.summary || '')).slice(0, 3000), JSON.stringify(items), JSON.stringify(open), total, msgs.length]);
  return view((await q(`SELECT week::text, summary, items, open, total, messages, created_at FROM tg_weeks WHERE driver_id = $1 AND week = $2`, [driverId, week])).rows[0]);
}

// The weeks to choose from on the driver's page: from his first message to this week, the newest first, with what is kept
async function weeks(driverId) {
  const now = sunday(await today());
  const kept = (await q(`SELECT week::text, summary, items, open, total, messages, created_at FROM tg_weeks WHERE driver_id = $1 ORDER BY week DESC LIMIT 104`, [driverId])).rows.map(view);
  const first = (await q(`SELECT min((m.at AT TIME ZONE $2)::date)::text d FROM tg_messages m JOIN tg_chats c ON c.chat_id = m.chat_id WHERE c.driver_id = $1`, [driverId, db.settings.tz])).rows[0].d;
  const by = new Map(kept.map((k) => [k.week, k])); const out = [];
  const from = [first ? sunday(first) : now, ...kept.map((k) => k.week)].sort()[0];
  for (let w = now; w >= from && out.length < 104; w = plus(w, -7)) out.push(by.get(w) || { week: w, to: plus(w, 6), none: true });
  return { weeks: out, now, ai: ai.on(), groups: !!first };
}

// Sunday on: the week that just ended is written for every active driver whose groups had messages in it (and written
// again if it was last made while the week was still running)
async function tick() {
  if (!ai.on()) return;
  const tz = db.settings.tz; const end = sunday(await today()); const week = plus(end, -7);
  const had = (await q(`SELECT DISTINCT c.driver_id FROM tg_messages m JOIN tg_chats c ON c.chat_id = m.chat_id JOIN drivers d ON d.id = c.driver_id
    WHERE d.status = 'Hired' AND d.left_on IS NULL AND (m.at AT TIME ZONE $3)::date >= $1::date AND (m.at AT TIME ZONE $3)::date < $2::date`, [week, end, tz])).rows.map((r) => r.driver_id);
  if (!had.length) return;
  const done = new Set((await q(`SELECT driver_id FROM tg_weeks WHERE week = $1::date AND (created_at AT TIME ZONE $3)::date >= $2::date`, [week, end, tz])).rows.map((r) => r.driver_id));
  let n = 0;
  for (const id of had) { if (done.has(id)) continue; if (++n > 5) break; await buildWeek(id, week).catch((e) => console.error('tg week', id, e.message)); } // a few each round, the rest in the next
}
function start() { setInterval(() => tick().catch((e) => console.error('week tick', e.message)), +process.env.TG_WEEK_MS || 10 * 60000); }
module.exports = { buildWeek, weeks, tick, start, sunday, plus };
