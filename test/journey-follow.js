// Follow-ups along the journey: the bot sees what is missing for each onboarding driver and follows up with whoever
// owes it: our team in the management group, the driver in his group (a draft in Watch).
//   bash test/all.sh journey-follow
process.env.TG_NO_QUIET = '1';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const bot = require('../src/tg/bot');
const J = require('../src/tg/journey');
const q = db.q;
(async () => {
  const SENT = []; let mid = 100;
  bot.send = async (chat, text, opts = {}) => { SENT.push({ chat: String(chat), text, buttons: opts.buttons, replyTo: opts.replyTo }); return { message_id: ++mid }; };
  bot.call = async () => ({}); bot.dropButtons = async () => {};
  bot.state.me = bot.state.me || { id: 1, username: 'testbot' };
  const MG = '-990000';
  const rita = (await q(`INSERT INTO users (name, email, pass_hash, role) VALUES ('Rita Journey', 'ritaj@example.com', 'x', 'recruiter') RETURNING id`)).rows[0].id;
  await q(`INSERT INTO tg_people (tg_id, name, username, user_id) VALUES (991001, 'Rita J', 'rita_j', $1)`, [rita]);
  await q(`INSERT INTO tg_chats (chat_id, title, kind, active) VALUES ($1, 'Team', 'management', true)`, [MG]);
  const STAFF = { tg_id: '991001', name: 'Rita J', user_id: rita };
  const hoursAgo = (h) => new Date(Date.now() - h * 36e5);
  const driver = async (name, { step, startedH = 100, zip = '12345', state = 'TX', arrive = null } = {}) => {
    const id = (await q(`INSERT INTO drivers (name, name_key, status, owner_id, zip, license_state, amazon_step, amazon_log) VALUES ($1, lower($1), 'Onboarding', $2, $3, $4, $5, $6) RETURNING id`,
      [name, rita, zip, state, step || null, JSON.stringify(step ? { [step]: hoursAgo(50) } : {})])).rows[0].id;
    await q(`INSERT INTO onboarding (driver_id, started_at, expected_arrival) VALUES ($1, $2, $3)`, [id, hoursAgo(startedH), arrive]);
    return id;
  };
  const group = async (chat, id, { admin = true, active = true, mode = 'watch' } = {}) => {
    await q(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active, bot_admin, linked_at) VALUES ($1, 'G', 'dispatch', $2, $3, $4, $5)`, [chat, id, active, admin, hoursAgo(100)]);
    await q(`INSERT INTO onb_cases (driver_id, chat_id, mode) VALUES ($1, $2, $3)`, [id, chat, mode]);
  };
  const toTeam = (re) => SENT.filter((s) => s.chat === MG && re.test(s.text));
  const clear = async () => { SENT.length = 0; await q(`UPDATE journey_asks SET last_at = now() - interval '200 hours'`); };

  // the gaps
  const noGroup = await driver('Nora Nogroup', { step: 'invite' });
  const removed = await driver('Rex Removed', { step: 'invite' }); await group(-990002, removed, { active: false });
  const notAdmin = await driver('Nat Notadmin', { step: 'invite' }); await group(-990003, notAdmin, { admin: false });
  const signed = await driver('Sam Signedup', { step: 'profile' }); await group(-990004, signed);
  const noInvite = await driver('Ian Noinvite'); await group(-990005, noInvite);
  const quiet = await driver('Quinn Quiet', { step: 'invite', zip: null, state: null }); await group(-990006, quiet, { mode: 'assist' });
  const late = await driver('Larry Late', { step: 'verified', arrive: '2020-01-01' }); await group(-990007, late);
  for (const [d, c] of [[signed, -990004], [noInvite, -990005], [late, -990007]]) { // they spoke lately, and are known
    await q(`INSERT INTO tg_people (tg_id, name, role, driver_id) VALUES ($1, 'x', 'driver', $2)`, [990100 + d, d]);
    await q(`INSERT INTO tg_messages (chat_id, msg_id, from_id, text, at) VALUES ($1, 1, $2, 'hi', now())`, [c, 990100 + d]);
  }

  await J.tick();
  ok(toTeam(/@rita_j, Nora Nogroup is in onboarding but has no Telegram group yet/).length === 1, 'no group: the recruiter is asked in the management group');
  ok(toTeam(/@rita_j, I'm not in Rex Removed's group any more/).length === 1, 'bot removed: asked to add it back');
  ok(toTeam(/Nat Notadmin's group but not an admin/).length === 1, 'not an admin: asked to make it one');
  const v = toTeam(/Is Sam Signedup's Amazon Relay account verified yet\?/)[0];
  ok(v && v.buttons && v.buttons[0][0][0] === '✅ Verified', 'signed up on Relay: "is he verified?" with buttons');
  const teamCount = SENT.filter((s) => s.chat === MG).length;
  ok(teamCount === 4, 'at most 4 team messages at once, never a wall: ' + teamCount);

  // the driver side
  const d1 = SENT.find((s) => s.chat === '-990006');
  ok(d1 && /Quinn! Just checking: did you get the Amazon Relay invite email\?/.test(d1.text), '"Answer questions": the bot follows up with the driver himself: ' + (d1 || {}).text);
  const dr = (await q(`SELECT draft FROM tg_drafts WHERE chat_id = -990003 AND state = 'open' AND driver_text LIKE 'Follow-up:%'`)).rows[0];
  ok(!SENT.some((s) => s.chat === '-990003') && dr && /Relay invite/.test(dr.draft), 'Watch: the driver follow-up waits on the website');

  // the next round: the rest of the team items, and nothing asked twice too soon
  SENT.length = 0; await J.tick();
  ok(toTeam(/Has the Amazon Relay invite gone out to Ian Noinvite\?/).length === 1 && toTeam(/Larry Late was due to start/).length === 1, 'next round: the invite and the late arrival');
  ok(!toTeam(/Nora Nogroup/).length && !toTeam(/Sam Signedup/).length, 'nothing asked again within its wait');

  // the team answers with the buttons
  const tap = (s, data) => J.onButton({ data, message: { chat: { id: +MG }, message_id: 1 } }, STAFF);
  ok(await tap(v, `jr:${signed}:ver`) === 'Saved ✓' && (await q(`SELECT amazon_step FROM drivers WHERE id = $1`, [signed])).rows[0].amazon_step === 'verified', '"Verified" marks him verified on the website');
  ok(SENT.some((s) => /Great news, thanks Rita! Marked Sam Signedup verified/.test(s.text)), 'and says thanks like a person');
  await tap(null, `jr:${late}:arr`);
  ok(!!(await q(`SELECT arrived_on FROM onboarding WHERE driver_id = $1`, [late])).rows[0].arrived_on, '"He arrived" marks the arrival');
  await tap(null, `jr:${noInvite}:later:invite`);
  ok(await J.onButton({ data: `jr:${noInvite}:inv`, message: { chat: { id: +MG }, message_id: 1 } }, { tg_id: '5', name: 'Driver' }) === 'Only our team can answer this.', 'only our team can answer');

  // done things stop; a snoozed one waits; tried enough: the admins hear
  await clear(); await J.tick();
  ok(!toTeam(/Sam Signedup.*verified yet/).length, 'once verified, the bot stops asking');
  ok(!toTeam(/Ian Noinvite/).length, '"Not yet" waits a day');
  await q(`UPDATE journey_asks SET count = 3, last_at = now() - interval '200 hours' WHERE driver_id = $1 AND key = 'no_group'`, [noGroup]);
  await J.tick();
  const adm = (await q(`SELECT text FROM notices WHERE text LIKE 'Nora Nogroup: I followed up 3 times%'`)).rows;
  ok(adm.length >= 1, 'after the last try the admins get a website notice');

  // switched off with the team follow-ups
  db.settings.tg = { ...(db.settings.tg || {}), teamFollowups: false }; await clear(); await J.tick();
  ok(!SENT.length, 'off when team follow-ups are off');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
