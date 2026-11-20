// Badges, in groups, each with five levels (Bronze to Diamond), like a fitness tracker.
// Every number comes from what is already recorded (leads, calls, onboarding, hires, working hours, Facebook work).
// A level once reached is kept (stored in user_badges), even if a count later goes down (a driver leaves).
// A new level is a notification; the first time a person's badges are worked out, levels are recorded quietly.
const db = require('./db');
const lib = require('./lib');
const hours = require('./api-hours');
const challenge = require('./challenge');
const { q } = db;
const { wrap, needUser } = lib;

const LEVELS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
const GROUPS = [
  { id: 'habits', name: 'Work habits', icon: '⏰', what: 'Showing up on time, staying to the end, staying busy' },
  { id: 'leads', name: 'Leads', icon: '🎯', what: 'Finding drivers, calling them, moving them forward' },
  { id: 'onboarding', name: 'Onboarding', icon: '🧾', what: 'Getting drivers through the checklist, Amazon Relay and to the yard' },
  { id: 'active', name: 'Active drivers', icon: '🚚', what: 'Drivers you brought in who are on the road, and stay' },
  { id: 'facebook', name: 'Facebook', icon: '📣', what: 'Daily targets, posts, comments and drivers found on Facebook' }
];
// need: the count for each level. unit: how the count reads ("12 days").
const BADGES = [
  { id: 'early_bird', group: 'habits', icon: '🌅', name: 'Early bird', what: 'Working days started on time', unit: 'days', need: [5, 20, 50, 100, 250] },
  { id: 'finisher', group: 'habits', icon: '🏁', name: 'Strong finisher', what: 'Working days you stayed to the end of your hours', unit: 'days', need: [5, 20, 50, 100, 250] },
  { id: 'hard_worker', group: 'habits', icon: '💪', name: 'Hard worker', what: 'Hours active on the site', unit: 'hours', need: [25, 100, 250, 500, 1000] },
  { id: 'clockwork', group: 'habits', icon: '🕰️', name: 'Like clockwork', what: 'Working days in a row started on time (days off don\'t break it)', unit: 'days in a row', need: [5, 10, 20, 40, 60] },
  { id: 'locked_in', group: 'habits', icon: '🎧', name: 'Locked in', what: 'Worked days with no idle stretch', unit: 'days', need: [5, 20, 50, 100, 200] },
  { id: 'never_misses', group: 'habits', icon: '📆', name: 'Never misses', what: 'Months with every working day worked', unit: 'months', need: [1, 2, 3, 6, 12] },

  { id: 'lead_finder', group: 'leads', icon: '🔎', name: 'Lead finder', what: 'Leads you added', unit: 'leads', need: [10, 50, 150, 400, 1000] },
  { id: 'dialer', group: 'leads', icon: '📞', name: 'Dialer', what: 'Calls logged', unit: 'calls', need: [50, 250, 750, 2000, 5000] },
  { id: 'connector', group: 'leads', icon: '🗣️', name: 'Connector', what: 'Calls where you talked to the driver', unit: 'calls', need: [25, 100, 300, 750, 2000] },
  { id: 'spark', group: 'leads', icon: '✨', name: 'Spark', what: 'Your leads who became interested', unit: 'drivers', need: [5, 25, 75, 200, 500] },
  { id: 'mover', group: 'leads', icon: '⏩', name: 'Mover', what: 'Times you moved a lead to a further stage', unit: 'moves', need: [25, 100, 300, 750, 2000] },

  { id: 'onboarder', group: 'onboarding', icon: '🧾', name: 'Onboarder', what: 'Your drivers who started onboarding', unit: 'drivers', need: [1, 5, 15, 40, 100] },
  { id: 'checklist_pro', group: 'onboarding', icon: '✅', name: 'Checklist pro', what: 'Onboarding steps you ticked off', unit: 'steps', need: [25, 100, 300, 750, 2000] },
  { id: 'relay_ready', group: 'onboarding', icon: '📦', name: 'Relay ready', what: 'Your drivers verified on Amazon Relay', unit: 'drivers', need: [1, 5, 15, 40, 100] },
  { id: 'wheels_in', group: 'onboarding', icon: '🛞', name: 'Wheels in', what: 'Your drivers who arrived to start', unit: 'drivers', need: [1, 5, 15, 40, 100] },

  { id: 'closer', group: 'active', icon: '🤝', name: 'Closer', what: 'Your drivers hired', unit: 'drivers', need: [1, 5, 15, 40, 100] },
  { id: 'fleet_builder', group: 'active', icon: '🚛', name: 'Fleet builder', what: 'Your drivers on the road right now', unit: 'drivers', need: [1, 3, 8, 15, 30] },
  { id: 'keeper', group: 'active', icon: '🛡️', name: 'Keeper', what: 'Your drivers still driving 90 days after they were hired', unit: 'drivers', need: [1, 3, 10, 25, 50] },

  { id: 'on_fire', group: 'facebook', icon: '🔥', name: 'On fire', what: 'Best streak of days with every Facebook target met', unit: 'days in a row', need: [3, 5, 10, 20, 50] },
  { id: 'perfect_month', group: 'facebook', icon: '🗓️', name: 'Perfect month', what: 'Months with every Facebook target met each working day', unit: 'months', need: [1, 2, 3, 6, 12] },
  { id: 'ad_maker', group: 'facebook', icon: '🎨', name: 'Ad maker', what: 'Ad pictures made with ChatGPT', unit: 'pictures', need: [25, 100, 250, 500, 1000] },
  { id: 'poster', group: 'facebook', icon: '📣', name: 'Poster', what: 'Ads posted in groups', unit: 'posts', need: [25, 100, 250, 500, 1000] },
  { id: 'commenter', group: 'facebook', icon: '💬', name: 'Commenter', what: 'Comments on driver ads', unit: 'comments', need: [100, 500, 1000, 2500, 5000] },
  { id: 'networker', group: 'facebook', icon: '🤝', name: 'Networker', what: 'Drivers messaged on Facebook', unit: 'drivers', need: [50, 250, 500, 1000, 2500] },
  { id: 'fb_eye', group: 'facebook', icon: '🎯', name: 'Sharp eye', what: 'Drivers from Facebook made into leads', unit: 'leads', need: [1, 5, 10, 25, 50] },
  { id: 'real_person', group: 'facebook', icon: '🙂', name: 'Real person', what: 'Personal posts and comments that keep the account safe', unit: 'posts and comments', need: [25, 100, 250, 500, 1000] }
];
const BY_ID = Object.fromEntries(BADGES.map((b) => [b.id, b]));
const levelOf = (b, n) => b.need.filter((x) => n >= x).length; // 0 = not yet, 1 = Bronze … 5 = Diamond

// ---------- the numbers ----------
async function workHabits(u) {
  const today = await lib.today();
  const p = (await hours.loadPeople([u.id]))[0]; if (!p) return {};
  const from = (await q(`SELECT greatest($1::date, $2::date - 400)::text d`, [p.created_local, today])).rows[0].d;
  const a = (await hours.attendance([p], from, today))[p.id];
  let onTime = 0, finish = 0, focus = 0, run = 0, bestRun = 0; const months = {};
  for (const d of a.days) {
    const worked = d.status === 'worked' || d.status === 'extra';
    const ok = d.status === 'worked' && d.sch && !d.late;
    if (ok) onTime++;
    if (d.status === 'worked' && d.sch && d.date < today && !d.early && d.last) finish++;
    if (worked && !d.idles.length) focus++;
    // on time in a row: a day off, a rest day or today (not over) neither adds nor breaks
    if (ok) { run++; bestRun = Math.max(bestRun, run); } else if (d.sch && (d.status === 'worked' || d.status === 'off')) run = 0;
    const m = d.date.slice(0, 7); const mm = months[m] || (months[m] = { worked: 0, off: 0 });
    if (worked) mm.worked++; if (d.status === 'off') mm.off++;
  }
  const thisMonth = today.slice(0, 7);
  const perfect = Object.entries(months).filter(([m, v]) => m < thisMonth && v.worked > 0 && v.off === 0).length;
  const secs = (await q(`SELECT coalesce(sum(active_seconds), 0)::bigint s FROM activity_hours WHERE user_id = $1`, [u.id])).rows[0].s;
  return { early_bird: onTime, finisher: finish, hard_worker: Math.floor(+secs / 3600), clockwork: bestRun, locked_in: focus, never_misses: perfect };
}
async function counts(u) {
  const one = async (sql, params = [u.id]) => +(await q(sql, params)).rows[0].n;
  const mine = `d.owner_id = $1`;
  return {
    lead_finder: await one(`SELECT count(*)::int n FROM activity WHERE user_id = $1 AND type = 'lead_add'`),
    dialer: await one(`SELECT count(*)::int n FROM activity WHERE user_id = $1 AND type = 'contact' AND detail LIKE 'Call%'`),
    connector: await one(`SELECT count(*)::int n FROM activity WHERE user_id = $1 AND type = 'contact' AND detail LIKE 'Call, talked%'`),
    spark: await one(`SELECT count(DISTINCT s.driver_id)::int n FROM status_log s JOIN drivers d ON d.id = s.driver_id WHERE ${mine} AND s.to_status = 'Interested'`),
    mover: await one(`SELECT count(*)::int n FROM status_log WHERE user_id = $1 AND array_position($2::text[], to_status) > array_position($2::text[], from_status)`, [u.id, db.ROUTE]),
    onboarder: await one(`SELECT count(*)::int n FROM onboarding o JOIN drivers d ON d.id = o.driver_id WHERE ${mine}`),
    checklist_pro: await one(`SELECT count(*)::int n FROM checklist WHERE done AND done_by = $1`),
    relay_ready: await one(`SELECT count(*)::int n FROM drivers d WHERE ${mine} AND d.amazon_step = 'verified'`),
    wheels_in: await one(`SELECT count(*)::int n FROM onboarding o JOIN drivers d ON d.id = o.driver_id WHERE ${mine} AND o.arrived_on IS NOT NULL`),
    closer: await one(`SELECT count(*)::int n FROM drivers d WHERE ${mine} AND (d.status = 'Hired' OR EXISTS (SELECT 1 FROM status_log s WHERE s.driver_id = d.id AND s.to_status = 'Hired'))`),
    fleet_builder: await one(`SELECT count(*)::int n FROM drivers d WHERE ${mine} AND d.status = 'Hired' AND d.left_on IS NULL`),
    keeper: await one(`SELECT count(*)::int n FROM drivers d LEFT JOIN onboarding o ON o.driver_id = d.id WHERE ${mine} AND d.status = 'Hired' AND d.left_on IS NULL AND coalesce(o.completed_at, d.status_at) < now() - interval '90 days'`)
  };
}
async function facebook(u) {
  const f = await challenge.fbStats(u); const t = f.totals;
  return { on_fire: f.best, perfect_month: f.perfectMonths, ad_maker: t.picture || 0, poster: t.post || 0, commenter: t.comment || 0, networker: t.contact || 0, fb_eye: f.leads, real_person: (t.ppost || 0) + (t.pcomment || 0) };
}

// ---------- levels, kept and announced ----------
const cache = new Map(); const CACHE_MS = 2 * 60 * 1000;
async function compute(u, { fresh } = {}) {
  const hit = cache.get(u.id); if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  const have = { ...(await workHabits(u)), ...(await counts(u)), ...(await facebook(u)) };
  const kept = (await q(`SELECT badge, max(level)::int level, max(earned_at) at FROM user_badges WHERE user_id = $1 GROUP BY 1`, [u.id])).rows;
  const first = !(await q(`SELECT 1 FROM user_badges WHERE user_id = $1 LIMIT 1`, [u.id])).rows[0] && !(await q(`SELECT 1 FROM users WHERE id = $1 AND badges_seen`, [u.id])).rows[0];
  const keptOf = Object.fromEntries(kept.map((k) => [k.badge, k]));
  const fresh2 = [];
  for (const b of BADGES) {
    const now = levelOf(b, have[b.id] || 0); const before = keptOf[b.id] ? keptOf[b.id].level : 0;
    for (let l = before + 1; l <= now; l++) {
      const ins = await q(`INSERT INTO user_badges (user_id, badge, level) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING earned_at`, [u.id, b.id, l]);
      if (ins.rows[0]) fresh2.push({ b, l, at: ins.rows[0].earned_at });
    }
  }
  if (first) await q(`UPDATE users SET badges_seen = true WHERE id = $1`, [u.id]);
  else {
    // one notification per badge, for its highest new level
    const top = {}; for (const x of fresh2) if (!top[x.b.id] || x.l > top[x.b.id].l) top[x.b.id] = x;
    for (const x of Object.values(top)) await db.notify(db.pool, u.id, 'badge', `${x.b.icon} New badge: ${x.b.name}, ${LEVELS[x.l - 1]}. ${have[x.b.id]} ${x.b.unit}.`, '#/badges');
  }
  const levels = (await q(`SELECT badge, level, earned_at FROM user_badges WHERE user_id = $1 ORDER BY earned_at DESC, level DESC`, [u.id])).rows;
  const best = {}; for (const r of levels) if (!best[r.badge] || r.level > best[r.badge].level) best[r.badge] = r;
  const list = BADGES.map((b) => {
    const n = have[b.id] || 0; const lvl = Math.max(levelOf(b, n), best[b.id] ? best[b.id].level : 0);
    return { id: b.id, group: b.group, icon: b.icon, name: b.name, what: b.what, unit: b.unit, need: b.need, have: n, level: lvl,
      levelName: lvl ? LEVELS[lvl - 1] : null, next: lvl < 5 ? b.need[lvl] : null, nextName: lvl < 5 ? LEVELS[lvl] : null, earnedAt: best[b.id] ? best[b.id].earned_at : null };
  });
  const recent = levels.slice(0, 8).map((r) => ({ id: r.badge, icon: BY_ID[r.badge] ? BY_ID[r.badge].icon : '🏅', name: BY_ID[r.badge] ? BY_ID[r.badge].name : r.badge, level: r.level, levelName: LEVELS[r.level - 1], at: r.earned_at }));
  const v = { levels: LEVELS, groups: GROUPS.map((g) => ({ ...g, earned: list.filter((b) => b.group === g.id).reduce((a, b) => a + b.level, 0), total: list.filter((b) => b.group === g.id).length * 5 })),
    badges: list, recent, earned: list.reduce((a, b) => a + b.level, 0), total: list.length * 5 };
  cache.set(u.id, { at: Date.now(), v });
  return v;
}
// Checked about once an hour while the person is on the site (from the heartbeat)
const checked = new Map();
async function hourly(u) { const t = Date.now(); if (t - (checked.get(u.id) || 0) < 3600000) return; checked.set(u.id, t); await compute(u, { fresh: true }); }

module.exports = (app) => {
  app.get('/api/badges', needUser, wrap(async (req, res) => {
    let u = req.user;
    if (req.query.user && +req.query.user !== u.id) {
      if (u.role !== 'admin') return res.status(403).json({ error: 'Only an admin can see other people' });
      u = (await q(`SELECT * FROM users WHERE id = $1`, [+req.query.user])).rows[0];
      if (!u) return res.status(404).json({ error: 'Person not found' });
    }
    res.json({ person: { id: u.id, name: u.name }, ...(await compute(u, { fresh: req.query.quick !== '1' })) }); // the Badges page is always up to date; My day may use a 2-minute-old copy
  }));
  // The team at a glance (admin): levels in each group, and the latest badge
  app.get('/api/badges/team', needUser, wrap(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can see the team' });
    const people = (await q(`SELECT * FROM users WHERE active AND role <> 'admin' ORDER BY lower(name)`)).rows;
    const out = [];
    for (const p of people) { const v = await compute(p); out.push({ id: p.id, name: p.name, earned: v.earned, total: v.total, groups: v.groups.map((g) => ({ id: g.id, earned: g.earned, total: g.total })), latest: v.recent[0] || null }); }
    res.json({ groups: GROUPS, levels: LEVELS, people: out.sort((a, b) => b.earned - a.earned) });
  }));
};
module.exports.compute = compute;
module.exports.hourly = hourly;
module.exports.BADGES = BADGES;
module.exports.LEVELS = LEVELS;
