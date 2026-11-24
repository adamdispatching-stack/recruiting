// One driver, two conversations: the Telegram bot knows what he said on Indeed, and the Indeed auto-reply (the
// Chrome extension) gets what Telegram knows.
//   bash test/all.sh cross
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const fs = require('fs');
const db = require('../src/db');
const cross = require('../src/cross');
const q = db.q;
(async () => {
  const r0 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }) });
  const cookie = (r0.headers.get('set-cookie') || '').split(';')[0];
  const key = (await (await fetch(BASE + '/api/keys', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Cross profile' }) })).json()).key;
  const pull = async (since) => (await fetch(BASE + '/api/ext/pull?since=' + encodeURIComponent(since.toISOString()), { headers: { Authorization: 'Bearer ' + key } })).json();

  // ---- what he said on Indeed, for the Telegram bot ----
  const transcript = ['[Indeed: invited]', 'Dispatch: Does that work for you?', 'Driver: Yes sounds good', 'Dispatch: How long have you had your CDL-A?', 'Driver: 6 years, clean record', 'Dispatch: What is your email and best number?', 'Driver: ivan@example.com 215-555-0144'].join('\n');
  const ivan = (await q(`INSERT INTO drivers (name, name_key, status, answers, exp_years, relay_before, zip, license_state, location, ai_summary, transcript, web_updated_at)
    VALUES ('Ivan Indeed', 'ivan indeed', 'Onboarding', $1, 6, true, '19104', 'PA', 'Philadelphia, PA', 'Experienced, wants regional work.', $2, now() - interval '10 days') RETURNING id`,
  [JSON.stringify({ qualify: '6 years, clean record', relay: 'yes for 2 years', telegram: 'ok installed' }), transcript])).rows[0].id;
  const txt = await cross.fromIndeed(ivan);
  ok(/CDL-A experience: 6 years/.test(txt) && /Ran Amazon Relay loads before: yes/.test(txt) && /ZIP code: 19104/.test(txt) && /CDL state: PA/.test(txt) && /Lives in: Philadelphia, PA/.test(txt), 'the facts from Indeed are listed for the Telegram bot');
  ok(/About Telegram he said: "ok installed"/.test(txt) && /Summary of the Indeed chat: Experienced/.test(txt), 'with what he said about Telegram, and the summary');
  ok(/The last lines of the Indeed chat:/.test(txt) && /Driver: ivan@example\.com/.test(txt) && !/\[Indeed: invited\]/.test(txt), 'and how the Indeed chat ended (the driver\'s and our lines, not Indeed\'s notices)');
  const blank = (await q(`INSERT INTO drivers (name, name_key, status, web_updated_at) VALUES ('Nora Nothing', 'nora nothing', 'Onboarding', now() - interval '10 days') RETURNING id`)).rows[0].id;
  ok(await cross.fromIndeed(blank) === '', 'nothing from Indeed: nothing is added');
  const src = (f) => fs.readFileSync(__dirname + '/../src/tg/' + f, 'utf8');
  ok(/fromIndeed\(c\.driver_id\)/.test(src('onboard.js')) && /WHAT HE ALREADY TOLD US ON INDEED/.test(src('onboard.js')), 'the bot\'s replies in Telegram are written with it');
  ok(/fromIndeed\(chat\.driver_id\)/.test(src('digest.js')) && /What he told us on Indeed before this group/.test(src('ai.js')), 'and so is its reading of the group');

  // ---- what Telegram knows, for the Indeed auto-reply ----
  let t = await cross.fromTelegram([ivan, blank]);
  ok(!t[ivan] && !t[blank], 'no group and no Amazon step yet: nothing to tell');
  const before = new Date(Date.now() - 5000);
  await q(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active, linked_at) VALUES (-110001, 'Ivan Indeed', 'dispatch', $1, true, now())`, [ivan]);
  await q(`UPDATE drivers SET amazon_step = 'profile' WHERE id = $1`, [ivan]);
  t = await cross.fromTelegram([ivan]);
  ok(t[ivan].group === true && t[ivan].joined === false && /finished the Relay profile/.test(t[ivan].amazon), 'his group exists, he has not joined, and the Amazon step: ' + JSON.stringify(t[ivan]));
  await q(`INSERT INTO tg_people (tg_id, name, role, driver_id) VALUES (111001, 'Ivan', 'driver', $1)`, [ivan]);
  await q(`INSERT INTO onb_cases (driver_id, chat_id, mode, ai_status, ai_status_at) VALUES ($1, -110001, 'watch', $2, now())`, [ivan, JSON.stringify({ summary: 'Waiting for the Accurate background check.' })]);
  await q(`INSERT INTO onboarding (driver_id, expected_arrival) VALUES ($1, '2026-12-07')`, [ivan]);
  t = await cross.fromTelegram([ivan]);
  ok(t[ivan].joined === true && t[ivan].lately === 'Waiting for the Accurate background check.' && t[ivan].start === '2026-12-07', 'once he is in the group: joined, the start date, and what was said lately');
  // the extension gets it with its next sync, also when only Telegram changed (the lead itself was not edited)
  const p = await pull(before);
  const row = (p.drivers || []).find((d) => d.name === 'Ivan Indeed');
  ok(row && row.telegram && row.telegram.joined === true && row.telegram.amazonStep === 'profile', 'the Chrome extension gets it with its next sync, though the lead itself was not edited');
  ok(!(p.drivers || []).some((d) => d.name === 'Nora Nothing'), 'a lead with nothing new is not sent');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
