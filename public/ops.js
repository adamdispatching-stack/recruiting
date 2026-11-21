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
  const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
  const firstName = () => esc(String(S.me.name || '').split(/\s+/)[0]);
  function trendHtml([now, before]) {
    if (!before && !now) return '<span class="trend"><b class="flat">No change</b> vs. prior 30 days</span>';
    if (!before) return '<span class="trend"><b>New</b> none in the prior 30 days</span>';
    const p = Math.round(((now - before) / before) * 100);
    return `<span class="trend"><b class="${p > 0 ? '' : p < 0 ? 'down' : 'flat'}">${p > 0 ? '↑ +' : p < 0 ? '↓ ' : ''}${p}%</b> vs. prior 30 days</span>`;
  }
  // Needs attention: one row per thing that is not zero, with a button to the list behind it.
  function attnList(items) {
    const shown = items.filter((x) => x[0]);
    return shown.length ? `<ul class="alist">${shown.map(([n, title, sub, href, btn, tone]) => `<li><i class="adot ${tone}"></i><div class="grow"><b>${title(n)}</b><span>${sub}</span></div><a class="btn plain sm" href="${href}">${btn} <span aria-hidden="true">→</span></a></li>`).join('')}</ul>`
      : '<p class="allok">Nothing needs attention right now.</p>';
  }
  function adminHome(r) {
    const a = r.attention; const c = Object.fromEntries(r.pipeline.map((x) => [x.status, x.n]));
    const stages = S.me.route.filter((s) => s !== 'Invited'); const inRoute = stages.reduce((n, s) => n + (c[s] || 0), 0); const max = Math.max(1, ...stages.map((s) => c[s] || 0));
    const srcMax = Math.max(1, ...r.sources.map((s) => s.leads)); const lostMax = Math.max(1, ...r.lost.map((s) => s.n));
    const off = S.me.other.filter((s) => c[s]).map((s) => `<a href="#/leads?status=${q(s)}">${esc(s)} ${c[s]}</a>`).join(', ');
    const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const items = [
      [a.due, (n) => `${pl(n, 'follow-up', 'follow-ups')} due`, 'Leads waiting for a call back today or earlier', '#/leads?due=1', 'View follow-ups', 'r'],
      [a.late, (n) => `${pl(n, 'driver', 'drivers')} past the arrival date`, 'Expected and not arrived yet', '#/onboarding', 'Review onboarding', 'r'],
      [a.expiring, (n) => `${pl(n, 'CDL or medical card', 'CDLs or medical cards')} expiring`, 'Expired, or expiring in the next 30 days', '#/active', 'View drivers', 'r'],
      [a.unassigned, (n) => `${pl(n, 'lead', 'leads')} with no recruiter`, 'In progress and nobody working them', '#/leads?owner=none&working=1', 'Assign', 'y'],
      [a.cold, (n) => `${pl(n, 'lead', 'leads')} going cold`, `Quiet for ${S.me.coldDays}+ days with no follow-up set`, '#/leads?cold=1', 'View leads', 'y'],
      [a.stuck, (n) => `${pl(n, 'onboarding', 'onboardings')} waiting 3 days`, 'No step done for 3 days', '#/onboarding', 'Review onboarding', 'y'],
      [a.dueHome, (n) => `${pl(n, 'driver', 'drivers')} due home`, 'In the next 3 days, or overdue', '#/active', 'View drivers', 'y'],
      [a.ready, (n) => `${pl(n, 'driver', 'drivers')} ready to hire`, 'Every onboarding step is done', '#/onboarding', 'Mark hired', 'g'],
      [a.arriving, (n) => `${pl(n, 'driver', 'drivers')} arriving this week`, 'Coordinate orientation and the truck', '#/onboarding', 'View details', 'g'],
      [a.missingDocs, (n) => `${pl(n, 'driver', 'drivers')} without document dates`, 'CDL or medical card expiry not entered', '#/active', 'Add dates', 'g'],
      [a.emptyTrucks, (n) => `${pl(n, 'empty truck', 'empty trucks')}`, 'Ready for a driver', '#/trucks', 'View trucks', 'g']];
    const urgent = items.filter((x) => x[0] && x[5] === 'r').length;
    const nextStep = (d) => d.followUp ? (d.followUp <= r.today ? `<span class="fu due">${esc(fuText(d.followUp))}</span>` : esc(fuText(d.followUp))) : '<span class="none">No follow-up</span>';
    return `<main class="dash"><div class="hero"><picture class="heroimg" aria-hidden="true"><source srcset="/img/hero.webp" type="image/webp"><img src="/img/hero.jpg" alt=""></picture>
        ${App.pageHead('Recruiting overview', '', '<button class="btn primary lg" data-act="addLead">' + App.plus + ' Add lead</button>')}
        <div class="greet"><h2>${greet()}, ${firstName()}</h2>${urgent ? `<span class="ok warn">${pl(urgent, 'thing needs', 'things need')} attention</span>` : '<span class="ok">Your team is on track</span>'}</div></div>
      <div class="tiles">${App.tile('lead', r.trend.leads[0], 'new leads, last 30 days', { href: '#/leads', trend: trendHtml(r.trend.leads) })}${App.tile('clip', r.trend.onboarded[0], 'started onboarding, 30 days', { href: '#/onboarding', trend: trendHtml(r.trend.onboarded) })}
        ${App.tile('award', r.trend.hired[0], 'hired, last 30 days', { trend: trendHtml(r.trend.hired) })}${App.tile('wheel', a.activeDrivers, 'active drivers', { href: '#/active' })}</div>
      <div class="dgrid">
        <section class="card"><h3>Recruiting pipeline</h3><p class="hint lead">Driver leads from first reply to hire</p>
          <div class="pipe">${stages.map((s) => `<a href="#/leads?status=${q(s)}"><span class="pn">${esc(s)}</span><span class="pc">${c[s] || 0}</span><span class="pb"><i style="width:${(c[s] || 0) ? Math.max(1.5, ((c[s] || 0) / max) * 100) : 0}%"></i></span><span class="pp">${inRoute ? Math.round(((c[s] || 0) / inRoute) * 100) : 0}%</span></a>`).join('')}</div>
          <p class="hint foot">${(c.Invited || 0).toLocaleString()} invited on Indeed with no reply yet (<a href="#/leads?status=Invited">show</a>).${off ? ` Off the route: ${off}.` : ''}</p></section>
        <section class="card"><h3><span class="warnico" aria-hidden="true">${TI.warn}</span>Needs attention</h3><p class="hint lead">Items that need your team's action</p>${attnList(items)}</section>
      </div>
      <div class="dgrid wide1">
        <section class="card"><h3>Recent leads<span class="grow"></span><a class="h3link" href="#/leads">View all leads →</a></h3><p class="hint lead">The latest driver leads in your pipeline</p>
          ${r.recent.length ? `<div class="scroll"><table class="mini recent"><thead><tr><th>Driver</th><th>Source</th><th>Stage</th><th>Recruiter</th><th>Next step</th></tr></thead><tbody>${r.recent.map((d) => `<tr><td><div class="who1">${App.avatar(d.name, 'sm')}<div><a class="nml" href="#/driver/${d.id}"><b>${esc(d.name)}</b></a><div class="small mut">${[d.mode === 'Owner-operators' ? 'Owner operator' : d.mode ? 'Company driver' : '', d.expYears !== null ? `${d.expYears} yrs exp` : ''].filter(Boolean).join(', ') || 'No details yet'}</div></div></div></td>
            <td><span class="srcpill">${esc(d.source || 'Not set')}</span></td><td>${badge(d.status)}</td><td>${App.assignPick(d)}</td><td class="small">${nextStep(d)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No leads yet.</p>'}</section>
        <section class="card"><h3>Team activity<span class="grow"></span><a class="h3link" href="#/team">Team →</a></h3><p class="hint lead">Recent updates from your recruiting team</p>${App.feedAv(r.feed.slice(0, 8))}</section>
      </div>
      <div class="dgrid three">
        <section class="card"><h3>Where leads came from</h3><p class="hint lead">Last 30 days</p>
            ${r.sources.length ? `<div class="mlist src">${r.sources.map((s) => meterRow(esc(s.source), s.leads, srcMax, `<span class="mextra">${s.engaged} interested or further, ${s.won} onboarding or hired</span>`, `#/leads?source=${q(s.source)}`)).join('')}</div>` : '<p class="hint">No new leads in the last 30 days.</p>'}</section>
        ${r.lost.length ? `<section class="card"><h3>Why leads were lost</h3><p class="hint lead">Last 30 days</p><div class="mlist">${r.lost.map((s) => meterRow(esc(s.reason), s.n, lostMax)).join('')}</div></section>` : ''}
      </div>
          <section class="card"><h3>Team today<span class="grow"></span><a class="h3link" href="#/team">All numbers →</a></h3>
            <div class="scroll"><table class="mini teamtoday"><thead><tr><th>Person</th><th>First seen</th><th class="n">Active</th><th class="n">Leads opened</th><th class="n">Notes</th><th class="n">Calls, texts</th><th class="n">Due</th></tr></thead><tbody>
              ${r.team.filter((p) => p.active).map((p) => `<tr><td><a href="#/team/${p.id}"><b>${esc(p.name)}</b></a>${presenceHtml(p, r.now)}</td><td>${p.firstAt ? esc(teamTime(p.firstAt)) : '<span class="none">Not today</span>'}</td><td class="n">${dur(p.activeSeconds)}</td><td class="n">${p.opened}</td><td class="n">${p.notes}</td><td class="n">${p.contacts}</td><td class="n${p.due ? ' bad' : ''}">${p.due}</td></tr>`).join('')}
            </tbody></table></div><p class="hint foot">Times in ${esc(tzName())}. Due = follow-ups due today or earlier on their leads.</p></section>
      </main>`;
  }
  // ---------- today's challenge: every Facebook target, the streak, badges and the team ----------
  const KT = { picture: 'Ad pictures (ChatGPT)', post: 'Group posts', comment: 'Comments on ads', contact: 'Drivers messaged', chat: 'Group chats joined', ppost: 'Personal posts', pcomment: 'Other comments' };
  const KI = { picture: '🎨', post: '📣', comment: '💬', contact: '🤝', chat: '👥', ppost: '🙂', pcomment: '🗨️' };
  // Badges on My day: the groups, the latest ones, and the closest next level
  function badgeStrip(bd) {
    if (!bd) return '';
    const close = bd.badges.filter((b) => b.next).map((b) => ({ b, left: (b.next - b.have) / b.next })).sort((x, y) => x.left - y.left)[0];
    return `<h4>Badges <span class="mut">${bd.earned} of ${bd.total} levels</span><span class="grow"></span><a class="h3link" href="#/badges">All badges →</a></h4>
      <div class="bstrip"><ul class="bgroups mini">${bd.groups.map((x) => `<li><a href="#/badges"><span aria-hidden="true">${x.icon}</span><b>${esc(x.name)}</b><span class="bbar"><i style="width:${(x.earned / x.total) * 100}%"></i></span><small>${x.earned}/${x.total}</small></a></li>`).join('')}</ul>
      <div class="bside">${bd.recent.length ? `<div class="brow">${bd.recent.slice(0, 5).map((x) => `<span title="${esc(x.name)}, ${esc(x.levelName)}">${App.badgeMedal({ icon: x.icon, level: x.level }, 'sm')}</span>`).join('')}</div>` : ''}
        ${close ? `<p class="small">Closest next: <b>${esc(close.b.icon)} ${esc(close.b.name)}</b> ${esc(close.b.nextName)}, ${(close.b.next - close.b.have).toLocaleString()} ${esc(close.b.unit)} to go</p>` : ''}</div></div>`;
  }
  function challengeCard(g, due, bd) {
    if (!g || !g.on) return bd ? `<section class="card chall">${badgeStrip(bd).replace('<h4>', '<h4 style="margin-top:0">')}</section>` : '';
    const R = 52, C = 2 * Math.PI * R, pc = Math.min(100, g.pct);
    const left = g.kinds.filter((k) => k.n < k.target).map((k) => `${k.target - k.n} ${App.KNAME[k.k][k.target - k.n === 1 ? 0 : 1]}`);
    const line = g.met ? (g.streak > 1 ? `All done. That's ${g.streak} working days in a row.` : 'All done for today. Do it again tomorrow to start a streak.')
      : g.atStake ? `Your ${g.streak}-day streak ends tonight unless you finish: ${left.join(', ')}.`
      : g.done === 0 ? `Start with one ${App.KNAME[g.kinds[0].k][0]}. ${g.target} to go today.`
      : pc >= 75 ? `Almost there. ${left.join(', ')} left.` : `${pc}% done. ${left.join(', ')} left.`;
    const dot = (x) => `<i class="sd ${x.s}" title="${esc(dateText(x.d, { weekday: 'short', month: 'short', day: 'numeric' }))}: ${x.s === 'met' ? 'all targets met' : x.s === 'miss' ? 'targets missed' : x.s === 'today' ? 'today' : 'not a working day'}"></i>`;
    return `<section class="card chall${g.met ? ' met' : ''}"><h3>Today's challenge<span class="grow"></span><a class="h3link" href="#/facebook">Facebook work →</a></h3>
      <p class="cline">${esc(line)}</p>
      <div class="cgrid">
        <a class="cring" href="#/facebook" aria-label="${pc}% of today's targets done"><svg viewBox="0 0 120 120" width="132" height="132" aria-hidden="true"><circle cx="60" cy="60" r="${R}" class="trk"/><circle cx="60" cy="60" r="${R}" class="val" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pc / 100)}" transform="rotate(-90 60 60)"/></svg>
          <span><b>${g.met ? '✓' : pc + '%'}</b><small>${g.done} of ${g.target}</small></span></a>
        <ul class="ctasks">${g.kinds.map((k) => `<li class="${k.n >= k.target ? 'done' : ''}"><span class="ci" aria-hidden="true">${k.n >= k.target ? '✓' : KI[k.k]}</span><span class="cn">${KT[k.k]}</span><b>${Math.min(k.n, 999)} <span>of ${k.target}</span></b><span class="cbar"><i style="width:${Math.min(100, (k.n / k.target) * 100)}%"></i></span></li>`).join('')}
          <li class="bonus${due ? '' : ' done'}"><span class="ci" aria-hidden="true">${due ? '📞' : '✓'}</span><span class="cn">Bonus: clear your call list</span><b>${due ? `${due} <span>to call</span>` : '<span>Clear</span>'}</b></li></ul>
        <div class="cstreak"><div class="sbig"><span aria-hidden="true">${g.streak ? '🔥' : '🌱'}</span><b>${g.streak}</b><small>day streak</small></div>
          <p class="small">Best: <b>${plural(g.best, 'day')}</b><br>This month: <b>${plural(g.month.met, 'day')}</b> all done${g.month.missed ? `, ${g.month.missed} missed` : ''}</p>
          <div class="sdots" aria-label="Last two weeks">${g.recent.map(dot).join('')}</div>
          <p class="hint">Days off and non-working days don't break a streak.</p></div>
      </div>
      ${badgeStrip(bd)}
      ${g.team.length > 1 ? `<h4>Team today</h4><ul class="cteam">${g.team.map((p) => `<li class="${p.me ? 'me' : ''}${p.met ? ' done' : ''}"><span>${esc(p.me ? 'You' : p.name.split(/\s+/)[0])}</span><b>${p.met ? '✓' : p.pct + '%'}</b><span class="cbar"><i style="width:${p.pct}%"></i></span></li>`).join('')}</ul>` : ''}
    </section>`;
  }
  function myDay(r) {
    const s = r.stats; const c = Object.fromEntries(r.pipeline.map((x) => [x.status, x.n]));
    const stages = S.me.route.filter((x) => x !== 'Invited'); const max = Math.max(1, ...stages.map((x) => c[x] || 0));
    return `<main class="dash"><div class="hero"><picture class="heroimg" aria-hidden="true"><source srcset="/img/hero.webp" type="image/webp"><img src="/img/hero.jpg" alt=""></picture>
        ${App.pageHead('My day', '', '<button class="btn primary lg" data-act="addLead">' + App.plus + ' Add lead</button>')}
        <div class="greet"><h2>${greet()}, ${firstName()}</h2>${s.due ? `<span class="ok warn">${plural(s.due, 'follow-up')} due</span>` : '<span class="ok">No follow-ups waiting</span>'}</div></div>
      <div class="tiles">${App.tile('cal', s.due, 'follow-ups due', { tone: s.due ? 'r' : '', href: '#/leads?owner=me&due=1' })}${App.tile('warn', s.cold, 'leads going cold', { tone: s.cold ? 'y' : '', href: '#/leads?owner=me&cold=1' })}
        ${App.tile('lead', s.owned, 'your leads in progress', { href: '#/leads?owner=me&working=1' })}${App.tile('clip', r.onboarding.length, 'your drivers in onboarding', { href: '#/onboarding' })}${App.tile('people', r.unassigned, 'leads up for grabs', { href: '#/leads?owner=none&working=1' })}</div>
      ${challengeCard(r.goal, s.due, r.badges)}
      <div class="dgrid">
        <div>
          <section class="card"><h3>Call list</h3>
            ${r.calls.length ? `<div class="scroll"><table class="mini calls"><thead><tr><th>Driver</th><th>Phone</th><th>Follow-up</th><th>Last note</th></tr></thead><tbody>${r.calls.map((d) => `<tr><td><a href="#/driver/${d.id}"><b>${esc(d.name)}</b></a><div>${badge(d.status)}</div></td>
              <td>${(d.phones || []).map((p) => App.phone(p)).join('') || '<span class="none">No phone</span>'}</td>
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
    const live = App.drawing();
    const [r, g, bd] = await Promise.all([api('/api/dashboard'), S.me.role === 'admin' ? null : api('/api/challenge').catch(() => null), S.me.role === 'admin' ? null : api('/api/badges').catch(() => null)]); if (!live()) return;
    if (g) { r.goal = g; App.setGoal(g); }
    r.badges = bd;
    document.title = (r.role === 'admin' ? 'Dashboard' : 'My day') + ' · FleetHire';
    view.innerHTML = header('home') + (r.role === 'admin' ? adminHome(r) : myDay(r));
    App.every(60000, viewHome);
  }

  // ---------- onboarding board: one row per driver, one column per step ----------
  const LOCKED = ['truck', 'arrival', 'arrived', 'amazon'];
  // Icons for the figure tiles
  const TI = {
    people: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5.4 6-5.4s5.4 2 6 5.4"/><path d="M16 4.9a3.2 3.2 0 0 1 0 6.2M18.2 14.8c1.6.8 2.6 2.6 2.8 5.2"/></svg>',
    cal: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.3v.2"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.2"/></svg>',
    truck: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6h11v10H2z"/><path d="M13 9h4.5l3.5 3.8V16h-8"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>',
    lead: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="8" r="3.4"/><path d="M3.5 20c.7-3.6 3.2-5.6 6.5-5.6 1.4 0 2.6.3 3.6 1"/><path d="M18 14v6M15 17h6"/></svg>',
    clip: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.8h6V4"/><path d="m8.5 12.5 2.2 2.2 4.8-4.8"/></svg>',
    award: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="9.5" r="6"/><path d="m9.6 9.6 1.7 1.7 3.2-3.3M8.5 14.6 7 21l5-2.6 5 2.6-1.5-6.4"/></svg>',
    wheel: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/><path d="M3.8 10.5c2.6-.9 5.3-1.2 8.2-1.2s5.6.3 8.2 1.2M10.4 13.6 7 19.6M13.6 13.6l3.4 6"/></svg>'
  };
  App.TI = TI;
  const tile = (icon, n, label, { tone = '', href = '', on = false, trend = '' } = {}) => `<${href ? `a href="${href}"` : 'div'} class="tile${on ? ' on' : ''}"><span class="ti ${tone}">${TI[icon]}</span><span class="tv"><span class="num">${n}</span><span class="lab">${label}</span>${trend}</span></${href ? 'a' : 'div'}>`;
  App.tile = tile;

  const open = new Set(); // drivers whose checklist is unfolded on the board
  async function viewOnboarding() {
    const live = App.drawing(); const r = await api('/api/onboarding'); if (!live()) return; const t = r.today;
    document.title = 'Onboarding · FleetHire';
    const arriving = r.drivers.filter((d) => !d.arrivedOn && d.expectedArrival && d.expectedArrival >= t && d.expectedArrival <= addDays(t, 7)).length;
    const late = r.drivers.filter((d) => !d.arrivedOn && d.expectedArrival && d.expectedArrival < t).length;
    const ready = r.drivers.filter((d) => d.items.length && d.items.every((i) => i.done)).length;
    const days = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);
    const SOON = 3; // arriving within this many days (or late, or no date yet) is worked now; later ones are followed up
    const isSoon = (d) => d.arrivedOn || !d.expectedArrival || days(t, d.expectedArrival) <= SOON;
    const whenText = (d) => {
      if (d.arrivedOn) return `<span class="okt">Arrived ${esc(dateText(d.arrivedOn))}</span>`;
      if (!d.expectedArrival) return '<span class="latetag">No date yet</span>';
      const n = days(t, d.expectedArrival); const day = esc(dateText(d.expectedArrival, { weekday: 'short' }));
      return `<b>${day}</b> <span class="${n < 0 ? 'latetag' : 'small mut'}">${n < 0 ? `Late ${plural(-n, 'day')}` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`}</span>`;
    };
    const step = (d, i, k) => `<li class="${i.done ? 'done' : ''}${d.items[k + 1] && d.items[k + 1].done && i.done ? ' linked' : ''}">
          <button class="dot" data-act="boardStep" data-step="${i.id}" data-done="${i.done ? 1 : 0}" ${LOCKED.includes(i.auto) ? 'disabled title="Ticks itself from the driver\'s page"' : ''} aria-pressed="${i.done}" aria-label="${esc(i.label)}: ${i.done ? 'done' : 'not done'}${LOCKED.includes(i.auto) ? ', ticks itself' : ''}">${i.done ? '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m3.5 8.4 3 3 6-6.4" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}</button>
          <span>${esc(i.label)}</span>${i.note ? `<small title="${esc(i.note)}">Note</small>` : ''}</li>`;
    const row = (d, k) => {
      const alt = k % 2 ? ' alt' : '';
      const done = d.items.filter((i) => i.done).length, total = d.items.length, isOpen = open.has(d.id);
      const next = d.items.find((i) => !i.done); const oo = d.mode === 'Owner-operators';
      const facts = [d.location, d.expYears !== null && d.expYears !== undefined ? `${plural(d.expYears, 'yr')} CDL` : '', d.relayBefore === true ? 'ran Relay before' : d.relayBefore === false ? 'new to Relay' : '', App.periodText(d)].filter(Boolean).map(esc).join(' · ');
      const truck = oo && !d.truck ? (d.ownTruck ? `<b>Own</b> <span class="small mut">${esc(d.ownTruck)}</span>` : '<span class="none">Own truck, not noted</span>')
        : d.truck ? `<b>${esc(d.truck.unit)}</b>${d.truck.details ? ` <span class="small mut">${esc(d.truck.details)}</span>` : ''}` : '<span class="latetag">No truck yet</span>';
      const azv = d.amazonStep === 'verified'; const az = (S.me.amazon || []).find((x) => x.key === d.amazonStep);
      return `<tr class="brow${alt}${azv ? ' azrow' : ''}${isOpen ? ' open' : ''}" data-driver="${d.id}" title="Open ${esc(d.name)}"><th scope="row"><a class="nml" href="#/driver/${d.id}"><b>${esc(d.name)}</b></a><span class="obday">day ${daysSince(d.startedAt) + 1}</span>
          <div class="small mut ofacts">${azv ? '<span class="azv sm">✓ Amazon verified</span>' : `<span class="azpend" title="Amazon Relay">Amazon: ${az ? esc(az.label) : 'not started'}</span>`}${(d.needed || []).length ? ` <span class="needtag" title="Verified on Amazon: this must be set">Set: ${esc(d.needed.join(', '))}</span>` : ''}${facts ? ` ${facts}` : ''}</div></th>
        <td>${(d.phones || []).slice(0, 1).map((p) => App.phone(p)).join('') || '<span class="none">No phone</span>'}</td>
        <td>${d.companyId ? App.coTag(d.companyId) : (d.needed || []).includes('company') ? '<span class="latetag">Not set</span>' : '<span class="none">Not set</span>'}</td>
        <td class="tk">${truck}</td>
        <td class="arr" title="${esc(d.arrivalNote || '')}">${whenText(d)}${d.arrivalNote ? `<div class="small mut clip1">${esc(d.arrivalNote)}</div>` : ''}</td>
        <td><div class="obprog"><span class="pbar"><i style="width:${total ? (done / total) * 100 : 0}%"></i></span><span class="cpill${done === total && total ? ' full' : ''}">${done}/${total}</span></div>
          <div class="small mut clip1">${next ? `Next: ${esc(next.label)}` : 'All done, ready to mark hired'}</div></td>
        <td class="small">${d.ownerId ? esc(person(d.ownerId)) : '<span class="none">Nobody</span>'}${d.telegramLink ? `<div><a class="small" href="${esc(d.telegramLink)}" target="_blank" rel="noopener noreferrer">Telegram</a></div>` : ''}</td>
        <td><button class="caret" data-act="boardOpen" aria-expanded="${isOpen}" aria-label="${isOpen ? 'Hide' : 'Show'} the checklist for ${esc(d.name)}"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m3.5 6 4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></td></tr>
        ${isOpen ? `<tr class="ostep${alt}"><td colspan="8"><div class="ohead"><b>Onboarding checklist (${plural(total, 'step')})</b><span class="grow"></span><span class="small mut">Done ${done}, not done ${total - done}</span></div>
          <ol class="stepper">${d.items.map((i, k) => step(d, i, k)).join('')}</ol>
          <p class="note-i">Truck and arrival steps tick themselves when you fill them in on the driver's page. Click a circle to tick or untick a step.</p></td></tr>` : ''}`;
    };
    const table = (list, title, oo) => list.length ? `<h3 class="obsub">${title} <span class="cnt">${list.length}</span></h3>
      <div class="sheet"><table class="board2 obt"><colgroup><col style="width:20%"><col style="width:148px"><col style="width:10%"><col style="width:15%"><col style="width:16%"><col><col style="width:10%"><col style="width:40px"></colgroup>
        <thead><tr><th>Driver</th><th>Phone</th><th>Company</th><th>${oo ? 'Their truck' : 'Truck'}</th><th>Arrival</th><th>Progress</th><th>Recruiter</th><th></th></tr></thead><tbody>${list.map((d, k) => row(d, k)).join('')}</tbody></table></div>` : '';
    const byType = (list) => {
      const co = list.filter((d) => d.mode !== 'Owner-operators'), oo = list.filter((d) => d.mode === 'Owner-operators');
      return table(co, 'Company drivers', false) + table(oo, 'Owner operators', true);
    };
    const soon = r.drivers.filter(isSoon), later = r.drivers.filter((d) => !isSoon(d));
    view.innerHTML = header('onboarding') + `<main>${App.pageHead('Driver onboarding', "Track each driver's onboarding progress and readiness to be hired.")}
      <div class="tiles mini">${tile('people', r.drivers.length, 'in onboarding', { on: true })}${tile('cal', arriving, 'arriving within 7 days')}${tile('warn', late, 'past the arrival date', { tone: late ? 'y' : '' })}${tile('check', ready, 'ready to mark hired')}${tile('truck', r.emptyTrucks, 'empty trucks', { href: '#/trucks' })}</div>
      ${r.drivers.length ? `<section class="obsec"><h2>Arriving in the next ${SOON} days <span class="cnt">${soon.length}</span></h2><p class="hint">Late arrivals, drivers with no arrival date yet, and drivers already at the truck are here too.</p>
          ${soon.length ? byType(soon) : '<p class="hint obnone">Nobody is arriving in the next 3 days.</p>'}</section>
        ${later.length ? `<section class="obsec later"><h2>Follow up: arriving in more than ${SOON} days <span class="cnt">${later.length}</span></h2><p class="hint">Check in with them before the day, so the truck is ready and they still plan to come.</p>${byType(later)}</section>` : ''}`
        : `<div class="emptycard"><div class="emptyart">${App.ART.truck}<h2>Nobody is in onboarding.</h2><p>Open a lead and choose Start onboarding. The driver gets these steps: ${esc(r.template.map((c) => c.label).join(', '))}.</p><a class="btn primary lg" href="#/leads">Go to leads</a></div></div>`}
      ${r.hired.length ? `<section class="card" style="margin-top:16px"><h3>Hired in the last 30 days</h3><ul class="list">${r.hired.map((d) => `<li><span class="grow"><a class="nml" href="#/driver/${d.id}"><b>${esc(d.name)}</b></a> ${App.coTag(d.companyId)} <span class="small mut">${d.ownerId ? esc(person(d.ownerId)) + "'s lead" : ''}</span></span>
        <span class="small mut">${d.truck ? 'Truck ' + esc(d.truck) + ', ' : ''}hired ${esc(dateText(dayOf(d.hiredAt)))}, ${plural(Math.max(1, Math.round((new Date(d.hiredAt) - new Date(d.startedAt)) / 864e5)), 'day')} in onboarding</span></li>`).join('')}</ul></section>` : ''}
    </main>`;
  }
  // a click anywhere on a driver's row opens the driver; links, buttons and the arrow keep their own job
  document.addEventListener('click', (e) => {
    const r = e.target.closest('table.obt tr.brow[data-driver]');
    if (r && !e.target.closest('a, button, input, select, label, .phw, .caret') && !String(window.getSelection() || '')) App.go('#/driver/' + r.dataset.driver);
  });
  on('boardOpen', (b) => { const id = +b.closest('[data-driver]').dataset.driver; if (open.has(id)) open.delete(id); else open.add(id); redraw(viewOnboarding); });
  on('boardStep', async (b) => { try { await api('/api/checklist/' + b.dataset.step, { method: 'PATCH', body: { done: b.dataset.done !== '1' } }); } catch (e) { fail(e); } await redraw(viewOnboarding); });
  onChange('boardStep', async (el) => { try { await api('/api/checklist/' + el.dataset.step, { method: 'PATCH', body: { done: el.checked } }); } catch (e) { fail(e); } await redraw(viewOnboarding); });

  // ---------- trucks ----------
  let trucks = []; let truckFilter = ''; let truckCo = '';
  const STATE = { empty: 'Empty', assigned: 'With a driver', out: 'Out of service' };
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const oilCell = (o, out) => {
    if (out) return '<span class="none">Out of service</span>';
    if (o.state === 'unknown') return '<span class="oil unknown">No record</span>';
    const parts = [];
    if (o.milesLeft !== null) parts.push(o.milesLeft <= 0 ? `${(-o.milesLeft).toLocaleString('en-US')} mi over` : `${o.milesLeft.toLocaleString('en-US')} mi`);
    parts.push(o.daysLeft <= 0 ? `${-o.daysLeft}d over` : `${o.daysLeft}d`);
    return `<span class="oil ${o.state}">${o.state === 'overdue' ? 'Overdue' : o.state === 'soon' ? 'Due soon' : 'OK'}</span><div class="small mut">${parts.join(' · ')}</div>`;
  };
  async function viewTrucks() {
    const live = App.drawing(); const r = await api('/api/trucks'); if (!live()) return;
    trucks = r.trucks; const sum = r.summary; const admin = S.me.role === 'admin'; const disp = S.me.role === 'dispatcher'; const canEdit = true; // anyone adds and edits trucks; only an admin removes one
    document.title = 'Trucks · FleetHire';
    const n = (s) => trucks.filter((t) => t.state === s).length;
    const oilDue = (t) => !t.outOfService && (t.oil.state === 'overdue' || t.oil.state === 'soon');
    const inCo = (t) => !truckCo || (truckCo === 'none' ? !t.companyId : t.companyId === +truckCo);
    const pass = (t) => !truckFilter || (truckFilter === 'oil' ? oilDue(t) : truckFilter === 'mine' ? t.dispatcherId === S.me.id : truckFilter === 'issues' ? t.openIssues > 0 : t.state === truckFilter);
    const shown = trucks.filter((t) => pass(t) && inCo(t));
    // one table per company, empty trucks on top, then by unit number
    const order = { empty: 0, assigned: 1, out: 2 };
    const byUnit = (a, b) => order[a.state] - order[b.state] || a.unit.length - b.unit.length || a.unit.localeCompare(b.unit);
    const groups = [...(S.me.companies || []).map((c) => [c, shown.filter((t) => t.companyId === c.id)]), [null, shown.filter((t) => !t.companyId || !(S.me.companies || []).some((c) => c.id === t.companyId))]]
      .filter(([, l]) => l.length).map(([c, l]) => [c, l.sort(byUnit)]);
    const mine = trucks.filter((t) => t.dispatcherId === S.me.id).length;
    const tile = (k, v, l, cls) => `<button type="button" class="ftile ${cls || ''}" data-act="truckFilter" data-k="${k}" aria-pressed="${truckFilter === k}"><b>${v}</b><span>${l}</span></button>`;
    view.innerHTML = header('trucks') + `<main>${App.pageHead('Trucks', 'Every truck: its company and driver, oil changes, shop visits and what it costs.', `${admin || disp ? '<button class="btn plain" data-act="fleetSettings">Oil change settings</button>' : ''}${canEdit ? `<button class="btn primary lg" data-act="truckAdd">${App.plus} Add truck</button>` : ''}`)}
      ${trucks.length ? `<div class="ftiles">${tile('oil', sum.overdue, 'oil changes overdue', sum.overdue ? 'bad' : '')}${tile('oil', sum.soon, 'due soon', sum.soon ? 'warn' : '')}${tile('issues', sum.issues, 'open issues', sum.issues ? 'warn' : '')}
        <div class="ftile static"><b>${money(sum.monthCost)}</b><span>spent this month</span></div><div class="ftile static${sum.unpaid ? ' warn' : ''}"><b>${money(sum.unpaid)}</b><span>not paid yet</span></div></div>` : ''}
      <div class="pagebar"><div class="seg" role="group" aria-label="Show">${[['', `All ${trucks.length}`], ...(mine || disp ? [['mine', `Mine ${mine}`]] : []), ['oil', `Oil due ${sum.overdue + sum.soon}`], ['assigned', `With a driver ${n('assigned')}`], ['empty', `Empty ${n('empty')}`], ['out', `Out of service ${n('out')}`]].map(([k, l]) => `<button data-act="truckFilter" data-k="${k}" class="${truckFilter === k ? 'on' : ''}" aria-pressed="${truckFilter === k}">${l}</button>`).join('')}</div>
        ${(S.me.companies || []).length ? `<select class="pick line" data-ch="truckCo" aria-label="Company"><option value="">All companies</option>${S.me.companies.map((c) => `<option value="${c.id}" ${String(c.id) === truckCo ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="none" ${truckCo === 'none' ? 'selected' : ''}>No company</option></select>` : ''}
        <span class="grow"></span></div>
      ${trucks.length ? (groups.map(([co, list]) => `<section class="cotable"><h3 class="cohead">${co ? App.coTag(co.id, true) : '<span class="co none">No company</span>'}<span class="small mut">${plural(list.length, 'truck')}${list.filter((t) => t.state === 'empty').length ? `, ${list.filter((t) => t.state === 'empty').length} empty` : ''}</span></h3>
        <div class="sheet"><table class="trucks"><thead><tr><th style="width:90px">Unit</th><th>Truck</th><th style="width:130px">Status</th><th>Driver</th><th style="width:150px">Oil change</th><th style="width:110px">Issues</th><th style="width:110px">This month</th>${canEdit ? '<th style="width:60px"></th>' : ''}</tr></thead><tbody>
        ${list.map((t) => `<tr data-truck="${t.id}" class="${t.state === 'empty' ? 'emptyrow' : ''}"><td><a class="unit" href="#/truck/${t.id}">${esc(t.unit)}</a></td><td>${esc(t.details || '') || '<span class="none">Not filled in</span>'}${t.dispatcher ? `<div class="small mut">Dispatcher: ${esc(t.dispatcher)}</div>` : ''}</td>
          <td><span class="tstate ${t.state}">${STATE[t.state]}</span></td>
          <td>${t.driver ? `${t.driver.id ? `<a class="nml" href="${App.driverHref(t.driver.id, t.driver.status)}"><b>${esc(t.driver.name)}</b></a>` : `<b>${esc(t.driver.name)}</b>`} ${badge(t.driver.status)}` : t.driverName ? `${esc(t.driverName)}${canEdit ? ' <button type="button" class="linkbtn small" data-act="truckEdit">Link to a driver</button>' : ''}` : '<span class="none">Nobody</span>'}</td>
          <td>${oilCell(t.oil, t.outOfService)}</td>
          <td>${t.openIssues ? `<a class="tiss open" href="#/truck/${t.id}">${t.openIssues} open</a>` : '<span class="none">None</span>'}</td>
          <td>${t.monthCost ? money(t.monthCost) : '<span class="none">$0</span>'}${t.unpaid ? `<div class="small bad">${money(t.unpaid)} not paid</div>` : ''}</td>
          ${canEdit ? '<td><button class="linkbtn" data-act="truckEdit">Edit</button></td>' : ''}</tr>`).join('')}
        </tbody></table></div></section>`).join('') || '<div class="empty"><p>No trucks in this group.</p></div>') + `<p class="hint foot">Each company has its own table, empty trucks first. Click a unit number for the truck's own page: oil changes, shop visits, drivers and costs.</p>`
        : `<div class="empty"><p>No trucks listed yet.</p>Add your trucks, and mark the ones that already have a driver. Empty trucks can then be picked during onboarding.</div>`}
    </main>`;
  }
  on('truckFilter', (b) => { truckFilter = truckFilter === b.dataset.k && b.classList.contains('ftile') ? '' : b.dataset.k; viewTrucks(); });
  onChange('truckCo', (el) => { truckCo = el.value; viewTrucks(); });
  let dispatchers = null;
  async function truckDialog(t, preset = {}, after = viewTrucks) {
    const has = t && (t.driver || t.driverName);
    if (!dispatchers) dispatchers = (await api('/api/fleet/dispatchers')).people;
    // active drivers without a truck, to link this one to
    const act = t && t.driver ? [] : (await api('/api/active')).drivers;
    const free = act.filter((d) => !d.truck);
    const match = t && t.driverName ? free.find((d) => d.name.trim().toLowerCase() === t.driverName.trim().toLowerCase()) : null;
    dialog(`<form id="truckForm" class="dform"><h2>${t ? 'Truck ' + esc(t.unit) : 'Add a truck'}</h2><div class="grid2">
        <label class="fld">Unit number<input name="unit" type="text" required maxlength="30" value="${esc(t ? t.unit : '')}"></label>
        <label class="fld">Year, make, model<input name="details" type="text" maxlength="120" placeholder="2021 Freightliner Cascadia" value="${esc(t ? t.details || '' : '')}"></label>
        <label class="fld">Company<select name="companyId">${App.coOptions(t ? t.companyId : preset.companyId || null, 'No company')}</select></label>
        <label class="fld">Dispatcher who looks after it<select name="dispatcherId"><option value="">Nobody yet</option>${dispatchers.map((p) => `<option value="${p.id}" ${t && t.dispatcherId === p.id ? 'selected' : ''}>${esc(p.name)}${p.role === 'admin' ? ' (admin)' : ''}</option>`).join('')}</select></label>
        <label class="fld">VIN<input name="vin" type="text" maxlength="30" autocomplete="off" value="${esc(t ? t.vin || '' : '')}"></label>
        <label class="fld">Plate<input name="plate" type="text" maxlength="30" autocomplete="off" value="${esc(t ? t.plate || '' : '')}"></label>
        <label class="fld">Where it is<input name="location" type="text" maxlength="120" placeholder="Newark yard" value="${esc(t ? t.location || '' : '')}"></label>
        ${t && t.driver ? `<div class="fld">Driver<div class="ownerline"><b>${esc(t.driver.name)}</b> ${badge(t.driver.status)}</div></div>`
          : `<label class="fld">Driver<select name="driverPick"><option value="">Nobody, the truck is free</option>${free.map((d) => `<option value="${d.id}" ${match && match.id === d.id ? 'selected' : ''}>${esc(d.name)}${d.companyId && App.company(d.companyId) ? ` (${esc(App.company(d.companyId).name)})` : ''}</option>`).join('')}<option value="other" ${t && t.driverName && !match ? 'selected' : ''}>Someone not in the active drivers list…</option></select></label>
          <label class="fld" id="dnWrap" ${t && t.driverName && !match ? '' : 'hidden'}>Driver's name<input name="driverName" type="text" maxlength="80" value="${esc(t ? t.driverName || '' : '')}"></label>`}
      </div>
      <label class="fld">Notes<textarea name="notes" maxlength="500" placeholder="Anything the next driver should know">${esc(t ? t.notes || '' : '')}</textarea></label>
      <label class="chk"><input type="checkbox" name="outOfService" ${t && t.outOfService ? 'checked' : ''}><span>Out of service (in the shop, not to be assigned)</span></label>
      <p class="err" id="truckErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button><span class="grow"></span>
        ${has ? '<button type="button" class="btn plain" id="truckRelease">Free this truck</button>' : ''}${t && S.me.role === 'admin' ? '<button type="button" class="btn danger" id="truckDelete">Remove truck</button>' : ''}</div></form>`, (d) => {
      const f = $('#truckForm', d); const fin = async (p, msg) => { try { await p; d.close(); toast(msg); after(); } catch (e) { $('#truckErr').textContent = e.message; } };
      if (f.driverPick) f.driverPick.onchange = () => { $('#dnWrap', d).hidden = f.driverPick.value !== 'other'; if (f.driverPick.value === 'other') f.driverName.focus(); };
      f.onsubmit = (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(f)); b.outOfService = f.outOfService.checked;
        if (f.driverPick) { const v = b.driverPick; delete b.driverPick; if (v === 'other') { /* typed name */ } else if (v) { b.driverId = +v; delete b.driverName; } else b.driverName = ''; } b.companyId = b.companyId ? +b.companyId : null; b.dispatcherId = b.dispatcherId ? +b.dispatcherId : null; fin(api(t ? '/api/trucks/' + t.id : '/api/trucks', { method: t ? 'PATCH' : 'POST', body: b }), t ? 'Truck saved' : 'Truck added'); };
      if ($('#truckRelease')) $('#truckRelease').onclick = () => fin(api('/api/trucks/' + t.id, { method: 'PATCH', body: { release: true } }), 'Truck is free again');
      if ($('#truckDelete')) $('#truckDelete').onclick = () => { if (confirm(`Remove truck ${t.unit} from the list? Its whole history goes with it.`)) fin(api('/api/trucks/' + t.id, { method: 'DELETE' }), 'Truck removed'); };
    });
  }
  on('truckAdd', () => truckDialog(null));
  on('truckEdit', (b) => truckDialog(trucks.find((t) => t.id === +b.closest('[data-truck]').dataset.truck)));
  App.showTrucks = (co) => { truckCo = co; truckFilter = ''; App.go('#/trucks'); };
  App.truckDialog = truckDialog;
  App.viewTrucks = () => viewTrucks(); // the company page adds and edits trucks with the same form

  App.route(/^#\/$/, viewHome);
  App.route(/^#\/onboarding$/, viewOnboarding);
  App.route(/^#\/trucks$/, viewTrucks);
})();
