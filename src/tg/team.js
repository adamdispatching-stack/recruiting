// The team's side of the bot:
// - /onboard: the drivers in onboarding, Amazon verified first, then pending Amazon; each with the recruiter, the start date
//   and what is going on in the group (the AI reads the newest messages first, so the list is up to date)
// - management groups: a Telegram group of our team (no driver). The bot posts the morning report there and follows up:
//   it tags whoever looks after a driver who got no response (the recruiter; for a working driver the truck's dispatcher),
//   and the recruiter when a call-back was missed or Amazon is stuck.
const db = require('../db');
const bot = require('./bot');
const { q } = db; const { send, esc } = bot;

const AMZ = Object.fromEntries(db.AMAZON.map((a) => [a.key, a.label]));
const ago = (t) => { const h = (Date.now() - new Date(t)) / 36e5; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`; };
const nice = (d) => require('../lib').niceDate(String(d).slice(0, 10));

// the recruiter, tagged in Telegram when their account is connected
async function who(userId, name) {
  if (!userId) return name ? `<b>${esc(name)}</b>` : 'no recruiter';
  const p = (await q(`SELECT * FROM tg_people WHERE user_id = $1 ORDER BY seen_at DESC NULLS LAST LIMIT 1`, [userId])).rows[0];
  return p ? bot.tag(p) : `<b>${esc(name || 'recruiter')}</b>`;
}

// Read the newest messages of the onboarding groups first (up to ~40 s), so the list says what is going on now
async function refresh(limitMs = 40000) {
  const t0 = Date.now();
  const chats = (await q(`SELECT DISTINCT m.chat_id FROM tg_messages m JOIN tg_chats c ON c.chat_id = m.chat_id AND c.kind = 'dispatch' JOIN drivers d ON d.id = c.driver_id AND d.status = 'Onboarding' WHERE NOT m.digested`)).rows;
  let n = 0;
  for (const c of chats) { if (Date.now() - t0 > limitMs) break; await require('./digest').digestChat(c.chat_id).catch((e) => console.error('onboard refresh', e.message)); n++; }
  return n;
}

async function onboardText({ tagRecruiters = false } = {}) {
  const rows = (await q(`SELECT d.id, d.name, d.mode dtype, d.truck_year, d.truck_model, d.amazon_step, d.amazon_log, d.owner_id, u.name owner, o.expected_arrival::text start, o.arrival_note, c.ai_status, c.ai_status_at, c.mode,
      (SELECT max(at) FROM tg_messages m WHERE m.chat_id = ch.chat_id AND NOT m.is_bot) last_msg, ch.chat_id
    FROM drivers d LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN onboarding o ON o.driver_id = d.id LEFT JOIN onb_cases c ON c.driver_id = d.id
    LEFT JOIN tg_chats ch ON ch.driver_id = d.id AND ch.kind = 'dispatch' AND ch.active
    WHERE d.status = 'Onboarding' ORDER BY o.expected_arrival NULLS LAST, d.name`)).rows;
  if (!rows.length) return ['Nobody is in onboarding right now.'];
  // plain: Amazon verified, then Amazon pending; inside each CD, then OO (and anyone not marked); name and start date
  rows.sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999') || a.name.localeCompare(b.name));
  const line = (d) => `${esc(d.name)} — ${d.start ? esc(nice(d.start)) : 'no start date'}`;
  const part = (title, list) => {
    const out = [`\n<b>${title}</b> (${list.length})`];
    for (const [label, ds] of [['CD', list.filter((d) => d.dtype === 'Company drivers')], ['OO', list.filter((d) => d.dtype === 'Owner-operators')], ['Not marked CD or OO', list.filter((d) => d.dtype !== 'Company drivers' && d.dtype !== 'Owner-operators')]]) {
      if (!ds.length) continue;
      out.push(`${label} (${ds.length})`); for (const d of ds) out.push(line(d));
    }
    if (!list.length) out.push('None');
    return out;
  };
  const ver = rows.filter((d) => d.amazon_step === 'verified'), pend = rows.filter((d) => d.amazon_step !== 'verified');
  const blocks = [`<b>Onboarding: ${rows.length}</b>`, ...part('Amazon verified', ver), ...part('Amazon pending', pend)];
  // Telegram allows 4096 characters a message: split between drivers
  const out = []; let cur = '';
  for (const b of blocks) { if ((cur + '\n' + b).length > 3800) { out.push(cur); cur = b; } else cur = cur ? cur + '\n' + b : b; }
  if (cur) out.push(cur);
  return out;
}
// /onboard: reads the groups first, then the list
async function onboardCmd(chatId, person, { tagRecruiters = false } = {}) {
  if (!bot.isStaff(person)) return send(chatId, 'Only our team can see this. Connect your website account first: /me CODE (the code is under Telegram → Connect my Telegram).');
  const n = (await q(`SELECT count(DISTINCT m.chat_id)::int n FROM tg_messages m JOIN tg_chats c ON c.chat_id = m.chat_id AND c.kind = 'dispatch' JOIN drivers d ON d.id = c.driver_id AND d.status = 'Onboarding' WHERE NOT m.digested`)).rows[0].n;
  if (n) await refresh(); // the newest messages first, quietly, so start dates are up to date
  let last = null; for (const t of await onboardText({ tagRecruiters })) last = await send(chatId, t);
  return last;
}

// /oil: every truck in service, overdue first: the truck, the driver, the miles now, when the oil was done and when it is due
async function oilText() {
  const fl = require('../fleet');
  const ts = (await q(`SELECT t.*, d.name driver, co.name company FROM trucks t LEFT JOIN drivers d ON d.id = t.driver_id LEFT JOIN companies co ON co.id = t.company_id WHERE NOT t.out_of_service ORDER BY t.unit`)).rows;
  if (!ts.length) return ['No trucks on the website yet.'];
  const last = await fl.lastOils(ts.map((t) => t.id));
  const mi = (n) => (n === null || n === undefined ? '?' : Math.round(n).toLocaleString('en-US'));
  const rows = ts.map((t) => ({ t, o: fl.oilStatus(t, last[t.id]) }));
  const line = ({ t, o }) => {
    const who = t.driver || t.driver_name || 'no driver';
    if (o.state === 'unknown') return `${esc(t.unit)} — ${esc(who)} — now ${mi(t.odometer)} mi — no oil change on record`;
    const due = [o.dueMiles ? `due at ${mi(o.dueMiles)} mi${o.milesLeft !== null ? ` (${o.milesLeft <= 0 ? `${mi(-o.milesLeft)} over` : `${mi(o.milesLeft)} left`})` : ''}` : '',
      `${o.daysLeft <= 0 ? `${-o.daysLeft} days past` : `by ${esc(nice(o.dueDate))}`}`].filter(Boolean).join(', ');
    return `${esc(t.unit)} — ${esc(who)} — now ${mi(o.odometer)} mi — done at ${mi(o.last.odometer)} mi on ${esc(nice(new Date(o.last.at).toISOString()))} — ${due}`;
  };
  const by = (s) => rows.filter((x) => x.o.state === s).sort((a, b) => (a.o.milesLeft ?? 1e9) - (b.o.milesLeft ?? 1e9) || (a.o.daysLeft ?? 1e9) - (b.o.daysLeft ?? 1e9));
  const blocks = [`<b>Oil changes: ${rows.length} trucks</b>`];
  for (const [title, s] of [['Overdue', 'overdue'], ['Due soon', 'soon'], ['No oil change on record', 'unknown'], ['OK', 'ok']]) {
    const xs = by(s); if (!xs.length) continue;
    blocks.push(`\n<b>${title}</b> (${xs.length})`); for (const x of xs) blocks.push(line(x));
  }
  const out = []; let cur = '';
  for (const b of blocks) { if ((cur + '\n' + b).length > 3800) { out.push(cur); cur = b; } else cur = cur ? cur + '\n' + b : b; }
  if (cur) out.push(cur);
  return out;
}
async function oilCmd(chatId, person) {
  if (!bot.isStaff(person)) return send(chatId, 'Only our team can see this. Connect your website account first: /me CODE (the code is under Telegram → Connect my Telegram).');
  let last = null; for (const t of await oilText()) last = await send(chatId, t);
  return last;
}

// ---------- management groups: the morning report and follow-ups ----------
const local = () => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: db.settings.tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const g = (k) => (p.find((x) => x.type === k) || {}).value; return { date: `${g('year')}-${g('month')}-${g('day')}`, min: (+g('hour') % 24) * 60 + +g('minute') }; };
async function once(key) { const r = await q(`INSERT INTO tg_state (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`, [key]); return !!r.rows[0]; }

// A driver waits for us: he wrote in his dispatch group and got no response at all for 3+ hours (in onboarding, or working).
// - only the driver's own messages start the wait. What others write is never an alert, and neither is a driver who does
//   not answer us (his silence still lowers his chance on the Onboarding page).
// - any response ends it: a person who is not the driver writing in the group, our reply sent from the website or
//   answered through the bot, or a logged call where they talked.
// - "ok", "thanks" or a sticker needs no answer. The wait counts from his first unanswered message, so writing again
//   does not restart it. After 3 days it is no longer news.
const WAIT_MS = 3 * 36e5, WAIT_DAYS = 3;
const ANON_ADMIN = '1087968824'; // Telegram's id for an admin who writes as the group: our team
const ACK = /^(?:(?:ok(?:ay)?|k+|thanks?( you)?|thank u|thx|ty|yes|yeah|yep|yup|no|nope|no problem|got it|copy( that)?|roger( that)?|10-4|will do|sounds good|alright|cool|great|perfect|good|noted|understood|you too|sir|bro|brother|man|boss)(?![a-z0-9])[\s.,!]*)+$/i;
function needsAnswer(m) {
  if (!m.text) return !!m.media && m.media !== 'sticker';
  const t = String(m.text).replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]/gu, '').trim();
  return /[\p{L}\p{N}?]/u.test(t) && !t.startsWith('/') && !ACK.test(t);
}
const firstWord = (s) => String(s || '').trim().split(/\s+/)[0].toLowerCase();
async function waitingDrivers() {
  const groups = (await q(`SELECT d.id, d.name, d.status, d.owner_id, u.name owner_name, ch.chat_id
    FROM drivers d JOIN tg_chats ch ON ch.driver_id = d.id LEFT JOIN users u ON u.id = d.owner_id
    WHERE ch.kind = 'dispatch' AND ch.active AND (d.status = 'Onboarding' OR (d.status = 'Hired' AND d.left_on IS NULL))`)).rows;
  if (!groups.length) return [];
  const msgs = (await q(`SELECT m.chat_id, m.msg_id, m.from_id, m.from_name, m.is_bot, m.text, m.media, m.at, m.imported, p.role, p.user_id, p.name person
    FROM tg_messages m JOIN tg_chats c ON c.chat_id = m.chat_id LEFT JOIN tg_people p ON p.tg_id = m.from_id
    WHERE c.kind = 'dispatch' AND c.active AND m.at > now() - interval '${WAIT_DAYS} days' ORDER BY m.at, m.id`)).rows;
  const byChat = new Map();
  for (const m of msgs) { const k = String(m.chat_id); if (!byChat.has(k)) byChat.set(k, []); byChat.get(k).push(m); }
  const known = new Map(); // driver -> his Telegram accounts
  for (const p of (await q(`SELECT tg_id, driver_id FROM tg_people WHERE role = 'driver' AND driver_id IS NOT NULL`)).rows) {
    if (!known.has(p.driver_id)) known.set(p.driver_id, new Set());
    known.get(p.driver_id).add(String(p.tg_id));
  }
  // our responses that are not a person's message in the group
  const sent = (await q(`SELECT chat_id, decided_at at FROM tg_drafts WHERE state = 'sent' AND decided_at > now() - interval '${WAIT_DAYS} days'`)).rows
    .concat((await q(`SELECT chat_id, answered_at at FROM tg_questions WHERE answered_at > now() - interval '${WAIT_DAYS} days'`)).rows);
  const talked = (await q(`SELECT driver_id, created_at at FROM notes WHERE kind = 'call' AND outcome = 'Talked' AND created_at > now() - interval '${WAIT_DAYS} days'`)).rows;

  const out = [];
  for (const g of groups) {
    const list = byChat.get(String(g.chat_id)); if (!list) continue;
    const ids = known.get(g.id);
    // not connected as the driver yet: only someone with no role and the driver's own first name counts as him
    const isDriver = (m) => !m.is_bot && !m.user_id && (ids ? ids.has(String(m.from_id))
      : (!m.role || m.role === 'driver') && firstWord(m.person || m.from_name) === firstWord(g.name));
    let first = null;
    for (const m of list) {
      if (!m.text && !m.media) continue; // someone joined, the title changed
      if (isDriver(m)) { if (!first && !m.imported && needsAnswer(m)) first = m; continue; }
      const byPerson = m.is_bot
        ? String(m.from_id) === ANON_ADMIN || /\n\([^()\n]+\)$/.test(m.text || '') // a note posted from the website ends "(name)"
        : m.user_id || m.role !== 'driver';
      if (byPerson) first = null;
    }
    if (!first) continue;
    const at = +new Date(first.at);
    if (Date.now() - at <= WAIT_MS) continue;
    if (sent.some((r) => String(r.chat_id) === String(g.chat_id) && new Date(r.at) >= at)) continue;
    if (talked.some((r) => r.driver_id === g.id && new Date(r.at) >= at)) continue;
    out.push({ ...g, msg: first });
  }
  return out;
}

// what needs a follow-up now: each item once a day
async function followups() {
  const items = [];
  for (const w of await waitingDrivers()) {
    let userId = w.owner_id, owner = w.owner_name;
    if (w.status === 'Hired') { // a working driver: his truck's dispatcher, not the recruiter who hired him
      const t = (await q(`SELECT t.dispatcher_id, u.name FROM trucks t JOIN users u ON u.id = t.dispatcher_id WHERE t.driver_id = $1 AND u.active`, [w.id])).rows[0];
      userId = t ? t.dispatcher_id : null; owner = t ? t.name : 'Dispatch';
    }
    const said = String(w.msg.text || '').replace(/\s+/g, ' ').trim();
    items.push({ key: `wait:${w.id}:${w.chat_id}:${w.msg.msg_id}`, userId, owner, driverId: w.id, disp: w.status === 'Hired',
      text: `${esc(w.name)} wrote in the group ${ago(w.msg.at)} ago and got no response${said ? `: "${esc(said.length > 120 ? said.slice(0, 120) + '…' : said)}"` : '.'}` });
  }
  // a call-back that was missed
  for (const d of (await q(`SELECT d.id, d.name, d.owner_id, u.name owner, d.callback_at, d.callback_said FROM drivers d LEFT JOIN users u ON u.id = d.owner_id WHERE d.callback_state = 'due' AND d.callback_at < now() - interval '30 minutes'`)).rows)
    items.push({ key: `cb:${d.id}`, userId: d.owner_id, owner: d.owner, text: `missed the call-back to ${esc(d.name)} (asked for ${esc(d.callback_said || 'a call')}, ${ago(d.callback_at)} ago).`, driverId: d.id });
  // Amazon stuck on one step for 5+ days
  for (const d of (await q(`SELECT d.id, d.name, d.owner_id, u.name owner, d.amazon_step, d.amazon_log FROM drivers d LEFT JOIN users u ON u.id = d.owner_id WHERE d.status = 'Onboarding' AND d.amazon_step = 'invite'`)).rows) { // after the invite, the journey follow-ups ask the team (tg/journey.js)
    const at = d.amazon_step && d.amazon_log ? d.amazon_log[d.amazon_step] : null;
    if (at && Date.now() - new Date(at) > 5 * 864e5) items.push({ key: `amz:${d.id}:${d.amazon_step}`, userId: d.owner_id, owner: d.owner, text: `${esc(d.name)} has been on "${esc(AMZ[d.amazon_step])}" with Amazon for ${ago(at)}.`, driverId: d.id });
  }
  return items;
}
async function tick() {
  if (!bot.state.me) return;
  const groups = (await q(`SELECT chat_id FROM tg_chats WHERE kind = 'management' AND active`)).rows;
  if (bot.paused()) return; // paused everywhere (Telegram → Autopilot)
  if (!groups.length) return;
  const t = db.settings.tg || {}; const L = local();
  const [h, mi] = String(t.teamReportAt || '09:00').split(':').map(Number);
  const work = process.env.TG_NO_QUIET || (L.min >= 8 * 60 && L.min < 20 * 60);
  for (const g of groups) {
    if (t.teamReport !== false && L.min >= h * 60 + mi && L.min < h * 60 + mi + 180 && await once(`mreport:${g.chat_id}:${L.date}`)) {
      await refresh();
      const e = await require('../fleet').emptyBoard();
      await send(g.chat_id, `☀️ <b>Good morning, team.</b>${e.count ? ` ${e.count} empty truck${e.count === 1 ? '' : 's'} today (about $${Math.round(e.losingPerDay).toLocaleString('en-US')} a day): /empty for the list.` : ' No empty trucks.'}`);
      for (const x of await onboardText({ tagRecruiters: true })) await send(g.chat_id, x);
      await bot.log('said', 'Morning report in the management group', { chatId: g.chat_id, driverId: null });
    }
    if (t.teamFollowups === false || !work) continue;
    const fu = await followups();
    for (const it of fu) {
      if (it.userId && !it.disp && !(await require('../working').working(it.userId))) continue; // a recruiter is tagged only in their working hours: it waits (dispatch runs around the clock)
      if (!await once(`mf:${g.chat_id}:${it.key}:${L.date}`)) continue;
      const tg = await who(it.userId, it.owner);
      const nm = it.driverId ? ((await q(`SELECT name FROM drivers WHERE id = $1`, [it.driverId])).rows[0] || {}).name : null; // his name opens his group
      await send(g.chat_id, `🔔 ${tg}${it.text.startsWith('missed') ? ' ' : ': '}${nm ? await bot.linkName(it.text, it.driverId, nm) : it.text}`);
      await bot.log('ask', `Follow-up: ${it.owner || 'no recruiter'}: ${bot.stripHtml ? bot.stripHtml(it.text) : it.text}`, { chatId: g.chat_id, driverId: it.driverId });
    }
  }
}
function start() { setInterval(() => tick().catch((e) => console.error('team tick', e.message)), +process.env.TG_TEAM_MS || 5 * 60000); }
module.exports = { who, oilCmd, oilText, start, tick, onboardCmd, onboardText, followups, refresh };
