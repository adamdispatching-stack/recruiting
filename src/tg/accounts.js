// A dispatcher the bot learned from the driver groups gets a website account by himself:
// - if a team member with the same name exists (dispatcher or admin, not linked to another Telegram yet), the two are linked
// - otherwise a dispatcher account is made. It has no email or password yet, so nobody can sign in with it;
//   an admin gives it an email and a password on the Team page (or removes its access if the bot was wrong)
// The admins are told once for each. Turn it off with Settings → Telegram (tg.autoAccounts = false).
const db = require('../db');
const { q } = db;
const NOLOGIN = '@no-login.fleethire';
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-zЀ-ӿ ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);

async function ensure(tgId) {
  if ((db.settings.tg || {}).autoAccounts === false) return null;
  const p = (await q(`SELECT * FROM tg_people WHERE tg_id = $1`, [tgId])).rows[0];
  if (!p || p.role !== 'dispatch' || p.user_id || !String(p.name || '').trim()) return null;
  const bot = require('./bot');
  // a team member with the same name
  const w = words(p.name);
  const team = (await q(`SELECT u.id, u.name FROM users u WHERE u.active AND u.role IN ('dispatcher', 'admin') AND NOT EXISTS (SELECT 1 FROM tg_people t WHERE t.user_id = u.id)`)).rows;
  const same = team.filter((u) => { const uw = words(u.name); return w.length && uw.length && (w.every((x) => uw.includes(x)) || (uw.length >= 2 && uw.every((x) => w.includes(x)))); });
  let id, made = false;
  if (same.length === 1) id = same[0].id;
  else {
    id = (await q(`INSERT INTO users (email, name, pass_hash, role, from_tg) VALUES ($1, $2, $3, 'dispatcher', $4) ON CONFLICT (email) DO UPDATE SET name = users.name RETURNING id`,
      [`tg${tgId}${NOLOGIN}`, String(p.name).trim().slice(0, 80), db.hashPassword(db.token('x_') + db.token('y_')), tgId])).rows[0].id;
    made = true;
  }
  const r = await q(`UPDATE tg_people SET user_id = $2 WHERE tg_id = $1 AND user_id IS NULL RETURNING tg_id`, [tgId, id]);
  if (!r.rows[0]) return null;
  const text = made ? `${p.name} writes as a dispatcher in the driver groups, so the bot made him a dispatcher account. He cannot sign in yet: give him an email and a password (or remove the account if he is not a dispatcher).`
    : `${p.name} writes as a dispatcher in the driver groups: linked to his account.`;
  await bot.log('fact', made ? `Made a dispatcher account for ${p.name}` : `Linked ${p.name}'s Telegram to his account`, {});
  for (const a of (await q(`SELECT id FROM users WHERE active AND role = 'admin'`)).rows) await db.notify(db.pool, a.id, 'tg', text, '#/team/' + id);
  return { id, made };
}
// the ones learned before this existed
async function tick() {
  const due = (await q(`SELECT tg_id FROM tg_people WHERE role = 'dispatch' AND user_id IS NULL LIMIT 20`)).rows;
  for (const d of due) await ensure(d.tg_id).catch((e) => console.error('tg account', e.message));
}
const noLogin = (email) => String(email || '').endsWith(NOLOGIN);
module.exports = { ensure, tick, noLogin, NOLOGIN };
