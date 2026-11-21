// What the MVR and the drug test need from a new driver:
// - the state on the CDL, and for a Pennsylvania CDL the last 4 of the SSN (the PA MVR asks for it)
// - the ZIP code, so the team books a drug test facility nearby
// The last 4 of the SSN: hidden in every saved message, shown on the website only to the recruiter and admins
// (each look is logged), and deleted 30 days after it was given.
const db = require('../db');
const bot = require('./bot');
const { q } = db; const { send, esc } = bot;

const STATES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC' };
const CODES = new Set(Object.values(STATES));
const stateCode = (s) => { const t = String(s || '').trim(); if (!t) return null; const u = t.toUpperCase(); if (u.length === 2 && CODES.has(u)) return u; return STATES[t.toLowerCase()] || null; };
const SSN_WORDS = /\b(ssn|social(\s+security)?|last\s*(4|four)(\s+digits)?)\b/i;
const ZIP_WORDS = /\b(zip|postal|drug\s*test|lab|facility)\b/i;

async function driver(id) {
  return (await q(`SELECT d.id, d.name, d.status, d.zip, d.license_state, d.ssn4 IS NOT NULL has_ssn4, d.ssn4_at, d.owner_id, (SELECT expected_arrival IS NULL FROM onboarding WHERE driver_id = d.id) no_start,
    (SELECT done FROM checklist WHERE driver_id = d.id AND key = 'mvr' LIMIT 1) mvr_done FROM drivers d WHERE d.id = $1`, [id])).rows[0];
}
// what is still missing, in plain words
function needs(d) {
  const out = [];
  if (!d) return out;
  if (!d.license_state) out.push({ key: 'state', label: 'CDL state' });
  if (d.license_state === 'PA' && !d.has_ssn4 && !d.mvr_done) out.push({ key: 'ssn4', label: 'Last 4 of SSN (Pennsylvania MVR)' });
  if (!d.zip) out.push({ key: 'zip', label: 'ZIP code (drug test nearby)' });
  if (d.no_start) out.push({ key: 'start', label: 'Start date' });
  return out;
}
async function tellOwner(d, text) {
  const to = d.owner_id ? [d.owner_id] : (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows.map((r) => r.id);
  for (const id of to) await db.notify(db.pool, id, 'tg', text, '#/driver/' + d.id, { driverId: d.id });
}
const history = (id, text, by) => require('../lib').history(id, text, by || 'Telegram', 'telegram').catch(() => {});

// Save what we learned. onlyEmpty: the AI fills gaps but never overwrites what the team typed.
async function setFacts(driverId, f, by, { onlyEmpty = false, quiet = false } = {}) {
  const d = await driver(driverId); if (!d) return null;
  const said = [];
  const st = f.state !== undefined ? stateCode(f.state) : null;
  if (st && st !== d.license_state && !(onlyEmpty && d.license_state)) { await q(`UPDATE drivers SET license_state = $2, updated_at = now() WHERE id = $1`, [driverId, st]); said.push(`CDL state ${st}`); }
  const zip = f.zip !== undefined ? (String(f.zip).match(/^\s*(\d{5})(?:-\d{4})?\s*$/) || [])[1] : null;
  if (zip && zip !== d.zip && !(onlyEmpty && d.zip)) { await q(`UPDATE drivers SET zip = $2, updated_at = now() WHERE id = $1`, [driverId, zip]); said.push(`ZIP ${zip}`); }
  if (f.ssn4 && /^\d{4}$/.test(f.ssn4)) {
    await q(`UPDATE drivers SET ssn4 = $2, ssn4_at = now(), updated_at = now() WHERE id = $1`, [driverId, f.ssn4]);
    await history(driverId, 'Last 4 of SSN saved for the MVR', by);
    if (!quiet) await tellOwner(d, `${d.name} sent the last 4 of SSN for the MVR. It is on the driver's page.`);
  }
  if (said.length) await history(driverId, said.join(', ') + (by === 'AI' ? ' (from the Telegram group)' : ''), by);
  const cid = ((await q(`SELECT chat_id FROM onb_cases WHERE driver_id = $1`, [driverId])).rows[0] || {}).chat_id || null;
  if (said.length || (f.ssn4 && /^\d{4}$/.test(f.ssn4))) await bot.log('fact', `Saved ${[...said, ...(f.ssn4 && /^\d{4}$/.test(f.ssn4) ? ['the last 4 of SSN'] : [])].join(', ')} (${by})`, { chatId: cid, driverId });
  // a Pennsylvania CDL: the MVR needs the last 4 of the SSN
  if (st === 'PA' && d.license_state !== 'PA' && !d.has_ssn4 && !d.mvr_done) {
    if (!quiet) await tellOwner(d, `${d.name}'s CDL is from Pennsylvania: the MVR needs the last 4 of the SSN. Ask the driver, or send the private link from the driver's page.`);
    const c = (await q(`SELECT mode FROM onb_cases WHERE driver_id = $1`, [driverId])).rows[0];
    if (c && c.mode === 'run') await ask(driverId).catch(() => {});
  }
  return driver(driverId);
}

// The private link: the driver sends the last 4 to the bot, not in the group
async function privateLink(driverId) {
  if (!bot.state.me || !bot.state.me.username) return null;
  let code = (await q(`SELECT ssn4_code FROM drivers WHERE id = $1`, [driverId])).rows[0];
  if (!code) return null; code = code.ssn4_code;
  if (!code) { code = require('crypto').randomBytes(9).toString('base64url'); await q(`UPDATE drivers SET ssn4_code = $2 WHERE id = $1`, [driverId, code]); }
  return `https://t.me/${bot.state.me.username}?start=s4_${code}`;
}
// /start s4_CODE in a private chat with the bot
async function privateStart(m, code) {
  const d = (await q(`SELECT id, name FROM drivers WHERE ssn4_code = $1`, [String(code || '')])).rows[0];
  if (!d) return send(m.chat.id, 'That link is not valid anymore. Ask your recruiter for a new one.');
  await q(`INSERT INTO tg_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, ['s4:' + m.from.id, JSON.stringify({ driverId: d.id, at: Date.now() })]);
  return send(m.chat.id, `Hi ${esc(d.name.split(/\s+/)[0])}! For your MVR (Pennsylvania), please send the <b>last 4 digits</b> of your Social Security number.\nOnly your recruiter can see them, and we delete them after 30 days. Please don't send the full number.`);
}
// the next private message after the link: the 4 digits. Returns true when it was handled (and must not be saved as text).
async function privateMessage(m) {
  const st = ((await q(`SELECT value FROM tg_state WHERE key = $1`, ['s4:' + (m.from && m.from.id)])).rows[0] || {}).value;
  if (!st || Date.now() - st.at > 2 * 36e5 || /^\//.test(m.text || '')) return false;
  const dg = String(m.text || '').replace(/\D/g, '');
  if (dg.length !== 4 && dg.length !== 9) { await send(m.chat.id, 'Please send just the last 4 digits, like 1234.'); return true; }
  await q(`DELETE FROM tg_state WHERE key = $1`, ['s4:' + m.from.id]);
  await setFacts(st.driverId, { ssn4: dg.slice(-4) }, 'Driver (private chat)');
  if (dg.length === 9) await bot.call('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }).catch(() => {});
  await send(m.chat.id, `Saved ✓ Thank you!${dg.length === 9 ? ' (I kept only the last 4 and deleted your message.)' : ''}`);
  return true;
}

// In the group: the driver answers with the last 4 or the ZIP code (any mode, the bot stays quiet in watch mode)
async function fromGroup(c, m, raw) {
  const text = String(raw || ''); if (!text) return;
  const recent = (await q(`SELECT text FROM tg_messages WHERE chat_id = $1 AND msg_id <> $2 AND at > now() - interval '3 hours' ORDER BY at DESC LIMIT 6`, [m.chat.id, m.message_id])).rows.map((r) => r.text || '').join('\n');
  const nums = text.match(/\d+/g) || [];
  // the last 4 of the SSN: a 4-digit answer (or a full number, of which we keep only the last 4) when someone asked for it
  const full = text.match(/(?<!\d)\d{3}[ -]?\d{2}[ -]?\d{4}(?!\d)/);
  const four = nums.length === 1 && nums[0].length === 4 ? nums[0] : null;
  if ((four || full) && (SSN_WORDS.test(text) || SSN_WORDS.test(recent))) {
    const v = four || full[0].replace(/\D/g, '').slice(-4);
    await q(`UPDATE tg_messages SET text = '[last 4 of SSN, hidden]' WHERE chat_id = $1 AND msg_id = $2`, [m.chat.id, m.message_id]); // hidden first
    await setFacts(c.driver_id, { ssn4: v }, c.name);
    if (full) await bot.call('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }).catch(() => {});
    return;
  }
  // the ZIP code
  const zips = nums.filter((n) => n.length === 5);
  if (zips.length === 1 && nums.length <= 2 && (ZIP_WORDS.test(text) || ZIP_WORDS.test(recent))) await setFacts(c.driver_id, { zip: zips[0] }, c.name);
  // the CDL state, said plainly in answer to the question
  const sm = /\b(cdl|license|licence)\b/i.test(text + '\n' + recent) && text.length < 60 ? stateCode(text.replace(/\b(my|cdl|license|licence|is|from|it'?s|state|the|i have a|a)\b/gi, ' ').replace(/[^a-z ]/gi, ' ').replace(/\s+/g, ' ').trim()) : null;
  if (sm) await setFacts(c.driver_id, { state: sm }, c.name);
}

// Run mode: the bot asks for what is missing (once each)
async function ask(driverId) {
  const c = (await q(`SELECT c.chat_id, c.asked, c.mode FROM onb_cases c WHERE c.driver_id = $1`, [driverId])).rows[0];
  if (!c || c.mode !== 'run') return;
  const d = await driver(driverId); const asked = c.asked || {}; const todo = needs(d).filter((n) => !asked[n.key]);
  if (!todo.length) return;
  const p = (await q(`SELECT * FROM tg_people WHERE driver_id = $1 AND role = 'driver' LIMIT 1`, [driverId])).rows[0];
  const who = p ? bot.tag(p) : `<b>${esc(d.name.split(/\s+/)[0])}</b>`;
  const lines = [];
  if (todo.some((n) => n.key === 'state')) lines.push('Which state is your CDL from?');
  if (todo.some((n) => n.key === 'zip')) lines.push('What is your ZIP code? We will book your drug test at a facility near you.');
  if (todo.some((n) => n.key === 'start')) lines.push('Which day can you start (be here and ready to roll)?');
  if (lines.length) await send(c.chat_id, `${who}, ${lines.length > 1 ? 'a few quick questions:\n' + lines.map((l, i) => `${i + 1}. ${l}`).join('\n') : lines[0].charAt(0).toLowerCase() + lines[0].slice(1)}`);
  if (todo.some((n) => n.key === 'ssn4')) {
    const url = await privateLink(driverId);
    await send(c.chat_id, `${who}, your CDL is from Pennsylvania, so the MVR needs the <b>last 4 digits of your SSN</b>. Please send them to me privately${url ? ' (tap the button)' : ''}, not in this group.`, url ? { buttons: [[['🔒 Send privately', url]]] } : {});
  }
  await bot.log('ask', `Asked ${d.name} for: ${todo.map((n) => n.label).join(', ')}`, { chatId: c.chat_id, driverId });
  const now = Object.fromEntries(todo.map((n) => [n.key, new Date().toISOString()]));
  await q(`UPDATE onb_cases SET asked = coalesce(asked, '{}'::jsonb) || $2::jsonb WHERE driver_id = $1`, [driverId, JSON.stringify(now)]);
}

// the last 4 of the SSN is deleted 30 days after it was given
const purge = () => q(`UPDATE drivers SET ssn4 = NULL, ssn4_at = NULL WHERE ssn4 IS NOT NULL AND ssn4_at < now() - interval '30 days'`);

module.exports = { needs, driver, setFacts, privateLink, privateStart, privateMessage, fromGroup, ask, purge, stateCode };
