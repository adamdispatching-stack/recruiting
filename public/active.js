// Active drivers: hired and still with us. CDL and medical card expiry, working period, and home time.
(() => {
  const { $, esc, view, S, api, toast, on, onChange, header, dialog, plural, person, dateText, dayOf, fmtPhone, today, addDays } = App;
  const SOON = 30; // days before an expiry date when it starts to need attention
  const one = (mode) => (mode === 'Owner-operators' ? 'Owner operator' : mode === 'Company drivers' ? 'Company driver' : '');
  const days = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5); // from a to b
  const long = (ymd) => dateText(ymd, { year: 'numeric' });
  // "3 weeks out, 4 days home"
  const periodText = (d) => [d.weeksOut ? `${plural(d.weeksOut, 'week')} out` : '', d.daysHome !== null && d.daysHome !== undefined ? `${plural(d.daysHome, 'day')} home` : ''].filter(Boolean).join(', ');
  App.periodText = periodText;

  // An expiry date: when, and how it stands today.
  function expiry(ymd, t) {
    if (!ymd) return { cls: 'missing', html: '<span class="none">Not entered</span>', state: 'missing' };
    const n = days(t, ymd);
    const state = n < 0 ? 'expired' : n <= SOON ? 'soon' : 'ok';
    const note = n < 0 ? `Expired ${plural(-n, 'day')} ago` : n === 0 ? 'Expires today' : n <= SOON ? `In ${plural(n, 'day')}` : '';
    return { state, html: `<b>${esc(long(ymd))}</b>${note ? `<span class="dtag ${n <= 0 ? 'bad' : 'warn'}">${note}</span>` : ''}` };
  }
  // Home time: out since a date, for so many weeks.
  function road(d, t) {
    if (!d.outSince) return { state: '', html: '<span class="none">Not entered</span>' };
    const on = days(d.outSince, t) + 1;
    if (!d.weeksOut) return { state: '', html: `Out since ${esc(dateText(d.outSince))}<div class="small mut">Day ${on}</div>` };
    const home = addDays(d.outSince, Math.round(d.weeksOut * 7)); const left = days(t, home);
    const state = left < 0 ? 'over' : left <= 3 ? 'due' : '';
    return { state, home, html: `Out since ${esc(dateText(d.outSince))}<div class="small ${state ? '' : 'mut'}">${left < 0 ? `<span class="dtag bad">Home time ${plural(-left, 'day')} overdue</span>` : left <= 3 ? `<span class="dtag warn">Due home ${left ? esc(dateText(home, { weekday: 'short' })) : 'today'}</span>` : `Due home ${esc(dateText(home, { weekday: 'short' }))}`}</div>` };
  }

  let filter = '', coFilter = '', data = null;
  const TGK = { dispatch: 'Dispatch', eld: 'ELD', accounting: 'Acct' };
  async function viewActive() {
    const live = App.drawing(); const r = await api('/api/active'); if (!live()) return; data = r;
    document.title = 'Active drivers · FleetHire';
    const t = r.today;
    const rows = r.drivers.map((d) => ({ d, cdl: expiry(d.cdlExpires, t), med: expiry(d.medExpires, t), road: road(d, t) }));
    const bad = (x) => ['expired', 'soon'].includes(x.cdl.state) || ['expired', 'soon'].includes(x.med.state);
    const missing = (x) => x.cdl.state === 'missing' || x.med.state === 'missing';
    const due = (x) => ['due', 'over'].includes(x.road.state);
    const inCo = (x) => !coFilter || (coFilter === 'none' ? !x.d.companyId : x.d.companyId === +coFilter);
    const tests = { '': () => true, expiring: bad, missing, home: due };
    const shown = rows.filter((x) => inCo(x) && tests[filter](x));
    const n = (f) => rows.filter((x) => inCo(x) && f(x)).length;
    const row = ({ d, cdl, med, road: rd }) => `<tr data-id="${d.id}">
      <td><a class="nml" href="#/driver/${d.id}"><b>${esc(d.name)}</b></a>${d.phone ? `<div class="small">${App.phone(d.phone, '')}</div>` : ''}<div class="small mut">${[esc(one(d.mode)), d.truck ? `truck ${d.truck.id ? `<a href="#/truck/${d.truck.id}"><b>${esc(d.truck.unit)}</b></a>` : `<b>${esc(d.truck.unit)}</b>`}` : d.ownTruck ? `own truck: ${esc(d.ownTruck)}` : 'no truck'].filter(Boolean).join(', ')}</div></td>
      <td>${App.coTag(d.companyId) || '<span class="none">Not assigned</span>'}</td>
      <td class="exp ${cdl.state}">${cdl.html}</td><td class="exp ${med.state}">${med.html}</td>
      <td>${esc(periodText(d)) || '<span class="none">Not entered</span>'}</td>
      <td>${rd.html}</td>
      <td class="small">${d.hiredAt ? esc(dateText(dayOf(d.hiredAt), { year: 'numeric' })) : ''}${d.ownerId ? `<div class="mut">${esc(person(d.ownerId))}</div>` : ''}</td>
      <td class="tgcell">${['dispatch', 'eld', 'accounting'].map((k) => (d.groups && d.groups[k] ? `<a class="tgdot on" href="#/telegram/${d.groups[k]}" title="${TGK[k]} group">${TGK[k]}</a>` : `<span class="tgdot" title="No ${TGK[k]} group yet: in Telegram, type register ${k} in it">${TGK[k]}</span>`)).join('')}</td>
      <td>${S.me.role === 'dispatcher' ? '' : '<button class="linkbtn" data-act="activeEdit">Edit</button>'}</td></tr>`;
    const seg = [['', `All ${n(() => true)}`], ['expiring', `Expiring ${n(bad)}`], ['missing', `Dates missing ${n(missing)}`], ['home', `Due home ${n(due)}`]];
    view.innerHTML = header('active') + `<main>${App.pageHead('Active drivers', 'Hired drivers on the road: their documents, working period and home time.')}
      <div class="tiles">${App.tile('wheel', n(() => true), 'active drivers', { on: !filter, href: '#/active' })}
        ${App.tile('warn', n((x) => x.cdl.state === 'expired' || x.med.state === 'expired'), 'with an expired CDL or medical card', { tone: n((x) => x.cdl.state === 'expired' || x.med.state === 'expired') ? 'r' : '' })}
        ${App.tile('cal', n((x) => x.cdl.state === 'soon'), `CDLs expiring in ${SOON} days`, { tone: n((x) => x.cdl.state === 'soon') ? 'y' : '' })}
        ${App.tile('clip', n((x) => x.med.state === 'soon'), `medical cards expiring in ${SOON} days`, { tone: n((x) => x.med.state === 'soon') ? 'y' : '' })}
        ${App.tile('people', n(due), 'due home in 3 days or overdue')}</div>
      <div class="pagebar"><div class="seg" role="group" aria-label="Show">${seg.map(([k, l]) => `<button data-act="activeFilter" data-k="${k}" class="${filter === k ? 'on' : ''}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>
        ${(S.me.companies || []).length ? `<select class="pick line" data-ch="activeCo" aria-label="Company"><option value="">All companies</option>${S.me.companies.map((c) => `<option value="${c.id}" ${String(c.id) === coFilter ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="none" ${coFilter === 'none' ? 'selected' : ''}>No company</option></select>` : ''}
        <span class="grow"></span></div>
      ${r.drivers.length ? `<div class="sheet"><table class="active"><colgroup><col><col style="width:140px"><col style="width:140px"><col style="width:140px"><col style="width:130px"><col style="width:160px"><col style="width:110px"><col style="width:100px"><col style="width:50px"></colgroup>
        <thead><tr><th>Driver</th><th>Company</th><th>CDL expires</th><th>Medical card expires</th><th>Working period</th><th>On the road</th><th>Hired</th><th>Telegram</th><th></th></tr></thead>
        <tbody>${shown.map(row).join('') || '<tr><td colspan="9" class="none" style="padding:24px;text-align:center">No drivers in this group.</td></tr>'}</tbody></table></div>
        <p class="hint foot">Dates turn yellow ${SOON} days before they expire and red once expired. Enter only the expiry dates here, never license numbers. A driver is listed here once marked hired.</p>`
        : '<div class="empty"><p>No active drivers yet.</p>Drivers appear here once they are marked hired at the end of onboarding.</div>'}
      ${r.left.length ? `<section class="card" style="margin-top:14px"><h3>Left in the last 6 months</h3><ul class="list">${r.left.map((d) => `<li data-id="${d.id}"><span class="grow"><a class="nml" href="#/driver/${d.id}"><b>${esc(d.name)}</b></a> ${App.coTag(d.companyId)}
          <span class="small mut">left ${esc(long(d.leftOn))}${d.leftReason ? `: ${esc(d.leftReason)}` : ''}</span></span><button class="btn plain sm" data-act="activeBack">Active again</button></li>`).join('')}</ul></section>` : ''}
    </main>`;
  }
  on('activeFilter', (b) => { filter = b.dataset.k; viewActive(); });
  onChange('activeCo', (el) => { coFilter = el.value; viewActive(); });
  on('activeEdit', (b) => activeDialog(data.drivers.find((d) => d.id === +b.closest('[data-id]').dataset.id), viewActive));
  on('activeBack', async (b) => { await api('/api/drivers/' + b.closest('[data-id]').dataset.id, { method: 'PATCH', body: { leftOn: null } }); toast('Back on the active list'); viewActive(); });

  // Documents, working period and home time for one driver (this page and the driver's own page).
  function activeDialog(d, after) {
    const t = today();
    dialog(`<form id="actForm" class="dform"><h2>${esc(d.name)}</h2>
      <h3 class="fsub first">Documents</h3><div class="grid2">
        <label class="fld">CDL expires<input name="cdlExpires" type="date" value="${esc(d.cdlExpires || '')}"></label>
        <label class="fld">Medical card expires<input name="medExpires" type="date" value="${esc(d.medExpires || '')}"></label></div>
      <p class="hint" style="margin-top:-4px">Only the expiry dates. Never type license numbers here.</p>
      <h3 class="fsub">Working period</h3><div class="grid2">
        <label class="fld">Weeks out before going home<input name="weeksOut" type="number" min="0.5" max="26" step="0.5" value="${d.weeksOut ?? ''}" placeholder="e.g. 3"></label>
        <label class="fld">Days home<input name="daysHome" type="number" min="0" max="60" step="1" value="${d.daysHome ?? ''}" placeholder="e.g. 4"></label>
        <label class="fld">Out on the road since<span class="inrow"><input name="outSince" type="date" value="${esc(d.outSince || '')}" max="${t}"><button type="button" class="btn plain sm" data-act="outToday">Today</button></span></label></div>
      <p class="err" id="actErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div>
      <details class="leftbox"><summary>The driver left the company</summary>
        <div class="form" style="margin-top:10px"><label class="fld">Left on<input id="leftOn" type="date" value="${t}" max="${t}"></label>
          <label class="fld">Why<input id="leftWhy" type="text" maxlength="200" placeholder="Quit, let go, moved to another carrier" list="leftReasons"></label>
          <datalist id="leftReasons"><option value="Quit"><option value="Let go"><option value="Went to another carrier"><option value="Home time"><option value="Pay"><option value="Truck issues"></datalist>
          <button type="button" class="btn danger" data-act="markLeft">Mark as left</button></div>
        <p class="hint">They leave this list and keep their history. A truck from the fleet is freed.</p></details></form>`, (dl) => {
      $('#actForm', dl).onsubmit = async (e) => {
        e.preventDefault(); const body = Object.fromEntries(new FormData(e.target));
        try { await api('/api/drivers/' + d.id, { method: 'PATCH', body }); dl.close(); toast('Saved'); after(); } catch (err) { $('#actErr').textContent = err.message; }
      };
      dl.leftFor = { d, after };
    });
  }
  App.activeDialog = activeDialog;
  on('outToday', () => { const i = $('#actForm [name=outSince]'); if (i) i.value = today(); });
  on('markLeft', async () => {
    const dl = $('#dlg'); const { d, after } = dl.leftFor;
    if (!confirm(`Mark ${d.name} as left on ${long($('#leftOn').value)}?`)) return;
    try { await api('/api/drivers/' + d.id, { method: 'PATCH', body: { leftOn: $('#leftOn').value, leftReason: $('#leftWhy').value } }); dl.close(); toast('Marked as left'); after(); } catch (err) { $('#actErr').textContent = err.message; }
  });

  App.route(/^#\/active$/, viewActive);
})();
