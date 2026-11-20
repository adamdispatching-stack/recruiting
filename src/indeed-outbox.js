// Indeed messages the website asks the Chrome extension to send.
// When someone logs a call with no answer (or a voicemail) on a lead that has an Indeed chat, a short message
// is queued: "I just tried to call you…". A Chrome profile that has that chat, with Indeed Messages open and
// auto-reply on, takes it, sends it in the chat, and reports back. One per driver every 12 hours at most.
const db = require('./db');
const lib = require('./lib');
const { q } = db;
const { wrap, needUser, needKey } = lib;

const AFTER = ['No answer', 'Left voicemail'];
const STALE_MIN = 20;   // taken but not reported back: offered again
const GIVE_UP_H = 24;   // nobody could send it: failed
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
const cidOf = (u) => { try { const c = new URL(u).searchParams.get('conversationId'); return c && c.length > 12 && !/\s/.test(c) ? c : null; } catch (e) { return null; } };
const textFor = (d, user) => String(db.settings.noAnswer.text || '').replace(/\{first\}/g, first(d.name)).replace(/\{me\}/g, first(user && user.name)).trim();

// After a call is logged. Returns { queued: true } or { skip: 'why not' }.
async function afterCall(d, user, outcome, noteId) {
  if (!AFTER.includes(outcome)) return { skip: 'not a missed call', why: 'notmissed' };
  const set = db.settings.noAnswer || {};
  if (!set.on || !String(set.text || '').trim()) return { skip: 'Indeed messages after missed calls are turned off in Settings', why: 'off' };
  if (!cidOf(d.conversation_url)) return { skip: 'this lead has no Indeed chat', why: 'nochat' };
  if (db.LOST.includes(d.status)) return { skip: `this lead is “${d.status}”`, why: 'lost' };
  const recent = (await q(`SELECT 1 FROM indeed_outbox WHERE driver_id = $1 AND status <> 'failed' AND created_at > now() - interval '12 hours'`, [d.id])).rows[0];
  if (recent) return { skip: 'an Indeed message already went out after a missed call in the last 12 hours', why: 'recent' };
  const r = await q(`INSERT INTO indeed_outbox (driver_id, note_id, created_by, text) VALUES ($1, $2, $3, $4) RETURNING id`, [d.id, noteId || null, user.id, textFor(d, user)]);
  return { queued: true, id: r.rows[0].id };
}

// The messages of one lead, for its page
async function ofDriver(driverId) {
  return (await q(`SELECT id, note_id, text, status, error, created_at, done_at FROM indeed_outbox WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 20`, [driverId])).rows
    .map((m) => ({ id: m.id, noteId: m.note_id, text: m.text, status: m.status, error: m.error, createdAt: m.created_at, doneAt: m.done_at }));
}

async function fail(id, error) {
  const m = (await q(`UPDATE indeed_outbox o SET status = 'failed', error = $2, done_at = now() FROM drivers d WHERE o.id = $1 AND d.id = o.driver_id AND o.status IN ('pending', 'sending')
    RETURNING o.created_by, d.id driver_id, d.name`, [id, String(error || 'Not sent').slice(0, 300)])).rows[0];
  if (m && m.created_by) await db.notify(db.pool, m.created_by, 'lead_update', `Indeed message to ${m.name} after your call was not sent: ${String(error || '').slice(0, 200)}`, `#/driver/${m.driver_id}`, { driverId: m.driver_id });
  return m;
}

module.exports = (app) => {
  // ---------- for the Chrome extension ----------
  // Messages waiting to go out. Taken ones not reported back in time are offered again; very old ones fail.
  app.get('/api/ext/outbox', needKey, wrap(async (req, res) => {
    await q(`UPDATE indeed_outbox SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE status = 'sending' AND claimed_at < now() - interval '${STALE_MIN} minutes'`);
    const old = (await q(`SELECT id FROM indeed_outbox WHERE status = 'pending' AND created_at < now() - interval '${GIVE_UP_H} hours'`)).rows;
    for (const o of old) await fail(o.id, 'No Chrome profile with this Indeed chat had Messages open (with auto-reply on) within a day');
    const r = await q(`SELECT o.id, o.text, d.name, d.phones, d.emails, d.account, d.conversation_url FROM indeed_outbox o JOIN drivers d ON d.id = o.driver_id
      WHERE o.status = 'pending' ORDER BY o.created_at LIMIT 20`);
    res.json({ items: r.rows.map((m) => ({ id: m.id, text: m.text, name: m.name, phones: m.phones || [], emails: m.emails || [], account: m.account, conversationUrl: m.conversation_url })) });
  }));
  // One Chrome profile takes a message, so two never send it
  app.post('/api/ext/outbox/:id/claim', needKey, wrap(async (req, res) => {
    const r = await q(`UPDATE indeed_outbox SET status = 'sending', claimed_by = $2, claimed_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`, [+req.params.id || 0, req.key.name]);
    if (!r.rows[0]) return res.status(409).json({ error: 'Already taken' });
    res.json({ ok: true });
  }));
  // Sent, or not (with the reason). Not sent puts it back for another profile only when asked (retry).
  app.post('/api/ext/outbox/:id/done', needKey, wrap(async (req, res) => {
    const id = +req.params.id || 0; const b = req.body || {};
    if (b.retry) { await q(`UPDATE indeed_outbox SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE id = $1 AND status = 'sending'`, [id]); return res.json({ ok: true }); }
    if (!b.ok) { await fail(id, b.error || 'Not sent'); return res.json({ ok: true }); }
    const m = (await q(`UPDATE indeed_outbox SET status = 'sent', done_at = now(), error = NULL WHERE id = $1 AND status IN ('sending', 'pending') RETURNING driver_id, text, created_by`, [id])).rows[0];
    if (m) {
      const who = m.created_by ? (await q(`SELECT name FROM users WHERE id = $1`, [m.created_by])).rows[0] : null;
      await q(`INSERT INTO driver_events (driver_id, t, type, text, who, fp) VALUES ($1, now(), 'manual', $2, $3, $4)`, [m.driver_id, `Indeed message after a missed call: ${m.text.slice(0, 300)}`, who ? who.name : 'website', 'outbox:' + id]).catch((e) => console.error('outbox event', e.message));
      await q(`UPDATE drivers SET last_contact_at = now(), updated_at = now() WHERE id = $1`, [m.driver_id]);
    }
    res.json({ ok: true });
  }));

  // ---------- on the website ----------
  // Send again (a failed one), or stop one still waiting
  app.post('/api/indeed-outbox/:id', needUser, wrap(async (req, res) => {
    const m = (await q(`SELECT o.*, d.id did FROM indeed_outbox o JOIN drivers d ON d.id = o.driver_id WHERE o.id = $1`, [+req.params.id || 0])).rows[0];
    if (!m) return res.status(404).json({ error: 'Message not found' });
    const d = await lib.loadDriver(req, res, m.did); if (!d) return;
    const act = (req.body || {}).action;
    if (act === 'retry' && m.status === 'failed') await q(`UPDATE indeed_outbox SET status = 'pending', error = NULL, done_at = NULL, claimed_by = NULL, claimed_at = NULL, created_at = now() WHERE id = $1`, [m.id]);
    else if (act === 'cancel' && m.status === 'pending') await q(`UPDATE indeed_outbox SET status = 'failed', error = 'Stopped on the website', done_at = now() WHERE id = $1`, [m.id]);
    else return res.status(400).json({ error: m.status === 'sending' ? 'It is being sent right now' : 'Nothing to do for this message' });
    res.json({ ok: true });
  }));
};
module.exports.afterCall = afterCall;
module.exports.ofDriver = ofDriver;
module.exports.textFor = textFor;
