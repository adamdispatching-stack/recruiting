// Companies: the carriers we dispatch for. Each has its own trucks, and each driver works for one of them.
(() => {
  const { $, esc, view, S, api, toast, on, header, badge, dialog, plural, person, dateText, dayOf, fmtPhone } = App;
  const COLOR_NAMES = ['Green', 'Blue', 'Purple', 'Orange', 'Teal', 'Red', 'Brown', 'Gray'];
  const STATE = { empty: 'Empty', assigned: 'With a driver', out: 'Out of service' };
  const one = (mode) => (mode === 'Owner-operators' ? 'Owner operator' : mode === 'Company drivers' ? 'Company driver' : '');
  const fig = (v, l, href) => `<div><dd>${href && v ? `<a href="${href}">${v}</a>` : v}</dd><dt>${l}</dt></div>`;

  // ---------- all companies ----------
  async function viewCompanies() {
    const live = App.drawing(); const r = await api('/api/companies'); if (!live()) return;
    const admin = S.me.role === 'admin';
    document.title = 'Companies · FleetHire';
    const card = (c) => `<a class="cocard k${c.color % 8}" href="#/company/${c.id}">
        <div class="cohead"><b>${esc(c.name)}</b><span class="small mut">${[c.mc ? 'MC ' + esc(c.mc) : '', c.dot ? 'DOT ' + esc(c.dot) : ''].filter(Boolean).join(', ') || 'No MC or DOT yet'}</span></div>
        <dl class="figs">${fig(c.trucks, plural(c.trucks, 'truck').replace(/^\d+ /, ''))}${fig(c.empty, 'empty')}${fig(c.withDriver, 'with a driver')}${c.outOfService ? fig(c.outOfService, 'out of service') : ''}</dl>
        <dl class="figs">${fig(c.onboarding, 'in onboarding')}${fig(c.hired, 'hired')}${fig(c.inProgress, 'leads in progress')}</dl></a>`;
    const loose = r.unassigned.trucks || r.unassigned.drivers ? `Not with any company yet: ${r.unassigned.trucks ? `<a href="#/trucks" data-act="trucksNoCo">${plural(r.unassigned.trucks, 'truck')}</a>` : ''}${r.unassigned.trucks && r.unassigned.drivers ? ' and ' : ''}${r.unassigned.drivers ? `<a href="#/leads?company=none&status=Onboarding">${plural(r.unassigned.drivers, 'driver')} in onboarding or hired</a>` : ''}` : '';
    view.innerHTML = header('companies') + `<main>
      ${App.pageHead('Companies', 'The carriers your team dispatches for.', admin ? `<button class="btn primary lg" data-act="coAdd">${App.plus} Add company</button>` : '')}
      ${r.companies.length ? `<div class="cogrid">${r.companies.map(card).join('')}</div>`
        : `<div class="emptycard"><div class="emptyart">${App.ART.carrier}<h2>No companies added yet</h2><p>Each truck belongs to a company, and drivers are assigned through their truck.</p>${admin ? `<button class="btn primary lg" data-act="coAdd">${App.plus} Add your first company</button>` : '<p>An admin adds the companies.</p>'}${loose ? `<div><span class="more">${loose}</span></div>` : ''}</div></div>`}
      ${r.companies.length && loose ? `<p class="hint foot">${loose}.</p>` : ''}
    </main>`;
  }

  // ---------- one company ----------
  let shown = null;
  async function viewCompany(id) {
    const live = App.drawing(); let r;
    try { r = await api('/api/companies/' + id); } catch (e) { if (live()) view.innerHTML = header('companies') + `<main><a class="back" href="#/companies">← Companies</a><div class="empty"><p>${esc(e.message)}</p></div></main>`; return; }
    if (!live()) return; shown = r; const c = r.company; const admin = S.me.role === 'admin';
    document.title = `${c.name} · FleetHire`;
    const n = (s) => r.trucks.filter((t) => t.state === s).length;
    const ds = (s) => r.drivers.filter((d) => d.status === s).length;
    const truckRow = (t) => `<tr data-truck="${t.id}"><td><b class="unit">${esc(t.unit)}</b></td><td>${esc(t.details || '') || '<span class="none">Not filled in</span>'}</td><td>${esc(t.location || '') || '<span class="none">Not filled in</span>'}</td>
      <td><span class="tstate ${t.state}">${STATE[t.state]}</span></td>
      <td>${t.driver ? `${t.driver.id ? `<a class="nml" href="#/driver/${t.driver.id}"><b>${esc(t.driver.name)}</b></a>` : `<b>${esc(t.driver.name)}</b>`} ${badge(t.driver.status)}` : t.driverName ? esc(t.driverName) : '<span class="none">Nobody</span>'}</td>
      ${admin ? '<td><button class="linkbtn" data-act="coTruckEdit">Edit</button></td>' : ''}</tr>`;
    const driverRow = (d) => `<tr><td>${d.id ? `<a class="nml" href="#/driver/${d.id}"><b>${esc(d.name)}</b></a>` : `<b>${esc(d.name)}</b>`}${d.phone ? `<div class="small"><a href="tel:${esc(d.phone)}">${esc(fmtPhone(d.phone))}</a></div>` : ''}</td>
      <td>${esc(one(d.mode)) || '<span class="none">Not set</span>'}</td><td>${badge(d.status)}</td>
      <td>${d.truck ? `Truck <b>${esc(d.truck)}</b>` : d.ownTruck ? `Own truck: ${esc(d.ownTruck)}` : '<span class="none">None yet</span>'}</td>
      <td class="small">${d.status === 'Hired' && d.hiredAt ? `Hired ${esc(dateText(dayOf(d.hiredAt)))}` : d.arrivedOn ? `Arrived ${esc(dateText(d.arrivedOn))}` : d.expectedArrival ? `Arriving ${esc(dateText(d.expectedArrival, { weekday: 'short' }))}` : ''}</td>
      <td class="small">${d.ownerId ? esc(person(d.ownerId)) : '<span class="none">Nobody</span>'}</td></tr>`;
    view.innerHTML = header('companies') + `<main>
      <a class="back" href="#/companies">← Companies</a>
      <section class="dhead cobar k${c.color % 8}"><div class="top"><div class="who"><h2>${esc(c.name)}</h2>
          <div class="sub">${[c.mc ? 'MC ' + esc(c.mc) : '', c.dot ? 'USDOT ' + esc(c.dot) : ''].filter(Boolean).join(', ') || 'No MC or DOT number yet'}</div>
          ${c.notes ? `<p class="conotes">${esc(c.notes)}</p>` : ''}</div>
        ${admin ? '<div class="acts"><button class="btn plain" data-act="coEdit">Edit company</button><button class="btn primary" data-act="coTruckAdd">Add truck</button></div>' : ''}</div></section>
      <section class="card"><dl class="figs wide">${fig(r.trucks.length, 'trucks')}${fig(n('empty'), 'empty trucks')}${fig(n('assigned'), 'with a driver')}${fig(n('out'), 'out of service')}
        ${fig(ds('Onboarding'), 'drivers in onboarding')}${fig(ds('Hired'), 'drivers hired')}${fig(r.drivers.length - ds('Onboarding') - ds('Hired'), 'other leads', `#/leads?company=${c.id}`)}</dl></section>
      <section class="card"><h3>Trucks</h3>${r.trucks.length ? `<div class="scroll"><table class="mini cotbl"><thead><tr><th>Unit</th><th>Truck</th><th>Where it is</th><th>Status</th><th>Driver</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>${r.trucks.map(truckRow).join('')}</tbody></table></div>`
        : `<p class="hint">No trucks for ${esc(c.name)} yet.${admin ? ' Add one here, or give an existing truck this company on the Trucks page.' : ''}</p>`}</section>
      <section class="card"><h3>Drivers</h3>${r.drivers.length ? `<div class="scroll"><table class="mini cotbl"><thead><tr><th>Driver</th><th>Type</th><th>Status</th><th>Truck</th><th>Arrival</th><th>Recruiter</th></tr></thead><tbody>${r.drivers.map(driverRow).join('')}</tbody></table></div>`
        : '<p class="hint">No drivers with this company yet. Pick the company on a driver\'s page, or give the driver one of this company\'s trucks during onboarding.</p>'}</section>
    </main>`;
  }

  // ---------- add or edit a company (admin) ----------
  function coDialog(c) {
    const color = c ? c.color % 8 : (S.me.companies || []).length % 8;
    dialog(`<form id="coForm" class="dform"><h2>${c ? 'Edit ' + esc(c.name) : 'Add a company'}</h2><div class="grid2">
        <label class="fld">Company name<input name="name" type="text" required maxlength="80" value="${esc(c ? c.name : '')}" placeholder="Bobtail Trucking LLC"></label>
        <div class="grid2 tight"><label class="fld">MC number<input name="mc" type="text" maxlength="20" value="${esc(c ? c.mc || '' : '')}"></label>
          <label class="fld">USDOT number<input name="dot" type="text" maxlength="20" value="${esc(c ? c.dot || '' : '')}"></label></div></div>
      <fieldset class="swatches"><legend>Tag color</legend>${COLOR_NAMES.map((nm, i) => `<label><input type="radio" name="color" value="${i}" ${i === color ? 'checked' : ''}><span class="co c${i}">${nm}</span></label>`).join('')}</fieldset>
      <label class="fld">Notes<textarea name="notes" maxlength="1000" placeholder="Insurance, ELD provider, who to call">${esc(c ? c.notes || '' : '')}</textarea></label>
      <p class="err" id="coErr" role="alert"></p>
      <div class="drow"><button class="btn primary">${c ? 'Save' : 'Add company'}</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button><span class="grow"></span>
        ${c ? '<button type="button" class="btn danger" id="coDelete">Remove company</button>' : ''}</div></form>`, (d) => {
      $('#coForm', d).onsubmit = async (e) => {
        e.preventDefault(); const b = Object.fromEntries(new FormData(e.target));
        try { const res = await api(c ? '/api/companies/' + c.id : '/api/companies', { method: c ? 'PATCH' : 'POST', body: b }); await App.reloadMe(); d.close(); toast(c ? 'Company saved' : 'Company added'); if (c) App.render(); else App.go('#/company/' + res.id); }
        catch (err) { $('#coErr').textContent = err.message; }
      };
      if ($('#coDelete')) $('#coDelete').onclick = async () => {
        if (!confirm(`Remove ${c.name}? Its trucks and drivers stay, without a company.`)) return;
        try { await api('/api/companies/' + c.id, { method: 'DELETE' }); await App.reloadMe(); d.close(); toast('Company removed'); App.go('#/companies'); } catch (err) { $('#coErr').textContent = err.message; }
      };
    });
  }
  on('coAdd', () => coDialog(null));
  on('coEdit', () => coDialog(shown.company));
  on('coTruckAdd', () => App.truckDialog(null, { companyId: shown.company.id }, App.render));
  on('coTruckEdit', (b) => App.truckDialog(shown.trucks.find((t) => t.id === +b.closest('[data-truck]').dataset.truck), {}, App.render));
  on('trucksNoCo', (b, e) => { e.preventDefault(); App.showTrucks('none'); });

  App.route(/^#\/companies$/, viewCompanies);
  App.route(/^#\/company\/(\d+)$/, (id) => viewCompany(+id));
})();
