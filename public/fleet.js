// A truck's own page: oil changes, shop visits and issues, mileage, costs, and which drivers and companies it had.
(() => {
  const { $, esc, view, S, api, toast, fail, on, header, dialog, dateText, dayOf, teamWhen, badge, plural, today } = App;
  const KIND = { oil_change: 'Oil change', maintenance: 'Maintenance', repair: 'Repair', tires: 'Tires', inspection: 'Inspection', breakdown: 'Breakdown', damage: 'Damage', warning_light: 'Warning light', other: 'Other' };
  const SHOP = ['oil_change', 'maintenance', 'repair', 'tires', 'inspection'];
  const money = (n) => '$' + (+n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const mi = (n) => (+n).toLocaleString('en-US') + ' mi';
  const evDay = (e) => e.doneOn || dayOf(e.fixedAt || e.at);
  let cur = null; let hist = 'all';

  function oilHero(o, t) {
    const every = `every ${mi(o.every.miles)} or ${plural(o.every.days, 'day')}${t.oilMiles || t.oilDays ? ' (this truck)' : ''}`;
    if (o.state === 'unknown') {
      return `<div class="oilhero unknown"><div class="oh-main"><span class="oh-k">Oil change</span><b class="oh-big">No oil change on record</b>
        <p>Log the last one, with its date and mileage, so the next one can be tracked. Oil changes are due ${every}.</p></div></div>`;
    }
    const left = [];
    if (o.milesLeft !== null) left.push(o.milesLeft <= 0 ? `${mi(-o.milesLeft)} over` : `${mi(o.milesLeft)} left`);
    left.push(o.daysLeft <= 0 ? `${plural(-o.daysLeft, 'day')} over` : `${plural(o.daysLeft, 'day')} left`);
    const big = o.state === 'overdue' ? 'Overdue' : o.state === 'soon' ? 'Due soon' : 'Up to date';
    const l = o.last;
    return `<div class="oilhero ${o.state}"><div class="oh-main"><span class="oh-k">Oil change</span><b class="oh-big">${big}</b><p class="oh-left">${left.join(', ')}</p>
        <p class="small">Next by <b>${esc(dateText(o.dueDate, { year: 'numeric' }))}</b>${o.dueMiles ? ` or <b>${mi(o.dueMiles)}</b>, whichever comes first` : ''}. Due ${every}.</p></div>
      <dl class="oh-last"><dt>Last one</dt><dd>${esc(dateText(dayOf(l.at), { year: 'numeric' }))}${l.odometer ? `, ${mi(l.odometer)}` : ''}</dd>
        ${l.shop ? `<dt>Shop</dt><dd>${esc(l.shop)}</dd>` : ''}${l.cost !== null ? `<dt>Cost</dt><dd>${money(l.cost)} ${l.paid === true ? '<span class="paid yes">Paid</span>' : l.paid === false ? '<span class="paid no">Not paid</span>' : ''}</dd>` : ''}</dl></div>`;
  }
  const evRow = (e, edit) => `<li class="ev" data-ev="${e.id}"><time>${esc(dateText(evDay(e), { year: 'numeric' }))}</time>
    <div class="grow"><div><span class="tst ${e.status}">${e.status === 'fixed' ? 'Done' : e.status === 'scheduled' ? 'Scheduled' : 'Open'}</span> <b>${esc(e.title)}</b> <span class="small mut">${esc(KIND[e.kind] || e.kind)}</span></div>
      ${e.details ? `<div class="small">${esc(e.details)}</div>` : ''}
      <div class="small mut">${[e.shop && esc(e.shop), e.odometer && mi(e.odometer), e.source === 'telegram' ? 'from the Telegram group' : e.addedBy ? 'by ' + esc(e.addedBy) : ''].filter(Boolean).join(' · ')}</div></div>
    <div class="evcost">${e.cost !== null ? `<b>${money(e.cost)}</b>${e.paid === true ? '<span class="paid yes">Paid</span>' : e.paid === false ? '<span class="paid no">Not paid</span>' : '<span class="paid unk">Paid?</span>'}` : ''}
      ${edit ? `${e.cost !== null && e.paid !== true ? '<button type="button" class="linkbtn" data-act="evPaid">Mark paid</button>' : ''}${e.status !== 'fixed' ? '<button type="button" class="linkbtn" data-act="evDone">Mark done</button>' : ''}<button type="button" class="linkbtn" data-act="evEdit">Edit</button>` : ''}</div></li>`;
  const HK = { added: 'Added to the list', driver: 'Driver', company: 'Company', service: 'Service', dispatcher: 'Dispatcher', unit: 'Unit number' };
  const histRow = (h) => {
    let txt;
    if (h.kind === 'added') txt = 'Added to the list';
    else if (h.kind === 'service') txt = h.to === 'out' ? 'Out of service' : 'Back in service';
    else if (h.kind === 'driver') txt = h.to ? (h.from ? `Driver: <b>${esc(h.to)}</b> (was ${esc(h.from)})` : `Driver: <b>${esc(h.to)}</b>`) : `<b>${esc(h.from || 'The driver')}</b> left the truck`;
    else txt = `${HK[h.kind] || h.kind}: <b>${esc(h.to || 'none')}</b>${h.from ? ` (was ${esc(h.from)})` : ''}`;
    return `<li class="ev hist"><time>${esc(dateText(dayOf(h.at), { year: 'numeric' }))}</time><div class="grow">${txt}</div></li>`;
  };

  async function viewTruck(id) {
    const live = App.drawing(); let r;
    try { r = await api('/api/trucks/' + id); } catch (e) { if (!live()) return; view.innerHTML = header('trucks') + `<main><a class="back" href="#/trucks">← Trucks</a><div class="empty"><p>${esc(e.message)}</p></div></main>`; return; }
    if (!live()) return;
    cur = r; const t = r.truck, o = r.oil, c = r.costs, edit = r.canEdit;
    document.title = `Truck ${t.unit} · FleetHire`;
    const open = r.events.filter((e) => e.status !== 'fixed' && e.kind !== 'oil_change' || (e.kind === 'oil_change' && e.status === 'scheduled'));
    const filt = { all: () => true, oil: (e) => e.kind === 'oil_change', shop: (e) => SHOP.includes(e.kind) && e.kind !== 'oil_change', issues: (e) => !SHOP.includes(e.kind) };
    const evs = hist === 'people' ? [] : r.events.filter(filt[hist] || filt.all);
    const items = hist === 'people' ? r.history.map(histRow) : hist === 'all' ? [...r.events.map((e) => ({ at: evDay(e), h: evRow(e, edit) })), ...r.history.map((h) => ({ at: dayOf(h.at), h: histRow(h) }))].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map((x) => x.h) : evs.map((e) => evRow(e, edit));
    const kinds = Object.entries(c.byKind).sort((a, b) => b[1] - a[1]); const top = kinds.length ? kinds[0][1] : 0;
    const drv = t.driver ? `${t.driver.id ? `<a href="#/driver/${t.driver.id}"><b>${esc(t.driver.name)}</b></a>` : `<b>${esc(t.driver.name)}</b>`} ${badge(t.driver.status)}${t.driver.group ? ` <a class="small" href="#/telegram/${t.driver.group}">dispatch group</a>` : ''}` : t.driverName ? `<b>${esc(t.driverName)}</b>` : '<span class="none">Nobody</span>';
    const tab = (k, l) => `<button type="button" data-act="truckHist" data-k="${k}" class="${hist === k ? 'on' : ''}" aria-pressed="${hist === k}">${l}</button>`;
    view.innerHTML = header('trucks') + `<main class="truckpage">
      <a class="back" href="#/trucks">← Trucks</a>
      <section class="dhead"><div class="top"><div class="who"><h2>Truck ${esc(t.unit)} <span class="tstate ${t.outOfService ? 'out' : t.driver || t.driverName ? 'assigned' : 'empty'}">${t.outOfService ? 'Out of service' : t.driver || t.driverName ? 'With a driver' : 'Empty'}</span></h2>
          <div class="sub">${[t.details && esc(t.details), t.vin && 'VIN ' + esc(t.vin), t.plate && 'Plate ' + esc(t.plate), t.location && esc(t.location)].filter(Boolean).join(' · ') || '<span class="none">No details yet</span>'}</div></div>
        ${edit ? `<div class="acts"><button class="btn primary" data-act="evAdd" data-k="oil_change">Log oil change</button><button class="btn plain" data-act="evAdd" data-k="repair">Log service or issue</button><button class="btn plain" data-act="truckEditHere">Edit truck</button></div>` : ''}</div>
        <dl class="tfacts"><div><dt>Company</dt><dd>${App.coTag(t.companyId) || '<span class="none">None</span>'}</dd></div><div><dt>Driver</dt><dd>${drv}</dd></div>
          <div><dt>Dispatcher</dt><dd>${t.dispatcher ? esc(t.dispatcher) : '<span class="none">Nobody yet</span>'}</dd></div>
          <div><dt>Mileage</dt><dd>${o.odometer ? `<b>${mi(o.odometer)}</b> <span class="small mut">${o.odometerAt ? 'updated ' + esc(teamWhen(o.odometerAt)) : ''}</span>` : '<span class="none">Not known</span>'}${edit ? ' <button type="button" class="linkbtn" data-act="truckMiles">Update</button>' : ''}</dd></div></dl></section>
      <div class="cols tcols"><div>
        <section class="card">${oilHero(o, t)}${edit ? `<div class="oh-acts"><button type="button" class="linkbtn" data-act="truckOilEvery">Change the interval for this truck</button></div>` : ''}</section>
        ${open.length ? `<section class="card"><h3>Open issues and scheduled work <span class="cnt">${open.length}</span></h3><ul class="evlist">${open.map((e) => evRow(e, edit)).join('')}</ul></section>` : ''}
        <section class="card"><h3>History</h3><div class="seg sm" role="group" aria-label="Show">${tab('all', 'Everything')}${tab('oil', 'Oil changes')}${tab('shop', 'Shop and service')}${tab('issues', 'Issues')}${tab('people', 'Drivers and companies')}</div>
          ${items.length ? `<ul class="evlist">${items.join('')}</ul>` : '<p class="hint">Nothing here yet. Oil changes and shop visits talked about in the driver\'s Telegram groups are added by themselves.</p>'}</section>
      </div><div>
        <section class="card"><h3>Costs</h3><dl class="figs">${[['This month', c.month], ['This year', c.year], ['All time', c.all]].map(([l, v]) => `<div><dd>${money(v)}</dd><dt>${l}</dt></div>`).join('')}</dl>
          ${c.unpaid ? `<p class="unpaidline">${money(c.unpaid)} not paid yet</p>` : ''}
          ${kinds.length ? `<ul class="kbars">${kinds.map(([k, v]) => `<li><span>${esc(KIND[k] || k)}</span><i style="width:${Math.max(4, (v / top) * 100)}%"></i><b>${money(v)}</b></li>`).join('')}</ul>` : '<p class="hint">No costs yet. Add the cost when you log a service.</p>'}</section>
        <section class="card"><h3>Drivers and companies</h3>${r.history.filter((h) => ['driver', 'company'].includes(h.kind)).length ? `<ul class="evlist">${r.history.filter((h) => ['driver', 'company'].includes(h.kind)).slice(0, 12).map(histRow).join('')}</ul>` : '<p class="hint">Changes of driver and company are kept here from now on.</p>'}</section>
        ${t.notes ? `<section class="card"><h3>Notes</h3><p class="small" style="white-space:pre-wrap">${esc(t.notes)}</p></section>` : ''}
      </div></div></main>`;
  }
  on('truckHist', (b) => { hist = b.dataset.k; viewTruck(cur.truck.id); });
  on('truckEditHere', () => App.truckDialog({ ...cur.truck }, {}, () => viewTruck(cur.truck.id)));

  // log or edit a service, an oil change or an issue
  function evDialog(e, kind) {
    const t = cur.truck; const isNew = !e; e = e || { kind, status: kind === 'oil_change' ? 'fixed' : 'open', title: kind === 'oil_change' ? 'Oil change' : '', doneOn: today(), paid: null };
    const oil = e.kind === 'oil_change';
    dialog(`<form id="evForm" class="dform"><h2>${isNew ? (oil ? 'Log an oil change' : 'Log a service or an issue') : esc(e.title)}<span class="small mut"> · truck ${esc(t.unit)}</span></h2><div class="grid2">
        <label class="fld">What<input name="title" type="text" required maxlength="120" value="${esc(e.title)}" placeholder="${oil ? 'Oil change and filters' : 'New steer tires, check engine light, PM service'}"></label>
        <label class="fld">Kind<select name="kind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${e.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="fld">Status<select name="status">${[['fixed', 'Done'], ['scheduled', 'Scheduled'], ['open', 'Open (a problem to fix)']].map(([k, l]) => `<option value="${k}" ${e.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="fld">Day<input name="doneOn" type="date" max="${esc(today())}" value="${esc(e.doneOn || evDay(e) || '')}"></label>
        <label class="fld">Mileage${oil ? ' (needed to track the next one)' : ''}<input name="odometer" type="number" min="1" step="1" inputmode="numeric" value="${e.odometer || ''}" placeholder="${cur.oil.odometer || '412500'}"></label>
        <label class="fld">Shop<input name="shop" type="text" maxlength="120" value="${esc(e.shop || '')}" placeholder="Speedco, Love's, TA"></label>
        <label class="fld">Cost ($)<input name="cost" type="number" min="0" step="0.01" inputmode="decimal" value="${e.cost !== null && e.cost !== undefined ? e.cost : ''}"></label>
        <label class="fld">Paid<select name="paid"><option value="" ${e.paid === null || e.paid === undefined ? 'selected' : ''}>Not known</option><option value="true" ${e.paid === true ? 'selected' : ''}>Yes, paid</option><option value="false" ${e.paid === false ? 'selected' : ''}>Not paid yet</option></select></label>
        <label class="fld" style="grid-column:1 / -1">Details<textarea name="details" rows="2" maxlength="800" placeholder="${oil ? 'Oil and filters changed, anything else done' : 'What happened, what the shop said'}">${esc(e.details || '')}</textarea></label></div>
      <p class="err" id="evErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button><span class="grow"></span>${!isNew && ['admin', 'dispatcher'].includes(S.me.role) ? '<button type="button" class="btn danger" id="evDel">Delete</button>' : ''}</div></form>`, (d) => {
      const f = $('#evForm', d);
      f.status.onchange = () => { f.doneOn.max = f.status.value === 'fixed' ? today() : ''; };
      f.onsubmit = async (ev) => {
        ev.preventDefault(); const b = Object.fromEntries(new FormData(f)); b.paid = b.paid === '' ? null : b.paid === 'true';
        if (b.kind === 'oil_change' && b.status === 'fixed' && !b.odometer && !confirm('No mileage: the next oil change will be tracked by date only. Save anyway?')) return;
        try { await api(isNew ? `/api/trucks/${t.id}/events` : `/api/truck-events/${e.id}`, { method: isNew ? 'POST' : 'PATCH', body: b }); d.close(); toast('Saved'); viewTruck(t.id); } catch (er) { $('#evErr').textContent = er.message; }
      };
      if ($('#evDel')) $('#evDel').onclick = async () => { if (!confirm(`Delete "${e.title}" from the history?`)) return; try { await api('/api/truck-events/' + e.id, { method: 'DELETE' }); d.close(); toast('Deleted'); viewTruck(t.id); } catch (er) { fail(er); } };
    });
  }
  const evOf = (b) => cur.events.find((e) => e.id === +b.closest('[data-ev]').dataset.ev);
  on('evAdd', (b) => evDialog(null, b.dataset.k));
  on('evEdit', (b) => evDialog(evOf(b)));
  on('evPaid', async (b) => { await api('/api/truck-events/' + evOf(b).id, { method: 'PATCH', body: { paid: true } }); toast('Marked paid'); viewTruck(cur.truck.id); });
  on('evDone', async (b) => { const e = evOf(b); if (e.kind === 'oil_change') return evDialog({ ...e, status: 'fixed', doneOn: today() }); await api('/api/truck-events/' + e.id, { method: 'PATCH', body: { status: 'fixed' } }); toast('Marked done'); viewTruck(cur.truck.id); });
  on('truckMiles', () => dialog(`<form id="miForm" class="dform"><h2>Mileage of truck ${esc(cur.truck.unit)}</h2>
      <label class="fld">Odometer now (miles)<input name="odometer" type="number" min="1" step="1" inputmode="numeric" required value="${cur.oil.odometer || ''}"></label>
      <label class="chk"><input type="checkbox" name="fix"><span>Correct the mileage (it was entered too high)</span></label>
      <p class="hint">The bot also picks up the mileage when the driver says it in his Telegram group.</p><p class="err" id="miErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
    $('#miForm', d).onsubmit = async (e) => { e.preventDefault(); try { await api(`/api/trucks/${cur.truck.id}/miles`, { method: 'POST', body: { odometer: e.target.odometer.value, fix: e.target.fix.checked } }); d.close(); toast('Saved'); viewTruck(cur.truck.id); } catch (er) { $('#miErr').textContent = er.message; } };
  }));
  on('truckOilEvery', () => {
    const t = cur.truck, f = cur.fleet;
    dialog(`<form id="oeForm" class="dform"><h2>Oil changes for truck ${esc(t.unit)}</h2><div class="grid2">
        <label class="fld">Every (miles)<input name="oilMiles" type="number" min="1000" max="200000" step="500" value="${t.oilMiles || ''}" placeholder="${f.oilMiles} (all trucks)"></label>
        <label class="fld">or every (days)<input name="oilDays" type="number" min="7" max="730" value="${t.oilDays || ''}" placeholder="${f.oilDays} (all trucks)"></label></div>
      <p class="hint">Leave empty to use the setting for all trucks: every ${mi(f.oilMiles)} or ${f.oilDays} days, whichever comes first.</p><p class="err" id="oeErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
      $('#oeForm', d).onsubmit = async (e) => { e.preventDefault(); try { await api('/api/trucks/' + t.id, { method: 'PATCH', body: { oilMiles: e.target.oilMiles.value, oilDays: e.target.oilDays.value } }); d.close(); toast('Saved'); viewTruck(t.id); } catch (er) { $('#oeErr').textContent = er.message; } };
    });
  });
  // for all trucks (admins and dispatchers)
  on('fleetSettings', async () => {
    const f = await api('/api/fleet/settings');
    dialog(`<form id="fsForm" class="dform"><h2>Oil change settings</h2><div class="grid2">
        <label class="fld">Oil change every (miles)<input name="oilMiles" type="number" min="1000" max="200000" step="500" required value="${f.oilMiles}"></label>
        <label class="fld">or every (days)<input name="oilDays" type="number" min="7" max="730" required value="${f.oilDays}"></label>
        <label class="fld">"Due soon" this many miles before<input name="warnMiles" type="number" min="0" max="50000" step="100" required value="${f.warnMiles}"></label>
        <label class="fld">or this many days before<input name="warnDays" type="number" min="0" max="120" required value="${f.warnDays}"></label></div>
      <label class="chk"><input type="checkbox" name="askDriver" ${f.askDriver ? 'checked' : ''}><span>When an oil change is due, the bot asks the driver for the mileage in his dispatch group</span></label>
      <p class="hint">Whichever comes first, miles or days. A truck can have its own interval on its page. When one is due soon or overdue, its dispatcher (or every dispatcher) and the admins get a notification.</p><p class="err" id="fsErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
      $('#fsForm', d).onsubmit = async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); b.askDriver = e.target.askDriver.checked; try { await api('/api/fleet/settings', { method: 'PUT', body: b }); d.close(); toast('Saved'); App.render(); } catch (er) { $('#fsErr').textContent = er.message; } };
    });
  });
  App.route(/^#\/truck\/(\d+)$/, (id) => viewTruck(+id));
})();
