// The case playbook: what to do, step by step, when something happens on the road (a breakdown, a breakdown on the
// NJ Turnpike, an accident, running late, out of hours...). Each playbook has ordered steps (what the dispatcher does,
// what to tell the driver, how long it may wait) and if/else rules.
// While reading a working driver's group (no extra AI call) the AI says when a case starts and which steps the messages
// show done. The bot then:
// - opens the case on the website (open cases: dashboard, trucks, the group, the driver), tells the truck's dispatcher
// - writes the message to the driver for the next step: waiting on the website (Watch) or sent in the group (Updater)
// - raises it with the dispatcher and the admins when a step waits longer than it should
// - when the case is over, keeps what was learned (to approve in Knowledge) so the playbook gets better
// The team edits the playbooks (Telegram → Playbook).
const db = require('../db');
const { q } = db;

// Starting set. The team changes them; the bot never changes a playbook by itself.
const STARTERS = [
  { key: 'breakdown_toll_road', title: 'Breakdown on the NJ Turnpike or Garden State Parkway',
    when: 'The truck broke down or cannot go on while ON the New Jersey Turnpike or the Garden State Parkway (also when the driver mentions a Turnpike or Parkway mile marker).',
    steps: [
      { text: 'Make sure the driver is safe: hazards on, triangles out, as far off the lane as possible. Ask if the truck can still move.', driver: 'Are you safe? Hazards on and triangles out, please. Can the truck still move at all?', wait: 10 },
      { text: 'If the truck CAN move: get it off the Turnpike/Parkway to the nearest safe place (service area, the first exit after the toll, a truck stop) and get the new location.', driver: 'Do not wait for road service on the Turnpike shoulder: outside road services cannot come there. If the truck can move safely, take it to the nearest service area or the first exit and send me your location.', wait: 30 },
      { text: 'Truck off the Turnpike: call road service (Amazon road service for Amazon loads, or our provider) for the new location. Share the ETA in the group.', driver: '', wait: 30 },
      { text: 'If the truck CANNOT move: call #95 (Turnpike) or #GSP / #477 (Parkway). Only Turnpike-authorized garages may tow or repair there; they tow to their garage at the Authority\'s set rates. Then plan the repair from that garage.', driver: 'Since the truck cannot move: call #95 (Turnpike) or #477 (Parkway) for the authorized tow, and tell us when they give you a time.', wait: 30 },
      { text: 'Tell Amazon / the broker about the delay and the new ETA; move or recover the load if it cannot make it.', driver: '', wait: 60 },
      { text: 'Follow up every 2 hours until the truck is rolling. Write down the shop, the cost and the mileage.', driver: 'Any update on the repair? Send the shop name and the ETA when you have it.', wait: 120 }],
    rules: ['If he is on the NJ Turnpike or the Garden State Parkway: never leave him waiting on the shoulder for Amazon or outside road service; they will not come there.',
      'If the truck can move safely: move it off first, then call road service.', 'If it cannot move: authorized tow through #95 / #477 only.',
      'If road service is 2 hours past its ETA: call a second provider.', 'If the driver runs out of hours: he takes his 10-hour break at the shop or the truck stop.'] },
  { key: 'breakdown', title: 'Breakdown',
    when: 'The truck cannot go on or should not go on: engine problem, derate, red warning light, air leak, electrical, it will not start (not a flat tire, not on the NJ Turnpike or Parkway).',
    steps: [
      { text: 'Driver safe and off the road; get the exact location (exit, mile marker or pin).', driver: 'Are you safe and off the road? Send me your location pin please.', wait: 10 },
      { text: 'Get photos of the dash (lights, codes) and what happened.', driver: 'Send a photo of the dash with the lights or codes, please.', wait: 20 },
      { text: 'Decide: can it drive to a shop safely (only if no red / stop-engine light)? If yes, the nearest shop. If no, road service or a tow.', driver: '', wait: 20 },
      { text: 'Road service or shop booked; share the ETA in the group.', driver: '', wait: 45 },
      { text: 'Tell Amazon / the broker about the delay and the new ETA; recover the load if needed.', driver: '', wait: 60 },
      { text: 'Follow up every 2 hours until rolling; write down the shop, cost and mileage.', driver: 'Any update from the shop? Send the ETA when you have it.', wait: 120 }],
    rules: ['If a red or stop-engine light is on: he does not drive.', 'If he is on the NJ Turnpike or Garden State Parkway: use that playbook instead.',
      'If road service is 2 hours past its ETA: call a second provider.', 'If the load will miss its time: tell Amazon / the broker before the appointment, not after.'] },
  { key: 'flat_tire', title: 'Flat tire or blowout',
    when: 'A flat tire, a blowout, low tire pressure that cannot hold, or a damaged tire.',
    steps: [
      { text: 'Driver safe, off the road; which tire (steer, drive, trailer) and a photo.', driver: 'Are you safe? Which tire is it (steer, drive or trailer)? Send a photo please.', wait: 10 },
      { text: 'Tire road service called with the location and tire size; share the ETA.', driver: '', wait: 30 },
      { text: 'Tell Amazon / the broker if the load will be late.', driver: '', wait: 60 },
      { text: 'Tire fixed: cost and shop written down, driver rolling.', driver: '', wait: 180 }],
    rules: ['If it is a steer tire: he does not drive on it at all.', 'If he is on the NJ Turnpike or Garden State Parkway: authorized service only (#95 / #477).'] },
  { key: 'accident', title: 'Accident',
    when: 'The truck hit something or was hit, any crash or damage to another vehicle or property.',
    steps: [
      { text: 'Anyone hurt? If yes, 911 first. Driver safe, hazards and triangles.', driver: 'Is anyone hurt? If yes, call 911 right now. Hazards on and triangles out.', wait: 5 },
      { text: 'Police called and the report number taken.', driver: 'Please call the police so there is a report, and send me the report number.', wait: 30 },
      { text: 'Photos: all vehicles, damage, plates, the scene; the other driver\'s name, insurance and phone.', driver: 'Send photos of both vehicles, the damage, the plates and the scene, and the other driver\'s insurance card.', wait: 30 },
      { text: 'Safety / insurance told right away (an admin). Ask safety whether a post-accident drug and alcohol test is needed.', driver: '', wait: 30 },
      { text: 'Can the truck go on? If not, use the breakdown steps. Tell Amazon / the broker.', driver: '', wait: 60 }],
    rules: ['The driver never admits fault at the scene; he gives facts to the police.', 'If the truck cannot move: breakdown steps (Turnpike rules if he is on the Turnpike).'] },
  { key: 'running_late', title: 'Running late to pickup or delivery',
    when: 'The driver will miss or may miss a pickup or delivery time (traffic, slept late, the shipper was slow, hours).',
    steps: [
      { text: 'Get his real ETA and the reason.', driver: 'What is your real ETA, and what is holding you up?', wait: 15 },
      { text: 'Tell Amazon / the broker BEFORE the appointment and ask for a new time.', driver: '', wait: 30 },
      { text: 'New time confirmed and shared with the driver.', driver: '', wait: 60 }],
    rules: ['If his hours will not allow it: plan the break, never push him past his hours.', 'If the new time is not possible: ask about moving the load to another truck.'] },
  { key: 'out_of_hours', title: 'Out of hours (HOS)',
    when: 'The driver is close to or out of driving hours (11 / 14 hour, 70 hour) or needs his 10-hour break before the load is done.',
    steps: [
      { text: 'Check his hours left on the ELD.', driver: 'How many hours do you have left on the ELD?', wait: 15 },
      { text: 'Find safe parking before his hours run out.', driver: '', wait: 30 },
      { text: 'Tell Amazon / the broker about the new ETA after his break.', driver: '', wait: 60 }],
    rules: ['Never ask a driver to drive past his hours or to change his logs.'] },
  { key: 'detention', title: 'Waiting at the shipper or receiver (detention)',
    when: 'The driver is waiting long at a shipper, receiver or Amazon site (not loaded or unloaded yet).',
    steps: [
      { text: 'Write down when he arrived and checked in.', driver: 'What time did you arrive and check in? Send a photo of the check-in if you have it.', wait: 15 },
      { text: 'After 2 hours: call the facility / Amazon about the wait and ask for detention as the load allows.', driver: '', wait: 120 },
      { text: 'Write down when he left; in and out times on the BOL.', driver: 'Please make sure the in and out times are written on the BOL.', wait: 240 }],
    rules: ['If the wait will make the next load late: tell that customer early.'] },
  { key: 'wrong_load', title: 'Wrong trailer, container or location',
    when: 'The trailer, container, seal or load number does not match, or the driver is at the wrong place.',
    steps: [
      { text: 'Stop: compare the numbers with the load (photo of the trailer number, seal and BOL).', driver: 'Please do not leave yet. Send a photo of the trailer number, the seal and the BOL.', wait: 10 },
      { text: 'Call the facility / Amazon to confirm the right trailer or address.', driver: '', wait: 20 },
      { text: 'Right trailer / address confirmed to the driver.', driver: '', wait: 30 }],
    rules: ['He never leaves with a trailer that does not match the load.'] },
  { key: 'load_refused', title: 'Load refused or rejected',
    when: 'The receiver refused the load, or part of it, or the driver was turned away.',
    steps: [
      { text: 'Get the reason, photos and the BOL with the receiver\'s notes.', driver: 'What reason did they give? Send photos of the load and the BOL with their notes.', wait: 15 },
      { text: 'Call Amazon / the broker for instructions (return, other address).', driver: '', wait: 30 },
      { text: 'Instructions given to the driver.', driver: '', wait: 60 }],
    rules: ['He does not leave the load anywhere without written instructions.'] },
  { key: 'inspection', title: 'DOT inspection, weigh station or police stop',
    when: 'The driver is pulled in for a DOT inspection, at a weigh station, or stopped by police.',
    steps: [
      { text: 'Driver has the registration, insurance and the ELD transfer ready.', driver: 'Stay calm. Registration and insurance are in the truck papers; if they ask for logs, use the ELD transfer.', wait: 10 },
      { text: 'Photo of the inspection report when done.', driver: 'Send a photo of the inspection report when it is done, please.', wait: 60 },
      { text: 'If out of service: breakdown steps. If clean: back on the road.', driver: '', wait: 60 }],
    rules: ['If he is placed out of service: the truck does not move until it is fixed.'] },
  { key: 'eld_problem', title: 'ELD not working',
    when: 'The ELD stopped working, will not log in, or shows wrong hours.',
    steps: [
      { text: 'Tell the ELD team; driver writes the problem down.', driver: 'Please tell me what the ELD shows. Note the time it stopped working.', wait: 15 },
      { text: 'Driver keeps paper logs until it works again.', driver: 'Until the ELD works again, keep paper logs for today.', wait: 30 },
      { text: 'ELD fixed (the law gives 8 days).', driver: '', wait: 1440 }],
    rules: ['If it is not fixed the same day: paper logs every day until it is.'] }];

async function seed() {
  for (const p of STARTERS) await q(`INSERT INTO tg_playbooks (key, title, when_text, steps, rules, source, active) VALUES ($1, $2, $3, $4, $5, 'starter', true) ON CONFLICT (key) DO NOTHING`,
    [p.key, p.title, p.when, JSON.stringify(p.steps), JSON.stringify(p.rules)]);
}
const list = async () => (await q(`SELECT * FROM tg_playbooks WHERE active ORDER BY id`)).rows;
// for the AI: the playbooks (the same for every group, so it is cached with the instructions)
async function forAi() {
  const pbs = await list(); if (!pbs.length) return '';
  return `\nCASE PLAYBOOK (id: name: when it applies). In a WORKING driver's group, open a case (cases_opened) when the NEW messages show one of these starting; never open the same case twice (see OPEN CASES):\n${pbs.map((p) => `${p.id}: ${p.title}: ${p.when_text}`).join('\n')}`;
}
// for the AI: the open cases in this group with their steps
async function openFor(chatId) {
  const cs = (await q(`SELECT c.*, p.title, p.steps, p.rules FROM tg_cases c JOIN tg_playbooks p ON p.id = c.playbook_id WHERE c.chat_id = $1 AND c.status = 'open' ORDER BY c.id`, [chatId])).rows;
  if (!cs.length) return '';
  return `\nOPEN CASES in this group (case_updates: the steps the NEW messages show done or not needed, and resolved when it is over):\n${cs.map((c) => `case ${c.id}: ${c.title} (since ${new Date(c.opened_at).toISOString().slice(0, 16).replace('T', ' ')} UTC). Steps: ${(c.steps || []).map((s, i) => `${i + 1}${(c.done || []).includes(i + 1) ? ' [done]' : ''}) ${s.text}`).join(' ')} Rules: ${(c.rules || []).join(' ')}`).join('\n')}`;
}
const nextStep = (c, steps) => { for (let i = 1; i <= steps.length; i++) if (!(c.done || []).includes(i)) return i; return null; };

// the people to tell: the truck's dispatcher, or the admins
async function team(c) {
  const d = (await q(`SELECT t.dispatcher_id FROM trucks t WHERE t.driver_id = $1 AND t.dispatcher_id IS NOT NULL LIMIT 1`, [c.driver_id])).rows[0];
  const admins = (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id);
  return { dispatcher: d ? d.dispatcher_id : null, admins };
}
async function say(c, step, text, mode) {
  const bot = require('./bot');
  if (!text) return;
  if (mode === 'updater') { await bot.send(c.chat_id, bot.esc(text)).catch((e) => console.error('case send', e.message)); await bot.log('reply', `Case "${c.title}", step ${step}: told the driver "${text.slice(0, 120)}"`, { chatId: c.chat_id, driverId: c.driver_id }); }
  else {
    await q(`UPDATE tg_drafts SET state = 'replaced', decided_at = now() WHERE chat_id = $1 AND state = 'open' AND kind = 'case'`, [c.chat_id]);
    await q(`INSERT INTO tg_drafts (chat_id, driver_id, driver_text, draft, kind) VALUES ($1, $2, $3, $4, 'case')`, [c.chat_id, c.driver_id, `${c.title}: step ${step}`, text]);
  }
}

// after the AI read a working group: open cases and move them on
async function apply(chat, r, fresh, { quiet = false, mode = 'watch' } = {}) {
  const bot = require('./bot');
  const pbs = Object.fromEntries((await list()).map((p) => [p.id, p]));
  for (const o of (r.cases_opened || []).slice(0, 3)) {
    const p = pbs[+o.playbook_id]; if (!p || !chat.driver_id) continue;
    if ((await q(`SELECT 1 FROM tg_cases WHERE chat_id = $1 AND playbook_id = $2 AND status = 'open'`, [chat.chat_id, p.id])).rows[0]) continue;
    const m = fresh.find((x) => +x.msg_id === +o.msg_id) || fresh[fresh.length - 1];
    const P = require('../places');
    const c = (await q(`INSERT INTO tg_cases (chat_id, driver_id, playbook_id, summary, opened_at, msg_id, done, step_since, city, state) VALUES ($1, $2, $3, $4, $5, $6, '{}', $5, $7, $8) RETURNING *`,
      [chat.chat_id, chat.driver_id, p.id, bot.redact(String(o.summary || p.title)).slice(0, 400), m ? m.at : new Date(), m ? m.msg_id : null, o.city ? String(o.city).slice(0, 60) : null, P.st(o.state)])).rows[0];
    c.title = p.title;
    await bot.log('case', `Case opened: ${p.title}${o.summary ? ` (${String(o.summary).slice(0, 120)})` : ''}`, { chatId: chat.chat_id, driverId: chat.driver_id });
    await require('../lib').history(chat.driver_id, `Case opened: ${p.title}`, 'AI', 'telegram').catch(() => {});
    if (quiet) { await q(`UPDATE tg_cases SET status = 'old', closed_at = now() WHERE id = $1`, [c.id]); continue; } // from old messages: kept as history only
    const s = p.steps[0];
    const t = await team(c);
    for (const id of new Set([...(t.dispatcher ? [t.dispatcher] : t.admins)])) await db.notify(db.pool, id, 'case', `${chat.driver}: ${p.title}. First step: ${s ? s.text : ''}`, '#/cases', { driverId: chat.driver_id });
    if (s) await say(c, 1, s.driver, mode);
  }
  for (const u of (r.case_updates || []).slice(0, 5)) {
    const c = (await q(`SELECT c.*, p.title, p.steps FROM tg_cases c JOIN tg_playbooks p ON p.id = c.playbook_id WHERE c.id = $1 AND c.chat_id = $2 AND c.status = 'open'`, [+u.case_id, chat.chat_id])).rows[0]; if (!c) continue;
    const add = (u.steps_done || []).map(Number).filter((n) => n >= 1 && n <= c.steps.length && !(c.done || []).includes(n));
    const before = nextStep(c, c.steps);
    const done = [...new Set([...(c.done || []), ...add])].sort((a, b) => a - b);
    const note = u.note ? bot.redact(String(u.note)).slice(0, 300) : null;
    // what it cost, who did it, where (for the case times and costs, and Shops & services)
    const P = require('../places'); const cost = typeof u.cost === 'number' && u.cost > 0 ? u.cost : null;
    let placeId = null; if (u.shop) { const pl = (await q(`SELECT id FROM places WHERE lower(name) = lower($1) LIMIT 1`, [String(u.shop).trim()])).rows[0]; placeId = pl ? pl.id : null; }
    if (cost || placeId || P.st(u.state)) await q(`UPDATE tg_cases SET cost = coalesce($2, cost), place_id = coalesce($3, place_id), state = coalesce(state, $4) WHERE id = $1`, [c.id, cost, placeId, P.st(u.state)]);
    if (u.resolved) {
      await q(`UPDATE tg_cases SET done = $2, status = 'resolved', closed_at = now(), note = coalesce($3, note), lesson = $4 WHERE id = $1`, [c.id, done, note, u.lesson ? bot.redact(String(u.lesson)).slice(0, 500) : null]);
      await bot.log('case', `Case resolved: ${c.title}${note ? ` (${note})` : ''}`, { chatId: chat.chat_id, driverId: chat.driver_id });
      // what to do better next time: to approve in Knowledge (the team may then add it to the playbook)
      if (u.lesson) await q(`INSERT INTO tg_knowledge (question, answer, source, added_by, chat_id, kind, active, review) VALUES ($1, $2, 'conversation', 'AI, from a case', $3, 'dispatch', false, true)`,
        [`Case: ${c.title}`, bot.redact(String(u.lesson)).slice(0, 1000), chat.chat_id]);
      continue;
    }
    const after = nextStep({ done }, c.steps);
    await q(`UPDATE tg_cases SET done = $2, note = coalesce($3, note), step_since = CASE WHEN $4 THEN now() ELSE step_since END, warned_step = CASE WHEN $4 THEN NULL ELSE warned_step END, last_at = now() WHERE id = $1`, [c.id, done, note, after !== before]);
    if (add.length) await bot.log('case', `Case "${c.title}": step ${add.join(', ')} done`, { chatId: chat.chat_id, driverId: chat.driver_id });
    if (!quiet && after && after !== before) await say({ ...c, chat_id: chat.chat_id }, after, c.steps[after - 1].driver, mode);
  }
}

// a step waiting longer than it should: the dispatcher (and the admins) are told once per step; a case open 24 hours: the admins
async function tick() {
  const open = (await q(`SELECT c.*, p.title, p.steps, d.name driver FROM tg_cases c JOIN tg_playbooks p ON p.id = c.playbook_id LEFT JOIN drivers d ON d.id = c.driver_id WHERE c.status = 'open'`)).rows;
  for (const c of open) {
    const n = nextStep(c, c.steps || []);
    if (!n) { await q(`UPDATE tg_cases SET status = 'resolved', closed_at = now() WHERE id = $1`, [c.id]); continue; }
    const s = c.steps[n - 1]; const late = (Date.now() - new Date(c.step_since || c.opened_at)) / 60000;
    const t = await team(c);
    if (s.wait && late > s.wait && c.warned_step !== n) {
      await q(`UPDATE tg_cases SET warned_step = $2 WHERE id = $1`, [c.id, n]);
      const to = new Set([...(t.dispatcher ? [t.dispatcher] : []), ...(late > s.wait * 3 || !t.dispatcher ? t.admins : [])]);
      for (const id of to) await db.notify(db.pool, id, 'case', `${c.driver || 'A driver'}: ${c.title}. Step ${n} is waiting ${Math.round(late)} min: ${s.text}`, '#/cases', { driverId: c.driver_id });
      await require('./bot').log('case', `Case "${c.title}": step ${n} waiting ${Math.round(late)} min, the team is told`, { chatId: c.chat_id, driverId: c.driver_id });
    }
    if (!c.long_warned && Date.now() - new Date(c.opened_at) > 24 * 3600e3) {
      await q(`UPDATE tg_cases SET long_warned = true WHERE id = $1`, [c.id]);
      for (const id of t.admins) await db.notify(db.pool, id, 'case', `${c.driver || 'A driver'}: "${c.title}" has been open for 24 hours. Step ${n}: ${s.text}`, '#/cases', { driverId: c.driver_id });
    }
    // nothing at all for 3 days: closed by itself
    if (Date.now() - new Date(c.last_at || c.opened_at) > 72 * 3600e3) await q(`UPDATE tg_cases SET status = 'stale', closed_at = now() WHERE id = $1`, [c.id]);
  }
}
function start() { seed().catch((e) => console.error('playbook seed', e.message)); setInterval(() => { tick().catch((e) => console.error('case tick', e.message)); require('../hometime').tick().catch((e) => console.error('home time tick', e.message)); require('./desk').tick().catch((e) => console.error('desk tick', e.message)); }, +process.env.TG_CASE_MS || 60000); }
module.exports = { STARTERS, seed, list, forAi, openFor, apply, tick, start, nextStep };
