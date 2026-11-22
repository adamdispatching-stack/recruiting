// AI usage and cost (admins): the report, the monthly budget and the prices per model.
const db = require('./db');
const { wrap, needUser, needAdmin, act } = require('./lib');
const usage = require('./ai-usage');

module.exports = (app) => {
  app.get('/api/ai-usage', needUser, needAdmin, wrap(async (req, res) => res.json(await usage.report())));
  app.put('/api/ai-usage/settings', needUser, needAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.budget !== undefined) {
      const n = +b.budget; if (!(n >= 0 && n < 100000)) return res.status(400).json({ error: 'A budget in dollars, 0 for none' });
      await db.saveSetting('ai', { ...(db.settings.ai || {}), budget: Math.round(n * 100) / 100 });
      usage.recheck(); usage.checkBudget().catch(() => {});
    }
    if (b.prices && typeof b.prices === 'object') {
      const cur = { ...(db.settings.aiPrices || {}) };
      for (const [m, p] of Object.entries(b.prices)) {
        if (!/^[a-z0-9.-]{3,60}$/.test(m)) return res.status(400).json({ error: 'Model names look like claude-haiku-5-5' });
        if (p === null) { delete cur[m]; continue; }
        const x = {}; for (const k of ['in', 'out', 'cr', 'cw', 'longIn', 'longOut']) if (p[k] !== undefined && p[k] !== '') { const v = +p[k]; if (!(v >= 0 && v < 1000)) return res.status(400).json({ error: 'Prices are dollars per million tokens' }); x[k] = v; }
        if (x.in === undefined || x.out === undefined) return res.status(400).json({ error: 'Input and output prices are needed' });
        cur[m] = { ...(usage.PRICES[m] || {}), ...x };
      }
      await db.saveSetting('aiPrices', cur);
    }
    await act(req.user, 'admin', null, 'AI cost settings changed').catch(() => {});
    res.json({ ok: true });
  }));
};
