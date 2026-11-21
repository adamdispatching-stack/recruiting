// Telegram manager: the bot's groups, what happened in each (AI summaries, ELD steps and checks, messages),
// who is who, and the bot's settings. Also the "Telegram groups" part of a lead's page.
(() => {
  const { esc, view, S, api, toast, fail, on, header, dialog, dateText, when } = App;
  const KIND = { onboarding: 'Onboarding', eld: 'ELD', accounting: 'Accounting', updates: 'Updates', dispatch: 'Dispatch' };
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
  const onbLine = (o) => (o ? `<span class="small">Amazon: ${esc(o.amazonLabel || 'invite not sent')}</span>${o.openQuestions ? ` <span class="latetag">${o.openQuestions} question${o.openQuestions > 1 ? 's' : ''} waiting</span>` : ''}${o.reportsToReview ? ` <span class="latetag">${o.reportsToReview} report${o.reportsToReview > 1 ? 's' : ''} to review</span>` : ''}` : '');
  // questions the bot passed on: answer here, it posts the answer in the group and learns it
  const qBox = (x, withDriver) => `<li class="tgq" data-q="${x.id}"><div><b>${withDriver ? `<a href="#/driver/${x.driver_id}">${esc(x.driver)}</a>: ` : ''}</b>“${esc(x.text)}” <span class="small mut">${esc(when(x.asked_at))}</span></div>
      <form class="tgqf"><textarea name="answer" rows="2" required placeholder="Your answer. The bot posts it in the group and remembers it for next time." aria-label="Answer"></textarea><button class="btn primary sm">Send answer</button></form></li>`;
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
    const tabs = `<nav class="fbtabs" aria-label="Telegram pages">${[['groups', 'Groups'], ['knowledge', 'Knowledge'], ...(admin ? [['people', 'People'], ['settings', 'Settings']] : []), ['how', 'How it works']].map(([k, l]) => `<button type="button" class="${tab === k ? 'on' : ''}" data-act="tgTab" data-tab="${k}" aria-current="${tab === k ? 'page' : 'false'}">${l}</button>`).join('')}</nav>`;
    let body = '';
    if (tab === 'groups') {
      const g = r.chats; const qs = (await api('/api/tg/questions')).questions; if (!live()) return;
      body = (qs.length ? `<section class="card tgqs"><h3>Drivers' questions waiting for you <span class="cnt">${qs.length}</span></h3><ul class="list">${qs.map((x) => qBox(x, true)).join('')}</ul></section>` : '') + (g.length ? `<div class="sheet"><table class="tgt"><thead><tr><th>Driver</th><th>Group</th><th>Now</th><th>Latest summary</th><th class="n">Today</th></tr></thead><tbody>
        ${g.map((c) => `<tr data-chat="${c.chatId}" class="${c.openChecks || (c.eld && c.eld.waiting && c.eld.waiting.stuck) ? 'hot' : ''}"><th scope="row">${c.driverId ? `<a class="nml" href="#/driver/${c.driverId}"><b>${esc(c.driver)}</b></a>` : '<span class="none">Not linked</span>'}</th>
          <td>${kindTag(c.kind)}<div class="small mut clip1"><a href="#/telegram/${c.chatId}">${esc(c.title || 'Group')}</a></div>${c.botAdmin ? '' : '<div class="small latetag">Bot is not an admin</div>'}</td>
          <td>${c.kind === 'eld' ? eldLine(c.eld, c.lastCheck, c.openChecks) : c.kind === 'onboarding' ? onbLine(c.onb) : '<span class="none">Summaries only for now</span>'}</td>
          <td class="tgsum">${c.lastSummary ? `<span class="small mut">${esc(dateText(c.lastSummary.day, { month: 'short', day: 'numeric' }))}${MOOD[c.lastSummary.mood] ? ', ' + MOOD[c.lastSummary.mood] : ''}</span><div class="clip2">${esc(c.lastSummary.summary)}</div>${(c.lastSummary.issues || []).length ? `<div class="small latetag">${c.lastSummary.issues.length} open</div>` : ''}` : '<span class="none">None yet</span>'}</td>
          <td class="n">${c.todayMsgs || '<span class="none">0</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="emptycard"><div class="emptyart"><h2>No groups yet.</h2><p>Open a driver in onboarding and use <b>Link a group</b> in the Telegram part of the onboarding card. The bot joins in from there.</p></div></div>`);
    } else if (tab === 'knowledge') {
      const k = (await api('/api/tg/knowledge')).knowledge; if (!live()) return;
      body = `<p class="hint">What the bot answers drivers from, besides the company facts in Settings → Call guide. When the bot does not know, it asks the recruiter; the recruiter's answer (in Telegram or here) is added below. Fix or turn off anything that is wrong.</p>
        <details class="card tgkadd"><summary><b>Add a question and answer</b></summary><form id="tgkForm" class="form tgkf"><label class="fld">Question<input type="text" name="question" required placeholder="Can I bring my dog?"></label><label class="fld">Answer<textarea name="answer" rows="2" required placeholder="Yes, one small pet is fine in our trucks."></textarea></label><div><button class="btn primary">Add</button></div></form></details>
        <ul class="tgk-list">${k.map((x) => `<li data-k="${x.id}" class="${x.active ? '' : 'off'}"><div class="kq"><b>Q:</b> <span>${esc(x.question)}</span></div><div class="ka"><b>A:</b> <span>${esc(x.answer)}</span></div>
          <div class="small mut">${x.source === 'learned' ? `Learned from ${esc(x.added_by || 'the team')}${x.driver ? ` (${esc(x.driver)}'s group)` : ''}` : `Added by ${esc(x.added_by || '')}`}, ${esc(dateText(String(x.created_at).slice(0, 10), { month: 'short', day: 'numeric' }))}${x.active ? '' : ', turned off'}
          · <button type="button" class="linkbtn" data-act="tgkEdit">Edit</button> · <button type="button" class="linkbtn" data-act="tgkToggle">${x.active ? 'Turn off' : 'Turn on'}</button>${admin ? ' · <button type="button" class="linkbtn danger" data-act="tgkDel">Delete</button>' : ''}</div></li>`).join('') || '<li class="hint">Nothing yet. It fills up as the team answers drivers.</li>'}</ul>`;
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
      <section class="card"><h2>In the onboarding group</h2><ol class="gsteps">
      <li>The bot welcomes the driver, posts a card with the Amazon Relay steps, reports and start date, and keeps it up to date.</li>
      <li>It tells the driver what to do at each Amazon step (account, Relay profile, Accurate background check), with a button to tap when done. A Relay screenshot moves the step too. Steps also follow what you set on the website.</li>
      <li>Stuck on a step: a reminder each day (3 times), then the recruiter is told. Waiting for Amazon over 7 days: the recruiter is told.</li>
      <li>A screenshot that looks approved: the recruiter confirms "verified" with a button.</li>
      <li>Background check, MVR, PSP, drug test or Clearinghouse results the driver sends are read (result and findings only, no personal details) and the recruiter approves them. An approved MVR ticks "MVR checked".</li>
      <li>A CDL or medical card photo: its expiry date is saved, and you hear if it expires soon.</li>
      <li>The driver's questions are answered from the company facts (Settings → Call guide) and the Knowledge list. If the bot is not sure, it tags the recruiter; the recruiter's answer, in Telegram or on this page, is learned for next time.</li>
      <li>The day before the start date, the driver gets the arrival details and the truck.</li>
      <li>While a recruiter is chatting with the driver, the bot stays quiet.</li></ol></section>
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
        ${r.onb ? `<section class="card"><h3>Amazon Relay</h3><ol class="tgsteps">${r.onb.amazon.map((x) => `<li class="${x.done ? 'done' : ''}"><span aria-hidden="true">${x.done ? '✅' : '⬜'}</span><span>${esc(x.label)}</span>${x.at ? `<small>${esc(when(x.at))}</small>` : '<small></small>'}</li>`).join('')}</ol></section>
        ${r.onb.questions.some((x) => !x.answer) ? `<section class="card tgqs"><h3>Questions waiting for you</h3><ul class="list">${r.onb.questions.filter((x) => !x.answer).map((x) => qBox(x, false)).join('')}</ul></section>` : ''}
        <section class="card"><h3>Reports the driver sent</h3>${r.onb.reports.length ? `<ul class="list tgreps">${r.onb.reports.map((x) => `<li data-rep="${x.id}"><div class="grow"><b>${esc(x.label)}</b> <span class="${x.result === 'clear' ? 'okt' : x.result === 'issues' ? 'latetag' : 'small mut'}">${esc(x.resultText)}</span> <span class="small mut">${esc(when(x.at))}</span>
            ${(x.findings || []).length ? `<ul class="small">${x.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</div>
            <div>${x.review === 'ok' ? `<span class="okt">Approved</span> <span class="small mut">${esc(x.reviewed_by || '')}</span>` : x.review === 'look' ? `<span class="latetag">Needs a look</span>` : ''}
            ${x.review !== 'ok' ? '<button type="button" class="btn plain sm" data-act="tgRep" data-v="ok">Approve</button>' : ''}${!x.review ? ' <button type="button" class="btn plain sm" data-act="tgRep" data-v="look">Needs a look</button>' : ''}</div></li>`).join('')}</ul>` : '<p class="hint">When the driver sends a background check, MVR, PSP, drug test or Clearinghouse result, the bot reads it and lists it here (only the result, no personal details).</p>'}</section>
        ${r.onb.questions.some((x) => x.answer) ? `<section class="card"><h3>Questions answered</h3><ul class="list">${r.onb.questions.filter((x) => x.answer).map((x) => `<li><div><b>Q:</b> ${esc(x.text)}</div><div><b>A:</b> ${esc(x.answer)} <span class="small mut">${esc(x.answered_by || '')}</span></div></li>`).join('')}</ul></section>` : ''}` : ''}
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
    host.innerHTML = `<h4>Telegram groups${r.openQuestions ? ` <span class="latetag">${r.openQuestions} question${r.openQuestions > 1 ? 's' : ''} waiting</span>` : ''}</h4><ul class="tglead">${['onboarding', 'eld', 'accounting', 'updates'].map((k) => {
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
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form.tgqf'); if (f) { e.preventDefault(); const li = f.closest('[data-q]'); const b = f.querySelector('button'); b.disabled = true;
      try { await api(`/api/tg/questions/${li.dataset.q}/answer`, { method: 'POST', body: { answer: f.answer.value } }); toast('Sent in the group, and learned'); App.render(); } catch (er) { fail(er); b.disabled = false; } return; }
    const k = e.target.closest('#tgkForm'); if (k) { e.preventDefault(); try { await api('/api/tg/knowledge', { method: 'POST', body: { question: k.question.value, answer: k.answer.value } }); toast('Added'); App.render(); } catch (er) { fail(er); } }
  });
  on('tgkToggle', async (b) => { const li = b.closest('[data-k]'); await api('/api/tg/knowledge/' + li.dataset.k, { method: 'PATCH', body: { active: li.classList.contains('off') } }); App.render(); });
  on('tgkDel', async (b) => { if (!confirm('Delete this answer?')) return; await api('/api/tg/knowledge/' + b.closest('[data-k]').dataset.k, { method: 'DELETE' }); App.render(); });
  on('tgkEdit', (b) => {
    const li = b.closest('[data-k]'); const qv = li.querySelector('.kq span').textContent, av = li.querySelector('.ka span').textContent;
    dialog(`<form class="dform" id="tgkEditF"><h2>Edit the answer</h2><label class="fld">Question<input type="text" name="question" required></label><label class="fld">Answer<textarea name="answer" rows="4" required></textarea></label>
      <div class="dact"><button type="button" class="btn plain" data-act="closeDialog">Cancel</button><button class="btn primary">Save</button></div></form>`, (d) => {
      const f = d.querySelector('form'); f.question.value = qv; f.answer.value = av;
      f.onsubmit = async (e) => { e.preventDefault(); try { await api('/api/tg/knowledge/' + li.dataset.k, { method: 'PATCH', body: { question: f.question.value, answer: f.answer.value } }); d.close(); toast('Saved'); App.render(); } catch (er) { fail(er); } };
    });
  });
  on('tgRep', async (b) => { await api('/api/tg/reports/' + b.closest('[data-rep]').dataset.rep, { method: 'PATCH', body: { review: b.dataset.v } }); toast(b.dataset.v === 'ok' ? 'Approved' : 'Marked'); App.render(); });
  App.route(/^#\/telegram$/, viewList);
  App.route(/^#\/telegram\/(-?\d+)$/, viewChat);
  App.tgLeadGroups = leadGroups;
})();
