// Recruiting database website: sign-in, driver list, driver page with notes, and settings.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');
  const fmtPhone = (p) => (p && p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p);
  const cls = (s) => 's-' + String(s || 'Invited').replace(/[^A-Za-z0-9]+/g, '-');
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const shortWhen = (iso) => { if (!iso) return ''; const d = new Date(iso), n = new Date(); if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); if (d.toDateString() === new Date(n - 864e5).toDateString()) return 'Yesterday'; return d.toLocaleDateString([], d.getFullYear() === n.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }); };
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fuText = (d) => { if (!d) return ''; const t = today(); if (d === t) return 'Today'; if (d < t) return `Overdue · ${new Date(d + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}`; return new Date(d + 'T12:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); };
  const ROUTE = ['Invited', 'Replied', 'Interested', 'Email collected', 'Relay invite sent', 'Signed up on Relay', 'Hired'];
  const OTHER = ['Review', 'Stalled', 'No CDL', 'Not interested', 'Declined on Indeed', 'Rejected'];
  const ALL = ROUTE.concat(OTHER);
  const SHORT = { 'Declined on Indeed': 'Declined' };
  const LABELS = { cdl: 'License', qualify: 'CDL and record', qualifyNote: 'Screening', endorsements: 'Endorsements', freight: 'Freight hauled', relay: 'Amazon Relay', relayApp: 'Relay sign-up', equipment: 'Truck', currentJob: 'Working now', availability: 'Can start', interest: 'Interest', lookingFor: 'Looking for', homeTimeWanted: 'Home time', payExpectation: 'Pay wanted', home: 'Home', declineReason: 'Declined because', notes: 'Other details', fullName: 'Full name', zip: 'Zip' };
  const label = (k) => LABELS[k] || k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  const ICON_SEARCH = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.6 10.6 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  let me = null;
  const list = { q: '', status: '', account: '', mode: '', due: '', sort: 'updated', rows: [], total: 0, counts: [], accounts: [] };

  // ---------- server calls ----------
  async function api(path, opts = {}) {
    const r = await fetch(path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
    if (r.status === 401 && path !== '/api/login') { me = null; go('#/login'); throw new Error('Sign in first'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  let toastT;
  function toast(text, bad) { const t = $('#toast'); t.textContent = text; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2200); }
  const fail = (e) => toast(e.message || String(e), true);

  // ---------- router ----------
  const go = (h) => { if (location.hash !== h) location.hash = h; else route(); };
  async function route() {
    const h = location.hash || '#/';
    if (!me && h !== '#/login') { try { me = await api('/api/me'); } catch (e) { return; } }
    if (h === '#/login') return viewLogin();
    if (h.startsWith('#/driver/')) return viewDriver(+h.split('/')[2]);
    if (h === '#/settings') return viewSettings();
    return viewList();
  }
  window.addEventListener('hashchange', route);

  // ---------- header ----------
  function header(inner, routeHtml = '') {
    return `<header class="sign"><div class="o"><div class="plate"><div class="bar">
      <h1><a href="#/">Drivers</a></h1>${inner}<span class="grow"></span>
      <details class="menu" id="acct"><summary class="btn ghost">${esc(me ? me.name : '')}</summary><div class="pop">
        <div class="who">${esc(me ? me.email : '')}</div>
        <a href="#/">All drivers</a><a href="/api/export.csv">Export CSV</a><a href="#/settings">Settings</a><hr><button data-act="logout">Sign out</button></div></details>
    </div>${routeHtml}</div></div></header>`;
  }
  document.addEventListener('click', (e) => { const m = $('#acct'); if (m && m.open && !m.contains(e.target)) m.open = false; });

  // ---------- login ----------
  function viewLogin() {
    document.title = 'Sign in · Drivers';
    app.innerHTML = `<div class="login"><div class="o"><div class="plate"><h1>Drivers</h1><div>Recruiting database</div></div></div>
      <form id="lf"><label class="fld">Email<input type="email" name="email" autocomplete="username" required></label>
      <label class="fld">Password<input type="password" name="password" autocomplete="current-password" required></label>
      <p class="err" id="lerr"></p><button class="btn primary" style="width:100%">Sign in</button></form></div>`;
    $('#lf input').focus();
    $('#lf').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target); $('#lerr').textContent = '';
      try { await api('/api/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } }); me = await api('/api/me'); go('#/'); }
      catch (err) { $('#lerr').textContent = err.message; }
    };
  }

  // ---------- driver list ----------
  async function loadList(more) {
    const p = new URLSearchParams({ q: list.q, status: list.status, account: list.account, mode: list.mode, due: list.due, sort: list.sort, limit: 100, offset: more ? list.rows.length : 0 });
    const r = await api('/api/drivers?' + p);
    list.rows = more ? list.rows.concat(r.drivers) : r.drivers; list.total = r.total; list.counts = r.counts; list.accounts = r.accounts;
  }
  async function viewList() {
    document.title = 'Drivers';
    if (!$('#lst')) {
      app.innerHTML = header(`<label class="search">${ICON_SEARCH}<input id="q" type="search" placeholder="Search name, phone, email, city, notes" aria-label="Search drivers"></label>
        <select id="fAcct" class="pick" aria-label="Indeed account"></select>
        <select id="fMode" class="pick" aria-label="Driver type"><option value="">All types</option><option>Company drivers</option><option>Owner-operators</option></select>
        <select id="fSort" class="pick" aria-label="Sort"><option value="updated">Newest activity</option><option value="followup">Follow-up date</option><option value="name">Name A–Z</option><option value="created">Newest added</option></select>
        <button class="btn solid" data-act="add">Add driver</button>`, '<nav id="route" class="route" aria-label="Filter by status"></nav>') + '<main id="lst"></main>';
      $('#q').value = list.q; $('#fMode').value = list.mode; $('#fSort').value = list.sort;
      let t; $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { list.q = e.target.value; refresh(); }, 250); };
      $('#fAcct').onchange = (e) => { list.account = e.target.value; refresh(); };
      $('#fMode').onchange = (e) => { list.mode = e.target.value; refresh(); };
      $('#fSort').onchange = (e) => { list.sort = e.target.value; refresh(); };
    }
    await refresh();
  }
  async function refresh(more) {
    try { await loadList(more); } catch (e) { return fail(e); }
    const c = Object.fromEntries(list.counts.map((x) => [x.status, x.n])); const due = list.counts.reduce((a, x) => a + x.due, 0); const all = list.counts.reduce((a, x) => a + x.n, 0);
    const stop = (s, ring) => `<button class="stop${list.status === s ? ' on' : ''}${c[s] ? '' : ' zero'}" data-f="${esc(s)}">${ring ? '<i></i>' : ''}<span>${esc(SHORT[s] || s)}</span><b>${c[s] || 0}</b></button>`;
    $('#route').innerHTML = `<div class="main"><button class="stop${!list.status ? ' on' : ''}" data-f=""><span>All</span><b>${all}</b></button><ol>${ROUTE.map((s) => `<li>${stop(s, true)}</li>`).join('')}</ol></div>
      <div class="side">${OTHER.map((s) => stop(s)).join('')}<button class="stop due${list.due ? ' on' : ''}" data-due="1" title="Drivers whose follow-up date is today or earlier"><span>Follow-ups due</span><b>${due}</b></button></div>`;
    const acc = $('#fAcct'); acc.innerHTML = '<option value="">All accounts</option>' + list.accounts.map((a) => `<option ${a === list.account ? 'selected' : ''}>${esc(a)}</option>`).join('');
    const rows = list.rows.map((d) => {
      const contact = (d.phones || []).map((p) => `<a class="ph" href="tel:${esc(p)}">${esc(fmtPhone(p))}</a>`).join('') + (d.emails || []).slice(0, 1).map((e) => `<a class="em" href="mailto:${esc(e)}">${esc(e)}</a>`).join('');
      const note = d.redFlags ? `<span class="k flag">Flag</span>${esc(d.redFlags)}` : d.lastNote ? `<span class="k you">Note</span>${esc(d.lastNote)}` : d.aiSummary ? `<span class="k ai">AI</span>${esc(d.aiSummary)}` : '';
      const isDue = d.followUp && d.followUp <= today();
      return `<tr data-id="${d.id}"><td><div class="nm"><a href="#/driver/${d.id}">${esc(d.name)}</a></div><div class="type">${esc((d.mode || '').replace(/s$/, ''))}${d.account ? ` · ${esc(d.account)}` : ''}</div></td>
        <td><span class="badge ${cls(d.status)}">${esc(d.status)}</span></td>
        <td>${d.followUp ? `<span class="fu${isDue ? ' due' : ''}">${esc(fuText(d.followUp))}</span>` : '<span class="none">—</span>'}</td>
        <td><div class="note1 clamp">${note || '<span class="none">—</span>'}</div>${d.noteCount ? `<div class="small mut">${d.noteCount} note${d.noteCount > 1 ? 's' : ''}</div>` : ''}</td>
        <td>${contact || '<span class="none">—</span>'}</td>
        <td>${esc(d.location || (d.answers || {}).home || '') || '<span class="none">—</span>'}${d.zip ? `<div class="small mut">${esc(d.zip)}</div>` : ''}</td>
        <td class="small mut" title="${esc(when(d.updatedAt))}">${esc(shortWhen(d.updatedAt))}</td></tr>`;
    }).join('');
    $('#lst').innerHTML = list.rows.length ? `<div class="sheet"><table><colgroup><col style="width:22%"><col style="width:150px"><col style="width:130px"><col><col style="width:200px"><col style="width:140px"><col style="width:90px"></colgroup>
        <thead><tr><th>Driver</th><th>Status</th><th>Follow-up</th><th>Notes</th><th>Contact</th><th>Home</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${list.rows.length < list.total ? `<button class="btn plain more" data-act="more">Show more (${list.total - list.rows.length} left)</button>` : ''}`
      : `<div class="empty">${all ? '<p>No drivers match these filters.</p><button class="btn plain" data-act="clear">Clear filters</button>' : '<p>No drivers yet.</p>Connect the Chrome extension under Settings, or import a backup from it.'}</div>`;
  }

  // ---------- driver page ----------
  let cur = null;
  function convoHtml(c) {
    return String(c || '').split('\n').filter((l) => l.trim()).map((l) => {
      if (l.startsWith('Dispatch: ')) return `<div class="msg d"><span class="w">Dispatch</span>${esc(l.slice(10))}</div>`;
      if (l.startsWith('Driver: ')) return `<div class="msg c"><span class="w">Driver</span>${esc(l.slice(8))}</div>`;
      return `<div class="msg s">${esc(l.replace(/^\[(Indeed|On screen): /, '').replace(/\]$/, ''))}</div>`;
    }).join('');
  }
  async function viewDriver(id) {
    let r; try { r = await api('/api/drivers/' + id); } catch (e) { app.innerHTML = header('') + `<main><a class="back" href="#/">← All drivers</a><div class="empty"><p>${esc(e.message)}</p></div></main>`; return; }
    cur = r; const d = r.driver; const a = d.answers || {};
    document.title = `${d.name} · Drivers`;
    const answerKeys = Object.keys(LABELS).filter((k) => a[k]).concat(Object.keys(a).filter((k) => !(k in LABELS) && a[k]));
    const focusNew = document.activeElement && document.activeElement.id === 'newNote';
    app.innerHTML = header('') + `<main>
      <a class="back" href="#/">← All drivers</a>
      <section class="dhead">
        <div class="who"><h2>${esc(d.name)}</h2>
          <div class="sub">${[(d.mode || '').replace(/s$/, ''), d.location, d.zip, d.account].filter(Boolean).map(esc).join(' · ') || 'No details yet'}</div>
          <div class="contact">${(d.phones || []).map((p) => `<a href="tel:${esc(p)}">${esc(fmtPhone(p))}</a>`).join('')}${(d.emails || []).map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join('')}<button class="linkbtn" data-act="editContact">Edit contact</button></div>
          <div class="tags" id="tags">${(d.tags || []).map((t) => `<span class="tag">${esc(t)}<button data-tag="${esc(t)}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('')}<input id="tagIn" type="text" placeholder="Add a tag, press Enter" aria-label="Add a tag"></div>
        </div>
        <div class="ctl">
          <label class="fld">Status<select id="st" class="stsel">${ALL.concat(ALL.includes(d.status) ? [] : [d.status]).map((s) => `<option ${s === d.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <label class="fld">Follow-up<input id="fu" type="date" value="${esc(d.followUp || '')}"></label>
          ${d.conversationUrl ? `<a class="btn plain" href="${esc(d.conversationUrl)}" target="_blank" rel="noopener">Open on Indeed</a>` : ''}
          ${(d.phones || [])[0] ? `<a class="btn primary" href="tel:${esc(d.phones[0])}">Call</a>` : ''}
        </div>
      </section>
      <form id="contactForm" class="card" hidden><h3>Contact</h3><div class="form">
        <label class="fld">Name<input name="name" type="text" value="${esc(d.name)}"></label>
        <label class="fld">Phones, comma separated<input name="phones" type="text" value="${esc((d.phones || []).map(fmtPhone).join(', '))}"></label>
        <label class="fld">Emails, comma separated<input name="emails" type="text" value="${esc((d.emails || []).join(', '))}"></label>
        <label class="fld">Home<input name="location" type="text" value="${esc(d.location || '')}"></label>
        <label class="fld">Zip<input name="zip" type="text" value="${esc(d.zip || '')}" style="min-width:90px;width:90px"></label>
        <label class="fld">Type<select name="mode"><option value="">Not set</option>${['Company drivers', 'Owner-operators'].map((m) => `<option ${m === d.mode ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <button class="btn primary">Save</button><button type="button" class="btn plain" data-act="cancelContact">Cancel</button></div></form>
      <div class="cols">
        <div>
          <section class="card"><h3>Notes</h3>
            ${d.redFlags ? `<div class="flagbox"><span>${esc(d.redFlags)}</span></div>` : ''}
            <form class="compose" id="noteForm"><textarea id="newNote" placeholder="Add a note: a call, what they said, what to do next"></textarea>
              <div class="row"><button class="btn primary">Add note</button><span class="hint">Ctrl+Enter adds it</span></div></form>
            ${r.notes.length ? `<ul class="notes">${r.notes.map((n) => `<li data-note="${n.id}"><div class="meta"><b>${esc(n.author)}</b>${n.fromExtension ? '<span class="ext">from the extension</span>' : ''}<span class="grow">${esc(when(n.createdAt))}${n.updatedAt && new Date(n.updatedAt) - new Date(n.createdAt) > 60000 ? ' · edited' : ''}</span>
                ${n.mine || me.role === 'admin' ? `<button class="linkbtn" data-act="editNote">Edit</button><button class="linkbtn red" data-act="delNote">Delete</button>` : ''}</div><div class="body">${esc(n.body)}</div></li>`).join('')}</ul>` : '<p class="hint" style="margin:10px 0 0">No notes yet.</p>'}
          </section>
          <section class="card"><h3>Conversation</h3>${d.transcript ? `<div class="convo" id="cv">${convoHtml(d.transcript)}</div>` : `<p class="hint">No conversation saved yet. It appears after the extension reads this chat.</p>`}</section>
        </div>
        <div>
          ${d.aiSummary ? `<section class="card"><div class="ai"><b>AI summary</b>${esc(d.aiSummary)}</div></section>` : ''}
          <section class="card"><h3>Profile</h3><dl class="facts">
            ${[['Status', `<span class="badge ${cls(d.status)}">${esc(d.status)}</span>${d.statusLocked ? ' <span class="small mut">set by hand</span>' : ''}`], ['Job', esc(d.job)], ['Found through', esc(d.source)], ['Indeed account', esc(d.account)], ['Invited', esc(when(d.invitedAt))], ['Last contact', esc(when(d.lastContactAt))], ['Indeed profile', esc(d.profileSummary)]]
              .concat(answerKeys.map((k) => [label(k), esc(a[k])])).filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}
          </dl></section>
          <section class="card"><h3>History</h3>${r.events.length ? `<ol class="tl">${r.events.map((e) => `<li><time>${esc(when(e.t))}${e.who ? ` · ${esc(e.who)}` : ''}</time>${esc(e.text)}</li>`).join('')}</ol>` : '<p class="hint">No activity yet.</p>'}</section>
          ${me.role === 'admin' ? `<p class="small" style="text-align:right"><button class="linkbtn red" data-act="delDriver">Delete this driver</button></p>` : ''}
        </div>
      </div></main>`;
    const cv = $('#cv'); if (cv) cv.scrollTop = cv.scrollHeight;
    if (focusNew) $('#newNote').focus();
    $('#st').onchange = (e) => patch({ status: e.target.value }, 'Status saved');
    $('#fu').onchange = (e) => patch({ followUp: e.target.value || null }, e.target.value ? 'Follow-up saved' : 'Follow-up cleared');
    $('#tagIn').onkeydown = (e) => { if (e.key === 'Enter' && e.target.value.trim()) { e.preventDefault(); patch({ tags: [...(d.tags || []), e.target.value.trim()] }, 'Tag added'); } };
    $('#noteForm').onsubmit = (e) => { e.preventDefault(); addNote(); };
    $('#newNote').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNote(); } };
    $('#contactForm').onsubmit = (e) => {
      e.preventDefault(); const f = new FormData(e.target); const split = (v) => String(v || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
      patch({ name: f.get('name'), phones: split(f.get('phones')), emails: split(f.get('emails')), location: f.get('location'), zip: f.get('zip'), mode: f.get('mode') }, 'Contact saved');
    };
  }
  async function patch(body, ok) { try { await api('/api/drivers/' + cur.driver.id, { method: 'PATCH', body }); toast(ok); viewDriver(cur.driver.id); } catch (e) { fail(e); } }
  async function addNote() {
    const t = $('#newNote'); const body = t.value.trim(); if (!body) { t.focus(); return; }
    try { await api(`/api/drivers/${cur.driver.id}/notes`, { method: 'POST', body: { body } }); toast('Note added'); viewDriver(cur.driver.id); } catch (e) { fail(e); }
  }

  // ---------- settings ----------
  async function viewSettings() {
    document.title = 'Settings · Drivers';
    let keys = [], users = [];
    try { keys = await api('/api/keys'); if (me.role === 'admin') users = await api('/api/users'); } catch (e) { return fail(e); }
    app.innerHTML = header('') + `<main class="narrow">
      <a class="back" href="#/">← All drivers</a>
      <section class="card"><h3>Connect the Chrome extension</h3>
        <p class="hint" style="margin-top:0">Create one key for each Chrome profile. In that profile, open the extension's side panel → Settings → Shared database, and paste this website's address and the key.</p>
        <form id="keyForm" class="form"><label class="fld">Name<input name="name" type="text" placeholder="e.g. Davy profile" required></label><button class="btn primary">Create key</button></form>
        <div id="newKey"></div>
        <ul class="list" style="margin-top:8px">${keys.map((k) => `<li><span class="grow"><b>${esc(k.name)}</b><br><span class="small mut">Created ${esc(when(k.created_at))}${k.owner ? ` by ${esc(k.owner)}` : ''} · ${k.last_used_at ? `last used ${esc(when(k.last_used_at))}` : 'not used yet'}</span></span><button class="btn danger sm" data-act="delKey" data-id="${k.id}">Revoke</button></li>`).join('') || '<li class="hint">No keys yet.</li>'}</ul>
      </section>
      <section class="card"><h3>Import a backup</h3>
        <p class="hint" style="margin-top:0">In each Chrome profile, open the extension's database page → More → Download a backup. Import each file here. Drivers are merged by chat, phone, email and name, so nothing is doubled.</p>
        <div class="form"><label class="fld">Backup file<input id="impFile" type="file" accept=".json"></label><button class="btn primary" data-act="import">Import</button></div><p class="hint" id="impMsg"></p>
      </section>
      ${me.role === 'admin' ? `<section class="card"><h3>Team</h3>
        <ul class="list">${users.map((u) => `<li data-user="${u.id}"><span class="grow"><b>${esc(u.name)}</b> <span class="small mut">${esc(u.email)} · ${u.role === 'admin' ? 'Admin' : 'Member'}${u.active ? '' : ' · <b>No access</b>'}</span></span>
          ${u.id !== me.id ? `<button class="btn plain sm" data-act="resetPw">Set password</button><button class="btn ${u.active ? 'danger' : 'plain'} sm" data-act="toggleUser" data-on="${u.active ? 0 : 1}">${u.active ? 'Remove access' : 'Give access back'}</button>` : '<span class="small mut">You</span>'}</li>`).join('')}</ul>
        <form id="userForm" class="form" style="margin-top:10px">
          <label class="fld">Name<input name="name" type="text" required></label><label class="fld">Email<input name="email" type="email" required></label>
          <label class="fld">Password<input name="password" type="text" minlength="10" required placeholder="At least 10 characters"></label>
          <label class="fld">Role<select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label><button class="btn primary">Add person</button></form>
        <p class="hint">Members can see and edit drivers and notes. Admins can also manage the team and delete drivers.</p></section>` : ''}
      <section class="card"><h3>Your password</h3><form id="pwForm" class="form">
        <label class="fld">Current password<input name="current" type="password" autocomplete="current-password" required></label>
        <label class="fld">New password<input name="next" type="password" autocomplete="new-password" minlength="10" required></label><button class="btn primary">Change password</button></form></section>
    </main>`;
    $('#keyForm').onsubmit = async (e) => {
      e.preventDefault(); const name = new FormData(e.target).get('name');
      try { const r = await api('/api/keys', { method: 'POST', body: { name } }); await viewSettings();
        $('#newKey').innerHTML = `<div class="keybox"><b>Copy this key now. It is shown only once.</b><code id="kc">${esc(r.key)}</code><div class="small">Website address: <b>${esc(location.origin)}</b></div><button class="btn primary sm" data-act="copyKey" style="margin-top:6px">Copy key</button></div>`;
      } catch (err) { fail(err); }
    };
    $('#pwForm').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); try { await api('/api/me/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } }); e.target.reset(); toast('Password changed'); } catch (err) { fail(err); } };
    if ($('#userForm')) $('#userForm').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await api('/api/users', { method: 'POST', body: f }); toast(`${f.name} can now sign in`); viewSettings(); } catch (err) { fail(err); } };
  }

  // ---------- clicks ----------
  document.addEventListener('click', async (e) => {
    const stop = e.target.closest('.stop');
    if (stop) { if (stop.dataset.due) list.due = list.due ? '' : '1'; else list.status = stop.dataset.f; refresh(); return; }
    const row = e.target.closest('tbody tr[data-id]');
    if (row && !e.target.closest('a')) { go('#/driver/' + row.dataset.id); return; }
    const tagX = e.target.closest('[data-tag]');
    if (tagX) { patch({ tags: (cur.driver.tags || []).filter((t) => t !== tagX.dataset.tag) }, 'Tag removed'); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    try {
      if (act === 'logout') { await api('/api/logout', { method: 'POST' }); me = null; go('#/login'); }
      else if (act === 'more') refresh(true);
      else if (act === 'clear') { Object.assign(list, { q: '', status: '', account: '', mode: '', due: '' }); $('#q').value = ''; $('#fMode').value = ''; refresh(); }
      else if (act === 'add') {
        const name = prompt('Driver name'); if (!name || !name.trim()) return;
        const phone = prompt('Phone (optional)') || '';
        const r = await api('/api/drivers', { method: 'POST', body: { name, phone } }); go('#/driver/' + r.id);
      }
      else if (act === 'editContact') { const f = $('#contactForm'); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input').focus(); }
      else if (act === 'cancelContact') $('#contactForm').hidden = true;
      else if (act === 'editNote') {
        const li = b.closest('[data-note]'); const bodyEl = li.querySelector('.body'); if (li.querySelector('textarea')) return;
        const old = cur.notes.find((n) => n.id === +li.dataset.note).body;
        bodyEl.innerHTML = `<textarea>${esc(old)}</textarea><div style="margin-top:6px;display:flex;gap:8px"><button class="btn primary sm" data-act="saveNote">Save</button><button class="btn plain sm" data-act="cancelNote">Cancel</button></div>`;
        bodyEl.querySelector('textarea').focus();
      }
      else if (act === 'cancelNote') viewDriver(cur.driver.id);
      else if (act === 'saveNote') { const li = b.closest('[data-note]'); await api('/api/notes/' + li.dataset.note, { method: 'PATCH', body: { body: li.querySelector('textarea').value } }); toast('Note saved'); viewDriver(cur.driver.id); }
      else if (act === 'delNote') { if (!confirm('Delete this note?')) return; await api('/api/notes/' + b.closest('[data-note]').dataset.note, { method: 'DELETE' }); toast('Note deleted'); viewDriver(cur.driver.id); }
      else if (act === 'delDriver') { if (!confirm(`Delete ${cur.driver.name} and all their notes? This cannot be undone.`)) return; await api('/api/drivers/' + cur.driver.id, { method: 'DELETE' }); toast('Driver deleted'); go('#/'); }
      else if (act === 'delKey') { if (!confirm('Revoke this key? That Chrome profile stops syncing until it gets a new key.')) return; await api('/api/keys/' + b.dataset.id, { method: 'DELETE' }); viewSettings(); }
      else if (act === 'copyKey') { await navigator.clipboard.writeText($('#kc').textContent); b.textContent = 'Copied'; }
      else if (act === 'import') {
        const file = $('#impFile').files[0]; if (!file) { $('#impMsg').textContent = 'Pick a backup file first.'; return; }
        let data; try { data = JSON.parse(await file.text()); } catch (err) { $('#impMsg').textContent = 'That file is not a backup from the extension.'; return; }
        $('#impMsg').textContent = 'Importing…';
        const r = await api('/api/import', { method: 'POST', body: { drivers: data.drivers, label: file.name.replace(/\.json$/i, '') } });
        $('#impMsg').textContent = `Done: ${r.merged} drivers merged.`;
      }
      else if (act === 'resetPw') { const pw = prompt('New password for this person (at least 10 characters). They will be signed out.'); if (!pw) return; await api('/api/users/' + b.closest('[data-user]').dataset.user, { method: 'PATCH', body: { password: pw } }); toast('Password set'); }
      else if (act === 'toggleUser') { await api('/api/users/' + b.closest('[data-user]').dataset.user, { method: 'PATCH', body: { active: b.dataset.on === '1' } }); viewSettings(); }
    } catch (err) { fail(err); }
  });

  route();
})();
