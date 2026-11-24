// The shifts' daily routines, and the words our team uses.
// - Dispatch words: a glossary the AI reads with its instructions (cached), so "didn't catch", "post truck", "book it",
//   "time is not matching" or a * next to a name are read the way our team means them. Admins edit it (Shift desk).
// - Booking list: early in each shift the shift posts the loads to book, by hub (Chambersburg, Baltimore, Hazleton,
//   Kearny): a driver's name alone = he is ready (empty) there; with * = he is on a load and will finish near there
//   (pre-book from his delivery). The bot reads it (no AI), matches the names to our drivers and keeps it for the
//   website; when a shift has not posted it in time, the shift is reminded.
// - End-of-shift notes: before a shift ends, each driver's group should get an update note for the next shift. The AI
//   notices a dispatcher's update note while reading the groups; the shift is reminded which groups still need one
//   (with a suggested note per driver on the website), and after the shift the bot says who has one and who not.
const db = require('../db');
const { q } = db;

const TERMS = [
  ["didn't catch", 'We tried to book the load offered to the driver (on Amazon Relay) and did not get it, or could not book it. He still needs a load.'],
  ['post truck', 'Put the truck on Amazon Relay as available (Post truck) so loads are offered for it; done when the times do not match or nothing could be booked.'],
  ['book it', 'The driver accepts the load offered: the dispatcher books it.'],
  ['time is not matching', 'The load\'s pickup or delivery time does not fit the driver (his hours, where he is, his rest); the dispatcher looks for another load or posts the truck.'],
  ['* next to a name', 'In a booking list: the driver is on a load now and will finish near that location; pre-book his next load from his delivery location. A name without * = he is ready (empty) there now.'],
  ['ready', 'The driver is empty and can take a load now.'],
  ['deadhead', 'Driving empty to the next pickup.'],
  ['bobtail', 'Driving the tractor with no trailer.'],
  ['drop and hook', 'Drop the trailer and hook a loaded one, no waiting for loading.'],
  ['live load / live unload', 'The driver waits while the trailer is loaded or unloaded.'],
  ['TONU', 'Truck order not used: the load was cancelled after the truck was sent; a fee may be paid.'],
  ['lumper', 'A person paid to unload at the receiver.'],
  ['BOL / POD', 'Bill of lading (the shipping paper) / proof of delivery (the signed paper after delivery).'],
  ['block', 'Amazon Relay: a set of loads booked together for a period.']];
async function seed() { for (const [t, m] of TERMS) await q(`INSERT INTO tg_terms (term, meaning, source) VALUES ($1, $2, 'starter') ON CONFLICT (lower(term)) DO NOTHING`, [t, m]); }
async function forAi() {
  const ts = (await q(`SELECT term, meaning FROM tg_terms WHERE active ORDER BY id`)).rows; if (!ts.length) return '';
  return `\nWORDS OUR TEAM USES (read the messages with these meanings):\n${ts.map((t) => `- "${t.term}": ${t.meaning}`).join('\n')}`;
}

// ---------- the booking list ----------
const D = () => require('./desk');
const hubs = () => (D().cfg().hubs && D().cfg().hubs.length ? D().cfg().hubs : ['Chambersburg', 'Baltimore', 'Hazleton', 'Kearny']);
const norm = (s) => String(s || '').toLowerCase().replace(/kearney/g, 'kearny').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
// "Chambersburg: John*, Mike / Baltimore - Sam ..." → [{ hub, name, star }] (null when it is not a booking list)
function parseBoard(text) {
  const H = hubs(); const out = []; let cur = null; let found = 0;
  for (let line of String(text || '').split(/\n+/)) {
    line = line.replace(/^\s*(?:[-•·▪◦]|\*\s(?=\S))*\s*(?:\d+[.)]\s*)?/, '').trim(); if (!line) continue; // bullets and numbers (a "* " bullet is not a star)
    const ln = norm(line);
    const h = H.find((x) => ln === norm(x) || ln.startsWith(norm(x) + ' ') || ln.startsWith(norm(x)));
    let rest = line;
    if (h) { cur = h; found++; rest = line.replace(new RegExp('^\\W*' + h.replace(/y$/i, 'e?y') + '\\W*', 'i'), ''); }
    if (!cur || !rest.trim()) continue;
    for (const part of rest.split(/[,;/\n]| and |\t/)) {
      const star = /\*/.test(part); const name = part.replace(/\*/g, '').replace(/\(.*?\)/g, '').replace(/[-–:]+$/, '').trim();
      if (name.length >= 2 && /[a-zA-Z]/.test(name) && name.split(/\s+/).length <= 4 && !/^(none|nobody|no one|empty|n\/?a|tbd|-+)$/i.test(name)) out.push({ hub: cur, name, star });
    }
  }
  return found >= 2 && out.length ? out : null;
}
async function matchDrivers(items) {
  const ds = (await q(`SELECT id, name FROM drivers WHERE status = 'Hired' AND left_on IS NULL`)).rows.map((d) => ({ ...d, w: norm(d.name).split(' ') }));
  for (const it of items) {
    const w = norm(it.name).split(' ').filter(Boolean);
    let m = ds.filter((d) => w.every((x) => d.w.includes(x)));
    if (m.length !== 1 && w.length === 1) m = ds.filter((d) => d.w[0] === w[0] || d.w[0].startsWith(w[0]));
    if (m.length === 1) { it.driverId = m[0].id; it.driver = m[0].name; }
  }
  return items;
}
// a message in a shift or management group (or the private chat): a booking list? kept for the website
async function fromMessage(chat, m, who) {
  const items = parseBoard(m.text || m.caption); if (!items) return false;
  await matchDrivers(items);
  const sh = await D().shiftNow();
  await q(`INSERT INTO tg_boards (chat_id, shift, posted_by, items) VALUES ($1, $2, $3, $4)`, [chat ? chat.chat_id : m.chat.id, sh ? sh.name : null, who ? who.name : null, JSON.stringify(items)]);
  const bot = require('./bot');
  await bot.log('desk', `Booking list from ${who ? who.name : 'someone'}${sh ? ` (${sh.name} shift)` : ''}: ${items.filter((x) => !x.star).length} ready, ${items.filter((x) => x.star).length} finishing a load`, { chatId: chat ? chat.chat_id : null, who });
  await bot.react(m.chat.id, m.message_id, '👀').catch(() => {});
  return true;
}
// the lists of today (and how long each driver has been on them as ready)
async function boards() {
  const rows = (await q(`SELECT b.id, b.shift, b.posted_by, b.at, b.items, c.title FROM tg_boards b LEFT JOIN tg_chats c ON c.chat_id = b.chat_id WHERE b.at > now() - interval '36 hours' ORDER BY b.at DESC LIMIT 12`)).rows;
  const latest = rows[0] || null;
  if (latest) for (const it of latest.items) { // ready since: the first list in a row where he was ready at the same hub
    let since = latest.at; for (const b of rows.slice(1)) { if ((b.items || []).some((x) => !x.star && !it.star && x.hub === it.hub && (x.driverId && x.driverId === it.driverId || norm(x.name) === norm(it.name)))) since = b.at; else break; }
    it.since = since;
  }
  return { latest, list: rows.map((b) => ({ id: b.id, shift: b.shift, by: b.posted_by, at: b.at, title: b.title, ready: b.items.filter((x) => !x.star).length, finishing: b.items.filter((x) => x.star).length })), hubs: hubs() };
}

// ---------- end-of-shift notes ----------
async function noteFromGroup(chat, by) {
  await q(`INSERT INTO tg_shift_notes (chat_id, driver_id, by_name) VALUES ($1, $2, $3)`, [chat.chat_id, chat.driver_id, by ? String(by).slice(0, 80) : null]);
}
// the window of a shift that is running now or ended in the last hour: { start, end } as dates
async function windowOf(s) {
  const r = (await q(`WITH t AS (SELECT (now() AT TIME ZONE $1) l) SELECT
      (date_trunc('day', t.l) + $2::time) AT TIME ZONE $1 s_today, (date_trunc('day', t.l) + $3::time) AT TIME ZONE $1 e_today FROM t`, [s.tz || db.settings.tz, s.start, s.end])).rows[0];
  let start = new Date(r.s_today), end = new Date(r.e_today);
  if (end <= start) { if (Date.now() < end.getTime() + 3600e3) start = new Date(start - 864e5); else end = new Date(end.getTime() + 864e5); } // past midnight
  if (Date.now() < start.getTime() - 3600e3) { start = new Date(start - 864e5); end = new Date(end - 864e5); }
  return { start, end };
}
// the working drivers a shift (or one of its groups) looks after
async function driversOf(group) {
  const cos = group && (group.companies || []).length ? group.companies.map(Number) : null;
  return (await q(`SELECT d.id, d.name, c.chat_id::text chat_id, c.title FROM drivers d JOIN tg_chats c ON c.driver_id = d.id AND c.kind = 'dispatch' AND c.active
    WHERE d.status = 'Hired' AND d.left_on IS NULL AND ($1::int[] IS NULL OR d.company_id = ANY($1::int[])) ORDER BY d.name`, [cos])).rows;
}
// what a note could say, from what the bot knows (no AI): the last load update, an open case, home time, a rest
async function suggestNote(driverId, shiftName) {
  const u = (await q(`SELECT status, place, eta FROM tg_updates WHERE driver_id = $1 ORDER BY at DESC LIMIT 1`, [driverId])).rows[0];
  const cs = (await q(`SELECT p.title FROM tg_cases c JOIN tg_playbooks p ON p.id = c.playbook_id WHERE c.driver_id = $1 AND c.status = 'open' LIMIT 1`, [driverId])).rows[0];
  const h = (await q(`SELECT status, back_on::text back FROM home_time WHERE driver_id = $1 AND status IN ('planned', 'home') ORDER BY id DESC LIMIT 1`, [driverId])).rows[0];
  const r = (await q(`SELECT until_text FROM tg_checks WHERE driver_id = $1 AND kind = 'rest' AND until_at > now() ORDER BY id DESC LIMIT 1`, [driverId])).rows[0];
  const ld = (await q(`SELECT answer FROM tg_checks WHERE driver_id = $1 AND kind = 'needs_load' AND answer IS NOT NULL AND created_at > now() - interval '18 hours' ORDER BY id DESC LIMIT 1`, [driverId])).rows[0];
  const ST = { assigned: 'Load assigned', to_pickup: 'Going to pickup', at_pickup: 'At pickup', loaded: 'Loaded', rolling: 'Rolling', at_delivery: 'At delivery', delivered: 'Delivered, empty', delayed: 'Delayed' };
  return [`📝 ${shiftName || 'Shift'} shift update`,
    `Now: ${u ? `${ST[u.status] || u.status}${u.place ? ' at ' + u.place : ''}${u.eta ? ', ETA ' + u.eta : ''}` : 'no update yet'}`,
    r ? `Resting until ${r.until_text}` : '', ld ? `Next load: ${ld.answer.slice(0, 160)}` : 'Next: ',
    cs ? `Open case: ${cs.title}` : '', h ? (h.status === 'home' ? `At home, back ${h.back || '?'}` : `Going home soon, back ${h.back || '?'}`) : ''].filter(Boolean).join('\n');
}
async function notesStatus(s) {
  const w = await windowOf(s); const gs = D().groupsOf(s); const scopes = gs.length ? gs : [null];
  const seen = new Set(); const rows = [];
  for (const g of scopes) for (const d of await driversOf(g)) { if (seen.has(d.id)) continue; seen.add(d.id);
    const n = (await q(`SELECT by_name, at FROM tg_shift_notes WHERE driver_id = $1 AND at >= $2 ORDER BY at DESC LIMIT 1`, [d.id, w.start])).rows[0];
    rows.push({ ...d, note: n || null }); }
  return { window: w, drivers: rows };
}
// where a routine message goes: each of the shift's groups (with its own drivers), else privately to the shift's people
async function deliver(s, textFor) {
  const bot = require('./bot'); const gs = D().groupsOf(s);
  if (gs.length) { for (const g of gs) { const t = await textFor(g); if (t) await bot.send(g.chatId, t).catch((e) => console.error('routine send', e.message)); } return; }
  const t = await textFor(null); if (!t) return;
  for (const p of (await q(`SELECT (SELECT tg_id FROM tg_people WHERE user_id = u.id ORDER BY seen_at DESC NULLS LAST LIMIT 1) tg_id FROM users u WHERE u.id = ANY($1::int[]) AND u.active`, [(s.people || []).map(Number)])).rows) if (p.tg_id) await bot.send(p.tg_id, t).catch(() => {});
}
async function once(s, w, kind) {
  const r = await q(`INSERT INTO tg_routine (shift, day, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`, [s.name, w.start.toISOString().slice(0, 10), kind]);
  return !!r.rows[0];
}
async function tick() {
  const c = D().cfg(); if (!c.on) return; const bot = require('./bot');
  if (bot.paused()) return; // paused everywhere
  const R = { boardMin: 45, notesMin: 45, ...(c.routines || {}) };
  const site = process.env.PUBLIC_URL || '';
  for (const s of c.shifts) {
    if (!(s.people || []).length && !D().groupsOf(s).length) continue;
    const w = await windowOf(s); const now = Date.now();
    // the booking list: not posted by this shift in time
    if (R.board !== false && now > w.start.getTime() + R.boardMin * 60e3 && now < w.end.getTime()) {
      const posted = (await q(`SELECT 1 FROM tg_boards WHERE at >= $1 LIMIT 1`, [w.start])).rows[0];
      if (!posted && await once(s, w, 'board')) await deliver(s, async () => `📋 ${bot.esc(s.name)} shift: please post the booking list, by location:\n${hubs().map((h) => `<b>${bot.esc(h)}</b>: names`).join('\n')}\nA name alone = ready there now; with * = on a load, finishing near there (pre-book from his delivery).`);
    }
    // before the shift ends: the groups that still need an update note
    if (R.notes !== false && now > w.end.getTime() - R.notesMin * 60e3 && now < w.end.getTime() && await once(s, w, 'notes')) {
      const st = await notesStatus(s);
      await deliver(s, async (g) => { const ids = new Set((await driversOf(g)).map((d) => d.id)); const miss = st.drivers.filter((d) => ids.has(d.id) && !d.note);
        return miss.length ? `🕑 ${bot.esc(s.name)} shift ends soon. Please write the update note in each driver's group for the next shift (where he is, the load, the next plan). Still without a note:\n${miss.map((d) => '• ' + bot.esc(d.name)).join('\n')}${site ? `\nSuggested notes: ${site}/#/shifts` : '\nSuggested notes: website → Shift desk'}` : null; });
    }
    // after the shift: who has a note and who not
    if (R.notes !== false && now > w.end.getTime() + 5 * 60e3 && now < w.end.getTime() + 60 * 60e3 && await once(s, w, 'notes_report')) {
      const st = await notesStatus(s); const miss = st.drivers.filter((d) => !d.note);
      if (st.drivers.length) {
        await deliver(s, async (g) => { const ids = new Set((await driversOf(g)).map((d) => d.id)); const mine = st.drivers.filter((d) => ids.has(d.id)); const mm = mine.filter((d) => !d.note);
          return mine.length ? `✅ ${bot.esc(s.name)} shift notes: ${mine.length - mm.length} of ${mine.length} groups.${mm.length ? `\nNo note: ${mm.map((d) => bot.esc(d.name)).join(', ')}` : ''}` : null; });
        if (miss.length) for (const id of (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id)) await db.notify(db.pool, id, 'desk', `${s.name} shift ended: ${miss.length} of ${st.drivers.length} driver groups got no update note (${miss.slice(0, 5).map((d) => d.name).join(', ')}${miss.length > 5 ? '…' : ''}).`, '#/shifts');
      }
    }
  }
}
module.exports = { TERMS, seed, forAi, parseBoard, matchDrivers, fromMessage, boards, noteFromGroup, notesStatus, suggestNote, windowOf, driversOf, tick };
