// Shops & services: truck shops, tire service, towing, road service, mobile mechanics, detailing, locksmiths, truck
// washes, parts. Built by the AI from the driver groups and by the team; trusted ones first, by state.
(() => {
  const { $, esc, view, S, api, toast, fail, on, onChange, header, dialog, plural, when } = App;
  let kind = '', state = '', words = '', data = null;
  const mapLink = (p) => { const a = [p.address, p.city, p.state].filter(Boolean).join(', '); return a ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + ' ' + a)}" target="_blank" rel="noopener">${esc(a)}</a>` : '<span class="none">—</span>'; };
  async function viewPlaces() {
    const live = App.drawing(); data = await api('/api/places'); if (!live()) return;
    document.title = 'Shops & services · FleetHire';
    const K = data.kinds; const all = data.places;
    const pass = (p) => (!kind || p.kind === kind) && (!state || p.state === state) && (!words || `${p.name} ${p.services.join(' ')} ${p.city || ''} ${p.area || ''} ${p.notes || ''}`.toLowerCase().includes(words));
    const shown = all.filter(pass);
    const cnt = (k) => all.filter((p) => p.kind === k).length;
    const states = [...new Set(all.map((p) => p.state).filter(Boolean))].sort();
    const row = (p) => `<tr data-pl="${p.id}"><th scope="row"><b>${esc(p.name)}</b>${p.verified ? ' <span class="okt" title="Trusted by the team">✓ Trusted</span>' : p.source === 'ai' ? ' <span class="small mut" title="Found by the AI in the driver groups; check it and mark it trusted">from the groups</span>' : ''}
        ${p.area ? `<div class="small mut">${esc(p.area)}</div>` : ''}</th>
      <td><span class="pkind k-${esc(p.kind)}">${esc(K[p.kind] || p.kind)}</span></td>
      <td>${p.services.length ? p.services.map((s) => `<span class="chip">${esc(s)}</span>`).join(' ') : '<span class="none">—</span>'}${p.notes ? `<div class="small mut">${esc(p.notes)}</div>` : ''}</td>
      <td class="nowrap">${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a>` : '<span class="none">—</span>'}</td>
      <td>${mapLink(p)}</td>
      <td class="nowrap">${p.good ? `<span title="Went well">👍 ${p.good}</span> ` : ''}${p.bad ? `<span title="Went badly">👎 ${p.bad}</span> ` : ''}${p.uses ? `<div class="small mut">used ${plural(p.uses, 'time')}${p.last_used_at ? ', last ' + esc(when(p.last_used_at)) : ''}</div>` : '<span class="small mut">not used yet</span>'}${p.last_cost ? `<div class="small">last $${Math.round(p.last_cost).toLocaleString()}</div>` : ''}</td>
      <td class="nowrap"><button class="linkbtn" data-act="plEdit">Edit</button> <button class="linkbtn" data-act="plTrust">${p.verified ? 'Untrust' : 'Trust'}</button> <button class="linkbtn" data-act="plHide">Hide</button></td></tr>`;
    view.innerHTML = header('places') + `<main>${App.pageHead('Shops & services', 'Truck shops, tire service, towing, road service, mobile mechanics, detailing, locksmiths and more. The bot adds the ones shared or used in the driver groups, with what they fix and how it went; trusted ones come first. Breakdown and flat tire cases show the ones in the same state.', `<button class="btn primary lg" data-act="plAdd">${App.plus} Add a place</button>`)}
      <div class="pagebar"><div class="seg" role="group" aria-label="Kind"><button data-act="plKind" data-k="" class="${kind ? '' : 'on'}">All ${all.length}</button>${Object.entries(K).filter(([k]) => cnt(k)).map(([k, l]) => `<button data-act="plKind" data-k="${k}" class="${kind === k ? 'on' : ''}">${esc(l.split(' (')[0])} ${cnt(k)}</button>`).join('')}</div>
        <select class="pick line" data-ch="plState" aria-label="State"><option value="">All states</option>${states.map((s) => `<option ${s === state ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <input type="search" id="plFind" class="pick line" placeholder="Find: DPF, lockout, Baltimore…" value="${esc(words)}" aria-label="Find"><span class="grow"></span></div>
      ${shown.length ? `<div class="sheet"><table class="tgt plt"><thead><tr><th>Name</th><th>Kind</th><th>What they do</th><th>Phone</th><th>Where</th><th>How it went</th><th></th></tr></thead><tbody>${shown.map(row).join('')}</tbody></table></div>`
        : `<section class="card"><p class="hint">${all.length ? 'Nothing matches.' : 'Nothing yet. Add the shops and services you use, or share them in the driver groups: the bot adds them here by itself.'}</p></section>`}</main>`;
  }
  onChange('plState', (el) => { state = el.value; viewPlaces(); });
  on('plKind', (b) => { kind = b.dataset.k; viewPlaces(); });
  document.addEventListener('input', (e) => { if (e.target.id !== 'plFind') return; words = e.target.value.trim().toLowerCase(); clearTimeout(viewPlaces.t); viewPlaces.t = setTimeout(() => { viewPlaces().then(() => { const i = document.getElementById('plFind'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }); }, 300); });
  const byId = (b) => data.places.find((p) => p.id === +b.closest('[data-pl]').dataset.pl);
  function placeDialog(p) {
    const K = data.kinds;
    dialog(`<form id="plForm" class="dform wide"><h2>${p ? 'Edit ' + esc(p.name) : 'Add a place'}</h2>
      <div class="frow"><label class="fld">Name<input name="name" required maxlength="120" value="${esc(p ? p.name : '')}"></label>
        <label class="fld">Kind<select name="kind">${Object.entries(K).map(([k, l]) => `<option value="${k}" ${p && p.kind === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>
      <label class="fld">What they do (commas: DPF cleaning, air leaks, steer tires)<input name="services" value="${esc(p ? p.services.join(', ') : '')}"></label>
      <div class="frow"><label class="fld">Phone<input name="phone" value="${esc(p ? p.phone || '' : '')}"></label><label class="fld">Area (for example Baltimore area)<input name="area" value="${esc(p ? p.area || '' : '')}"></label></div>
      <label class="fld">Address<input name="address" value="${esc(p ? p.address || '' : '')}"></label>
      <div class="frow"><label class="fld">City<input name="city" value="${esc(p ? p.city || '' : '')}"></label><label class="fld">State<select name="state"><option value="">—</option>${data.states.map((s) => `<option ${p && p.state === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>
      <label class="fld">Notes (hours, prices, who to ask for)<textarea name="notes" rows="2">${esc(p ? p.notes || '' : '')}</textarea></label>
      <p class="err" id="plErr" role="alert"></p><div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
      $('#plForm', d).onsubmit = async (e) => { e.preventDefault(); const body = Object.fromEntries(new FormData(e.target));
        try { await api(p ? '/api/places/' + p.id : '/api/places', { method: p ? 'PUT' : 'POST', body }); d.close(); toast('Saved'); viewPlaces(); } catch (er) { $('#plErr').textContent = er.message; } };
    });
  }
  on('plAdd', () => placeDialog(null));
  on('plEdit', (b) => placeDialog(byId(b)));
  on('plTrust', async (b) => { const p = byId(b); try { await api('/api/places/' + p.id, { method: 'PUT', body: { verified: !p.verified } }); viewPlaces(); } catch (e) { fail(e); } });
  on('plHide', async (b) => { const p = byId(b); if (!confirm(`Hide ${p.name}? It stays saved, the bot does not suggest it any more.`)) return; try { await api('/api/places/' + p.id, { method: 'PUT', body: { hidden: true } }); viewPlaces(); } catch (e) { fail(e); } });
  App.route(/^#\/places$/, viewPlaces);
})();
