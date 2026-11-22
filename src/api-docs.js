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
