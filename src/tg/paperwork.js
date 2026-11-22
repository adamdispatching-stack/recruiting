// Onboarding paperwork the driver has to do himself: the contract the safety team sends, and the FMCSA Drug and
// Alcohol Clearinghouse (he registers at clearinghouse.fmcsa.dot.gov/register with Login.gov, then gives electronic
// consent to our pre-employment query). The bot reminds him in the onboarding group, daytime only:
// Watch: the message waits on the website (Reply ready to send); Answer questions / Run: the bot sends it.
// The steps tick themselves when the group shows them done (the AI reads the group), or by hand on the website.
const db = require('../db');
const { q } = db;

const MSG = {
  ch_ask: (f) => `${f}, for the drug and alcohol Clearinghouse (FMCSA): please register as a driver at clearinghouse.fmcsa.dot.gov/register. You sign in with Login.gov. It takes about 10 minutes. Write here when it is done.`,
  ch_ask2: (f) => `${f}, a reminder about the Clearinghouse: we cannot finish your hiring until you are registered at clearinghouse.fmcsa.dot.gov/register. Let us know if you get stuck.`,
  ch_consent: (f) => `${f}, our safety team sent you a Clearinghouse consent request. Please log in at clearinghouse.fmcsa.dot.gov and approve it (Consent requests). Write here when it is done.`,
  contract: (f) => `${f}, did you get the contract from our safety team? Please check your email (also the spam folder), sign it, and tell us here.`
};

async function deliver(c, key, text) {
  const bot = require('./bot');
  if (c.bot_mode === 'watch') {
    await q(`UPDATE tg_drafts SET state = 'replaced', decided_at = now() WHERE chat_id = $1 AND state = 'open' AND kind = 'remind'`, [c.chat_id]);
    await q(`INSERT INTO tg_drafts (chat_id, driver_id, driver_text, draft, kind) VALUES ($1, $2, $3, $4, 'remind')`, [c.chat_id, c.driver_id, `Reminder: ${key.startsWith('ch') ? 'Clearinghouse' : 'contract'}`, text]);
  } else await bot.send(c.chat_id, bot.esc(text));
  await bot.log('remind', `${c.bot_mode === 'watch' ? 'Reminder ready on the website' : 'Reminded the driver'}: ${key.startsWith('ch') ? 'Clearinghouse' : 'contract'}`, { chatId: c.chat_id, driverId: c.driver_id });
  await q(`UPDATE onb_cases SET sent = coalesce(sent, '{}'::jsonb) || $2::jsonb WHERE driver_id = $1`, [c.driver_id, JSON.stringify({ [key]: new Date().toISOString() })]);
}

async function tick(day) {
  if (!day) return;
  const cases = (await q(`SELECT c.driver_id, c.chat_id, c.mode bot_mode, c.sent, c.started_at, d.name FROM onb_cases c JOIN tg_chats ch ON ch.chat_id = c.chat_id AND ch.active AND ch.kind = 'dispatch' AND ch.driver_id = c.driver_id
    JOIN drivers d ON d.id = c.driver_id WHERE d.status = 'Onboarding' AND d.left_on IS NULL`)).rows;
  for (const c of cases) {
    const st = Object.fromEntries((await q(`SELECT key, done, done_at FROM checklist WHERE driver_id = $1 AND key IN ('contract_sent', 'contract_signed', 'ch_registered', 'ch_query', 'ch_consent')`, [c.driver_id])).rows.map((r) => [r.key, r]));
    const sent = c.sent || {}; const f = c.name.split(/\s+/)[0]; const hrs = (t) => (Date.now() - new Date(t)) / 36e5;
    if (st.ch_registered && !st.ch_registered.done) {
      if (!sent.ch_ask && hrs(c.started_at) >= 1) { await deliver(c, 'ch_ask', MSG.ch_ask(f)); continue; }
      if (sent.ch_ask && !sent.ch_ask2 && hrs(sent.ch_ask) >= 48) { await deliver(c, 'ch_ask2', MSG.ch_ask2(f)); continue; }
    }
    if (st.ch_query && st.ch_query.done && st.ch_consent && !st.ch_consent.done && !sent.ch_consent && hrs(st.ch_query.done_at) >= 12) { await deliver(c, 'ch_consent', MSG.ch_consent(f)); continue; }
    if (st.contract_sent && st.contract_sent.done && st.contract_signed && !st.contract_signed.done && !sent.contract && hrs(st.contract_sent.done_at) >= 24) await deliver(c, 'contract', MSG.contract(f));
  }
}
module.exports = { tick, MSG };
