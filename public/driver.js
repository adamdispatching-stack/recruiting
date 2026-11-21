// An active driver's own page: his three Telegram groups, his mood day by day, alerts, what the bot noticed,
// the daily summaries, his profile for dispatchers, and his truck.
(() => {
  const { esc, view, S, api, on, header, dateText, dayOf, teamWhen, plural, badge } = App;
  const GK = { dispatch: ['Dispatch', 'Loads, appointments, truck talk'], eld: ['ELD', 'Logs and ELD checks'], accounting: ['Accounting', 'Pay and settlements'] };
  const AK = { container_mismatch: 'Container / number', wrong_location: 'Location', late_risk: 'Running late', appointment_change: 'Appointment', load_refused: 'Load refused', driver_upset: 'Driver upset', unprofessional_dispatcher: 'Dispatcher conduct', safety: 'Safety', other: 'Other' };
  const NK = { routine: 'Routine', request: 'Request', likes_loads: 'Likes', dislikes_loads: 'Does not like', home_time: 'Home time', reliability: 'Reliability', work_style: 'Work style', communication: 'Talking to him', other: 'Note' };
  const one = (mode) => (mode === 'Owner-operators' ? 'Owner operator' : mode === 'Company drivers' ? 'Company driver' : '');
  let cur = null;

  async function viewDriver(id) {
    const live = App.drawing(); let r;
    try { r = await api('/api/active/' + id); } catch (e) { if (!live()) return; view.innerHTML = header('active') + `<main><a class="back" href="#/active">← Active drivers</a><div class="empty"><p>${esc(e.message)}</p></div></main>`; return; }
    if (!live()) return;
    cur = r; const d = r.driver;
    document.title = `${d.name} · FleetHire`;
    const by = Object.fromEntries(r.groups.map((g) => [g.kind, g]));
    const cdl = App.expiry(d.cdlExpires), med = App.expiry(d.medExpires), road = App.road(d);
    const open = r.alerts.filter((a) => !a.resolved_at);
    const days = {}; for (const s of r.summaries) (days[s.day] = days[s.day] || []).push(s);
    const bad = r.mood.filter((x) => x.mood === 'unhappy' || x.mood === 'angry' || x.high);
    view.innerHTML = header('active') + `<main class="drvpage">
      <a class="back" href="#/active">← Active drivers</a>
      <section class="dhead"><div class="top"><div class="who"><h2>${esc(d.name)} ${App.coTag(d.companyId) || ''} ${d.leftOn ? `<span class="tstate out">Left ${esc(dateText(d.leftOn, { year: 'numeric' }))}</span>` : d.status !== 'Hired' ? badge(d.status) : ''}</h2>
          ${d.phone ? `<div class="contact">${App.phone(d.phone, '')}</div>` : ''}
          <div class="sub">${[esc(one(d.mode)), d.hiredAt && 'hired ' + esc(dateText(dayOf(d.hiredAt), { year: 'numeric' })), d.ownerId && 'recruited by ' + esc(App.person(d.ownerId))].filter(Boolean).join(' · ')}</div></div>
        <div class="acts">${r.canLead ? `<button class="btn plain" data-act="drvDates">Dates and home time</button><a class="btn plain" href="#/driver/${d.id}">Lead page</a>` : ''}</div></div>
        <dl class="tfacts"><div><dt>Truck</dt><dd>${r.truck ? `<a href="#/truck/${r.truck.id}"><b>${esc(r.truck.unit)}</b></a> ${oilTag(r.truck.oil)}<div class="small mut">${esc(r.truck.details || '')}</div>` : d.ownTruck ? `Own truck: ${esc(d.ownTruck)}` : '<span class="none">No truck</span>'}</dd></div>
          <div><dt>CDL expires</dt><dd class="exp ${cdl.state}">${cdl.html}</dd></div><div><dt>Medical card expires</dt><dd class="exp ${med.state}">${med.html}</dd></div>
          <div><dt>On the road</dt><dd>${road.html}</dd></div></dl></section>

      <section class="card"><h3>Telegram groups</h3><div class="gtiles">${['dispatch', 'eld', 'accounting'].map((k) => {
        const g = by[k];
        return g ? `<a class="gtile on" href="#/telegram/${g.id}"><b>${GK[k][0]}</b><span>${esc(g.title || GK[k][1])}</span><span class="small mut">${g.lastAt ? 'last message ' + esc(teamWhen(g.lastAt)) : 'no messages yet'}${g.today ? ` · ${plural(g.today, 'message')} today` : ''}</span></a>`
          : `<div class="gtile"><b>${GK[k][0]}</b><span>Not registered yet</span><span class="small mut">In the group, type <code>register ${k} ${esc(d.name.split(/\s+/)[0])}</code></span></div>`;
      }).join('')}</div></section>

      <section class="card moodcard"><h3>Mood, last 14 days<span class="grow"></span>${bad.length ? `<span class="latetag">${plural(bad.length, 'day')} with trouble</span>` : ''}</h3>
        ${App.moodDots(r.mood, true)}
        <div class="mdays">${r.mood.map((x, i) => `<span>${i === r.mood.length - 1 ? 'today' : esc(dateText(x.day, { month: undefined, day: 'numeric' }))}</span>`).join('')}</div>
        <p class="hint">From the evening summary of each of his groups (the worst of the day counts); a red edge means an important alert that day. Hover a day for the summary.</p></section>

      <div class="cols">
        <div>
          ${open.length || r.alerts.length ? `<section class="card"><h3>Alerts${open.length ? ` <span class="cnt">${open.length}</span>` : ''}</h3><ul class="list tgalerts">${r.alerts.slice(0, 15).map((a) => `<li data-al="${a.id}" class="${a.severity === 'high' ? 'hi' : ''}"><span class="grow"><span class="tgk ${a.severity === 'high' ? 'k-hi' : ''}">${esc(AK[a.kind] || a.kind)}</span> ${esc(a.text)} <span class="small mut">${esc(teamWhen(a.at))}</span></span>${a.resolved_at ? `<span class="small okt">Done${a.resolved_by ? ', ' + esc(a.resolved_by) : ''}</span>` : '<button type="button" class="btn plain sm" data-act="tgAlertDone">Done</button>'}</li>`).join('')}</ul></section>` : ''}
          <section class="card"><h3>Day by day<span class="grow"></span><span class="small mut">the AI's evening summaries</span></h3>
            ${Object.keys(days).length ? Object.entries(days).slice(0, 10).map(([day, list]) => `<article class="dday"><h4>${esc(dateText(day, { weekday: 'short', month: 'short', day: 'numeric' }))}</h4>${list.map((s) => `<p><span class="tgk k-${s.kind}">${esc((GK[s.kind] || [s.kind])[0])}</span> ${s.mood && App.MOODS[s.mood] ? `<span title="${App.MOODS[s.mood][1]}">${App.MOODS[s.mood][0]}</span> ` : ''}${esc(s.summary || '')}${(s.issues || []).length ? `<span class="small latetag">${plural(s.issues.length, 'thing')} open</span>` : ''}</p>`).join('')}</article>`).join('')
              : '<p class="hint">The bot writes a summary of each group every evening. Nothing yet.</p>'}</section>
          ${(r.updates || []).length ? `<section class="card"><h3>Load updates<span class="grow"></span><span class="small mut">from the dispatch group</span></h3><ul class="list upds">${r.updates.map((u) => `<li><span class="grow">${esc(App.updText(u))}${u.by_role ? ` <span class="small mut">(${esc(u.by_role)})</span>` : ''}</span><span class="small mut">${esc(teamWhen(u.at))}</span></li>`).join('')}</ul></section>` : ''}
          <section class="card"><h3>What the bot noticed<span class="grow"></span><span class="small mut">${plural(r.notes.length, 'note')}</span></h3>
            ${r.notes.length ? `<ul class="list">${r.notes.map((n) => `<li><span class="grow"><span class="nk">${esc(NK[n.kind] || 'Note')}</span> ${esc(n.text)}</span><span class="small mut">${esc(dateText(dayOf(n.at)))}</span></li>`).join('')}</ul>` : '<p class="hint">Routines, requests, loads he likes or refuses, how he works: the bot notes them from his groups.</p>'}</section>
        </div>
        <div>
          <section class="card dprof" id="dprof"><p class="hint">Loading the profile…</p></section>
          ${r.truckEvents.length ? `<section class="card"><h3>Truck issues and service</h3><ul class="list">${r.truckEvents.map((e) => `<li><span class="grow"><span class="tst ${e.status}">${e.status === 'fixed' ? 'Done' : e.status === 'scheduled' ? 'Scheduled' : 'Open'}</span> <b>${esc(e.title)}</b>${e.unit ? ` <span class="small mut">truck ${esc(e.unit)}</span>` : ''}</span><span class="small mut">${e.cost !== null ? '$' + e.cost.toLocaleString('en-US') + ' · ' : ''}${esc(dateText(e.day || dayOf(e.at)))}</span></li>`).join('')}</ul></section>` : ''}
        </div>
      </div></main>`;
    App.profileCard(d.id, document.getElementById('dprof'), true);
  }
  const oilTag = (o) => (o.state === 'unknown' ? '<span class="oil unknown">No oil record</span>' : `<span class="oil ${o.state}">${o.state === 'overdue' ? 'Oil overdue' : o.state === 'soon' ? 'Oil due soon' : 'Oil OK'}</span>`);
  on('drvDates', () => App.activeDialog(cur.driver, () => viewDriver(cur.driver.id)));
  App.route(/^#\/active\/(\d+)$/, (id) => viewDriver(+id));
})();
