// One driver, two conversations. What he said on Indeed is known to the Telegram bot (so it never asks again and answers
// with the full picture), and what happens in Telegram is known to the Indeed auto-reply (so it stops asking him to
// install Telegram once he is in his group, and knows where his Amazon sign-up stands).
const db = require('./db');
const { q } = db;
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// For the Telegram bot: the facts from the Indeed chat, and how that chat ended. '' when there is nothing.
async function fromIndeed(driverId) {
  const d = (await q(`SELECT * FROM drivers WHERE id = $1`, [driverId])).rows[0]; if (!d) return '';
  const a = d.answers && typeof d.answers === 'object' ? d.answers : {};
  const f = [];
  if (d.exp_years !== null && d.exp_years !== undefined) f.push(`CDL-A experience: ${+d.exp_years} years`); else if (a.qualify) f.push(`CDL-A experience and record, in his words: "${clip(a.qualify, 160)}"`);
  if (d.relay_before === true || d.relay_before === false) f.push(`Ran Amazon Relay loads before: ${d.relay_before ? 'yes' : 'no'}`); else if (a.relay) f.push(`Amazon Relay before, in his words: "${clip(a.relay, 120)}"`);
  if (d.truck_year || d.truck_model || a.equipment) f.push(`His truck: ${clip([d.truck_year, d.truck_model].filter(Boolean).join(' ') || a.equipment, 120)}`);
  if (d.location || a.home) f.push(`Lives in: ${clip(d.location || a.home, 80)}`);
  if (d.zip) f.push(`ZIP code: ${d.zip}`);
  if (d.license_state) f.push(`CDL state: ${d.license_state}`);
  if (d.weeks_out) f.push(`Wants to stay out about ${+d.weeks_out} weeks${d.days_home ? `, then ${d.days_home} days home` : ''}`);
  if (a.telegram) f.push(`About Telegram he said: "${clip(a.telegram, 100)}"`);
  if (a.lookingFor) f.push(`Looking for: "${clip(a.lookingFor, 120)}"`);
  if (d.ai_summary) f.push(`Summary of the Indeed chat: ${clip(d.ai_summary, 300)}`);
  if (d.red_flags) f.push(`Flagged there: ${clip(d.red_flags, 200)}`);
  const last = String(d.transcript || '').split('\n').map((l) => l.trim()).filter((l) => /^(Driver|Dispatch): /.test(l)).slice(-8).map((l) => clip(l, 220));
  if (!f.length && !last.length) return '';
  return [...f.map((x) => '- ' + x), ...(last.length ? ['The last lines of the Indeed chat:', ...last.map((l) => '  ' + l)] : [])].join('\n');
}

// For the Indeed auto-reply: what the website and Telegram know about these drivers
async function fromTelegram(ids) {
  const out = {}; const list = ids.map(Number).filter(Number.isInteger).join(','); // whole numbers only
  if (!list) return out;
  const groups = (await q(`SELECT driver_id, active FROM tg_chats WHERE kind = 'dispatch' AND driver_id = ANY($1::int[])`, [ids])).rows;
  const joined = new Set((await q(`SELECT driver_id FROM tg_people WHERE role = 'driver' AND driver_id = ANY($1::int[])`, [ids])).rows.map((r) => r.driver_id));
  const cases = (await q(`SELECT driver_id, ai_status FROM onb_cases WHERE driver_id IN (${list})`)).rows;
  const arr = Object.fromEntries((await q(`SELECT driver_id, expected_arrival FROM onboarding WHERE driver_id IN (${list})`)).rows.map((r) => [r.driver_id, r.expected_arrival]));
  const ds = (await q(`SELECT id, amazon_step FROM drivers WHERE id IN (${list})`)).rows.map((d) => ({ ...d, arrive: arr[d.id] || null }));
  for (const d of ds) {
    const g = groups.filter((x) => x.driver_id === d.id); let st = (cases.find((c) => c.driver_id === d.id) || {}).ai_status || null; if (typeof st === 'string') { try { st = JSON.parse(st); } catch (e) { st = null; } }
    const step = d.amazon_step ? db.AMAZON.find((s) => s.key === d.amazon_step) : null;
    if (!g.length && !step) continue; // nothing to add yet
    out[d.id] = { group: g.some((x) => x.active), joined: joined.has(d.id), amazon: step ? step.long : null, amazonStep: d.amazon_step || null,
      start: d.arrive ? String(d.arrive instanceof Date ? d.arrive.toISOString() : d.arrive).slice(0, 10) : null, lately: st && st.summary ? clip(st.summary, 300) : null };
  }
  return out;
}
module.exports = { fromIndeed, fromTelegram };
