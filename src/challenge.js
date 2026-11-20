// The daily challenge: hit every Facebook target today. Days in a row with all targets met make a streak.
// A day that is not a working day for the person, or a day off, neither adds to the streak nor breaks it.
// Badges come from the streaks and the all-time totals, so nothing extra is stored.
const db = require('./db');
const lib = require('./lib');
const hours = require('./api-hours');
const { q } = db;
const { wrap, needUser } = lib;

const KINDS = ['post', 'comment', 'contact', 'chat'];
const LOOKBACK = 400; // days of history used for streaks and badges

const BADGES = [
  { id: 'first', icon: '⭐', name: 'First full day', what: 'Hit every target in one day', kind: 'best', need: 1 },
  { id: 'streak3', icon: '🔥', name: 'On a roll', what: '3 working days in a row', kind: 'best', need: 3 },
  { id: 'streak5', icon: '🚚', name: 'Full week', what: '5 working days in a row', kind: 'best', need: 5 },
  { id: 'streak10', icon: '🏅', name: 'Ten straight', what: '10 working days in a row', kind: 'best', need: 10 },
  { id: 'streak20', icon: '🛣️', name: 'Long haul', what: '20 working days in a row', kind: 'best', need: 20 },
  { id: 'streak50', icon: '🏆', name: 'Iron driver', what: '50 working days in a row', kind: 'best', need: 50 },
  { id: 'month', icon: '📅', name: 'Perfect month', what: 'Every working day of a month', kind: 'months', need: 1 },
  { id: 'posts100', icon: '📣', name: '100 group posts', what: 'Ads posted in groups, all time', kind: 'post', need: 100 },
  { id: 'comments500', icon: '💬', name: '500 comments', what: 'Comments on ads, all time', kind: 'comment', need: 500 },
  { id: 'drivers500', icon: '🤝', name: '500 drivers', what: 'Drivers messaged, all time', kind: 'contact', need: 500 },
  { id: 'leads10', icon: '🎯', name: '10 Facebook leads', what: 'Drivers from Facebook made into leads', kind: 'leads', need: 10 }
];

const targetsOn = () => { const t = db.settings.fbTargets || {}; return KINDS.reduce((a, k) => a + (t[k] || 0), 0) > 0; };
// A day's counts meet every target (each kind up to its own target)
const meets = (c) => { const t = db.settings.fbTargets || {}; return targetsOn() && KINDS.every((k) => (c[k] || 0) >= (t[k] || 0)); };

// History before today does not change while the day goes on, so it is kept for a few minutes.
const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;
const forget = (userId) => { for (const k of cache.keys()) if (k.startsWith(userId + ':')) cache.delete(k); };

async function history(u, today) {
  const key = `${u.id}:${today}:${JSON.stringify(db.settings.fbTargets)}`;
  const hit = cache.get(key); if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  const tz = db.settings.tz;
  const born = (await q(`SELECT (created_at AT TIME ZONE $2)::date::text d FROM users WHERE id = $1`, [u.id, tz])).rows[0].d;
  const rows = (await q(`SELECT to_char(day, 'YYYY-MM-DD') d, kind, count(*)::int n FROM fb_entries
    WHERE user_id = $1 AND day < $2::date AND day >= $2::date - $3::int GROUP BY 1, 2`, [u.id, today, LOOKBACK])).rows;
  const offs = new Set((await q(`SELECT day::text d FROM days_off WHERE user_id = $1 AND day <= $2::date AND day >= $2::date - $3::int`, [u.id, today, LOOKBACK])).rows.map((r) => r.d));
  const dates = (await q(`SELECT g::date::text d, extract(dow FROM g)::int dow FROM generate_series($1::date - $2::int, $1::date - 1, interval '1 day') g ORDER BY g`, [today, LOOKBACK])).rows;
  const byDay = {};
  for (const r of rows) (byDay[r.d] = byDay[r.d] || {})[r.kind] = r.n;
  const week = hours.weekOf(u);
  // each past day: 'met', 'skip' (not a working day, a day off, or before the account) or 'miss'
  const days = dates.map(({ d, dow }) => {
    const met = meets(byDay[d] || {});
    if (met) return { d, s: 'met' };
    if (d < born || !week[dow] || offs.has(d)) return { d, s: 'skip' };
    return { d, s: 'miss' };
  });
  // best run, and finished months with every working day met
  let run = 0, best = 0; const months = {};
  for (const x of days) {
    if (x.s === 'met') { run++; best = Math.max(best, run); } else if (x.s === 'miss') run = 0;
    const m = x.d.slice(0, 7); const mm = months[m] || (months[m] = { met: 0, miss: 0 });
    if (x.s === 'met') mm.met++; if (x.s === 'miss') mm.miss++;
  }
  // the run that is still going at yesterday
  let tail = 0;
  for (let i = days.length - 1; i >= 0; i--) { if (days[i].s === 'met') tail++; else if (days[i].s === 'miss') break; }
  const thisMonth = today.slice(0, 7);
  const perfectMonths = Object.entries(months).filter(([m, v]) => m < thisMonth && v.met > 0 && v.miss === 0 && m >= born.slice(0, 7)).length;
  const monthSoFar = months[thisMonth] || { met: 0, miss: 0 };
  // the last 14 days for the strip on My day
  const recent = days.slice(-13);
  const v = { tail, best, perfectMonths, monthSoFar, recent, scheduledToday: !!week[(new Date(today + 'T12:00:00Z')).getUTCDay()] && !offs.has(today) };
  cache.set(key, { at: Date.now(), v });
  return v;
}

// Everything the ring and the challenge card need, for one person.
async function progress(u, full) {
  const today = await lib.today();
  const t = db.settings.fbTargets || {};
  if (!targetsOn()) return { on: false };
  const rows = (await q(`SELECT kind, count(*)::int n FROM fb_entries WHERE user_id = $1 AND day = $2::date GROUP BY 1`, [u.id, today])).rows;
  const c = {}; for (const r of rows) c[r.kind] = r.n;
  let done = 0, target = 0;
  for (const k of KINDS) { target += t[k] || 0; done += Math.min(c[k] || 0, t[k] || 0); }
  const met = meets(c);
  const h = await history(u, today);
  const streak = h.tail + (met ? 1 : 0);
  const res = { on: true, today, met, done, target, pct: target ? Math.round((done / target) * 100) : 0, streak, best: Math.max(h.best, streak),
    kinds: KINDS.filter((k) => t[k] > 0).map((k) => ({ k, n: c[k] || 0, target: t[k] })),
    // the streak is at stake today: there is one going, and today is a working day not yet met
    atStake: h.tail > 0 && !met && h.scheduledToday };
  if (!full) return res;
  const totals = Object.fromEntries((await q(`SELECT kind, count(*)::int n FROM fb_entries WHERE user_id = $1 GROUP BY 1`, [u.id])).rows.map((r) => [r.kind, r.n]));
  totals.leads = (await q(`SELECT count(*)::int n FROM fb_entries WHERE user_id = $1 AND kind = 'contact' AND driver_id IS NOT NULL`, [u.id])).rows[0].n;
  const have = { best: res.best, months: h.perfectMonths, ...totals };
  res.badges = BADGES.map((b) => ({ id: b.id, icon: b.icon, name: b.name, what: b.what, need: b.need, have: Math.min(b.need, have[b.kind] || 0), earned: (have[b.kind] || 0) >= b.need }));
  res.month = { met: h.monthSoFar.met + (met ? 1 : 0), missed: h.monthSoFar.miss };
  res.recent = [...h.recent.map((x) => ({ d: x.d, s: x.s })), { d: today, s: met ? 'met' : 'today' }];
  // the team today, so people can see who already finished
  const people = (await q(`SELECT id, name FROM users WHERE active AND role <> 'admin' ORDER BY lower(name)`)).rows;
  const tc = (await q(`SELECT user_id, kind, count(*)::int n FROM fb_entries WHERE day = $1::date GROUP BY 1, 2`, [today])).rows;
  res.team = people.map((p) => {
    const pc = {}; for (const r of tc) if (r.user_id === p.id) pc[r.kind] = r.n;
    let d = 0; for (const k of KINDS) d += Math.min(pc[k] || 0, t[k] || 0);
    return { id: p.id, name: p.name, pct: target ? Math.round((d / target) * 100) : 0, met: meets(pc), me: p.id === u.id };
  }).sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
  return res;
}

module.exports = (app) => {
  app.get('/api/challenge', needUser, wrap(async (req, res) => {
    let u = req.user;
    if (req.query.user && +req.query.user !== u.id) {
      if (u.role !== 'admin') return res.status(403).json({ error: 'Only an admin can see other people' });
      u = (await q(`SELECT * FROM users WHERE id = $1`, [+req.query.user])).rows[0];
      if (!u) return res.status(404).json({ error: 'Person not found' });
    }
    res.json(await progress(u, true));
  }));
};
module.exports.progress = progress;
module.exports.forget = forget;
module.exports.BADGES = BADGES;
