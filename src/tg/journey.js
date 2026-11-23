// Follow-ups along the driver's journey. For every driver in onboarding the bot looks at what is still missing and who
// owes it, and follows up with that side the way a person would: one thing at a time, by first name, in working hours,
// never twice in a row too soon, and it stops by itself once the thing is done.
// - our team (in the management group, tagging the recruiter; a website notice when there is no management group):
//   no Telegram group, the bot removed or not an admin, which account is the driver, the Relay invite, "is he verified?",
//   what is still open on our side, missing start date/company/truck, did he arrive, ready to hire.
// - the driver (in his group): the Relay invite, his CDL state and ZIP, a check-in when he goes quiet. Sent in
//   "Answer questions" and "Run"; in "Watch and learn" it waits on his page as a reply ready to send.
// After the last try the admins get a website notice. Switched off with the team follow-ups (Telegram → Team).
const db = require('../db');
const bot = require('./bot');
const { q } = db; const { esc } = bot;

const H = 36e5;
const hrs = (t) => (t ? (Date.now() - new Date(t)) / H : 0);
const ago = (t) => { const h = hrs(t); return h < 48 ? `${Math.max(1, Math.round(h))} h ago` : `${Math.round(h / 24)} days ago`; };
const first = (n) => String(n || '').trim().split(/\s+/)[0];
const nice = (d) => require('../lib').niceDate(String(d).slice(0, 10));
const AMZ = Object.fromEntries(db.AMAZON.map((a) => [a.key, a]));
const TEAM_TODO = { insurance: 'insurance approval', mvr: 'the MVR check', contract_sent: 'sending the contract', ch_query: 'the Clearinghouse query' };
const pick = (n, list) => list[n % list.length]; // a different wording on the next try

async function load() {
  const ds = (await q(`SELECT d.id, d.name, d.owner_id, u.name owner, d.amazon_step, d.amazon_log, d.zip, d.license_state, d.company_id,
      o.started_at, o.expected_arrival arrive, o.arrived_on arrived, c.mode bot_mode
    FROM drivers d JOIN onboarding o ON o.driver_id = d.id LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN onb_cases c ON c.driver_id = d.id
    WHERE d.status = 'Onboarding' AND d.left_on IS NULL ORDER BY d.id`)).rows;
  if (!ds.length) return [];
  const ids = ds.map((d) => d.id);
  const groups = (await q(`SELECT driver_id, chat_id::text chat_id, active, bot_admin, linked_at FROM tg_chats WHERE kind = 'dispatch' AND driver_id = ANY($1::int[]) ORDER BY active DESC, linked_at DESC NULLS LAST`, [ids])).rows;
  const units = (await q(`SELECT driver_id, unit FROM trucks WHERE driver_id = ANY($1::int[])`, [ids])).rows;
  const open = (await q(`SELECT driver_id, key FROM checklist WHERE driver_id = ANY($1::int[]) AND NOT done AND key = ANY($2::text[])`, [ids, Object.keys(TEAM_TODO)])).rows;
  const orient = (await q(`SELECT driver_id, count(*)::int total, count(*) FILTER (WHERE NOT done)::int open FROM orientation WHERE driver_id = ANY($1::int[]) GROUP BY driver_id`, [ids])).rows;
  const spoke = (await q(`SELECT c.driver_id, max(m.at) at FROM tg_chats c JOIN tg_messages m ON m.chat_id = c.chat_id JOIN tg_people p ON p.tg_id = m.from_id AND p.role = 'driver' AND p.driver_id = c.driver_id
    WHERE c.driver_id = ANY($1::int[]) GROUP BY c.driver_id`, [ids])).rows;
  const who = await require('./whois').candidates(ids);
  const day = (v) => (!v ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)); // dates are plain text (db.js)
  return ds.map((d) => ({ ...d, arrive: day(d.arrive), arrived: day(d.arrived), group: groups.find((g) => g.driver_id === d.id) || null, unit: (units.find((u) => u.driver_id === d.id) || {}).unit || null,
    teamOpen: open.filter((x) => x.driver_id === d.id).map((x) => x.key), orient: orient.find((x) => x.driver_id === d.id) || null,
    spoke: (spoke.find((x) => x.driver_id === d.id) || {}).at || null, who: who[d.id] }));
}

// What is missing for one driver, and whose move it is. every: hours between tries; max: tries before the admins hear.
function owed(d) {
  const out = []; const N = esc(d.name); const g = d.group; const live = g && g.active;
  const stepAt = d.amazon_step && d.amazon_log ? d.amazon_log[d.amazon_step] : null;
  const mode = d.bot_mode || (db.settings.tg || {}).onbMode || 'watch';
  // ---- our team ----
  if (!g && hrs(d.started_at) >= 2) out.push({ key: 'no_group', side: 'team', every: 24, max: 3, text: (n) => pick(n, [
    `${N} is in onboarding but has no Telegram group yet. Can you create one and add me to it?`,
    `Still no Telegram group for ${N}. Could you make one and add me, so I can help him through the steps?`]) });
  if (g && !g.active) out.push({ key: 'bot_removed', side: 'team', every: 24, max: 3, text: () => `I'm not in ${N}'s group any more (someone removed me). Could you add me back?` });
  if (live && g.bot_admin === false && hrs(g.linked_at || d.started_at) >= 1) out.push({ key: 'bot_admin', side: 'team', every: 48, max: 2,
    text: () => `I'm in ${N}'s group but not an admin, so I can miss his messages. Can you make me an admin? (Group settings → Administrators → Add admin)` });
  const ask = live ? require('./whois').toAsk(d.who) : [];
  if (live && ask.length && !(d.who && d.who.linked.length) && hrs(g.linked_at || d.started_at) >= 6) out.push({ key: 'who_driver', side: 'team', every: 24, max: 3,
    text: () => `Which one is ${N} in his group? I want to make sure I talk to the right person.`,
    buttons: [ask.map((p) => [p.name.slice(0, 30), `jr:${d.id}:who:${p.tgId}`]), [['None of them', `jr:${d.id}:whonone`]]] });
  if (!d.amazon_step && hrs(d.started_at) >= 24) out.push({ key: 'invite', side: 'team', every: 24, max: 3,
    text: () => `Has the Amazon Relay invite gone out to ${N}? I don't see it yet.`, buttons: [[['✅ Sent', `jr:${d.id}:inv`], ['Not yet', `jr:${d.id}:later:invite`]]] });
  if (['profile', 'accurate', 'waiting'].includes(d.amazon_step) && hrs(stepAt || d.started_at) >= 24) out.push({ key: 'verified', side: 'team', every: 48, max: 5,
    text: (n) => pick(n, [`Is ${N}'s Amazon Relay account verified yet? Last step: ${esc(AMZ[d.amazon_step].long.toLowerCase())}${stepAt ? `, ${ago(stepAt)}` : ''}.`,
      `Checking in on ${N}: has Amazon verified him yet?`]),
    buttons: [[['✅ Verified', `jr:${d.id}:ver`], ['⏳ Not yet', `jr:${d.id}:later:verified`]]] });
  if (d.teamOpen.length && (d.amazon_step === 'verified' || hrs(d.started_at) >= 72)) out.push({ key: 'team_todo', side: 'team', every: 48, max: 3,
    text: () => `${N}: still open on our side: ${d.teamOpen.map((k) => TEAM_TODO[k]).join(', ')}. Anything I can tell him about it?` });
  const missing = [!d.arrive && 'start date', !d.company_id && 'company', !d.unit && 'truck'].filter(Boolean);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: db.settings.tz || 'America/Chicago' });
  if (d.arrive && d.arrive < today && !d.arrived) out.push({ key: 'arrived', side: 'team', every: 24, max: 3,
    text: () => `${N} was due to start ${esc(nice(d.arrive))}. Did he arrive?`, buttons: [[['✅ He arrived', `jr:${d.id}:arr`], ['Not yet', `jr:${d.id}:later:arrived`]]] });
  if (d.amazon_step === 'verified' && missing.length && !d.arrived) out.push({ key: 'missing', side: 'team', every: 24, max: 3,
    text: () => `${N} is verified on Amazon 🎉 We still need his ${missing.join(', ')}. Can you set ${missing.length > 1 ? 'them' : 'it'} on the website?` });
  if (d.arrived && d.orient && d.orient.total && !d.orient.open) out.push({ key: 'hire', side: 'team', every: 24, max: 2,
    text: () => `${N} finished orientation day ✓ Ready to mark him Hired on the website?` });
  // ---- the driver (not in Run mode: the onboarding bot already guides him there) ----
  if (live && mode !== 'run') {
    if (d.amazon_step === 'invite' && hrs(stepAt) >= 24) out.push({ key: 'd_invite', side: 'driver', every: 48, max: 2, text: (n, f) => pick(n, [
      `Hi ${f}! Just checking: did you get the Amazon Relay invite email? Let me know here once you've created your account 👍`,
      `${f}, any luck with the Amazon Relay invite? If you can't find the email, check spam, or tell me and we'll send it again.`]) });
    const facts = [!d.license_state && 'which state your CDL is from', !d.zip && 'your ZIP code'].filter(Boolean);
    if (facts.length && hrs(g.linked_at || d.started_at) >= 24) out.push({ key: 'd_facts', side: 'driver', every: 72, max: 2,
      text: (n, f) => `Hi ${f}! Quick one so we can order your MVR and book your drug test near you: ${facts.join(' and ')}?` });
    if (d.amazon_step !== 'verified' && hrs(d.spoke || g.linked_at || d.started_at) >= 72) out.push({ key: 'd_checkin', side: 'driver', every: 72, max: 2, text: (n, f) => pick(n, [
      `Hey ${f}, how is it going? Anything holding you up? I'm here if you need help with any step.`,
      `${f}, just checking in. Are you still with us? Tell me where you are with the Amazon steps and I'll help with the next one.`]) });
  }
  return out;
}

async function state(driverId) { return Object.fromEntries((await q(`SELECT * FROM journey_asks WHERE driver_id = $1`, [driverId])).rows.map((r) => [r.key, r])); }
const due = (it, s) => !s || ((!s.snooze_until || new Date(s.snooze_until) <= Date.now()) && s.count < it.max && hrs(s.last_at) >= it.every);

async function typing(chatId) { try { await bot.call('sendChatAction', { chat_id: chatId, action: 'typing' }); if (!process.env.TG_NO_QUIET) await new Promise((r) => setTimeout(r, 1500)); } catch (e) { /* no matter */ } }

async function tick() {
  if (!bot.state.me) return;
  const t = db.settings.tg || {}; if (t.teamFollowups === false) return;
  const h = +new Date().toLocaleString('en-US', { timeZone: db.settings.tz || 'America/Chicago', hour: 'numeric', hourCycle: 'h23' });
  if (!process.env.TG_NO_QUIET && (h < 9 || h >= 20)) return; // working hours only
  const teamChat = ((await q(`SELECT chat_id FROM tg_chats WHERE kind = 'management' AND active ORDER BY linked_at NULLS LAST LIMIT 1`)).rows[0] || {}).chat_id;
  const admins = (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id);
  let teamSent = 0, driverSent = 0;
  for (const d of await load()) {
    const items = owed(d); const st = await state(d.id);
    // done: forget it (a new gap later starts fresh)
    const keys = items.map((i) => i.key);
    for (const k of Object.keys(st)) if (!keys.includes(k)) await q(`DELETE FROM journey_asks WHERE driver_id = $1 AND key = $2`, [d.id, k]);
    // tried enough: the admins hear once
    for (const it of items) {
      const s = st[it.key];
      if (s && s.count >= it.max && !s.done_at && hrs(s.last_at) >= it.every) {
        for (const id of admins) await db.notify(db.pool, id, 'telegram', `${d.name}: I followed up ${it.max} times and it is still open: ${bot.stripHtml(it.text(0, first(d.name)))}`, `#/driver/${d.id}`, { driverId: d.id });
        await q(`UPDATE journey_asks SET done_at = now() WHERE driver_id = $1 AND key = $2`, [d.id, it.key]);
      }
    }
    // one thing at a time on each side, like a person would; never a wall of messages
    for (const side of ['team', 'driver']) {
    const it = items.find((x) => x.side === side && due(x, st[x.key])); if (!it) continue;
    if (side === 'team' && teamSent >= 4) continue;
    if (side === 'driver' && driverSent >= 8) continue;
    const n = st[it.key] ? st[it.key].count : 0;
    if (it.side === 'team') {
      const tag = await require('./team').who(d.owner_id, d.owner);
      if (teamChat) { await typing(teamChat); await bot.send(teamChat, `${tag}, ${it.text(n, first(d.name))}`, it.buttons ? { buttons: it.buttons } : {}); }
      else if (d.owner_id) await db.notify(db.pool, d.owner_id, 'telegram', bot.stripHtml(it.text(n, first(d.name))), `#/driver/${d.id}`, { driverId: d.id });
      else continue; // nobody to tell
      teamSent++;
    } else {
      const text = it.text(n, esc(first(d.name)));
      const mode = d.bot_mode || t.onbMode || 'watch';
      if (mode === 'watch') {
        await q(`UPDATE tg_drafts SET state = 'replaced', decided_at = now() WHERE chat_id = $1 AND state = 'open' AND kind = 'remind' AND driver_text LIKE 'Follow-up:%'`, [d.group.chat_id]);
        await q(`INSERT INTO tg_drafts (chat_id, driver_id, driver_text, draft, kind) VALUES ($1, $2, $3, $4, 'remind')`, [d.group.chat_id, d.id, `Follow-up: ${it.key.slice(2)}`, bot.stripHtml(text)]);
      } else { await typing(d.group.chat_id); await bot.send(d.group.chat_id, text); }
      driverSent++;
    }
    await q(`INSERT INTO journey_asks (driver_id, key, count, last_at) VALUES ($1, $2, 1, now()) ON CONFLICT (driver_id, key) DO UPDATE SET count = journey_asks.count + 1, last_at = now(), snooze_until = NULL`, [d.id, it.key]);
    await bot.log('ask', `Follow-up (${it.side === 'team' ? 'team' : 'driver'}): ${bot.stripHtml(it.text(n, first(d.name)))}`, { chatId: it.side === 'team' ? teamChat || null : d.group.chat_id, driverId: d.id }).catch(() => {});
    }
  }
}

// The team's answers in the management group
async function onButton(cq, who) {
  if (!bot.isStaff(who)) return 'Only our team can answer this.';
  const [, did, act, arg] = cq.data.split(':'); const id = +did;
  const d = (await q(`SELECT id, name FROM drivers WHERE id = $1`, [id])).rows[0]; if (!d) return 'This driver is gone.';
  const chat = cq.message.chat.id; const mid = cq.message.message_id; const by = who.name;
  const reply = async (t) => { await bot.dropButtons(chat, mid); await bot.send(chat, t, { replyTo: mid }); };
  const history = (t) => require('../lib').history(id, t, by, 'telegram').catch(() => {});
  if (act === 'later') {
    await q(`UPDATE journey_asks SET snooze_until = now() + interval '24 hours' WHERE driver_id = $1 AND key = $2`, [id, arg]);
    await reply(`👍 OK, I'll check again tomorrow.`); return 'OK';
  }
  if (act === 'ver' || act === 'inv') {
    const key = act === 'ver' ? 'verified' : 'invite';
    if (await db.amazonTo(db.pool, id, key, null)) {
      await history(`Amazon: ${AMZ[key].long} (Telegram, ${by})`);
      if (key === 'verified') await require('../needed').check(id).catch(() => {});
    }
    await q(`DELETE FROM journey_asks WHERE driver_id = $1 AND key = $2`, [id, act === 'ver' ? 'verified' : 'invite']);
    await reply(act === 'ver' ? `Great news, thanks ${esc(first(by))}! Marked ${esc(d.name)} verified ✓` : `Thanks ${esc(first(by))}! Noted the invite went out to ${esc(d.name)} ✓`);
    return 'Saved ✓';
  }
  if (act === 'arr') {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: db.settings.tz || 'America/Chicago' });
    await q(`UPDATE onboarding SET arrived_on = $2 WHERE driver_id = $1 AND arrived_on IS NULL`, [id, today]);
    await db.syncAuto(db.pool, id, who.user_id || null); await history('Arrived (Telegram)');
    await reply(`Thanks! ${esc(d.name)} is marked arrived ✓ Orientation day starts now.`); return 'Saved ✓';
  }
  if (act === 'who' || act === 'whonone') {
    const whois = require('./whois'); const c = (await whois.candidates([id]))[id];
    const list = act === 'whonone' ? whois.toAsk(c) : c.people.filter((p) => p.tgId === String(arg));
    if (!list.length) { await bot.dropButtons(chat, mid); return 'Already settled.'; }
    for (const p of list) await whois.answer(id, p.tgId, act === 'who' ? 'driver' : 'not');
    await history(act === 'who' ? `Telegram: ${list[0].name} is the driver's account` : `Telegram: ${list.map((p) => p.name).join(', ')} not the driver`);
    await reply(act === 'who' ? `Got it, ${esc(list[0].name)} is ${esc(d.name)} ✓` : `OK, none of them. I'll ask again when someone new writes.`);
    return 'Saved ✓';
  }
  return '';
}

function start() { setInterval(() => tick().catch((e) => console.error('journey tick', e.message)), +process.env.TG_JOURNEY_MS || 10 * 60000); }
module.exports = { start, tick, owed, onButton };
