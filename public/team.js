// Team: what each person did (admin), one person's page with time by hour or day, and account management.
(() => {
  const { $, esc, view, S, api, toast, go, on, header, teamTime, teamWhen, dur, presenceHtml, dialog, feedHtml, tzName, plural } = App;
  let period = 'today';
  const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['month', 'This month'], ['lastmonth', 'Last month']];
  const periodBar = () => `<div class="pagebar"><div class="seg" role="group" aria-label="Period">${PERIODS.map(([k, l]) => `<button data-act="period" data-k="${k}" class="${period === k ? 'on' : ''}" aria-pressed="${period === k}">${l}</button>`).join('')}</div>
    <span class="hint">Days and times are in ${esc(tzName())}.${S.me.role === 'admin' ? ' <a href="#/settings">Change</a>' : ''}</span><span class="grow"></span>`;
  on('period', (b) => { period = b.dataset.k; App.render(); });
  const num = (n) => (n ? n.toLocaleString() : '<span class="none">0</span>');
  const hl = (n) => (n ? `<span class="hl">${n.toLocaleString()}</span>` : '<span class="none">0</span>'); // work done stands out
  // A day of attendance in words. Off = a working day without enough active time.
  const DAY = { worked: 'Worked', extra: 'Extra day', off: 'Off', approved: 'Off, approved', rest: 'Not a working day', today: 'Not worked yet', future: '', before: 'Before the account' };
  const hoursText = (sch) => (sch ? `${App.hm(sch.s)} to ${App.hm(sch.e)}` : 'Not a working day');
  function todayCell(d) { // the Team table on a one-day period
    if (!d) return '';
    const tag = { worked: ['ok', 'Worked'], extra: ['ok', 'Extra day'], off: ['bad', 'Off'], approved: ['warn', 'Off, approved'], rest: ['', 'Not a working day'], today: ['', 'Not worked yet'], before: ['', ''], future: ['', ''] }[d.status];
    return `<span class="dtag ${tag[0]}">${tag[1]}</span>${d.late ? '<span class="dtag bad">Late start</span>' : ''}${d.early ? '<span class="dtag warn">Left early</span>' : ''}<div class="small mut">${esc(hoursText(d.sch))}</div>`;
  }

  // idle time: total, how many stretches, and whether the person is idle right now
  const idleCell = (t) => (t.idle ? `${dur(t.idle)}${t.idleCount > 1 ? `<div class="small mut">${t.idleCount} times</div>` : ''}${t.idleNow ? '<div><span class="idletag now">Idle now</span></div>' : ''}` : '<span class="none">None</span>');
  const idleList = (d) => d.idles.map((i) => `${esc(hm(i.from))} to ${esc(hm(i.to))} (${dur(i.secs)}${i.now ? ', still idle' : ''}${i.alerted ? ', alert sent' : ''})`).join('<br>');

  // ---------- the team table ----------
  async function viewTeam() {
    if (S.me.role !== 'admin') return go('#/team/me');
    const live = App.drawing(); const r = await api('/api/team?period=' + period); if (!live()) return; const day = r.days === 1;
    document.title = 'Team · FleetHire';
    const cols = ['clicks', 'opened', 'notes', 'contacts', 'added', 'forward', 'onboarded', 'hired', 'due', 'cold', 'owned'];
    const act = r.people.filter((p) => p.active); const tot = Object.fromEntries(cols.map((k) => [k, act.reduce((a, p) => a + p[k], 0)]));
    const row = (p) => `<tr class="${p.active ? '' : 'off'}"><th scope="row"><a href="#/team/${p.id}">${esc(p.name)}</a>${p.role === 'admin' ? '<span class="rtag">Admin</span>' : ''}${p.active ? presenceHtml(p, r.now) : '<span class="pres never"><i></i>No access</span>'}</th>
      ${day ? `<td>${todayCell(p.day)}</td><td>${p.firstAt ? esc(teamTime(p.firstAt)) : '<span class="none">Not seen</span>'}</td><td>${p.lastAt ? esc(teamTime(p.lastAt)) : ''}</td>`
        : `<td class="n" title="${esc(p.weekText)}">${p.att.worked - p.att.extra} of ${p.att.scheduled}${p.att.extra ? `<div class="small mut">+${plural(p.att.extra, 'extra day')}</div>` : ''}</td><td class="n${p.att.off ? ' bad' : ''}">${num(p.att.off)}${p.att.approved ? `<div class="small mut">+${p.att.approved} approved</div>` : ''}</td><td class="n${p.att.late ? ' bad' : ''}">${num(p.att.late)}</td>`}
      <td class="n">${dur(p.openSeconds)}</td><td class="n strong">${dur(p.activeSeconds)}</td><td class="n${p.att.idle ? ' bad' : ''}">${day && p.day && p.day.idles.length ? `<button class="idlebtn" data-act="idleRow" aria-expanded="false" aria-controls="tidle-${p.id}">${dur(p.day.idle)}<span class="small"> · ${p.day.idles.length}×</span><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3.5 6 4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>${p.att.idleNow ? '<div><span class="idletag now">Idle now</span></div>' : ''}` : idleCell(p.att)}</td><td class="n">${num(p.clicks)}</td>
      <td class="n g">${hl(p.opened)}</td><td class="n">${hl(p.notes)}</td><td class="n">${hl(p.contacts)}</td><td class="n">${hl(p.added)}</td><td class="n">${hl(p.forward)}</td>
      <td class="n g">${hl(p.onboarded)}</td><td class="n">${hl(p.hired)}</td>
      <td class="n g${p.due ? ' bad' : ''}">${num(p.due)}</td><td class="n${p.cold ? ' bad' : ''}">${num(p.cold)}</td><td class="n">${num(p.owned)}</td></tr>
      ${day && p.day && p.day.idles.length ? `<tr class="idlerow" id="tidle-${p.id}" hidden><td colspan="18"><b>${esc(p.name)}, idle ${r.period === 'today' ? 'today' : 'yesterday'}</b>: no clicks, typing or scrolling on the website during working hours
        <ol class="idlelist">${p.day.idles.map((i) => `<li><b>${esc(hm(i.from))} to ${esc(hm(i.to))}</b><span>${dur(i.secs)}</span>${i.now ? '<span class="idletag now">Still idle</span>' : ''}${i.alerted ? '<span class="idletag">Alert sent</span>' : ''}</li>`).join('')}</ol></td></tr>` : ''}`;
    view.innerHTML = header('team') + `<main>${App.pageHead('Team performance', "Who is active, what they are working on, and the leads and hires they are moving forward.", `<button class="btn primary lg" data-act="personAdd">${App.plus} Add a person</button>`)}${periodBar()}</div>
      <div class="sheet"><table class="team"><thead>
        <tr class="grp"><th></th><th colspan="7">${day ? 'Presence and activity, ' + (r.period === 'today' ? 'today' : 'yesterday') : 'Days and time'}</th><th colspan="5" class="g">Recruiting work</th><th colspan="2" class="g">Hires</th><th colspan="3" class="g">Lead follow-up</th></tr>
        <tr><th>Person</th>${day ? '<th style="width:150px">Working day</th><th>First seen</th><th>Last seen</th>' : '<th class="n" title="Working days with at least the minimum active time (Settings, Working hours)">Days worked</th><th class="n" title="Working days without enough active time">Days off</th><th class="n">Late starts</th>'}<th class="n" title="The site was open and on screen">On site</th><th class="n" title="Time with clicks, typing or scrolling">Active</th><th class="n" title="Stretches of ${S.me.idleMinutes || 15}+ minutes inside working hours with no activity on the website">Idle</th><th class="n">Clicks</th>
          <th class="n g" title="Different leads opened">Leads opened</th><th class="n">Notes</th><th class="n" title="Calls, texts and emails logged">Calls, texts</th><th class="n">Leads added</th><th class="n" title="Status changes they made that moved a lead forward">Moved forward</th>
          <th class="n g">Onboarding</th><th class="n">Hired</th>
          <th class="n g" title="Follow-ups due today or earlier">Follow-ups due</th><th class="n" title="In progress, no follow-up set, quiet for ${S.me.coldDays}+ days">Going cold</th><th class="n" title="Leads in progress they own">In progress</th></tr></thead>
        <tbody>${r.people.map(row).join('')}</tbody>
        <tfoot><tr><th scope="row">Team total</th><td colspan="6"></td><td class="n">${num(tot.clicks)}</td><td class="n g">${num(tot.opened)}</td><td class="n">${num(tot.notes)}</td><td class="n">${num(tot.contacts)}</td><td class="n">${num(tot.added)}</td><td class="n">${num(tot.forward)}</td>
          <td class="n g">${num(tot.onboarded)}</td><td class="n">${num(tot.hired)}</td><td class="n g">${num(tot.due)}</td><td class="n">${num(tot.cold)}</td><td class="n">${num(tot.owned)}</td></tr></tfoot></table></div>
      <p class="hint foot">Only the website on a computer counts here: time, clicks, pages and leads opened on a phone or tablet are left out. <b>Active</b> counts only the time someone clicked, typed or scrolled while the site was on screen. <b>On site</b> also counts time the page was open and untouched.
        Time and clicks show presence, and they are easy to inflate. Judge the work by the middle columns and the results: notes, calls, leads moved forward, drivers hired.</p></main>`;
    App.every(60000, viewTeam);
  }

  // ---------- columns chart: one bar per hour or per day ----------
  function chartHtml(r) {
    const hour = r.unit === 'hour'; const rows = r.series; const peak = Math.max(0, ...rows.map((x) => x.active));
    const top = hour ? 3600 : Math.max(2, Math.ceil(peak / 3600 / 2) * 2) * 3600; // an hour holds 60 minutes; days scale to an even number of hours
    const tick = (s) => (hour ? `${s / 60} min` : `${s / 3600} h`);
    const step = rows.length > 12 ? (hour ? 3 : 5) : 1;
    const xlab = (x, i) => { if (i % step) return ''; if (hour) return x.label; const [dow, mon, d] = x.label.split(' '); return rows.length > 12 ? `${mon} ${d}` : `${dow} ${d}`; };
    const full = (x, i) => (hour ? `${x.label} to ${(rows[i + 1] || rows[0]).label}` : x.label);
    return `<figure class="viz"><figcaption><div><h3>Active time by ${hour ? 'hour' : 'day'}</h3><p class="hint">Time with clicks, typing or scrolling, in ${esc(tzName())}.</p></div><button class="linkbtn" data-act="vizTable" aria-expanded="false">Show as a table</button></figcaption>
      <div class="plot" tabindex="0" role="group" aria-label="Active time by ${hour ? 'hour' : 'day'}. Use the left and right arrow keys to read each bar.">
        <div class="ygrid">${[top, top / 2, 0].map((s, i) => `<span style="top:${i * 50}%"><i>${s ? tick(s) : '0'}</i></span>`).join('')}</div>
        <div class="bars">${rows.map((x, i) => `<div class="bar" data-i="${i}" data-label="${esc(full(x, i))}" data-active="${x.active}" data-open="${x.open}" data-clicks="${x.clicks}" data-views="${x.views}"><i style="height:${x.active ? Math.max(1.5, Math.min(100, (x.active / top) * 100)) : 0}%"></i></div>`).join('')}</div>
        ${peak ? '' : '<p class="vizempty">No activity in this period.</p>'}
        <div class="tip" role="status" aria-live="polite" hidden></div>
      </div>
      <div class="xax" aria-hidden="true">${rows.map((x, i) => `<span>${esc(xlab(x, i))}</span>`).join('')}</div>
      <div class="scroll viztable" hidden><table class="mini"><thead><tr><th>${hour ? 'Hour' : 'Day'}</th><th class="n">Active</th><th class="n">On site</th><th class="n">Clicks</th><th class="n">Pages opened</th></tr></thead>
        <tbody>${rows.filter((x) => !hour || x.active || x.open || x.clicks || x.views).map((x) => `<tr><td>${esc(hour ? full(x, rows.indexOf(x)) : x.label)}</td><td class="n">${dur(x.active)}</td><td class="n">${dur(x.open)}</td><td class="n">${x.clicks}</td><td class="n">${x.views}</td></tr>`).join('') || '<tr><td colspan="5" class="none">No activity in this period.</td></tr>'}</tbody></table></div></figure>`;
  }
  // Hover or arrow keys pick a bar; the readout gives the exact numbers (the table view has them all).
  function chartWire() {
    const plot = $('.viz .plot'); if (!plot) return; const tip = $('.tip', plot); const cols = [...plot.querySelectorAll('.bar')]; let cur = -1;
    const show = (i) => {
      cols.forEach((c, k) => c.classList.toggle('on', k === i)); cur = i;
      if (i < 0) { tip.hidden = true; return; }
      const c = cols[i]; tip.textContent = '';
      const line = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; tip.appendChild(d); };
      line('tipv', `${dur(+c.dataset.active)} active`); line('tipl', c.dataset.label);
      line('tipr', `On site ${dur(+c.dataset.open)}`); line('tipr', `${plural(+c.dataset.clicks, 'click')}, ${plural(+c.dataset.views, 'page')} opened`);
      tip.hidden = false;
      const pw = plot.clientWidth, tw = tip.offsetWidth, x = c.offsetLeft + c.offsetWidth / 2;
      tip.style.left = Math.max(0, Math.min(pw - tw, x - tw / 2)) + 'px';
      tip.style.bottom = Math.min(plot.clientHeight - 8, c.firstElementChild.offsetHeight + 10) + 'px';
    };
    cols.forEach((c, i) => { c.addEventListener('pointerenter', () => show(i)); });
    plot.addEventListener('pointerleave', () => show(-1));
    plot.addEventListener('focus', () => { if (cur < 0) show(Math.max(0, cols.findIndex((c) => +c.dataset.active > 0))); });
    plot.addEventListener('blur', () => show(-1));
    plot.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); show(Math.min(cols.length - 1, cur + 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); show(Math.max(0, cur - 1)); }
      else if (e.key === 'Escape') show(-1);
    });
  }
  on('vizTable', (b) => { const t = $('.viztable'); t.hidden = !t.hidden; b.textContent = t.hidden ? 'Show as a table' : 'Hide the table'; b.setAttribute('aria-expanded', String(!t.hidden)); });

  // ---------- the monthly report ----------
  let month = '', monthFor = null, shownMonth = null;
  const monthName = (ym) => new Date(ym + '-01T12:00:00Z').toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shiftMonth = (ym, n) => { const d = new Date(ym + '-01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
  const hm = App.hm;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '<span class="none">0%</span>');
  const DCLS = { worked: 'ok', extra: 'ok extra', off: 'bad', approved: 'warn', rest: 'rest', today: 'now', future: 'later', before: 'later' };
  function dayLabel(d) {
    if (d.status === 'approved') return d.offReason ? `Off, approved: ${d.offReason}` : 'Off, approved';
    return DAY[d.status];
  }
  function reportHtml(m, admin) {
    const t = m.totals; const ym = m.month; const thisMonth = m.today.slice(0, 7);
    const fig = (v, l, hint, bad) => `<div${hint ? ` title="${esc(hint)}"` : ''}${bad ? ' class="badfig"' : ''}><dd>${v}</dd><dt>${l}</dt></div>`;
    const blank = '<span class="none">–</span>';
    const row = (d, k) => {
      const has = d.active || d.first; const nIdle = d.idles.length;
      return `<tr class="dayrow ${DCLS[d.status]}${k % 2 ? ' alt' : ''}${d.date === m.today ? ' istoday' : ''}" data-d="${d.date}">
        <th scope="row"><button class="linkbtn dlink" data-act="dayOpen" data-d="${d.date}">${esc(App.dateText(d.date, { weekday: 'short' }))}</button></th>
        <td><span class="dtag ${DCLS[d.status].split(' ')[0]}">${esc(dayLabel(d))}</span>${d.late ? ' <span class="dtag bad">Late</span>' : ''}${d.early ? ' <span class="dtag warn">Left early</span>' : ''}${d.sch ? `<div class="small mut">${esc(hoursText(d.sch))}</div>` : ''}</td>
        <td>${d.first ? esc(hm(d.first)) : blank}</td><td>${d.last ? esc(hm(d.last)) : blank}</td>
        <td class="n strong">${has ? dur(d.active) : blank}</td><td class="n">${has ? dur(d.open) : blank}</td>
        <td class="n idlec">${d.idle ? `<button class="idlebtn" data-act="idleRow" aria-expanded="false" aria-controls="idle-${d.date}">${dur(d.idle)}<span class="small"> · ${nIdle}×</span><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3.5 6 4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : d.sch && has ? '<span class="none">None</span>' : blank}</td>
        <td class="n">${d.clicks || blank}</td><td class="n">${d.opened || blank}</td><td class="n">${d.contacts || blank}${d.calls ? `<div class="small mut">${d.calls} calls</div>` : ''}</td>
        <td class="n">${d.notes || blank}</td><td class="n">${d.added || blank}</td><td class="n">${d.moved || blank}</td></tr>
        ${nIdle ? `<tr class="idlerow" id="idle-${d.date}" hidden><td colspan="13"><b>Idle on ${esc(App.dateText(d.date, { weekday: 'long', month: 'long' }))}</b>: no clicks, typing or scrolling on the website during working hours
          <ol class="idlelist">${d.idles.map((i) => `<li><b>${esc(hm(i.from))} to ${esc(hm(i.to))}</b><span>${dur(i.secs)}</span>${i.now ? '<span class="idletag now">Still idle</span>' : ''}${i.alerted ? '<span class="idletag">Alert sent</span>' : ''}</li>`).join('')}</ol></td></tr>` : ''}`;
    };
    const shown = m.days; // every day of the month: later days too, so a day off can be approved ahead
    return `<section class="card report" aria-labelledby="rptTitle">
      <div class="rhead"><h3 id="rptTitle">Monthly report</h3>
        <div class="mnav noprint"><button class="btn plain sm" data-act="monthGo" data-m="${shiftMonth(ym, -1)}" ${ym > (m.firstMonth || ym) ? '' : 'disabled'} aria-label="Previous month">‹</button>
          <b>${esc(monthName(ym))}</b><button class="btn plain sm" data-act="monthGo" data-m="${shiftMonth(ym, 1)}" ${ym < thisMonth ? '' : 'disabled'} aria-label="Next month">›</button>
          ${ym !== thisMonth ? `<button class="linkbtn" data-act="monthGo" data-m="${thisMonth}">This month</button>` : ''}</div>
        <b class="printonly">${esc(m.person.name)}, ${esc(monthName(ym))}</b>
        <span class="grow"></span><button class="btn plain sm noprint" data-act="printReport">Print</button></div>
      <p class="hint hrs">Working hours: <b>${esc(m.weekText)}</b>${m.own ? ' (own hours)' : " (the team's hours)"}${admin ? ' <button class="linkbtn noprint" data-act="hoursEdit">Change</button>' : ''}.
        A working day counts as worked after ${plural(m.hours.minMinutes, 'minute')} of active time; starting more than ${plural(m.hours.grace, 'minute')} after the start time is a late start.${ym === thisMonth ? ' This month so far.' : ''}</p>
      <div class="rgrid">
        <div><h4>Attendance</h4><dl class="figs">
          ${fig(`${t.worked - t.extra} of ${t.scheduled}`, 'working days worked')}${fig(t.off, 'days off', 'Working days without enough active time', t.off)}
          ${fig(t.approved, 'approved days off')}${fig(t.extra, 'extra days', 'Days worked outside the working week')}${fig(t.late, 'late starts', '', t.late)}${fig(t.early, 'left early')}</dl></div>
        <div><h4>Time</h4><dl class="figs">
          ${fig(dur(t.active), 'active')}${fig(dur(t.idle), 'idle', `Stretches of ${m.hours.idleMinutes || 15}+ minutes in working hours with no activity${t.idleCount ? ` (${t.idleCount})` : ''}`, t.idle)}${fig(dur(t.avgActive), 'active per day worked')}${fig(pct(t.inHours, t.active), 'inside working hours', 'Share of active time that fell inside the working hours')}${fig(dur(t.open), 'on site')}</dl></div>
        <div><h4>Work</h4><dl class="figs">
          ${fig(t.contacts, 'calls, texts, emails', `${t.calls} of them calls`)}${fig(t.notes, 'notes')}${fig(t.added, 'leads added')}${fig(t.moved, 'moved forward')}${fig(t.onboarded, 'to onboarding', 'Their leads that started onboarding this month')}${fig(t.hired, 'hired')}</dl></div>
      </div>
      <div class="scroll"><table class="mini days daysfull"><thead><tr><th>Date</th><th>Day, working hours</th><th>Started</th><th>Ended</th><th class="n" title="Time with clicks, typing or scrolling">Active</th><th class="n" title="The site was open and on screen">On site</th><th class="n" title="Stretches of ${m.hours.idleMinutes || 15}+ minutes in working hours with no activity. Click to see the times.">Idle</th><th class="n">Clicks</th><th class="n" title="Different leads opened">Leads</th><th class="n" title="Calls, texts and emails logged">Contacts</th><th class="n">Notes</th><th class="n" title="Leads added">Added</th><th class="n" title="Leads moved forward">Moved</th></tr></thead>
        <tbody>${shown.map((d, k) => row(d, k)).join('') || '<tr><td colspan="13" class="hint">No days yet.</td></tr>'}</tbody>
        ${shown.length ? `<tfoot><tr><th scope="row" colspan="4">Month total</th><td class="n strong">${dur(t.active)}</td><td class="n">${dur(t.open)}</td><td class="n">${t.idle ? dur(t.idle) : '<span class="none">None</span>'}</td><td class="n">${(t.clicks || 0).toLocaleString()}</td><td class="n">${t.opened}</td><td class="n">${t.contacts}</td><td class="n">${t.notes}</td><td class="n">${t.added}</td><td class="n">${t.moved}</td></tr></tfoot>` : ''}</table></div>
      ${admin ? '<p class="hint foot noprint">Click a date to see the day, or to approve a day off (vacation, sick day). Approved days off are counted apart from days off. Click the idle time to see when it happened.</p>' : ''}
    </section>`;
  }
  on('monthGo', (b) => { month = b.dataset.m; App.render(); });
  on('printReport', () => { const rows = [...document.querySelectorAll('.idlerow')]; const was = rows.map((r) => r.hidden); rows.forEach((r) => { r.hidden = false; }); window.print(); rows.forEach((r, k) => { r.hidden = was[k]; }); });
  on('idleRow', (b) => { const r = $('#' + b.getAttribute('aria-controls')); if (!r) return; r.hidden = !r.hidden; b.setAttribute('aria-expanded', String(!r.hidden)); b.classList.toggle('open', !r.hidden); });
  on('dayOpen', (b) => {
    const m = shownMonth; const d = m.days.find((x) => x.date === b.dataset.d); if (!d) return;
    const admin = S.me.role === 'admin'; const canOff = admin && !['worked', 'extra', 'before'].includes(d.status);
    const line = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    const past = !['future', 'before'].includes(d.status);
    dialog(`<div class="dform"><h2>${esc(App.dateText(d.date, { weekday: 'long', month: 'long', year: 'numeric' }))}</h2>
      <p><span class="dtag ${DCLS[d.status].split(' ')[0]}">${esc(dayLabel(d) || 'Not yet')}</span>${d.late ? '<span class="dtag bad">Late start</span>' : ''}${d.early ? '<span class="dtag warn">Left early</span>' : ''}</p>
      <dl class="kv">${line('Working hours', esc(hoursText(d.sch)))}
        ${past ? line('Started', d.first ? esc(hm(d.first)) : 'Not seen') + line('Ended', d.last ? esc(hm(d.last)) : 'Not seen') + line('Active', dur(d.active)) + (d.sch ? line('Inside working hours', dur(d.inHours)) : '') + (d.sch ? line('Idle', d.idle ? `${dur(d.idle)}<div class="small mut">${idleList(d)}</div>` : 'None') : '') + line('On site', dur(d.open))
          + line('Calls, texts, emails', d.contacts) + line('Notes', d.notes) + line('Leads added', d.added) + line('Moved forward', d.moved) : ''}</dl>
      ${d.status === 'off' && d.active ? `<p class="hint">Active for ${dur(d.active)}, less than the ${plural(m.hours.minMinutes, 'minute')} a worked day needs.</p>` : ''}
      ${canOff && d.status !== 'approved' ? `<form id="offForm" class="form" style="margin-top:12px"><label class="fld">Reason (optional)<input name="reason" type="text" maxlength="80" list="offReasons" placeholder="Vacation, sick day…"></label>
          <datalist id="offReasons"><option value="Vacation"><option value="Sick day"><option value="Personal"><option value="Holiday"></datalist>
          <button class="btn primary">Approve day off</button></form>` : ''}
      <div class="drow">${admin && d.status === 'approved' ? '<button class="btn danger" data-act="offUndo">Take back the approved day off</button>' : ''}<button type="button" class="btn plain" data-act="closeDialog">Close</button></div></div>`, (dl) => {
      const f = $('#offForm', dl);
      if (f) f.onsubmit = async (e) => { e.preventDefault(); try { await api(`/api/team/${m.person.id}/days/${d.date}`, { method: 'PUT', body: { reason: new FormData(f).get('reason') } }); dl.close(); toast('Day off approved'); App.render(); } catch (err) { App.fail(err); } };
    });
    dayOpenFor = d.date;
  });
  let dayOpenFor = null;
  on('offUndo', async () => { const m = shownMonth; await api(`/api/team/${m.person.id}/days/${dayOpenFor}`, { method: 'DELETE' }); $('#dlg').close(); toast('Approved day off taken back'); App.render(); });
  on('hoursEdit', () => {
    const m = shownMonth;
    dialog(`<form id="hoursOwn" class="dform"><h2>Working hours for ${esc(m.person.name)}</h2>
      <label class="chk"><input type="checkbox" name="team" data-ch="useTeam" ${m.own ? '' : 'checked'}><span>Use the team's working hours (Settings)</span></label>
      <div id="ownWeek" style="margin-top:10px">${App.weekFields(m.own ? m.hours.week : m.teamWeek)}</div>
      <p class="hint">Times are in ${esc(tzName())}. Changing the hours also changes how past months are counted.</p>
      <p class="err" id="hoursErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Save hours</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (dl) => {
      const lock = () => { const team = $('[name=team]', dl).checked; $('#ownWeek', dl).classList.toggle('locked', team); $('#ownWeek', dl).querySelectorAll('input').forEach((i) => { i.disabled = team || (i.type === 'time' && !i.closest('.wrow').querySelector('[type=checkbox]').checked); }); };
      lock(); dl.lockWeek = lock;
      $('#hoursOwn', dl).onsubmit = async (e) => {
        e.preventDefault(); const team = $('[name=team]', dl).checked;
        try { await api(`/api/team/${m.person.id}/hours`, { method: 'PUT', body: { week: team ? null : App.readWeek($('#ownWeek', dl)) } }); dl.close(); toast('Working hours saved'); App.render(); }
        catch (err) { $('#hoursErr').textContent = err.message; }
      };
    });
  });
  App.onChange('useTeam', () => { const dl = $('#dlg'); if (dl && dl.lockWeek) dl.lockWeek(); });

  // ---------- one person ----------
  let shown = null;
  async function viewPerson(id) {
    if (monthFor !== id) { monthFor = id; month = ''; }
    const live = App.drawing();
    const [r, m] = await Promise.all([api(`/api/team/${id}?period=${period}`), api(`/api/team/${id}/month?m=${month}`)]); if (!live()) return;
    const p = r.person; shown = p; shownMonth = m; month = m.month;
    const admin = S.me.role === 'admin', self = p.id === S.me.id, day = r.days === 1;
    document.title = `${p.name} · FleetHire`;
    const fig = (v, l, hint) => `<div${hint ? ` title="${esc(hint)}"` : ''}><dd>${v}</dd><dt>${l}</dt></div>`;
    view.innerHTML = header('team') + `<main>
      ${admin ? '<a class="back" href="#/team">← Team</a>' : ''}
      <section class="dhead"><div class="top"><div class="who"><h2>${esc(p.name)}</h2>
          <div class="sub">${esc(p.email)}, ${p.role === 'admin' ? 'admin' : 'recruiter'}${p.active ? '' : ', no access'}</div>
          <div class="contact">${p.active ? presenceHtml(p, r.now) : ''}</div></div>
        ${admin && !self ? `<div class="acts"><button class="btn plain" data-act="personPw">Set password</button><button class="btn plain" data-act="personRole">${p.role === 'admin' ? 'Make recruiter' : 'Make admin'}</button><button class="btn ${p.active ? 'danger' : 'plain'}" data-act="personAccess">${p.active ? 'Remove access' : 'Give access back'}</button></div>` : ''}
      </div></section>
      ${reportHtml(m, admin)}
      <h2 class="sect">Activity</h2>
      ${periodBar()}</div>
      ${self && !admin ? '<p class="hint foot" style="margin:0 0 10px">This is your own activity. Your manager sees the same page.</p>' : ''}
      <section class="card"><dl class="figs wide">
        ${fig(dur(p.activeSeconds), 'active', 'Time with clicks, typing or scrolling')}${fig(dur(p.att.idle), 'idle', 'Stretches inside working hours with no activity on the website', p.att.idle)}${fig(dur(p.openSeconds), 'on site', 'The site was open and on screen')}
        ${day ? fig(p.firstAt ? esc(teamTime(p.firstAt)) : 'Not seen', 'first seen') + fig(p.lastAt ? esc(teamTime(p.lastAt)) : 'Not seen', 'last seen') : fig(`${p.att.worked - p.att.extra} of ${p.att.scheduled}`, 'days worked', 'Working days with enough active time') + fig(p.att.off, 'days off')}
        ${fig(p.clicks.toLocaleString(), 'clicks')}${fig(p.opened, 'leads opened')}${fig(p.notes, 'notes')}${fig(p.contacts, 'calls, texts, emails', `${p.calls} of them calls`)}${fig(p.added, 'leads added')}${fig(p.forward, 'moved forward', 'Status changes they made that moved a lead forward')}
        ${fig(p.onboarded, 'to onboarding', 'Their leads that started onboarding')}${fig(p.hired, 'hired', 'Their leads that were hired')}
      </dl></section>
      <section class="card">${chartHtml(r)}</section>
      <div class="cols">
        <section class="card"><h3>${self ? 'What you did' : 'What they did'}<span class="grow"></span><span class="small mut">${r.feed.length >= 300 ? 'latest 300' : plural(r.feed.length, 'action')}</span></h3>${feedHtml(r.feed, false)}</section>
        <div>
          <section class="card"><h3>Right now</h3><dl class="figs">${fig(p.owned, 'leads in progress')}${fig(p.due, 'follow-ups due')}${fig(p.cold, 'going cold')}</dl>
            ${admin ? `<p class="hint foot"><a href="#/leads?owner=${p.id}&working=1">Their leads in progress</a>, <a href="#/leads?owner=${p.id}&due=1">follow-ups due</a>, <a href="#/leads?owner=${p.id}&cold=1">going cold</a></p>` : ''}</section>
          <section class="card"><h3>Sign-ins</h3>${r.logins.length ? `<ol class="feed">${r.logins.map((l) => `<li><time>${esc(teamWhen(l.at))}</time><span>${l.kind === 'out' ? 'Signed out' : 'Signed in'}${l.browser ? `, ${esc(l.browser)}` : ''}${l.ip ? `<span class="small mut"> from ${esc(l.ip)}</span>` : ''}</span></li>`).join('')}</ol>` : '<p class="hint">No sign-ins in this period. A sign-in lasts 30 days, so a person can be active without signing in again.</p>'}</section>
        </div>
      </div></main>`;
    chartWire();
    App.every(60000, () => viewPerson(id));
  }
  const reloadMe = async () => { S.me = await api('/api/me'); };
  on('personAdd', () => dialog(`<form id="personForm" class="dform"><h2>Add a person</h2><div class="grid2">
      <label class="fld">Name<input name="name" type="text" required maxlength="80" autocomplete="off"></label>
      <label class="fld">Email (they sign in with it)<input name="email" type="email" required autocomplete="off"></label>
      <label class="fld">Password<input name="password" type="text" minlength="10" required autocomplete="off" placeholder="At least 10 characters"></label>
      <label class="fld">Role<select name="role"><option value="member">Recruiter</option><option value="admin">Admin</option></select></label></div>
      <p class="hint">A recruiter works leads and onboarding. An admin also sees this Team page, manages people, trucks and settings, and can export and delete. Give the password to the person yourself; they can change it after signing in.</p>
      <p class="err" id="personErr" role="alert"></p><div class="drow"><button class="btn primary">Create account</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
    $('#personForm', d).onsubmit = async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); try { await api('/api/users', { method: 'POST', body: b }); await reloadMe(); d.close(); toast(`${b.name} can now sign in`); App.render(); } catch (err) { $('#personErr').textContent = err.message; } };
  }));
  on('personPw', () => dialog(`<form id="pwSet" class="dform"><h2>New password for ${esc(shown.name)}</h2>
      <label class="fld">Password<input name="password" type="text" minlength="10" required autocomplete="off" placeholder="At least 10 characters"></label>
      <p class="hint">They are signed out everywhere and sign in again with this password.</p><p class="err" id="pwErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Set password</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
    $('#pwSet', d).onsubmit = async (e) => { e.preventDefault(); try { await api('/api/users/' + shown.id, { method: 'PATCH', body: { password: new FormData(e.target).get('password') } }); d.close(); toast('Password set'); } catch (err) { $('#pwErr').textContent = err.message; } };
  }));
  on('personAccess', async () => {
    if (shown.active && !confirm(`Remove ${shown.name}'s access? They are signed out and cannot sign in. Their leads, notes and history stay.`)) return;
    await api('/api/users/' + shown.id, { method: 'PATCH', body: { active: !shown.active } }); await reloadMe(); toast(shown.active ? 'Access removed' : 'Access given back'); App.render();
  });
  on('personRole', async () => {
    const to = shown.role === 'admin' ? 'member' : 'admin';
    if (to === 'admin' && !confirm(`Make ${shown.name} an admin? Admins see everyone's activity and can manage people, settings and exports.`)) return;
    await api('/api/users/' + shown.id, { method: 'PATCH', body: { role: to } }); await reloadMe(); toast(to === 'admin' ? 'Now an admin' : 'Now a recruiter'); App.render();
  });

  App.route(/^#\/team$/, viewTeam);
  App.route(/^#\/team\/(me|\d+)$/, (id) => viewPerson(id));
})();
