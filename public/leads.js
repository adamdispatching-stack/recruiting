// Leads: the list with filters, adding a lead by hand, and one driver's page (notes, contact log, onboarding).
(() => {
  const { $, $$, esc, view, S, api, toast, fail, go, on, onChange, redraw, header, badge, fmtPhone, when, shortWhen, today, addDays, dateText, dayOf, fuText, person, hasAccess, dialog, plural } = App;
  const SHORT = { 'Declined on Indeed': 'Declined' };
  const LABELS = { cdl: 'License', qualify: 'CDL and record', qualifyNote: 'Screening', endorsements: 'Endorsements', freight: 'Freight hauled', relay: 'Amazon Relay', relayApp: 'Relay sign-up', telegram: 'Telegram', equipment: 'Truck', currentJob: 'Working now', availability: 'Can start', interest: 'Interest', lookingFor: 'Looking for', homeTimeWanted: 'Home time', payExpectation: 'Pay wanted', home: 'Home', declineReason: 'Declined because', notes: 'Other details', fullName: 'Full name', zip: 'Zip' };
  const label = (k) => LABELS[k] || k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  const ICON_SEARCH = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.6 10.6 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const relayTag = (v) => (v === true ? '<span class="rbtag yes">Yes</span>' : v === false ? '<span class="rbtag no">No</span>' : '<span class="none">Not asked</span>');
  const one = (mode) => (mode || '').replace(/s$/, '').replace('Owner-operator', 'Owner operator');
  const people = () => S.me.people.filter((p) => p.active && p.role !== 'dispatcher');

  // ---------- the list ----------
  const FILTERS = ['q', 'status', 'account', 'mode', 'due', 'cold', 'working', 'owner', 'source', 'company'];
  const VIEWS = ['due', 'cold', 'working']; // work lists on the status strip; one chip is on at a time
  const list = { q: '', status: '', account: '', mode: '', due: '', cold: '', working: '', owner: '', source: '', company: '', sort: 'updated', rows: [], total: 0, counts: [], accounts: [], sel: new Set() };

  async function load(more) {
    const p = new URLSearchParams({ q: list.q, status: list.status, account: list.account, mode: list.mode, due: list.due, cold: list.cold, working: list.working, owner: list.owner, source: list.source, company: list.company, sort: list.sort, limit: 100, offset: more ? list.rows.length : 0 });
    const r = await api('/api/drivers?' + p);
    list.rows = more ? list.rows.concat(r.drivers) : r.drivers; list.total = r.total; list.counts = r.counts; list.accounts = r.accounts;
    if (!more) list.sel.clear();
  }
  // a recruiter starts on their own leads; the default is set once per sign-in, so a filter they pick sticks
  let ownerDefaultFor = null;
  const myDefault = () => (S.me.role === 'admin' ? '' : 'me');
  async function viewLeads(params) {
    document.title = 'Leads · FleetHire';
    if (ownerDefaultFor !== S.me.id) { ownerDefaultFor = S.me.id; FILTERS.forEach((k) => { list[k] = ''; }); list.owner = myDefault(); }
    if ([...params.keys()].length) { // a link from the dashboard, like "follow-ups due"
      FILTERS.forEach((k) => { list[k] = ''; });
      for (const [k, v] of params) if (FILTERS.includes(k)) list[k] = v;
      history.replaceState(null, '', '#/leads');
    }
    view.innerHTML = header('leads') + `<main>${App.pageHead('Driver leads', 'Track and move driver candidates from first contact to hire.', `<button class="btn primary lg" data-act="addLead">${App.plus} Add lead</button>`)}
      <section class="fcard" aria-label="Filters"><div class="tools">
        <label class="search">${ICON_SEARCH}<input id="q" type="search" placeholder="Search name, phone, email, city, notes" aria-label="Search leads"></label>
        <select id="fOwner" class="pick" aria-label="Recruiter">${S.me.role === 'admin' ? '<option value="">All recruiters</option><option value="me">My leads</option>' : '<option value="me">My leads</option><option value="">All recruiters</option>'}<option value="none">No recruiter</option>${S.me.people.filter((p) => p.id !== S.me.id).map((p) => `<option value="${p.id}">${esc(p.name)}${p.active ? '' : ' (no access)'}</option>`).join('')}</select>
        <select id="fSource" class="pick" aria-label="Source"><option value="">All sources</option>${S.me.sources.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
        <select id="fAcct" class="pick" aria-label="Indeed account" hidden></select>
        <select id="fMode" class="pick" aria-label="Driver type"><option value="">All types</option><option value="Company drivers">Company drivers</option><option value="Owner-operators">Owner operators</option></select>
        ${(S.me.companies || []).length ? `<select id="fCo" class="pick" aria-label="Company"><option value="">All companies</option>${S.me.companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}<option value="none">No company</option></select>` : ''}
        <select id="fSort" class="pick" aria-label="Sort"><option value="updated">Newest activity</option><option value="followup">Follow-up date</option><option value="name">Name A to Z</option><option value="created">Newest added</option></select>
        </div>
      <nav id="route" class="route" aria-label="Filter by status"></nav></section><div id="bulk" class="bulk" hidden></div><div id="lst"></div></main>`;
    $('#q').value = list.q; $('#fMode').value = list.mode; $('#fSort').value = list.sort; $('#fOwner').value = list.owner; $('#fSource').value = list.source;
    let t; $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { list.q = e.target.value; refresh(); }, 250); };
    if ($('#fCo')) $('#fCo').value = list.company;
    for (const [id, key] of [['fAcct', 'account'], ['fMode', 'mode'], ['fSort', 'sort'], ['fOwner', 'owner'], ['fSource', 'source'], ['fCo', 'company']]) if ($('#' + id)) $('#' + id).onchange = (e) => { list[key] = e.target.value; refresh(); };
    await refresh();
  }
  // A small team's list stays short at first: invite them to add the next driver.
  const addMoreArt = () => `<div class="emptyart">${App.ART.truck}<h2>Your next great driver is one conversation away.</h2><p>Add a lead to start recruiting, track their progress, and move them toward hire.</p><button class="btn primary lg" data-act="addLead">${App.plus} Add a lead</button></div>`;
  async function refresh(more) {
    const live = App.drawing();
    try { await load(more); } catch (e) { return fail(e); }
    if (!live() || !$('#lst')) return;
    const admin = S.me.role === 'admin';
    const c = Object.fromEntries(list.counts.map((x) => [x.status, x.n])); const sum = (k) => list.counts.reduce((a, x) => a + x[k], 0);
    const plain = !VIEWS.some((v) => list[v]);
    const stop = (s, ring) => `<button class="stop${plain && list.status === s ? ' on' : ''}${c[s] ? '' : ' zero'}" data-f="${esc(s)}">${ring ? '<i></i>' : ''}<span>${esc(SHORT[s] || s)}</span><b>${c[s] || 0}</b></button>`;
    $('#route').innerHTML = `<div class="main"><button class="stop${plain && !list.status ? ' on' : ''}" data-f=""><span>All</span><b>${sum('n')}</b></button><ol>${S.me.route.map((s) => `<li>${stop(s, true)}</li>`).join('')}</ol></div>
      <div class="side">${S.me.other.map((s) => stop(s)).join('')}
        <button class="stop work${list.working ? ' on' : ''}" data-view="working" title="Leads someone should be working: ${esc(S.me.active.join(', '))}"><span>In progress</span><b>${sum('working')}</b></button>
        <button class="stop due${list.due ? ' on' : ''}" data-view="due" title="Leads whose follow-up date is today or earlier"><span>Follow-ups due</span><b>${sum('due')}</b></button>
        <button class="stop due${list.cold ? ' on' : ''}" data-view="cold" title="Leads in progress with no follow-up date and nothing new for ${S.me.coldDays} days"><span>Going cold</span><b>${sum('cold')}</b></button></div>`;
    const acc = $('#fAcct'); acc.hidden = list.accounts.length < 2 && !list.account;
    acc.innerHTML = '<option value="">All Indeed accounts</option>' + list.accounts.map((a) => `<option ${a === list.account ? 'selected' : ''}>${esc(a)}</option>`).join('');
    const t = today();
    const rows = list.rows.map((d) => {
      const contact = (d.phones || []).map((p) => App.phone(p)).join('') + (d.emails || []).slice(0, 1).map((e) => `<a class="em" href="mailto:${esc(e)}">${esc(e)}</a>`).join('');
      const note = d.redFlags ? `<span class="k flag">Flag</span>${esc(d.redFlags)}` : d.lastNote ? `<span class="k you">Note</span>${esc(d.lastNote)}` : d.aiSummary ? `<span class="k ai">AI</span>${esc(d.aiSummary)}` : '';
      const isDue = d.followUp && d.followUp <= t;
      const where = [one(d.mode), d.location || (d.answers || {}).home].filter(Boolean).map(esc).join(', ');
      return `<tr data-id="${d.id}">${admin ? `<td class="cb"><input type="checkbox" data-sel="${d.id}" ${list.sel.has(d.id) ? 'checked' : ''} aria-label="Select ${esc(d.name)}"></td>` : ''}
        <td><div class="who1">${App.avatar(d.name)}<div><div class="nm"><a href="#/driver/${d.id}">${esc(d.name)}</a></div><div class="type">${where || '<span class="none">No details yet</span>'}</div></div></div></td>
        <td>${badge(d.status)}${d.amazonStep === 'verified' ? '<span class="azv xs">✓ Amazon</span>' : ''}<div class="small fuline">${d.followUp ? `Follow up <span class="fu${isDue ? ' due' : ''}">${esc(fuText(d.followUp))}</span>` : d.cold ? '<span class="coldtag">Going cold</span>' : ''}</div><div class="small mut upd" title="Last change ${esc(when(d.updatedAt))}">Updated ${esc(shortWhen(d.updatedAt))}</div></td>
        <td><div class="note1 clamp">${note || '<span class="none">No notes</span>'}</div>${d.noteCount ? `<div class="small mut">${plural(d.noteCount, 'note')}</div>` : ''}</td>
        <td>${contact || '<span class="none">No contact yet</span>'}</td>
        <td>${relayTag(d.relayBefore)}</td>
        <td>${esc(d.source || '') || '<span class="none">Not set</span>'}${d.sourceDetail || d.account ? `<div class="small mut clamp1">${esc(d.sourceDetail && d.source !== 'Indeed' ? d.sourceDetail : d.account || d.sourceDetail)}</div>` : ''}</td>
        <td>${App.coTag(d.companyId) || '<span class="none">Not assigned</span>'}</td>
        <td>${admin ? App.assignPick(d) : d.ownerId ? (hasAccess(d.ownerId) ? esc(person(d.ownerId)) : `<span class="none" title="This person no longer has access. An admin will give the lead to someone else.">${esc(person(d.ownerId))}, no access</span>`) : '<span class="none">Nobody yet</span>'}</td>
        </tr>`;
    }).join('');
    const any = sum('n');
    $('#lst').innerHTML = list.rows.length ? `<div class="sheet"><table class="leads"><colgroup>${admin ? '<col style="width:40px">' : ''}<col style="width:205px"><col style="width:150px"><col><col style="width:180px"><col style="width:115px"><col style="width:140px"><col style="width:190px"></colgroup>
        <thead><tr>${admin ? '<th class="cb"><input type="checkbox" id="selAll" aria-label="Select all shown"></th>' : ''}<th>Driver</th><th>Status, follow-up</th><th>Notes</th><th>Contact</th><th title="Has the driver run Amazon Relay loads before?">Relay before</th><th>Source</th><th>Company</th><th>Recruiter</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${list.rows.length < list.total ? `<button class="btn plain more" data-act="moreLeads">Show more (${list.total - list.rows.length} left)</button>` : ''}
        ${any < 5 && !list.q ? addMoreArt() : ''}`
      : S.me.role !== 'admin' && list.owner === 'me' && !(any || list.q || list.source || list.mode || list.account || list.company) ? '<div class="empty"><p>No leads are assigned to you yet. New leads are shared between recruiters as they come in.</p><button class="btn plain" data-act="allLeads">See all leads</button></div>'
      : (any || list.q || list.owner || list.source || list.mode || list.account || list.company ? '<div class="empty"><p>No leads match these filters.</p><button class="btn plain" data-act="clearFilters">Clear filters</button></div>' : addMoreArt());
    drawBulk();
  }
  function drawBulk() {
    const b = $('#bulk'); if (!b) return;
    b.hidden = !list.sel.size;
    if (list.sel.size) b.innerHTML = `<b>${plural(list.sel.size, 'lead')} selected</b><label>Give to <select id="bulkTo" class="pick line"><option value="">Choose a recruiter</option>${people().map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}<option value="none">Nobody (back to unassigned)</option></select></label>
      <button class="btn primary sm" data-act="bulkAssign">Assign</button><button class="btn plain sm" data-act="bulkClear">Clear selection</button>`;
    const all = $('#selAll'); if (all) all.checked = list.rows.length > 0 && list.rows.every((d) => list.sel.has(d.id));
  }
  document.addEventListener('click', (e) => {
    const stop = e.target.closest('.route .stop');
    if (stop) { // one chip at a time: a status, or one of the two work lists
      if (stop.dataset.view) { const on = !list[stop.dataset.view]; VIEWS.forEach((v) => { list[v] = ''; }); list.status = ''; list[stop.dataset.view] = on ? '1' : ''; }
      else { VIEWS.forEach((v) => { list[v] = ''; }); list.status = stop.dataset.f; }
      refresh(); return;
    }
    const row = e.target.closest('table.leads tbody tr[data-id]');
    if (row && !e.target.closest('a, input, button, select, label, .cb, .assign, .phw')) go('#/driver/' + row.dataset.id); // controls in a row never open the lead
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'selAll') { list.rows.forEach((d) => (e.target.checked ? list.sel.add(d.id) : list.sel.delete(d.id))); $$('[data-sel]').forEach((c) => { c.checked = e.target.checked; }); drawBulk(); }
    else if (e.target.dataset && e.target.dataset.sel) { const id = +e.target.dataset.sel; e.target.checked ? list.sel.add(id) : list.sel.delete(id); drawBulk(); }
  });
  on('moreLeads', () => refresh(true));
  on('allLeads', () => { list.owner = ''; go('#/leads'); });
  on('clearFilters', () => { FILTERS.forEach((k) => { list[k] = ''; }); list.owner = myDefault(); go('#/leads'); });
  on('bulkClear', () => { list.sel.clear(); $$('[data-sel]').forEach((c) => { c.checked = false; }); drawBulk(); });
  on('bulkAssign', async () => {
    const to = $('#bulkTo').value; if (!to) { toast('Choose who gets these leads', true); return; }
    const r = await api('/api/drivers/assign', { method: 'POST', body: { ids: [...list.sel], ownerId: to === 'none' ? null : +to } });
    toast(r.changed ? `${plural(r.changed, 'lead')} ${to === 'none' ? 'unassigned' : 'given to ' + person(+to)}` : 'Nothing to change'); refresh();
  });

  // ---------- add a lead ----------
  onChange('addMode', (el) => { const box = $('#ooTruck'); if (box) box.hidden = el.value !== 'Owner-operators'; });
  on('addLead', () => {
    const admin = S.me.role === 'admin';
    const yr = new Date().getFullYear();
    dialog(`<form id="addForm" class="dform addlead"><h2>Add a lead</h2>
      <fieldset class="typepick"><legend>Driver type</legend>
        <label><input type="radio" name="mode" value="Company drivers" required data-ch="addMode"><span><b>Company driver</b>Drives one of our trucks</span></label>
        <label><input type="radio" name="mode" value="Owner-operators" required data-ch="addMode"><span><b>Owner operator</b>Has their own truck</span></label></fieldset>
      <h3 class="fsub">Contact</h3>
      <div class="grid2">
        <label class="fld">Name<input name="name" type="text" required maxlength="120" autocomplete="off"></label>
        <label class="fld">Phone<input name="phone" type="tel" placeholder="10 digits" autocomplete="off"></label>
        <label class="fld">Email<input name="email" type="email" autocomplete="off"></label>
        <div class="grid2 tight"><label class="fld">Home city and state<input name="location" type="text" placeholder="Newark, NJ"></label>
          <label class="fld">Zip<input name="zip" type="text" inputmode="numeric" maxlength="10" placeholder="07102"></label></div>
      </div>
      <h3 class="fsub">Experience</h3>
      <div class="grid2">
        <label class="fld">Years driving with a CDL-A<input name="expYears" type="number" min="0" max="60" step="0.5" placeholder="e.g. 3"></label>
        <label class="fld">What they drove<input name="experience" type="text" maxlength="1000" placeholder="Dry van OTR, reefer, Amazon loads, past carriers"></label>
        <label class="fld">Ran Amazon Relay before?<select name="relayBefore"><option value="">Not asked yet</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        <label class="fld">Weeks out before going home<input name="weeksOut" type="number" min="0.5" max="26" step="0.5" placeholder="e.g. 3"></label>
        <label class="fld">Then days at home<input name="daysHome" type="number" min="0" max="60" step="1" placeholder="e.g. 4"></label>
      </div>
      <div id="ooTruck" hidden><h3 class="fsub">Their truck</h3><div class="grid2">
        <label class="fld">Year<input name="truckYear" type="number" min="1980" max="${yr + 1}" placeholder="${yr - 4}"></label>
        <label class="fld">Make and model<input name="truckModel" type="text" maxlength="80" placeholder="Freightliner Cascadia"></label></div></div>
      <h3 class="fsub">Lead</h3>
      <div class="grid2">
        <label class="fld">Where did this lead come from?<select name="source" required><option value="">Choose a source</option>${S.me.sources.map((s) => `<option>${esc(s)}</option>`).join('')}</select></label>
        <label class="fld">Source details<input name="sourceDetail" type="text" maxlength="200" placeholder="Which group, page or person"></label>
        <label class="fld">Company<select name="companyId">${App.coOptions(null, 'Not decided yet')}</select></label>
        <label class="fld">Status<select name="status">${['Replied', 'Interested', 'Email collected', 'Relay invite sent', 'Signed up on Relay', 'Review'].map((s) => `<option ${s === 'Interested' ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="fld">Follow up on<input name="followUp" type="date" min="${today()}"></label>
        ${admin ? `<label class="fld">Recruiter<select name="ownerId">${S.me.share ? '<option value="share" selected>Next in line (shared evenly)</option>' : ''}${people().map((p) => `<option value="${p.id}" ${!S.me.share && p.id === S.me.id ? 'selected' : ''}>${esc(p.name)}${p.id === S.me.id ? ' (you)' : ''}</option>`).join('')}<option value="">Nobody yet</option></select></label>` : ''}
      </div>
      <label class="fld">First note<textarea name="note" placeholder="What they said, what to do next"></textarea></label>
      <div id="dupBox"></div><p class="err" id="addErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Add lead</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
      const f = $('#addForm', d); let force = false;
      f.onsubmit = async (e) => {
        e.preventDefault(); const body = Object.fromEntries(new FormData(f)); if (force) body.force = true;
        body.companyId = body.companyId ? +body.companyId : null;
        if (admin) body.ownerId = body.ownerId === 'share' ? 'share' : body.ownerId ? +body.ownerId : null;
        $('#addErr').textContent = ''; $('#dupBox').innerHTML = '';
        try { const r = await api('/api/drivers', { method: 'POST', body }); d.close(); toast('Lead added'); go('#/driver/' + r.id); }
        catch (err) {
          if (err.status !== 409) { $('#addErr').textContent = err.message; return; }
          const x = err.data;
          $('#dupBox').innerHTML = `<div class="flagbox"><span><b>${esc(x.error)}.</b> ${x.duplicates.map((p) => `${p.id ? `<a href="#/driver/${p.id}" data-act="closeDialog">${esc(p.name)}</a>` : esc(p.name)} (${esc(p.status)}${p.owner ? `, ${esc(p.owner)}'s lead` : ', no recruiter yet'})`).join('; ')}
            ${x.canForce ? '<br><button type="button" class="linkbtn" id="forceAdd">It is a different person. Add anyway.</button>' : '<br>Open that lead instead of adding it again.'}</span></div>`;
          const fb = $('#forceAdd'); if (fb) fb.onclick = () => { force = true; f.requestSubmit(); };
        }
      };
    });
  });

  // ---------- one driver ----------
  let cur = null;
  const CONTACT_TEXT = (n) => (n.kind === 'call' ? `Call, ${String(n.outcome || '').toLowerCase()}` : n.kind === 'text' ? 'Text sent' : 'Email sent');
  const AUTO = { truck: 'Ticks itself when a truck is chosen', arrival: 'Ticks itself when the expected arrival is set', arrived: 'Ticks itself when the arrival date is filled in', amazon: 'Ticks itself when the Amazon steps reach Verified' };
  function convoHtml(c) {
    return String(c || '').split('\n').filter((l) => l.trim()).map((l) => {
      if (l.startsWith('Dispatch: ')) return `<div class="msg d"><span class="w">Dispatch</span>${esc(l.slice(10))}</div>`;
      if (l.startsWith('Driver: ')) return `<div class="msg c"><span class="w">Driver</span>${esc(l.slice(8))}</div>`;
      return `<div class="msg s">${esc(l.replace(/^\[(Indeed|On screen): /, '').replace(/\]$/, ''))}</div>`;
    }).join('');
  }
  const stepHtml = (i) => {
    const locked = !!AUTO[i.auto];
    return `<li class="step${i.done ? ' done' : ''}" data-step="${i.id}">
      <label class="chk"><input type="checkbox" data-ch="step" data-fk="s${i.id}" ${i.done ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>${esc(i.label)}</span></label>
      <span class="smeta">${i.done && i.doneAt ? `${i.doneBy ? esc(i.doneBy) + ', ' : ''}${esc(dateText(dayOf(i.doneAt)))}` : locked ? AUTO[i.auto] : ''}</span>
      <span class="sacts"><button class="linkbtn" data-act="stepNote">${i.note ? 'Edit note' : 'Add note'}</button>${i.custom ? '<button class="linkbtn red" data-act="delStep">Remove</button>' : ''}</span>
      ${i.note ? `<div class="snote">${esc(i.note)}</div>` : ''}${i.key === 'bank' ? '<div class="snote hint">Tick only. Never type account or routing numbers here.</div>' : ''}</li>`;
  };
  // Trucks to pick from, by company: the driver's own company first, then the others, then trucks of no company.
  function truckGroups(trucks, coId) {
    const groups = new Map();
    for (const t of trucks) { const k = t.companyId || 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
    return [...groups.entries()].sort(([a], [b]) => (a === coId ? -1 : b === coId ? 1 : !a ? 1 : !b ? -1 : 0))
      .map(([k, list]) => [k ? (App.company(k) || { name: 'Company' }).name + (k === coId ? " (this driver's company)" : '') : 'No company', list]);
  }
  // A hired driver: documents and home time (edited in the same window as on the Active drivers page)
  function activeCard(d) {
    const long = (v) => (v ? esc(dateText(v, { year: 'numeric' })) : '<span class="none">Not entered</span>');
    const t = today(); const soon = (v) => v && v <= addDays(t, 30);
    const due = d.outSince && d.weeksOut ? addDays(d.outSince, Math.round(d.weeksOut * 7)) : null;
    return `<section class="card"><h3>${d.leftOn ? 'Left the company' : 'Active driver'}<span class="grow"></span><button class="linkbtn" data-act="activeHere">Edit</button></h3>
      ${d.leftOn ? `<p class="hint" style="margin:0 0 8px">Left ${long(d.leftOn)}${d.leftReason ? `: ${esc(d.leftReason)}` : ''}. <button class="linkbtn" data-act="activeAgain">Active again</button></p>` : ''}
      <dl class="facts"><dt>CDL expires</dt><dd class="${soon(d.cdlExpires) ? 'warnv' : ''}">${long(d.cdlExpires)}</dd><dt>Medical card expires</dt><dd class="${soon(d.medExpires) ? 'warnv' : ''}">${long(d.medExpires)}</dd>
        <dt>Working period</dt><dd>${esc(App.periodText(d)) || '<span class="none">Not entered</span>'}</dd>
        <dt>On the road</dt><dd>${d.outSince ? `Since ${esc(dateText(d.outSince))}${due ? `, due home ${esc(dateText(due, { weekday: 'short' }))}` : ''}` : '<span class="none">Not entered</span>'}</dd></dl></section>`;
  }
  on('activeHere', () => App.activeDialog(cur.driver, again));
  on('activeAgain', () => patch({ leftOn: null }, 'Back on the active list'));
  // ---------- call guide: what to find out on the next call, what to mention, the next step ----------
  const REGION = ['MD', 'PA', 'NJ', 'DE', 'VA'];
  const FAR = ['FL', 'TX', 'NM', 'AZ', 'CA', 'NV', 'UT', 'CO', 'WA', 'OR', 'ID', 'MT', 'WY', 'ND', 'SD', 'NE', 'KS', 'OK', 'LA', 'AR', 'MS', 'AL', 'MN', 'IA', 'MO'];
  const stateOf = (d) => (String(d.location || '').toUpperCase().match(/\b([A-Z]{2})\b[\s,]*\d{0,5}\s*$/) || [])[1] || '';
  const homeTime = (d) => {
    if (d.mode === 'Owner-operators') return '';
    const st = stateOf(d); if (!st) return '';
    if (REGION.includes(st)) return `Lives in ${st}: 2 weeks out, then a long weekend home. If a load ends near home during the 2 weeks, they can sleep at home and roll by 8 AM.`;
    if (FAR.includes(st)) return `Lives in ${st}: 4 to 5 weeks out, and we buy the flight home and back.`;
    return `Lives in ${st}: 3 weeks out, 1 week home.`;
  };
  // answers typed in call notes ("Start date: next Monday") count as known
  const noted = (notes) => { const m = {}; (notes || []).forEach((n) => String(n.body || '').split('\n').forEach((l) => { const x = l.match(/^\s*([^:]{3,40}):\s*(\S.*)$/); if (x) m[x[1].trim().toLowerCase()] = x[2].trim(); })); return m; };
  function callQuestions(d, ob, notes) {
    const a = d.answers || {}; const fromNotes = noted(notes); const st = d.status || 'Invited'; const oo = d.mode === 'Owner-operators';
    const idx = S.me.route.indexOf(st); const at = (s) => idx >= S.me.route.indexOf(s);
    const has = (...xs) => xs.some((x) => x !== undefined && x !== null && String(x).trim() !== '');
    const Q = [];
    const add = (known, label, ask, why) => Q.push({ known: !!known || !!fromNotes[label.toLowerCase()], label, ask, why, answer: fromNotes[label.toLowerCase()] || '' });
    if (st === 'Onboarding') {
      add(ob && ob.expectedArrival, 'Arrival day', 'Which day and time can you be at the truck?', 'The truck earns from the day they arrive');
      add(d.medExpires, 'Medical card expires', 'When does your medical card expire? Can you text me a photo with your CDL?', 'We need both before day one');
      add(a.telegram, 'Telegram installed', 'Is Telegram installed with this number? That is where dispatch and accounting reach you.', 'All loads and pay go through it');
      add(a.travel, 'Travel to the truck', 'Which airport or bus station is closest to you?', 'We book the trip to the truck');
      return Q;
    }
    add(a.availability, 'Start date', 'When can you start? Could you get to the truck this week or next?', 'The sooner they start, the sooner the truck earns');
    add(has(d.expYears, a.qualify, a.cdl), 'CDL-A years and record', 'How long have you had your CDL-A? Any accidents, tickets or DUIs in the last 3 years?', 'Insurance reviews every record');
    add(has(d.location, d.zip, a.home, a.zip), 'Home city and zip', 'Where do you live? City and zip?', 'Decides home time and which dealership picks up the truck');
    add(has(d.weeksOut, a.homeTime, a.home_time_wanted), 'Weeks out / days home', 'How long can you stay out before going home, and how many days home do you need?', 'Matches them to the rotation');
    if (oo) {
      add(has(d.truckModel, d.truckYear, a.equipment), 'Truck year, make, model', 'What truck do you run? Year, make and model? Your own authority or leasing on?', 'Decides lease-on paperwork');
      add(a.insurance, 'Insurance and ELD', 'Do you have your own insurance and ELD, or do you want ours?', 'Insurance is the biggest cost for them');
    } else {
      add(has(d.experience, a.freight), 'Hauled before', 'What have you hauled? Any drop and hook, intermodal or rail yard work?', 'Most loads start at rail yards');
    }
    add(a.relay || (d.relayBefore !== null && d.relayBefore !== undefined), 'Amazon Relay before', 'Have you run Amazon Relay loads before?', 'Relay drivers start faster');
    add(d.medExpires || a.medical, 'Medical card expires', 'Is your medical card current? When does it expire?', 'Cannot drive without it');
    add(has(a.currentJob, a.current_job), 'Working now, notice', 'Are you working now? How much notice do you need to give?', 'Tells you their real start date');
    add(has(a.pay, a.payExpectation, a.pay_expectation), 'Weekly pay needed', 'What do you need to make a week?', 'Check it fits before going further');
    if (!at('Relay invite sent')) add((d.emails || []).length, 'Email for Relay invite', 'What is the best email for the Amazon Relay invite?', 'Amazon runs its own background check from it');
    if (st === 'Relay invite sent') add(false, 'Relay sign-up done', 'Did the Amazon Relay invite arrive? Have you finished signing up?', 'The only wait that is out of our hands');
    if (at('Email collected')) add(a.drug, 'Drug test, Clearinghouse', 'Any reason you could not pass a DOT drug test? Anything on the Clearinghouse?', 'Federal rules apply');
    if (at('Signed up on Relay')) add(a.docs, 'CDL and medical card photos', 'Can you text me photos of your CDL and medical card today?', 'First onboarding step');
    if (at('Relay invite sent')) add(a.telegram, 'Telegram installed', 'Is Telegram installed with this number?', 'Dispatch, accounting and ELD all run on it');
    return Q;
  }
  const NEXT = {
    Invited: 'They have not replied on Indeed yet. If you have a number, call: qualify them and get an email for the Relay invite.',
    Replied: 'Qualify them on the call, then get their email for the Amazon Relay invite.',
    Interested: 'Get their email and send the Amazon Relay invite today.',
    'Email collected': 'Send the Relay invite, set the status to Relay invite sent, and set a follow-up for tomorrow.',
    'Relay invite sent': 'Make sure they finished the Relay sign-up. Help with any step they are stuck on.',
    'Signed up on Relay': 'Get photos of their CDL and medical card, then start onboarding and set an arrival date.',
    Onboarding: 'Confirm the arrival day and the truck, and work through the checklist.',
    Review: 'Read the chat, decide, and call them with an answer.',
    Stalled: 'Find out what is holding them back, and set a follow-up date.',
    'Not interested': 'Ask what would change their mind, and note what they are looking for.',
    'No CDL': 'Note when they expect their CDL-A, and set a follow-up for then.'
  };
  function callGuide(d, ob, notes) {
    if (d.status === 'Hired' || d.leftOn) return '';
    const Q = callQuestions(d, ob, notes); const heard = Q.filter((x) => x.answer); const open = Q.filter((x) => !x.known); const known = Q.length - open.length;
    const oo = d.mode === 'Owner-operators';
    const pts = [homeTime(d), ...((S.me.callPoints || {})[oo ? 'owner' : 'company'] || [])].filter(Boolean);
    const first = esc(String(d.name || '').split(/\s+/)[0]);
    const facts = [one(d.mode), d.location, d.expYears !== null && d.expYears !== undefined ? `${plural(d.expYears, 'year')} CDL-A` : '', App.periodText(d), oo && (d.truckYear || d.truckModel) ? `${[d.truckYear, d.truckModel].filter(Boolean).join(' ')}` : ''].filter(Boolean).map(esc).join(', ');
    const p = d.callPrep;
    const ai = S.me.ai ? `<div class="cgai"><div class="cgaih"><b>AI suggestions</b><span class="grow"></span><button class="btn plain sm" data-act="callPrep">${p ? 'Refresh' : 'Get AI suggestions'}</button></div>
        ${p ? `${p.opener ? `<p><span class="mut">Open with:</span> ${esc(p.opener)}</p>` : ''}<ol class="qs">${p.questions.map((x) => `<li><b>${esc(x.ask)}</b><span>${esc(x.why)}</span></li>`).join('')}</ol>
        ${p.watchOut ? `<p class="cgwarn"><b>Watch out:</b> ${esc(p.watchOut)}</p>` : ''}${p.close ? `<p><b>Agree before you hang up:</b> ${esc(p.close)}</p>` : ''}<p class="small mut">Prepared ${esc(when(d.callPrepAt))}</p>`
        : '<p class="small mut">Suggestions written for this driver from everything on the lead: what to ask first, what to watch out for, and how to close.</p>'}</div>` : '';
    return `<section class="card callg" aria-labelledby="cgH"><h3 id="cgH">Call guide<span class="cgpill${open.length ? '' : ' full'}">${known} of ${Q.length} known</span><span class="grow"></span>${open.length ? '<button class="btn primary sm" data-act="callNotes">Take call notes</button>' : ''}</h3>
      <p class="cgwho">Before you call ${first}: ${facts || 'nothing known yet besides the name'}.</p>
      ${heard.length ? `<p class="cgheard"><b>From your call notes:</b> ${heard.map((x) => `${esc(x.label)}: ${esc(x.answer)}`).join('; ')}</p>` : ''}
      ${d.redFlags ? `<p class="cgwarn"><b>Watch out:</b> ${esc(d.redFlags)}</p>` : ''}
      <div class="cg2"><div><h4>Find out on this call</h4>${open.length ? `<ol class="qs">${open.slice(0, 7).map((x) => `<li><b>${esc(x.ask)}</b><span>${esc(x.why)}</span></li>`).join('')}</ol>${open.length > 7 ? `<p class="small mut">${open.length - 7} more after these.</p>` : ''}` : '<p class="small">Everything on the list is known. Use the call to agree the next step.</p>'}</div>
        <div><h4>Mention</h4><ul class="pts">${pts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>
      ${NEXT[d.status] ? `<p class="cgnext"><b>Next step:</b> ${esc(NEXT[d.status])}</p>` : ''}${ai}</section>`;
  }
  on('callNotes', () => {
    const t = $('#newNote'); if (!t || !cur) return;
    const open = callQuestions(cur.driver, cur.onboarding, cur.notes).filter((x) => !x.known);
    const tmpl = open.map((x) => `${x.label}: `).join('\n');
    t.value = (t.value.trim() ? t.value.trim() + '\n' : '') + tmpl; t.focus(); t.setSelectionRange(t.value.indexOf(': ') + 2, t.value.indexOf(': ') + 2);
    t.scrollIntoView({ block: 'center' }); toast('Fill in the answers, then save them with Called, talked');
  });
  on('callPrep', async (b) => {
    b.disabled = true; b.textContent = 'Preparing…';
    try { await api(`/api/drivers/${cur.driver.id}/callprep`, { method: 'POST' }); await again(); } catch (e) { fail(e); b.disabled = false; b.textContent = 'Try again'; }
  });
  const expText = (d) => [d.expYears !== null && d.expYears !== undefined ? `${plural(d.expYears, 'year')} with a CDL-A` : '', d.mode === 'Owner-operators' && (d.truckYear || d.truckModel) ? `own truck: ${[d.truckYear, d.truckModel].filter(Boolean).join(' ')}` : ''].filter(Boolean).join(', ');
  function onbCard(d, ob, needed = []) {
    const done = ob.items.filter((i) => i.done).length, total = ob.items.length, left = total - done;
    const trucks = (ob.truck ? [ob.truck] : []).concat(ob.freeTrucks);
    return `<section class="card onb" id="onb"><h3>Onboarding<span class="grow"></span><span class="prog"><b>${done} of ${total}</b> steps done<span class="meter"><i style="width:${total ? (done / total) * 100 : 0}%"></i></span></span></h3>
      ${needed.length ? `<div class="needbox" role="alert"><b>Needed now:</b> set the ${esc(needed.length < 2 ? needed[0] : needed.slice(0, -1).join(', ') + ' and ' + needed[needed.length - 1])}. ${needed.includes('arrival date') ? 'The driver is verified on Amazon, so plan the start date with them.' : 'The driver is verified on Amazon and starts within 3 days.'}${needed.includes('company') ? ' The company is set at the top of this page.' : ''}</div>` : ''}
      <p class="hint lead">Started ${esc(dateText(dayOf(ob.startedAt)))}${ob.startedBy ? ' by ' + esc(ob.startedBy) : ''}${ob.completedAt ? `. Hired ${esc(dateText(dayOf(ob.completedAt)))}.` : '.'}</p>
      <div class="tggroups" aria-live="polite"></div>
      <div class="ofields">
        <label class="fld">Truck<select data-ch="onbTruck" data-fk="truck"><option value="">No truck yet</option>${truckGroups(trucks, d.companyId).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((t) => `<option value="${t.id}" ${ob.truck && ob.truck.id === t.id ? 'selected' : ''}>${esc(t.unit)}${t.details ? ', ' + esc(t.details) : ''}${t.location ? ' (' + esc(t.location) + ')' : ''}</option>`).join('')}</optgroup>`).join('')}</select>
          ${!ob.truck ? `<span class="hint">${ob.freeTrucks.length ? plural(ob.freeTrucks.length, 'empty truck') + ' to choose from' : 'No empty trucks right now.'} <a href="#/trucks">See trucks</a></span>` : ''}</label>
        <label class="fld">Expected arrival<input type="date" data-ch="onbField" data-f="expectedArrival" data-fk="ea" value="${esc(ob.expectedArrival || '')}"></label>
        <label class="fld">Arrived on<input type="date" data-ch="onbField" data-f="arrivedOn" data-fk="ao" value="${esc(ob.arrivedOn || '')}"></label>
        <label class="fld wide">Arrival details<input type="text" data-ch="onbField" data-f="arrivalNote" data-fk="an" maxlength="500" placeholder="Flight or bus, pickup, hotel" value="${esc(ob.arrivalNote || '')}"></label>
        <label class="fld wide">Telegram onboarding group<span class="inrow"><input type="url" data-ch="onbField" data-f="telegramLink" data-fk="tg" placeholder="Paste the group's invite link, https://t.me/..." value="${esc(ob.telegramLink || '')}">${ob.telegramLink ? `<a class="btn plain" href="${esc(ob.telegramLink)}" target="_blank" rel="noopener noreferrer">Open group</a>` : ''}</span></label>
      </div>
      <ul class="steps">${ob.items.map(stepHtml).join('')}</ul>
      <form class="addstep" id="stepForm"><input type="text" name="label" maxlength="80" placeholder="Add a step only this driver needs" aria-label="New step" data-fk="newstep"><button class="btn plain sm">Add step</button></form>
      ${d.status === 'Onboarding' ? `<div class="orow"><button class="btn ${left ? 'plain' : 'primary'}" data-act="hire">Mark as hired</button><span class="hint">${left ? `${plural(left, 'step')} still open.` : 'Every step is done.'}</span></div>` : ''}
    </section>`;
  }
  async function viewDriver(id) {
    const live = App.drawing();
    let r; try { r = await api('/api/drivers/' + id); } catch (e) { if (live()) view.innerHTML = header('leads') + `<main><a class="back" href="#/leads">← Leads</a><div class="empty"><p>${esc(e.message)}</p></div></main>`; return; }
    if (!live()) return;
    const draft = cur && cur.driver.id === id && $('#newNote') ? $('#newNote').value : ''; // a half-written note survives a redraw
    cur = r; const d = r.driver, a = d.answers || {}, ob = r.onboarding, admin = S.me.role === 'admin', t = today();
    document.title = `${d.name} · FleetHire`;
    const answerKeys = Object.keys(LABELS).filter((k) => a[k]).concat(Object.keys(a).filter((k) => !(k in LABELS) && a[k]));
    const all = S.me.route.concat(S.me.other); const lostish = S.me.lost.concat('Stalled').includes(d.status);
    const owner = admin
      ? '' && `<label class="fld">Recruiter<select data-ch="owner" data-fk="owner"><option value="">Nobody yet</option>${S.me.people.filter((p) => p.active || p.id === d.ownerId).map((p) => `<option value="${p.id}" ${p.id === d.ownerId ? 'selected' : ''}>${esc(p.name)}${p.active ? '' : ' (no access)'}</option>`).join('')}</select></label>`
      : `<div class="fld">Recruiter<div class="ownerline">${d.ownerId && hasAccess(d.ownerId) ? `<b>${d.ownerId === S.me.id ? 'You' : esc(person(d.ownerId))}</b>`
        : `<span class="mut">${d.ownerId ? esc(person(d.ownerId)) + ', no access now' : 'Nobody yet'}. An admin assigns it.</span>`}</div></div>`;
    const IM = { pending: ['wait', 'Indeed message waiting for Chrome'], sending: ['wait', 'Sending on Indeed…'], sent: ['ok', 'Indeed message sent'], failed: ['bad', 'Indeed message not sent'] };
    const imHtml = (n) => (r.indeedMsgs || []).filter((m) => m.noteId === n.id).map((m) => `<div class="imsg ${IM[m.status][0]}" data-im="${m.id}" title="${esc(m.text)}"><span>${IM[m.status][1]}${m.status === 'sent' && m.doneAt ? ', ' + esc(when(m.doneAt)) : ''}${m.status === 'failed' && m.error ? `: ${esc(m.error)}` : ''}</span>
      ${m.status === 'failed' ? '<button type="button" class="linkbtn" data-act="imRetry">Try again</button>' : m.status === 'pending' ? '<button type="button" class="linkbtn" data-act="imStop">Don\'t send</button>' : ''}</div>`).join('');
    const noteHtml = (n) => `<li data-note="${n.id}"><div class="meta"><b>${esc(n.author)}</b>${n.kind ? `<span class="ck">${esc(CONTACT_TEXT(n))}</span>` : ''}${n.fromExtension ? '<span class="ext">from the extension</span>' : ''}<span class="grow">${esc(when(n.createdAt))}${n.updatedAt && new Date(n.updatedAt) - new Date(n.createdAt) > 60000 ? ', edited' : ''}</span>
      ${n.mine || admin ? '<button class="linkbtn" data-act="editNote">Edit</button><button class="linkbtn red" data-act="delNote">Delete</button>' : ''}</div><div class="body">${esc(n.body)}</div>${imHtml(n)}</li>`;
    const sourceLine = [d.source, d.sourceDetail].filter(Boolean).map(esc).join(', ');
    const onb = ob ? onbCard(d, ob, r.needed || []) : '';
    view.innerHTML = header('leads') + `<main>
      <a class="back" href="#/leads">← Leads</a>
      <section class="dhead">
        <div class="top">
          <div class="who"><h2>${esc(d.name)}${App.coTag(d.companyId, true)}</h2>
            <div class="sub">${[one(d.mode), d.location, d.zip].filter(Boolean).map(esc).join(', ') || 'No details yet'}${expText(d) ? `<span class="src">${esc(expText(d))}</span>` : ''}${sourceLine ? `<span class="src">Found through ${sourceLine}</span>` : ''}</div>
            <div class="contact">${(d.phones || []).map((p) => App.phone(p, '')).join('')}${(d.emails || []).map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join('')}<button class="linkbtn" data-act="editContact">Edit details</button></div>
            <div class="tags" id="tags">${(d.tags || []).map((x) => `<span class="tag">${esc(x)}<button data-tag="${esc(x)}" aria-label="Remove tag ${esc(x)}">×</button></span>`).join('')}<input id="tagIn" type="text" placeholder="Add a tag, press Enter" aria-label="Add a tag" data-fk="tag"></div>
          </div>
          <div class="acts">
            ${admin ? `<div class="ownbox"><span>Recruiter</span>${App.assignPick(d, 'big')}</div>` : ''}
            ${(d.phones || [])[0] ? `<a class="btn primary" href="tel:${esc(d.phones[0])}">Call</a>` : ''}
            ${/^https:\/\//.test(d.conversationUrl || '') ? `<a class="btn plain" href="${esc(d.conversationUrl)}" target="_blank" rel="noopener noreferrer">Open on Indeed</a>` : ''}
            ${!ob || !['Onboarding', 'Hired'].includes(d.status) ? `<button class="btn plain" data-act="startOnb">${ob ? 'Back to onboarding' : 'Start onboarding'}</button>` : ''}
          </div>
        </div>
        <div class="ctl">
          <label class="fld">Status<select data-ch="status" data-fk="status" class="stsel">${all.concat(all.includes(d.status) ? [] : [d.status]).map((s) => `<option ${s === d.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          ${lostish ? `<div class="fld">Why<div class="whyline">${d.lostReason ? `<b>${esc(d.lostReason)}</b>${d.lostNote ? `<span>${esc(d.lostNote)}</span>` : ''}` : '<span class="mut">No reason given</span>'}<button class="linkbtn" data-act="whyEdit">${d.lostReason ? 'Change' : 'Add the reason'}</button></div></div>` : ''}
          <div class="fld">Follow-up<div class="fuline"><input type="date" data-ch="followUp" data-fk="fu" aria-label="Follow-up date" value="${esc(d.followUp || '')}">
            <button class="chip" data-act="fuQuick" data-days="1">Tomorrow</button><button class="chip" data-act="fuQuick" data-days="3">In 3 days</button><button class="chip" data-act="fuQuick" data-days="7">Next week</button>${d.followUp ? '<button class="chip" data-act="fuQuick" data-days="">Clear</button>' : ''}</div>
            ${d.followUp && d.followUp <= t ? `<span class="fu due">${esc(fuText(d.followUp))}</span>` : ''}</div>
          <label class="fld">Company<select data-ch="company" data-fk="company" class="cosel">${App.coOptions(d.companyId)}</select></label>
          ${owner}
        </div>
      </section>
      <form id="contactForm" class="card" hidden><h3>Details</h3><div class="form">
        <label class="fld">Name<input name="name" type="text" value="${esc(d.name)}"></label>
        <label class="fld">Phones, comma separated<input name="phones" type="text" value="${esc((d.phones || []).map(fmtPhone).join(', '))}"></label>
        <label class="fld">Emails, comma separated<input name="emails" type="text" value="${esc((d.emails || []).join(', '))}"></label>
        <label class="fld">Home<input name="location" type="text" value="${esc(d.location || '')}"></label>
        <label class="fld">Zip<input name="zip" type="text" value="${esc(d.zip || '')}" style="min-width:90px;width:90px"></label>
        <label class="fld">Driver type<select name="mode" data-ch="editMode"><option value="">Not set</option>${[['Company drivers', 'Company driver'], ['Owner-operators', 'Owner operator']].map(([m, l]) => `<option value="${m}" ${m === d.mode ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="fld">Years with a CDL-A<input name="expYears" type="number" min="0" max="60" step="0.5" value="${d.expYears ?? ''}" style="min-width:90px;width:110px"></label>
        <label class="fld">What they drove<input name="experience" type="text" maxlength="1000" value="${esc(d.experience || '')}"></label>
        <label class="fld">Ran Amazon Relay before?<select name="relayBefore"><option value="" ${d.relayBefore === null || d.relayBefore === undefined ? 'selected' : ''}>Not asked yet</option><option value="yes" ${d.relayBefore === true ? 'selected' : ''}>Yes</option><option value="no" ${d.relayBefore === false ? 'selected' : ''}>No</option></select></label>
        <label class="fld">Weeks out<input name="weeksOut" type="number" min="0.5" max="26" step="0.5" value="${d.weeksOut ?? ''}" style="min-width:90px;width:100px"></label>
        <label class="fld">Days home<input name="daysHome" type="number" min="0" max="60" value="${d.daysHome ?? ''}" style="min-width:90px;width:100px"></label>
        <span class="ootruck" ${d.mode === 'Owner-operators' ? '' : 'hidden'}><label class="fld">Truck year<input name="truckYear" type="number" min="1980" max="${new Date().getFullYear() + 1}" value="${d.truckYear ?? ''}" style="min-width:90px;width:100px"></label>
          <label class="fld">Truck make and model<input name="truckModel" type="text" maxlength="80" value="${esc(d.truckModel || '')}"></label></span>
        <label class="fld">Source<select name="source">${d.source && S.me.sources.includes(d.source) ? '' : `<option value="">${esc(d.source || 'Not set')}</option>`}${S.me.sources.map((s) => `<option ${s === d.source ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        <label class="fld">Source details<input name="sourceDetail" type="text" maxlength="200" value="${esc(d.sourceDetail || '')}"></label>
        <button class="btn primary">Save</button><button type="button" class="btn plain" data-act="cancelContact">Cancel</button></div></form>
      <div class="cols">
        <div>
          ${d.status === 'Onboarding' ? onb : ''}
          ${d.status === 'Hired' ? '<section class="card"><div class="tggroups" aria-live="polite"></div></section>' : ''}
          <section class="card dprof" id="dprof" hidden></section>
          ${amazonCard(d)}
          ${callGuide(d, ob, r.notes)}
          <section class="card"><h3>Notes and contact log</h3>
            ${d.redFlags ? `<div class="flagbox"><span>${esc(d.redFlags)}</span></div>` : ''}
            <form class="compose" id="noteForm"><textarea id="newNote" data-fk="note" placeholder="What they said, what you agreed, what to do next"></textarea>
              <div class="row"><button class="btn primary">Add note</button><span class="hint">Ctrl+Enter adds it</span></div>
              <div class="logrow"><span class="hint">Or log a contact, with the text above if you wrote any:</span>
                <button type="button" class="btn plain sm" data-act="logContact" data-kind="call" data-outcome="Talked">Called, talked</button>
                <button type="button" class="btn plain sm" data-act="logContact" data-kind="call" data-outcome="No answer">Called, no answer</button>
                <button type="button" class="btn plain sm" data-act="logContact" data-kind="call" data-outcome="Left voicemail">Left voicemail</button>
                <button type="button" class="btn plain sm" data-act="logContact" data-kind="text" data-outcome="Sent">Texted</button>
                <button type="button" class="btn plain sm" data-act="logContact" data-kind="email" data-outcome="Sent">Emailed</button></div>${r.indeedChat && S.me.noAnswerOn ? '<p class="hint imhint">No answer or voicemail: Chrome also sends an Indeed message in this driver\'s chat.</p>' : ''}</form>
            ${r.notes.length ? `<ul class="notes">${r.notes.map(noteHtml).join('')}</ul>` : '<p class="hint" style="margin:10px 0 0">No notes yet.</p>'}
          </section>
          <section class="card"><h3>Conversation</h3>${d.transcript ? `<div class="convo" id="cv">${convoHtml(d.transcript)}</div>` : '<p class="hint">No Indeed conversation saved for this driver.</p>'}</section>
          ${d.status !== 'Onboarding' ? onb : ''}
        </div>
        <div>
          ${d.status === 'Hired' ? activeCard(d) : ''}
          ${d.aiSummary ? `<section class="card"><div class="ai"><b>AI summary</b>${esc(d.aiSummary)}</div></section>` : ''}
          <section class="card"><h3>Profile</h3><dl class="facts">
            ${[['Status', `${badge(d.status)}${d.statusLocked ? ' <span class="small mut">set by hand</span>' : ''}`], ['Company', App.coTag(d.companyId)], ['Driver type', esc(one(d.mode))],
              ['CDL-A experience', d.expYears !== null && d.expYears !== undefined ? esc(plural(d.expYears, 'year')) : ''], ['Drove', esc(d.experience || '')], ['Ran Amazon Relay before', d.relayBefore === true ? 'Yes' : d.relayBefore === false ? 'No' : ''], ['Working period', esc(App.periodText(d))], ['Their truck', esc([d.truckYear, d.truckModel].filter(Boolean).join(' '))], ['Recruiter', esc(person(d.ownerId))], ['Found through', sourceLine], ['Job', esc(d.job)], ['Indeed account', esc(d.account)], ['Became a lead', esc(when(d.leadAt))], ['Invited', esc(when(d.invitedAt))], ['Last contact', esc(when(d.lastContactAt))], ['Indeed profile', esc(d.profileSummary)]]
              .concat(answerKeys.map((k) => [label(k), esc(a[k])])).filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}
          </dl></section>
          <section class="card"><h3>History</h3>${r.events.length ? `<ol class="tl">${r.events.map((e) => `<li><time>${esc(when(e.t))}${e.who ? `, ${esc(e.who)}` : ''}</time>${esc(e.text)}</li>`).join('')}</ol>` : '<p class="hint">No activity yet.</p>'}</section>
          ${admin ? '<p class="small" style="text-align:right"><button class="linkbtn red" data-act="delDriver">Delete this driver</button></p>' : ''}
        </div>
      </div></main>`;
    const cv = $('#cv'); if (cv) cv.scrollTop = cv.scrollHeight;
    if (draft) $('#newNote').value = draft;
    $('#tagIn').onkeydown = (e) => { if (e.key === 'Enter' && e.target.value.trim()) { e.preventDefault(); patch({ tags: [...(d.tags || []), e.target.value.trim()] }, 'Tag added'); } };
    $('#noteForm').onsubmit = (e) => { e.preventDefault(); addNote(); };
    $('#newNote').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNote(); } };
    $('#contactForm').onsubmit = (e) => {
      e.preventDefault(); const f = new FormData(e.target); const split = (v) => String(v || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
      const oo = f.get('mode') === 'Owner-operators';
      patch({ name: f.get('name'), phones: split(f.get('phones')), emails: split(f.get('emails')), location: f.get('location'), zip: f.get('zip'), mode: f.get('mode'), source: f.get('source'), sourceDetail: f.get('sourceDetail'),
        expYears: f.get('expYears'), experience: f.get('experience'), relayBefore: f.get('relayBefore'), weeksOut: f.get('weeksOut'), daysHome: f.get('daysHome'), truckYear: oo ? f.get('truckYear') : '', truckModel: oo ? f.get('truckModel') : '' }, 'Details saved');
    };
    const tgh = document.querySelector('.tggroups'); if (tgh && App.tgLeadGroups) App.tgLeadGroups(d.id, tgh);
    const dp = document.getElementById('dprof'); if (dp && App.profileCard) App.profileCard(d.id, dp, d.status === 'Hired' || d.status === 'Onboarding');
    const sf = $('#stepForm'); if (sf) sf.onsubmit = async (e) => { e.preventDefault(); const v = sf.label.value.trim(); if (!v) return; try { await api(`/api/drivers/${d.id}/checklist`, { method: 'POST', body: { label: v } }); toast('Step added'); again(); } catch (err) { fail(err); } };
  }
  const again = () => redraw(() => viewDriver(cur.driver.id));
  async function patch(body, okText) { try { await api('/api/drivers/' + cur.driver.id, { method: 'PATCH', body }); if (okText) toast(okText); await again(); } catch (e) { fail(e); await again(); } }
  async function patchOnb(body, okText) { try { await api(`/api/drivers/${cur.driver.id}/onboarding`, { method: 'PATCH', body }); if (okText) toast(okText); } catch (e) { fail(e); } await again(); }
  async function addNote(extra = {}) {
    const box = $('#newNote'); const body = box.value.trim(); if (!body && !extra.kind) { box.focus(); return; }
    try {
      const r = await api(`/api/drivers/${cur.driver.id}/notes`, { method: 'POST', body: { body, ...extra } }); box.value = '';
      const ix = r.indeed;
      toast(ix && ix.queued ? 'Call logged. An Indeed message goes out from Chrome' : ix && ix.skip && (ix.why === 'recent' || ix.why === 'lost') ? `Call logged. No Indeed message: ${ix.skip}` : extra.kind ? 'Contact logged' : 'Note added');
      await again();
    } catch (e) { fail(e); }
  }
  onChange('status', (el) => (S.me.needReason.includes(el.value) ? askWhy(el.value) : patch({ status: el.value }, el.value === 'Onboarding' ? 'Onboarding started' : 'Status saved')));
  on('whyEdit', () => askWhy(null));
  // A lost lead needs its reason: ask for it before the status changes. Cancel keeps the old status.
  function askWhy(status) {
    const d = cur.driver; const to = status || d.status;
    let saved = false;
    dialog(`<form class="dform" id="whyForm"><h2>${status ? `Why is ${esc(d.name)} ${to === 'Stalled' ? 'stalled' : `“${esc(to)}”`}?` : `Why was ${esc(d.name)} lost?`}</h2>
      <p class="hint">The reason is saved on the lead and counted in the reports, so the team sees why drivers drop out.</p>
      <fieldset class="whyopts"><legend>Reason</legend>${S.me.lostReasons.map((x) => `<label class="chk"><input type="radio" name="why" value="${esc(x)}" ${x === d.lostReason ? 'checked' : ''} required> ${esc(x)}</label>`).join('')}</fieldset>
      <label class="fld">Details<textarea name="note" rows="3" maxlength="500" placeholder="What happened, in their words if you can (e.g. wants $2,000 a week, home every weekend)">${esc(d.lostNote || '')}</textarea></label>
      <p class="err" id="whyErr" role="alert"></p>
      <div class="drow"><button class="btn primary">${status ? `Save as ${esc(to)}` : 'Save the reason'}</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (dl) => {
      const f = $('#whyForm', dl);
      f.onsubmit = async (e) => {
        e.preventDefault(); const why = (f.querySelector('[name=why]:checked') || {}).value; const note = f.note.value.trim();
        if (!why) { $('#whyErr').textContent = 'Choose a reason'; return; }
        if (why === 'Other' && !note) { $('#whyErr').textContent = 'Write a few words on the reason'; f.note.focus(); return; }
        try { await api('/api/drivers/' + d.id, { method: 'PATCH', body: { ...(status ? { status } : {}), lostReason: why, lostNote: note } }); saved = true; dl.close(); toast(status ? `Saved as ${to}` : 'Reason saved'); }
        catch (err) { $('#whyErr').textContent = err.message; }
      };
      dl.addEventListener('close', () => { again(); }, { once: true }); // also puts the status back after Cancel
    });
  }

  // ---------- Amazon Relay, step by step ----------
  const AZ_NEXT = {
    '': 'Get the driver\'s email, then send the Relay invite from our Amazon account.',
    invite: 'The driver opens the invite email (check spam) and creates their Amazon account.',
    account: 'The driver signs up in Amazon Relay and finishes the profile.',
    profile: 'Amazon sends the background check to Accurate (accurate.com). The driver fills in the Accurate form from that email.',
    accurate: 'Accurate runs the check. Ask the driver whether the Accurate form is fully done.',
    waiting: 'Waiting for Amazon to verify. Check the driver in our Relay account.',
    verified: 'Verified by Amazon. The driver can be onboarded and dispatched.'
  };
  function amazonCard(d) {
    const steps = S.me.amazon || []; const at = steps.findIndex((x) => x.key === d.amazonStep);
    const route = S.me.route.indexOf(d.status);
    if (at < 0 && route < S.me.route.indexOf('Email collected')) return '';
    const done = d.amazonStep === 'verified'; const log = d.amazonLog || {};
    return `<section class="card azcard${done ? ' verified' : ''}" aria-labelledby="azH"><h3 id="azH">Amazon Relay${done ? '<span class="azv">✓ Amazon verified</span>' : at >= 0 ? `<span class="azstep">Step ${at + 1} of ${steps.length}: ${esc(steps[at].label)}</span>` : '<span class="azstep">Not started</span>'}</h3>
      <ol class="azsteps">${steps.map((x, i) => `<li class="${i <= at ? 'done' : ''}${i === at ? ' now' : ''}"><button type="button" data-act="azStep" data-k="${x.key}" aria-pressed="${i <= at}" title="${esc(x.long)}">
        <span class="azdot">${i <= at ? '✓' : i + 1}</span><span class="azl">${esc(x.label)}</span>${log[x.key] ? `<span class="azt">${esc(shortWhen(log[x.key]))}</span>` : ''}</button></li>`).join('')}</ol>
      <p class="aznext"><b>${done ? 'Done:' : 'Next:'}</b> ${esc(AZ_NEXT[done ? 'verified' : d.amazonStep || ''])}</p></section>`;
  }
  on('azStep', (b) => {
    const steps = S.me.amazon; const k = b.dataset.k; const to = steps.findIndex((x) => x.key === k); const at = steps.findIndex((x) => x.key === cur.driver.amazonStep);
    if (to === at) { if (confirm(`Go back one step, to ${to ? steps[to - 1].label : 'not started'}?`)) patch({ amazonStep: to ? steps[to - 1].key : null }, 'Amazon step saved'); return; }
    if (to < at && !confirm(`Move back to "${steps[to].label}"?`)) return;
    patch({ amazonStep: k }, k === 'verified' ? 'Amazon verified' : 'Amazon step saved');
  });
  onChange('followUp', (el) => patch({ followUp: el.value || null }, el.value ? 'Follow-up saved' : 'Follow-up cleared'));
  onChange('company', (el) => patch({ companyId: el.value ? +el.value : null }, el.value ? `Company: ${App.company(+el.value).name}` : 'Company removed'));
  onChange('editMode', (el) => { const x = $('.ootruck'); if (x) x.hidden = el.value !== 'Owner-operators'; });
  onChange('owner', (el) => patch({ ownerId: el.value ? +el.value : null }, el.value ? `Given to ${person(+el.value)}` : 'No recruiter now'));
  onChange('onbTruck', (el) => patchOnb({ truckId: el.value ? +el.value : null }, el.value ? 'Truck assigned' : 'Truck released'));
  onChange('onbField', (el) => patchOnb({ [el.dataset.f]: el.value }, 'Saved'));
  onChange('step', async (el) => { try { await api('/api/checklist/' + el.closest('[data-step]').dataset.step, { method: 'PATCH', body: { done: el.checked } }); } catch (e) { fail(e); } await again(); });
  on('fuQuick', (b) => patch({ followUp: b.dataset.days ? addDays(today(), +b.dataset.days) : null }, b.dataset.days ? 'Follow-up saved' : 'Follow-up cleared'));
  on('startOnb', () => patch({ status: 'Onboarding' }, 'Onboarding started'));
  on('hire', () => { const left = cur.onboarding.items.filter((i) => !i.done).length; if (!left || confirm(`${plural(left, 'step')} still open. Mark as hired anyway?`)) patch({ status: 'Hired' }, 'Marked as hired'); });
  on('logContact', (b) => addNote({ kind: b.dataset.kind, outcome: b.dataset.outcome }));
  on('imRetry', async (b) => { await api('/api/indeed-outbox/' + b.closest('[data-im]').dataset.im, { method: 'POST', body: { action: 'retry' } }); toast('It goes out again from Chrome'); await again(); });
  on('imStop', async (b) => { await api('/api/indeed-outbox/' + b.closest('[data-im]').dataset.im, { method: 'POST', body: { action: 'cancel' } }); toast('Not sent'); await again(); });
  on('editContact', () => { const f = $('#contactForm'); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input').focus(); });
  on('cancelContact', () => { $('#contactForm').hidden = true; });
  on('editNote', (b) => {
    const li = b.closest('[data-note]'); const bodyEl = li.querySelector('.body'); if (li.querySelector('textarea')) return;
    const old = cur.notes.find((n) => n.id === +li.dataset.note).body;
    bodyEl.innerHTML = `<textarea>${esc(old)}</textarea><div style="margin-top:6px;display:flex;gap:8px"><button class="btn primary sm" data-act="saveNote">Save</button><button class="btn plain sm" data-act="cancelNote">Cancel</button></div>`;
    bodyEl.querySelector('textarea').focus();
  });
  on('cancelNote', again);
  on('saveNote', async (b) => { const li = b.closest('[data-note]'); await api('/api/notes/' + li.dataset.note, { method: 'PATCH', body: { body: li.querySelector('textarea').value } }); toast('Note saved'); again(); });
  on('delNote', async (b) => { if (!confirm('Delete this entry?')) return; await api('/api/notes/' + b.closest('[data-note]').dataset.note, { method: 'DELETE' }); toast('Deleted'); again(); });
  on('delDriver', async () => { if (!confirm(`Delete ${cur.driver.name} and all their notes? This cannot be undone.`)) return; await api('/api/drivers/' + cur.driver.id, { method: 'DELETE' }); toast('Driver deleted'); go('#/leads'); });
  on('stepNote', (b) => {
    const li = b.closest('[data-step]'); if (li.querySelector('.snedit')) return;
    const it = cur.onboarding.items.find((i) => i.id === +li.dataset.step);
    const box = document.createElement('form'); box.className = 'snedit';
    box.innerHTML = `<input type="text" maxlength="500" aria-label="Note for this step" value="${esc(it.note || '')}"><button class="btn primary sm">Save</button><button type="button" class="btn plain sm" data-act="cancelNote">Cancel</button>`;
    li.appendChild(box); box.querySelector('input').focus();
    box.onsubmit = async (e) => { e.preventDefault(); try { await api('/api/checklist/' + it.id, { method: 'PATCH', body: { note: box.querySelector('input').value } }); toast('Note saved'); } catch (err) { fail(err); } again(); };
  });
  on('delStep', async (b) => { await api('/api/checklist/' + b.closest('[data-step]').dataset.step, { method: 'DELETE' }); toast('Step removed'); again(); });
  document.addEventListener('click', (e) => { const x = e.target.closest('[data-tag]'); if (x && cur) patch({ tags: (cur.driver.tags || []).filter((t) => t !== x.dataset.tag) }, 'Tag removed'); });

  App.route(/^#\/leads$/, viewLeads);
  App.route(/^#\/driver\/(\d+)$/, (id) => viewDriver(+id));
})();
