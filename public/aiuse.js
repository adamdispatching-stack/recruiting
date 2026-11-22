// AI usage and cost (admins): what Claude costs today, this week and this month (and where the month is heading),
// day by day, by purpose, by model and by part (website, Telegram bot, Chrome extension). A monthly budget and the
// prices per model can be changed here.
(() => {
  const { esc, view, S, api, toast, fail, on, header } = App;
  const usd = (n) => (n >= 100 ? '$' + Math.round(n).toLocaleString('en-US') : n >= 1 ? '$' + n.toFixed(2) : n > 0 ? '$' + n.toFixed(n >= 0.01 ? 3 : 4) : '$0');
  const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  // is the AI working right now, why calls failed, and the Test button
  function health(r) {
    const st = r.state || {}, errs = r.errors || [];
    const line = !r.serverKey ? '' : st.paused ? `<p class="aibad"><b>The AI is paused</b> until ${when(st.paused.until)}: ${esc(st.paused.why)}</p>`
      : st.lastOk ? `<p class="aiok"><b>Working.</b> Last answer ${when(st.lastOk.at)} (${esc(st.lastOk.model)}).</p>`
      : errs.length ? `<p class="aibad"><b>Not working.</b> ${esc(errs[0].why)}</p>` : '<p class="hint">No AI call since the website last restarted.</p>';
    const swapped = Object.entries(st.swapped || {}).map(([a, b]) => `<code>${esc(a)}</code> → <code>${esc(b)}</code>`).join(', ');
    return `<section class="card aihealth"><div class="row sb"><h3>Is the AI working?</h3><button class="btn sm" data-act="aiTest" ${r.serverKey ? '' : 'disabled'}>Test AI now</button></div>${line}
      <div id="aiTestOut"></div>
      ${swapped ? `<p class="small mut">This key cannot use one of the models, so the website uses another: ${swapped}.</p>` : ''}
      ${errs.length ? `<h4>Why calls failed, last 7 days</h4><table class="mini aierr"><tbody>${errs.map((e) => `<tr><td><b>${esc(e.why)}</b><div class="small mut">${e.n} time${e.n === 1 ? '' : 's'} · last ${when(e.last)} · ${esc(e.features || '')} · ${esc(e.models || '')}${e.status ? ` · HTTP ${e.status}` : ''}</div>${e.message ? `<div class="small mut">Anthropic said: ${esc(e.message)}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
      ${r.week.failed && !errs.length ? '<p class="small mut">Calls that failed before this update have no reason saved. Press Test AI now to see what is wrong.</p>' : ''}</section>`;
  }
  on('aiTest', async (btn) => {
    btn.disabled = true; btn.textContent = 'Testing…'; const box = document.getElementById('aiTestOut');
    try {
      const x = await api('/api/ai-usage/test', { method: 'POST' });
      box.innerHTML = x.results.map((t) => t.ok ? `<p class="aiok">✓ <code>${esc(t.model)}</code> works${t.used && t.used !== t.model ? ` (using <code>${esc(t.used)}</code>)` : ''}.</p>`
        : `<p class="aibad">✗ <code>${esc(t.model)}</code>: ${esc(t.why)}</p>`).join('') + (x.results.every((t) => t.ok) ? '<p class="small mut">The bot goes back to reading the groups now; messages it missed are read too.</p>' : '');
    } catch (er) { fail(er); }
    btn.disabled = false; btn.textContent = 'Test AI now';
  });
  const PART = { website: '🌐 Website', bot: '🤖 Telegram bot', extension: '🧩 Chrome extension' };

  function chart(days) {
    const max = Math.max(...days.map((d) => d.cost), 0.0001), W = 900, H = 180, bw = W / days.length;
    const bars = days.map((d, i) => { const h = Math.max(d.cost > 0 ? 2 : 0, (d.cost / max) * (H - 24)); const lab = new Date(d.day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      return `<g class="ab"><rect x="${i * bw + 2}" y="${H - h}" width="${bw - 4}" height="${h}" rx="3"/><rect class="hit" x="${i * bw}" y="0" width="${bw}" height="${H}"><title>${lab}: ${usd(d.cost)}, ${d.calls} call${d.calls === 1 ? '' : 's'}</title></rect>${i % 5 === 4 || i === days.length - 1 ? `<text x="${i * bw + bw / 2}" y="${H + 16}">${lab}</text>` : ''}</g>`; }).join('');
    return `<svg class="aichart" viewBox="0 -6 ${W} ${H + 26}" role="img" aria-label="AI cost per day, last 30 days"><line x1="0" x2="${W}" y1="${H}" y2="${H}" class="base"/><text x="0" y="6" class="mx">${usd(max)}</text>${bars}</svg>`;
  }

  async function viewAi() {
    if (S.me.role !== 'admin') { location.hash = '#/'; return; }
    const live = App.drawing(); let r;
    try { r = await api('/api/ai-usage'); } catch (e) { if (live()) view.innerHTML = header('ai') + `<main class="o"><p class="hint">${esc(e.message)}</p></main>`; return; }
    if (!live()) return;
    const pct = r.budget ? Math.round((r.month.cost / r.budget) * 100) : 0;
    const total30 = r.byFeature.reduce((a, x) => a + x.cost, 0) || 1;
    const prices = Object.entries(r.prices);
    view.innerHTML = header('ai') + `<main class="o aipage"><div class="pagehead"><h1>AI usage</h1><p class="hint">What Claude costs: the website and the Telegram bot (the key on Railway) and the Chrome extension (its own key; each Chrome profile reports its totals when it syncs). Costs come from the tokens and the prices below.</p></div>
      ${r.serverKey ? '' : '<p class="warnline">ANTHROPIC_API_KEY is not set on Railway, so the website and the bot use no AI.</p>'}
      ${r.unknownModels.length ? `<p class="warnline">No price for ${r.unknownModels.map(esc).join(', ')}: add it below, or those calls count as $0.</p>` : ''}
      ${health(r)}
      <section class="card"><dl class="figs aifigs"><div><dd>${usd(r.today.cost)}</dd><dt>today · ${r.today.calls} calls</dt></div><div><dd>${usd(r.week.cost)}</dd><dt>last 7 days · ${r.week.calls} calls</dt></div>
        <div><dd>${usd(r.month.cost)}</dd><dt>this month · heading to about ${usd(r.projected)}</dt></div>
        <div><dd>${r.budget ? usd(r.budget) : '—'}</dd><dt>${r.budget ? `monthly budget · ${pct}% used` : 'no monthly budget set'}</dt>${r.budget ? `<span class="pbar"><i style="width:${Math.min(100, pct)}%;${pct >= 100 ? 'background:#B3261E' : pct >= 80 ? 'background:#C9963A' : ''}"></i></span>` : ''}</div></dl>
        ${r.month.failed || r.week.failed ? `<p class="small mut">${r.week.failed} call${r.week.failed === 1 ? '' : 's'} failed in the last 7 days (they cost nothing).</p>` : ''}</section>
      <section class="card"><h3>Day by day, last 30 days</h3>${chart(r.days)}</section>
      <section class="card"><h3>What it is used for, last 30 days</h3>
        <div class="scroll"><table class="mini aitab"><thead><tr><th>Purpose</th><th class="n">Calls</th><th class="n">Tokens in / out</th><th class="n">Cost</th><th>Share</th></tr></thead><tbody>
        ${r.byFeature.map((x) => `<tr><td><b>${esc(x.name)}</b>${x.failed ? ` <span class="small mut">${x.failed} failed</span>` : ''}</td><td class="n">${x.calls}</td><td class="n">${num(x.in)} / ${num(x.out)}</td><td class="n"><b>${usd(x.cost)}</b></td><td><span class="pbar sm"><i style="width:${Math.round((x.cost / total30) * 100)}%"></i></span></td></tr>`).join('') || '<tr><td colspan="5" class="hint">No AI used yet.</td></tr>'}</tbody></table></div></section>
      <div class="twocol"><section class="card"><h3>By part, last 30 days</h3><table class="mini"><tbody>${r.bySource.map((x) => `<tr><td>${PART[x.key] || esc(x.key)}</td><td class="n">${x.calls} calls</td><td class="n"><b>${usd(x.cost)}</b></td></tr>`).join('') || '<tr><td class="hint">Nothing yet.</td></tr>'}</tbody></table></section>
        <section class="card"><h3>By model, last 30 days</h3><table class="mini"><tbody>${r.byModel.map((x) => `<tr><td><code>${esc(x.key)}</code></td><td class="n">${x.calls} calls</td><td class="n"><b>${usd(x.cost)}</b></td></tr>`).join('') || '<tr><td class="hint">Nothing yet.</td></tr>'}</tbody></table></section></div>
      <section class="card"><h3>Budget and prices</h3>
        <form id="aiBudget" class="autof"><label class="fld">Monthly budget, USD (0 = none)<input type="number" name="budget" min="0" step="1" value="${r.budget || 0}"></label><button class="btn primary sm">Save</button><span class="small mut">Admins get a notification at 80% and 100%.</span></form>
        <p class="hint">Dollars per million tokens. Change them when Anthropic changes its prices (platform.claude.com → pricing).</p>
        <form id="aiPrices"><div class="scroll"><table class="mini aiprice"><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th></tr></thead><tbody>
          ${prices.map(([m, p]) => `<tr data-m="${esc(m)}"><td><code>${esc(m)}</code></td>${['in', 'out', 'cr', 'cw'].map((k) => `<td><input type="number" step="0.001" min="0" name="${k}" value="${p[k] ?? ''}" aria-label="${esc(m)} ${k}"></td>`).join('')}</tr>`).join('')}
          <tr data-m=""><td><input type="text" name="model" placeholder="another model, e.g. claude-opus-5-5" aria-label="Model name"></td>${['in', 'out', 'cr', 'cw'].map((k) => `<td><input type="number" step="0.001" min="0" name="${k}" aria-label="New model ${k}"></td>`).join('')}</tr>
        </tbody></table></div><p><button class="btn primary sm">Save prices</button></p></form></section></main>`;
  }
  document.addEventListener('submit', async (e) => {
    const b = e.target.closest('#aiBudget'), p = e.target.closest('#aiPrices'); if (!b && !p) return; e.preventDefault();
    try {
      if (b) await api('/api/ai-usage/settings', { method: 'PUT', body: { budget: b.budget.value } });
      else {
        const prices = {};
        for (const tr of p.querySelectorAll('tr[data-m]')) {
          const m = tr.dataset.m || (tr.querySelector('[name=model]') || {}).value; if (!m) continue;
          const v = Object.fromEntries(['in', 'out', 'cr', 'cw'].map((k) => [k, tr.querySelector(`[name=${k}]`).value]));
          if (!tr.dataset.m && (v.in === '' || v.out === '')) continue;
          prices[m.trim()] = v;
        }
        await api('/api/ai-usage/settings', { method: 'PUT', body: { prices } });
      }
      toast('Saved'); viewAi();
    } catch (er) { fail(er); }
  });
  App.route(/^#\/ai$/, viewAi);
})();
