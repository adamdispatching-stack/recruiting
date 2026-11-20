// Badges: five groups, each badge with five levels (Bronze to Diamond). A recruiter sees their own;
// an admin sees the team at a glance and can open anyone's.
(() => {
  const { esc, view, S, api, header, dateText } = App;
  const TIER = ['none', 'bronze', 'silver', 'gold', 'platinum', 'diamond'];
  const num = (n) => Number(n || 0).toLocaleString();

  function medal(b, size = 'md') {
    return `<span class="medal ${size} t-${TIER[b.level]}" aria-hidden="true"><span>${b.icon}</span>${b.level ? `<i>${'I II III IV V'.split(' ')[b.level - 1]}</i>` : ''}</span>`;
  }
  function card(b) {
    const prev = b.level ? b.need[b.level - 1] : 0;
    const pc = b.next ? Math.max(2, Math.min(100, ((b.have - prev) / (b.next - prev)) * 100)) : 100;
    const steps = b.need.map((n, i) => `<li class="${i < b.level ? 'got t-' + TIER[i + 1] : ''}" title="${['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'][i]}: ${num(n)} ${esc(b.unit)}"></li>`).join('');
    return `<li class="bcard${b.level ? '' : ' locked'}">${medal(b)}
      <div class="bbody"><b>${esc(b.name)}</b><span class="blvl${b.level ? ' t-' + TIER[b.level] : ''}">${b.level ? esc(b.levelName) : 'Not yet'}</span>
        <p>${esc(b.what)}</p>
        <ol class="bsteps" aria-label="Level ${b.level} of 5">${steps}</ol>
        <div class="bnext">${b.next ? `<span class="bbar"><i style="width:${pc}%"></i></span><span><b>${num(b.have)}</b> of ${num(b.next)} ${esc(b.unit)} for ${esc(b.nextName)}</span>` : `<span><b>${num(b.have)}</b> ${esc(b.unit)}. Top level reached.</span>`}</div></div></li>`;
  }
  async function viewBadges(params) {
    const admin = S.me.role === 'admin'; const who = params.get('user');
    if (admin && !who) return viewTeam();
    const live = App.drawing();
    const r = await api('/api/badges' + (who ? '?user=' + encodeURIComponent(who) : '')); if (!live()) return;
    const mine = r.person.id === S.me.id;
    document.title = 'Badges · FleetHire';
    view.innerHTML = header('badges') + `<main class="badgepage">
      ${admin ? '<a class="back" href="#/badges">← Team badges</a>' : ''}
      ${App.pageHead(mine ? 'Your badges' : `Badges: ${esc(r.person.name)}`, 'Every badge has five levels: Bronze, Silver, Gold, Platinum and Diamond. A level you reach stays yours.')}
      <section class="card bsum"><div class="bsumtop"><div class="btotal"><b>${r.earned}</b><span>of ${r.total} levels</span></div>
        <ul class="bgroups">${r.groups.map((g) => `<li><a href="#bg-${g.id}"><span aria-hidden="true">${g.icon}</span><b>${esc(g.name)}</b><span class="bbar"><i style="width:${(g.earned / g.total) * 100}%"></i></span><small>${g.earned} of ${g.total}</small></a></li>`).join('')}</ul></div>
        ${r.recent.length ? `<h4>Latest</h4><ul class="brecent">${r.recent.map((x) => `<li>${medal({ icon: x.icon, level: x.level }, 'sm')}<span><b>${esc(x.name)}</b><small>${esc(x.levelName)}, ${esc(dateText(String(x.at).slice(0, 10), { month: 'short', day: 'numeric' }))}</small></span></li>`).join('')}</ul>` : '<p class="hint">No badges yet. Start your day on time, log your calls, and hit your Facebook targets: the first ones come quickly.</p>'}
      </section>
      ${r.groups.map((g) => `<section class="bgroup" id="bg-${g.id}"><h2><span aria-hidden="true">${g.icon}</span>${esc(g.name)}<small>${g.earned} of ${g.total} levels</small></h2><p class="hint">${esc(g.what)}</p>
        <ul class="bcards">${r.badges.filter((b) => b.group === g.id).map(card).join('')}</ul></section>`).join('')}
    </main>`;
  }
  async function viewTeam() {
    const live = App.drawing(); const r = await api('/api/badges/team'); if (!live()) return;
    document.title = 'Badges · FleetHire';
    view.innerHTML = header('badges') + `<main>${App.pageHead('Team badges', 'Levels each recruiter has reached in each group. Open a person to see every badge.')}
      <div class="sheet"><table class="bteam"><thead><tr><th>Recruiter</th><th class="n">Levels</th>${r.groups.map((g) => `<th class="n">${g.icon} ${esc(g.name)}</th>`).join('')}<th>Latest badge</th></tr></thead><tbody>
        ${r.people.map((p) => `<tr data-u="${p.id}"><th scope="row"><a href="#/badges?user=${p.id}">${esc(p.name)}</a></th><td class="n"><b>${p.earned}</b><span class="mut"> / ${p.total}</span></td>
          ${p.groups.map((g) => `<td class="n">${g.earned}<span class="mut"> / ${g.total}</span></td>`).join('')}
          <td>${p.latest ? `${medal({ icon: p.latest.icon, level: p.latest.level }, 'xs')} ${esc(p.latest.name)}, ${esc(p.latest.levelName)}` : '<span class="none">None yet</span>'}</td></tr>`).join('') || `<tr><td colspan="${3 + r.groups.length}" class="hint">No recruiters yet.</td></tr>`}
      </tbody></table></div></main>`;
  }
  document.addEventListener('click', (e) => { const r = e.target.closest('table.bteam tr[data-u]'); if (r && !e.target.closest('a')) App.go('#/badges?user=' + r.dataset.u); });
  App.route(/^#\/badges$/, viewBadges);
  App.badgeMedal = medal;
})();
