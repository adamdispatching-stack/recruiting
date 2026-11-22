// Road cases: what the bot saw happen to a driver (a breakdown, a breakdown on the NJ Turnpike, an accident, running
// late...), the playbook steps for it, which are done, what is next and how long it is waiting, the if/else rules, and
// the message for the driver. Also the playbooks themselves (admins edit them).
(() => {
  const { $, esc, view, S, api, toast, fail, on, onChange, header, dialog, plural } = App;
  const ago = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 60 ? `${m} min` : m < 1440 ? `${(m / 60).toFixed(m < 600 ? 1 : 0)} h` : `${Math.round(m / 1440)} d`; };
  const mins = (m) => (m < 60 ? `${m} min` : `${(m / 60).toFixed(m < 600 ? 1 : 0)} h`);

  function caseHtml(c, { compact = false } = {}) {
    const late = c.next && c.waitMin && c.waiting > c.waitMin;
    const steps = (c.steps || []).map((s, i) => { const n = i + 1, done = (c.done || []).includes(n), nx = n === c.next;
      return `<li class="${done ? 'done' : nx ? 'next' : ''}"><label><input type="checkbox" data-ch="caseStep" data-case="${c.id}" data-step="${n}" ${done ? 'checked' : ''} ${c.status === 'open' ? '' : 'disabled'}>
        <span>${esc(s.text)}${s.wait && !done ? ` <span class="small mut">(${mins(s.wait)})</span>` : ''}</span></label>${nx && c.status === 'open' ? `<div class="small ${late ? 'bad' : 'mut'}">${late ? `Waiting ${mins(c.waiting)}, longer than it should` : `Next step, waiting ${mins(c.waiting)}`}</div>` : ''}</li>`; }).join('');
    return `<article class="case card${late ? ' late' : ''}" data-case="${c.id}"><header><h3>${esc(c.title)}</h3>
        <span class="small mut">${c.driver ? `<a href="${App.driverHref(c.driver_id, c.driver_status)}">${esc(c.driver)}</a>` : 'Driver'}${c.unit ? ` · truck ${esc(c.unit)}` : ''}${c.dispatcher ? ` · ${esc(c.dispatcher)}` : ''} · ${c.status === 'open' ? `open ${ago(c.opened_at)}` : `${c.status === 'resolved' ? 'resolved' : c.status === 'stale' ? 'closed, nothing new for 3 days' : 'not a case'} ${ago(c.closed_at)} ago${c.closed_by ? ` by ${esc(c.closed_by)}` : ''}`}</span>
        <a class="small" href="#/telegram/${c.chat_id}">Group</a></header>
      ${c.summary ? `<p>${esc(c.summary)}</p>` : ''}${c.note ? `<p class="small"><b>Last news:</b> ${esc(c.note)}</p>` : ''}
      <ol class="csteps">${steps}</ol>
      ${(c.rules || []).length ? `<details${compact ? '' : ' open'}><summary>If / else</summary><ul class="crules">${c.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}
      ${c.draft ? `<div class="cdraft" data-cdraft="${c.draft.id}"><label class="small mut">Message for the driver (the bot is in Watch in this group, so it waits for you)<textarea rows="2">${esc(c.draft.text)}</textarea></label>
        <div class="drow"><button class="btn primary sm" data-act="caseSend">Send in the group</button><button class="btn plain sm" data-act="caseSkip">Not needed</button></div></div>` : ''}
      ${c.lesson ? `<p class="small"><b>Learned:</b> ${esc(c.lesson)}</p>` : ''}
      ${c.status === 'open' ? `<div class="drow"><button class="btn plain sm" data-act="caseDone">Resolved</button><button class="btn plain sm" data-act="caseNot">Not a case</button></div>` : ''}</article>`;
  }
  // open cases for a driver, a group, or everyone (dashboard, trucks, group and driver pages)
  App.casesCard = async (el, qs = '', { title = 'Road cases', empty = '' } = {}) => {
    if (!el) return; let r; try { r = await api('/api/cases?' + qs); } catch (e) { el.innerHTML = ''; return; }
    el.innerHTML = r.cases.length ? `<section class="casesbox"><div class="row sb"><h2 class="sect">${esc(title)} <span class="cnt">${r.cases.length}</span></h2><a class="small" href="#/cases">All cases and the playbook</a></div>${r.cases.slice(0, 6).map((c) => caseHtml(c, { compact: true })).join('')}</section>` : empty;
  };
  const reload = () => App.render();
  onChange('caseStep', async (el) => { try { await api(`/api/cases/${el.dataset.case}/step`, { method: 'POST', body: { step: +el.dataset.step, done: el.checked } }); reload(); } catch (e) { fail(e); } });
  on('caseSend', async (btn) => { const b = btn.closest('[data-cdraft]'); btn.disabled = true;
    try { await api(`/api/cases/drafts/${b.dataset.cdraft}/send`, { method: 'POST', body: { text: b.querySelector('textarea').value } }); toast('Sent in the Telegram group'); b.remove(); } catch (e) { fail(e); btn.disabled = false; } });
  on('caseSkip', async (btn) => { const b = btn.closest('[data-cdraft]'); try { await api(`/api/cases/drafts/${b.dataset.cdraft}/skip`, { method: 'POST' }); b.remove(); } catch (e) { fail(e); } });
  const closeDialog = (id, notACase) => dialog(`<form id="caseClose" class="dform"><h2>${notACase ? 'Not a case' : 'Case resolved'}</h2>
      ${notACase ? '<p class="hint">The bot opened it by mistake. It is closed and not counted.</p>' : `<label class="fld">How did it end? (optional)<input name="note" maxlength="300"></label>
      <label class="fld">What should we do next time? (optional, goes to Knowledge to approve, so the bot and the team learn)<textarea name="lesson" rows="3"></textarea></label>`}
      <p class="err" id="ccErr" role="alert"></p><div class="drow"><button class="btn primary">${notACase ? 'Close it' : 'Save'}</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
    $('#caseClose', d).onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
      try { await api(`/api/cases/${id}/close`, { method: 'POST', body: { notACase, note: f.get('note'), lesson: f.get('lesson') } }); d.close(); toast(notACase ? 'Closed' : 'Resolved'); reload(); } catch (er) { $('#ccErr').textContent = er.message; } };
  });
  on('caseDone', (btn) => closeDialog(btn.closest('[data-case]').dataset.case, false));
  on('caseNot', (btn) => closeDialog(btn.closest('[data-case]').dataset.case, true));

  // ---------- the page: open, closed, the playbook ----------
  let tab = 'open';
  on('caseTab', (b) => { tab = b.dataset.k; App.render(); });
  async function viewCases() {
    const live = App.drawing(); const admin = S.me.role === 'admin';
    const [r, pb] = await Promise.all([api('/api/cases' + (tab === 'closed' ? '?status=closed' : '')), tab === 'playbook' ? api('/api/playbooks') : null]); if (!live()) return;
    document.title = 'Road cases · FleetHire';
    const tabs = `<div class="seg" role="group">${[['open', 'Open'], ['closed', 'Closed, last 7 days'], ['playbook', 'The playbook']].map(([k, l]) => `<button data-act="caseTab" data-k="${k}" class="${tab === k ? 'on' : ''}" aria-pressed="${tab === k}">${l}</button>`).join('')}</div>`;
    let body;
    if (tab === 'playbook') {
      body = `${admin ? `<p><button class="btn primary" data-act="pbNew">${App.plus} New case</button></p>` : ''}
        ${pb.playbooks.map((p) => `<article class="card pbook${p.active ? '' : ' off'}" data-pb="${p.id}"><header><h3>${esc(p.title)}</h3><span class="small mut">${p.active ? '' : 'Off · '}${plural(p.cases30, 'case')} in 30 days${p.updated_by ? ` · changed by ${esc(p.updated_by)}` : p.source === 'starter' ? ' · starting version' : ''}</span>
          ${admin ? `<span class="grow"></span><button class="btn plain sm" data-act="pbEdit">Edit</button><button class="btn plain sm" data-act="pbOnOff">${p.active ? 'Turn off' : 'Turn on'}</button>` : ''}</header>
          <p class="small"><b>When:</b> ${esc(p.when_text)}</p>
          <table class="mini pbsteps"><thead><tr><th>Step</th><th>Message to the driver</th><th class="n">Raise it after</th></tr></thead><tbody>${(p.steps || []).map((s, i) => `<tr><td><b>${i + 1}.</b> ${esc(s.text)}</td><td class="small">${esc(s.driver || '')}</td><td class="n">${s.wait ? mins(s.wait) : '—'}</td></tr>`).join('')}</tbody></table>
          ${(p.rules || []).length ? `<h4>If / else</h4><ul class="crules">${p.rules.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</article>`).join('')}`;
      App.lastPlaybooks = pb.playbooks;
    } else body = r.cases.length ? r.cases.map((c) => caseHtml(c)).join('') : `<section class="card"><p class="hint">${tab === 'open' ? 'No open cases. When a driver writes about a breakdown, an accident, running late and so on, the bot opens the case here with its steps.' : 'Nothing closed in the last 7 days.'}</p></section>`;
    view.innerHTML = header('cases') + `<main class="casespage">${App.pageHead('Road cases', 'What is happening on the road right now, the steps for each case, what is next, and the message for the driver. The bot opens the cases from the driver groups and follows the playbook.')}
      <div class="pagebar">${tabs}</div>${body}
      ${tab !== 'playbook' ? '<p class="hint foot">A step that waits longer than its time is raised with the truck\'s dispatcher (the admins too when it is very late, or a case is open 24 hours). In groups set to Updater, the bot sends the messages to the driver by itself.</p>' : '<p class="hint foot">The bot reads the groups, opens the right case and follows these steps. When a case ends, what was learned waits in Telegram → Knowledge to approve; add it here to make the playbook better.</p>'}</main>`;
    if (tab !== 'playbook') App.every(60000, viewCases);
  }
  // editing a playbook: steps one per line, "step | message to the driver | minutes"
  function pbDialog(p) {
    const steps = p ? p.steps.map((s) => [s.text, s.driver || '', s.wait || ''].join(' | ')).join('\n') : '';
    dialog(`<form id="pbForm" class="dform wide"><h2>${p ? 'Edit: ' + esc(p.title) : 'New case'}</h2>
      <label class="fld">Name<input name="title" required maxlength="120" value="${esc(p ? p.title : '')}"></label>
      <label class="fld">When it applies (the bot uses this to recognize it)<textarea name="when" rows="2" required>${esc(p ? p.when_text : '')}</textarea></label>
      <label class="fld">Steps, one per line: what to do | message to the driver (optional) | minutes before it is raised (optional)<textarea name="steps" rows="8" required>${esc(steps)}</textarea></label>
      <label class="fld">If / else rules, one per line (for example: If he is on the Turnpike: move off first, then call road service)<textarea name="rules" rows="4">${esc(p ? (p.rules || []).join('\n') : '')}</textarea></label>
      <p class="err" id="pbErr" role="alert"></p><div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
      $('#pbForm', d).onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
        const body = { title: f.get('title'), when: f.get('when'), steps: String(f.get('steps')).split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((x) => x[0]).map(([text, driver, wait]) => ({ text, driver: driver || '', wait: parseInt(wait, 10) || 0 })),
          rules: String(f.get('rules')).split('\n').map((x) => x.trim()).filter(Boolean) };
        try { await api(p ? '/api/playbooks/' + p.id : '/api/playbooks', { method: p ? 'PUT' : 'POST', body }); d.close(); toast('Saved'); reload(); } catch (er) { $('#pbErr').textContent = er.message; } };
    });
  }
  on('pbNew', () => pbDialog(null));
  on('pbEdit', (b) => pbDialog((App.lastPlaybooks || []).find((x) => x.id === +b.closest('[data-pb]').dataset.pb)));
  on('pbOnOff', async (b) => { const p = (App.lastPlaybooks || []).find((x) => x.id === +b.closest('[data-pb]').dataset.pb); try { await api('/api/playbooks/' + p.id, { method: 'PUT', body: { active: !p.active } }); reload(); } catch (e) { fail(e); } });
  App.route(/^#\/cases$/, viewCases);
  App.route(/^#\/playbook$/, () => { tab = 'playbook'; viewCases(); });
})();
