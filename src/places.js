// Shops and services we use: truck shops, tire service, towing, mobile road service, detailing, locksmiths, truck
// washes, parts... One place for the team. The AI adds them from the driver groups (when someone shares a shop's name,
// address or phone, or a driver says how a repair went and what it cost); the team adds, edits, marks them trusted or
// hides them. A breakdown or a flat tire case shows the ones in the same state.
const db = require('./db');
const { q } = db;
const KINDS = { shop: 'Truck shop', tire: 'Tire service', tow: 'Towing', roadside: 'Road service (comes to the truck)', mobile_mechanic: 'Mobile mechanic', truck_wash: 'Truck wash',
  detailing: 'Detailing', locksmith: 'Locksmith', parts: 'Parts', trailer: 'Trailer repair', glass: 'Glass', dealer: 'Dealer', other: 'Other' };
const STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');
const st = (s) => { const x = String(s || '').trim().toUpperCase(); return STATES.includes(x) ? x : null; };
const digits = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d.length === 10 ? d : null; };
const clip = (s, n) => (s ? String(s).trim().slice(0, n) : null);

// Shops & services is ONLY for businesses that fix or serve trucks, and their contacts. An Amazon facility, a customer,
// a warehouse, an airport hub, a yard or a drop lot is a place we take loads to: it belongs in the knowledge base
// (Places & roads), never here. looksLikeSite tells them apart; such a place is sent to the knowledge base instead.
const CODE = /^K[A-Z]{3}\b|\b[A-Z]{3}\d\b/; // site codes, written in capitals: KBWI, BWI2, KRB1
const SITE = /\bamazon\b|\bair(port| hub| gateway)\b|fulfil+ment|sort(ation)? cent|distribution|delivery station|warehouse|\b(dc|fc|ds|xd)\b|cross ?-?dock|\byard\b|drop (lot|yard)|customer|shipper|receiver|\bdock\b|\bgate\b/i;
const SERVICE = /repair|tire|tyre|\btow|wreck|roadside|road service|mechanic|\bshop\b|service|wash|detail|lock ?smith|lockout|glass|parts|collision|diesel|truck cent|dealer|trailer repair|fleet maint/i;
const looksLikeSite = (x) => { const text = `${x.name || ''} ${x.address || ''}`; return (SITE.test(text) || CODE.test(x.name || '')) && !SERVICE.test(`${x.name || ''} ${(x.services || []).join(' ')}`); };
// a site the AI or a person put here by mistake: kept in the knowledge base (Places & roads) with what we knew
async function toKnowledge(p, by = 'Moved from Shops & services', sure = false) {
  const fact = [p.notes, p.address && `Address: ${p.address}`, p.phone && `Phone: ${p.phone}`, (p.services || []).length && `Notes: ${(p.services || []).join(', ')}`].filter(Boolean).join('. ')
    || `Amazon or customer location${p.city || p.state ? ' in ' + [p.city, p.state].filter(Boolean).join(', ') : ''}.`;
  return require('./kb').add({ kind: 'site', question: p.name, answer: fact, place: p.name, city: p.city, state: p.state, by, sure });
}
// what the AI found in the messages: [{ name, kind, services, phone, address, city, state, area, outcome, cost, note }]
async function learn(items, { chatId = null, driverId = null } = {}) {
  const bot = require('./tg/bot'); let n = 0;
  for (const x of (items || []).slice(0, 8)) {
    const name = clip(x.name, 120); if (!name) continue;
    if (looksLikeSite(x)) { await toKnowledge({ name, notes: clip(x.note, 300), address: clip(x.address, 200), phone: digits(x.phone) ? fmt(digits(x.phone)) : null, city: clip(x.city, 60), state: st(x.state), services: [] }, 'AI, from the groups'); continue; }
    const kind = KINDS[x.kind] ? x.kind : 'other', phone = digits(x.phone), state = st(x.state);
    const services = [...new Set((x.services || []).map((s) => clip(s, 60)).filter(Boolean))].slice(0, 12);
    let p = phone ? (await q(`SELECT * FROM places WHERE regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE '%' || $1`, [phone])).rows[0] : null;
    if (!p) p = (await q(`SELECT * FROM places WHERE lower(name) = lower($1) AND coalesce(state, '') = coalesce($2, '')`, [name, state])).rows[0];
    const used = ['good', 'bad', 'ok'].includes(x.outcome); const cost = typeof x.cost === 'number' && x.cost > 0 ? x.cost : null;
    if (p) {
      await q(`UPDATE places SET services = ARRAY(SELECT DISTINCT unnest(services || $2::text[])), phone = coalesce(phone, $3), address = coalesce(address, $4), city = coalesce(city, $5), state = coalesce(state, $6),
          area = coalesce(area, $7), uses = uses + $8, good = good + $9, bad = bad + $10, last_cost = coalesce($11, last_cost), last_used_at = CASE WHEN $8 = 1 THEN now() ELSE last_used_at END, updated_at = now() WHERE id = $1`,
        [p.id, services, phone ? fmt(phone) : null, clip(x.address, 200), clip(x.city, 60), state, clip(x.area, 60), used ? 1 : 0, x.outcome === 'good' ? 1 : 0, x.outcome === 'bad' ? 1 : 0, cost]);
    } else {
      p = (await q(`INSERT INTO places (name, kind, services, phone, address, city, state, area, notes, uses, good, bad, last_cost, last_used_at, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'ai') RETURNING *`,
        [name, kind, services, phone ? fmt(phone) : null, clip(x.address, 200), clip(x.city, 60), state, clip(x.area, 60), clip(x.note, 300), used ? 1 : 0, x.outcome === 'good' ? 1 : 0, x.outcome === 'bad' ? 1 : 0, cost, used ? new Date() : null])).rows[0];
      await bot.log('fact', `New in Shops & services: ${name} (${KINDS[kind]}${p.city || p.state ? ', ' + [p.city, p.state].filter(Boolean).join(', ') : ''})`, { chatId, driverId });
    }
    if (used || x.note || cost) await q(`INSERT INTO place_events (place_id, driver_id, chat_id, what, outcome, cost, by) VALUES ($1, $2, $3, $4, $5, $6, 'AI, from Telegram')`, [p.id, driverId, chatId, clip(x.note || services.join(', '), 300), x.outcome || null, cost]);
    n++;
  }
  return n;
}
const fmt = (d) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
// for a road case: the kinds that help, best first, in the same state
const FOR_CASE = { breakdown_toll_road: ['tow', 'roadside', 'shop', 'mobile_mechanic'], breakdown: ['shop', 'mobile_mechanic', 'roadside', 'tow'], flat_tire: ['tire', 'roadside'], accident: ['tow', 'shop', 'glass'],
  inspection: ['shop', 'mobile_mechanic'], wrong_load: [], running_late: [], out_of_hours: [], detention: [], load_refused: [], eld_problem: [] };
async function nearby(state, key) {
  const kinds = FOR_CASE[key]; if (!state || (kinds && !kinds.length)) return [];
  return (await q(`SELECT id, name, kind, services, phone, address, city, state, good, bad, verified FROM places WHERE NOT hidden AND state = $1 AND ($2::text[] IS NULL OR kind = ANY($2::text[])) AND bad <= good + 1
    ORDER BY verified DESC, (good - bad) DESC, uses DESC LIMIT 5`, [state, kinds || null])).rows;
}
// once (upgrade): sites that got in before this rule go to the knowledge base and are hidden here
async function cleanup() {
  let n = 0;
  for (const p of (await q(`SELECT * FROM places WHERE NOT hidden`)).rows) if (looksLikeSite(p)) { await toKnowledge(p); await q(`UPDATE places SET hidden = true, notes = trim(coalesce(notes, '') || ' (moved to the knowledge base: not a shop or service)'), updated_at = now() WHERE id = $1`, [p.id]); n++; }
  return n;
}
module.exports = { looksLikeSite, toKnowledge, cleanup, KINDS, STATES, learn, nearby, digits, fmt, st };
