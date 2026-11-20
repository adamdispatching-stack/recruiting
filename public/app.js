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
  // Companies (the carriers drivers work for): a colored tag that always carries the name.
  const company = (id) => (S.me && (S.me.companies || []).find((c) => c.id === id)) || null;
  const coTag = (id, big) => { const c = company(id); return c ? `<a class="co c${c.color % 8}${big ? ' big' : ''}" href="#/company/${c.id}">${esc(c.name)}</a>` : ''; };
  const coOptions = (sel, none = 'No company yet') => `<option value="">${esc(none)}</option>${(S.me.companies || []).map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
  // A page's title, one line about it, and its main buttons.
  const pageHead = (title, sub, actions = '') => `<div class="phead"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${actions ? `<div class="pacts">${actions}</div>` : ''}</div>`;
  // A person's initials in a circle.
  const initials = (name) => String(name || '?').trim().split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w[0] || '')).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  const avatar = (name, cls = '') => { const h = [...String(name || '')].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7); return `<span class="av ${['', 'b', ''][h % 3]} ${cls}" aria-hidden="true">${esc(initials(name))}</span>`; };
  const plus = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  // Drawings for empty pages and the dashboard (decoration only)
  const ART = {
    truck: `<svg class="art" viewBox="0 0 340 150" aria-hidden="true"><circle cx="170" cy="78" r="70" fill="#E4EFE7"/><circle cx="118" cy="70" r="30" fill="#F6ECCB"/>
      <path d="M8 120c40-30 70-36 104-22s58-18 96-20 70 18 124 30v12H8z" fill="#C2DBC9"/><path d="M60 126c30-22 64-26 92-12s50-6 80-10 50 8 90 22v4H60z" fill="#A5CAB1"/>
      <path d="M20 134h300" stroke="#9DBFA8" stroke-width="2"/><path d="M40 140h260" stroke="#E4EFE7" stroke-width="5" stroke-dasharray="14 10"/>
      <rect x="92" y="62" width="104" height="52" rx="3" fill="#fff" stroke="#24553B" stroke-width="2.5"/><path d="M100 104h88" stroke="#CFE2D6" stroke-width="2"/>
      <path d="M196 76h28l16 16v22h-44z" fill="#fff" stroke="#24553B" stroke-width="2.5" stroke-linejoin="round"/><path d="M206 82h14l10 10h-24z" fill="#BFD8C8" stroke="#24553B" stroke-width="2"/>
      <rect x="230" y="100" width="12" height="8" rx="1" fill="#E7EFEA" stroke="#24553B" stroke-width="1.6"/>
      ${[110, 130, 206, 230].map((x) => `<circle cx="${x}" cy="118" r="8.5" fill="#24553B"/><circle cx="${x}" cy="118" r="3.4" fill="#E4EFE7"/>`).join('')}</svg>`,
    carrier: `<svg class="art" viewBox="0 0 380 180" aria-hidden="true"><path d="M250 70a70 70 0 0 1 120 30H200a70 70 0 0 1 50-30z" fill="#E4EFE7"/>
      <path d="M80 36q4-12 16-10 8-10 20-2 12-2 14 10H76z M276 50q4-12 16-10 8-10 20-2 12-2 14 10h-54z" fill="#fff" stroke="#24553B" stroke-width="1.6"/>
      <circle cx="58" cy="118" r="26" fill="#BFD8C8"/><path d="M58 150v-38M58 126l-10-10M58 120l9-8" stroke="#24553B" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M86 150V74l46-16 46 16v76z" fill="#fff" stroke="#24553B" stroke-width="2.4" stroke-linejoin="round"/><rect x="104" y="84" width="56" height="16" rx="2" fill="#DCEDE2" stroke="#24553B" stroke-width="1.6"/>
      <text x="132" y="96" text-anchor="middle" font-size="10" font-weight="800" fill="#24553B" letter-spacing="1.5" font-family="inherit">CARRIER</text>
      <path d="M118 150v-28h28v28M132 122v28" fill="#BFD8C8" stroke="#24553B" stroke-width="2"/><path d="M96 110h14v12H96zM154 110h14v12h-14z" fill="#E4EFE7" stroke="#24553B" stroke-width="1.6"/>
      <path d="M178 150V88h120v62" fill="#fff" stroke="#24553B" stroke-width="2.4" stroke-linejoin="round"/>${[190, 230, 270].map((x) => `<rect x="${x}" y="98" width="24" height="18" fill="#DCEDE2" stroke="#24553B" stroke-width="1.6"/>`).join('')}
      ${[[186, 0], [246, 1]].map(([x]) => `<g><rect x="${x}" y="120" width="40" height="24" rx="2" fill="#fff" stroke="#24553B" stroke-width="2"/><path d="M${x + 40} 126h10l8 8v10h-18z" fill="#fff" stroke="#24553B" stroke-width="2" stroke-linejoin="round"/><circle cx="${x + 10}" cy="146" r="4.5" fill="#24553B"/><circle cx="${x + 48}" cy="146" r="4.5" fill="#24553B"/></g>`).join('')}
      <circle cx="330" cy="140" r="16" fill="#BFD8C8"/><path d="M30 152h330" stroke="#9DBFA8" stroke-width="2.4" stroke-linecap="round"/></svg>`,
    road: `<svg class="art hero" viewBox="0 0 720 170" preserveAspectRatio="xMaxYMin slice" aria-hidden="true">
      <defs><linearGradient id="hz" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#FBF7F2" stop-opacity="0"/><stop offset=".55" stop-color="#EEF1E4"/><stop offset="1" stop-color="#E4EDDA"/></linearGradient>
        <linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="#FBF7F2"/><stop offset=".22" stop-color="#FBF7F2" stop-opacity="0"/></linearGradient></defs>
      <rect width="720" height="170" fill="url(#hz)"/>
      <path d="M150 120 250 58l40 22 70-58 60 40 50-30 70 52 60-44 50 26 70-30v162H150z" fill="#D9E6D3"/>
      <path d="M230 132 330 84l50 22 70-46 70 44 60-28 60 34 80-40v120H230z" fill="#C4DAC1"/>
      <path d="M300 150 420 104l70 20 70-30 80 36 80-24v64H300z" fill="#AECDAE"/>
      <path d="M560 96l9.6 -30 9.6 30z" fill="#4F8B59"/><path d="M578 100l12.8 -40 12.8 40z" fill="#3E7A4A"/><path d="M600 94l8.3 -26 8.3 26z" fill="#5E9C69"/><path d="M616 102l14.7 -46 14.7 46z" fill="#2F6B3E"/><path d="M640 98l10.9 -34 10.9 34z" fill="#4F8B59"/><path d="M660 104l16.6 -52 16.6 52z" fill="#2F6B3E"/><path d="M686 96l9.6 -30 9.6 30z" fill="#5E9C69"/><path d="M340 112l7.0 -22 7.0 22z" fill="#7FB08A"/><path d="M354 114l9.0 -28 9.0 28z" fill="#6AA277"/><path d="M372 112l6.4 -20 6.4 20z" fill="#7FB08A"/><path d="M470 104l7.7 -24 7.7 24z" fill="#6AA277"/><path d="M486 108l9.6 -30 9.6 30z" fill="#5E9C69"/>
      <path d="M380 170c60-26 120-38 190-46s110-26 150-52v-20c-40 30-80 46-150 54s-140 22-196 64z" fill="#7E9184"/>
      <path d="M384 170c58-24 118-36 186-44s108-24 150-50" fill="none" stroke="#F7F4EE" stroke-width="2.2" stroke-dasharray="10 9"/>
      <path d="M372 170c62-30 126-44 198-52s108-28 150-56" fill="none" stroke="#F3F0E9" stroke-width="3"/>
      <g transform="translate(560 66)"><rect x="0" y="0" width="74" height="30" rx="2" fill="#FBF8F3" stroke="#5B6A60" stroke-width="1.4"/><path d="M-26 10h18l8 0v26h-30l-4-8v-10z" fill="#1E8A3E"/><path d="M-22 13h12v9h-15z" fill="#CFE3D4"/><rect x="-4" y="30" width="80" height="5" fill="#33413A"/>
        <circle cx="-16" cy="38" r="5" fill="#26312B"/><circle cx="48" cy="38" r="5" fill="#26312B"/><circle cx="62" cy="38" r="5" fill="#26312B"/></g>
      <rect width="720" height="170" fill="url(#fade)"/></svg>`
  };
  // Activity with the person's initials: "M. Keller moved James Delgado to Interested, 10 minutes ago"
  const ago = (iso) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`; const h = Math.round(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`; return teamWhen(iso); };
  const feedAv = (rows) => (rows.length ? `<ol class="feedav">${rows.map((f) => `<li>${avatar(f.user, 'sm')}<div><div><b>${esc(f.user)}</b> ${f.driver ? (f.driverId ? `<a href="#/driver/${f.driverId}">${esc(f.driver)}</a>: ` : `${esc(f.driver)}: `) : ''}${esc(f.text || '')}</div><time title="${esc(when(f.at))}">${esc(ago(f.at))}</time></div></li>`).join('')}</ol>` : '<p class="hint">Nothing yet.</p>');
  const reloadMe = async () => { S.me = await api('/api/me'); S.meAt = Date.now(); };
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
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    active: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/><path d="M3.8 10.5c2.6-.9 5.3-1.2 8.2-1.2s5.6.3 8.2 1.2M10.4 13.6 7 19.6M13.6 13.6l3.4 6"/>',
    companies: '<path d="M4 21V5.5L12 3v18M12 8.5l8 2.5v10"/><path d="M3 21h18M7.5 8h1.5M7.5 12h1.5M7.5 16h1.5M15.5 13h1.5M15.5 17h1.5"/>'
  };
  const icon = (k) => `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  function header(active, extra = '') {
    const admin = S.me.role === 'admin';
    const items = [['#/', admin ? 'Dashboard' : 'My day', 'home'], ['#/leads', 'Leads', 'leads'], ['#/onboarding', 'Onboarding', 'onboarding'], ['#/active', 'Active drivers', 'active'], ['#/companies', 'Companies', 'companies'], ['#/trucks', 'Trucks', 'trucks'], admin ? ['#/team', 'Team', 'team'] : ['#/team/me', 'My activity', 'team']];
    const link = ([href, label, key, ic]) => `<a href="${href}"${key === active ? ' class="on" aria-current="page"' : ''}>${icon(ic || key)}<span>${label}</span></a>`;
    return `<aside class="rail" id="rail"><div class="o"><div class="plate">
        <div class="brand"><a href="#/" aria-label="FleetHire Recruiting, home"><svg class="logo" viewBox="0 0 40 28" width="38" height="27" aria-hidden="true"><path d="M2 5.5h21v15H2z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M23 10h8.5l5.5 5.6v4.9H23z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><circle cx="9" cy="22.5" r="3.2" fill="#0B5B3A" stroke="currentColor" stroke-width="2.4"/><circle cx="30" cy="22.5" r="3.2" fill="#0B5B3A" stroke="currentColor" stroke-width="2.4"/><path d="M6 10.5h9M6 14.5h6" stroke="#F4B400" stroke-width="2.4" stroke-linecap="round"/></svg><span><b>FleetHire</b><small>Recruiting</small></span></a><button class="navbtn" data-act="navToggle" aria-expanded="false" aria-controls="railnav">${icon('menu')}<span>Menu</span></button></div>
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
    drawing(); document.title = 'Sign in · FleetHire';
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
    api, toast, fail, route, go, render, header, on, onChange, redraw, drawing, every, dialog, meterRow, feedHtml, feedAv, icon, pageHead, avatar, initials, plus, ART, company, coTag, coOptions, reloadMe, weekFields, readWeek, hm, DAYS };
})();
