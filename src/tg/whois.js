// Which Telegram account is the driver's. The people in a driver's groups who are not on our team
// (not a website user, not marked team, dispatcher, ELD or accounting) are the candidates; someone set on the
// website as "not the driver" of this driver is never linked to them again by the bot's own guesses.
const { q } = require('../db');

const TEAM_GROUPS = 5; // a driver is in one to three groups; someone in this many is almost surely our team

// For each driver id: { linked: [person], people: [person] }, people sorted: linked first, then who wrote most recently.
async function candidates(driverIds) {
  const ids = [...new Set(driverIds.map(Number).filter(Boolean))]; const out = {};
  for (const id of ids) out[id] = { linked: [], people: [] };
  if (!ids.length) return out;
  const chats = (await q(`SELECT chat_id, driver_id FROM tg_chats WHERE driver_id = ANY($1::int[]) AND active`, [ids])).rows;
  if (!chats.length) return out;
  const chatIds = chats.map((c) => String(c.chat_id)); const driverOf = Object.fromEntries(chats.map((c) => [String(c.chat_id), c.driver_id]));
  const members = (await q(`SELECT chat_id, tg_id FROM tg_members WHERE chat_id = ANY($1::bigint[])`, [chatIds])).rows;
  const wrote = (await q(`SELECT DISTINCT ON (chat_id, from_id) chat_id, from_id, text, media, at, is_bot FROM tg_messages WHERE chat_id = ANY($1::bigint[]) AND from_id IS NOT NULL ORDER BY chat_id, from_id, at DESC`, [chatIds])).rows;
  const counts = (await q(`SELECT chat_id, from_id, count(*)::int n FROM tg_messages WHERE chat_id = ANY($1::bigint[]) AND from_id IS NOT NULL GROUP BY chat_id, from_id`, [chatIds])).rows;
  const bots = new Set(wrote.filter((w) => w.is_bot).map((w) => String(w.from_id)));
  // driver id -> tg id -> { last, n }
  const seen = {};
  const at = (chat, tg) => { const d = driverOf[String(chat)]; seen[d] = seen[d] || {}; return (seen[d][String(tg)] = seen[d][String(tg)] || { last: null, n: 0 }); };
  for (const m of members) at(m.chat_id, m.tg_id);
  for (const w of wrote) { const s = at(w.chat_id, w.from_id); if (!s.last || new Date(w.at) > new Date(s.last.at)) s.last = w; }
  for (const c of counts) at(c.chat_id, c.from_id).n += c.n;
  const tgIds = [...new Set(Object.values(seen).flatMap((x) => Object.keys(x)))].filter((t) => !bots.has(t));
  if (!tgIds.length) return out;
  const tgNums = tgIds.map(Number);
  const people = (await q(`SELECT tg_id::text tg_id, name, username, role, driver_id, user_id, team_dismissed_at FROM tg_people WHERE tg_id::text = ANY($1::text[])`, [tgIds])).rows;
  const otherIds = [...new Set(people.map((p) => p.driver_id).filter(Boolean))];
  const dn = otherIds.length ? Object.fromEntries((await q(`SELECT id, name FROM drivers WHERE id = ANY($1::int[])`, [otherIds])).rows.map((x) => [x.id, x.name])) : {};
  for (const p of people) p.driver_name = dn[p.driver_id] || null;
  const groupsOf = Object.fromEntries((await q(`SELECT tg_id::text tg_id, count(*)::int n FROM tg_members WHERE tg_id = ANY($1::bigint[]) GROUP BY tg_id`, [tgNums])).rows.map((x) => [x.tg_id, x.n]));
  for (const p of people) p.groups = groupsOf[p.tg_id] || 0;
  const nots = new Set((await q(`SELECT driver_id, tg_id::text tg_id FROM tg_not_driver WHERE driver_id = ANY($1::int[])`, [ids])).rows.map((x) => x.driver_id + ':' + x.tg_id));
  for (const p of people) {
    if (p.user_id || (p.role && p.role !== 'driver')) continue; // our team, dispatchers, ELD, accounting
    for (const d of ids) {
      const s = seen[d] && seen[d][p.tg_id]; if (!s) continue;
      const last = s.last ? { text: s.last.text || (s.last.media ? '[' + s.last.media + ']' : ''), at: s.last.at } : null;
      const x = { tgId: p.tg_id, name: p.name || 'No name', username: p.username || null, linked: p.role === 'driver' && p.driver_id === d,
        otherDriver: p.role === 'driver' && p.driver_id !== d ? { id: p.driver_id, name: p.driver_name } : null, notDriver: nots.has(d + ':' + p.tg_id),
        groups: p.groups, likelyTeam: p.groups >= TEAM_GROUPS && !p.team_dismissed_at, messages: s.n, last };
      out[d].people.push(x); if (x.linked) out[d].linked.push(x);
    }
  }
  for (const d of ids) out[d].people.sort((a, b) => (b.linked - a.linked) || (a.likelyTeam - b.likelyTeam) || (a.notDriver - b.notDriver) || (new Date(b.last ? b.last.at : 0) - new Date(a.last ? a.last.at : 0)));
  return out;
}

// "Who is the driver?" is asked only when nobody is linked, about people who wrote and were not ruled out.
function toAsk(c) {
  if (!c || c.linked.length) return [];
  return c.people.filter((p) => p.messages && !p.notDriver && !p.otherDriver && !p.likelyTeam).slice(0, 3);
}

// The website's answer. 'driver': this account is the driver's (anyone else linked to this driver is unlinked and
// ruled out). 'not': this account is not the driver's.
async function answer(driverId, tgId, is) {
  tgId = String(tgId);
  if (is === 'driver') {
    const before = (await q(`SELECT tg_id::text tg_id FROM tg_people WHERE role = 'driver' AND driver_id = $1 AND tg_id <> $2`, [driverId, tgId])).rows;
    for (const b of before) await q(`INSERT INTO tg_not_driver (driver_id, tg_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [driverId, b.tg_id]);
    await q(`UPDATE tg_people SET role = NULL, driver_id = NULL WHERE role = 'driver' AND driver_id = $1 AND tg_id <> $2`, [driverId, tgId]);
    await q(`UPDATE tg_people SET role = 'driver', driver_id = $2 WHERE tg_id = $1`, [tgId, driverId]);
    await q(`DELETE FROM tg_not_driver WHERE driver_id = $1 AND tg_id = $2`, [driverId, tgId]);
    return before.length;
  }
  await q(`INSERT INTO tg_not_driver (driver_id, tg_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [driverId, tgId]);
  await q(`UPDATE tg_people SET role = NULL, driver_id = NULL WHERE tg_id = $1 AND role = 'driver' AND driver_id = $2`, [tgId, driverId]);
  return 0;
}

const ruledOut = async (driverId, tgId) => !!(await q(`SELECT 1 FROM tg_not_driver WHERE driver_id = $1 AND tg_id = $2`, [driverId, String(tgId)])).rows[0];

// People the bot has not placed who are in many groups: probably our team (People tab, for an admin to confirm)
async function likelyTeam() {
  return (await q(`SELECT p.tg_id::text tg_id, p.name, p.username, p.role, d.name driver, x.groups FROM tg_people p
    JOIN (SELECT tg_id, count(*)::int groups FROM tg_members GROUP BY tg_id) x ON x.tg_id = p.tg_id LEFT JOIN drivers d ON d.id = p.driver_id
    WHERE p.user_id IS NULL AND (p.role IS NULL OR p.role = 'driver') AND p.team_dismissed_at IS NULL AND x.groups >= $1 ORDER BY x.groups DESC LIMIT 30`, [TEAM_GROUPS])).rows;
}

module.exports = { candidates, toAsk, answer, ruledOut, likelyTeam, TEAM_GROUPS };
