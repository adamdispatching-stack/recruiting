// The knowledge base: what the team knows, learned from the Telegram groups and added on the website.
// Four kinds:
//   general / accounting  answers for drivers (the bot answers drivers with the approved ones)
//   dispatch              how our dispatchers handle a situation (training for new dispatchers and the updater bot)
//   site                  lasting facts about places and roads: Amazon sites, yards, gates, parking, waits, weigh stations, tolls
// Each entry has a topic, how often it came up and in how many groups, and other ways the team said it.
// Learning costs no extra AI: the group reading already returns these; here they are matched to what we know (word overlap):
// the same thing again counts as "seen again" instead of a new entry. A small AI pass a few times a day tidies new entries
// (clear wording, topic, merges duplicates, flags answers that disagree). The bot reads only the entries that fit the question.
const db = require('./db');
const { q } = db;

const TOPICS = {
  loads: 'Loads & booking', delivery: 'Pickup & delivery', sites: 'Sites & facilities', road: 'Routes, parking & weather',
  breakdowns: 'Breakdowns & repairs', equipment: 'Trucks & trailers', eld: 'Logs & hours (ELD)', pay: 'Pay & settlements',
  fuel: 'Fuel, tolls & expenses', hometime: 'Home time', hiring: 'Hiring & paperwork', safety: 'Safety, DOT & tickets',
  company: 'Company rules', other: 'Other',
};
const KINDS = { general: 'Answers for drivers', accounting: 'Answers for drivers (pay)', dispatch: 'How we dispatch', site: 'Places & roads' };
// a first guess at the topic (the AI tidy fixes it)
const GUESS = [
  ['pay', /\b(pay|paid|settlement|direct deposit|deduction|advance|escrow|per mile|cpm|1099|w-?2|invoice|percent)\b/],
  ['fuel', /\b(fuel|diesel|def\b|toll|ez-?pass|fuel card|love'?s|pilot|ta\b|petro|expense|receipt|lumper fee)\b/],
  ['eld', /\b(eld|logs?|hos|hours of service|reset|34|break|on duty|off duty|sleeper|personal conveyance|yard move|motive|samsara)\b/],
  ['breakdowns', /\b(breakdown|broke|repair|shop|mechanic|tow|tire|flat|roadside|dpf|regen|leak|check engine|derate|battery|jump)\b/],
  ['equipment', /\b(trailer|reefer|truck number|unit|dvir|pre-?trip|inspection sticker|registration|plates?|chassis|container)\b/],
  ['safety', /\b(dot|scale house|weigh station|inspection|ticket|citation|accident|crash|police|out of service|cvsa|insurance)\b/],
  ['hometime', /\b(home time|go home|going home|vacation|days off|ticket home|flight|bus ticket|coming back)\b/],
  ['hiring', /\b(onboard|orientation|drug test|clearinghouse|contract|application|mvr|cdl|medical card|psp|hire|start date)\b/],
  ['sites', /\b(gate|check-?in|guard|dock|door|yard|facility|warehouse|site|dc\b|[a-z]{3}\d\b)\b/],
  ['road', /\b(route|road|bridge|parking|park|weather|snow|ice|traffic|nyc|gw bridge|turnpike|i-\d+)\b/],
  ['delivery', /\b(pickup|pick up|delivery|deliver|appointment|appt|bol|pod|seal|detention|late|early|live load|drop)\b/],
  ['loads', /\b(load|book|booking|relay|load board|lane|rate|dispatch|empty|reload)\b/],
];
function guess(text, kind) {
  const t = String(text || '').toLowerCase();
  for (const [k, r] of GUESS) if (r.test(t)) return k;
  return kind === 'site' ? 'sites' : kind === 'accounting' ? 'pay' : kind === 'dispatch' ? 'loads' : 'other';
}

// ---------- words ----------
const STOP = new Set(('a an the to of and or for in on at by with is are was were be been it its this that these those do does did can could i you he she we they my our your his her ' +
  'what when where how why who whom which if then than from as not no yes will would should shall have has had me us them their there here about into out up so just ' +
  'any some all get got also only very too can\'t don\'t dont cant ok okay please').split(' '));
const stem = (w) => (w.length > 4 ? w.replace(/(ings|ing|ies|ied|es|ed|s)$/, '') : w);
function toks(s) {
  return new Set(String(s || '').toLowerCase().replace(/kearney/g, 'kearny').split(/[^a-z0-9$]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem));
}
// "payday" and "pay day", "checkin" and "check in": a word that is two words of the other text counts as those two
function split(a, b) {
  const out = new Set();
  for (const t of a) {
    let done = false;
    if (!b.has(t) && t.length >= 6) for (let i = 2; i <= t.length - 2 && !done; i++) {
      const x = t.slice(0, i), y = t.slice(i);
      if ((b.has(x) || STOP.has(x)) && (b.has(y) || STOP.has(y)) && (b.has(x) || b.has(y))) { for (const w of [x, y]) if (!STOP.has(w)) out.add(w); done = true; }
    }
    if (!done) out.add(t);
  }
  return out;
}
function sim(a, b) {
  if (!a.size || !b.size) return 0;
  a = split(a, b); b = split(b, a);
  let n = 0; for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}
const placeKey = (s) => String(s || '').toLowerCase().replace(/^amazon\s+/, '').replace(/kearney/g, 'kearny').replace(/[^a-z0-9]+/g, ' ').trim() || null;
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const cfgAuto = () => { const t = (db.settings && db.settings.tg) || {}; return t.kbAuto !== false; };
const AUTO_GROUPS = 3;

// how close an entry is to another one (0..1)
function closeness(kind, a, b) {
  if (kind === 'site') return sim(toks(a.answer), toks(b.answer)); // the question is the place: compare the facts
  const qq = sim(toks(a.question), toks(b.question));
  return Math.max(qq, 0.5 * qq + 0.5 * sim(toks(a.question + ' ' + a.answer), toks(b.question + ' ' + b.answer)));
}

// Add what the team said. The same thing again: seen once more (in one more group), and a different wording of the answer
// is kept as another way it was said. Returns { id, added | seen | approved }.
// opts.sure: a person wrote the answer for this (a recruiter answering a driver, a manager on the website): it is used now.
async function add(x) {
  const kind = KINDS[x.kind] ? x.kind : 'general';
  const question = clean(x.question, 600), answer = clean(x.answer, 1500);
  if (question.length < 3 || answer.length < 3) return null;
  const pk = kind === 'site' ? placeKey(x.place || question) : null;
  const topic = TOPICS[x.topic] ? x.topic : guess(question + ' ' + answer, kind);
  const chatId = x.chatId || null, sure = !!x.sure;
  const exact = (await q(`SELECT * FROM tg_knowledge WHERE kind = $1 AND lower(question) = lower($2) AND lower(answer) = lower($3) LIMIT 1`, [kind, question, answer])).rows[0];
  let best = exact, score = exact ? 1 : 0;
  if (!best) {
    const rows = (await q(`SELECT * FROM tg_knowledge WHERE kind = $1 ${kind === 'site' ? 'AND place_key = $2' : ''} ORDER BY seen DESC, id LIMIT 3000`, kind === 'site' ? [kind, pk] : [kind])).rows;
    for (const r of rows) { const s = closeness(kind, { question, answer }, r); if (s > score) { score = s; best = r; } }
  }
  const SAME = kind === 'site' ? 0.45 : 0.5;
  if (best && score >= SAME) {
    const chats = [...new Set([...(best.chats || []).map(String), ...(chatId ? [String(chatId)] : [])])];
    const variants = Array.isArray(best.variants) ? best.variants : [];
    const differs = sim(toks(answer), toks(best.answer)) < 0.6 && !variants.some((v) => sim(toks(answer), toks(v.answer)) >= 0.6);
    if (differs && variants.length < 6) variants.push({ answer, by: x.by || null, at: new Date().toISOString().slice(0, 10) });
    const sets = ['seen = seen + 1', 'last_seen = now()', 'chats = $2::bigint[]', 'variants = $3::jsonb', 'updated_at = now()'];
    const vals = [best.id, chats, JSON.stringify(variants)];
    if (differs) sets.push('tidied = false');
    let res = 'seen';
    if (sure) { // a person's answer wins: it becomes the answer, the old one is kept as a variant
      if (differs) { variants.pop(); variants.push({ answer: best.answer, by: best.added_by, at: String(best.created_at || '').slice(0, 10) }); vals[2] = JSON.stringify(variants); vals.push(answer); sets.push(`answer = $${vals.length}`); }
      sets.push('active = true', 'review = false'); res = 'approved';
    } else if (!best.active && best.review && cfgAuto() && chats.length >= AUTO_GROUPS && !best.conflict_note && !differs) {
      sets.push('active = true', 'review = false', `approved_by = 'Seen in ${AUTO_GROUPS}+ groups'`); res = 'approved';
    }
    await q(`UPDATE tg_knowledge SET ${sets.join(', ')} WHERE id = $1`, vals);
    return { id: best.id, [res]: true };
  }
  const r = await q(`INSERT INTO tg_knowledge (question, answer, source, added_by, chat_id, kind, active, review, topic, place_key, city, state, chats, seen, last_seen, tidied)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::bigint[], 1, now(), false) RETURNING id`,
  [question, answer, x.source || (sure ? 'learned' : 'conversation'), x.by || null, chatId, kind, sure || !!x.active, !sure && !x.active && x.review !== false, topic, pk,
    clean(x.city, 60) || null, (String(x.state || '').toUpperCase().match(/^[A-Z]{2}$/) || [null])[0], chatId ? [chatId] : []]);
  return { id: r.rows[0].id, added: true };
}

// The entries that fit a question, best first (the bot reads only these instead of everything)
async function pick({ kinds = ['general'], text = '', limit = 25 }) {
  const rows = (await q(`SELECT id, kind, question, answer, seen, uses FROM tg_knowledge WHERE active AND kind = ANY($1::text[]) ORDER BY seen DESC, uses DESC, id DESC LIMIT 1500`, [kinds])).rows;
  const t = toks(text);
  const scored = rows.map((r) => ({ r, s: (t.size ? sim(t, toks(r.question + ' ' + r.answer)) * 10 + sim(t, toks(r.question)) * 6 : 0) + Math.log2(1 + (r.seen || 1)) * 0.3 + Math.log2(1 + (r.uses || 0)) * 0.2 }));
  scored.sort((a, b) => b.s - a.s);
  const out = scored.slice(0, limit).map((x) => x.r);
  const hit = scored.filter((x) => x.s > 1.5).slice(0, 3).map((x) => x.r.id);
  if (hit.length) await q(`UPDATE tg_knowledge SET uses = uses + 1 WHERE id = ANY($1::int[])`, [hit]).catch(() => {});
  return out.map((r) => ({ question: r.kind === 'site' ? `About ${r.question}` : r.question, answer: r.answer }));
}

// One search across everything the team knows: the knowledge base, the team's words, shops & services, road case playbooks
// role: a recruiter searches the answers for drivers only (not the dispatching practices, sites, shops, playbooks, dispatch words)
const kindsFor = (role) => (role === 'member' ? ['general', 'accounting'] : Object.keys(KINDS));
async function search(text, { limit = 40, all = false, role = 'admin' } = {}) {
  const recruiter = role === 'member';
  const t = toks(text); if (!t.size) return [];
  const score = (s) => { const w = toks(s); let n = 0; for (const x of t) if (w.has(x) || [...w].some((y) => y.startsWith(x) && x.length >= 3)) n++; return n / t.size; };
  const out = [];
  for (const r of (await q(`SELECT id, kind, topic, question, answer, active, seen FROM tg_knowledge WHERE kind = ANY($1::text[]) ${all ? '' : 'AND active'} LIMIT 5000`, [kindsFor(role)])).rows) {
    const s = score(r.question + ' ' + r.answer); if (s >= 0.5) out.push({ type: 'kb', id: r.id, kind: r.kind, topic: r.topic, title: r.question, text: r.answer, active: r.active, s: s + Math.min(r.seen || 1, 10) / 100 });
  }
  if (recruiter) return out.sort((a, b) => b.s - a.s).slice(0, limit).map(({ s, ...x }) => x);
  for (const r of (await q(`SELECT id, term, meaning FROM tg_terms WHERE active`)).rows) { const s = score(r.term + ' ' + r.meaning); if (s >= 0.5) out.push({ type: 'term', id: r.id, title: `"${r.term}"`, text: r.meaning, s }); }
  for (const r of (await q(`SELECT id, name, kind, services, phone, city, state, area, notes FROM places WHERE NOT hidden`).catch(() => ({ rows: [] }))).rows) {
    const s = score(`${r.name} ${r.kind} ${(r.services || []).join(' ')} ${r.city || ''} ${r.state || ''} ${r.area || ''} ${r.notes || ''}`);
    if (s >= 0.5) out.push({ type: 'place', id: r.id, title: r.name, text: [(r.services || []).join(', '), [r.city, r.state].filter(Boolean).join(', '), r.phone].filter(Boolean).join(' · '), s });
  }
  for (const r of (await q(`SELECT id, title, when_text, steps FROM tg_playbooks WHERE active`).catch(() => ({ rows: [] }))).rows) {
    const s = score(`${r.title} ${r.when_text} ${(r.steps || []).map((x) => x.text || x).join(' ')}`); if (s >= 0.5) out.push({ type: 'playbook', id: r.id, title: r.title, text: r.when_text, s });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, limit).map(({ s, ...x }) => x);
}

// ---------- the AI tidy: a few times a day, only for new or changed entries ----------
let lastTidy = 0, tidying = false;
async function tidy({ batches = 3 } = {}) {
  if (tidying) return { skipped: true }; tidying = true;
  const done = { tidied: 0, merged: 0, conflicts: 0 };
  try {
    for (let b = 0; b < batches; b++) {
      const rows = (await q(`SELECT id, kind, topic, question, answer, variants, source, active, locked FROM tg_knowledge WHERE NOT tidied ORDER BY seen DESC, id LIMIT 40`)).rows;
      if (!rows.length) break;
      const ids = rows.map((r) => r.id); const topics = [...new Set(rows.map((r) => r.topic).filter(Boolean))];
      const others = (await q(`SELECT id, kind, topic, question, answer FROM tg_knowledge WHERE tidied AND NOT (id = ANY($1::int[])) AND (topic = ANY($2::text[]) OR kind = 'site') ORDER BY active DESC, seen DESC LIMIT 150`, [ids, topics])).rows;
      const r = await require('./tg/ai').kbTidy({ items: rows, others });
      const byId = new Map(rows.map((x) => [x.id, x]));
      const known = new Set([...ids, ...others.map((o) => o.id)]);
      for (const it of (r.items || [])) {
        const row = byId.get(+it.id); if (!row) continue; byId.delete(row.id);
        const dup = +it.duplicate_of;
        if (dup && dup !== row.id && known.has(dup)) {
          const tgt = (await q(`SELECT * FROM tg_knowledge WHERE id = $1`, [dup])).rows[0];
          if (tgt && tgt.kind === row.kind) {
            const full = (await q(`SELECT * FROM tg_knowledge WHERE id = $1`, [row.id])).rows[0];
            const chats = [...new Set([...(tgt.chats || []), ...(full.chats || [])].map(String))];
            const variants = [...(tgt.variants || []), ...(full.variants || [])];
            if (sim(toks(full.answer), toks(tgt.answer)) < 0.6) variants.push({ answer: full.answer, by: full.added_by, at: String(full.created_at).slice(0, 10) });
            await q(`UPDATE tg_knowledge SET seen = seen + $2, uses = uses + $3, chats = $4::bigint[], variants = $5::jsonb, active = active OR $6, review = CASE WHEN active OR $6 THEN false ELSE review END, last_seen = GREATEST(last_seen, $7), updated_at = now() WHERE id = $1`,
              [tgt.id, full.seen || 1, full.uses || 0, chats, JSON.stringify(variants.slice(-6)), full.active, full.last_seen || full.created_at]);
            await q(`DELETE FROM tg_knowledge WHERE id = $1`, [row.id]);
            known.delete(row.id); done.merged++; continue;
          }
        }
        const locked = row.source === 'added' || row.locked;
        const nq = !locked && clean(it.question, 600), na = !locked && clean(it.answer, 1500);
        const conflict = clean(it.conflict, 300) || null;
        await q(`UPDATE tg_knowledge SET question = COALESCE(NULLIF($2, ''), question), answer = COALESCE(NULLIF($3, ''), answer), topic = $4, conflict_note = $5,
          variants = CASE WHEN $5::text IS NULL THEN '[]'::jsonb ELSE variants END, review = CASE WHEN $5::text IS NOT NULL THEN true ELSE review END, tidied = true, updated_at = now() WHERE id = $1`,
        [row.id, nq && nq.length >= 3 ? nq : '', na && na.length >= 3 ? na : '', TOPICS[it.topic] ? it.topic : row.topic || guess(row.question + ' ' + row.answer, row.kind), conflict]);
        done.tidied++; if (conflict) done.conflicts++;
      }
      // anything the AI left out: keep as it is, don't ask again
      if (byId.size) await q(`UPDATE tg_knowledge SET tidied = true WHERE id = ANY($1::int[])`, [[...byId.keys()]]);
    }
  } finally { tidying = false; lastTidy = Date.now(); }
  return done;
}
const TIDY_MS = () => +process.env.KB_TIDY_MS || 6 * 3600 * 1000;
async function tick() {
  if (Date.now() - lastTidy < TIDY_MS()) return;
  const ai = require('./tg/ai'); if (!ai.on()) return;
  const n = (await q(`SELECT count(*)::int n FROM tg_knowledge WHERE NOT tidied`)).rows[0].n;
  if (!n) { lastTidy = Date.now(); return; }
  await tidy().catch((e) => { lastTidy = Date.now(); console.error('kb tidy', e.message); });
}

// the topic of the old entries (once, at the upgrade)
async function backfill() {
  for (const r of (await q(`SELECT id, kind, question, answer, chat_id FROM tg_knowledge WHERE topic IS NULL`)).rows) {
    await q(`UPDATE tg_knowledge SET topic = $2, chats = CASE WHEN $3::bigint IS NULL THEN chats ELSE ARRAY[$3::bigint] END WHERE id = $1`, [r.id, guess(r.question + ' ' + r.answer, r.kind), r.chat_id]);
  }
}

module.exports = { kindsFor, TOPICS, KINDS, AUTO_GROUPS, guess, toks, sim, placeKey, add, pick, search, tidy, tick, backfill };
