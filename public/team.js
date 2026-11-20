// Team: what each person did (admin), one person's page with time by hour or day, and account management.
(() => {
  const { $, esc, view, S, api, toast, go, on, header, teamTime, teamWhen, dur, presenceHtml, dialog, feedHtml, tzName, plural } = App;
  let period = 'today';
  const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];
  const periodBar = () => `<div class="pagebar"><div class="seg" role="group" aria-label="Period">${PERIODS.map(([k, l]) => `<button data-act="period" data-k="${k}" class="${period === k ? 'on' : ''}" aria-pressed="${period === k}">${l}</button>`).join('')}</div>
    <span class="hint">Days and times are in ${esc(tzName())}.${S.me.role === 'admin' ? ' <a href="#/settings">Change</a>' : ''}</span><span class="grow"></span>`;
  on('period', (b) => { period = b.dataset.k; App.render(); });
  const num = (n) => (n ? n.toLocaleString() : '<span class="none">0</span>');

  // ---------- the team table ----------
  async function viewTeam() {
    if (S.me.role !== 'admin') return go('#/team/me');
    const live = App.drawing(); const r = await api('/api/team?period=' + period); if (!live()) return; const day = r.days === 1;
    document.title = 'Team · Recruiting';
    const cols = ['clicks', 'opened', 'notes', 'contacts', 'added', 'forward', 'onboarded', 'hired', 'due', 'cold', 'owned'];
    const act = r.people.filter((p) => p.active); const tot = Object.fromEntries(cols.map((k) => [k, act.reduce((a, p) => a + p[k], 0)]));
    const row = (p) => `<tr class="${p.active ? '' : 'off'}"><th scope="row"><a href="#/team/${p.id}">${esc(p.name)}</a>${p.role === 'admin' ? '<span class="rtag">Admin</span>' : ''}${p.active ? presenceHtml(p, r.now) : '<span class="pres never"><i></i>No access</span>'}</th>
      ${day ? `<td>${p.firstAt ? esc(teamTime(p.firstAt)) : '<span class="none">Not seen</span>'}</td><td>${p.lastAt ? esc(teamTime(p.lastAt)) : ''}</td>` : `<td class="n">${p.daysActive} of ${r.days}</td>`}
      <td class="n">${dur(p.openSeconds)}</td><td class="n strong">${dur(p.activeSeconds)}</td><td class="n">${num(p.clicks)}</td>
      <td class="n g">${num(p.opened)}</td><td class="n">${num(p.notes)}</td><td class="n">${num(p.contacts)}</td><td class="n">${num(p.added)}</td><td class="n">${num(p.forward)}</td>
      <td class="n g">${num(p.onboarded)}</td><td class="n">${num(p.hired)}</td>
      <td class="n g${p.due ? ' bad' : ''}">${num(p.due)}</td><td class="n${p.cold ? ' bad' : ''}">${num(p.cold)}</td><td class="n">${num(p.owned)}</td></tr>`;
    view.innerHTML = header('team') + `<main>${periodBar()}<button class="btn primary" data-act="personAdd">Add a person</button></div>
      <div class="sheet"><table class="team"><thead>
        <tr class="grp"><th></th><th colspan="${day ? 5 : 4}">On the site</th><th colspan="5" class="g">Work on leads</th><th colspan="2" class="g">Their leads reached</th><th colspan="3" class="g">Right now</th></tr>
        <tr><th>Person</th>${day ? '<th>First seen</th><th>Last seen</th>' : '<th class="n">Days worked</th>'}<th class="n" title="The site was open and on screen">On site</th><th class="n" title="Time with clicks, typing or scrolling">Active</th><th class="n">Clicks</th>
          <th class="n g" title="Different leads opened">Leads opened</th><th class="n">Notes</th><th class="n" title="Calls, texts and emails logged">Calls, texts</th><th class="n">Leads added</th><th class="n" title="Status changes they made that moved a lead forward">Moved forward</th>
          <th class="n g">Onboarding</th><th class="n">Hired</th>
          <th class="n g" title="Follow-ups due today or earlier">Follow-ups due</th><th class="n" title="In progress, no follow-up set, quiet for ${S.me.coldDays}+ days">Going cold</th><th class="n" title="Leads in progress they own">In progress</th></tr></thead>
        <tbody>${r.people.map(row).join('')}</tbody>
        <tfoot><tr><th scope="row">Team total</th><td colspan="${day ? 4 : 3}"></td><td class="n">${num(tot.clicks)}</td><td class="n g">${num(tot.opened)}</td><td class="n">${num(tot.notes)}</td><td class="n">${num(tot.contacts)}</td><td class="n">${num(tot.added)}</td><td class="n">${num(tot.forward)}</td>
          <td class="n g">${num(tot.onboarded)}</td><td class="n">${num(tot.hired)}</td><td class="n g">${num(tot.due)}</td><td class="n">${num(tot.cold)}</td><td class="n">${num(tot.owned)}</td></tr></tfoot></table></div>
      <p class="hint foot"><b>Active</b> counts only the time someone clicked, typed or scrolled while the site was on screen. <b>On site</b> also counts time the page was open and untouched.
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

  // ---------- one person ----------
  let shown = null;
  async function viewPerson(id) {
    const live = App.drawing(); const r = await api(`/api/team/${id}?period=${period}`); if (!live()) return; const p = r.person; shown = p;
    const admin = S.me.role === 'admin', self = p.id === S.me.id, day = r.days === 1;
    document.title = `${p.name} · Recruiting`;
    const fig = (v, l, hint) => `<div${hint ? ` title="${esc(hint)}"` : ''}><dd>${v}</dd><dt>${l}</dt></div>`;
    view.innerHTML = header('team') + `<main>
      ${admin ? '<a class="back" href="#/team">← Team</a>' : ''}
      <section class="dhead"><div class="top"><div class="who"><h2>${esc(p.name)}</h2>
          <div class="sub">${esc(p.email)}, ${p.role === 'admin' ? 'admin' : 'recruiter'}${p.active ? '' : ', no access'}</div>
          <div class="contact">${p.active ? presenceHtml(p, r.now) : ''}</div></div>
        ${admin && !self ? `<div class="acts"><button class="btn plain" data-act="personPw">Set password</button><button class="btn plain" data-act="personRole">${p.role === 'admin' ? 'Make recruiter' : 'Make admin'}</button><button class="btn ${p.active ? 'danger' : 'plain'}" data-act="personAccess">${p.active ? 'Remove access' : 'Give access back'}</button></div>` : ''}
      </div></section>
      ${periodBar()}</div>
      ${self && !admin ? '<p class="hint foot" style="margin:0 0 10px">This is your own activity. Your manager sees the same page.</p>' : ''}
      <section class="card"><dl class="figs wide">
        ${fig(dur(p.activeSeconds), 'active', 'Time with clicks, typing or scrolling')}${fig(dur(p.openSeconds), 'on site', 'The site was open and on screen')}
        ${day ? fig(p.firstAt ? esc(teamTime(p.firstAt)) : 'Not seen', 'first seen') + fig(p.lastAt ? esc(teamTime(p.lastAt)) : 'Not seen', 'last seen') : fig(`${p.daysActive} of ${r.days}`, 'days worked')}
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
