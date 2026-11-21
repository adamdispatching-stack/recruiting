// Filling the trucks: what empty trucks cost, the team's monthly goal, the morning plan, coaching tips,
// and making sure every call ends with a note.
(() => {
  const { $, esc, S, api, toast, fail, on, dialog, plural, dateText, dayOf, teamWhen } = App;
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const first = (n) => String(n || '').split(/\s+/)[0];

  // ---------- empty trucks and the team goal ----------
  // The ring fills as trucks are filled this month; the empty ones are listed with what they cost.
  function goalRing(g) {
    const pct = Math.min(1, g.filled / Math.max(1, g.target)); const R = 34, C = 2 * Math.PI * R;
    return `<svg class="fring" viewBox="0 0 84 84" role="img" aria-label="${g.filled} of ${g.target} trucks filled this month"><circle cx="42" cy="42" r="${R}" class="bg"/><circle cx="42" cy="42" r="${R}" class="fg" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}" transform="rotate(-90 42 42)"/>
      <text x="42" y="40" text-anchor="middle" class="n">${g.filled}/${g.target}</text><text x="42" y="56" text-anchor="middle" class="l">filled</text></svg>`;
  }
  function emptyList(e, max = 6) {
    if (!e.trucks.length) return '<p class="hint">Every truck has a driver. Keep the pipeline full for the next one.</p>';
    return `<ul class="elist">${e.trucks.slice(0, max).map((t) => `<li class="${t.coming ? 'coming' : ''}"><a class="eunit" href="#/truck/${t.id}">${esc(t.unit)}</a>
      <span class="grow">${App.coTag(t.companyId) || ''}${t.coming ? `<span class="small">Coming: <a href="${App.driverHref(t.coming.id, t.coming.status)}">${esc(t.coming.name)}</a>${t.coming.owner ? ` (${esc(first(t.coming.owner))})` : ''}${t.coming.arrival ? `, arrives ${esc(dateText(t.coming.arrival))}` : ''}</span>` : `<span class="small mut">${t.details ? esc(t.details) : 'needs a driver'}</span>`}</span>
      <span class="eloss"><b>${t.days ? plural(t.days, 'day') : 'today'}</b>${t.lost ? `<span>${money(t.lost)} lost</span>` : ''}</span></li>`).join('')}</ul>
      ${e.trucks.length > max ? `<p class="small"><a href="#/trucks">All ${e.trucks.length} empty trucks →</a></p>` : ''}`;
  }
  // the card on the dashboard and on My day
  function fillCard(g, e, me) {
    const mine = me ? g.people.find((p) => p.id === me) : null;
    return `<section class="card fillcard"><h3>Fill the trucks<span class="grow"></span><a class="h3link" href="#/trucks">Trucks →</a></h3>
      <div class="fhead">${goalRing(g)}<div><p class="fbig">${e.count ? `<b>${plural(e.count, 'empty truck')}</b> cost about <b>${money(e.losingPerDay)} a day</b>` : '<b>No empty trucks</b>'}</p>
        <p class="small mut">Each one costs ${money(e.perDay)} a day (lease, insurance, fees: ${money(e.monthly)} a month) whether it runs or not.</p>
        ${mine ? `<p class="fme">You: <b>${mine.filled}</b> filled this month${mine.best ? `, your best month: ${mine.best}` : ''}${mine.filled && mine.filled >= mine.best && mine.best ? ' 🏆 personal best' : ''}</p>` : ''}</div></div>
      ${emptyList(e, 5)}
      ${g.people.length ? `<div class="fpeople">${g.people.map((p) => `<span class="${p.id === me ? 'me' : ''}${p.filled ? ' got' : ''}" title="Best month: ${p.best}">${esc(p.id === me ? 'You' : first(p.name))} <b>${p.filled}</b></span>`).join('')}</div>` : ''}
      ${g.fills.length ? `<p class="small fcredit">Latest: truck <b>${esc(g.fills[0].unit)}</b> filled with ${esc(g.fills[0].driver)}${g.fills[0].owner ? ` by <b>${esc(g.fills[0].owner)}</b>` : ''}, ${esc(teamWhen(g.fills[0].at))}</p>` : ''}
      ${S.me.role === 'admin' ? `<button type="button" class="linkbtn small" data-act="goalSet" data-target="${g.target}" data-month="${g.month}">Team goal: ${g.target} this month${g.setByAdmin ? '' : ' (the empty trucks)'}. Change</button>` : ''}</section>`;
  }
  on('goalSet', (b) => dialog(`<form id="goalForm" class="dform"><h2>Team goal for ${esc(b.dataset.month)}</h2>
      <label class="fld">Trucks to fill this month<input name="target" type="number" min="1" max="500" required value="${esc(b.dataset.target)}"></label>
      <p class="hint">Without a number, the goal is the trucks that are empty, plus those already filled this month.</p><p class="err" id="goalErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button><span class="grow"></span><button type="button" class="linkbtn" id="goalAuto">Use the empty trucks</button></div></form>`, (d) => {
    const save = async (target) => { try { await api('/api/fleet/goal', { method: 'PUT', body: { month: b.dataset.month, target } }); d.close(); toast('Team goal saved'); App.render(); } catch (e) { $('#goalErr').textContent = e.message; } };
    $('#goalForm', d).onsubmit = (e) => { e.preventDefault(); save(e.target.target.value); };
    $('#goalAuto', d).onclick = () => save(null);
  }));

  // ---------- the morning plan ----------
  function planCard(p) {
    if (!p.needed) return '';
    if (!p.plan) {
      return `<section class="card plancard"><h3>Plan your day first</h3>
        <p class="hint lead">Write your goal for today, and pick the calls you will make, with a time if you can. People who plan their calls this way make them far more often. Your manager sees your plan.</p>
        <form id="planForm"><label class="fld">My goal today<input name="goal" type="text" maxlength="300" required placeholder="Get 2 drivers to the Relay invite, call back every interested lead"></label>
        ${p.suggestions.length ? `<fieldset class="plist"><legend>Calls I will make</legend>${p.suggestions.map((d) => `<label class="pitem"><input type="checkbox" name="d" value="${d.id}" ${d.callback || (d.followUp && d.followUp <= p.day) ? 'checked' : ''}>
          <span class="grow"><b>${esc(d.name)}</b> <span class="small mut">${esc(d.status)}</span>${d.callback ? ` ${App.cbChip({ at: d.callback, state: 'due' })}` : d.followUp && d.followUp <= p.day ? ' <span class="fu due small">follow-up due</span>' : ''}</span>
          <input type="time" name="t${d.id}" aria-label="Time to call ${esc(d.name)}" value="${d.callback ? new Date(d.callback).toLocaleTimeString('en-GB', { timeZone: S.me.tz || 'America/New_York', hour: '2-digit', minute: '2-digit' }) : ''}"></label>`).join('')}</fieldset>` : '<p class="hint">No leads to call yet. Your goal can be about new leads.</p>'}
        <p class="err" id="planErr" role="alert"></p><button class="btn primary">Save my plan</button></form></section>`;
    }
    const pl = p.plan;
    return `<section class="card plancard done"><h3>Today's plan<span class="grow"></span>${pl.items.length ? `<span class="small mut">${pl.done} of ${pl.items.length} calls made</span>` : ''}</h3>
      <p class="pgoal">“${esc(pl.goal)}”</p>
      ${pl.items.length ? `<ul class="plan">${pl.items.map((i) => `<li class="${i.done ? 'ok' : ''}"><span class="tick" aria-hidden="true">${i.done ? '✓' : ''}</span><a class="grow" href="#/driver/${i.driverId}"><b>${esc(i.name)}</b></a>${i.time ? `<span class="small mut">${esc(i.time)}</span>` : ''}${i.done ? '<span class="sr">done</span>' : ''}</li>`).join('')}</ul>` : ''}
      <p class="hint">A call is ticked when you log a contact or a note on that lead. Calls with a time remind you then.</p>
      <button type="button" class="linkbtn small" data-act="planEdit">Change the plan</button></section>`;
  }
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'planForm') return; e.preventDefault();
    const f = e.target; const ids = [...f.querySelectorAll('input[name=d]:checked')].map((x) => +x.value);
    try { await api('/api/plan', { method: 'POST', body: { goal: f.goal.value, items: ids.map((id) => ({ driverId: id, time: f['t' + id] ? f['t' + id].value : '' })) } }); toast('Plan saved. Go get them!'); App.render(); }
    catch (er) { $('#planErr').textContent = er.message; }
  });
  on('planEdit', async () => { const r = await api('/api/plan'); const c = document.querySelector('.plancard'); if (c) c.outerHTML = planCard({ ...r, plan: null }); const g = document.querySelector('#planForm [name=goal]'); if (g && r.plan) { g.value = r.plan.goal; r.plan.items.forEach((i) => { const cb = document.querySelector(`#planForm input[name=d][value="${i.driverId}"]`); if (cb) cb.checked = true; const t = document.querySelector(`#planForm [name=t${i.driverId}]`); if (t && i.time) t.value = i.time; }); } });

  // ---------- coaching ----------
  function tipsCard(tips) {
    const open = tips.filter((t) => !t.seenAt); const old = tips.filter((t) => t.seenAt).slice(0, 3);
    if (!tips.length) return '';
    return `<section class="card tipcard"><h3>Coaching${open.length ? ` <span class="cnt">${open.length} new</span>` : ''}</h3>
      ${open.map((t) => `<div class="tip new" data-tip="${t.id}"><p>${esc(t.tip)}</p><div class="small mut">${esc(t.by || 'Your manager')}${t.driver ? ` · on <a href="#/driver/${t.driverId}">${esc(t.driver)}</a>` : ''} · ${esc(teamWhen(t.at))}</div>
        <div class="drow"><input type="text" maxlength="500" placeholder="Reply (optional)" aria-label="Reply to the tip"><button type="button" class="btn plain sm" data-act="tipGot">Got it</button></div></div>`).join('')}
      ${old.length ? `<details><summary class="small">Earlier tips</summary>${old.map((t) => `<div class="tip"><p>${esc(t.tip)}</p><div class="small mut">${esc(t.by || '')} · ${esc(teamWhen(t.at))}${t.reply ? ` · you: ${esc(t.reply)}` : ''}</div></div>`).join('')}</details>` : ''}</section>`;
  }
  on('tipGot', async (b) => { const box = b.closest('[data-tip]'); try { await api('/api/coaching/' + box.dataset.tip, { method: 'PATCH', body: { reply: box.querySelector('input').value } }); toast('Thanks!'); App.render(); } catch (e) { fail(e); } });
  // a manager gives a tip: from a lead (about that lead) or from a person's page
  function coachDialog(userId, userName, driverId, driverName) {
    dialog(`<form id="tipForm" class="dform"><h2>A tip for ${esc(userName)}</h2>${driverName ? `<p class="hint">About ${esc(driverName)}</p>` : ''}
      <label class="fld">One concrete thing to do differently, or to keep doing<textarea name="tip" rows="3" maxlength="1000" required placeholder="Ask about home time before you talk about pay. Drivers who ask about home time first care about it most."></textarea></label>
      <p class="hint">One tip at a time works best: specific, about a real call or chat, and kind. ${esc(first(userName))} is told and replies with "Got it".</p><p class="err" id="tipErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Send the tip</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
      $('#tipForm', d).onsubmit = async (e) => { e.preventDefault(); try { await api('/api/coaching', { method: 'POST', body: { userId, driverId, tip: e.target.tip.value } }); d.close(); toast('Tip sent'); App.render(); } catch (er) { $('#tipErr').textContent = er.message; } };
    });
  }
  on('coachLead', (b) => coachDialog(+b.dataset.user, b.dataset.name, +b.dataset.driver, b.dataset.dname));
  on('coachPerson', (b) => coachDialog(+b.dataset.user, b.dataset.name, null, null));
  on('coachPick', async (b) => { const r = await api('/api/coaching/pick?user=' + b.dataset.user); if (r.lead) App.go('#/driver/' + r.lead.id); else toast(`${b.dataset.name} worked no lead in the last week that was not reviewed`, true); });

  // ---------- every call gets its outcome ----------
  // Clicking a phone number (or copying it) starts a call; back on the website, the outcome is asked for.
  const driverOf = (el) => {
    const row = el.closest('[data-id]'); if (row && /^\d+$/.test(row.dataset.id)) return +row.dataset.id;
    const m = location.hash.match(/^#\/driver\/(\d+)/); if (m) return +m[1];
    const li = el.closest('tr, li'); const a = li && li.querySelector('a[href^="#/driver/"]'); return a ? +a.getAttribute('href').split('/')[2] : null;
  };
  let pending = null;
  document.addEventListener('click', (e) => {
    const el = e.target.closest('a[href^="tel:"], button.cpy'); if (!el || !S.me || S.me.role === 'dispatcher') return;
    if (el.matches('button.cpy') && !/\d{7}/.test((el.dataset.copy || '').replace(/\D/g, ''))) return;
    const id = driverOf(el); if (!id) return;
    api(`/api/drivers/${id}/call-start`, { method: 'POST', body: {} }).catch(() => {});
    pending = { id, at: Date.now() };
    // still here 3 minutes later (called from another phone): ask then
    const mine = pending; setTimeout(() => { if (pending === mine && document.visibilityState === 'visible') { pending = null; logDialog({ driverId: mine.id }); } }, +(window.__CALL_ASK_MS || 180000));
    // a link that only copies or dials does not leave the page: nothing to ask on the way back yet
  }, true);
  const back = () => { if (document.visibilityState !== 'visible' || !pending || Date.now() - pending.at < 15000) return; const p = pending; pending = null; logDialog({ driverId: p.id }); };
  document.addEventListener('visibilitychange', back); window.addEventListener('focus', back);
  let asking = false;
  async function logDialog(c) {
    if (asking || (document.querySelector('#callLog') && document.querySelector('#dlg[open], dialog[open]'))) return;
    asking = true; setTimeout(() => { asking = false; }, 1500);
    let name = c.name; if (!name) { try { name = (await api('/api/drivers/' + c.driverId)).driver.name; } catch (e) { asking = false; return; } }
    dialog(`<form id="callLog" class="dform"><h2>How did the call with ${esc(name)} go?</h2>
      <div class="outs" role="radiogroup" aria-label="Outcome">${['Talked', 'No answer', 'Left voicemail', 'Wrong number'].map((o, i) => `<label class="out"><input type="radio" name="o" value="${o}" ${i === 0 ? 'checked' : ''}><span>${o}</span></label>`).join('')}</div>
      <label class="fld" id="clNoteL">What he said, what you agreed, what comes next<textarea name="note" rows="4" maxlength="5000" placeholder="Interested, 5 years OTR, wants home every 2 weeks. Sending the Relay invite today, call back Friday."></textarea></label>
      <p class="hint" id="clHint">When you talked, a note is needed: the next person on this lead (and you, next week) needs to know what was said.</p>
      <p class="err" id="clErr" role="alert"></p>
      <div class="drow"><button class="btn primary">Log the call</button><span class="grow"></span><button type="button" class="linkbtn" id="clNo">I didn't call</button></div></form>`, (d) => {
      const f = $('#callLog', d);
      const upd = () => { const t = f.o.value === 'Talked'; $('#clHint', d).hidden = !t; f.note.required = t; f.note.minLength = t ? 20 : 0; };
      f.querySelectorAll('input[name=o]').forEach((x) => { x.onchange = upd; }); upd(); f.note.focus();
      f.onsubmit = async (e) => { e.preventDefault(); try { await api(`/api/drivers/${c.driverId}/notes`, { method: 'POST', body: { kind: 'call', outcome: f.o.value, body: f.note.value.trim() } }); d.close(); toast('Call logged'); App.render(); } catch (er) { $('#clErr').textContent = er.message; } };
      $('#clNo', d).onclick = async () => { if (c.id) await api(`/api/calls/${c.id}/skip`, { method: 'POST', body: {} }).catch(() => {}); else { const u = await api('/api/calls/unlogged'); for (const x of u.calls.filter((y) => y.driverId === c.driverId)) await api(`/api/calls/${x.id}/skip`, { method: 'POST', body: {} }); } d.close(); App.render(); };
    });
  }
  // calls started but not logged: a bar on My day and the lead page
  async function unloggedBar() {
    if (!S.me || S.me.role === 'dispatcher') return '';
    const r = await api('/api/calls/unlogged').catch(() => ({ calls: [] }));
    const old = r.calls.filter((c) => Date.now() - new Date(c.at) > 60000); if (!old.length) return '';
    return `<div class="unlog" role="status">${old.slice(0, 3).map((c) => `<span>You called <b>${esc(c.name)}</b> ${esc(teamWhen(c.at))}: how did it go? <button type="button" class="btn primary sm" data-act="logCallNow" data-id="${c.id}" data-driver="${c.driverId}" data-name="${esc(c.name)}">Log the call</button></span>`).join('')}${old.length > 3 ? `<span class="small">and ${old.length - 3} more</span>` : ''}</div>`;
  }
  on('logCallNow', (b) => logDialog({ id: +b.dataset.id, driverId: +b.dataset.driver, name: b.dataset.name }));

  Object.assign(App, { fillCard, emptyList, goalRing, planCard, tipsCard, unloggedBar, coachDialog, money });
})();
