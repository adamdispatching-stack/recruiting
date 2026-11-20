// Dashboard (admin) and My day (recruiter), the onboarding board, and the truck list.
(() => {
  const { $, esc, view, S, api, toast, fail, on, onChange, redraw, header, badge, fmtPhone, addDays, dateText, dayOf, teamTime, fuText, dur, daysSince, person, presenceHtml, dialog, meterRow, feedHtml, plural, tzName } = App;
  const q = encodeURIComponent;

  // One line of "needs attention": a count that links to the list behind it. Zero lines go quiet.
  const attn = (n, one, many, href, warn = true) => (n
    ? `<a class="aline${warn ? ' warn' : ''}" href="${href}"><b>${n.toLocaleString()}</b><span>${n === 1 ? one : many}</span></a>`
    : `<span class="aline none"><b>0</b><span>${many}</span></span>`);
  const figures = (list) => `<dl class="figs">${list.map(([v, l, hint]) => `<div${hint ? ` title="${esc(hint)}"` : ''}><dd>${v}</dd><dt>${l}</dt></div>`).join('')}</dl>`;

  // ---------- dashboard ----------
  function adminHome(r) {
    const a = r.attention; const c = Object.fromEntries(r.pipeline.map((x) => [x.status, x.n]));
    const stages = S.me.route.filter((s) => s !== 'Invited'); const max = Math.max(1, ...stages.map((s) => c[s] || 0));
    const srcMax = Math.max(1, ...r.sources.map((s) => s.leads)); const lostMax = Math.max(1, ...r.lost.map((s) => s.n));
    const off = S.me.other.filter((s) => c[s]).map((s) => `<a href="#/leads?status=${q(s)}">${esc(s)} ${c[s]}</a>`).join(', ');
    return `<main class="dash">
      <section class="card attn" aria-labelledby="attnH"><h3 id="attnH">Needs attention</h3><div class="agroups">
        <div><h4>Leads</h4>
          ${attn(a.due, 'follow-up due', 'follow-ups due', '#/leads?due=1')}
          ${attn(a.unassigned, 'lead in progress with no recruiter', 'leads in progress with no recruiter', '#/leads?owner=none&working=1')}
          ${attn(a.cold, `lead going cold (quiet ${S.me.coldDays}+ days, no follow-up set)`, `leads going cold (quiet ${S.me.coldDays}+ days, no follow-up set)`, '#/leads?cold=1')}</div>
        <div><h4>Onboarding</h4>
          ${attn(a.late, 'driver past the expected arrival date', 'drivers past the expected arrival date', '#/onboarding')}
          ${attn(a.stuck, 'onboarding with no step done for 3 days', 'onboardings with no step done for 3 days', '#/onboarding')}
          ${attn(a.ready, 'driver with every step done, ready to mark hired', 'drivers with every step done, ready to mark hired', '#/onboarding')}
          ${attn(a.arriving, 'driver arriving in the next 7 days', 'drivers arriving in the next 7 days', '#/onboarding', false)}</div>
        <div><h4>Trucks</h4>
          ${attn(a.emptyTrucks, 'empty truck', 'empty trucks', '#/trucks', false)}
          <span class="aline plain"><b>${a.onboarding}</b><span>${a.onboarding === 1 ? 'driver' : 'drivers'} in onboarding</span></span>
          ${a.trucks ? '' : '<span class="aline none"><span>No trucks listed yet. <a href="#/trucks">Add them</a> to see which are empty.</span></span>'}</div>
      </div></section>
      <div class="dgrid">
        <div>
          <section class="card"><h3>Pipeline now</h3>
            ${figures([[r.week.newLeads, 'new leads, last 7 days', 'People who answered for the first time or were added by hand'], [r.week.forward, 'moved forward, last 7 days', 'Leads that reached Interested or a later step'], [r.month.onboarded, 'started onboarding, last 30 days'], [r.month.hired, 'hired, last 30 days']])}
            <div class="mlist">${stages.map((s) => meterRow(esc(s), c[s] || 0, max, '', `#/leads?status=${q(s)}`)).join('')}</div>
            <p class="hint foot">${(c.Invited || 0).toLocaleString()} invited on Indeed with no reply yet (<a href="#/leads?status=Invited">show</a>).${off ? ` Off the route: ${off}.` : ''}</p>
          </section>
          <section class="card"><h3>Where leads came from, last 30 days</h3>
            ${r.sources.length ? `<div class="mlist src">${r.sources.map((s) => meterRow(esc(s.source), s.leads, srcMax, `<span class="mextra">${s.engaged} interested or further, ${s.won} onboarding or hired</span>`, `#/leads?source=${q(s.source)}`)).join('')}</div>
              <p class="hint foot">A lead counts from the day the person first answered or was added by hand. Invites with no reply are left out.</p>` : '<p class="hint">No new leads in the last 30 days.</p>'}
          </section>
          ${r.lost.length ? `<section class="card"><h3>Why leads were lost, last 30 days</h3><div class="mlist">${r.lost.map((s) => meterRow(esc(s.reason), s.n, lostMax)).join('')}</div>
            <p class="hint foot">Recruiters pick a reason when they set Stalled, Not interested or Rejected.</p></section>` : ''}
        </div>
        <div>
          <section class="card"><h3>Team today<span class="grow"></span><a class="h3link" href="#/team">All numbers</a></h3>
            <div class="scroll"><table class="mini"><thead><tr><th>Person</th><th>First seen</th><th class="n">Active</th><th class="n">Leads opened</th><th class="n">Notes</th><th class="n">Calls, texts</th><th class="n">Due</th></tr></thead><tbody>
              ${r.team.filter((p) => p.active).map((p) => `<tr><td><a href="#/team/${p.id}"><b>${esc(p.name)}</b></a>${presenceHtml(p, r.now)}</td><td>${p.firstAt ? esc(teamTime(p.firstAt)) : '<span class="none">Not today</span>'}</td><td class="n">${dur(p.activeSeconds)}</td><td class="n">${p.opened}</td><td class="n">${p.notes}</td><td class="n">${p.contacts}</td><td class="n${p.due ? ' bad' : ''}">${p.due}</td></tr>`).join('')}
            </tbody></table></div><p class="hint foot">Times in ${esc(tzName())}. Due = follow-ups due today or earlier on their leads.</p></section>
          <section class="card"><h3>Latest activity</h3>${feedHtml(r.feed, true)}</section>
        </div>
      </div></main>`;
  }
  function myDay(r) {
    const s = r.stats; const c = Object.fromEntries(r.pipeline.map((x) => [x.status, x.n]));
    const stages = S.me.route.filter((x) => x !== 'Invited'); const max = Math.max(1, ...stages.map((x) => c[x] || 0));
    return `<main class="dash">
      <section class="card attn" aria-labelledby="attnH"><h3 id="attnH">Today</h3><div class="agroups">
        <div><h4>Your leads</h4>
          ${attn(s.due, 'follow-up due', 'follow-ups due', '#/leads?owner=me&due=1')}
          ${attn(s.cold, `lead going cold (quiet ${S.me.coldDays}+ days, no follow-up set)`, `leads going cold (quiet ${S.me.coldDays}+ days, no follow-up set)`, '#/leads?owner=me&cold=1')}
          <a class="aline plain" href="#/leads?owner=me&working=1"><b>${s.owned}</b><span>${s.owned === 1 ? 'lead' : 'leads'} in progress</span></a></div>
        <div><h4>Up for grabs</h4>${attn(r.unassigned, 'lead in progress with no recruiter yet', 'leads in progress with no recruiter yet', '#/leads?owner=none&working=1', false)}</div>
        <div><h4>Onboarding</h4><a class="aline plain" href="#/onboarding"><b>${r.onboarding.length}</b><span>of your drivers being set up</span></a></div>
      </div></section>
      <div class="dgrid">
        <div>
          <section class="card"><h3>Call list</h3>
            ${r.calls.length ? `<div class="scroll"><table class="mini calls"><thead><tr><th>Driver</th><th>Phone</th><th>Follow-up</th><th>Last note</th></tr></thead><tbody>${r.calls.map((d) => `<tr><td><a href="#/driver/${d.id}"><b>${esc(d.name)}</b></a><div>${badge(d.status)}</div></td>
              <td>${(d.phones || []).map((p) => `<a class="ph" href="tel:${esc(p)}">${esc(fmtPhone(p))}</a>`).join('') || '<span class="none">No phone</span>'}</td>
              <td><span class="fu${d.followUp <= r.today ? ' due' : ''}">${esc(fuText(d.followUp))}</span></td><td><div class="clamp small">${esc(d.lastNote || '') || '<span class="none">No notes</span>'}</div></td></tr>`).join('')}</tbody></table></div>`
              : '<p class="hint">No follow-ups due. Put a follow-up date on every lead you are working, and it shows up here on the right day.</p>'}
          </section>
          ${r.cold.length ? `<section class="card"><h3>Going cold</h3><ul class="list">${r.cold.map((d) => `<li><span class="grow"><a class="nml" href="#/driver/${d.id}"><b>${esc(d.name)}</b></a> ${badge(d.status)}</span><span class="small mut">quiet for ${plural(daysSince(d.updatedAt), 'day')}</span></li>`).join('')}</ul>
            <p class="hint foot">These have no follow-up date. Call them, or set a date, or close them out.</p></section>` : ''}
        </div>
        <div>
          <section class="card"><h3>Your numbers today<span class="grow"></span><a class="h3link" href="#/team/me">Your activity</a></h3>
            ${figures([[dur(s.activeSeconds), 'active on the site'], [s.opened, 'leads opened'], [s.notes, 'notes'], [s.contacts, 'calls, texts, emails'], [s.forward, 'moved forward'], [s.added, 'leads added']])}
            <p class="hint foot">Your manager sees the same numbers.</p></section>
          <section class="card"><h3>Your pipeline</h3><div class="mlist">${stages.map((x) => meterRow(esc(x), c[x] || 0, max, '', `#/leads?owner=me&status=${q(x)}`)).join('')}</div></section>
          ${r.onboarding.length ? `<section class="card"><h3>Your drivers in onboarding</h3><ul class="list">${r.onboarding.map((d) => `<li><span class="grow"><a class="nml" href="#/driver/${d.id}"><b>${esc(d.name)}</b></a><br><span class="small mut">${d.arrivedOn ? 'Arrived ' + esc(dateText(d.arrivedOn)) : d.expectedArrival ? 'Expected ' + esc(dateText(d.expectedArrival)) : 'No arrival date yet'}</span></span>
            <span class="prog"><b>${d.done} of ${d.total}</b><span class="meter"><i style="width:${d.total ? (d.done / d.total) * 100 : 0}%"></i></span></span></li>`).join('')}</ul></section>` : ''}
        </div>
      </div></main>`;
  }
  async function viewHome() {
    const live = App.drawing(); const r = await api('/api/dashboard'); if (!live()) return;
    document.title = (r.role === 'admin' ? 'Dashboard' : 'My day') + ' · Recruiting';
    view.innerHTML = header('home') + (r.role === 'admin' ? adminHome(r) : myDay(r));
    App.every(60000, viewHome);
  }

  // ---------- onboarding board: one row per driver, one column per step ----------
  const LOCKED = ['truck', 'arrival', 'arrived'];
  async function viewOnboarding() {
    const live = App.drawing(); const r = await api('/api/onboarding'); if (!live()) return; const t = r.today;
    document.title = 'Onboarding · Recruiting';
    const cols = r.template; const keys = new Set(cols.map((c) => c.key));
    const extraCol = r.drivers.some((d) => d.items.some((i) => !keys.has(i.key)));
    const arriving = r.drivers.filter((d) => !d.arrivedOn && d.expectedArrival && d.expectedArrival >= t && d.expectedArrival <= addDays(t, 7)).length;
    const late = r.drivers.filter((d) => !d.arrivedOn && d.expectedArrival && d.expectedArrival < t).length;
    const ready = r.drivers.filter((d) => d.items.length && d.items.every((i) => i.done)).length;
    const rows = r.drivers.map((d) => {
      const by = Object.fromEntries(d.items.map((i) => [i.key, i])); const extra = d.items.filter((i) => !keys.has(i.key));
      const done = d.items.filter((i) => i.done).length, total = d.items.length;
      const isLate = !d.arrivedOn && d.expectedArrival && d.expectedArrival < t;
      const arrival = d.arrivedOn ? `<span class="okt">Arrived ${esc(dateText(d.arrivedOn))}</span>` : d.expectedArrival ? `${esc(dateText(d.expectedArrival, { weekday: 'short' }))}${isLate ? '<span class="latetag">Late</span>' : ''}` : '<span class="none">No date yet</span>';
      return `<tr data-driver="${d.id}"><th scope="row"><a href="#/driver/${d.id}">${esc(d.name)}</a><div class="small mut">${d.ownerId ? esc(person(d.ownerId)) : 'No recruiter'}, day ${daysSince(d.startedAt) + 1}</div>${d.companyId ? `<div>${App.coTag(d.companyId)}</div>` : ''}${d.telegramLink ? `<a class="small" href="${esc(d.telegramLink)}" target="_blank" rel="noopener noreferrer">Telegram group</a>` : ''}</th>
        <td class="tk">${d.truck ? `<b>${esc(d.truck.unit)}</b>` : '<span class="none">None yet</span>'}</td><td class="arr" title="${esc(d.arrivalNote || '')}">${arrival}${d.arrivalNote ? `<div class="small mut clamp1">${esc(d.arrivalNote)}</div>` : ''}</td>
        ${cols.map((c) => { const i = by[c.key]; return `<td class="ck">${i ? `<span class="ckw"><input type="checkbox" data-ch="boardStep" data-step="${i.id}" data-fk="b${i.id}" ${i.done ? 'checked' : ''} ${LOCKED.includes(i.auto) ? 'disabled' : ''} title="${esc(i.note || '')}" aria-label="${esc(c.label)}, ${esc(d.name)}">${i.note ? '<i class="hasnote" title="' + esc(i.note) + '"></i>' : ''}</span>` : '<span class="none" title="Not on this driver\'s list">n/a</span>'}</td>`; }).join('')}
        ${extraCol ? `<td class="n">${extra.length ? `<a href="#/driver/${d.id}">${extra.filter((i) => i.done).length} of ${extra.length}</a>` : ''}</td>` : ''}
        <td class="n"><span class="prog${done === total ? ' full' : ''}"><b>${done} of ${total}</b></span></td></tr>`;
    }).join('');
    view.innerHTML = header('onboarding') + `<main>
      <section class="card">${`<dl class="figs">${[[r.drivers.length, 'in onboarding'], [arriving, 'arriving in the next 7 days'], [late, 'past the expected arrival date'], [ready, 'ready to mark hired'], [r.emptyTrucks, 'empty trucks']].map(([v, l]) => `<div><dd>${v}</dd><dt>${l}</dt></div>`).join('')}</dl>`}</section>
      ${r.drivers.length ? `<div class="sheet"><table class="board"><thead><tr><th>Driver</th><th>Truck</th><th>Arrival</th>${cols.map((c) => `<th class="ck">${esc(c.label)}</th>`).join('')}${extraCol ? '<th class="n">Own steps</th>' : ''}<th class="n">Done</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="hint foot">Tick a step here or on the driver's page. Truck and arrival steps tick themselves when you fill them in on the driver's page. A dot marks a step with a note.</p>`
        : '<div class="empty"><p>Nobody is in onboarding.</p>Open a lead and choose Start onboarding. The driver gets this checklist: ' + esc(cols.map((c) => c.label).join(', ')) + '.</div>'}
      ${r.hired.length ? `<section class="card" style="margin-top:14px"><h3>Hired in the last 30 days</h3><ul class="list">${r.hired.map((d) => `<li><span class="grow"><a class="nml" href="#/driver/${d.id}"><b>${esc(d.name)}</b></a> ${App.coTag(d.companyId)} <span class="small mut">${d.ownerId ? esc(person(d.ownerId)) + "'s lead" : ''}</span></span>
        <span class="small mut">${d.truck ? 'Truck ' + esc(d.truck) + ', ' : ''}hired ${esc(dateText(dayOf(d.hiredAt)))}, ${plural(Math.max(1, Math.round((new Date(d.hiredAt) - new Date(d.startedAt)) / 864e5)), 'day')} in onboarding</span></li>`).join('')}</ul></section>` : ''}
    </main>`;
  }
  onChange('boardStep', async (el) => { try { await api('/api/checklist/' + el.dataset.step, { method: 'PATCH', body: { done: el.checked } }); } catch (e) { fail(e); } await redraw(viewOnboarding); });

  // ---------- trucks ----------
  let trucks = []; let truckFilter = ''; let truckCo = '';
  const STATE = { empty: 'Empty', assigned: 'With a driver', out: 'Out of service' };
  async function viewTrucks() {
    const live = App.drawing(); const got = (await api('/api/trucks')).trucks; if (!live()) return;
    trucks = got; const admin = S.me.role === 'admin';
    document.title = 'Trucks · Recruiting';
    const n = (s) => trucks.filter((t) => t.state === s).length;
    const inCo = (t) => !truckCo || (truckCo === 'none' ? !t.companyId : t.companyId === +truckCo);
    const shown = trucks.filter((t) => (!truckFilter || t.state === truckFilter) && inCo(t));
    view.innerHTML = header('trucks') + `<main>
      <div class="pagebar"><div class="seg" role="group" aria-label="Show">${[['', `All ${trucks.length}`], ['empty', `Empty ${n('empty')}`], ['assigned', `With a driver ${n('assigned')}`], ['out', `Out of service ${n('out')}`]].map(([k, l]) => `<button data-act="truckFilter" data-k="${k}" class="${truckFilter === k ? 'on' : ''}" aria-pressed="${truckFilter === k}">${l}</button>`).join('')}</div>
        ${(S.me.companies || []).length ? `<select class="pick line" data-ch="truckCo" aria-label="Company"><option value="">All companies</option>${S.me.companies.map((c) => `<option value="${c.id}" ${String(c.id) === truckCo ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="none" ${truckCo === 'none' ? 'selected' : ''}>No company</option></select>` : ''}
        <span class="grow"></span>${admin ? '<button class="btn primary" data-act="truckAdd">Add truck</button>' : ''}</div>
      ${trucks.length ? `<div class="sheet"><table class="trucks"><thead><tr><th style="width:90px">Unit</th><th style="width:170px">Company</th><th>Truck</th><th>Where it is</th><th style="width:150px">Status</th><th>Driver</th><th>Notes</th>${admin ? '<th style="width:70px"></th>' : ''}</tr></thead><tbody>
        ${shown.map((t) => `<tr data-truck="${t.id}"><td><b class="unit">${esc(t.unit)}</b></td><td>${App.coTag(t.companyId) || '<span class="none">None</span>'}</td><td>${esc(t.details || '') || '<span class="none">Not filled in</span>'}</td><td>${esc(t.location || '') || '<span class="none">Not filled in</span>'}</td>
          <td><span class="tstate ${t.state}">${STATE[t.state]}</span></td>
          <td>${t.driver ? `${t.driver.id ? `<a class="nml" href="#/driver/${t.driver.id}"><b>${esc(t.driver.name)}</b></a>` : `<b>${esc(t.driver.name)}</b>`} ${badge(t.driver.status)}` : t.driverName ? esc(t.driverName) : '<span class="none">Nobody</span>'}</td>
          <td><div class="clamp small">${esc(t.notes || '')}</div></td>${admin ? '<td><button class="linkbtn" data-act="truckEdit">Edit</button></td>' : ''}</tr>`).join('') || `<tr><td colspan="${admin ? 8 : 7}" class="none" style="padding:24px;text-align:center">No trucks in this group.</td></tr>`}
        </tbody></table></div><p class="hint foot">A truck gets its driver on the driver's onboarding card. It is freed again when that driver is rejected or drops out${admin ? ', or when you release it here' : ''}.</p>`
        : `<div class="empty"><p>No trucks listed yet.</p>${admin ? 'Add your trucks, and mark the ones that already have a driver. Empty trucks can then be picked during onboarding.' : 'An admin adds the trucks. Empty ones can then be picked during onboarding.'}</div>`}
    </main>`;
  }
  on('truckFilter', (b) => { truckFilter = b.dataset.k; viewTrucks(); });
  onChange('truckCo', (el) => { truckCo = el.value; viewTrucks(); });
  function truckDialog(t, preset = {}, after = viewTrucks) {
    const has = t && (t.driver || t.driverName);
    dialog(`<form id="truckForm" class="dform"><h2>${t ? 'Truck ' + esc(t.unit) : 'Add a truck'}</h2><div class="grid2">
        <label class="fld">Unit number<input name="unit" type="text" required maxlength="30" value="${esc(t ? t.unit : '')}"></label>
        <label class="fld">Year, make, model<input name="details" type="text" maxlength="120" placeholder="2021 Freightliner Cascadia" value="${esc(t ? t.details || '' : '')}"></label>
        <label class="fld">Company<select name="companyId">${App.coOptions(t ? t.companyId : preset.companyId || null, 'No company')}</select></label>
        <label class="fld">Where it is<input name="location" type="text" maxlength="120" placeholder="Newark yard" value="${esc(t ? t.location || '' : '')}"></label>
        ${t && t.driver ? `<div class="fld">Driver<div class="ownerline"><b>${esc(t.driver.name)}</b> ${badge(t.driver.status)}</div></div>`
          : `<label class="fld">Current driver, if not in the leads list<input name="driverName" type="text" maxlength="80" placeholder="Leave empty if the truck is free" value="${esc(t ? t.driverName || '' : '')}"></label>`}
      </div>
      <label class="fld">Notes<textarea name="notes" maxlength="500" placeholder="Repairs due, plates, anything the next driver should know">${esc(t ? t.notes || '' : '')}</textarea></label>
      <label class="chk"><input type="checkbox" name="outOfService" ${t && t.outOfService ? 'checked' : ''}><span>Out of service (in the shop, not to be assigned)</span></label>
      <p class="err" id="truckErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button><span class="grow"></span>
        ${has ? '<button type="button" class="btn plain" id="truckRelease">Free this truck</button>' : ''}${t ? '<button type="button" class="btn danger" id="truckDelete">Remove truck</button>' : ''}</div></form>`, (d) => {
      const f = $('#truckForm', d); const fin = async (p, msg) => { try { await p; d.close(); toast(msg); after(); } catch (e) { $('#truckErr').textContent = e.message; } };
      f.onsubmit = (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(f)); b.outOfService = f.outOfService.checked; b.companyId = b.companyId ? +b.companyId : null; fin(api(t ? '/api/trucks/' + t.id : '/api/trucks', { method: t ? 'PATCH' : 'POST', body: b }), t ? 'Truck saved' : 'Truck added'); };
      if ($('#truckRelease')) $('#truckRelease').onclick = () => fin(api('/api/trucks/' + t.id, { method: 'PATCH', body: { release: true } }), 'Truck is free again');
      if ($('#truckDelete')) $('#truckDelete').onclick = () => { if (confirm(`Remove truck ${t.unit} from the list?`)) fin(api('/api/trucks/' + t.id, { method: 'DELETE' }), 'Truck removed'); };
    });
  }
  on('truckAdd', () => truckDialog(null));
  on('truckEdit', (b) => truckDialog(trucks.find((t) => t.id === +b.closest('[data-truck]').dataset.truck)));
  App.showTrucks = (co) => { truckCo = co; truckFilter = ''; App.go('#/trucks'); };
  App.truckDialog = truckDialog; // the company page adds and edits trucks with the same form

  App.route(/^#\/$/, viewHome);
  App.route(/^#\/onboarding$/, viewOnboarding);
  App.route(/^#\/trucks$/, viewTrucks);
})();
