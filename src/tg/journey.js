// Follow-ups along the driver's journey. For every lead at the Relay invite and every driver in onboarding the bot looks
// at what is still missing and who owes it, and follows up with that side the way a person would: one thing at a time,
// by first name, never twice too soon, and it stops by itself once the thing is done.
// - our team (in the management group, tagging the recruiter, in that recruiter's working hours; a website notice when there is no
//   management group): Relay invite sent? signed up? verified yet? no Telegram group, the bot removed or not an admin,
//   the driver has not joined his group, which account is the driver, what is still open on our side (insurance, MVR, contract, Clearinghouse, ELD,
//   accounting, bank), once he is verified: is a truck available for him (never "set the company or the truck":
//   the team decides those after Amazon verifies him), did he arrive, ready to hire. Answered with the buttons or
//   by replying to the bot's message in words ("yes", "not yet", "done").
// - the driver (in his group, 9:00 to 20:00): the Relay invite, his CDL state and ZIP, a check-in when he goes quiet.
//   Sent in "Answer questions"; in "Watch and learn" it waits on his page as a reply ready to send; "Run" has its own.
// After the last try the admins get a website notice. Switched off with the team follow-ups (Telegram → Team).
const db = require('../db');
const bot = require('./bot');
const learn = require('./learn');
const { q } = db; const { esc } = bot;

const H = 36e5;
const hrs = (t) => (t ? (Date.now() - new Date(t)) / H : 0);
const ago = (t) => { const h = hrs(t); return h < 48 ? `${Math.max(1, Math.round(h))} h ago` : `${Math.round(h / 24)} days ago`; };
const first = (n) => String(n || '').trim().split(/\s+/)[0];
const nice = (d) => require('../lib').niceDate(String(d).slice(0, 10));
const AMZ = Object.fromEntries(db.AMAZON.map((a) => [a.key, a]));
const TEAM_TODO = { insurance: 'insurance approval', mvr: 'the MVR check', contract_sent: 'sending the contract', ch_query: 'the Clearinghouse query',
  eld_group: 'the ELD group', eld_profile: 'the ELD setup', acct_group: 'the accounting group', bank: 'his bank details' };
const LEADS = ['Relay invite sent', 'Signed up on Relay']; // not in onboarding yet: only the Amazon steps are followed up
const pick = (n, list) => list[n % list.length]; // a different wording on the next try

async function load() {
  const ds = (await q(`SELECT d.id, d.name, d.status, d.owner_id, u.name owner, d.amazon_step, d.amazon_log, d.zip, d.license_state, d.company_id, d.status_at,
      o.started_at, o.expected_arrival arrive, o.arrived_on arrived, c.mode bot_mode
    FROM drivers d LEFT JOIN onboarding o ON o.driver_id = d.id LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN onb_cases c ON c.driver_id = d.id
    WHERE (d.status = 'Onboarding' AND o.driver_id IS NOT NULL OR d.status IN ('Relay invite sent', 'Signed up on Relay')) AND d.left_on IS NULL ORDER BY d.id`)).rows; // = LEADS
  if (!ds.length) return [];
  const ids = ds.map((d) => d.id);
  const groups = (await q(`SELECT driver_id, chat_id::text chat_id, active, bot_admin, linked_at, invite_link FROM tg_chats WHERE kind = 'dispatch' AND driver_id = ANY($1::int[]) ORDER BY active DESC, linked_at DESC NULLS LAST`, [ids])).rows;
  const units = (await q(`SELECT driver_id, unit FROM trucks WHERE driver_id = ANY($1::int[])`, [ids])).rows;
  const open = (await q(`SELECT driver_id, key FROM checklist WHERE driver_id = ANY($1::int[]) AND NOT done AND key = ANY($2::text[])`, [ids, Object.keys(TEAM_TODO)])).rows;
  const orient = (await q(`SELECT driver_id, count(*)::int total, count(*) FILTER (WHERE NOT done)::int open FROM orientation WHERE driver_id = ANY($1::int[]) GROUP BY driver_id`, [ids])).rows;
  const spoke = (await q(`SELECT c.driver_id, max(m.at) at FROM tg_chats c JOIN tg_messages m ON m.chat_id = c.chat_id JOIN tg_people p ON p.tg_id = m.from_id AND p.role = 'driver' AND p.driver_id = c.driver_id
    WHERE c.driver_id = ANY($1::int[]) GROUP BY c.driver_id`, [ids])).rows;
  const who = await require('./whois').candidates(ids);
  const day = (v) => (!v ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)); // dates are plain text (db.js)
  const typ = await require('./learn').typical().catch(() => ({}));
  const emptyTrucks = +((await q(`SELECT count(*)::int n FROM trucks WHERE driver_id IS NULL AND driver_name IS NULL AND NOT out_of_service`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0] || {}).n || 0;
  return ds.map((d) => ({ ...d, typ, emptyTrucks, lead: d.status !== 'Onboarding', arrive: day(d.arrive), arrived: day(d.arrived), group: groups.find((g) => g.driver_id === d.id) || null, unit: (units.find((u) => u.driver_id === d.id) || {}).unit || null,
    teamOpen: open.filter((x) => x.driver_id === d.id).map((x) => x.key).sort((a, b) => Object.keys(TEAM_TODO).indexOf(a) - Object.keys(TEAM_TODO).indexOf(b)), // checklist order orient: orient.find((x) => x.driver_id === d.id) || null,
    spoke: (spoke.find((x) => x.driver_id === d.id) || {}).at || null, who: who[d.id] }));
}

// What is missing for one driver, and whose move it is. every: hours between tries; max: tries before the admins hear.
// yes / no: what a typed answer ("yes", "not yet") to the bot's message does, like the buttons.
function owed(d) {
  const out = []; const N = esc(d.name); const g = d.group; const live = g && g.active;
  const stepAt = d.amazon_step && d.amazon_log ? d.amazon_log[d.amazon_step] : null;
  const since = d.started_at || d.status_at;
  const mode = d.bot_mode || (db.settings.tg || {}).onbMode || 'watch';
  // ---- Amazon Relay (leads and onboarding) ----
  if (!d.lead && !d.amazon_step && hrs(since) >= 24) out.push({ key: 'invite', side: 'team', every: 24, max: 3, yes: 'inv',
    text: () => `Has the Amazon Relay invite gone out to ${N}? I don't see it yet.`, buttons: [[['✅ Sent', `jr:${d.id}:inv`], ['Not yet', `jr:${d.id}:later:invite`]]] });
  if (d.amazon_step === 'invite' && hrs(stepAt || since) >= 24) out.push({ key: 'signed', side: 'team', every: 24, max: 4, yes: 'sign',
    text: (n) => pick(n, [`${N} got the Amazon Relay invite ${ago(stepAt || since)}. Has he signed up yet?`, `Any news from ${N}? Did he sign up on Amazon Relay?`]),
    buttons: [[['✅ Signed up', `jr:${d.id}:sign`], ['Not yet', `jr:${d.id}:later:signed`]]] });
  if (['account', 'profile', 'accurate', 'waiting'].includes(d.amazon_step) && hrs(stepAt || since) >= 24) out.push({ key: 'verified', side: 'team', every: 48, max: 5, yes: 'ver',
    text: (n) => pick(n, [`Is ${N}'s Amazon Relay account verified yet? Last step: ${esc(AMZ[d.amazon_step].long.toLowerCase())}${stepAt ? `, ${ago(stepAt)}` : ''}.`,
      `Checking in on ${N}: has Amazon verified him yet?`]),
    buttons: [[['✅ Verified', `jr:${d.id}:ver`], ['⏳ Not yet', `jr:${d.id}:later:verified`]]] });
  // slipping: longer on this step than three in four of the drivers who got verified (learned from our own history)
  const t = d.typ && d.typ[d.amazon_step]; const onStep = hrs(stepAt);
  const span = (h) => (h < 36 ? `${Math.max(1, Math.round(h))} hours` : `${Math.round(h / 24)} days`);
  if (t && stepAt && ['invite', 'account', 'profile', 'accurate'].includes(d.amazon_step) && onStep > Math.max(12, t.slow)) out.push({ key: 'at_risk', side: 'team', every: 48, max: 2,
    text: () => `${N} has been on "${esc(AMZ[d.amazon_step].label)}" for ${span(onStep)}. Drivers who made it took about ${span(t.median)} here, so he may be slipping. Worth a call today.` });
  if (d.lead) return out; // a lead: nothing else is expected yet (no group, no checklist)
  // ---- our team: the group and the bot ----
  if (!g && hrs(since) >= 2) out.push({ key: 'no_group', side: 'team', every: 24, max: 3, text: (n) => pick(n, [
    `${N} is in onboarding but has no Telegram group yet. Can you create one and add me to it?`,
    `Still no Telegram group for ${N}. Could you make one and add me, so I can help him through the steps?`]) });
  if (g && !g.active) out.push({ key: 'bot_removed', side: 'team', every: 24, max: 3, text: () => `I'm not in ${N}'s group any more (someone removed me). Could you add me back?` });
  if (live && g.bot_admin === false && hrs(g.linked_at || since) >= 1) out.push({ key: 'bot_admin', side: 'team', every: 48, max: 2,
    text: () => `I'm in ${N}'s group but not an admin, so I can miss his messages. Can you make me an admin? (Group settings → Administrators → Add admin)` });
  // the group is there but nobody from his side is in it: he has not joined (maybe Telegram is not installed)
  if (live && d.who && !d.who.people.length && hrs(g.linked_at || since) >= 6) out.push({ key: 'not_joined', side: 'team', every: 24, max: 3, text: (n) => pick(n, [
    `I don't see ${N} in his Telegram group yet: nobody from his side has joined or written. Has he installed Telegram? ${g.invite_link ? `Here is the invite link to send him: ${esc(g.invite_link)}` : 'Please send him the invite link to the group.'}`,
    `Still nobody from ${N}'s side in his Telegram group. Can you check he has Telegram (same number he gave us) and send him the link${g.invite_link ? `: ${esc(g.invite_link)}` : ''}?`]) });
  const ask = live ? require('./whois').toAsk(d.who) : [];
  if (live && ask.length && !(d.who && d.who.linked.length) && hrs(g.linked_at || since) >= 6) out.push({ key: 'who_driver', side: 'team', every: 24, max: 3,
    text: () => `Which one is ${N} in his group? I want to make sure I talk to the right person.`,
    buttons: [ask.map((p) => [p.name.slice(0, 30), `jr:${d.id}:who:${p.tgId}`]), [['None of them', `jr:${d.id}:whonone`]]] });
  // ---- our team: steps and facts ----
  if (d.teamOpen.length && (d.amazon_step === 'verified' || hrs(since) >= 72)) out.push({ key: 'team_todo', side: 'team', every: 48, max: 3,
    text: () => `${N}: still open on our side: ${d.teamOpen.map((k) => TEAM_TODO[k]).join(', ')}. Anything I can tell him about it?` });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: db.settings.tz || 'America/Chicago' });
  if (d.arrive && d.arrive < today && !d.arrived) out.push({ key: 'arrived', side: 'team', every: 24, max: 3, yes: 'arr',
    text: () => `${N} was due to start ${esc(nice(d.arrive))}. Did he arrive?`, buttons: [[['✅ He arrived', `jr:${d.id}:arr`], ['Not yet', `jr:${d.id}:later:arrived`]]] });
  // The company and the truck are decided by the team after Amazon verifies him: the bot never asks to set them.
  // Once he is verified and ready to roll, it only checks with the recruiter that a truck is available for him.
  const ready = d.amazon_step === 'verified' && !d.arrived;
  const upcoming = d.arrive && d.arrive >= today;
  const empties = d.emptyTrucks ? ` (${d.emptyTrucks} empty right now)` : '';
  if (ready && !d.unit) out.push({ key: 'truck_check', side: 'team', every: 48, max: 3, text: (n) => pick(n, [
    `${N} is verified on Amazon and ready to roll 🎉${upcoming ? ` He starts ${esc(nice(d.arrive))}.` : ''} Do you have a truck available for him${empties}?`,
    `Checking again on ${N}: he is verified${upcoming ? ` and starts ${esc(nice(d.arrive))}` : ''}. Is there a truck for him${empties}?`]) });
  if (ready && d.unit && !d.arrive) out.push({ key: 'missing', side: 'team', every: 48, max: 2,
    text: () => `${N} is verified on Amazon and has truck ${esc(d.unit)}. When does he start?` });
  if (d.arrived && d.orient && d.orient.total && !d.orient.open) out.push({ key: 'hire', side: 'team', every: 24, max: 2,
    text: () => `${N} finished orientation day ✓ Ready to mark him Hired on the website?` });
  // ---- the driver (not in Run mode: the onboarding bot already guides him there) ----
  if (live && mode !== 'run') {
    if (d.amazon_step === 'invite' && hrs(stepAt) >= 24) out.push({ key: 'd_invite', side: 'driver', every: 48, max: 2, nv: 2, text: (n, f) => pick(n, [
      `Hi ${f}! Just checking: did you get the Amazon Relay invite email? Let me know here once you've created your account 👍`,
      `${f}, any luck with the Amazon Relay invite? If you can't find the email, check spam, or tell me and we'll send it again.`]) });
    const facts = [!d.license_state && 'which state your CDL is from', !d.zip && 'your ZIP code'].filter(Boolean);
    if (facts.length && hrs(g.linked_at || since) >= 24) out.push({ key: 'd_facts', side: 'driver', every: 72, max: 2,
      text: (n, f) => `Hi ${f}! Quick one so we can order your MVR and book your drug test near you: ${facts.join(' and ')}?` });
    if (d.amazon_step !== 'verified' && hrs(d.spoke || g.linked_at || since) >= 72) out.push({ key: 'd_checkin', side: 'driver', every: 72, max: 2, nv: 2, text: (n, f) => pick(n, [
      `Hey ${f}, how is it going? Anything holding you up? I'm here if you need help with any step.`,
      `${f}, just checking in. Are you still with us? Tell me where you are with the Amazon steps and I'll help with the next one.`]) });
  }
  // what matters most first: without his group and the bot in it nothing else works
  const ORDER = ['no_group', 'bot_removed', 'bot_admin', 'not_joined', 'arrived', 'at_risk', 'invite', 'signed', 'verified', 'who_driver', 'truck_check', 'missing', 'team_todo', 'hire'];
  return out.sort((a, b) => (ORDER.indexOf(a.key) + 1 || 99) - (ORDER.indexOf(b.key) + 1 || 99));
}

async function state(driverId) { return Object.fromEntries((await q(`SELECT * FROM journey_asks WHERE driver_id = $1`, [driverId])).rows.map((r) => [r.key, r])); }
const due = (it, s) => !s || ((!s.snooze_until || new Date(s.snooze_until) <= Date.now()) && s.count < it.max && hrs(s.last_at) >= it.every);

async function typing(chatId) { try { await bot.call('sendChatAction', { chat_id: chatId, action: 'typing' }); if (!process.env.TG_NO_QUIET) await new Promise((r) => setTimeout(r, 1500)); } catch (e) { /* no matter */ } }

async function tick() {
  if (!bot.state.me) return;
  const t = db.settings.tg || {}; if (t.teamFollowups === false) return;
  if (bot.paused()) return; // paused everywhere (Telegram → Autopilot)
  // our team works around the clock; drivers hear from the bot only in the daytime
  const h = +new Date().toLocaleString('en-US', { timeZone: db.settings.tz || 'America/Chicago', hour: 'numeric', hourCycle: 'h23' });
  const daytime = !!process.env.TG_NO_QUIET || (h >= 9 && h < 20);
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
    // one thing at a time on each side, like a person would; never a wall of messages, and a pause between two things
    // about the same driver (the team: 6 hours, the driver: a day)
    const sideOf = Object.fromEntries(items.map((x) => [x.key, x.side]));
    const lastOn = (side) => Math.max(0, ...Object.values(st).filter((s) => (sideOf[s.key] || (s.key.startsWith('d_') ? 'driver' : 'team')) === side && s.last_at).map((s) => +new Date(s.last_at)));
    for (const side of ['team', 'driver']) {
      if (side === 'driver' && !daytime) continue;
      if (side === 'driver' && !process.env.TG_NO_QUIET && !(await learn.goodTime(d.id, h))) continue; // when he is usually around
      if (lastOn(side) && hrs(lastOn(side)) < (side === 'team' ? 6 : 24)) continue;
      const it = items.find((x) => x.side === side && due(x, st[x.key])); if (!it) continue;
      if (side === 'team' && teamSent >= 4) continue;
      if (side === 'team' && !(await require('../working').working(d.owner_id))) continue; // the recruiter is tagged only in their working hours: it waits
      if (side === 'driver' && driverSent >= 8) continue;
      // the wording: for the driver, the one that got more replies so far (tg/learn.js); for the team, the next one each time
      const n = side === 'driver' && it.nv ? await learn.choose('followup:' + it.key, it.nv) : st[it.key] ? st[it.key].count : 0; let msgId = null;
      if (side === 'team') {
        const tag = await require('./team').who(d.owner_id, d.owner);
        if (teamChat) { await typing(teamChat); const m = await bot.send(teamChat, `${tag}, ${it.text(n, first(d.name))}`, it.buttons ? { buttons: it.buttons } : {}); msgId = m && m.message_id; await learn.record({ driverId: d.id, kind: 'team:' + it.key }).catch(() => {}); if (it.key === 'at_risk') await learn.flag(d.id).catch(() => {}); }
        else if (d.owner_id) await db.notify(db.pool, d.owner_id, 'telegram', bot.stripHtml(it.text(n, first(d.name))), `#/driver/${d.id}`, { driverId: d.id });
        else continue; // nobody to tell
        teamSent++;
      } else {
        const text = it.text(n, esc(first(d.name)));
        const mode = d.bot_mode || t.onbMode || 'watch';
        if (mode === 'watch') {
          await q(`UPDATE tg_drafts SET state = 'replaced', decided_at = now() WHERE chat_id = $1 AND state = 'open' AND kind = 'remind' AND driver_text LIKE 'Follow-up:%'`, [d.group.chat_id]);
          await q(`INSERT INTO tg_drafts (chat_id, driver_id, driver_text, draft, kind, variant) VALUES ($1, $2, $3, $4, 'remind', $5)`, [d.group.chat_id, d.id, `Follow-up: ${it.key.slice(2)}`, bot.stripHtml(text), n]);
        } else { await typing(d.group.chat_id); await bot.send(d.group.chat_id, text); await learn.record({ driverId: d.id, kind: 'followup:' + it.key, variant: n }).catch(() => {}); }
        driverSent++;
      }
      await q(`INSERT INTO journey_asks (driver_id, key, count, last_at, msg_id) VALUES ($1, $2, 1, now(), $3) ON CONFLICT (driver_id, key) DO UPDATE SET count = journey_asks.count + 1, last_at = now(), snooze_until = NULL, msg_id = coalesce($3, journey_asks.msg_id)`, [d.id, it.key, msgId]);
      await bot.log('ask', `Follow-up (${side}): ${bot.stripHtml(it.text(n, first(d.name)))}`, { chatId: side === 'team' ? teamChat || null : d.group.chat_id, driverId: d.id }).catch(() => {});
    }
  }
}

// ---------- the team's answers: a button, or a reply in words ----------
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: db.settings.tz || 'America/Chicago' });
// what the answer does; returns the bot's reply
async function act(id, what, arg, who) {
  const d = (await q(`SELECT id, name, status FROM drivers WHERE id = $1`, [id])).rows[0]; if (!d) return null;
  const by = who.name; const N = esc(d.name);
  const history = (t) => require('../lib').history(id, t, by, 'telegram').catch(() => {});
  const forget = (key) => q(`DELETE FROM journey_asks WHERE driver_id = $1 AND key = $2`, [id, key]);
  if (what === 'later') { await q(`UPDATE journey_asks SET snooze_until = now() + interval '24 hours' WHERE driver_id = $1 AND key = $2`, [id, arg]); return `👍 OK, I'll check again tomorrow.`; }
  if (what === 'inv' || what === 'ver') {
    const key = what === 'ver' ? 'verified' : 'invite';
    if (await db.amazonTo(db.pool, id, key, who.user_id || null)) {
      await history(`Amazon: ${AMZ[key].long} (Telegram, ${by})`);
      if (key === 'verified') await require('../needed').check(id).catch(() => {});
    }
    await forget(what === 'ver' ? 'verified' : 'invite');
    if (what === 'inv') return `Thanks ${esc(first(by))}! Noted the invite went out to ${N} ✓`;
    return `Great news, thanks ${esc(first(by))}! Marked ${N} verified ✓${LEADS.includes(d.status) ? ' Move him to Onboarding on the website when you are ready.' : ''}`;
  }
  if (what === 'sign') {
    if (d.status === 'Relay invite sent') {
      await q(`UPDATE drivers SET status = 'Signed up on Relay', status_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await db.statusChanged(db.pool, d, 'Signed up on Relay', { userId: who.user_id || null, via: 'telegram' });
    } else await db.amazonTo(db.pool, id, 'profile', who.user_id || null);
    await history(`Amazon: signed up on Relay (Telegram, ${by})`); await forget('signed');
    return `Nice, thanks! ${N} signed up on Relay ✓ I'll check with you about his verification.`;
  }
  if (what === 'arr') {
    await q(`UPDATE onboarding SET arrived_on = $2 WHERE driver_id = $1 AND arrived_on IS NULL`, [id, today()]);
    await db.syncAuto(db.pool, id, who.user_id || null); await history('Arrived (Telegram)'); await forget('arrived');
    return `Thanks! ${N} is marked arrived ✓ Orientation day starts now.`;
  }
  if (what === 'who' || what === 'whonone') {
    const whois = require('./whois'); const c = (await whois.candidates([id]))[id];
    const list = what === 'whonone' ? whois.toAsk(c) : c.people.filter((p) => p.tgId === String(arg));
    if (!list.length) return 'Already settled.';
    for (const p of list) await whois.answer(id, p.tgId, what === 'who' ? 'driver' : 'not');
    await history(what === 'who' ? `Telegram: ${list[0].name} is the driver's account` : `Telegram: ${list.map((p) => p.name).join(', ')} not the driver`);
    return what === 'who' ? `Got it, ${esc(list[0].name)} is ${N} ✓` : `OK, none of them. I'll ask again when someone new writes.`;
  }
  return null;
}
async function onButton(cq, who) {
  if (!bot.isStaff(who)) return 'Only our team can answer this.';
  const [, did, what, arg] = cq.data.split(':');
  const chat = cq.message.chat.id; const mid = cq.message.message_id;
  const r = await act(+did, what, arg, who);
  await learn.teamAnswered(+did, what === 'later' ? arg : { inv: 'invite', ver: 'verified', sign: 'signed', arr: 'arrived', who: 'who_driver', whonone: 'who_driver' }[what], who.name).catch(() => {});
  await bot.dropButtons(chat, mid);
  if (!r) return 'This driver is gone.';
  if (r === 'Already settled.') return r;
  await bot.send(chat, r, { replyTo: mid });
  return what === 'later' ? 'OK' : 'Saved ✓';
}
// A reply in words to one of the bot's follow-ups in the management group
const NO = /\b(not yet|no|nope|not|still|waiting|pending|tomorrow|later|didn'?t|hasn'?t|haven'?t|nothing)\b/i;
const YES = /\b(yes|yep|yeah|ya|yup|done|sent|verified|approved|arrived|here|signed( up)?|fixed|set|added|ok(ay)?|sure|of course|already)\b|✅|👍/i;
async function fromReply(chat, m, who) {
  const r = m.reply_to_message; if (!r || !bot.isStaff(who)) return false;
  const a = (await q(`SELECT * FROM journey_asks WHERE msg_id = $1`, [r.message_id])).rows[0]; if (!a) return false;
  const text = String(m.text || '');
  const it = (await load()).filter((d) => d.id === a.driver_id).flatMap(owed).find((x) => x.key === a.key);
  let out; const no = NO.test(text), yes = YES.test(text);
  if (no && !yes) out = await act(a.driver_id, 'later', a.key, who);
  else if (yes && !no) {
    if (it && it.yes) out = await act(a.driver_id, it.yes, null, who);
    else { await q(`UPDATE journey_asks SET snooze_until = now() + interval '12 hours' WHERE driver_id = $1 AND key = $2`, [a.driver_id, a.key]); out = `Thanks ${esc(first(who.name))}! 👍`; }
  } else return false; // not an answer: leave it to the rest of the bot
  await learn.teamAnswered(a.driver_id, a.key, who.name).catch(() => {});
  if (it && it.buttons) await bot.dropButtons(chat.chat_id, r.message_id);
  if (out) await bot.send(chat.chat_id, out, { replyTo: m.message_id });
  return true;
}

function start() { setInterval(() => tick().catch((e) => console.error('journey tick', e.message)), +process.env.TG_JOURNEY_MS || 10 * 60000); }
module.exports = { start, tick, load, owed, onButton, fromReply };
