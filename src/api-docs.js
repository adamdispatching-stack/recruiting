// Papers the team uploads: the driver's CDL and medical card (on the lead), each truck's registration and other
// paperwork (on the truck). Stored in the database, shown only to the team, and shared in the driver's ELD group
// only when someone types /info there. Dispatchers handle truck papers only.
const db = require('./db');
const { q } = db;
const { wrap, needUser, loadDriver, history } = require('./lib');

const DRIVER_KINDS = ['cdl', 'medical', 'other'], TRUCK_KINDS = ['registration', 'insurance', 'lease', 'other'];
const MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
const MAX = 15 * 1024 * 1024;
const out = (d) => ({ id: d.id, kind: d.kind, name: d.name, mime: d.mime, size: d.size, at: d.created_at, by: d.by_name || null });

module.exports = (app) => {
  // the list for a driver or a truck (no file contents)
  app.get('/api/docs', needUser, wrap(async (req, res) => {
    const did = +req.query.driverId || 0, tid = +req.query.truckId || 0;
    if (did) { if (req.user.role === 'dispatcher') return res.status(403).json({ error: 'Dispatchers handle truck papers only' }); const d = await loadDriver(req, res, did); if (!d) return; }
    const r = await q(`SELECT x.id, x.kind, x.name, x.mime, x.size, x.created_at, u.name by_name FROM docs x LEFT JOIN users u ON u.id = x.uploaded_by WHERE ${did ? 'x.driver_id = $1' : 'x.truck_id = $1'} ORDER BY x.created_at DESC`, [did || tid]);
    res.json({ docs: r.rows.map(out) });
  }));
  // upload: { driverId | truckId, kind, name, mime, data (base64) }
  app.post('/api/docs', needUser, wrap(async (req, res) => {
    const b = req.body || {}; const did = +b.driverId || 0, tid = +b.truckId || 0;
    if (!did === !tid) return res.status(400).json({ error: 'A driver or a truck' });
    if (!MIME.test(String(b.mime || ''))) return res.status(400).json({ error: 'A photo (JPG, PNG, HEIC) or a PDF' });
    const buf = Buffer.from(String(b.data || ''), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'The file is empty' });
    if (buf.length > MAX) return res.status(400).json({ error: 'Up to 15 MB' });
    let kind = String(b.kind || 'other');
    if (did) {
      if (req.user.role === 'dispatcher') return res.status(403).json({ error: 'Dispatchers handle truck papers only' });
      const d = await loadDriver(req, res, did); if (!d) return;
      if (!DRIVER_KINDS.includes(kind)) kind = 'other';
    } else {
      if (!(await q(`SELECT 1 FROM trucks WHERE id = $1`, [tid])).rows[0]) return res.status(404).json({ error: 'Truck not found' });
      if (!TRUCK_KINDS.includes(kind)) kind = 'other';
    }
    const name = String(b.name || 'file').replace(/[\\/\r\n]/g, ' ').slice(0, 120);
    const r = await q(`INSERT INTO docs (driver_id, truck_id, kind, name, mime, size, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [did || null, tid || null, kind, name, b.mime, buf.length, buf, req.user.id]);
    if (did) await history(did, `${kind === 'cdl' ? 'CDL' : kind === 'medical' ? 'Medical card' : 'A paper'} uploaded`, req.user.name, 'web');
    res.json({ doc: out({ ...r.rows[0], by_name: req.user.name }) });
  }));
  // CDL and medical card: on file or not, and when the bot last asked for them in his Telegram group
  const ASK = {
    cdl: (f) => `Hi ${f}! Please send a clear photo of your CDL here in this chat, front and back. We need it on file before you start.`,
    medical: (f) => `Hi ${f}! Please send a photo of your DOT medical card here in this chat. We need it on file before you start.` };
  const group = async (id) => (await q(`SELECT chat_id FROM tg_chats WHERE driver_id = $1 AND kind = 'dispatch' AND active ORDER BY last_at DESC NULLS LAST LIMIT 1`, [id])).rows[0];
  app.get('/api/drivers/:id/papers', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const have = new Set((await q(`SELECT DISTINCT kind FROM docs WHERE driver_id = $1`, [d.id])).rows.map((r) => r.kind));
    const asked = Object.fromEntries((await q(`SELECT kind, max(sent_at) at FROM bot_outcomes WHERE driver_id = $1 AND kind IN ('docreq:cdl', 'docreq:medical') GROUP BY kind`, [d.id])).rows.map((r) => [r.kind.slice(7), r.at]));
    const bot = require('./tg/bot');
    res.json({ cdl: have.has('cdl'), medical: have.has('medical'), asked: { cdl: asked.cdl || null, medical: asked.medical || null }, canAsk: bot.on() && !!(await group(d.id)), botOn: bot.on() });
  }));
  app.post('/api/drivers/:id/request-paper', needUser, wrap(async (req, res) => {
    const d = await loadDriver(req, res); if (!d) return;
    const kind = (req.body || {}).kind; if (!ASK[kind]) return res.status(400).json({ error: 'CDL or medical card' });
    const bot = require('./tg/bot'); if (!bot.on()) return res.status(400).json({ error: 'The Telegram bot is not turned on' });
    const g = await group(d.id); if (!g) return res.status(404).json({ error: 'This driver has no Telegram group with the bot in it yet' });
    if ((await q(`SELECT 1 FROM docs WHERE driver_id = $1 AND kind = $2`, [d.id, kind])).rows[0]) return res.status(400).json({ error: 'It is already on file' });
    if ((await q(`SELECT 1 FROM bot_outcomes WHERE driver_id = $1 AND kind = $2 AND sent_at > now() - interval '2 hours'`, [d.id, 'docreq:' + kind])).rows[0]) return res.status(400).json({ error: 'The bot asked for it less than 2 hours ago' });
    const p = (await q(`SELECT * FROM tg_people WHERE role = 'driver' AND driver_id = $1 ORDER BY seen_at DESC NULLS LAST LIMIT 1`, [d.id])).rows[0];
    const text = ASK[kind](String(d.name).trim().split(/\s+/)[0]);
    try { await bot.send(g.chat_id, p ? bot.esc(text).replace(/^Hi [^!]+!/, 'Hi ' + bot.tag(p) + '!') : bot.esc(text), { human: true }); } catch (e) { return res.status(502).json({ error: 'Telegram did not take it: ' + e.message }); }
    await require('./tg/learn').record({ driverId: d.id, kind: 'docreq:' + kind }).catch(() => {});
    await history(d.id, `${kind === 'cdl' ? 'CDL' : 'Medical card'} requested in the Telegram group`, req.user.name, 'telegram');
    res.json({ ok: true });
  }));
  // the file itself, for the team
  app.get('/api/docs/:id/file', needUser, wrap(async (req, res) => {
    const x = (await q(`SELECT * FROM docs WHERE id = $1`, [+req.params.id || 0])).rows[0]; if (!x) return res.status(404).json({ error: 'Not found' });
    if (x.driver_id) { if (req.user.role === 'dispatcher') return res.status(403).json({ error: 'Dispatchers handle truck papers only' }); const d = await loadDriver(req, res, x.driver_id); if (!d) return; }
    res.set({ 'Content-Type': x.mime, 'Content-Disposition': `inline; filename="${encodeURIComponent(x.name)}"`, 'Cache-Control': 'private, no-store' }).send(x.data);
  }));
  app.delete('/api/docs/:id', needUser, wrap(async (req, res) => {
    const x = (await q(`SELECT id, driver_id, kind FROM docs WHERE id = $1`, [+req.params.id || 0])).rows[0]; if (!x) return res.status(404).json({ error: 'Not found' });
    if (x.driver_id) { if (req.user.role === 'dispatcher') return res.status(403).json({ error: 'Dispatchers handle truck papers only' }); const d = await loadDriver(req, res, x.driver_id); if (!d) return; }
    await q(`DELETE FROM docs WHERE id = $1`, [x.id]);
    if (x.driver_id) await history(x.driver_id, `${x.kind === 'cdl' ? 'CDL' : 'A paper'} deleted`, req.user.name, 'web');
    res.json({ ok: true });
  }));
};
