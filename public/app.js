// Core of the recruiting website: helpers, sign-in, navigation, and the "I'm here" signals.
// Each screen lives in its own file (leads.js, ops.js, team.js, settings.js) and registers itself here.
window.App = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const view = $('#app');
  const S = { me: null };

  // ---------- words and numbers ----------
  const fmtPhone = (p) => (p && p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p);
  const cls = (s) => 's-' + String(s || 'Invited').replace(/[^A-Za-z0-9]+/g, '-');
  const badge = (s) => `<span class="badge ${cls(s)}">${esc(s)}</span>`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  // times on notes and history: the reader's own clock
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const shortWhen = (iso) => { if (!iso) return ''; const d = new Date(iso), n = new Date(); if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); if (d.toDateString() === new Date(n - 864e5).toDateString()) return 'Yesterday'; return d.toLocaleDateString([], d.getFullYear() === n.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }); };
  // days and times on reports: the team's time zone (Settings), so everyone reads the same day
  const tz = () => (S.me && S.me.tz) || 'America/New_York';
  const tzName = () => tz().split('/').pop().replace(/_/g, ' ') + ' time';
  const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(new Date(iso));
  const today = () => dayOf(Date.now());
  const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dateText = (ymd, opts) => (ymd ? new Date(ymd + 'T12:00:00Z').toLocaleDateString([], { timeZone: 'UTC', month: 'short', day: 'numeric', ...opts }) : '');
  const teamTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { timeZone: tz(), hour: 'numeric', minute: '2-digit' }) : '');
  const teamWhen = (iso) => { if (!iso) return ''; const d = dayOf(iso), t = today(); return (d === t ? '' : d === addDays(t, -1) ? 'Yesterday ' : dateText(d) + ', ') + teamTime(iso); };
  const fuText = (d) => { if (!d) return ''; const t = today(); if (d === t) return 'Today'; if (d < t) return `Overdue, ${dateText(d)}`; if (d === addDays(t, 1)) return 'Tomorrow'; return dateText(d, { weekday: 'short' }); };
  const dur = (sec) => { const m = Math.round((sec || 0) / 60); if (!m) return sec > 0 ? '1m' : '0m'; return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const daysSince = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 864e5));
  const person = (id) => { const p = S.me && S.me.people.find((x) => x.id === id); return p ? p.name : ''; };
  const hasAccess = (id) => { const p = S.me && S.me.people.find((x) => x.id === id); return !!(p && p.active); };
  // Online now? "Active" = clicked, typed or scrolled in the last 2 minutes. "Idle" = the site is open but untouched.
  function presence(p, now) {
    const n = new Date(now || Date.now()).getTime(); const gap = (t) => (t ? (n - new Date(t).getTime()) / 1000 : Infinity);
    if (!p.lastSeenAt) return { state: 'never', label: 'Never signed in' };
    if (gap(p.lastActiveAt) < 120) return { state: 'active', label: 'Active now' };
    if (gap(p.lastSeenAt) < 150) return { state: 'idle', label: 'Idle, site open' };
    return { state: 'offline', label: `Last seen ${teamWhen(p.lastSeenAt)}` };
  }
  const presenceHtml = (p, now) => { const x = presence(p, now); return `<span class="pres ${x.state}"><i></i>${esc(x.label)}</span>`; };

  // ---------- server calls ----------
  async function api(path, opts = {}) {
    const r = await fetch(path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
    if (r.status === 401 && path !== '/api/login') { S.me = null; go('#/login'); throw new Error('Sign in first'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || 'Something went wrong'); e.status = r.status; e.data = data; throw e; }
    return data;
  }
  let toastT;
  function toast(text, bad) { const t = $('#toast'); t.textContent = text; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2200); }
  const fail = (e) => { if (e && e.message !== 'Sign in first') toast(e.message || String(e), true); };

  // ---------- "I'm here" signals ----------
  // Every 30 seconds while the site is open: was the page on screen, and did the person click, type or scroll?
  // Only counts are sent (never what was typed). The manager sees them on the Team page; each person sees their own.
  const sig = { clicks: 0, last: 0, timer: null, page: '' };
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'pointermove', 'scroll'].forEach((ev) => document.addEventListener(ev, () => { sig.last = Date.now(); }, { passive: true, capture: true }));
  document.addEventListener('click', () => { sig.clicks++; }, true);
  function beat(extra) {
    if (!S.me) return;
    const body = JSON.stringify({ active: !document.hidden && Date.now() - sig.last < 31000, visible: !document.hidden, clicks: sig.clicks, ...extra });
    sig.clicks = 0;
    fetch('/api/beat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'same-origin', keepalive: true }).catch(() => {});
  }
  function startSignals() { if (sig.timer) return; beat({ start: true }); sig.timer = setInterval(beat, 30000); }
  function stopSignals() { clearInterval(sig.timer); sig.timer = null; sig.page = ''; }
  document.addEventListener('visibilitychange', () => { if (document.hidden) beat(); });
  window.addEventListener('pagehide', () => beat());
  function pageOpened(hash) { const p = hash.split('?')[0]; if (!S.me || p === sig.page) return; sig.page = p; fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }), credentials: 'same-origin' }).catch(() => {}); }

  // Screens load their data and then draw. If a newer draw started meanwhile (the person clicked on, or typed
  // more in the search box), the older answer is stale and must not be drawn over the newer one.
  let drawId = 0;
  const drawing = () => { const id = ++drawId; return () => id === drawId; };

  // ---------- navigation ----------
  const routes = [];
  const route = (re, fn) => routes.push([re, fn]);
  const go = (h) => { if (location.hash !== h) location.hash = h; else render(); };
  // Screens that show who is online refresh themselves once a minute, unless you are in the middle of something.
  let ticker = null;
  function every(ms, fn) {
    clearInterval(ticker);
    ticker = setInterval(() => {
      const a = document.activeElement; const busy = document.hidden || $('dialog[open]') || $('details[open]') || $('.bar.on') || $('.viztable:not([hidden])') || (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) || String(getSelection()).length;
      if (!busy) redraw(fn).catch(() => {});
    }, ms);
  }
  async function render() {
    const h = location.hash || '#/';
    clearInterval(ticker); ticker = null;
    if (!S.me && h !== '#/login') { try { S.me = await api('/api/me'); S.meAt = Date.now(); startSignals(); } catch (e) { return; } }
    // names of people and the lead sources can change while the site is open: refresh them now and then
    if (S.me && Date.now() - (S.meAt || 0) > 5 * 60000) { S.meAt = Date.now(); api('/api/me').then((m) => { if (S.me) S.me = m; }).catch(() => {}); }
    const dlg = $('#dlg'); if (dlg && dlg.open) dlg.close(); // a form left open does not follow you to another screen
    if (h === '#/login') return viewLogin();
    pageOpened(h);
    const [path, qs] = h.split('?');
    for (const [re, fn] of routes) { const m = path.match(re); if (m) { try { return await fn(...m.slice(1), new URLSearchParams(qs || '')); } catch (e) { return fail(e); } } }
    go('#/');
  }
  window.addEventListener('hashchange', render);

  // The menu down the left side (a bar with a menu button on a phone). A screen with its own search and filters
  // passes them as "extra"; they sit in a green strip at the top of the page.
  const ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v11h5v-6h4v6h5V9"/>',
    leads: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
    onboarding: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.8h6V4"/><path d="m8.5 12.5 2.2 2.2 4.8-4.8"/>',
    trucks: '<path d="M2 6h11v10H2z"/><path d="M13 9h4.5l3.5 3.8V16h-8"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5.4 6-5.4s5.4 2 6 5.4"/><path d="M16 4.9a3.2 3.2 0 0 1 0 6.2M18.2 14.8c1.6.8 2.6 2.6 2.8 5.2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.2 5.6l2.1 2.1M17.7 16.3l2.1 2.1M2.5 12h3M18.5 12h3M4.2 18.4l2.1-2.1M17.7 7.7l2.1-2.1"/>',
    password: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    export: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
    out: '<path d="M10 4H5v16h5"/><path d="M14 8l4 4-4 4M18 12H9"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>'
  };
  const icon = (k) => `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  function header(active, extra = '') {
    const admin = S.me.role === 'admin';
    const items = [['#/', admin ? 'Dashboard' : 'My day', 'home'], ['#/leads', 'Leads', 'leads'], ['#/onboarding', 'Onboarding', 'onboarding'], ['#/trucks', 'Trucks', 'trucks'], admin ? ['#/team', 'Team', 'team'] : ['#/team/me', 'My activity', 'team']];
    const link = ([href, label, key, ic]) => `<a href="${href}"${key === active ? ' class="on" aria-current="page"' : ''}>${icon(ic || key)}<span>${label}</span></a>`;
    return `<aside class="rail" id="rail"><div class="o"><div class="plate">
        <div class="brand"><a href="#/">Recruiting</a><button class="navbtn" data-act="navToggle" aria-expanded="false" aria-controls="railnav">${icon('menu')}<span>Menu</span></button></div>
        <div class="railnav" id="railnav">
          <nav aria-label="Sections">${items.map(link).join('')}</nav>
          <span class="grow"></span>
          <div class="acct"><div class="who"><b>${esc(S.me.name)}</b><span>${admin ? 'Admin' : 'Recruiter'}</span></div>
            <nav aria-label="Account">${admin ? link(['#/settings', 'Settings', 'settings']) + `<a href="/api/export.csv">${icon('export')}<span>Export leads</span></a>` : link(['#/settings', 'Password', 'settings', 'password'])}
              <button data-act="logout">${icon('out')}<span>Sign out</span></button></nav></div>
        </div></div></div></aside>${extra ? `<header class="sign"><div class="o"><div class="plate">${extra}</div></div></header>` : ''}`;
  }
  document.addEventListener('click', (e) => { $$('details.menu[open]').forEach((m) => { if (!m.contains(e.target)) m.open = false; }); });

  // ---------- buttons: every [data-act] runs the function registered under that name ----------
  const actions = {};
  const on = (name, fn) => { actions[name] = fn; };
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const fn = actions[b.dataset.act]; if (!fn) return;
    try { await fn(b, e); } catch (err) { fail(err); }
  });
  // ...and every [data-ch] field does the same when its value changes
  const changes = {};
  const onChange = (name, fn) => { changes[name] = fn; };
  document.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-ch]'); if (!el) return;
    const fn = changes[el.dataset.ch]; if (!fn) return;
    try { await fn(el, e); } catch (err) { fail(err); }
  });
  // the menu button on a phone
  on('navToggle', (b) => { const open = document.body.classList.toggle('navopen'); b.setAttribute('aria-expanded', String(open)); });
  window.addEventListener('hashchange', () => document.body.classList.remove('navopen'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('navopen')) { document.body.classList.remove('navopen'); const b = $('.navbtn'); if (b) { b.setAttribute('aria-expanded', 'false'); b.focus(); } } });
  // Screens redraw after every save; this puts the keyboard focus back where it was.
  async function redraw(fn) {
    const a = document.activeElement; const fk = a && a.dataset ? a.dataset.fk : ''; const y = window.scrollY;
    await fn();
    if (fk) { const el = document.querySelector(`[data-fk="${fk}"]`); if (el) el.focus({ preventScroll: true }); }
    window.scrollTo(0, y);
  }
  on('logout', async () => { await api('/api/logout', { method: 'POST' }); S.me = null; stopSignals(); go('#/login'); });

  // ---------- a dialog for forms ----------
  function dialog(html, onOpen) {
    let d = $('#dlg'); if (!d) { d = document.createElement('dialog'); d.id = 'dlg'; document.body.appendChild(d); d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); }
    d.innerHTML = html; if (!d.open) d.showModal();
    const first = d.querySelector('input:not([type=hidden]), select, textarea'); if (first) first.focus();
    if (onOpen) onOpen(d);
    return d;
  }
  on('closeDialog', () => { const d = $('#dlg'); if (d) d.close(); });

  // ---------- sign-in ----------
  function viewLogin() {
    drawing(); document.title = 'Sign in · Recruiting';
    view.innerHTML = `<div class="login"><div class="o"><div class="plate"><h1>Recruiting</h1><div>Leads, follow-ups and onboarding</div></div></div>
      <form id="lf"><label class="fld">Email<input type="email" name="email" autocomplete="username" required></label>
      <label class="fld">Password<input type="password" name="password" autocomplete="current-password" required></label>
      <p class="err" id="lerr" role="alert"></p><button class="btn primary" style="width:100%">Sign in</button>
      <p class="hint notice">Work on this site is recorded: when you are signed in, how long you are active, and what you change. Your manager can see it, and you can see your own under My activity.</p></form></div>`;
    $('#lf input').focus();
    $('#lf').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target); $('#lerr').textContent = '';
      try { await api('/api/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } }); S.me = await api('/api/me'); S.meAt = Date.now(); startSignals(); go('#/'); }
      catch (err) { $('#lerr').textContent = err.message; }
    };
  }

  // ---------- small shared pieces ----------
  // One row of a list where each line is a name, a bar and a figure (pipeline stages, lead sources).
  const meterRow = (name, n, max, extra = '', href = '') => `<${href ? `a href="${href}"` : 'div'} class="mrow"><span class="mname">${name}</span><span class="mbar"><i style="width:${max ? Math.max(n ? 1.5 : 0, (n / max) * 100) : 0}%"></i></span><b class="mnum">${n.toLocaleString()}</b>${extra}</${href ? 'a' : 'div'}>`;
  // One line of an activity feed.
  const feedHtml = (rows, showUser) => (rows.length ? `<ol class="feed">${rows.map((f) => `<li><time title="${esc(when(f.at))}">${esc(teamWhen(f.at))}</time><span>${showUser ? `<b>${esc(f.user)}</b> ` : ''}${f.driver ? (f.driverId ? `<a href="#/driver/${f.driverId}">${esc(f.driver)}</a>` : `<span class="gone">${esc(f.driver)}</span>`) + ': ' : ''}${esc(f.text || '')}</span></li>`).join('')}</ol>` : '<p class="hint">Nothing yet.</p>');

  // ---------- working hours: one row per day of the week (Settings and each person's page) ----------
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ORDER = [1, 2, 3, 4, 5, 6, 0]; // the week starts on Monday on screen
  const hm = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
  const weekFields = (week) => `<div class="week">${ORDER.map((i) => { const d = week[i]; return `<div class="wrow${d ? '' : ' offd'}" data-dow="${i}">
      <label class="chk"><input type="checkbox" data-ch="weekDay" ${d ? 'checked' : ''}><span>${DAYS[i]}</span></label>
      <input type="time" step="900" value="${d ? d.s : '09:00'}" aria-label="${DAYS[i]} start" ${d ? '' : 'disabled'}><span class="mut">to</span>
      <input type="time" step="900" value="${d ? d.e : '18:00'}" aria-label="${DAYS[i]} end" ${d ? '' : 'disabled'}>
      <span class="small mut wnote">${d ? '' : 'Day off'}</span></div>`; }).join('')}</div>`;
  const readWeek = (root) => { const w = Array(7).fill(null); root.querySelectorAll('.wrow').forEach((r) => { const [on, s, e] = r.querySelectorAll('input'); if (on.checked) w[+r.dataset.dow] = { s: s.value, e: e.value }; }); return w; };
  onChange('weekDay', (el) => { const r = el.closest('.wrow'); r.querySelectorAll('input[type=time]').forEach((t) => { t.disabled = !el.checked; }); r.classList.toggle('offd', !el.checked); r.querySelector('.wnote').textContent = el.checked ? '' : 'Day off'; });

  return { $, $$, esc, view, S, fmtPhone, cls, badge, plural, when, shortWhen, tz, tzName, dayOf, today, addDays, dateText, teamTime, teamWhen, fuText, dur, daysSince, person, hasAccess, presence, presenceHtml,
    api, toast, fail, route, go, render, header, on, onChange, redraw, drawing, every, dialog, meterRow, feedHtml, icon, weekFields, readWeek, hm, DAYS };
})();
