// Admin tools (people, access keys, settings, import and export) and the API the Chrome extension syncs with.
const db = require('./db');
const share = require('./share');
const hours = require('./api-hours');
const lib = require('./lib');
const { q, sha, token, hashPassword } = db;
const { wrap, needUser, needAdmin, needKey, act, validTz } = lib;

// A changed checklist template also updates drivers who are being onboarded right now:
// new steps are added, renamed steps are renamed, and removed steps disappear unless already ticked.
async function applyTemplate(list) {
  const rows = await q(`SELECT d.id FROM drivers d JOIN onboarding o ON o.driver_id = d.id WHERE d.status = 'Onboarding'`);
  for (const { id } of rows.rows) {
    let i = 0;
    for (const it of list) await q(`INSERT INTO checklist (driver_id, key, label, position, auto) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (driver_id, key) DO UPDATE SET label = EXCLUDED.label, position = EXCLUDED.position`, [id, it.key, it.label, i++, it.auto || null]);
    await q(`DELETE FROM checklist WHERE driver_id = $1 AND NOT done AND key NOT LIKE 'custom\\_%' AND key <> ALL($2::text[])`, [id, list.map((x) => x.key)]);
    await db.syncAuto(db.pool, id, null);
  }
}

const ROLE = (r) => (['admin', 'dispatcher'].includes(r) ? r : 'member');
const ROLE_NAME = { admin: 'admin', member: 'recruiter', dispatcher: 'dispatcher' };
module.exports = (app) => {
  // ---------- people ----------
  app.get('/api/users', needUser, needAdmin, wrap(async (req, res) => res.json((await q(`SELECT id, email, name, role, active, created_at FROM users ORDER BY id`)).rows)));
  app.post('/api/users', needUser, needAdmin, wrap(async (req, res) => {
    const { email, name, password, role } = req.body || {};
    if (!/^\S+@\S+\.\S+$/.test(String(email || '').trim()) || !String(name || '').trim()) return res.status(400).json({ error: 'Name and email are required' });
    if (String(password || '').length < 10) return res.status(400).json({ error: 'Password needs at least 10 characters' });
    let id;
    try { id = (await q(`INSERT INTO users (email, name, pass_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`, [String(email).trim().toLowerCase(), String(name).trim().slice(0, 80), hashPassword(password), ROLE(role)])).rows[0].id; }
    catch (e) { if (e.code === '23505') return res.status(400).json({ error: 'Someone already uses that email' }); throw e; }
    await act(req.user, 'admin', null, `Created an account for ${String(name).trim()} (${ROLE_NAME[ROLE(role)]})`);
    res.json({ ok: true, id });
  }));
  app.patch('/api/users/:id', needUser, needAdmin, wrap(async (req, res) => {
    const id = +req.params.id; const b = req.body || {};
    const target = (await q(`SELECT * FROM users WHERE id = $1`, [id])).rows[0];
    if (!target) return res.status(404).json({ error: 'Person not found' });
    if (id === req.user.id && (b.active === false || (b.role && b.role !== 'admin'))) return res.status(400).json({ error: "You can't remove your own admin access" });
    if (b.password !== undefined) {
      if (String(b.password).length < 10) return res.status(400).json({ error: 'Password needs at least 10 characters' });
      await q(`UPDATE users SET pass_hash = $2 WHERE id = $1`, [id, hashPassword(b.password)]); await q(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      await act(req.user, 'admin', null, `Set a new password for ${target.name}`);
    }
    if (b.active !== undefined && !!b.active !== target.active) {
      await q(`UPDATE users SET active = $2 WHERE id = $1`, [id, !!b.active]); if (!b.active) await q(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      await lib.loadGone();
      await act(req.user, 'admin', null, b.active ? `Gave ${target.name} access again` : `Removed ${target.name}'s access`);
    }
    if (b.role && ROLE(b.role) !== target.role) { await q(`UPDATE users SET role = $2 WHERE id = $1`, [id, ROLE(b.role)]); await act(req.user, 'admin', null, `Made ${target.name} ${{ admin: 'an admin', member: 'a recruiter', dispatcher: 'a dispatcher' }[ROLE(b.role)]}`); }
    if (b.email !== undefined && String(b.email).trim().toLowerCase() !== target.email) {
      const em = String(b.email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) || em.endsWith(require('./tg/accounts').NOLOGIN)) return res.status(400).json({ error: 'Enter a real email address' });
      if ((await q(`SELECT 1 FROM users WHERE email = $1 AND id <> $2`, [em, id])).rows[0]) return res.status(400).json({ error: 'Someone already uses this email' });
      await q(`UPDATE users SET email = $2 WHERE id = $1`, [id, em]); await act(req.user, 'admin', null, `Set ${target.name}'s email to ${em}`);
    }
    if (b.name !== undefined && String(b.name).trim()) await q(`UPDATE users SET name = $2 WHERE id = $1`, [id, String(b.name).trim().slice(0, 80)]);
    res.json({ ok: true });
  }));

  // ---------- access keys for the Chrome extension (one per Chrome profile) ----------
  app.get('/api/keys', needUser, needAdmin, wrap(async (req, res) => res.json((await q(`SELECT k.id, k.name, k.created_at, k.last_used_at, k.assign_to, u.name owner, a.name assign_name FROM api_keys k LEFT JOIN users u ON u.id = k.user_id LEFT JOIN users a ON a.id = k.assign_to ORDER BY k.id`)).rows)));
  app.post('/api/keys', needUser, needAdmin, wrap(async (req, res) => {
    const name = String((req.body || {}).name || '').trim().slice(0, 60); if (!name) return res.status(400).json({ error: 'Give the key a name, like the Chrome profile or Indeed account' });
    const assignTo = (req.body || {}).assignTo ? +req.body.assignTo : null;
    const key = token('rk_');
    await q(`INSERT INTO api_keys (name, key_hash, user_id, assign_to) VALUES ($1, $2, $3, $4)`, [name, sha(key), req.user.id, assignTo]);
    await act(req.user, 'admin', null, `Created the access key "${name}"`);
    res.json({ key }); // shown once
  }));
  app.patch('/api/keys/:id', needUser, needAdmin, wrap(async (req, res) => {
    await q(`UPDATE api_keys SET assign_to = $2 WHERE id = $1`, [+req.params.id, (req.body || {}).assignTo ? +req.body.assignTo : null]); res.json({ ok: true });
  }));
  app.delete('/api/keys/:id', needUser, needAdmin, wrap(async (req, res) => {
    const k = (await q(`DELETE FROM api_keys WHERE id = $1 RETURNING name`, [+req.params.id])).rows[0];
    if (k) await act(req.user, 'admin', null, `Revoked the access key "${k.name}"`);
    res.json({ ok: true });
  }));

  // ---------- settings ----------
  app.get('/api/settings', needUser, needAdmin, (req, res) => res.json({ tz: db.settings.tz, visibility: db.settings.visibility, sources: db.settings.sources, checklist: db.settings.checklist, hours: db.settings.hours, callPoints: db.settings.callPoints, share: db.settings.share, fbTargets: db.settings.fbTargets, noAnswer: db.settings.noAnswer, tg: db.settings.tg }));
  app.put('/api/settings', needUser, needAdmin, wrap(async (req, res) => {
    const b = req.body || {}; const changed = [];
    if (b.tz !== undefined) { if (!validTz(b.tz)) return res.status(400).json({ error: 'That time zone is not known. Use a name like America/New_York.' }); if (b.tz !== db.settings.tz) { await db.saveSetting('tz', b.tz); changed.push('time zone'); } }
    if (b.visibility !== undefined) { const v = b.visibility === 'own' ? 'own' : 'all'; if (v !== db.settings.visibility) { await db.saveSetting('visibility', v); changed.push('who sees which leads'); } }
    if (b.sources !== undefined) {
      const list = [...new Set((Array.isArray(b.sources) ? b.sources : []).map((x) => String(x).trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
      if (!list.includes('Indeed')) list.unshift('Indeed'); // leads from the extension are filed under Indeed
      if (JSON.stringify(list) !== JSON.stringify(db.settings.sources)) { await db.saveSetting('sources', list); changed.push('lead sources'); }
    }
    if (b.checklist !== undefined) {
      const builtIn = Object.fromEntries(db.DEFAULTS.checklist.map((x) => [x.key, x])); const seen = new Set();
      const list = (Array.isArray(b.checklist) ? b.checklist : []).map((x) => {
        const label = String((x && x.label) || '').trim().slice(0, 80); if (!label) return null;
        let key = String((x && x.key) || '').trim(); if (!/^[a-z0-9_]{1,40}$/.test(key) || key.startsWith('custom_') || seen.has(key)) key = 'c_' + token().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'x');
        seen.add(key);
        return { key, label, ...(builtIn[key] && builtIn[key].auto ? { auto: builtIn[key].auto } : {}) };
      }).filter(Boolean).slice(0, 40);
      if (!list.length) return res.status(400).json({ error: 'The checklist needs at least one step' });
      if (JSON.stringify(list) !== JSON.stringify(db.settings.checklist)) { await db.saveSetting('checklist', list); await applyTemplate(list); changed.push('onboarding checklist'); }
    }
    if (b.fbTargets !== undefined) {
      const t = b.fbTargets || {}; const v = {};
      for (const k of ['picture', 'post', 'comment', 'contact', 'chat', 'ppost', 'pcomment']) { const n = Math.round(+(t[k] ?? db.settings.fbTargets[k] ?? 0)); if (!(n >= 0 && n <= 200)) return res.status(400).json({ error: 'Daily targets: a number from 0 to 200' }); v[k] = n; }
      if (JSON.stringify(v) !== JSON.stringify(db.settings.fbTargets)) { await db.saveSetting('fbTargets', v); changed.push(`Facebook daily targets (${v.picture} ad pictures, ${v.post} posts, ${v.comment} comments, ${v.contact} drivers messaged, ${v.chat} group chats, ${v.ppost} personal posts, ${v.pcomment} other comments)`); }
    }
    if (b.tg !== undefined) {
      const t = b.tg || {}; const cur = db.settings.tg; const hm = (x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
      const times = t.eldTimes === undefined ? cur.eldTimes : [...new Set((Array.isArray(t.eldTimes) ? t.eldTimes : String(t.eldTimes).split(/[ ,;]+/)).map((x) => String(x).trim()).filter(Boolean).map((x) => (/^\d:\d\d$/.test(x) ? '0' + x : x)))].sort();
      if (times.some((x) => !hm(x))) return res.status(400).json({ error: 'Write the check times like 11:00, 18:00' });
      if (times.length > 6) return res.status(400).json({ error: 'At most 6 checks a day' });
      const num = (v, def, lo, hi) => (v === undefined ? def : Math.round(+v));
      const v = { ...cur, eldTimes: times, eldDays: num(t.eldDays, cur.eldDays), remindMin: num(t.remindMin, cur.remindMin), summaryAt: t.summaryAt === undefined ? cur.summaryAt : String(t.summaryAt).trim(),
        eldTeam: t.eldTeam === undefined ? cur.eldTeam : [...new Set((Array.isArray(t.eldTeam) ? t.eldTeam : String(t.eldTeam).split(/[ ,;]+/)).map((x) => String(x).trim().replace(/^@?/, '@')).filter((x) => /^@[A-Za-z0-9_]{4,32}$/.test(x)))] };
      if (!(v.eldDays >= 0 && v.eldDays <= 365)) return res.status(400).json({ error: 'Days of checks: 0 to 365 (0 means always)' });
      if (!(v.remindMin >= 15 && v.remindMin <= 720)) return res.status(400).json({ error: 'Remind after 15 to 720 minutes' });
      if (!hm(v.summaryAt)) return res.status(400).json({ error: 'Write the summary time like 21:00' });
      if (JSON.stringify(v) !== JSON.stringify(cur)) { await db.saveSetting('tg', v); changed.push('Telegram bot settings'); }
    }
    if (b.noAnswer !== undefined) {
      const n = b.noAnswer || {}; const text = String(n.text || '').trim().slice(0, 600);
      if (n.on !== false && !text) return res.status(400).json({ error: 'Write the message, or turn it off' });
      const v = { on: n.on !== false, text: text || db.settings.noAnswer.text };
      if (JSON.stringify(v) !== JSON.stringify(db.settings.noAnswer)) { await db.saveSetting('noAnswer', v); changed.push(v.on ? 'Indeed message after a missed call' : 'no Indeed message after a missed call'); }
    }
    if (b.share !== undefined) {
      const sh = b.share || {}; const ids = Array.isArray(sh.people) ? [...new Set(sh.people.map((x) => +x).filter(Boolean))] : null;
      const mv = Math.round(+sh.moveAfter); const v = { on: sh.on !== false, people: ids, onlyOnline: sh.onlyOnline !== false, moveAfter: sh.moveAfter === undefined ? share.cfg().moveAfter : mv >= 0 && mv <= 1440 ? mv : 60 };
      if (JSON.stringify(v) !== JSON.stringify(db.settings.share)) { await db.saveSetting('share', v); changed.push(v.on ? 'leads shared evenly' : 'leads not shared automatically'); }
    }
    if (b.callPoints !== undefined) {
      const clean = (a) => (Array.isArray(a) ? a : []).map((x) => String(x || '').trim().slice(0, 400)).filter(Boolean).slice(0, 15);
      const v = { company: clean((b.callPoints || {}).company), owner: clean((b.callPoints || {}).owner) };
      if (JSON.stringify(v) !== JSON.stringify(db.settings.callPoints)) { await db.saveSetting('callPoints', v); changed.push('call guide talking points'); }
    }
    if (b.hours !== undefined) {
      const h = b.hours || {}; let week;
      try { week = hours.cleanWeek(h.week); } catch (e) { return res.status(400).json({ error: e.message }); }
      const minMinutes = Math.round(+h.minMinutes), grace = Math.round(+h.grace);
      if (!(minMinutes >= 1 && minMinutes <= 600)) return res.status(400).json({ error: 'Minimum active time for a worked day: 1 to 600 minutes' });
      if (!(grace >= 0 && grace <= 180)) return res.status(400).json({ error: 'Late after: 0 to 180 minutes' });
      const idleMinutes = h.idleMinutes === undefined ? db.settings.hours.idleMinutes : Math.round(+h.idleMinutes), idleAlert = h.idleAlert === undefined ? db.settings.hours.idleAlert : Math.round(+h.idleAlert);
      if (!(idleMinutes >= 5 && idleMinutes <= 120)) return res.status(400).json({ error: 'Idle after: 5 to 120 minutes' });
      if (!(idleAlert >= idleMinutes && idleAlert <= 480)) return res.status(400).json({ error: `Idle alert after: ${idleMinutes} to 480 minutes` });
      const v = { week, minMinutes, grace, idleMinutes, idleAlert };
      if (JSON.stringify(v) !== JSON.stringify(db.settings.hours)) { await db.saveSetting('hours', v); changed.push(`working hours (${hours.weekText(week)})`); }
    }
    if (changed.length) await act(req.user, 'admin', null, `Changed settings: ${changed.join(', ')}`);
    res.json({ ok: true, tz: db.settings.tz, visibility: db.settings.visibility, sources: db.settings.sources, checklist: db.settings.checklist, hours: db.settings.hours, callPoints: db.settings.callPoints, share: db.settings.share, fbTargets: db.settings.fbTargets, noAnswer: db.settings.noAnswer, tg: db.settings.tg });
  }));

  // ---------- export and import ----------
  app.get('/api/export.csv', needUser, needAdmin, wrap(async (req, res) => {
    const r = await q(`SELECT d.*, u.name recruiter, (SELECT string_agg(${lib.NOTE_TEXT}, ' | ' ORDER BY n.created_at) FROM notes n WHERE n.driver_id = d.id) all_notes
      FROM drivers d LEFT JOIN users u ON u.id = d.owner_id ORDER BY d.updated_at DESC`);
    const cols = ['name', 'status', 'recruiter', 'phones', 'emails', 'location', 'zip', 'source', 'source_detail', 'account', 'mode', 'job', 'follow_up', 'tags', 'all_notes', 'red_flags', 'ai_summary', 'answers', 'relay_before', 'amazon_step', 'lost_reason', 'lost_note', 'last_contact_at', 'updated_at', 'conversation_url'];
    const cell = (v) => {
      let t = String(Array.isArray(v) ? v.join('; ') : v && typeof v === 'object' && !(v instanceof Date) ? Object.entries(v).map(([k, x]) => `${k}: ${x}`).join('; ') : v instanceof Date ? v.toISOString() : v ?? '');
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // a spreadsheet must never run a cell as a formula
      return `"${t.replace(/"/g, '""')}"`;
    };
    await act(req.user, 'export', null, `Exported the driver list (${r.rows.length} drivers)`);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="drivers-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send('﻿' + [cols.join(','), ...r.rows.map((d) => cols.map((c) => cell(d[c])).join(','))].join('\r\n'));
  }));
  app.post('/api/import', needUser, needAdmin, wrap(async (req, res) => {
    const drivers = Object.values(((req.body || {}).drivers) || {});
    if (!drivers.length) return res.status(400).json({ error: 'No drivers in this file. Use "Download a backup" on the extension\'s database page.' });
    const label = String((req.body || {}).label || 'import').slice(0, 60);
    const c = await db.pool.connect(); let n = 0;
    try { await c.query('BEGIN'); for (const d of drivers) { if (await db.mergeFromExtension(c, d, label)) n++; } await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await act(req.user, 'admin', null, `Imported a backup (${n} drivers)`);
    res.json({ ok: true, merged: n });
  }));

  // ---------- the Chrome extension ----------
  app.get('/api/ext/ping', needKey, (req, res) => res.json({ ok: true, name: req.key.name }));
  // the extension's own AI use (its key), as daily totals per model and purpose
  app.post('/api/ext/ai-usage', needKey, wrap(async (req, res) => {
    await require('./ai-usage').addExtension((req.body || {}).rows, req.key.name); // which Chrome profile (the access key's name)
    res.json({ ok: true });
  }));
  app.post('/api/ext/push', needKey, wrap(async (req, res) => {
    const items = Array.isArray((req.body || {}).drivers) ? req.body.drivers.slice(0, 500) : [];
    // One record that cannot be saved must never hold back the others: each one gets its own savepoint.
    const c = await db.pool.connect(); let n = 0; const failed = [];
    try {
      await c.query('BEGIN');
      for (const d of items) {
        await c.query('SAVEPOINT one');
        try { if (await db.mergeFromExtension(c, d, req.key.name, { assignTo: req.key.assign_to, pick: db.settings.share.on ? () => share.pick(c) : null })) n++; await c.query('RELEASE SAVEPOINT one'); }
        catch (e) { await c.query('ROLLBACK TO SAVEPOINT one'); failed.push({ id: d && d.id, name: d && String(d.name || '').slice(0, 80), error: e.message.slice(0, 160) }); console.error('ext push: could not save', d && d.name, e.message); }
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    res.json({ ok: true, merged: n, failed });
  }));
  // What changed on the website since the last pull: team notes, status set by hand, follow-ups, tags.
  app.get('/api/ext/pull', needKey, wrap(async (req, res) => {
    const since = new Date(String(req.query.since || 0)); const sinceIso = isNaN(since) ? new Date(0).toISOString() : since.toISOString();
    // with "recruiters see only their own leads" on, a profile set up for one recruiter gets that recruiter's leads only
    const own = db.settings.visibility === 'own' && req.key.assign_to ? req.key.assign_to : null;
    const r = await q(`SELECT d.*, (SELECT string_agg(coalesce(u.name, 'Chrome ' || substr(n.source, 5)) || ', ' || to_char(n.created_at, 'Mon DD') || ': ' ||
          ${lib.NOTE_TEXT}, E'\\n' ORDER BY n.created_at DESC)
        FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.driver_id = d.id AND coalesce(n.source, '') <> $2) team_notes
      FROM drivers d WHERE (d.web_updated_at > $1 OR EXISTS (SELECT 1 FROM tg_chats c WHERE c.driver_id = d.id AND c.linked_at > $1) OR EXISTS (SELECT 1 FROM onb_cases o WHERE o.driver_id = d.id AND o.ai_status_at > $1))
        AND ($3::int IS NULL OR d.owner_id = $3::int OR ${lib.unownedSql()}) ORDER BY d.web_updated_at LIMIT 1000`, [sinceIso, 'ext:' + req.key.name, own]);
    const tg = await require('./cross').fromTelegram(r.rows.map((d) => d.id)); // what Telegram knows, for the Indeed auto-reply
    // Drivers who are in more than one Indeed account, by name: for sure (one lead that came in through several accounts,
    // same phone, email or chat) or maybe (the same name in several accounts). The whole short list goes out with every
    // pull, so each Chrome profile can mark them on Indeed.
    const shared = {};
    const maybe = await q(`SELECT name_key, array_agg(DISTINCT account) accounts FROM drivers WHERE account IS NOT NULL AND name_key <> '' GROUP BY name_key HAVING count(DISTINCT account) > 1 LIMIT 3000`).catch(() => ({ rows: [] }));
    for (const x of maybe.rows) shared[x.name_key] = { accounts: x.accounts, sure: false };
    const sure = await q(`SELECT name_key, accounts FROM drivers WHERE cardinality(accounts) > 1 AND name_key <> '' LIMIT 3000`).catch(() => ({ rows: [] }));
    for (const x of sure.rows) shared[x.name_key] = { accounts: [...new Set([...x.accounts, ...((shared[x.name_key] || {}).accounts || [])])], sure: true };
    res.json({ now: new Date().toISOString(), shared, drivers: r.rows.map((d) => ({ name: d.name, phones: d.phones, emails: d.emails, account: d.account, status: d.status, statusLocked: d.status_locked, followUp: d.follow_up || null, tags: d.tags, teamNotes: d.team_notes || '', url: `/#/driver/${d.id}`, telegram: tg[d.id] || null })) });
  }));
  // ---------- backups, data, errors (admins) ----------
  app.get('/api/admin/backup', needUser, needAdmin, wrap(async (req, res) => {
    const b = await require('./backup').make({ files: req.query.files === '1' });
    await act(req.user, 'admin', null, `Downloaded a backup (${b.rows} rows${req.query.files === '1' ? ', with files' : ''})`);
    res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${b.name}"`, 'Cache-Control': 'no-store' }).send(b.buffer);
  }));
  app.get('/api/admin/safety', needUser, needAdmin, wrap(async (req, res) => {
    const size = (await q(`SELECT pg_database_size(current_database())::bigint b, (SELECT count(*)::int FROM tg_messages) msgs, (SELECT min(at) FROM tg_messages) oldest`)).rows[0];
    res.json({ backup: require('./backup').cfg(), data: { keepMessagesDays: 0, ...(db.settings.data || {}) }, runner: require('./guard').isLeader(), botOn: require('./tg/bot').on(),
      size: { bytes: +size.b, messages: size.msgs, oldest: size.oldest },
      errors: (await q(`SELECT id, at, kind, place, message FROM server_errors ORDER BY id DESC LIMIT 30`)).rows });
  }));
  app.put('/api/admin/safety', needUser, needAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.backup) { const h = Math.round(+b.backup.hour); if (!(h >= 0 && h <= 23)) return res.status(400).json({ error: 'The hour is 0 to 23' });
      await db.saveSetting('backup', { ...require('./backup').cfg(), tg: !!b.backup.tg, hour: h }); }
    if (b.data) { const d = Math.round(+b.data.keepMessagesDays || 0); if (d !== 0 && !(d >= 30 && d <= 3650)) return res.status(400).json({ error: 'Keep messages at least 30 days, or 0 to keep them forever' });
      await db.saveSetting('data', { keepMessagesDays: d }); }
    await act(req.user, 'admin', null, 'Changed the backup and data settings');
    res.json({ ok: true });
  }));
  app.post('/api/admin/backup/send', needUser, needAdmin, wrap(async (req, res) => {
    if (!require('./tg/bot').on()) return res.status(400).json({ error: 'The Telegram bot is off' });
    res.json(await require('./backup').sendNow());
  }));
};
