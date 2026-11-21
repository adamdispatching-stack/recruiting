// Telegram manager: the bot's groups, what happened in each (AI summaries, ELD steps and checks, messages),
// who is who, and the bot's settings. Also the "Telegram groups" part of a lead's page.
(() => {
  const { esc, view, S, api, toast, fail, on, header, dialog, dateText, when } = App;
  const KIND = { eld: 'ELD', accounting: 'Accounting', updates: 'Updates', dispatch: 'Dispatch' };
  const MOOD = { good: '🙂 Good', neutral: '😐 Neutral', unhappy: '🙁 Unhappy', angry: '😠 Angry', unknown: '' };
  const PHASE = { docs: 'waiting on the driver: CDL and registration', login: 'waiting on the ELD team: login', driver: 'waiting on the driver: log in, manual, paper logs', checked: 'waiting on the ELD team: setup check', done: 'setup complete' };
  const ROLE = { driver: 'Driver', eld: 'ELD team', accounting: 'Accounting', dispatch: 'Dispatcher', staff: 'Our team' };
  let tab = 'groups';

  const kindTag = (k) => (k ? `<span class="tgk k-${k}">${KIND[k]}</span>` : '<span class="tgk none">Not linked</span>');
  function eldLine(e, lastCheck, open) {
    if (!e) return '';
    const done = e.steps.filter((x) => x.done).length;
    if (!e.setupDoneAt) return `<span class="${e.waiting && e.waiting.stuck ? 'latetag' : 'small'}">Setup ${done}/${e.steps.length}: ${esc(PHASE[e.phase])}${e.waiting && e.waiting.reminders ? `, reminded ${e.waiting.reminders}×` : ''}${e.waiting && e.waiting.stuck ? ', stuck' : ''}</span>`;
    if (lastCheck === undefined) return `<span class="small">${e.stoppedAt ? 'Daily checks finished' : 'Setup done, daily checks running'}</span>`;
    const lc = lastCheck ? (lastCheck.answer === 'ok' ? `last check ✅ ${esc(lastCheck.slot.slice(11))}` : lastCheck.answer === 'problem' ? `last check ⚠️ ${esc(lastCheck.slot.slice(11))}` : `${esc(lastCheck.slot.slice(11))} check waiting`) : 'no check yet';
    return `<span class="small">${e.stoppedAt ? 'Daily checks finished' : 'Daily checks'}, ${lc}</span>${open ? ` <span class="latetag">${open} open</span>` : ''}`;
  }
  function setupCard(st) {
    return `<section class="card tgsetup"><h3>Turn on the Telegram bot</h3>
      <ol class="gsteps">
        <li>In Telegram, open <b>@BotFather</b>, send <code>/newbot</code>, and give it a name (for example "FleetHire Assistant") and a user name ending in "bot". BotFather sends back a <b>token</b>. Don't share it with anyone or paste it in a chat.</li>
        <li>Still in BotFather: <code>/setprivacy</code>, pick your bot, choose <b>Disable</b>, so it can read every message in the groups.</li>
        <li>On Railway, open the website's service, <b>Variables</b>, and add <code>TELEGRAM_BOT_TOKEN</code> with the token. Railway restarts the website and the bot comes on.</li>
        <li>For AI (reading pictures, daily summaries) the variable <code>ANTHROPIC_API_KEY</code> must be there too${st.ai ? ' (it is)' : ''}.</li>
      </ol></section>`;
  }

  async function viewList() {
    const live = App.drawing();
    const [st, r] = await Promise.all([api('/api/tg/status'), api('/api/tg/chats')]); if (!live()) return;
    const admin = S.me.role === 'admin';
    document.title = 'Telegram · FleetHire';
    const status = !st.on ? '' : st.bot ? `<p class="tgstat ${st.lastError ? 'bad' : 'ok'}"><b>@${esc(st.bot.username)}</b> is ${st.lastError ? `having trouble: ${esc(st.lastError)}` : 'on'}${st.ai ? ', AI on' : ', AI off (no ANTHROPIC_API_KEY)'}.</p>` : `<p class="tgstat bad">The bot is starting${st.lastError ? `: ${esc(st.lastError)}` : ''}.</p>`;
    const tabs = `<nav class="fbtabs" aria-label="Telegram pages">${[['groups', 'Groups'], ...(admin ? [['people', 'People'], ['settings', 'Settings']] : []), ['how', 'How it works']].map(([k, l]) => `<button type="button" class="${tab === k ? 'on' : ''}" data-act="tgTab" data-tab="${k}" aria-current="${tab === k ? 'page' : 'false'}">${l}</button>`).join('')}</nav>`;
    let body = '';
    if (tab === 'groups') {
      const g = r.chats;
      body = g.length ? `<div class="sheet"><table class="tgt"><thead><tr><th>Driver</th><th>Group</th><th>Now</th><th>Latest summary</th><th class="n">Today</th></tr></thead><tbody>
        ${g.map((c) => `<tr data-chat="${c.chatId}" class="${c.openChecks || (c.eld && c.eld.waiting && c.eld.waiting.stuck) ? 'hot' : ''}"><th scope="row">${c.driverId ? `<a class="nml" href="#/driver/${c.driverId}"><b>${esc(c.driver)}</b></a>` : '<span class="none">Not linked</span>'}</th>
          <td>${kindTag(c.kind)}<div class="small mut clip1"><a href="#/telegram/${c.chatId}">${esc(c.title || 'Group')}</a></div>${c.botAdmin ? '' : '<div class="small latetag">Bot is not an admin</div>'}</td>
          <td>${c.kind === 'eld' ? eldLine(c.eld, c.lastCheck, c.openChecks) : '<span class="none">Summaries only for now</span>'}</td>
          <td class="tgsum">${c.lastSummary ? `<span class="small mut">${esc(dateText(c.lastSummary.day, { month: 'short', day: 'numeric' }))}${MOOD[c.lastSummary.mood] ? ', ' + MOOD[c.lastSummary.mood] : ''}</span><div class="clip2">${esc(c.lastSummary.summary)}</div>${(c.lastSummary.issues || []).length ? `<div class="small latetag">${c.lastSummary.issues.length} open</div>` : ''}` : '<span class="none">None yet</span>'}</td>
          <td class="n">${c.todayMsgs || '<span class="none">0</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="emptycard"><div class="emptyart"><h2>No groups yet.</h2><p>Open a driver in onboarding and use <b>Link a group</b> in the Telegram part of the onboarding card. The bot joins in from there.</p></div></div>`;
    } else if (tab === 'people') {
      const p = await api('/api/tg/people'); if (!live()) return;
      body = `<p class="hint">Everyone the bot has seen in its groups. Drivers and the ELD team usually set this themselves with the buttons; change it here if it is wrong. "Our team" can tap any button.</p>
        <div class="sheet"><table class="tgt"><thead><tr><th>Name</th><th>Telegram</th><th>Role</th><th>Driver</th><th class="n">Groups</th><th>Last seen</th></tr></thead><tbody>
        ${p.people.map((x) => `<tr data-tg="${x.tg_id}"><th scope="row">${esc(x.name || '')}${x.user_name ? `<div class="small mut">${esc(x.user_name)} on the website</div>` : ''}</th><td>${x.username ? '@' + esc(x.username) : '<span class="none">No user name</span>'}</td>
          <td><select data-ch="tgRole" aria-label="Role of ${esc(x.name || '')}"><option value="">Unknown</option>${p.roles.map((k) => `<option value="${k}" ${x.role === k ? 'selected' : ''}>${ROLE[k]}</option>`).join('')}</select></td>
          <td>${x.driver ? `<a href="#/driver/${x.driver_id}">${esc(x.driver)}</a>` : '<span class="none">-</span>'}</td><td class="n">${x.groups}</td><td class="small">${x.seen_at ? esc(when(x.seen_at)) : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="hint">Nobody yet.</td></tr>'}</tbody></table></div>`;
    } else if (tab === 'settings') {
      const t = st.settings;
      body = `<section class="card"><h3>ELD checks</h3><form id="tgForm" class="form tgform">
        <label class="fld">Check times each day<input type="text" name="eldTimes" value="${esc(t.eldTimes.join(', '))}" placeholder="11:00, 18:00"><small class="mut">The bot tags the ELD team at these times to check each driver's logs. Your team's time zone.</small></label>
        <label class="fld sm">For how many days after the setup<input name="eldDays" type="number" min="0" max="365" value="${t.eldDays}"><small class="mut">0 = every day, no end</small></label>
        <label class="fld sm">Tag again after (minutes)<input name="remindMin" type="number" min="15" max="720" value="${t.remindMin}"><small class="mut">Then the recruiter and admins are told</small></label>
        <label class="fld">ELD team user names (always tagged)<input type="text" name="eldTeam" value="${esc(t.eldTeam.join(' '))}" placeholder="@eld_anna @eld_mike"><small class="mut">Besides people who tapped "I am with the ELD team"</small></label>
        <label class="fld sm">Daily summary at<input type="text" name="summaryAt" value="${esc(t.summaryAt)}" placeholder="21:00"></label>
        <div class="tgsave"><button class="btn primary">Save</button></div></form></section>`;
    } else body = howHtml();
    view.innerHTML = header('telegram') + `<main>${App.pageHead('Telegram manager', 'The bot runs the drivers\' Telegram groups: it walks the ELD setup, tags the ELD team for daily checks, and sums up each day.')}
      ${st.on ? status : setupCard(st)}${tabs}${body}</main>`;
    const f = document.getElementById('tgForm');
    if (f) f.onsubmit = async (e) => { e.preventDefault(); const d = new FormData(f);
      try { await api('/api/settings', { method: 'PUT', body: { tg: { eldTimes: d.get('eldTimes'), eldDays: +d.get('eldDays'), remindMin: +d.get('remindMin'), eldTeam: d.get('eldTeam'), summaryAt: d.get('summaryAt') } } }); toast('Saved'); App.render(); } catch (er) { fail(er); } };
  }
  function howHtml() {
    return `<article class="fbguide"><section class="card"><h2>For each driver</h2><ol class="gsteps">
      <li>When the driver is coming, create the Telegram groups (ELD, accounting, updates) and add the driver, the people who work on it, and the bot.</li>
      <li>Make the bot an <b>admin</b> of the group.</li>
      <li>On the driver's page, in the Onboarding card, click <b>Link a group</b>, pick the kind, and send the code it shows in the group, like <code>/link 482913</code>.</li></ol></section>
      <section class="card"><h2>In the ELD group</h2><ol class="gsteps">
      <li>The bot posts the driver's name, phone, email, company, truck and start date for the ELD team, and a setup card it keeps up to date.</li>
      <li>The driver and the ELD people tap "I am the driver" / "I am with the ELD team", so the bot knows whom to tag.</li>
      <li>The driver sends a photo of the <b>CDL</b> and the <b>registration</b>. The bot recognises them (the pictures are not kept).</li>
      <li>The ELD team sends the <b>login</b>. On the website the password is hidden.</li>
      <li>The driver taps when they <b>logged in</b>, have the <b>printed ELD manual</b> and <b>blank paper logs</b> in the truck.</li>
      <li>The ELD team checks the setup: good, or a problem the bot passes to the driver.</li>
      <li>Then, at the check times, the bot tags the ELD team to check the logs (signed, documents, trailer number, hours). A problem goes to the driver with a Fixed button. No answer: tagged again, then the recruiter and admins are told here.</li></ol>
      <p class="hint">Anyone waiting too long is reminded (not at night); after 3 reminders the recruiter and admins get a notification.</p></section>
      <section class="card"><h2>Every evening</h2><p>The AI writes a short summary of each group's day, with anything still open and the driver's mood. It is on each group's page and in the list.</p>
      <p class="hint">Accounting and dispatch groups can be linked now: they get the daily summaries. Their own jobs (accounting questions, checking container numbers, truck issues, learning from dispatchers) come next.</p></section></article>`;
  }

  async function viewChat(id) {
    const live = App.drawing(); const r = await api('/api/tg/chats/' + encodeURIComponent(id)); if (!live()) return;
    const c = r.chat; const admin = S.me.role === 'admin';
    document.title = `${c.title || 'Group'} · Telegram · FleetHire`;
    const e = r.eld;
    view.innerHTML = header('telegram') + `<main><a class="back" href="#/telegram">← Telegram manager</a>
      ${App.pageHead(c.title || 'Telegram group', `${c.kind ? KIND[c.kind] + ' group' : 'Not linked'}${c.driverId ? ` for <a href="#/driver/${c.driverId}">${esc(c.driver)}</a>` : ''}${c.linkedAt ? `, linked ${esc(dateText(String(c.linkedAt).slice(0, 10)))}` : ''}`)}
      ${c.botAdmin ? '' : '<div class="needbox">The bot is not an admin in this group, so it may miss messages. In Telegram: Group settings, Administrators, Add admin.</div>'}
      <div class="tgcols"><div>
        ${e ? `<section class="card"><h3>ELD setup${e.setupDoneAt ? ' <span class="okt">complete</span>' : ''}</h3>
          <ul class="tgsteps">${e.steps.map((x) => `<li class="${x.done ? 'done' : ''}"><span aria-hidden="true">${x.done ? '✅' : '⬜'}</span><span>${esc(x.label)}</span>${x.done && x.by && x.key !== 'info' ? `<small>${esc(x.by)}, ${esc(when(x.at))}</small>` : ''}</li>`).join('')}</ul>
          ${e.waiting ? `<p class="${e.waiting.stuck ? 'latetag' : 'hint'}">Now ${esc(PHASE[e.phase])}, since ${esc(when(e.waiting.since))}${e.waiting.reminders ? `, reminded ${e.waiting.reminders}×` : ''}.</p>` : ''}
          ${e.problem ? `<div class="needbox">Setup problem from ${esc(e.problem.by)}: ${esc(e.problem.text)}</div>` : ''}</section>
        <section class="card"><h3>Daily ELD checks</h3>${r.checks.length ? `<ul class="list tgchecks">${r.checks.map((k) => `<li><b>${esc(dateText(k.slot.slice(0, 10), { month: 'short', day: 'numeric' }))} ${esc(k.slot.slice(11))}</b>
          ${k.answer === 'ok' ? `<span class="okt">All good</span> <span class="small mut">${esc(k.answered_by || '')}</span>` : k.answer === 'problem' ? `<span class="latetag">Problem</span> <span class="small">${esc(k.problem || '')}</span> ${k.fixed_at ? '<span class="okt">Fixed</span>' : '<span class="small latetag">Not fixed</span>'}` : k.escalated_at ? '<span class="latetag">No answer</span>' : `<span class="small mut">Waiting${k.reminded ? ', reminded' : ''}</span>`}</li>`).join('')}</ul>` : '<p class="hint">They start after the setup.</p>'}</section>` : ''}
        <section class="card"><h3>Daily summaries<span class="grow"></span><button type="button" class="btn plain sm" data-act="tgSum" data-chat="${c.chatId}">Sum up today now</button></h3>
          ${r.summaries.length ? r.summaries.map((s) => `<article class="tgday"><h4>${esc(dateText(s.day, { weekday: 'short', month: 'short', day: 'numeric' }))} <span class="small mut">${s.messages} messages${MOOD[s.mood] ? ', driver ' + MOOD[s.mood] : ''}</span></h4><p>${esc(s.summary)}</p>${(s.issues || []).length ? `<ul class="tgissues">${s.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</article>`).join('') : `<p class="hint">The first summary comes this evening${r.ai ? '' : ' (AI is off: only a message count without ANTHROPIC_API_KEY)'}.</p>`}</section>
      </div><div>
        <section class="card"><h3>People</h3><ul class="list">${r.people.map((p) => `<li><span class="grow"><b>${esc(p.name || '')}</b> ${p.username ? `<span class="small mut">@${esc(p.username)}</span>` : ''}</span><span class="tgk ${p.role ? 'k-' + p.role : 'none'}">${p.role ? ROLE[p.role] : 'Unknown'}</span></li>`).join('') || '<li class="hint">Nobody has written yet.</li>'}</ul>
          ${admin ? '<p class="hint">Change roles under <button type="button" class="linkbtn" data-act="tgPeople">People</button>.</p>' : ''}</section>
        <section class="card"><h3>Messages <span class="small mut">last ${r.messages.length}</span></h3><ol class="tgmsgs">${r.messages.map((m) => `<li class="${m.is_bot ? 'bot' : ''}"><div class="mh"><b>${esc(m.is_bot ? 'Bot' : m.from_name || '')}</b>${m.role ? ` <span class="small mut">${esc(ROLE[m.role] || m.role)}</span>` : ''}<span class="small mut">${esc(when(m.at))}</span></div>
          ${m.media ? `<div class="small tgmedia">📎 ${esc(m.media)}${m.media_note ? `: ${esc(m.media_note)}` : ''}</div>` : ''}${m.text ? `<div class="mt">${esc(m.text)}</div>` : ''}</li>`).join('')}</ol></section>
        ${admin && c.kind ? `<p><button type="button" class="btn plain sm" data-act="tgUnlink" data-chat="${c.chatId}">Unlink this group</button></p>` : ''}
      </div></div></main>`;
    const box = document.querySelector('.tgmsgs'); if (box) box.scrollTop = box.scrollHeight;
  }

  // ---------- on a lead's page ----------
  async function leadGroups(driverId, host) {
    let r; try { r = await api(`/api/drivers/${driverId}/tg`); } catch (e) { return; }
    if (!host.isConnected) return;
    const has = Object.fromEntries(r.groups.map((g) => [g.kind, g]));
    host.innerHTML = `<h4>Telegram groups</h4><ul class="tglead">${['eld', 'accounting', 'updates'].map((k) => {
      const g = has[k];
      return `<li><span class="tgk k-${k}">${KIND[k]}</span>${g ? `<a href="#/telegram/${g.chatId}">${esc(g.title || 'Group')}</a> ${g.eld ? eldLine(g.eld) : ''}` : `<span class="none">Not linked</span> <button type="button" class="linkbtn" data-act="tgLink" data-kind="${k}" data-driver="${driverId}">Link a group</button>`}</li>`;
    }).join('')}</ul>${r.botOn ? '' : '<p class="hint">The Telegram bot is not turned on yet (see Telegram manager).</p>'}`;
  }
  on('tgLink', async (b) => {
    try {
      const r = await api(`/api/drivers/${b.dataset.driver}/tg-link`, { method: 'POST', body: { kind: b.dataset.kind } });
      dialog(`<div class="dform"><h2>Link the ${KIND[b.dataset.kind]} group</h2>
        <ol class="gsteps"><li>In Telegram, create the group (for example "${KIND[b.dataset.kind]} · driver's name") and add the driver and the people who work on it.</li>
          <li>Add the bot${r.bot ? `: <b>@${esc(r.bot)}</b>` : ''}, and make it an <b>admin</b>.</li>
          <li>Send this in the group:</li></ol>
        <div class="gcopy"><pre>/link ${esc(r.code)}</pre><button type="button" class="btn plain sm" data-act="tgCopyCode" data-code="/link ${esc(r.code)}">Copy</button></div>
        <p class="hint">The code works once, for 7 days.${r.botOn ? '' : ' The bot is not turned on yet: see Telegram manager.'}</p>
        <div class="dact"><button type="button" class="btn primary" data-act="closeDialog">Done</button></div></div>`);
    } catch (e) { fail(e); }
  });
  on('tgCopyCode', async (b) => { try { await navigator.clipboard.writeText(b.dataset.code); toast('Copied'); } catch (e) { toast('Select the code and copy it', true); } });
  on('tgTab', (b) => { tab = b.dataset.tab; App.render(); });
  on('tgPeople', () => { tab = 'people'; App.go('#/telegram'); });
  on('tgSum', async (b) => { b.disabled = true; try { await api(`/api/tg/chats/${b.dataset.chat}/summary`, { method: 'POST', body: {} }); toast('Summary written'); App.render(); } catch (e) { fail(e); b.disabled = false; } });
  on('tgUnlink', async (b) => { if (!confirm('Unlink this group from the driver? The bot stops its ELD work there.')) return; try { await api(`/api/tg/chats/${b.dataset.chat}/link`, { method: 'DELETE' }); toast('Unlinked'); App.render(); } catch (e) { fail(e); } });
  document.addEventListener('change', async (e) => {
    const s = e.target.closest('select[data-ch="tgRole"]'); if (!s) return;
    try { await api('/api/tg/people/' + s.closest('tr').dataset.tg, { method: 'PATCH', body: { role: s.value || null } }); toast('Saved'); } catch (er) { fail(er); }
  });
  document.addEventListener('click', (e) => { const r = e.target.closest('table.tgt tr[data-chat]'); if (r && !e.target.closest('a,button')) App.go('#/telegram/' + r.dataset.chat); });
  App.route(/^#\/telegram$/, viewList);
  App.route(/^#\/telegram\/(-?\d+)$/, viewChat);
  App.tgLeadGroups = leadGroups;
})();
