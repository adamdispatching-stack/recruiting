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

  function header(active, extra = '') {
    const admin = S.me.role === 'admin';
    const tabs = [['#/', admin ? 'Dashboard' : 'My day', 'home'], ['#/leads', 'Leads', 'leads'], ['#/onboarding', 'Onboarding', 'onboarding'], ['#/trucks', 'Trucks', 'trucks'], admin ? ['#/team', 'Team', 'team'] : ['#/team/me', 'My activity', 'team']];
    return `<header class="sign"><div class="o"><div class="plate"><div class="bar">
      <h1><a href="#/">Recruiting</a></h1>
      <nav class="tabs" aria-label="Sections">${tabs.map(([href, label, key]) => `<a href="${href}"${key === active ? ' class="on" aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <span class="grow"></span>
      <details class="menu" id="acct"><summary class="btn ghost">${esc(S.me.name)}</summary><div class="pop">
        <div class="who">${esc(S.me.email)}<br>${admin ? 'Admin' : 'Recruiter'}</div>
        <a href="#/settings">${admin ? 'Settings' : 'Change password'}</a>${admin ? '<a href="/api/export.csv">Export all leads (CSV)</a>' : ''}<hr><button data-act="logout">Sign out</button></div></details>
    </div>${extra}</div></div></header>`;
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

  return { $, $$, esc, view, S, fmtPhone, cls, badge, plural, when, shortWhen, tz, tzName, dayOf, today, addDays, dateText, teamTime, teamWhen, fuText, dur, daysSince, person, hasAccess, presence, presenceHtml,
    api, toast, fail, route, go, render, header, on, onChange, redraw, drawing, every, dialog, meterRow, feedHtml };
})();
