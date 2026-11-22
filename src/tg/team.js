// The team's side of the bot:
// - /onboard: the drivers in onboarding, Amazon verified first, then pending Amazon; each with the recruiter, the start date
//   and what is going on in the group (the AI reads the newest messages first, so the list is up to date)
// - management groups: a Telegram group of our team (no driver). The bot posts the morning report there and follows up:
//   it tags the recruiter when a driver waits for an answer, a call-back was missed, or Amazon is stuck.
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

// ---------- management groups: the morning report and follow-ups ----------
const local = () => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: db.settings.tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const g = (k) => (p.find((x) => x.type === k) || {}).value; return { date: `${g('year')}-${g('month')}-${g('day')}`, min: (+g('hour') % 24) * 60 + +g('minute') }; };
async function once(key) { const r = await q(`INSERT INTO tg_state (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`, [key]); return !!r.rows[0]; }

// what needs a follow-up now: each item once a day
async function followups() {
  const items = [];
  // a driver in onboarding wrote in the group and nobody from the team answered for 3+ hours
  for (const d of (await q(`SELECT d.id, d.name, d.owner_id, u.name owner, ch.chat_id, ch.title,
      (SELECT max(m.at) FROM tg_messages m JOIN tg_people p ON p.tg_id = m.from_id WHERE m.chat_id = ch.chat_id AND NOT m.is_bot AND (p.role = 'driver' OR (p.role IS NULL AND p.user_id IS NULL))) drv,
      (SELECT max(m.at) FROM tg_messages m LEFT JOIN tg_people p ON p.tg_id = m.from_id WHERE m.chat_id = ch.chat_id AND NOT m.is_bot AND (p.role IN ('staff', 'dispatch', 'eld', 'accounting') OR p.user_id IS NOT NULL)) team
    FROM drivers d JOIN tg_chats ch ON ch.driver_id = d.id AND ch.kind = 'dispatch' AND ch.active LEFT JOIN users u ON u.id = d.owner_id WHERE d.status = 'Onboarding'`)).rows) {
    if (d.drv && (!d.team || new Date(d.team) < new Date(d.drv)) && Date.now() - new Date(d.drv) > 3 * 36e5)
      items.push({ key: `wait:${d.id}`, userId: d.owner_id, owner: d.owner, text: `${esc(d.name)} wrote in the group ${ago(d.drv)} ago and nobody from the team answered.`, driverId: d.id });
  }
  // the silence countdown: 2 days (call him), 4 days (at risk), 7 days (still with us?)
  const ob = (await q(`SELECT d.id, d.name, d.owner_id, u.name owner FROM drivers d LEFT JOIN users u ON u.id = d.owner_id WHERE d.status = 'Onboarding'`)).rows;
  const rs = await require('../reach').scoreMany(ob.map((d) => d.id));
  for (const d of ob) {
    const r = rs[d.id]; if (!r || !(r.silentDays >= 2)) continue;
    const step = r.silentDays >= 7 ? 7 : r.silentDays >= 4 ? 4 : 2;
    const what = step === 7 ? 'still with us? Consider moving the driver out of onboarding.' : step === 4 ? `now at risk (${r.icon} ${r.score}). Try a call and a text today.` : 'please give a call.';
    items.push({ ever: true, key: `silent${step}:${d.id}`, userId: d.owner_id, owner: d.owner, driverId: d.id,
      text: `${esc(d.name)} has been silent ${r.silentDays} days${r.unanswered ? ` (${r.unanswered} of our messages unanswered${r.calls.noAnswer ? `, ${r.calls.noAnswer} call${r.calls.noAnswer === 1 ? '' : 's'} not answered` : ''})` : ''}: ${what}` });
  }
  // a call-back that was missed
  for (const d of (await q(`SELECT d.id, d.name, d.owner_id, u.name owner, d.callback_at, d.callback_said FROM drivers d LEFT JOIN users u ON u.id = d.owner_id WHERE d.callback_state = 'due' AND d.callback_at < now() - interval '30 minutes'`)).rows)
    items.push({ key: `cb:${d.id}`, userId: d.owner_id, owner: d.owner, text: `missed the call-back to ${esc(d.name)} (asked for ${esc(d.callback_said || 'a call')}, ${ago(d.callback_at)} ago).`, driverId: d.id });
  // Amazon stuck on one step for 5+ days
  for (const d of (await q(`SELECT d.id, d.name, d.owner_id, u.name owner, d.amazon_step, d.amazon_log FROM drivers d LEFT JOIN users u ON u.id = d.owner_id WHERE d.status = 'Onboarding' AND coalesce(d.amazon_step, '') <> 'verified'`)).rows) {
    const at = d.amazon_step && d.amazon_log ? d.amazon_log[d.amazon_step] : null;
    if (at && Date.now() - new Date(at) > 5 * 864e5) items.push({ key: `amz:${d.id}:${d.amazon_step}`, userId: d.owner_id, owner: d.owner, text: `${esc(d.name)} has been on "${esc(AMZ[d.amazon_step])}" with Amazon for ${ago(at)}.`, driverId: d.id });
  }
  return items;
}
async function tick() {
  if (!bot.state.me) return;
  const groups = (await q(`SELECT chat_id FROM tg_chats WHERE kind = 'management' AND active`)).rows;
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
    // one silence = since the driver's last sign of life; a new silence later counts again
    const rsAt = Object.fromEntries((await q(`SELECT d.id, (SELECT max(m.at) FROM tg_messages m JOIN tg_people p ON p.tg_id = m.from_id WHERE m.chat_id IN (SELECT chat_id FROM tg_chats WHERE driver_id = d.id) AND NOT m.is_bot AND (p.role = 'driver' OR (p.role IS NULL AND p.user_id IS NULL)))::text last FROM drivers d WHERE d.id = ANY($1::int[])`, [fu.filter((x) => x.ever).map((x) => x.driverId)])).rows.map((r) => [r.id, r.last || '']));
    for (const it of fu) {
      if (!await once(it.ever ? `mf:${g.chat_id}:${it.key}:${(rsAt[it.driverId] || '')}` : `mf:${g.chat_id}:${it.key}:${L.date}`)) continue; // the silence steps: once per silence
      const tg = await who(it.userId, it.owner);
      await send(g.chat_id, `🔔 ${tg}${it.text.startsWith('missed') ? ' ' : ': '}${it.text}`);
      await bot.log('ask', `Follow-up: ${it.owner || 'no recruiter'}: ${bot.stripHtml ? bot.stripHtml(it.text) : it.text}`, { chatId: g.chat_id, driverId: it.driverId });
    }
  }
}
function start() { setInterval(() => tick().catch((e) => console.error('team tick', e.message)), +process.env.TG_TEAM_MS || 5 * 60000); }
module.exports = { start, tick, onboardCmd, onboardText, followups, refresh };
