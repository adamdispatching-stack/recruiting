// Facebook work: what each recruiter did in Facebook groups today, with links and pictures, against daily targets.
//   post    an ad picture posted in a group: group name and link, the post's link, the picture
//   comment a comment under someone else's ad: the ad's link and a screenshot of the comment
//   contact a driver messaged: profile link, name, OTR? Class A CDL? and how it went; can become a lead
//   chat    a group chat they were added to: its name and link
// Admins see everyone, mark each entry OK or Problem (with a note), and set the daily targets.
const crypto = require('crypto');
const db = require('./db');
const lib = require('./lib');
const { q } = db;
const { wrap, needUser, needAdmin, act, isDate } = lib;

const KINDS = ['post', 'comment', 'contact', 'chat'];
const LABEL = { post: 'group post', comment: 'comment', contact: 'driver messaged', chat: 'group chat joined' };
const OUTCOMES = ['messaged', 'replied', 'interested', 'not interested'];
const MAX_IMAGE = 4 * 1024 * 1024;
const KEEP_IMAGES_DAYS = 120;

// A Facebook link without tracking bits, so the same post or person is caught twice.
function linkKey(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|web|mbasic|business)\./, '');
  const keep = ['id', 'story_fbid', 'fbid', 'v', 'multi_permalinks'];
  const qs = keep.filter((k) => u.searchParams.get(k)).map((k) => `${k}=${u.searchParams.get(k)}`).join('&');
  return `${host}${u.pathname.replace(/\/+$/, '').toLowerCase()}${qs ? '?' + qs : ''}`;
}
const isFb = (key) => !!key && /^(facebook\.com|fb\.com|fb\.me|fb\.watch|m\.me|messenger\.com)(\/|\?|$)/.test(key);
const clean = (v, n = 300) => String(v || '').trim().slice(0, n) || null;
const yn = (v) => (v === 'yes' || v === true ? 'yes' : v === 'no' || v === false ? 'no' : null);

const today = () => lib.today();
const canSeeUser = (req, id) => req.user.role === 'admin' || id === req.user.id;
const out = (e) => ({ id: e.id, userId: e.user_id, day: e.dayt || (e.day instanceof Date ? e.day.toISOString().slice(0, 10) : e.day), kind: e.kind, link: e.link, groupName: e.group_name, groupLink: e.group_link,
  personName: e.person_name, answers: e.answers || {}, outcome: e.outcome, note: e.note, imageId: e.image_id, review: e.review, reviewNote: e.review_note,
  reviewedBy: e.reviewed_name || null, reviewedAt: e.reviewed_at, driverId: e.driver_id, driverName: e.driver_name || null, createdAt: e.created_at });
const SELECT = `SELECT e.*, to_char(e.day, 'YYYY-MM-DD') AS dayt, r.name reviewed_name, d.name driver_name FROM fb_entries e
  LEFT JOIN users r ON r.id = e.reviewed_by LEFT JOIN drivers d ON d.id = e.driver_id`;

async function counts(userIds, from, to) {
  const rows = (await q(`SELECT user_id, kind, count(*)::int n, count(*) FILTER (WHERE review = 'problem')::int bad, count(*) FILTER (WHERE review IS NULL)::int open
    FROM fb_entries WHERE user_id = ANY($1::int[]) AND day BETWEEN $2::date AND $3::date GROUP BY 1, 2`, [userIds, from, to])).rows;
  const res = {};
  for (const id of userIds) res[id] = { post: 0, comment: 0, contact: 0, chat: 0, problems: 0, unreviewed: 0 };
  for (const r of rows) { res[r.user_id][r.kind] = r.n; res[r.user_id].problems += r.bad; res[r.user_id].unreviewed += r.open; }
  return res;
}
// done against target, counting each kind only up to its target (doing 30 comments does not make up for no posts)
function score(c) {
  const t = db.settings.fbTargets; let done = 0, target = 0;
  for (const k of KINDS) { target += t[k] || 0; done += Math.min(c[k] || 0, t[k] || 0); }
  return { done, target, met: target > 0 && done >= target };
}

module.exports = (app) => {
  // ---------- pictures (the ad picture of a post, the screenshot of a comment) ----------
  app.post('/api/fb/images', needUser, wrap(async (req, res) => {
    const m = String((req.body || {}).data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: 'Choose a picture (JPG, PNG or WebP)' });
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > MAX_IMAGE) return res.status(400).json({ error: 'The picture is too big. Use one under 4 MB.' });
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    // the same picture twice: posts must use a new picture, and a screenshot proves one comment only
    const used = (await q(`SELECT e.kind, to_char(e.day, 'Mon DD') d, u.name FROM fb_entries e JOIN fb_images i ON i.id = e.image_id JOIN users u ON u.id = e.user_id WHERE i.sha = $1 LIMIT 1`, [sha])).rows[0];
    if (used) return res.status(409).json({ error: `This exact picture was already used for a ${LABEL[used.kind]} by ${used.name} on ${used.d}. Use a new one.` });
    const r = await q(`INSERT INTO fb_images (user_id, mime, bytes, sha) VALUES ($1, $2, $3, $4) RETURNING id`, [req.user.id, m[1], bytes, sha]);
    res.json({ id: r.rows[0].id });
  }));
  app.get('/api/fb/images/:id', needUser, wrap(async (req, res) => {
    const i = (await q(`SELECT mime, bytes, user_id FROM fb_images WHERE id = $1`, [+req.params.id || 0])).rows[0];
    if (!i || !(req.user.role === 'admin' || i.user_id === req.user.id)) return res.status(404).json({ error: 'Picture not found' });
    res.set('Content-Type', i.mime).set('Cache-Control', 'private, max-age=86400').send(i.bytes);
  }));

  // ---------- one person's day ----------
  app.get('/api/fb/day', needUser, wrap(async (req, res) => {
    const t = await today();
    const uid = req.query.user && req.query.user !== 'me' ? +req.query.user : req.user.id;
    if (!canSeeUser(req, uid)) return res.status(403).json({ error: 'Only an admin can see other people' });
    const day = isDate(req.query.day) ? req.query.day : t;
    const person = (await q(`SELECT id, name FROM users WHERE id = $1`, [uid])).rows[0];
    if (!person) return res.status(404).json({ error: 'Person not found' });
    const entries = (await q(`${SELECT} WHERE e.user_id = $1 AND e.day = $2::date ORDER BY e.created_at`, [uid, day])).rows.map(out);
    const c = (await counts([uid], day, day))[uid];
    // groups this person used lately, to pick from instead of typing again
    const groups = (await q(`SELECT DISTINCT ON (lower(group_name)) group_name name, group_link link FROM fb_entries WHERE group_name IS NOT NULL AND day > $1::date - 30 ORDER BY lower(group_name), created_at DESC LIMIT 200`, [t])).rows;
    // problems the admin flagged on earlier days that are still open (the recruiter should see them)
    const flagged = (await q(`${SELECT} WHERE e.user_id = $1 AND e.review = 'problem' AND e.day <> $2::date AND e.day > $2::date - 14 ORDER BY e.day DESC LIMIT 30`, [uid, day])).rows.map(out);
    res.json({ day, today: t, person, targets: db.settings.fbTargets, counts: c, score: score(c), entries, groups, flagged, outcomes: OUTCOMES });
  }));

  // ---------- the team's day (admin) ----------
  app.get('/api/fb/team', needUser, needAdmin, wrap(async (req, res) => {
    const t = await today(); const day = isDate(req.query.day) ? req.query.day : t;
    const people = (await q(`SELECT id, name, role FROM users WHERE active ORDER BY lower(name)`)).rows.filter((p) => p.role !== 'admin');
    const c = await counts(people.map((p) => p.id), day, day);
    const last = (await q(`SELECT user_id, max(created_at) at FROM fb_entries WHERE day = $1::date GROUP BY 1`, [day])).rows;
    res.json({ day, today: t, targets: db.settings.fbTargets,
      people: people.map((p) => ({ id: p.id, name: p.name, counts: c[p.id], score: score(c[p.id]), lastAt: (last.find((x) => x.user_id === p.id) || {}).at || null })) });
  }));

  // ---------- groups everyone has posted in ----------
  app.get('/api/fb/groups', needUser, wrap(async (req, res) => {
    const rows = (await q(`SELECT lower(group_name) k, max(group_name) name, max(group_link) link, count(*)::int posts, to_char(max(day), 'YYYY-MM-DD') last_day,
        (array_agg(u.name ORDER BY e.created_at DESC))[1] last_by
      FROM fb_entries e JOIN users u ON u.id = e.user_id WHERE e.kind = 'post' AND e.group_name IS NOT NULL GROUP BY 1 ORDER BY max(day) DESC, 2 LIMIT 500`)).rows;
    res.json({ groups: rows.map((g) => ({ name: g.name, link: g.link, posts: g.posts, lastDay: g.last_day, lastBy: g.last_by })) });
  }));

  // ---------- add, change, remove an entry ----------
  async function check(kind, b, userId, exceptId) {
    const link = clean(b.link, 600); const key = link ? linkKey(link) : null;
    const groupName = clean(b.groupName, 150); const groupLink = clean(b.groupLink, 600);
    if (link && !key) return { error: 'That link does not look right. Copy it from the address bar.' };
    if (kind === 'post') {
      if (!groupName) return { error: 'Which group did you post in?' };
      if (!key || !isFb(key)) return { error: 'Paste the link to your post in the group (from Facebook)' };
      if (!b.imageId) return { error: 'Add the picture you posted' };
    }
    if (kind === 'comment') {
      if (!key || !isFb(key)) return { error: 'Paste the link to the post you commented on (from Facebook)' };
      if (!b.imageId) return { error: 'Add a screenshot of your comment' };
    }
    if (kind === 'contact' && (!key || !isFb(key))) return { error: "Paste the link to the driver's Facebook profile" };
    if (kind === 'chat' && !key && !groupName) return { error: 'Give the group chat a name or a link' };
    if (groupLink && !linkKey(groupLink)) return { error: 'The group link does not look right' };
    if (key) {
      // the same post, the same commented ad, the same driver within 60 days, the same chat: once
      const days = kind === 'contact' ? 60 : 3650;
      const dup = (await q(`SELECT e.id, u.name, to_char(e.day, 'Mon DD') d FROM fb_entries e JOIN users u ON u.id = e.user_id
        WHERE e.kind = $1 AND e.link_key = $2 AND e.day > current_date - $3::int AND ($4::int IS NULL OR e.id <> $4::int) ${kind === 'chat' ? 'AND e.user_id = $5' : ''} LIMIT 1`,
      kind === 'chat' ? [kind, key, days, exceptId || null, userId] : [kind, key, days, exceptId || null])).rows[0];
      if (dup) return { error: kind === 'contact' ? `${dup.name} already messaged this driver on ${dup.d}` : `This ${LABEL[kind]} was already recorded by ${dup.name} on ${dup.d}` };
    }
    if (b.imageId) {
      const img = (await q(`SELECT i.user_id, (SELECT count(*)::int FROM fb_entries e WHERE e.image_id = i.id AND ($2::int IS NULL OR e.id <> $2::int)) used FROM fb_images i WHERE i.id = $1`, [+b.imageId || 0, exceptId || null])).rows[0];
      if (!img || img.user_id !== userId) return { error: 'Upload the picture again' };
      if (img.used) return { error: 'That picture is already on another entry' };
    }
    const answers = kind === 'contact' ? { otr: yn(b.otr), cdlA: yn(b.cdlA), phone: clean(b.phone, 30) } : {};
    if (kind === 'contact' && b.outcome && !OUTCOMES.includes(b.outcome)) return { error: 'Unknown outcome' };
    return { row: { link, link_key: key, group_name: groupName, group_link: groupLink, person_name: clean(b.personName, 120), answers: JSON.stringify(answers),
      outcome: kind === 'contact' ? b.outcome || 'messaged' : null, note: clean(b.note, 1000), image_id: b.imageId ? +b.imageId : null } };
  }

  app.post('/api/fb/entries', needUser, wrap(async (req, res) => {
    const b = req.body || {}; const kind = b.kind;
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown kind of entry' });
    const t = await today();
    // a recruiter logs today's work; an admin can add to an earlier day
    const day = req.user.role === 'admin' && isDate(b.day) ? b.day : t;
    const uid = req.user.role === 'admin' && b.userId ? +b.userId : req.user.id;
    const c = await check(kind, b, uid);
    if (c.error) return res.status(400).json({ error: c.error });
    const r = c.row;
    const ins = await q(`INSERT INTO fb_entries (user_id, day, kind, link, link_key, group_name, group_link, person_name, answers, outcome, note, image_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12) RETURNING id`, [uid, day, kind, r.link, r.link_key, r.group_name, r.group_link, r.person_name, r.answers, r.outcome, r.note, r.image_id]);
    await act(req.user, 'facebook', null, `Facebook: ${LABEL[kind]}${r.group_name ? ` in ${r.group_name}` : ''}${r.person_name ? `, ${r.person_name}` : ''}`);
    res.json({ id: ins.rows[0].id });
  }));

  async function loadEntry(req, res) {
    const e = (await q(`SELECT *, to_char(day, 'YYYY-MM-DD') dayt FROM fb_entries WHERE id = $1`, [+req.params.id || 0])).rows[0];
    if (!e || !canSeeUser(req, e.user_id)) { res.status(404).json({ error: 'Entry not found' }); return null; }
    return e;
  }
  app.patch('/api/fb/entries/:id', needUser, wrap(async (req, res) => {
    const e = await loadEntry(req, res); if (!e) return;
    const b = req.body || {}; const admin = req.user.role === 'admin';
    if (b.review !== undefined) { // admin review: OK, or a problem with a note for the recruiter
      if (!admin) return res.status(403).json({ error: 'Only an admin reviews entries' });
      const v = b.review === 'ok' || b.review === 'problem' ? b.review : null;
      if (v === 'problem' && !clean(b.reviewNote)) return res.status(400).json({ error: 'Say what is wrong, so the recruiter can fix it' });
      await q(`UPDATE fb_entries SET review = $2, review_note = $3, reviewed_by = $4, reviewed_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, updated_at = now() WHERE id = $1`,
        [e.id, v, v === 'problem' ? clean(b.reviewNote, 500) : null, v ? req.user.id : null]);
      return res.json({ ok: true });
    }
    // the recruiter puts their entry right (also after a problem was flagged); an OK'd entry stays as it is
    if (!admin && e.user_id !== req.user.id) return res.status(403).json({ error: 'Not your entry' });
    if (!admin && e.review === 'ok') return res.status(400).json({ error: 'This entry was already checked by an admin' });
    const merged = { link: e.link, groupName: e.group_name, groupLink: e.group_link, personName: e.person_name, imageId: e.image_id, outcome: e.outcome, note: e.note, ...(e.answers || {}), ...b };
    const c = await check(e.kind, merged, e.user_id, e.id);
    if (c.error) return res.status(400).json({ error: c.error });
    const r = c.row;
    await q(`UPDATE fb_entries SET link = $2, link_key = $3, group_name = $4, group_link = $5, person_name = $6, answers = $7::jsonb, outcome = $8, note = $9, image_id = $10,
        review = CASE WHEN review = 'problem' THEN NULL ELSE review END, updated_at = now() WHERE id = $1`, // fixed: back in the admin's queue
    [e.id, r.link, r.link_key, r.group_name, r.group_link, r.person_name, r.answers, r.outcome, r.note, r.image_id]);
    res.json({ ok: true });
  }));
  app.delete('/api/fb/entries/:id', needUser, wrap(async (req, res) => {
    const e = await loadEntry(req, res); if (!e) return;
    const admin = req.user.role === 'admin';
    if (!admin && (e.user_id !== req.user.id || e.dayt !== await today() || e.review === 'ok')) return res.status(403).json({ error: 'You can remove your own entries on the same day, before an admin checks them' });
    await q(`DELETE FROM fb_entries WHERE id = $1`, [e.id]);
    if (e.image_id) await q(`DELETE FROM fb_images WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM fb_entries WHERE image_id = $1)`, [e.image_id]);
    res.json({ ok: true });
  }));

  // ---------- a driver messaged on Facebook becomes a lead ----------
  app.post('/api/fb/entries/:id/lead', needUser, wrap(async (req, res) => {
    const e = await loadEntry(req, res); if (!e) return;
    if (e.kind !== 'contact') return res.status(400).json({ error: 'Only a driver you messaged can become a lead' });
    if (e.driver_id) return res.json({ id: e.driver_id, existing: true });
    const name = clean((req.body || {}).name || e.person_name, 120);
    if (!name) return res.status(400).json({ error: "Write the driver's name first" });
    const phone = String((e.answers || {}).phone || (req.body || {}).phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    const phones = phone.length === 10 ? [phone] : [];
    // the same person already in the leads (by phone, or the same Facebook profile)
    const same = (await q(`SELECT id FROM drivers WHERE ($1::text[] <> '{}' AND phones && $1::text[]) OR (source_detail = $2) LIMIT 1`, [phones, e.link])).rows[0];
    let id;
    if (same) id = same.id;
    else {
      const status = e.outcome === 'interested' ? 'Interested' : e.outcome === 'replied' ? 'Replied' : 'Replied';
      const r = await q(`INSERT INTO drivers (name, name_key, phones, source, source_detail, status, status_locked, status_at, owner_id, created_by, assigned_at, lead_at, answers)
        VALUES ($1, $2, $3, 'Facebook', $4, $5, false, now(), $6, $6, now(), now(), $7::jsonb) RETURNING *`,
      [name, db.keyOf(name), phones, e.link, status, e.user_id, JSON.stringify({ ...(e.answers.otr ? { otr: e.answers.otr } : {}), ...(e.answers.cdlA ? { cdl: e.answers.cdlA === 'yes' ? 'Class A CDL' : 'No Class A CDL' } : {}) })]);
      await db.statusChanged(db.pool, { id: r.rows[0].id, status: null }, status, { userId: req.user.id });
      await lib.record(req, 'lead_add', r.rows[0], `Added the lead (Facebook${e.group_name ? ': ' + e.group_name : ''})`);
      if (e.note) await q(`INSERT INTO notes (driver_id, user_id, body) VALUES ($1, $2, $3)`, [r.rows[0].id, req.user.id, `From Facebook: ${e.note}`]);
      id = r.rows[0].id;
    }
    await q(`UPDATE fb_entries SET driver_id = $2, outcome = CASE WHEN outcome = 'messaged' THEN 'replied' ELSE outcome END WHERE id = $1`, [e.id, id]);
    res.json({ id, existing: !!same });
  }));

  // ---------- old pictures are removed after a while (the entries and links stay) ----------
  const tidy = () => q(`DELETE FROM fb_images i WHERE created_at < now() - interval '${KEEP_IMAGES_DAYS} days'
    OR (created_at < now() - interval '1 day' AND NOT EXISTS (SELECT 1 FROM fb_entries e WHERE e.image_id = i.id))`).catch(() => {}); // also pictures uploaded but never saved
  setInterval(tidy, 6 * 3600000); setTimeout(tidy, 60000);
};
module.exports.counts = counts;
module.exports.score = score;
module.exports.linkKey = linkKey;
