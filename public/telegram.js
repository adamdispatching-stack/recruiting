// Telegram manager: the bot's groups, what happened in each (AI summaries, ELD steps and checks, messages),
// who is who, and the bot's settings. Also the "Telegram groups" part of a lead's page.
(() => {
  const { $, esc, view, S, api, toast, fail, on, onChange, header, dialog, dateText, when, plural } = App;
  const KIND = { dispatch: 'Dispatch', eld: 'ELD', accounting: 'Accounting', management: 'Management', shift: 'Shift' };
  const AKIND = { container_mismatch: 'Container / number', wrong_location: 'Location', late_risk: 'Running late', appointment_change: 'Appointment', load_refused: 'Load refused', driver_upset: 'Driver upset', unprofessional_dispatcher: 'Dispatcher conduct', safety: 'Safety', other: 'Other' };
  const TKIND = { breakdown: 'Breakdown', repair: 'Repair', maintenance: 'Maintenance', oil_change: 'Oil change', tires: 'Tires', inspection: 'Inspection', damage: 'Damage', warning_light: 'Warning light', other: 'Other' };
  const MOOD = { good: '🙂 Good', neutral: '😐 Neutral', unhappy: '🙁 Unhappy', angry: '😠 Angry', unknown: '' };
  const PHASE = { docs: 'waiting on the driver: CDL and registration', login: 'waiting on the ELD team: login', driver: 'waiting on the driver: log in, manual, paper logs', checked: 'waiting on the ELD team: setup check', done: 'setup complete' };
  const ROLE = { driver: 'Driver', eld: 'ELD team', accounting: 'Accounting', dispatch: 'Dispatcher', staff: 'Our team' };
  let tab = 'groups', agView = 'active';

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
  const alertLi = (a, noDriver) => `<li data-al="${a.id}" class="${a.severity === 'high' ? 'hi' : ''}"><span class="grow"><span class="tgk ${a.severity === 'high' ? 'k-hi' : ''}">${esc(AKIND[a.kind] || a.kind)}</span> ${noDriver ? '' : `<a href="#/telegram/${a.chatId}"><b>${esc(a.driver)}</b></a>: `}${esc(a.text)} <span class="small mut">${esc(when(a.at))}</span></span>${a.resolved_at ? `<span class="small okt">Done, ${esc(a.resolved_by || '')}</span>` : '<button type="button" class="btn plain sm" data-act="tgAlertDone">Done</button>'}</li>`;
  function setupCard(st) {
    return `<section class="card tgsetup"><h3>Turn on the Telegram bot</h3>
      <ol class="gsteps">
        <li>In Telegram, open <b>@BotFather</b>, send <code>/newbot</code>, and give it a name (for example "FleetHire Assistant") and a user name ending in "bot". BotFather sends back a <b>token</b>. Don't share it with anyone or paste it in a chat.</li>
        <li>Still in BotFather: <code>/setprivacy</code>, pick your bot, choose <b>Disable</b>, so it can read every message in the groups.</li>
        <li>On Railway, open the website's service, <b>Variables</b>, and add <code>TELEGRAM_BOT_TOKEN</code> with the token. Railway restarts the website and the bot comes on.</li>
        <li>For AI (reading pictures, daily summaries) the variable <code>ANTHROPIC_API_KEY</code> must be there too${st.ai ? ' (it is)' : ''}.</li>
      </ol></section>`;
  }

  // ---------- the bot's history ----------
  const LOGK = { join: ['🤖', 'Joined'], left: ['👋', 'Removed'], title: ['🔎', 'Read the title'], connect: ['🔗', 'Connected'], wait: ['⏳', 'Waiting'], me: ['🔑', 'Connected Telegram'],
    tap: ['👆', 'Tapped a button'], reaction: ['😀', 'Reaction'], reply: ['💬', 'Replied to the bot'], cmd: ['⌨️', 'Command'], mode: ['⚙️', 'Mode'], fact: ['📝', 'Saved'], ask: ['❓', 'Asked'], said: ['🗨️', 'Bot said'] };
  const LOGF = [['', 'Everything'], ['join,left,title,connect,wait,me,mode', 'Groups and setup'], ['tap,reaction,reply', 'People\'s reactions'], ['said,ask,fact,cmd', 'What the bot said and saved']];
  const logLi = (x, withGroup = true) => `<li class="tglog k-${x.kind}"><span class="lgi" aria-hidden="true">${(LOGK[x.kind] || ['•'])[0]}</span><div class="grow"><div>${x.who && !x.text.startsWith(x.who) ? `<b>${esc(x.who)}</b> ` : ''}${esc(x.text)}</div>
    ${withGroup && (x.title || x.driver) ? `<div class="small mut">${x.chatId ? `<a href="#/telegram/${x.chatId}">${esc(x.title || 'Group')}</a>` : ''}${x.driver ? ` · <a href="${App.driverHref(x.driverId, x.hired ? 'Hired' : '')}">${esc(x.driver)}</a>` : ''}</div>` : ''}</div><span class="small mut lgt">${esc(when(x.at))}</span></li>`;
  let logFilter = '';
  // groups waiting for someone to connect their Telegram to the website
  const waitCard = (ws) => !ws.length ? '' : `<section class="card tgwait"><h3>Groups to connect <span class="cnt">${ws.length}</span></h3>
    <p class="hint">The bot is in these groups but could not connect them by itself: it is not sure whose group it is, or the person who added it has not connected Telegram to the website (then it connects once they send <b>/me CODE</b> to the bot). The bot writes nothing in the groups.</p>
    <ul class="list">${ws.map((w) => `<li data-w="${w.id}"><div class="grow"><b>${esc(w.title || 'Group')}</b> ${kindTag(w.kind)}${w.members ? ` <span class="small mut">${w.members} people${w.big ? ', a working driver\'s group' : ''}</span>` : ''}<div class="small">${esc(w.what)}</div><div class="small mut">${esc(when(w.at))}${w.link ? ` · <a href="${esc(w.link)}" target="_blank" rel="noopener noreferrer">Open group</a>` : ''}</div></div>
      ${S.me.role === 'dispatcher' ? '' : `<span class="inrow">${w.driverId ? `<button type="button" class="btn primary sm" data-act="tgWaitGo" data-d="${w.driverId}">Connect to ${esc(w.driver)}</button>` : ''}
        <select data-ch="tgWaitKind" aria-label="Which group">${[['dispatch', 'Dispatch'], ['eld', 'ELD'], ['accounting', 'Accounting'], ['management', 'Management (our team)']].map(([k, l]) => `<option value="${k}" ${w.kind === k ? 'selected' : ''}>${l} group</option>`).join('')}</select>${w.kind === 'management' ? '<button type="button" class="btn primary sm" data-act="tgWaitTeamGroup">Connect as our team\'s group</button>' : ''}
        <select data-ch="tgWaitPick" aria-label="The driver"><option value="">${w.driverId ? 'Another driver…' : 'Pick the driver…'}</option>${w.options.length ? `<optgroup label="Fits the title">${w.options.map((o) => `<option value="${o.id}">${esc(o.name)} (${esc(o.status === 'Hired' ? 'active' : o.status.toLowerCase())})</option>`).join('')}</optgroup>` : ''}${(w.others || []).length ? `<optgroup label="All drivers">${w.others.map((o) => `<option value="${o.id}">${esc(o.name)} (${esc(o.status === 'Hired' ? 'active' : o.status.toLowerCase())})</option>`).join('')}</optgroup>` : ''}</select>
        ${w.newName && !w.driverId ? `<button type="button" class="btn plain sm" data-act="tgWaitNew" data-k="${w.kind === 'dispatch' && !w.big ? 'onboarding' : 'active'}" title="Then connected as the group picked on the left">Add ${esc(w.newName)} as a new ${w.kind === 'dispatch' && !w.big ? 'driver in onboarding' : 'active driver'}</button>` : ''}
        ${S.me.role === 'admin' && w.who ? `<button type="button" class="btn plain sm" data-act="tgWaitTeam" title="They are on our team: connect this and every group they add">${esc(w.who)} is our team</button>` : ''}
        <button type="button" class="linkbtn" data-act="tgWaitNo">Dismiss</button></span>`}</li>`).join('')}</ul></section>`;
  const wKind = (el) => (el.closest('[data-w]').querySelector('[data-ch="tgWaitKind"]') || {}).value;
  on('tgWaitGo', async (b) => { try { await api('/api/tg/waiting/' + b.closest('[data-w]').dataset.w, { method: 'POST', body: { driverId: +b.dataset.d, kind: wKind(b) } }); toast('Connected'); } catch (e) { fail(e); } App.render(); });
  onChange('tgWaitPick', async (el) => { if (!el.value) return; try { await api('/api/tg/waiting/' + el.closest('[data-w]').dataset.w, { method: 'POST', body: { driverId: +el.value, kind: wKind(el) } }); toast('Connected'); } catch (e) { fail(e); } App.render(); });
  onChange('tgWaitKind', async (el) => { if (el.value !== 'management') return; try { await api('/api/tg/waiting/' + el.closest('[data-w]').dataset.w, { method: 'POST', body: { kind: 'management' } }); toast('Connected as our team\'s group'); } catch (e) { fail(e); } App.render(); });
  on('tgWaitTeam', async (b) => { try { const r = await api('/api/tg/waiting/' + b.closest('[data-w]').dataset.w, { method: 'POST', body: { team: true } }); toast(`Marked as our team${r.connected ? `, ${plural(r.connected, 'group')} connected` : ''}`); } catch (e) { fail(e); } App.render(); });
  on('tgWaitNew', async (b) => { try { await api('/api/tg/waiting/' + b.closest('[data-w]').dataset.w, { method: 'POST', body: { newDriver: b.dataset.k, kind: wKind(b) } }); toast('Added and connected'); } catch (e) { fail(e); } App.render(); });
  on('tgChatMode', async (b) => { try { await api(`/api/tg/chats/${b.dataset.chat}/mode`, { method: 'PATCH', body: { mode: b.dataset.m } }); toast(b.textContent.trim()); } catch (e) { fail(e); } App.render(); });
  on('tgUpd', async (b) => { try { await api('/api/tg/updates/' + b.closest('[data-u]').dataset.u, { method: 'POST', body: { ok: !!b.dataset.ok } }); b.parentNode.querySelectorAll('.ub').forEach((x) => x.classList.toggle('on', x === b)); } catch (e) { fail(e); } });
  on('tgWaitTeamGroup', async (b) => { try { await api('/api/tg/waiting/' + b.closest('[data-w]').dataset.w, { method: 'POST', body: { kind: 'management' } }); toast('Connected'); } catch (e) { fail(e); } App.render(); });
  on('tgTeamReport', async (b) => { b.disabled = true; b.textContent = 'Reading the groups…'; try { await api(`/api/tg/chats/${b.dataset.chat}/report`, { method: 'POST' }); toast('Sent to the group'); } catch (e) { fail(e); } b.disabled = false; b.textContent = 'Send the onboarding list now'; });
  on('tgWaitNo', async (b) => { try { await api('/api/tg/waiting/' + b.closest('[data-w]').dataset.w, { method: 'POST', body: { dismiss: true } }); toast('Dismissed'); } catch (e) { fail(e); } App.render(); });
  on('tgLogF', (b) => { logFilter = b.dataset.k; App.render(); });
  on('tgLogMore', async (b) => {
    b.disabled = true; try { const r = await api(`/api/tg/log?before=${b.dataset.before}${logFilter ? '&kinds=' + logFilter : ''}${b.dataset.chat ? '&chat=' + b.dataset.chat : ''}`);
      b.closest('section').querySelector('ul').insertAdjacentHTML('beforeend', r.log.map((x) => logLi(x, !b.dataset.chat)).join('')); if (r.more) { b.dataset.before = r.log[r.log.length - 1].id; b.disabled = false; } else b.remove(); } catch (e) { fail(e); b.disabled = false; }
  });

  async function viewList(qp) {
    if (qp && qp.get && qp.get('tab')) tab = qp.get('tab');
    const live = App.drawing();
    const [st, r] = await Promise.all([api('/api/tg/status'), api('/api/tg/chats')]); if (!live()) return;
    const admin = S.me.role === 'admin';
    document.title = 'Telegram · FleetHire';
    const status = !st.on ? '' : st.bot ? `<p class="tgstat ${st.lastError ? 'bad' : 'ok'}"><b>@${esc(st.bot.username)}</b> is ${st.lastError ? `having trouble: ${esc(st.lastError)}` : 'on'}${st.ai ? ', AI on' : ', AI off (no ANTHROPIC_API_KEY)'}.</p>` : `<p class="tgstat bad">The bot is starting${st.lastError ? `: ${esc(st.lastError)}` : ''}.</p>`;
    const tabs = `<nav class="fbtabs" aria-label="Telegram pages">${[['groups', 'Groups'], ...(admin ? [['all', 'All groups'], ['desk', 'Shift desk']] : []), ...(S.me.role === 'dispatcher' ? [] : [['history', 'Bot history'], ['knowledge', 'Autopilot']]), ...(admin ? [['people', 'People'], ['settings', 'Settings']] : []), ['how', 'How it works']].map(([k, l]) => `<button type="button" class="${tab === k ? 'on' : ''}" data-act="tgTab" data-tab="${k}" aria-current="${tab === k ? 'page' : 'false'}">${l}</button>`).join('')}</nav>`;
    let body = '';
    if (tab === 'groups') {
      const [qs, al, act, ws] = await Promise.all([(S.me.role === 'dispatcher' ? Promise.resolve([]) : api('/api/tg/questions').then((x) => x.questions)), api('/api/tg/alerts').then((x) => x.alerts), (S.me.role === 'member' ? Promise.resolve([]) : api('/api/active').then((x) => x.drivers)), (S.me.role === 'dispatcher' ? Promise.resolve([]) : api('/api/tg/waiting').then((x) => x.waiting))]); if (!live()) return;
      // active drivers, one table per company, with their three groups; the other groups (onboarding, not linked) below
      const byChat = Object.fromEntries(r.chats.map((c) => [c.chatId, c])); const used = new Set();
      const cell = (d, k) => { const c = d.groups && byChat[d.groups[k]]; if (!c) return `<td><span class="tgdot" title="In the group, type register ${k}">Not registered</span></td>`; used.add(c.chatId);
        const now = k === 'dispatch' && c.lastUpdate ? `${esc(App.updText(c.lastUpdate))} <span class="mut">${esc(when(c.lastUpdate.at))}</span>` : k === 'eld' ? eldLine(c.eld, c.lastCheck, c.openChecks) : k === 'accounting' ? (c.openQuestions ? `<span class="latetag">${c.openQuestions} waiting</span>` : '') : '';
        return `<td><a class="gname" href="#/telegram/${c.chatId}">${esc(c.title || KIND[k])}</a><div class="small mut">${c.todayMsgs ? plural(c.todayMsgs, 'message') + ' today' : 'quiet today'}${c.openAlerts ? ` · <span class="latetag">${plural(c.openAlerts, 'alert')}</span>` : ''}</div>${now ? `<div class="small">${now}</div>` : ''}</td>`; };
      const moody = (d) => d.moodIssue || d.openAlerts > 0;
      const coGroups = [...(S.me.companies || []).map((co) => [co, act.filter((d) => d.companyId === co.id)]), [null, act.filter((d) => !d.companyId || !(S.me.companies || []).some((co) => co.id === d.companyId))]]
        .filter(([, l]) => l.length).map(([co, l]) => [co, l.sort((a, b) => (moody(b) - moody(a)) || a.name.localeCompare(b.name))]);
      const coHtml = coGroups.map(([co, list]) => `<section class="cotable"><h3 class="cohead">${co ? App.coTag(co.id, true) : '<span class="co none">No company</span>'}<span class="small mut">${plural(list.length, 'active driver')}</span></h3>
        <div class="sheet"><table class="tgt tgco"><thead><tr><th>Driver</th><th>Dispatch</th><th>ELD</th><th>Accounting</th><th style="width:110px">Last 3 days</th></tr></thead><tbody>
        ${list.map((d) => `<tr class="${moody(d) ? 'hot' : ''}"><th scope="row"><a class="nml" href="#/active/${d.id}"><b>${esc(d.name)}</b></a>${d.truck ? `<div class="small mut">truck ${esc(d.truck.unit)}</div>` : ''}</th>${cell(d, 'dispatch')}${cell(d, 'eld')}${cell(d, 'accounting')}<td>${App.moodDots(d.mood)}</td></tr>`).join('')}</tbody></table></div></section>`).join('');
      const g = r.chats.filter((c) => !used.has(c.chatId));
      body = waitCard(ws) + (al.length ? `<section class="card tgal"><h3>Alerts from the groups <span class="cnt">${al.length}</span></h3><ul class="list">${al.map((a) => alertLi(a)).join('')}</ul></section>` : '') + (qs.length ? `<section class="card tgqs"><h3>Drivers' questions waiting for you <span class="cnt">${qs.length}</span></h3><ul class="list">${qs.map((x) => qBox(x, true)).join('')}</ul></section>` : '') + coHtml + (g.length ? `${coHtml ? '<h3 class="sect">Onboarding and other groups</h3>' : ''}<div class="sheet"><table class="tgt"><thead><tr><th>Driver</th><th>Group</th><th>Now</th><th>Latest summary</th><th class="n">Today</th></tr></thead><tbody>
        ${g.map((c) => `<tr data-chat="${c.chatId}" class="${c.openChecks || (c.eld && c.eld.waiting && c.eld.waiting.stuck) ? 'hot' : ''}"><th scope="row">${c.driverId ? `<a class="nml" href="${App.driverHref(c.driverId, c.active ? 'Hired' : '')}"><b>${esc(c.driver)}</b></a>` : '<span class="none">Not linked</span>'}</th>
          <td>${kindTag(c.kind)}<div class="small mut clip1"><a href="#/telegram/${c.chatId}">${esc(c.title || 'Group')}</a></div>${c.botAdmin ? '' : '<div class="small latetag">Bot is not an admin</div>'}</td>
          <td>${c.kind === 'eld' ? eldLine(c.eld, c.lastCheck, c.openChecks) : c.onb ? onbLine(c.onb) : c.kind === 'accounting' ? `<span class="small">Answering pay questions</span>${c.openQuestions ? ` <span class="latetag">${c.openQuestions} waiting</span>` : ''}` : c.lastUpdate ? `<span class="small">${esc(App.updText(c.lastUpdate))}</span> <span class="small mut">${esc(when(c.lastUpdate.at))}</span>` : c.kind ? '<span class="small">Reading along: truck, notes, alerts</span>' : ''}${c.openAlerts ? ` <span class="latetag">${c.openAlerts} alert${c.openAlerts > 1 ? 's' : ''}</span>` : ''}</td>
          <td class="tgsum">${c.lastSummary ? `<span class="small mut">${esc(dateText(c.lastSummary.day, { month: 'short', day: 'numeric' }))}${MOOD[c.lastSummary.mood] ? ', ' + MOOD[c.lastSummary.mood] : ''}</span><div class="clip2">${esc(c.lastSummary.summary)}</div>${(c.lastSummary.issues || []).length ? `<div class="small latetag">${c.lastSummary.issues.length} open</div>` : ''}` : '<span class="none">None yet</span>'}</td>
          <td class="n">${c.todayMsgs || '<span class="none">0</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : coHtml ? '' : `<div class="emptycard"><div class="emptyart"><h2>No groups yet.</h2><p>Open a driver in onboarding and use <b>Link a group</b> in the Telegram part of the onboarding card. The bot joins in from there.</p></div></div>`);
    } else if (tab === 'desk' && admin) {
      // the shift desk: shifts and their dispatchers, who can be reached, what the bot asked and what they answered
      const [dk, rt] = await Promise.all([api('/api/tg/desk'), api('/api/tg/routines')]); if (!live()) return; const D = dk.desk; App._dk = dk;
      const ago = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 60 ? m + ' min' : (m / 60).toFixed(m < 600 ? 1 : 0) + ' h'; };
      const B = rt.boards.latest;
      const boardHtml = `<section class="card"><h3>Booking list${B ? ` <span class="small mut">· ${esc(B.shift || '')} shift, ${esc(B.posted_by || '')}, ${esc(when(B.at))}</span>` : ''}</h3>
        ${B ? `<div class="hubs">${rt.boards.hubs.map((h) => { const it = B.items.filter((x) => x.hub === h); return `<div class="hub"><h4>${esc(h)}</h4>${it.length ? `<ul>${it.map((x) => `<li>${x.star ? '<span class="star" title="On a load, finishing near here: pre-book from his delivery">★</span> ' : ''}${x.driverId ? `<a href="#/active/${x.driverId}">${esc(x.driver)}</a>` : `${esc(x.name)} <span class="small cwarn" title="Not matched to a driver on the website">?</span>`}${!x.star ? ` <span class="small ${Date.now() - new Date(x.since) > 4 * 3600e3 ? 'cbad' : 'mut'}">ready ${ago(x.since)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="small mut">Nobody</p>'}</div>`; }).join('')}</div>` : '<p class="hint">No list yet today.</p>'}
        <p class="small mut">Post it in the shift's group (or send it to the bot): each location on its own line, then the names. A name alone = ready there now; with * = on a load, finishing near there (pre-book from his delivery). "Ready" turns red after 4 hours on the lists.</p>
        ${rt.boards.list.length > 1 ? `<details><summary class="small">Earlier lists (${rt.boards.list.length - 1})</summary><ul class="small">${rt.boards.list.slice(1).map((b) => `<li>${esc(when(b.at))} · ${esc(b.shift || '')} · ${esc(b.by || '')}: ${b.ready} ready, ${b.finishing} finishing</li>`).join('')}</ul></details>` : ''}</section>`;
      const notesHtml = `<section class="card"><h3>End-of-shift notes</h3><p class="hint">Before a shift ends, each driver's group gets an update note for the next shift. The bot sees the notes the dispatchers write; for the ones missing, here is a suggested note (from what the bot knows) to fix and post. ${D.routines && D.routines.notes !== false ? `The shift is reminded ${D.routines.notesMin} min before it ends, and told after it who has a note.` : ''}</p>
        ${rt.shifts.map((s) => `<details ${s.name === rt.now ? 'open' : ''}><summary><b>${esc(s.name)}</b> <span class="small mut">${esc(when(s.start))} – ${esc(when(s.end))} · ${s.drivers.filter((d) => d.note).length} of ${s.drivers.length} notes${s.name === rt.now ? ' · on shift now' : ''}</span></summary>
          <ul class="notes">${s.drivers.map((d) => `<li data-nd="${d.id}"><a href="#/active/${d.id}"><b>${esc(d.name)}</b></a> ${d.note ? `<span class="okt">✓ note</span> <span class="small mut">${esc(d.note.by_name || '')}, ${esc(when(d.note.at))}</span>` : `<span class="cwarn">no note yet</span>
            <textarea rows="4">${esc(d.suggest || '')}</textarea><div class="drow"><button class="btn primary sm" data-act="notePost">Post in his group</button></div>`}</li>`).join('') || '<li class="small mut">No working drivers with a dispatch group for this shift.</li>'}</ul></details>`).join('')}</section>`;
      const termsHtml = `<section class="card"><h3>Words our team uses</h3><p class="hint">The AI reads the groups with these meanings (for example "didn't catch" = we could not book the load offered). Add your own.</p>
        <table class="mini terms"><tbody>${rt.terms.map((t) => `<tr data-term="${t.id}"><td><b>${esc(t.term)}</b></td><td>${esc(t.meaning)}</td><td><button class="linkbtn danger" data-act="termDel">Remove</button></td></tr>`).join('')}</tbody></table>
        <form id="termForm" class="deskrow"><label class="fld sm">Words<input name="term" maxlength="60" placeholder="didn't catch" required></label><label class="fld" style="flex:1">Meaning<input name="meaning" maxlength="400" required placeholder="What our team means by it"></label><button class="btn plain">Add</button></form></section>`;
      const reach = (p) => (!p.tg_id ? '<span class="small cbad" title="He sends /me CODE to the bot (Connect my Telegram on the website)">Telegram not connected</span>' : p.private_ok ? '<span class="small okt">reachable</span>' : '<span class="small cwarn" title="He opens a chat with the bot and sends /start once">needs /start</span>');
      const KIND = { rest: '😴 Resting until', needs_load: '📦 Needs a load', question: '❓ Unanswered question', other: '🔎 To check', wake: '⏰ Wake-up check', rolling: '🚚 Where is he rolling to?', prebook: '📅 Next load pre-booked?', problem: '⚠️ Hard situation' };
      const KSHORT = { rolling: 'Regular check when his group shows no update', rest: 'Then the wake-up check at his time', question: 'Nobody from our team answered him', needs_load: 'He is empty or asks for a load', prebook: 'He delivers soon and no next load is seen', problem: 'Breakdown, refused or late load, wrong place, upset driver', other: 'Anything else the AI wants checked' };
      const LV = (n) => `<span class="lvl l${n}">L${n}</span>`;
      const levelsHtml = `<section class="card lvcard"><h3>Dispatcher levels</h3>
        <p class="hint">Each dispatcher gets the questions of his level. The truck's own dispatcher is still asked first when he is on shift and his level is high enough. Nobody of that level on shift: the next level up, then down. No answer in time: the level up.</p>
        <div class="lvgrid"><div><h4>People</h4><table class="mini lvppl"><tbody>${dk.people.map((p) => `<tr data-pid="${p.id}"><td>${esc(p.name)}${p.role === 'admin' ? ' <span class="small mut">admin</span>' : ''}</td>
            <td><select name="lvl" aria-label="Level of ${esc(p.name)}">${[1, 2, 3].map((n) => `<option value="${n}" ${+p.level === n ? 'selected' : ''}>${esc(dk.levels[n])}</option>`).join('')}</select></td>
            <td class="small mut">${p.suggest ? `AI review ${p.score} / 5: suggests ${LV(p.suggest)}` : ''}</td></tr>`).join('')}</tbody></table>
          <ul class="lvhelp small">${[1, 2, 3].map((n) => `<li>${LV(n)} ${esc(dk.levelHelp[n])}</li>`).join('')}</ul></div>
          <div><h4>Questions</h4><table class="mini lvq"><tbody>${dk.kinds.map((k) => `<tr><td>${esc(KIND[k] || k)}<div class="small mut">${esc(KSHORT[k] || '')}</div></td><td><select name="kl" data-k="${k}" aria-label="Level for ${esc(KIND[k] || k)}">${[1, 2, 3].map((n) => `<option value="${n}" ${+D.levels[k] === n ? 'selected' : ''}>Level ${n}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table>
          <label class="chk"><input type="checkbox" name="rollOn" ${D.rolling.on ? 'checked' : ''}> During shifts, ask where a working driver is rolling to when his group shows no update for <input type="number" name="rollH" min="2" max="24" value="${D.rolling.hours}" style="width:56px"> hours</label>
          <p class="small mut">Not while he rests or is at home. "Empty, no load" sends a load question to the booking level.</p></div></div></section>`;
      const STATE = { open: ['Waiting', 'cwarn'], ok: ['Got it', 'okt'], done: ['Done', 'okt'], answered: ['Answered', 'okt'], booked: ['Load booked', 'okt'], looking: ['Still looking', 'cwarn'], onit: ['On it', 'okt'], calling: ['Calling him', 'cwarn'], cancelled: ['Called off', ''] };
      const mins = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);
      const sgRow = App._sgRow = (g) => `<div class="sgrow"><select name="chatId" aria-label="Group"><option value="">Pick a group…</option>${dk.groups.map((x) => `<option value="${x.chat_id}" ${String(g.chatId || '') === x.chat_id ? 'selected' : ''}>${esc(x.title || 'Group')}${x.kind === 'management' ? ' (management)' : ''}</option>`).join('')}</select>
        <span class="cos">${dk.companies.map((co) => `<label class="pchip"><input type="checkbox" name="co" value="${co.id}" ${(g.companies || []).map(Number).includes(co.id) ? 'checked' : ''}> ${esc(co.name)}</label>`).join('') || '<span class="small mut">No companies yet</span>'}</span>
        <button type="button" class="linkbtn danger" data-act="deskDelGroup">Remove</button></div>`;
      body = `<section class="card deskcfg"><h3>Shifts ${dk.now ? `<span class="small mut">· on shift now: <b>${esc(dk.now)}</b></span>` : ''}</h3>
        <p class="hint">The bot reads the working drivers' groups and checks in with the dispatcher on shift, one to one in a private chat with the bot: a driver resting until a time ("Got it? No calls until then", then a check at that time), a driver who needs a load ("send me the best option you see now and why"), a question nobody answered. Each question goes to the dispatchers of its level (Dispatcher levels, below); the truck's own dispatcher first when he is on shift and his level is high enough. No answer in time: the level up, then the admins. Nothing is written in the driver groups.</p>
        <form id="deskForm"><div class="deskrow"><label class="chk"><input type="checkbox" name="on" ${D.on ? 'checked' : ''}> On</label>
          <label class="fld sm">Ask<select name="where"><option value="private" ${D.where !== 'group' ? 'selected' : ''}>In a private chat with the bot</option><option value="shift" ${D.where === 'shift' ? 'selected' : ''}>In the shift's Telegram group (tagging him)</option><option value="group" ${D.where === 'group' ? 'selected' : ''}>In the driver's group (tagging him)</option></select></label>
          <label class="fld sm">Ask the others after (min)<input type="number" name="answerMin" min="5" max="120" value="${D.answerMin}"></label></div>
        ${D.shifts.map((s, i) => `<div class="shiftrow" data-i="${i}"><div class="deskrow"><label class="fld sm">Shift<input name="name" value="${esc(s.name)}"></label><label class="fld sm">From<input type="time" name="start" value="${esc(s.start)}"></label><label class="fld sm">To<input type="time" name="end" value="${esc(s.end)}"></label>
            <label class="fld sm">Time zone<select name="tz">${Object.entries(dk.tzs).map(([k, l]) => `<option value="${k}" ${(s.tz || 'America/New_York') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>
          <div class="sgroups"><span class="small mut">Telegram groups of this shift (when the bot asks in the shift's group). Give each group its companies, or leave none for every company.</span>
            ${(s.groups || (s.chatId ? [{ chatId: s.chatId, companies: [] }] : [])).map((g) => sgRow(g)).join('')}
            <button type="button" class="linkbtn" data-act="deskAddGroup">+ Add a group</button></div>
          <div class="ppl">${dk.people.map((p) => `<label class="pchip"><input type="checkbox" name="p" value="${p.id}" ${(s.people || []).map(Number).includes(p.id) ? 'checked' : ''}> ${esc(p.name)}${p.role === 'admin' ? ' <span class="small mut">admin</span>' : ''} ${reach(p)}</label>`).join('')}</div></div>`).join('')}
        <div class="deskrow"><label class="fld">Booking list locations (commas)<input name="hubs" value="${esc((D.hubs || []).join(', '))}"></label>
          <label class="chk"><input type="checkbox" name="rBoard" ${D.routines && D.routines.board === false ? '' : 'checked'}> Remind the shift to post the list after <input type="number" name="rBoardMin" min="10" max="240" value="${(D.routines || {}).boardMin || 45}" style="width:64px"> min</label>
          <label class="chk"><input type="checkbox" name="rNotes" ${D.routines && D.routines.notes === false ? '' : 'checked'}> Remind about update notes <input type="number" name="rNotesMin" min="10" max="180" value="${(D.routines || {}).notesMin || 45}" style="width:64px"> min before the shift ends</label></div>
        ${levelsHtml}<div class="tgsave"><button class="btn primary">Save</button></div></form></section>${boardHtml}${notesHtml}${termsHtml}
        ${dk.speed.length ? `<section class="card"><h3>How fast they answer the bot, 30 days</h3><table class="mini"><thead><tr><th>Dispatcher</th><th class="n">Asked</th><th class="n">Answered</th><th class="n">Half within</th></tr></thead><tbody>${dk.speed.map((x) => `<tr><td>${esc(x.name)}</td><td class="n">${x.asked}</td><td class="n">${x.answered}</td><td class="n">${x.med === null ? '—' : x.med + ' min'}</td></tr>`).join('')}</tbody></table></section>` : ''}
        <section class="card"><h3>What the bot asked, last 7 days <span class="cnt">${dk.checks.length}</span></h3>${dk.checks.length ? `<div class="sheet"><table class="tgt"><thead><tr><th>When</th><th>Driver</th><th>What</th><th>Asked</th><th>Answer</th></tr></thead><tbody>
          ${dk.checks.map((c) => { const st = STATE[c.state] || [c.state, '']; const m = mins(c.asked_at, c.answered_at);
            return `<tr><td class="nowrap small">${esc(when(c.created_at))}</td><td>${c.driver_id ? `<a href="#/active/${c.driver_id}">${esc(c.driver)}</a>` : ''} <a class="small" href="#/telegram/${c.chat_id}">group</a></td>
              <td>${c.level ? LV(c.level) + ' ' : ''}${esc(KIND[c.kind] || c.kind)}${c.until_text ? ' <b>' + esc(c.until_text) + '</b>' : ''}${c.place ? ' · ' + esc(c.place) : ''}${c.quote ? `<div class="small mut">"${esc(c.quote)}"</div>` : ''}${c.ask ? `<div class="small">${esc(c.ask)}</div>` : ''}</td>
              <td class="small">${esc(c.asked || 'nobody on shift')}${c.escalated ? ' <span class="dtag warn">asked the level up</span>' : ''}</td>
              <td><span class="${st[1]}">${esc(st[0])}</span>${c.answered_by ? ` <span class="small mut">${esc(c.answered_by)}${m !== null ? `, ${m} min` : ''}</span>` : ''}${c.answer ? `<div class="small">${esc(c.answer)}</div>` : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="hint">Nothing yet. The bot asks when a working driver\'s group shows something to confirm.</p>'}</section>`;
    } else if (tab === 'all' && admin) {
      // every group the bot is in: not connected first, then connected; type and driver changed right here
      const [ag, dopt] = await Promise.all([api('/api/tg/all-groups'), api('/api/tg/driver-options')]); if (!live()) return;
      const st = (s) => (s === 'Hired' ? 'active' : String(s || '').toLowerCase());
      const dval = (id, name, status) => (id ? `${name} · ${st(status)} · #${id}` : '');
      const TYPES = [['dispatch', 'Dispatch'], ['eld', 'ELD'], ['accounting', 'Accounting'], ['management', 'Management (our team)'], ['shift', 'Shift group (dispatchers)']];
      const row = (g, open) => { const k = g.kind || (g.guess && g.guess.kind) || 'dispatch'; const did = g.driver_id || (g.guess && g.guess.driverId);
        const dn = g.driver_id ? dval(g.driver_id, g.driver, g.driver_status) : g.guess && g.guess.driverId ? dval(g.guess.driverId, g.guess.driver, g.guess.status) : '';
        return `<tr data-ag="${g.chat_id}" data-k="${g.kind || ''}" data-d="${g.driver_id || ''}"><th scope="row"><a href="#/telegram/${g.chat_id}">${esc(g.title || 'Group')}</a>
            <div class="small mut">${g.member_count ? plural(g.member_count, 'person', 'people') : ''}${g.msgs7 ? ` · ${plural(g.msgs7, 'message')} this week` : ' · quiet this week'}${g.bot_admin ? '' : ' · <span class="latetag">bot not admin</span>'}${g.pushed_by ? ` · pushed out by "${esc(g.pushed_by)}"` : ''}</div></th>
          <td><select data-ch="agKind" aria-label="Type">${TYPES.map(([v, l]) => `<option value="${v}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td><input class="agdrv" list="agDrivers" value="${esc(dn)}" placeholder="Type a driver's name" aria-label="Driver" ${['management', 'shift'].includes(k) ? 'disabled' : ''}>${open && g.guess && g.guess.driverId ? '<div class="small mut">Guessed from the title</div>' : ''}</td>
          <td class="small mut">${g.linked_by ? `${esc(g.linked_by)}, ` : ''}${g.linked_at ? esc(when(g.linked_at)) : ''}</td>
          <td class="acts"><button type="button" class="btn ${open ? 'primary' : 'plain'} sm" data-act="agSave">${open ? 'Connect' : 'Save'}</button>${open ? '' : ' <button type="button" class="btn plain sm" data-act="agOff">Disconnect</button>'}</td></tr>`; };
      const notc = ag.groups.filter((g) => g.active && !g.kind), conn = ag.groups.filter((g) => g.active && g.kind), gone = ag.groups.filter((g) => !g.active);
      const byKind = (a, b) => ['dispatch', 'eld', 'accounting', 'management'].indexOf(a.kind) - ['dispatch', 'eld', 'accounting', 'management'].indexOf(b.kind) || String(a.driver || '').localeCompare(String(b.driver || ''));
      const table = (list, open) => `<div class="sheet"><table class="tgt agt"><thead><tr><th>Group</th><th style="width:190px">Type</th><th style="width:300px">Driver</th><th>Connected by</th><th></th></tr></thead><tbody>${list.map((g) => row(g, open)).join('')}</tbody></table></div>`;
      // where the team's messages go: set by hand, one chat for each kind
      const teamG = ag.groups.filter((g) => g.active && ['management', 'shift'].includes(g.kind));
      const routeRow = (k) => { const now = ag.routes[k.key]; const cur = now ? now.chatId : '';
        const opt = (id, l) => `<option value="${id}" ${String(id) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`;
        return `<tr><th scope="row">${esc(k.label)}<div class="small mut">${esc(k.hint)}</div></th>
          <td><select data-ch="agRoute" data-key="${k.key}" aria-label="Where ${esc(k.label)} go"><option value="">Default${k.key === 'recruiting' ? ' (private chat of the admin with the bot)' : ''}</option>
            ${now && now.broken ? `<option value="${now.chatId}" selected>A chat that can no longer be used</option>` : ''}
            <optgroup label="Team groups">${teamG.map((g) => opt(g.chat_id, `${g.title || 'Group'} (${KIND[g.kind]})`)).join('')}</optgroup>
            ${k.priv && ag.privates.length ? `<optgroup label="Private chat with the bot">${ag.privates.map((p) => opt(p.chat_id, p.title || 'Private chat')).join('')}</optgroup>` : ''}</select>
            ${now && now.broken ? '<div class="small latetag">The chat picked before now belongs to a driver, or the bot left it. The default is used until you pick another.</div>' : ''}</td></tr>`; };
      const routesCard = `<p class="hint">Pick the chat for each kind of message. Only a Management or Shift group (or a private chat) can be picked, never a driver's group. To use another group, set its type to Management under All connected first.</p>
        <div class="sheet"><table class="tgt agt"><thead><tr><th>Kind of message</th><th style="width:380px">Goes to</th></tr></thead><tbody>${ag.routeKinds.map(routeRow).join('')}</tbody></table></div>
        <p class="hint">The shift groups of the dispatchers are set in <a href="#/shifts">Shift desk</a>.</p>`;
      // every driver with his three groups, and how the bot works in each (set by hand)
      const MODES = (k) => (k === 'dispatch' ? [['watch', '👀 Watch'], ['updater', '🚚 Updater']] : [['watch', '👀 Silent'], ['updater', '🛠 Runs']]);
      const own = {}; for (const g of ag.groups) if (g.active && g.driver_id && ['dispatch', 'eld', 'accounting'].includes(g.kind)) (own[g.driver_id] = own[g.driver_id] || {})[g.kind] = g;
      const dcell = (d, k) => { const g = (own[d.id] || {})[k]; if (!g) return '<td><span class="none">None</span></td>';
        return `<td><div class="gcell"><a class="gname" href="#/telegram/${g.chat_id}" title="${esc(g.title || KIND[k])}${g.bot_admin ? '' : ' (the bot is not an admin here)'}">${g.bot_admin ? '' : '<span class="latetag" aria-label="bot not admin">!</span> '}${esc(g.title || KIND[k])}</a>
          <select data-ch="agMode" data-chat="${g.chat_id}" aria-label="How the bot works in the ${KIND[k]} group of ${esc(d.name)}">${MODES(k).map(([v, l]) => `<option value="${v}" ${(g.mode || 'watch') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></td>`; };
      const byName = (x, y) => x.name.localeCompare(y.name);
      const dTable = (list) => { const withG = list.filter((d) => own[d.id]).sort(byName), noG = list.filter((d) => !own[d.id]).sort(byName);
        return `${withG.length ? `<div class="sheet"><table class="tgt agt agd"><thead><tr><th style="width:22%">Driver</th><th>Dispatch</th><th>ELD</th><th>Accounting</th></tr></thead><tbody>
          ${withG.map((d) => `<tr data-ag-d="${d.id}"><th scope="row"><a class="nml" href="${App.driverHref(d.id, d.status)}">${esc(d.name)}</a></th>${dcell(d, 'dispatch')}${dcell(d, 'eld')}${dcell(d, 'accounting')}</tr>`).join('')}</tbody></table></div>` : '<p class="hint">No driver here has a group yet.</p>'}
          ${noG.length ? `<details class="agnone"><summary>${plural(noG.length, 'driver')} with no group yet</summary><p class="small">${noG.map((d) => `<a href="${App.driverHref(d.id, d.status)}">${esc(d.name)}</a>`).join(' · ')}</p></details>` : ''}`; };
      const actD = ag.drivers.filter((d) => d.status === 'Hired'), onbD = ag.drivers.filter((d) => d.status !== 'Hired');
      const nG = (l) => l.filter((d) => own[d.id]).length;
      const VIEWS = [['active', 'Active drivers', nG(actD)], ['onb', 'Onboarding drivers', nG(onbD)], ['team', 'Team messages', null], ['open', 'Not connected', notc.length], ['conn', 'All connected', conn.length]];
      if (!VIEWS.some(([v]) => v === agView)) agView = 'active';
      const modeHint = '<p class="hint">How the bot works in each group, set by hand and saved as you pick. <b>Watch / Silent</b>: it reads and writes nothing of its own.</p>';
      const part = agView === 'active' ? modeHint + dTable(actD)
        : agView === 'onb' ? modeHint + dTable(onbD)
        : agView === 'team' ? routesCard
        : agView === 'open' ? `<p class="hint">The bot is in these groups but they belong to no one yet. Pick the type and the driver, then Connect. Nothing is written in the group.</p>${notc.length ? table(notc, true) : '<p class="hint">Every group is connected.</p>'}`
        : `<p class="hint">Change the type or the driver and press Save: what the wrong type started is undone, and a group it pushed out gets its place back.</p>${table(conn.sort(byKind), false)}`;
      body = `<datalist id="agDrivers">${dopt.drivers.map((d) => `<option value="${esc(dval(d.id, d.name, d.status))}"></option>`).join('')}</datalist>
        <div class="agbar"><nav class="fbtabs sub" aria-label="Show">${VIEWS.map(([v, l, n]) => `<button type="button" class="${agView === v ? 'on' : ''}" data-act="agView" data-v="${v}">${l}${n === null ? '' : ` <span class="cnt">${n}</span>`}</button>`).join('')}</nav>
          ${agView === 'team' ? '' : '<span class="agsearch"><input type="search" id="agFind" placeholder="Find a group or a driver" aria-label="Find a group or a driver"></span>'}</div>
        <section class="card agcard">${part}</section>
        ${gone.length ? `<details class="card"><summary>Groups the bot was removed from (${gone.length})</summary><ul class="list">${gone.map((g) => `<li><a href="#/telegram/${g.chat_id}">${esc(g.title || 'Group')}</a> <span class="small mut">${g.kind ? kindTag(g.kind) : ''}${g.driver ? ' ' + esc(g.driver) : ''}</span></li>`).join('')}</ul></details>` : ''}`;
    } else if (tab === 'history') {
      const lg = await api('/api/tg/log' + (logFilter ? '?kinds=' + logFilter : '')); if (!live()) return;
      const wk = lg.week; const n = (ks) => ks.reduce((a, k) => a + (wk[k] || 0), 0);
      body = `<dl class="figs tglogfig"><div><dd>${n(['connect'])}</dd><dt>groups connected</dt></div><div><dd>${n(['tap', 'reaction', 'reply'])}</dd><dt>reactions to the bot (taps, emoji, replies)</dt></div>
          <div><dd>${n(['said'])}</dd><dt>messages the bot wrote</dt></div><div><dd>${n(['wait'])}</dd><dt>times the bot waited for someone to connect Telegram</dt></div></dl><p class="small mut">Last 7 days.</p>
        <nav class="fbtabs sub" aria-label="Show">${LOGF.map(([k, l]) => `<button type="button" class="${logFilter === k ? 'on' : ''}" data-act="tgLogF" data-k="${k}">${l}</button>`).join('')}</nav>
        <section class="card"><ul class="list tgloglist">${lg.log.map((x) => logLi(x)).join('') || '<li class="hint">Nothing yet. Everything the bot does, and every button, emoji and reply to it, shows up here.</li>'}</ul>
        ${lg.more ? `<p><button type="button" class="btn plain sm" data-act="tgLogMore" data-before="${lg.log[lg.log.length - 1].id}">Show older</button></p>` : ''}</section>`;
    } else if (tab === 'knowledge') {
      const [kAll, rd, dr, ln] = await Promise.all([api('/api/tg/knowledge').then((x) => x.knowledge), api('/api/tg/readiness'), admin ? api('/api/tg/dispatch-readiness') : Promise.resolve(null), api('/api/tg/learning').catch(() => null)]); if (!live()) return;
      const disp = kAll.filter((x) => x.kind === 'dispatch'); const kN = kAll.filter((x) => x.kind !== 'dispatch');
      const review = kN.filter((x) => x.review && !x.active);
      const pct = (v) => (v === null ? 'not measured yet' : Math.round(v * 100) + '%');
      body = `<section class="card autop"><h3>Onboarding autopilot<span class="grow"></span>${rd.ready ? '<span class="onl">Ready to run alone</span>' : '<span class="small mut">Still learning</span>'}</h3>
        <p class="hint">The bot learns from every onboarding group: the answers your team gives, and whether the steps it sees done are right. When it is right often enough, new onboarding groups can start in "Run the onboarding", with no recruiter needed.</p>
        <dl class="figs"><div><dd>${pct(rd.steps.accuracy)}</dd><dt>steps it saw done that were right (${rd.steps.confirmed} of ${rd.steps.confirmed + rd.steps.rejected})</dt></div>
          <div><dd>${pct(rd.questions.share)}</dd><dt>driver questions it answered itself, last 30 days (${rd.questions.byBot} of ${rd.questions.total})</dt></div>
          <div><dd>${rd.knowledge.approved}</dd><dt>answers it knows${rd.knowledge.waiting ? `, ${rd.knowledge.waiting} to approve below` : ''}</dt></div>
          <div><dd>${pct(rd.self.accuracy)}</dd><dt>of its own drafts matched what your team really wrote, last 30 days (${rd.self.same} same, ${rd.self.partly} partly, ${rd.self.wrong} wrong)</dt></div></dl>
        <p class="small mut">Ready when it was right on at least 90% of 15 or more steps, and answers 70% of 20 or more questions itself.</p>
        <p class="small ${rd.self.canTry ? 'okt' : 'mut'}">${rd.self.canTry ? 'Its drafts match your team often enough to try "Answer questions" on a few drivers.' : 'The bot grades itself: each time a recruiter answers a driver, it compares its own draft with what they wrote. Worth trying "Answer questions" at 80% over 20 or more drafts.'}</p>
        ${(rd.self.misses || []).length ? `<details class="selfmiss"><summary>Where its drafts were off (${rd.self.misses.length})</summary><ul class="list">${rd.self.misses.map((m) => `<li><span class="grow"><b>${esc(m.name || 'Driver')}</b> <span class="${m.grade === 'wrong' ? 'cbad' : 'cwarn'}">${m.grade === 'wrong' ? 'Wrong' : 'Partly right'}</span> <span class="small mut">${esc(when(m.at))}</span>
          <span class="small" style="display:block">${esc(m.note || '')}</span>
          <span class="small mut" style="display:block">Driver: “${esc((m.asked || '').slice(0, 200))}”</span>
          <span class="small mut" style="display:block">Bot drafted: “${esc((m.draft || '').slice(0, 240))}”</span>
          <span class="small mut" style="display:block">Your team wrote: “${esc((m.team || '').slice(0, 240))}”</span></span></li>`).join('')}</ul>
          <p class="small mut">Add or fix the answer in the knowledge below and the bot gets it right next time.</p></details>` : ''}
        ${admin ? `<form id="autoForm" class="autof"><label class="fld">New onboarding groups start in<select name="onbMode">${[['watch', '👀 Watch and learn'], ['assist', '💬 Answer questions'], ['run', '🚀 Run the onboarding']].map(([m, l]) => `<option value="${m}" ${rd.settings.onbMode === m ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="chk"><input type="checkbox" name="autoTick" ${rd.settings.autoTick ? 'checked' : ''}> The AI ticks onboarding steps by itself (you can still undo)</label><button class="btn primary sm">Save</button></form>` : ''}</section>
        ${ln ? learnCard(ln, admin) : ''}
        ${dr ? `        <section class="card autop dautop"><h3>Dispatch autopilot<span class="grow"></span>${dr.ready ? '<span class="onl">Ready to run updates</span>' : '<span class="small mut">Still learning</span>'}</h3>
        <p class="hint">The bot learns from every working driver's dispatch group: how each dispatcher writes and runs updates, the load updates, and each driver (mood, whether he keeps his word). When it is right often enough, the groups can switch to 🚚 Updater.</p>
        <dl class="figs"><div><dd>${dr.groups.groups}</dd><dt>working groups (${dr.groups.watched} watched 14+ days${dr.groups.updater ? `, ${dr.groups.updater} on Updater` : ''})</dt></div>
          <div><dd>${dr.messages30}</dd><dt>messages read, last 30 days</dt></div>
          <div><dd>${pct(dr.updates.accuracy)}</dd><dt>load updates read right (${dr.updates.ok} of ${dr.updates.ok + dr.updates.wrong} checked, ${dr.updates.total} seen)</dt></div>
          <div><dd>${dr.practices.approved}</dd><dt>dispatching practices approved${dr.practices.waiting ? `, ${dr.practices.waiting} to approve below` : ''}</dt></div>
          <div><dd>${dr.promises.kept + dr.promises.broken ? Math.round((dr.promises.kept / (dr.promises.kept + dr.promises.broken)) * 100) + '%' : '-'}</dd><dt>driver promises kept (${dr.promises.kept} of ${dr.promises.kept + dr.promises.broken}, ${dr.promises.open} open)</dt></div></dl>
        <p class="small mut">Ready when 3 or more groups were watched 14+ days, 10 practices are approved, and it read 90% of 20 or more checked load updates right (check them with ✓ / ✗ on a group's page).</p>
        ${admin ? `<form id="workForm" class="autof"><label class="fld">New working drivers' groups start in<select name="workMode">${[['watch', '👀 Watch and learn'], ['updater', '🚚 Updater']].map(([m, l]) => `<option value="${m}" ${dr.settings.workMode === m ? 'selected' : ''}>${l}</option>`).join('')}</select></label><button class="btn primary sm">Save</button></form>` : ''}
        ${dr.dispatchers.length ? `<h4 class="sub">Dispatchers</h4><div class="dcards">${dr.dispatchers.map((x) => { const p = x.profile || {}; const chip = (v, map) => (v ? `<span class="dchip d-${esc(v)}">${esc(map[v] || v)}</span>` : '');
          return `<article class="dcard"><header><a href="#/dispatcher/${x.tg_id}"><b>${esc(x.name)}</b></a> <a class="small" href="#/dispatcher/${x.tg_id}">Full review →</a><span class="small mut">${plural(x.msgs30, 'message')}, ${plural(x.groups, 'group')}, 30 days${x.reply_min !== null && x.reply_min !== undefined ? ` · answers drivers in ${x.reply_min < 60 ? x.reply_min + ' min' : (x.reply_min / 60).toFixed(1) + ' h'}` : ''}</span></header>
            ${x.profile ? `<div class="dchips">${chip(p.tone, { friendly: 'Friendly', neutral: 'Neutral', firm: 'Firm', harsh: 'Harsh' })}${chip(p.clarity, { clear: 'Clear', mostly_clear: 'Mostly clear', unclear: 'Unclear' })}${chip(p.professionalism, { high: 'Very professional', medium: 'Professional', low: 'Not professional' })}</div>
            <p>${esc(p.summary || '')}</p>${[['How he runs updates', p.update_habits], ['Typical messages', p.phrases], ['Strengths', p.strengths], ['To improve', p.improve]].filter(([, a]) => a && a.length).map(([t, a]) => `<div class="small"><b>${t}</b><ul>${a.map((y) => `<li>${esc(y)}</li>`).join('')}</ul></div>`).join('')}
            <p class="small mut">Written by the AI from the messages, ${esc(when(x.profile_at))}.</p>` : '<p class="small mut">The profile is written once the bot has read 20 or more of this dispatcher\'s messages.</p>'}</article>`; }).join('')}</div>` : '<p class="small mut">No dispatchers known yet: the bot learns who they are from the working groups (or set them under People).</p>'}</section>` : ''}
        <section class="card kbcard"><h3>Knowledge base<span class="grow"></span><a class="btn primary sm" href="#/kb">Open the knowledge base</a></h3>
          <p class="hint">What the bot learns from the groups (answers the team gives drivers, how dispatchers handle things, facts about sites and roads) is kept in the knowledge base, by topic, with how often it came up. The bot answers drivers only with approved answers.</p>
          <dl class="figs"><div><dd>${kAll.filter((x) => x.active).length}</dd><dt>in use</dt></div><div><dd>${review.length + disp.filter((x) => x.review && !x.active).length}</dd><dt>to approve</dt></div><div><dd>${disp.length}</dd><dt>dispatching practices</dt></div></dl></section>`;
    } else if (tab === 'people') {
      const p = await api('/api/tg/people'); if (!live()) return;
      body = `${likelyTeamCard(p.likelyTeam || [])}<p class="hint">Everyone the bot has seen in its groups. The bot learns who is a dispatcher, the driver, ELD or accounting from what they write; dispatchers are listed first. Drivers and the ELD team usually set this themselves with the buttons; change it here if it is wrong. "Our team" can tap any button.</p>
        <div class="sheet"><table class="tgt"><thead><tr><th>Name</th><th>Telegram</th><th>Role</th><th>Driver</th><th class="n">Groups</th><th class="n">Messages, 7 days</th><th class="n" title="Median time from a driver's message to this person's reply, last 7 days">Reply time</th><th>Last seen</th></tr></thead><tbody>
        ${p.people.map((x) => `<tr data-tg="${x.tg_id}"><th scope="row">${esc(x.name || '')}${x.user_name ? `<div class="small mut">${esc(x.user_name)} on the website</div>` : ''}</th><td>${x.username ? '@' + esc(x.username) : '<span class="none">No user name</span>'}</td>
          <td><select data-ch="tgRole" aria-label="Role of ${esc(x.name || '')}"><option value="">Unknown</option>${p.roles.map((k) => `<option value="${k}" ${x.role === k ? 'selected' : ''}>${ROLE[k]}</option>`).join('')}</select></td>
          <td>${x.driver ? `<a href="#/driver/${x.driver_id}">${esc(x.driver)}</a>` : '<span class="none">-</span>'}</td><td class="n">${x.groups}</td><td class="n">${x.msgs7 || '<span class="none">0</span>'}</td><td class="n">${x.reply_min !== null && x.reply_min !== undefined && x.role !== 'driver' ? `${x.reply_min < 60 ? x.reply_min + ' min' : (x.reply_min / 60).toFixed(1) + ' h'} <span class="small mut">(${x.replies})</span>` : '<span class="none">-</span>'}</td><td class="small">${x.seen_at ? esc(when(x.seen_at)) : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="hint">Nobody yet.</td></tr>'}</tbody></table></div>`;
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
    view.innerHTML = header(tab === 'desk' && location.hash.startsWith('#/shifts') ? 'shifts' : 'telegram') + `<main>${App.pageHead('Telegram manager', 'Each driver has a dispatch, an ELD and an accounting group. The bot reads every message, helps where it can, and keeps the team informed.', '<button type="button" class="btn plain" data-act="tgMe">Connect my Telegram</button>')}
      ${st.on ? status : setupCard(st)}${tabs}${body}</main>`;
    const f = document.getElementById('tgForm');
    if (f) f.onsubmit = async (e) => { e.preventDefault(); const d = new FormData(f);
      try { await api('/api/settings', { method: 'PUT', body: { tg: { eldTimes: d.get('eldTimes'), eldDays: +d.get('eldDays'), remindMin: +d.get('remindMin'), eldTeam: d.get('eldTeam'), summaryAt: d.get('summaryAt') } } }); toast('Saved'); App.render(); } catch (er) { fail(er); } };
  }
  // people in many driver groups the bot has not placed: almost surely our team. Marked once, they never show up as a driver.
  const likelyTeamCard = (list) => (list.length ? `<section class="card"><h3>Probably our team <span class="cnt">${list.length}</span></h3>
    <p class="hint">Each is in 5 or more driver groups, which a driver almost never is. Say who they are once: our team is then left out when picking a driver's account.</p>
    <ul class="list">${list.map((x) => `<li data-tg="${x.tg_id}"><span class="grow"><b>${esc(x.name || 'No name')}</b>${x.username ? ` <span class="small mut">@${esc(x.username)}</span>` : ''}<div class="small mut">In ${x.groups} groups${x.role === 'driver' && x.driver ? ` · now set as ${esc(x.driver)}'s account` : ''}</div></span>
      ${['staff', 'dispatch', 'eld', 'accounting'].map((k) => `<button type="button" class="btn plain sm" data-act="tgTeamRole" data-role="${k}">${ROLE[k]}</button>`).join('')}<button type="button" class="linkbtn" data-act="tgNotTeam">Not our team</button></li>`).join('')}</ul></section>` : '');
  function howHtml() {
    return `<article class="fbguide"><section class="card"><h2>Each driver has three groups</h2><ol class="gsteps">
      <li><b>Dispatch</b>: made when onboarding starts. It is the onboarding group first; once the driver is hired, the dispatchers run it.</li>
      <li><b>ELD</b> and <b>accounting</b>: made when the driver arrives.</li>
      <li>Add the driver, the people who work on it, and the bot, and make the bot an <b>admin</b>.</li>
      <li>In the group, type <code>register dispatch</code> (or <code>register eld</code>, <code>register accounting</code>). The bot finds the driver from the group's name, or add the name: <code>register eld John Smith</code>. Tap the right driver. A fleet driver not on the website yet can be added right there.</li>
      <li>First time? Click <b>Connect my Telegram</b> at the top of this page and send the bot the code it shows, so it knows you are on the team.</li>
      <li>Every active driver should have all three; the Active drivers page shows which are missing.</li></ol></section>
      <section class="card"><h2>In every group, all the time</h2><ol class="gsteps">
      <li>The bot reads every message and photo, a few minutes after a conversation settles.</li>
      <li><b>Truck</b>: breakdowns, warning lights, repairs, oil changes, tires and shop visits go on the truck's history (Trucks page), and are marked fixed when the group says so. A breakdown or damage tells the admins.</li>
      <li><b>The driver</b>: routines and requests ("call me at 7 AM"), loads he likes or refuses, home time, how he works and how to talk to him. These build his <b>profile for dispatchers</b> on his page, rebuilt every day. Your own notes there always win. It is never shown in the driver's groups. Send the bot <code>/driver Name</code> in a private chat to get it in Telegram.</li>
      <li><b>Alerts</b>: a container or trailer number in a photo that does not match the load (the bot asks the driver right away), a changed appointment (the bot confirms it in the group), an upset driver, a safety issue, a dispatcher being rude (admins only). They are listed at the top of Groups.</li>
      <li>Every evening, a summary of each group's day.</li></ol></section>
      <section class="card"><h2>A group that is already going</h2><ol class="gsteps">
      <li>Name the group with the driver's <b>name and phone number</b> (add <b>ELD</b> or <b>Accounting</b> for those groups), then add the bot and make it an admin. It finds the driver on the website and connects the group by itself. It writes nothing in the group. If it is not sure whose group it is, the group shows under <b>Groups to connect</b> on this page; you can also type <code>/register</code>. For a driver still onboarding, the bot starts in <b>Watch and learn</b>: it reads, sums up on the website and learns, and never writes. To change it, type <code>/mode</code> in the group (<b>Answer questions</b> or <b>Run the onboarding</b>) or use the driver's page.</li><li>Working drivers' groups (more than 10 people, or the driver is active on the website): the bot learns quietly: who the dispatchers are, the load updates (at pickup, loaded, rolling, ETA, delivered) and how our dispatchers handle things (Knowledge → How our dispatchers work). When a driver in onboarding is hired, the onboarding group becomes the driver's dispatch group by itself. Switch a group to <b>Updater</b> on its page when it knows the group well.</li>
      <li>A bot cannot read messages from before it joined. To bring them in: Telegram Desktop → the group → ⋮ → Export chat history → JSON, then <b>Bring in earlier messages</b> on the group's page. The AI reads them for the summary, the steps done, notes, and what the team answered; nothing is sent in the group.</li>
      <li>On the driver's page the bot shows where the onboarding stands, who it is waiting on, the next step, and the steps it saw done. Confirm or reject them: that is how its accuracy is measured.</li>
      <li>Knowledge tab: approve the answers it learned from the team, and watch the <b>Onboarding autopilot</b> numbers. When it is ready, start new groups in "Run the onboarding".</li></ol></section>
      <section class="card"><h2>In the dispatch group, while onboarding</h2><ol class="gsteps">
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
</section>
      <section class="card"><h2>In the accounting group</h2><ol class="gsteps">
      <li>The accounting people tap "I am with accounting".</li>
      <li>The bot answers the driver's pay and settlement questions from the company facts and what accounting taught it. Not sure: it tags accounting. Their answer is learned (Knowledge tab).</li></ol></section></article>`;
  }

  async function viewChat(id) {
    const live = App.drawing(); const r = await api('/api/tg/chats/' + encodeURIComponent(id)); if (!live()) return;
    const c = r.chat; const admin = S.me.role === 'admin';
    document.title = `${c.title || 'Group'} · Telegram · FleetHire`;
    const e = r.eld;
    view.innerHTML = header('telegram') + `<main><a class="back" href="#/telegram">← Telegram manager</a>
      ${App.pageHead(c.title || 'Telegram group', `${c.kind ? KIND[c.kind] + ' group' : 'Not linked'}${c.driverId ? ` for <a href="${App.driverHref(c.driverId, c.driverStatus)}">${esc(c.driver)}</a>` : ''}${c.linkedAt ? `, linked ${esc(dateText(String(c.linkedAt).slice(0, 10)))}` : ''}`)}
      <div id="chatDrafts"></div><div id="chatCases"></div>
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
        ${(r.alerts || []).length ? `<section class="card"><h3>Alerts</h3><ul class="list tgalerts">${r.alerts.map((a) => alertLi({ ...a, chatId: c.chatId }, true)).join('')}</ul></section>` : ''}
        ${(r.truckEvents || []).length ? `<section class="card"><h3>Truck issues from this group</h3><ul class="list">${r.truckEvents.map((e) => `<li><span class="grow"><span class="tst ${e.status}">${esc(e.status === 'fixed' ? 'Fixed' : e.status === 'scheduled' ? 'Scheduled' : 'Open')}</span> <b>${esc(e.title)}</b>${e.unit ? ` <span class="small mut">truck ${esc(e.unit)}</span>` : ''}${e.details ? `<div class="small">${esc(e.details)}</div>` : ''}</span><span class="small mut">${esc(when(e.at))}</span></li>`).join('')}</ul><p class="hint">All of it is on the truck's history, on the Trucks page.</p></section>` : ''}
        ${(r.notes || []).length ? `<section class="card"><h3>Noticed about the driver</h3><ul class="list">${r.notes.map((n) => `<li><span class="grow">${esc(n.text)}</span><span class="small mut">${esc(when(n.at))}</span></li>`).join('')}</ul><p class="hint">These build the driver's profile for dispatchers, on <a href="${App.driverHref(c.driverId, c.driverStatus)}">the driver's page</a>.</p></section>` : ''}
        <section class="card"><h3>Daily summaries<span class="grow"></span><button type="button" class="btn plain sm" data-act="tgImport" data-chat="${c.chatId}">Bring in earlier messages</button> <button type="button" class="btn plain sm" data-act="tgSum" data-chat="${c.chatId}">Sum up today now</button></h3>
          ${r.summaries.length ? r.summaries.map((s) => `<article class="tgday"><h4>${esc(dateText(s.day, { weekday: 'short', month: 'short', day: 'numeric' }))} <span class="small mut">${s.messages} messages${MOOD[s.mood] ? ', driver ' + MOOD[s.mood] : ''}</span></h4><p>${esc(s.summary)}</p>${(s.issues || []).length ? `<ul class="tgissues">${s.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</article>`).join('') : `<p class="hint">The first summary comes this evening${r.ai ? '' : ' (AI is off: only a message count without ANTHROPIC_API_KEY)'}.</p>`}</section>
      </div><div>
        <section class="card"><h3>People</h3><ul class="list">${r.people.map((p) => `<li><span class="grow"><b>${esc(p.name || '')}</b> ${p.username ? `<span class="small mut">@${esc(p.username)}</span>` : ''}</span><span class="tgk ${p.role ? 'k-' + p.role : 'none'}">${p.role ? ROLE[p.role] : 'Unknown'}</span></li>`).join('') || '<li class="hint">Nobody has written yet.</li>'}</ul>
          ${admin ? '<p class="hint">Change roles under <button type="button" class="linkbtn" data-act="tgPeople">People</button>.</p>' : ''}</section>
        <section class="card"><h3>Messages <span class="small mut">last ${r.messages.length}</span></h3><ol class="tgmsgs">${r.messages.map((m) => `<li class="${m.is_bot ? 'bot' : ''}"><div class="mh"><b>${esc(m.is_bot ? 'Bot' : m.from_name || '')}</b>${m.role ? ` <span class="small mut">${esc(ROLE[m.role] || m.role)}</span>` : ''}<span class="small mut">${esc(when(m.at))}</span></div>
          ${m.media ? `<div class="small tgmedia">📎 ${esc(m.media)}${m.media_note ? `: ${esc(m.media_note)}` : ''}</div>` : ''}${m.text ? `<div class="mt">${esc(m.text)}</div>` : ''}</li>`).join('')}</ol></section>
        ${c.working ? `<section class="card tgwork"><h3>The bot in this group</h3>
          <p class="small mut">${c.members ? `${c.members} people. ` : ''}A working driver's group: the bot learns the driver, the dispatchers and how they run updates. Load updates, truck issues, notes and alerts go to the website.</p>
          <dl class="figs"><div><dd>${c.learning.msgs || 0}</dd><dt>messages read${c.learning.since ? ' since ' + esc(dateText(String(c.learning.since).slice(0, 10), { month: 'short', day: 'numeric' })) : ''}</dt></div><div><dd>${c.learning.dispatchers || 0}</dd><dt>dispatchers known</dt></div>
            <div><dd>${c.learning.notes || 0}</dd><dt>notes on the driver</dt></div><div><dd>${c.learning.truck || 0}</dd><dt>truck issues</dt></div><div><dd>${c.learning.alerts || 0}</dd><dt>alerts</dt></div><div><dd>${c.learning.learned || 0}</dd><dt>answers learned</dt></div><div><dd>${c.learning.updates || 0}</dd><dt>load updates seen</dt></div><div><dd>${c.learning.lessons || 0}</dd><dt>dispatching practices learned</dt></div></dl>
          ${(r.updates || []).length ? `<h4 class="sub">Latest load updates</h4><ul class="list upds">${r.updates.map((u) => `<li data-u="${u.id}"><span class="grow">${esc(App.updText(u))}${u.by_role ? ` <span class="small mut">(${esc(u.by_role)})</span>` : ''}<div class="small mut clip1">${esc(u.text || '')}</div></span><span class="small mut">${esc(when(u.at))}</span>
            ${S.me.role === 'dispatcher' ? '' : `<span class="uchk"><button type="button" class="ub ${u.checked === 'ok' ? 'on' : ''}" data-act="tgUpd" data-ok="1" aria-label="Read right" title="Read right">✓</button><button type="button" class="ub bad ${u.checked === 'wrong' ? 'on' : ''}" data-act="tgUpd" data-ok="" aria-label="Read wrong" title="Read wrong">✗</button></span>`}</li>`).join('')}</ul>` : ''}
          ${S.me.role === 'dispatcher' ? `<p>${esc(c.mode === 'updater' ? '🚚 Updater' : '👀 Watch and learn')}</p>` : `<div class="seg" role="group" aria-label="How the bot works here">${[['watch', '👀 Watch and learn', 'Writes nothing in the group'], ['updater', '🚚 Updater', 'Also writes: asks the driver about wrong container numbers or locations, confirms appointment changes']].map(([k, l, h]) => `<button type="button" class="${c.mode === k ? 'on' : ''}" data-act="tgChatMode" data-m="${k}" data-chat="${c.chatId}" aria-pressed="${c.mode === k}" title="${esc(h)}">${l}</button>`).join('')}</div>
            <p class="small mut">${c.mode === 'updater' ? 'Also writes: asks the driver about wrong container numbers or locations, and confirms appointment changes.' : 'Writes nothing in the group. Switch to Updater when it knows the group well.'} In the group: <code>/mode</code>.</p>`}</section>` : ''}
        ${c.team ? `<section class="card tgwork"><h3>Our team's group</h3>
          <p class="small mut">Every morning the bot posts the empty trucks and the onboarding list (Amazon verified, pending Amazon; start dates, what is going on, the recruiter tagged). During the day it tags the recruiter (for a working driver, the truck's dispatcher) when a driver wrote and got no response for 3+ hours. It also tags the recruiter when a call-back was missed or Amazon is stuck on one step for 5+ days. Other people's messages, and drivers who don't answer us, are not alerted. In the group: /onboard, /empty.</p>
          ${S.me.role === 'admin' ? `<form id="teamForm" class="autof"><label class="fld">Morning report at<input type="time" name="at" value="${esc(c.team.at)}"></label><label class="chk"><input type="checkbox" name="report" ${c.team.report ? 'checked' : ''}> Morning report</label><label class="chk"><input type="checkbox" name="followups" ${c.team.followups ? 'checked' : ''}> Follow-ups</label><button class="btn primary sm">Save</button></form>` : ''}
          ${S.me.role === 'dispatcher' ? '' : `<p><button type="button" class="btn plain sm" data-act="tgTeamReport" data-chat="${c.chatId}">Send the onboarding list now</button></p>`}</section>` : ''}
        ${c.eldish && c.driverId ? `<section class="card tgwork"><h3>The bot in this ${c.kind === 'eld' ? 'ELD' : 'accounting'} group</h3>
          ${S.me.role === 'dispatcher' ? `<p>${c.mode === 'watch' ? '👀 Silent: reads only' : '🛠 Runs the setup and checks'}</p>` : `<div class="seg" role="group" aria-label="How the bot works here">${[['watch', '👀 Silent, reads only'], ['updater', c.kind === 'eld' ? '🛠 Run the ELD setup and checks' : '💬 Answer pay questions']].map(([k, l]) => `<button type="button" class="${c.mode === k ? 'on' : ''}" data-act="tgChatMode" data-m="${k}" data-chat="${c.chatId}" aria-pressed="${c.mode === k}">${l}</button>`).join('')}</div>`}
          <p class="small mut">${c.mode === 'watch' ? 'Writes nothing in the group: it reads along, keeps notes and alerts on the website and learns. Groups of drivers who are already working start like this.' : c.kind === 'eld' ? 'Posts the ELD setup steps for a new driver, then the daily log checks.' : 'Answers the driver\'s pay questions and passes the rest to accounting.'}</p></section>` : ''}
        <section class="card tglogc"><h3>Bot history in this group</h3><ul class="list tgloglist" id="tgLogBox"><li class="hint">Loading…</li></ul></section>
        ${admin ? `<p class="inrow"><button type="button" class="btn plain sm" data-act="tgRelink" data-chat="${c.chatId}" data-kind="${c.kind || ''}" data-driver="${c.driverId || ''}">${c.kind ? 'Wrong type or driver? Change it' : 'Connect this group'}</button>${c.kind ? ` <button type="button" class="btn plain sm" data-act="tgUnlink" data-chat="${c.chatId}">Unlink this group</button>` : ''}</p>` : ''}
      </div></div></main>`;
    (S.me.role === 'dispatcher' ? Promise.resolve({ log: [] }) : api('/api/tg/log?chat=' + encodeURIComponent(c.chatId))).then((lg) => { const bx = $('#tgLogBox'); if (!bx) return;
      bx.innerHTML = lg.log.map((x) => logLi(x, false)).join('') || '<li class="hint">Nothing yet.</li>';
      if (lg.more) bx.insertAdjacentHTML('afterend', `<p><button type="button" class="btn plain sm" data-act="tgLogMore" data-chat="${c.chatId}" data-before="${lg.log[lg.log.length - 1].id}">Show older</button></p>`); }).catch(() => {});
    const box = document.querySelector('.tgmsgs'); if (box) box.scrollTop = box.scrollHeight;
    App.draftsBox(document.getElementById('chatDrafts'), 'chatId=' + encodeURIComponent(id));
    App.casesCard(document.getElementById('chatCases'), 'chatId=' + encodeURIComponent(id), { title: 'Open cases in this group' });
  }

  // ---------- on a lead's page ----------
  // Is the bot in the driver's group: green when it is in and an admin, yellow when not an admin, red when removed
  function botPill(g, botOn, driverId) {
    const name = g && g.title ? '"' + g.title + '"' : 'the group';
    const [cls, label, tip] = !g ? ['none', 'No bot group', 'No Telegram group with the bot is linked to this driver yet. Add the bot to his group, then link the group on his page.']
      : g.state === 'removed' ? ['bad', 'Bot removed', 'The bot was removed from ' + name + '. Add it back to the group.']
      : botOn === false ? ['none', 'Bot is off', 'The bot is linked to ' + name + ', but the Telegram bot is turned off (see Telegram manager).']
      : g.state === 'noadmin' ? ['warn', 'Bot not admin', 'The bot is in ' + name + ' but not an admin, so it may miss messages. In Telegram: Group settings, Administrators, Add admin.']
      : ['on', 'Bot connected', 'The bot is in ' + name + ' and connected' + (g.lastAt ? '. Last message ' + App.teamWhen(g.lastAt) : '') + '.'];
    const href = g && g.state !== 'removed' ? '#/telegram/' + g.chatId : '#/driver/' + driverId;
    return `<a class="botst ${cls}" href="${href}" title="${esc(tip)}"><i aria-hidden="true"></i>${label}</a>`;
  }
  App.botPill = botPill;
  async function leadGroups(driverId, host) {
    let r, w; try { [r, w] = await Promise.all([api(`/api/drivers/${driverId}/tg`), api(`/api/drivers/${driverId}/tg-people`).catch(() => null)]); } catch (e) { return; }
    if (!host.isConnected) return;
    const has = Object.fromEntries(r.groups.map((g) => [g.kind, g]));
    host.innerHTML = `<h4>Telegram groups${r.openQuestions ? ` <span class="latetag">${r.openQuestions} question${r.openQuestions > 1 ? 's' : ''} waiting</span>` : ''}</h4><ul class="tglead">${['dispatch', 'eld', 'accounting'].map((k) => {
      const g = has[k];
      const gone = !g && (r.removed || []).find((x) => x.kind === k);
      return `<li><span class="tgk k-${k}">${KIND[k]}</span>${g ? `<a href="#/telegram/${g.chatId}">${esc(g.title || 'Group')}</a> ${botPill({ ...g, state: g.botAdmin ? 'on' : 'noadmin' }, r.botOn, driverId)} ${g.eld ? eldLine(g.eld) : ''}` : `${gone ? botPill({ ...gone, state: 'removed' }, r.botOn, driverId) + ' ' : ''}<span class="none">Not linked</span> <button type="button" class="linkbtn" data-act="tgLink" data-kind="${k}" data-driver="${driverId}">Link a group</button>`}</li>`;
    }).join('')}</ul>${whoBox(driverId, w, r.groups.length)}${r.botOn ? '' : '<p class="hint">The Telegram bot is not turned on yet (see Telegram manager).</p>'}${has.dispatch ? onbPanel(driverId, r.onb, has.dispatch) : ''}`;
  }
  // ---------- which Telegram account is the driver's: picked from the people in the driver's groups, our team left out ----------
  const said = (p) => (p.last && p.last.text ? '“' + p.last.text.slice(0, 90) + '”' : '');
  function whoBox(driverId, w, groups) {
    if (!w || !groups) return '';
    const linked = w.people.find((p) => p.linked); const ask = w.people.filter((p) => w.ask.includes(p.tgId));
    const tags = (p) => [p.username ? '@' + p.username : '', p.likelyTeam ? `in ${p.groups} groups, probably our team` : '', p.otherDriver ? `set as ${p.otherDriver.name}'s account` : '', p.notDriver ? 'marked not the driver' : '', p.messages ? '' : 'has not written'].filter(Boolean).join(', ');
    return `<div class="tgwho" data-driver="${driverId}">
      ${ask.length ? `<div class="wholine"><b>Who is the driver?</b> ${ask.map((p) => `<button type="button" class="btn plain sm" data-act="tgWho" data-tg="${p.tgId}" data-is="driver" title="${esc(said(p) || p.name)}">${esc(p.name)}</button>`).join('')}<button type="button" class="linkbtn" data-act="tgWho" data-is="none">None of them</button></div>` : ''}
      <label class="fld">Driver's Telegram account<select data-ch="tgWhoPick" data-linked="${linked ? linked.tgId : ''}" ${w.people.length ? '' : 'disabled'}><option value="">${w.people.length ? 'Not set' : 'Nobody to pick yet'}</option>${w.people.map((p) => `<option value="${p.tgId}" ${p.linked ? 'selected' : ''}>${esc(p.name)}${tags(p) ? ' (' + esc(tags(p)) + ')' : ''}</option>`).join('')}</select></label>
      <p class="small mut">${linked ? `The bot treats <b>${esc(linked.name)}</b> as the driver${linked.last ? `. Last wrote ${esc(App.teamWhen(linked.last.at))}${said(linked) ? ': ' + esc(said(linked)) : ''}` : ''}. <button type="button" class="linkbtn" data-act="tgWho" data-tg="${linked.tgId}" data-is="not">Not the driver</button>`
        : w.people.length ? "Pick the driver's account so the bot knows who the driver is. Our team is not listed." : "Nobody from the driver's side yet. People show up here once they write in the group or join it after the bot."}</p></div>`;
  }
  const whoSave = async (driverId, body) => {
    await api(`/api/drivers/${driverId}/tg-people`, { method: 'POST', body });
    toast(body.is === 'driver' ? 'Saved: the bot now knows the driver' : 'Saved: not the driver'); App.render();
  };
  on('tgWho', (b) => whoSave(b.closest('[data-driver]').dataset.driver, b.dataset.is === 'none' ? { none: true } : { tgId: b.dataset.tg, is: b.dataset.is }));
  onChange('tgWhoPick', (s) => { const id = s.closest('[data-driver]').dataset.driver; if (s.value) return whoSave(id, { tgId: s.value, is: 'driver' }); if (s.dataset.linked) return whoSave(id, { tgId: s.dataset.linked, is: 'not' }); });
  on('tgTeamRole', async (b) => { await api('/api/tg/people/' + b.closest('[data-tg]').dataset.tg, { method: 'PATCH', body: { role: b.dataset.role } }); toast('Saved: ' + ROLE[b.dataset.role]); App.render(); });
  on('tgNotTeam', async (b) => { await api('/api/tg/people/' + b.closest('[data-tg]').dataset.tg + '/not-team', { method: 'POST' }); toast('Saved: not our team'); App.render(); });
  // ---------- the onboarding bot on a lead: how it works, where the AI sees things, steps it saw done ----------
  const MODE = { watch: ['👀 Watch and learn', 'Reads everything, sums it up here and learns from the team. Never writes in the group.'], assist: ['💬 Answer questions', 'Also answers the driver\'s questions it knows; asks the team the rest.'], run: ['🚀 Run the onboarding', 'Guides the driver through every step and reminds him.'] };
  const WAIT = { driver: 'the driver', recruiter: 'the recruiter', amazon: 'Amazon', company: 'the company', nobody: 'nobody' };
  function onbPanel(driverId, o, g) {
    const s = o && o.status; const mode = o ? o.mode : null;
    return `<div class="onbbot" data-driver="${driverId}"><div class="obhead"><b>Onboarding bot</b><div class="seg sm" role="group" aria-label="How the bot works">${Object.entries(MODE).map(([k, [l, h]]) => `<button type="button" data-act="tgMode" data-mode="${k}" class="${mode === k ? 'on' : ''}" aria-pressed="${mode === k}" title="${esc(h)}">${l}</button>`).join('')}</div></div>
      <p class="small mut">${mode ? esc(MODE[mode][1]) : 'Pick how the bot works in this group.'}</p>
      ${s ? `<div class="aist"><p>${esc(s.summary)}</p><dl>${s.waitingOn ? `<div><dt>Waiting on</dt><dd><b>${esc(WAIT[s.waitingOn] || s.waitingOn)}</b></dd></div>` : ''}${s.nextStep ? `<div><dt>Next</dt><dd>${esc(s.nextStep)}</dd></div>` : ''}${s.mood ? `<div><dt>Mood</dt><dd>${App.MOODS[s.mood] ? App.MOODS[s.mood][0] + ' ' + App.MOODS[s.mood][1] : esc(s.mood)}</dd></div>` : ''}</dl>
        ${(s.blockers || []).length ? `<p class="small"><b>Holding it up:</b> ${s.blockers.map(esc).join('; ')}</p>` : ''}${(s.openQuestions || []).length ? `<p class="small"><b>Unanswered:</b> ${s.openQuestions.map(esc).join('; ')}</p>` : ''}
        <p class="small mut">The AI's view of the Telegram group, ${esc(when(o.statusAt))}.</p></div>` : '<p class="hint">The AI sums up the group here after the conversation settles.</p>'}
      ${o && o.steps.length ? `<div class="aisteps"><p class="small"><b>Steps the AI saw done in the chat</b></p><ul class="list">${o.steps.map((x) => `<li data-ais="${x.id}"><span class="grow"><b>${esc(x.label)}</b><span class="small mut" style="display:block">“${esc(x.evidence || '')}”</span></span>
        ${x.state === 'auto' ? '<span class="small okt">Ticked by the AI</span><button type="button" class="linkbtn" data-act="aiStep" data-ok="0">Undo</button>' : '<button type="button" class="btn primary sm" data-act="aiStep" data-ok="1">Yes, done</button><button type="button" class="btn plain sm" data-act="aiStep" data-ok="0">Not yet</button>'}</li>`).join('')}</ul><p class="small mut">Your answers teach the AI and measure how right it is.</p></div>` : ''}
      <button type="button" class="linkbtn small" data-act="tgImport" data-chat="${g.chatId}">Bring in messages from before the bot joined</button></div>`;
  }
  on('tgMode', async (b) => { const box = b.closest('.onbbot'); try { await api(`/api/drivers/${box.dataset.driver}/tg-mode`, { method: 'PATCH', body: { mode: b.dataset.mode } }); toast(MODE[b.dataset.mode][0]); App.render(); } catch (e) { fail(e); } });
  on('aiStep', async (b) => { const li = b.closest('[data-ais]'); try { await api('/api/onb-ai-steps/' + li.dataset.ais, { method: 'POST', body: { ok: b.dataset.ok === '1' } }); toast(b.dataset.ok === '1' ? 'Ticked' : 'Noted: not done'); App.render(); } catch (e) { fail(e); } });
  // a Telegram Desktop export (JSON): read in the browser, the senders marked, the messages sent to the website
  const flat = (t) => (Array.isArray(t) ? t.map((x) => (typeof x === 'string' ? x : x.text || '')).join('') : String(t || ''));
  on('tgImport', (b) => {
    dialog(`<div class="dform"><h2>Messages from before the bot joined</h2>
      <ol class="gsteps"><li>On a computer, open the group in <b>Telegram Desktop</b>.</li><li>Click ⋮ (top right), then <b>Export chat history</b>.</li><li>Untick photos and videos, set Format to <b>Machine-readable JSON</b>, and export.</li><li>Pick the <b>result.json</b> file here.</li></ol>
      <label class="fld">The export file<input type="file" id="tgFile" accept=".json,application/json"></label>
      <div id="tgWho"></div><p class="err" id="tgErr" role="alert"></p>
      <div class="drow"><button type="button" class="btn primary" id="tgGo" disabled>Bring them in</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></div>`, (d) => {
      let msgs = [], people = [];
      d.querySelector('#tgFile').onchange = async (e) => {
        const f = e.target.files[0]; $('#tgErr').textContent = ''; if (!f) return;
        if (f.size > 25 * 1024 * 1024) { $('#tgErr').textContent = 'That file is too big. Export without photos and videos.'; return; }
        let j; try { j = JSON.parse(await f.text()); } catch (er) { $('#tgErr').textContent = 'That is not the JSON export. Pick result.json, exported as "Machine-readable JSON".'; return; }
        const list = (j.messages || []).filter((m) => m.type === 'message');
        msgs = list.map((m) => ({ id: m.id, date: +m.date_unixtime || Math.floor(new Date(m.date) / 1000), fromId: String(m.from_id || '').replace(/\D/g, ''), from: m.from || '', text: flat(m.text), media: m.photo ? 'photo' : m.media_type || (m.file ? 'file' : ''), replyTo: m.reply_to_message_id || null, bot: /bot$/i.test(m.from || '') }));
        const by = {}; for (const m of msgs) if (m.fromId) by[m.fromId] = by[m.fromId] || { tgId: m.fromId, name: m.from, n: 0 }, by[m.fromId].n++;
        people = Object.values(by).sort((a, c) => c.n - a.n);
        // who the bot already knows in this group: preset their role
        const known = await api('/api/tg/chats/' + b.dataset.chat).then((x) => Object.fromEntries((x.people || []).map((p) => [String(p.tg_id), p.role]))).catch(() => ({}));
        const preset = (p) => { const r = known[p.tgId]; return r === 'driver' ? 'driver' : r && r !== 'driver' ? 'staff' : 'other'; };
        if (!msgs.length) { $('#tgErr').textContent = 'No messages in this file.'; return; }
        $('#tgWho').innerHTML = `<p class="small"><b>${msgs.length.toLocaleString()} messages</b>${j.name ? ` from "${esc(j.name)}"` : ''}. Who is who? (so the bot learns from the team's answers)</p>
          <table class="opent"><tbody>${people.filter((p) => !/bot$/i.test(p.name)).map((p) => `<tr><td><b>${esc(p.name || 'Someone')}</b> <span class="small mut">${p.n} messages</span></td><td><select data-who="${esc(p.tgId)}" aria-label="Who is ${esc(p.name)}">${[['other', 'Someone else'], ['driver', 'The driver'], ['staff', 'Our team']].map(([v, l]) => `<option value="${v}" ${preset(p) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table>`;
        $('#tgGo').disabled = false;
      };
      d.querySelector('#tgGo').onclick = async () => {
        const roles = Object.fromEntries([...d.querySelectorAll('[data-who]')].map((s) => [s.dataset.who, s.value]));
        $('#tgGo').disabled = true; $('#tgGo').textContent = 'Sending…';
        try { const r = await api(`/api/tg/chats/${b.dataset.chat}/import`, { method: 'POST', body: { messages: msgs, people: people.map((p) => ({ ...p, role: roles[p.tgId] || 'other' })) } });
          d.close(); toast(`${r.imported.toLocaleString()} messages brought in${r.skipped ? ` (${r.skipped} were already here)` : ''}. The AI reads them over the next minutes.`); }
        catch (er) { $('#tgErr').textContent = er.message; $('#tgGo').disabled = false; $('#tgGo').textContent = 'Bring them in'; }
      };
    });
  });
  // ---------- the driver's profile for dispatchers, on the driver's page ----------
  const LBL = { high: 'High', medium: 'Medium', low: 'Low', unknown: 'Not known yet', self_driven: 'Self-driven', light_check_ins: 'Light check-ins', needs_close_follow_up: 'Needs close follow-up' };
  async function profileCard(driverId, host, always) {
    let r; try { r = await api(`/api/drivers/${driverId}/profile`); } catch (e) { return; }
    if (!host.isConnected) return;
    const p = r.profile;
    if (!p && !r.pins && !r.notesCount && !always) return;
    const list = (t, a) => (a && a.length ? `<div class="pl"><h4>${t}</h4><ul>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
    host.hidden = false;
    host.innerHTML = `<h3>Driver profile for dispatchers<span class="grow"></span>${r.text ? '<button type="button" class="btn plain sm" data-act="profCopy">Copy for a new dispatcher</button>' : ''}</h3>
      ${p ? `<p class="plead">${esc(p.summary || '')}</p>
        <div class="pbadges"><span class="pb r-${p.reliability}">Reliability: <b>${esc(LBL[p.reliability] || p.reliability)}</b></span><span class="pb s-${p.supervision}">Supervision: <b>${esc(LBL[p.supervision] || p.supervision)}</b></span></div>
        ${p.work_style ? `<p><b>Work style:</b> ${esc(p.work_style)}</p>` : ''}
        <div class="pgrid">${list('Routines', p.routines)}${list('Requests', p.requests)}${list('Loads he likes', p.likes_loads)}${list('Loads he does not like', p.dislikes_loads)}${list('Tips for dispatchers', p.tips_for_dispatchers)}${list('Watch out for', p.watch_outs)}</div>
        ${p.home_time ? `<p><b>Home time:</b> ${esc(p.home_time)}</p>` : ''}${p.communication ? `<p><b>Talking to him:</b> ${esc(p.communication)}</p>` : ''}
        <p class="hint">Built by the AI from ${r.notesCount} note${r.notesCount === 1 ? '' : 's'} the bot took in this driver's Telegram groups, ${esc(when(r.builtAt))}. Never shown to the driver.</p>`
        : `<p class="hint">${r.notesCount ? `${r.notesCount} note${r.notesCount === 1 ? '' : 's'} so far; the profile is built from them soon.` : 'The bot builds this from the driver\'s Telegram groups: routines, requests, loads he likes or refuses, how he works. Nothing yet.'}</p>`}
      <form class="pform" id="pinForm"><label class="fld">Our own notes (always kept, the AI never changes them)<textarea name="pins" rows="3" placeholder="For example: wake-up call at 7 AM; does not take NYC loads; very reliable, no need to check in">${esc(r.pins || '')}</textarea></label>
        <div class="drow"><button class="btn plain sm">Save notes</button>${r.ai && r.notesCount ? '<button type="button" class="btn plain sm" data-act="profBuild">Rebuild now</button>' : ''}</div></form>
      ${r.notes.length ? `<details class="pnotes"><summary>What the bot noticed (${r.notesCount})</summary><ul class="list">${r.notes.map((n) => `<li><span class="grow">${esc(n.text)}</span><span class="small mut">${esc(when(n.at))}</span></li>`).join('')}</ul></details>` : ''}`;
    host.dataset.driver = driverId; host._text = r.text;
    host.querySelector('#pinForm').onsubmit = async (e) => { e.preventDefault(); try { await api(`/api/drivers/${driverId}/profile`, { method: 'PUT', body: { pins: e.target.pins.value } }); toast('Saved'); profileCard(driverId, host, always); } catch (er) { fail(er); } };
  }
  on('profCopy', async (b) => { const h = b.closest('#dprof'); try { await navigator.clipboard.writeText(h._text || ''); toast('Copied: paste it to the new dispatcher'); } catch (e) { toast('Could not copy', true); } });
  on('profBuild', async (b) => { const h = b.closest('#dprof'); b.disabled = true; try { await api(`/api/drivers/${h.dataset.driver}/profile/build`, { method: 'POST', body: {} }); toast('Profile rebuilt'); profileCard(+h.dataset.driver, h, true); } catch (e) { fail(e); b.disabled = false; } });
  App.profileCard = profileCard;
  // a dispatcher has no driver pages: a driver's name opens his profile for dispatchers instead
  App.profileDialog = (id) => { App.dialog(`<div class="dform pdlg"><section class="dprof" id="dprof"><p class="hint">Loading…</p></section><div class="dact"><button type="button" class="btn plain" data-act="closeDialog">Close</button></div></div>`, (d) => profileCard(+id, d.querySelector('#dprof'), true)); };

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
  // ---------- how the bot teaches itself: skills, what works, what it expects, the team, its weekly ideas ----------
  const PKIND = { knowledge: 'New answer', wording: 'Wording', rule: 'Follow-up rule', site: 'Website change' };
  const hoursText = (h) => (h < 36 ? `${Math.max(1, h)} h` : `${Math.round(h / 24)} days`);
  const OUT_LBL = { 'followup:d_invite': 'Relay invite follow-up', 'followup:d_checkin': 'Check-in when quiet', 'followup:d_facts': 'CDL state and ZIP' };
  function learnCard(ln, admin) {
    const open = ln.proposals.filter((p) => p.status === 'open'), past = ln.proposals.filter((p) => p.status !== 'open');
    const skill = (s) => `<tr><th scope="row">${esc(s.label)}</th><td>${Math.round(s.accuracy * 100)}% <span class="small mut">of ${s.total}</span></td><td class="small mut">${s.same} same, ${s.partly} partly, ${s.wrong} wrong</td>
      <td>${s.humanOnly ? '<span class="small mut">Always a person</span>' : s.proven ? '<span class="okt">Proven</span>' : s.slipping ? '<span class="cbad">Slipped: a recent miss</span>' : `<span class="small mut">Learning (${Math.max(0, ln.bar.min - s.total)} more to go${s.total >= ln.bar.min ? ', below ' + Math.round(ln.bar.acc * 100) + '%' : ''})</span>`}${s.alone ? ` <span class="small mut">· answered ${s.alone} alone</span>` : ''}</td></tr>`;
    return `<section class="card autop learnc"><h3>How the bot teaches itself<span class="grow"></span>${admin ? `<button type="button" class="btn plain sm" data-act="tgReviewNow">Review its week now</button><button type="button" class="btn ${ln.paused ? 'primary' : 'danger'} sm" data-act="tgPause" data-on="${ln.paused ? '0' : '1'}">${ln.paused ? '▶ Resume the bot' : '⏸ Pause the bot everywhere'}</button>` : ''}</h3>
      ${ln.paused ? '<div class="needbox"><b>The bot is paused everywhere.</b> It writes nothing by itself in any group; it keeps reading and learning, and what you send from the website still goes out. In Telegram: /resume.</div>' : ''}
      <p class="hint">Nobody has to press anything: the bot grades its own drafts against what your team writes, follows which messages drivers answer, learns how long each step takes, and once a week reads its own mistakes and proposes fixes.</p>
      ${open.length ? `<h4>Its ideas, for you to approve (${open.length})</h4><ul class="list props">${open.map((p) => `<li data-prop="${p.id}"><span class="grow"><span class="tgk">${PKIND[p.kind] || p.kind}</span> <b>${esc(p.title)}</b><span class="small" style="display:block">${esc(p.detail || '')}</span></span>
        ${admin ? '<button type="button" class="btn primary sm" data-act="tgProp" data-d="approve">Approve</button><button type="button" class="btn plain sm" data-act="tgProp" data-d="reject">No</button>' : ''}</li>`).join('')}</ul>
        <p class="small mut">An approved answer goes straight into the knowledge base. An approved website change becomes a task to build; wording and rules are noted for the next update.</p>` : '<p class="small mut">No ideas waiting. The bot reviews its week every week, or now with the button.</p>'}
      ${ln.audit && ln.audit.length ? `<h4>Check the grader (${ln.audit.length})</h4><p class="small mut">The bot grades itself, so a person should confirm a few of its grades. Was each one fair?</p><ul class="list audits">${ln.audit.map((a) => `<li data-audit="${a.id}"><span class="grow"><b>${esc(a.name || 'Driver')}</b> <span class="${a.grade === 'same' ? 'okt' : a.grade === 'wrong' ? 'cbad' : 'cwarn'}">The bot said: ${GRADE[a.grade]}</span> <span class="small mut">${esc(a.note || '')}</span>
          <span class="small mut" style="display:block">Driver: “${esc((a.asked || '').slice(0, 200))}”</span><span class="small mut" style="display:block">Bot drafted: “${esc((a.draft || '').slice(0, 240))}”</span><span class="small mut" style="display:block">Your team wrote: “${esc((a.team || '').slice(0, 240))}”</span></span>
          <button type="button" class="btn primary sm" data-act="tgAudit" data-fair="1">Fair</button>${['same', 'partly', 'wrong'].filter((g) => g !== a.grade).map((g) => `<button type="button" class="btn plain sm" data-act="tgAudit" data-grade="${g}">No: ${GRADE[g].toLowerCase()}</button>`).join('')}</li>`).join('')}</ul>` : ''}
      ${ln.grader && ln.grader.total ? `<p class="small ${ln.grader.trusted ? 'mut' : 'cbad'}">A person checked ${ln.grader.total} of its grades: ${Math.round(ln.grader.agreement * 100)}% were fair.${ln.grader.trusted ? '' : ' That is too low, so no topic counts as proven until the checks look better.'}</p>` : ''}
      <h4>Topics it has learned</h4>
      ${ln.skills.length ? `<div class="scroll"><table class="mini"><thead><tr><th>Topic</th><th>Drafts that matched</th><th></th><th>Status</th></tr></thead><tbody>${ln.skills.map(skill).join('')}</tbody></table></div>` : '<p class="small mut">Nothing graded yet. It starts as soon as recruiters answer drivers in the groups.</p>'}
      <p class="small mut">Proven: ${Math.round(ln.bar.acc * 100)}% over ${ln.bar.min} or more graded drafts, with no miss among the last ${ln.bar.recent}. Pay and safety always go to a person.</p>
      ${admin ? `<label class="chk"><input type="checkbox" data-ch="tgSkillAuto" ${ln.skillAuto ? 'checked' : ''}> The bot answers proven topics by itself, also in "Watch and learn" groups (one in ${ln.sample} still goes to the team, so it keeps being checked; a topic that slips goes back to drafts)</label>` : ''}
      ${ln.outcomes.length ? `<h4>Which messages drivers answer</h4><div class="scroll"><table class="mini"><thead><tr><th>Message</th><th>Wording</th><th>Answered within a day</th></tr></thead><tbody>${ln.outcomes.map((o) => `<tr><th scope="row">${esc(OUT_LBL[o.kind] || o.kind.replace(/^reply:/, 'Answer: ').replace(/^followup:/, 'Follow-up: '))}</th><td>${o.variant + 1}</td><td>${Math.round(o.rate * 100)}% <span class="small mut">(${o.replied} of ${o.sent})</span></td></tr>`).join('')}</tbody></table></div><p class="small mut">With 8 or more results for each wording, the bot uses the better one four times in five.</p>` : ''}
      ${ln.typical.length ? `<h4>How long drivers who made it took</h4><p class="small">${ln.typical.map((t) => `<b>${esc(t.step)}</b>: usually ${hoursText(t.medianH)}, slow after ${hoursText(t.slowH)} <span class="mut">(${t.n} drivers)</span>`).join(' · ')}</p><p class="small mut">A driver slower than three in four of them is flagged to the team as slipping, before the fixed deadlines.</p>` : ''}
      ${ln.predictions && ln.predictions.flagged ? `<h4>Did its warnings come true?</h4><p class="small">It warned that <b>${ln.predictions.flagged}</b> ${ln.predictions.flagged === 1 ? 'driver was' : 'drivers were'} slipping: ${ln.predictions.dropped} dropped out, ${ln.predictions.madeIt} made it, ${ln.predictions.open} still open.${ln.predictions.hitRate !== null && ln.predictions.baseRate !== null ? ` Of the drivers it warned about, ${Math.round(ln.predictions.hitRate * 100)}% dropped out; of the others, ${Math.round(ln.predictions.baseRate * 100)}%.` : ''}${ln.predictions.useful === true ? ' <span class="okt">Its warnings point at the right drivers.</span>' : ln.predictions.useful === false ? ' <span class="cbad">Its warnings are no better than chance so far.</span>' : ' <span class="mut">Too early to judge (10 finished cases needed).</span>'}</p>` : ''}
      ${ln.team && ln.team.asked ? `<h4>How the team answers the bot</h4><p class="small">${ln.team.people.map((p) => `<b>${esc(p.who)}</b>: ${p.answered} answered, usually in ${p.medianMin < 90 ? p.medianMin + ' min' : Math.round(p.medianMin / 60) + ' h'}`).join(' · ') || 'Nobody answered yet'} · ${ln.team.waiting} of ${ln.team.asked} follow-ups not answered (30 days)</p>` : ''}
      ${past.length ? `<details><summary class="small">Decided ideas (${past.length})</summary><ul class="list">${past.map((p) => `<li><span class="grow"><span class="tgk">${PKIND[p.kind] || p.kind}</span> ${esc(p.title)} <span class="small mut">${p.status === 'rejected' ? 'Rejected' : p.status === 'done' ? 'Done' : 'Approved'}${p.decided_by ? ' by ' + esc(p.decided_by) : ''}${p.note ? '. ' + esc(p.note) : ''}</span></span></li>`).join('')}</ul></details>` : ''}</section>`;
  }
  on('tgProp', async (b) => { try { const r = await api('/api/tg/proposals/' + b.closest('[data-prop]').dataset.prop, { method: 'POST', body: { decision: b.dataset.d } }); toast(r.note || (b.dataset.d === 'approve' ? 'Approved' : 'Rejected')); App.render(); } catch (e) { fail(e); } });
  const GRADE = { same: 'Same', partly: 'Partly right', wrong: 'Wrong', unrelated: 'Not comparable' };
  on('tgAudit', async (b) => { try { await api('/api/tg/drafts/' + b.closest('[data-audit]').dataset.audit + '/audit', { method: 'POST', body: b.dataset.fair ? { fair: true } : { fair: false, grade: b.dataset.grade } }); toast(b.dataset.fair ? 'Thanks: fair' : 'Corrected'); App.render(); } catch (e) { fail(e); } });
  on('tgPause', async (b) => { const onNow = b.dataset.on === '1'; if (onNow && !confirm('Pause the bot everywhere? It will write nothing by itself in any group until you resume it.')) return;
    try { await api('/api/tg/autopilot', { method: 'PUT', body: { paused: onNow } }); toast(onNow ? 'Paused everywhere' : 'The bot is back on'); App.render(); } catch (e) { fail(e); } });
  on('tgReviewNow', async (b) => { b.disabled = true; b.textContent = 'Reading its week…'; try { const r = await api('/api/tg/learning/review', { method: 'POST' }); toast(r.skipped || (r.saved ? `${r.saved} new idea${r.saved === 1 ? '' : 's'}` : 'Nothing new to propose')); App.render(); } catch (e) { fail(e); b.disabled = false; } });
  onChange('tgSkillAuto', async (el) => { try { await api('/api/tg/autopilot', { method: 'PUT', body: { skillAuto: el.checked } }); toast(el.checked ? 'On: the bot answers proven topics by itself' : 'Off: every answer waits for a person'); } catch (e) { fail(e); el.checked = !el.checked; } });
  on('tgPeople', () => { tab = 'people'; App.go('#/telegram'); });
  on('tgSum', async (b) => { b.disabled = true; try { await api(`/api/tg/chats/${b.dataset.chat}/summary`, { method: 'POST', body: {} }); toast('Summary written'); App.render(); } catch (e) { fail(e); b.disabled = false; } });
  on('deskAddGroup', (b) => b.insertAdjacentHTML('beforebegin', App._sgRow({ chatId: '', companies: [] })));
  on('deskDelGroup', (b) => b.closest('.sgrow').remove());
  // the shift desk settings
  document.addEventListener('submit', async (e) => { if (e.target.id !== 'deskForm') return; e.preventDefault(); const f = e.target;
    const shifts = [...f.querySelectorAll('.shiftrow')].map((r) => ({ name: r.querySelector('[name=name]').value, start: r.querySelector('[name=start]').value, end: r.querySelector('[name=end]').value, tz: r.querySelector('[name=tz]').value,
      groups: [...r.querySelectorAll('.sgrow')].map((g) => ({ chatId: g.querySelector('[name=chatId]').value, companies: [...g.querySelectorAll('[name=co]:checked')].map((x) => +x.value) })).filter((g) => g.chatId), people: [...r.querySelectorAll('[name=p]:checked')].map((x) => +x.value) }));
    const routines = { board: f.querySelector('[name=rBoard]').checked, boardMin: +f.querySelector('[name=rBoardMin]').value, notes: f.querySelector('[name=rNotes]').checked, notesMin: +f.querySelector('[name=rNotesMin]').value };
    const levels = Object.fromEntries([...f.querySelectorAll('[name=kl]')].map((x) => [x.dataset.k, +x.value]));
    const peopleLevels = Object.fromEntries([...f.querySelectorAll('[data-pid]')].map((r) => [r.dataset.pid, +r.querySelector('[name=lvl]').value]));
    const rolling = { on: f.querySelector('[name=rollOn]').checked, hours: +f.querySelector('[name=rollH]').value };
    try { await api('/api/tg/desk', { method: 'PUT', body: { on: f.querySelector('[name=on]').checked, where: f.querySelector('[name=where]').value, answerMin: +f.querySelector('[name=answerMin]').value, shifts, hubs: f.querySelector('[name=hubs]').value.split(','), routines, levels, rolling, peopleLevels } }); toast('Saved'); App.render(); } catch (er) { fail(er); } });
  document.addEventListener('submit', async (e) => { if (e.target.id !== 'termForm') return; e.preventDefault(); const f = new FormData(e.target);
    try { await api('/api/tg/terms', { method: 'POST', body: { term: f.get('term'), meaning: f.get('meaning') } }); toast('Added'); App.render(); } catch (er) { fail(er); } });
  on('termDel', async (b) => { try { await api('/api/tg/terms/' + b.closest('[data-term]').dataset.term, { method: 'DELETE' }); App.render(); } catch (e) { fail(e); } });
  on('notePost', async (b) => { const li = b.closest('[data-nd]'); b.disabled = true;
    try { await api('/api/tg/notes/' + li.dataset.nd, { method: 'POST', body: { text: li.querySelector('textarea').value } }); toast('Posted in his group'); App.render(); } catch (e) { fail(e); b.disabled = false; } });
  // All groups tab: connect, change, disconnect in the row
  onChange('agKind', (el) => { const i = el.closest('tr').querySelector('.agdrv'); i.disabled = ['management', 'shift'].includes(el.value); });
  on('agView', (b) => { agView = b.dataset.v; App.render(); });
  onChange('agRoute', async (el) => { try { await api('/api/tg/routes', { method: 'PUT', body: { key: el.dataset.key, chatId: el.value } }); toast(el.value ? 'Saved: these messages go there from now on' : 'Back to the default'); App.render(); } catch (e) { fail(e); App.render(); } });
  onChange('agMode', async (el) => { try { await api(`/api/tg/chats/${el.dataset.chat}/mode`, { method: 'PATCH', body: { mode: el.value } }); toast(el.value === 'watch' ? 'Saved: the bot stays silent in this group' : 'Saved: the bot works in this group'); } catch (e) { fail(e); App.render(); } });
  on('agSave', async (b) => { const tr = b.closest('tr'); const kind = tr.querySelector('[data-ch=agKind]').value; const v = tr.querySelector('.agdrv').value; const m = /#(\d+)\s*$/.exec(v);
    if (!['management', 'shift'].includes(kind) && !m) return toast('Pick the driver from the list (type a name)', true);
    b.disabled = true;
    try { const r = await api(`/api/tg/chats/${tr.dataset.ag}/link`, { method: 'PATCH', body: { kind, driverId: m ? +m[1] : null } });
      toast(r.same ? 'Nothing changed' : r.restored && r.restored.length ? `Saved. "${r.restored[0].title || 'The other group'}" is back as the ${KIND[r.restored[0].kind]} group.` : 'Saved'); App.render(); }
    catch (e) { fail(e); b.disabled = false; } });
  on('agOff', async (b) => { const tr = b.closest('tr'); if (!confirm('Disconnect this group? The bot stays in it and keeps reading, but it belongs to no one until you connect it again.')) return;
    try { await api(`/api/tg/chats/${tr.dataset.ag}/link`, { method: 'PATCH', body: { kind: 'none' } }); toast('Disconnected'); App.render(); } catch (e) { fail(e); } });
  document.addEventListener('input', (e) => { if (e.target.id !== 'agFind') return; const t = e.target.value.trim().toLowerCase();
    for (const tr of document.querySelectorAll('tr[data-ag]')) tr.hidden = !!t && !(tr.textContent.toLowerCase().includes(t) || ((tr.querySelector('.agdrv') || {}).value || '').toLowerCase().includes(t));
    for (const tr of document.querySelectorAll('tr[data-ag-d]')) tr.hidden = !!t && !tr.textContent.toLowerCase().includes(t); });
  // a group linked as the wrong type (an ELD group set as Dispatch...) or to the wrong driver
  on('tgRelink', async (b) => {
    let ds; try { ds = (await api('/api/tg/driver-options')).drivers; } catch (e) { return fail(e); }
    const st = (s) => (s === 'Hired' ? 'active' : String(s || '').toLowerCase());
    dialog(`<form id="relink" class="dform"><h2>${b.dataset.kind ? 'Change this group' : 'Connect this group'}</h2>
      <label class="fld">This group is the<select name="kind">${[['dispatch', 'Dispatch group (the driver and his dispatchers)'], ['eld', 'ELD group'], ['accounting', 'Accounting group']].map(([k, l]) => `<option value="${k}" ${b.dataset.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld">of the driver<select name="driverId" required><option value="">Pick the driver…</option>${ds.map((d) => `<option value="${d.id}" ${+b.dataset.driver === d.id ? 'selected' : ''}>${esc(d.name)} (${esc(st(d.status))})</option>`).join('')}</select></label>
      <p class="hint">What the wrong type started here is undone (replies waiting, road cases, the onboarding conversation). If this mistake pushed another group out (a driver has one group of each type), that group gets its place back. The last 14 days are read again as the right type, quietly. Nothing is written in the groups.</p>
      <p class="err" id="rlErr" role="alert"></p><div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
      $('#relink', d).onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
        try { const r = await api(`/api/tg/chats/${b.dataset.chat}/link`, { method: 'PATCH', body: { kind: f.get('kind'), driverId: +f.get('driverId') } }); d.close();
          toast(r.restored && r.restored.length ? `Saved. "${r.restored[0].title || 'The other group'}" is back as the ${KIND[r.restored[0].kind]} group.` : 'Saved'); App.render(); }
        catch (er) { $('#rlErr').textContent = er.message; } };
    });
  });
  on('tgUnlink', async (b) => { if (!confirm('Unlink this group from the driver? The bot stops its ELD work there.')) return; try { await api(`/api/tg/chats/${b.dataset.chat}/link`, { method: 'DELETE' }); toast('Unlinked'); App.render(); } catch (e) { fail(e); } });
  document.addEventListener('change', async (e) => {
    const s = e.target.closest('select[data-ch="tgRole"]'); if (!s) return;
    try { await api('/api/tg/people/' + s.closest('tr').dataset.tg, { method: 'PATCH', body: { role: s.value || null } }); toast('Saved'); } catch (er) { fail(er); }
  });
  document.addEventListener('click', (e) => { const r = e.target.closest('table.tgt tr[data-chat]'); if (r && !e.target.closest('a,button')) App.go('#/telegram/' + r.dataset.chat); });
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form.tgqf'); if (f) { e.preventDefault(); const li = f.closest('[data-q]'); const b = f.querySelector('button'); b.disabled = true;
      try { await api(`/api/tg/questions/${li.dataset.q}/answer`, { method: 'POST', body: { answer: f.answer.value } }); toast('Sent in the group, and learned'); App.render(); } catch (er) { fail(er); b.disabled = false; } return; }
    const tf = e.target.closest('#teamForm'); if (tf) { e.preventDefault(); try { await api('/api/tg/autopilot', { method: 'PUT', body: { teamReportAt: tf.at.value, teamReport: tf.report.checked, teamFollowups: tf.followups.checked } }); toast('Saved'); App.render(); } catch (er) { fail(er); } return; }
    const wf = e.target.closest('#workForm'); if (wf) { e.preventDefault(); try { await api('/api/tg/autopilot', { method: 'PUT', body: { workMode: wf.workMode.value } }); toast('Saved'); App.render(); } catch (er) { fail(er); } return; }
    const af = e.target.closest('#autoForm'); if (af) { e.preventDefault(); try { await api('/api/tg/autopilot', { method: 'PUT', body: { onbMode: af.onbMode.value, autoTick: af.autoTick.checked } }); toast('Saved'); App.render(); } catch (er) { fail(er); } return; }
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
  on('tgAlertDone', async (b) => { await api('/api/tg/alerts/' + b.closest('[data-al]').dataset.al, { method: 'PATCH', body: {} }); toast('Done'); App.render(); });
  on('tgMe', async () => {
    try {
      const r = await api('/api/tg/me-code', { method: 'POST', body: {} });
      dialog(`<div class="dform"><h2>Connect my Telegram</h2>${r.connected ? `<p class="hint">Connected now as <b>${esc(r.connected.name)}</b>${r.connected.username ? ' (@' + esc(r.connected.username) + ')' : ''}. Do it again only for a different account.</p>` : ''}
        <ol class="gsteps"><li>In Telegram, open ${r.bot ? `<b>@${esc(r.bot)}</b>` : 'the bot'} (or any group it is in).</li><li>Send this:</li></ol>
        <div class="gcopy"><pre>/me ${esc(r.code)}</pre><button type="button" class="btn plain sm" data-act="tgCopyCode" data-code="/me ${esc(r.code)}">Copy</button></div>
        <p class="hint">Then the bot knows you are on the team: you can register groups, tap the team's buttons, and ask it for a driver's profile (/driver Name). The code works for a day.</p>
        <div class="dact"><button type="button" class="btn primary" data-act="closeDialog">Done</button></div></div>`);
    } catch (e) { fail(e); }
  });
  // ---------- one dispatcher's work review (admins) ----------
  const AREA = { communication: 'Talking to drivers', clarity: 'Clear instructions', speed: 'Answering fast', problem_solving: 'Solving problems', follow_through: 'Doing what he says',
    updates: 'Running updates', driver_care: 'Caring for the driver', professionalism: 'Professional' };
  const VERDICT = { good: ['Handled well', 'v-good'], ok: ['OK', 'v-ok'], poor: ['Handled badly', 'v-poor'] };
  const TREND = { first: 'First review', better: '↑ Better than last time', same: '→ About the same', worse: '↓ Worse than last time' };
  const dots = (n) => `<span class="sdots" aria-label="${n} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on s' + n : ''}"></i>`).join('')}</span>`;
  const avg = (sc) => (sc && sc.length ? sc.reduce((a, x) => a + (+x.score || 0), 0) / sc.length : null);
  let dispRefNow = null;
  // a message in Telegram: only supergroups (-100...) have links; the person must be in the group to open it
  const tgMsgUrl = (chatId, msg) => (/^-100[0-9]+$/.test(String(chatId)) ? `https://t.me/c/${String(chatId).slice(4)}/${msg}` : null);
  // "See the messages" for a review item that cites a message
  const seeMsgs = (p, ref) => { const x = ref && p.refs && p.refs[ref]; if (!x) return '';
    const url = tgMsgUrl(x.chat, x.msg);
    return `<div class="seemsg"><button type="button" class="linkbtn small" data-act="tgAround" data-chat="${esc(x.chat)}" data-msg="${x.msg}" data-hl="${x.msg}${x.driverMsg ? ',' + x.driverMsg : ''}">See the messages</button>${url ? ` · <a class="small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open in Telegram</a>` : ''}</div>`; };
  on('tgAround', async (b) => {
    const r = await api(`/api/tg/chats/${encodeURIComponent(b.dataset.chat)}/around?msg=${b.dataset.msg}`);
    const hl = new Set(String(b.dataset.hl || '').split(',').map(Number)); const url = tgMsgUrl(r.chatId, b.dataset.msg);
    dialog(`<div class="dform"><h2>${esc(r.title || 'Group')}</h2><p class="hint">The messages around this moment. Highlighted: the driver's message and the reply the review is about.</p>
      <ol class="chatlog">${r.msgs.map((m) => `<li class="${hl.has(m.msgId) ? 'hl' : ''} ${m.role === 'driver' ? 'drv' : ''}"><div class="small mut"><b>${esc(m.who)}</b>${m.role === 'driver' ? ' (driver)' : ''}, ${esc(when(m.at))}</div><div>${m.text ? esc(m.text) : `<span class="none">[${esc(m.media || 'message')}]${m.mediaNote ? ' ' + esc(m.mediaNote) : ''}</span>`}</div></li>`).join('') || '<li class="none">No messages saved here.</li>'}</ol>
      <div class="dact">${url ? `<a class="btn plain" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open in Telegram</a>` : ''}<a class="btn plain" href="#/telegram/${esc(r.chatId)}">Open the group page</a><button type="button" class="btn primary" data-act="closeDialog">Close</button></div></div>`);
    const h = document.querySelector('#dlg .chatlog li.hl'); if (h) h.scrollIntoView({ block: 'center' });
  });
  async function viewDispatcher(ref) {
    if (S.me.role !== 'admin') { location.hash = '#/'; return; }
    dispRefNow = ref; const live = App.drawing(); let r;
    try { r = await api('/api/tg/dispatchers/' + ref); } catch (e) { if (live()) view.innerHTML = header('telegram') + `<main><a class="back" href="#/telegram">← Telegram manager</a><p class="hint">${esc(e.message)}</p></main>`; return; }
    if (!live()) return;
    const p = r.profile || {}, st = r.stats || {}, fb = p.feedback || {}, li = (a) => (a || []).map((x) => `<li>${esc(x)}</li>`).join('');
    const fmtMin = (m) => (m === null || m === undefined ? '—' : m < 60 ? m + ' min' : (m / 60).toFixed(1) + ' h');
    document.title = `${r.person.name} · review · FleetHire`;
    const fig = (v, l) => `<div><dd>${v}</dd><dt>${l}</dt></div>`;
    view.innerHTML = header('telegram') + `<main class="dreview"><a class="back" href="${r.user ? '#/team/' + r.user.id : '#/telegram'}">← ${r.user ? esc(r.user.name) : 'Telegram manager'}</a>
      <div class="pagehead"><h1>${esc(r.person.name)}: work review</h1>
        <p class="hint">What the AI sees in the driver groups: how he works, how he writes, how he handles problems, and the feedback to give him. Only admins see this page.${r.at ? ` Reviewed ${when(r.at)}.` : ''}</p>
        <div class="acts"><button class="btn plain" data-act="dispReview">Review again now</button>${r.user ? (r.user.noLogin ? ` <a class="btn plain" href="#/team/${r.user.id}">Give him a login</a>` : '') : ''}</div></div>
      <section class="card"><dl class="figs">${fig(st.msgs || 0, 'messages, 30 days')}${fig(st.groups || 0, 'driver groups')}${fig(fmtMin(st.med), 'half his answers within')}${fig(st.his ? Math.round((st.fast / st.his) * 100) + '%' : '—', 'answered within 15 min')}${fig(st.slow || 0, 'driver messages waited 2 h+ (his groups)')}${fig(st.night || 0, 'messages 10 PM–6 AM')}</dl></section>
      ${!r.profile ? '<section class="card"><p class="hint">No review yet. It is written once he has 20 messages in the groups (or press Review again now).</p></section>' : `
      ${(p.red_flags || []).length ? `<section class="card flagcard"><h3>Act on this</h3><ul>${p.red_flags.map((x, i) => `<li>${esc(x)}${seeMsgs(p, (p.red_flag_refs || [])[i])}</li>`).join('')}</ul></section>` : ''}
      <section class="card"><div class="dchips">${p.trend ? `<span class="dchip">${esc(TREND[p.trend.direction] || '')}</span>` : ''}${p.confidence ? `<span class="dchip">${p.confidence === 'low' ? 'Few messages: a first impression' : p.confidence === 'medium' ? 'Fair picture' : 'Clear picture'}</span>` : ''}</div>
        <p class="lead">${esc(p.summary || '')}</p>${p.trend && p.trend.what_changed ? `<p class="small"><b>Since last time:</b> ${esc(p.trend.what_changed)}</p>` : ''}</section>
      ${p.feedback ? `<section class="card fbcard"><div class="row sb"><h3>Feedback to give him</h3><button class="btn sm plain" data-act="dispCopy">Copy</button></div>
        ${p.tip ? `<p class="tipline"><b>Tip this week:</b> ${esc(p.tip)}</p>` : ''}
        <dl class="fb">${[['Start with', fb.praise_first], ['The main point', fb.main_point], ['Show him', fb.show_example], ['What to say', fb.how_to_say_it], ['Goal for the next 2 weeks', fb.goal], ['How to check', fb.check_how]].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}${k === 'Show him' ? seeMsgs(p, fb.show_example_ref) : ''}</dd>`).join('')}</dl></section>` : ''}
      ${(p.scores || []).length ? `<section class="card"><h3>Area by area</h3><table class="mini scoretab"><tbody>${p.scores.map((x) => `<tr><td><b>${esc(AREA[x.area] || x.area)}</b><div>${dots(+x.score || 0)}</div></td><td>${esc(x.seen || '')}${x.example ? `<div class="quote">“${esc(x.example)}”</div>${seeMsgs(p, x.ref)}` : ''}${x.say_instead ? `<div class="better"><b>Better:</b> “${esc(x.say_instead)}”</div>` : ''}${x.improve ? `<div class="howto"><b>${+x.score >= 5 ? 'Keep doing' : 'To improve'}:</b> ${esc(x.improve)}</div>` : ''}</td></tr>`).join('')}</tbody></table>${p.scores.some((x) => x.improve) ? '' : '<p class="hint">This review was made before the per-area advice existed. Press <b>Review again</b> to get how to improve in each area.</p>'}</section>` : ''}
      ${(p.issues || []).length ? `<section class="card"><h3>Real situations from the groups</h3><table class="mini issuetab"><thead><tr><th>What happened</th><th>What he did</th><th></th><th>Better</th></tr></thead><tbody>${p.issues.map((x) => { const v = VERDICT[x.verdict] || ['', ''];
          return `<tr><td>${esc(x.situation)}${seeMsgs(p, x.ref)}</td><td>${esc(x.what_he_did)}</td><td><span class="vbadge ${v[1]}">${v[0]}</span></td><td>${esc(x.better_way || '')}</td></tr>`; }).join('')}</tbody></table></section>` : ''}
      <div class="twocol"><section class="card"><h3>How he thinks</h3><p>${esc(p.thinking || '—')}</p><h3>How drivers react to him</h3><p>${esc(p.drivers_view || '—')}</p></section>
        <section class="card">${[['Keep doing', p.strengths], ['To improve', p.improve], ['How he runs updates', p.update_habits], ['His typical messages', p.phrases]].filter(([, a]) => a && a.length).map(([t, a]) => `<h4>${t}</h4><ul>${li(a)}</ul>`).join('')}</section></div>`}
      ${r.history.length > 1 ? `<section class="card"><h3>Past reviews</h3><table class="mini"><thead><tr><th>Date</th><th class="n">Average</th><th>Goal given</th><th>Trend</th></tr></thead><tbody>${r.history.map((h) => `<tr><td>${when(h.at)}</td><td class="n">${avg(h.scores) === null ? '—' : avg(h.scores).toFixed(1) + ' / 5'}</td><td>${esc(h.goal || '')}</td><td>${esc((TREND[(h.trend || {}).direction] || ''))}</td></tr>`).join('')}</tbody></table></section>` : ''}
      ${r.groups.length ? `<section class="card"><h3>His groups, last 30 days</h3><ul class="glist">${r.groups.map((g) => `<li><a href="#/telegram/${g.chat_id}">${esc(g.title || 'Group')}</a> <span class="small mut">${plural(g.n, 'message')}</span></li>`).join('')}</ul></section>` : ''}
      ${r.rules ? `<details class="card rulescard" ${r.rules.own ? '' : 'open'}><summary><b>How we work</b> <span class="small mut">the reviews must fit these rules</span></summary>
        <p class="hint">Always applied:</p><pre class="rulesfixed">${esc(r.rules.fixed)}</pre>
        <label class="fld">Your own rules, one per line<textarea id="dispRules" rows="6" placeholder="- A tired driver: ...
- A late driver: ...">${esc(r.rules.own)}</textarea></label>
        <p class="hint">When a review suggests something your team cannot or should not do, write the rule here. It is used from the next review of every dispatcher (press Review again now to see it at once).</p>
        <div><button type="button" class="btn primary sm" data-act="dispRulesSave">Save the rules</button></div></details>` : ''}
    </main>`;
    App.lastReview = r;
  }
  on('dispRulesSave', async (b) => { b.disabled = true; try { await api('/api/tg/dispatch-rules', { method: 'PUT', body: { text: $('#dispRules').value } }); toast('Saved. Used from the next review.'); } catch (e) { fail(e); } b.disabled = false; });
  on('dispReview', async (btn) => { btn.disabled = true; btn.textContent = 'Reviewing… (up to a minute)'; try { await api(`/api/tg/dispatchers/${dispRefNow}/review`, { method: 'POST' }); toast('Review updated'); viewDispatcher(dispRefNow); } catch (e) { fail(e); btn.disabled = false; btn.textContent = 'Review again now'; } });
  on('dispCopy', async () => { const fb = ((App.lastReview || {}).profile || {}).feedback || {};
    const t = [fb.praise_first, fb.main_point, fb.show_example, fb.how_to_say_it, fb.goal && 'Goal for the next 2 weeks: ' + fb.goal].filter(Boolean).join('\n\n');
    try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { toast('Could not copy'); } });
  App.route(/^#\/dispatcher\/(u?\d+)$/, viewDispatcher);
  App.route(/^#\/telegram$/, viewList);
  App.route(/^#\/shifts$/, () => { tab = 'desk'; return viewList(); }); // the Shift desk, also from the menu
  App.route(/^#\/telegram\/(-?\d+)$/, viewChat);
  App.tgLeadGroups = leadGroups;
  // ---------- the Telegram conversation on the lead page, and a box to write in it through the bot ----------
  const GK = { dispatch: 'Dispatch', eld: 'ELD', accounting: 'Accounting' };
  async function leadChat(driverId, host, keep) {
    let r; try { r = await api(`/api/drivers/${driverId}/tg-chat`); } catch (e) { return; }
    if (!host.isConnected) return;
    const many = new Set(r.msgs.map((m) => m.chatId)).size > 1;
    const bubble = (m) => `<div class="msg ${m.side === 'driver' ? 'c' : m.side === 'other' ? 's' : 'd'}"><span class="w">${esc(m.who)}${many ? ' · ' + (GK[m.kind] || m.kind) : ''} <span class="mut">${esc(when(m.at))}</span></span>${esc(m.text)}${m.note ? `<span class="small mut" style="display:block">${esc(m.note)}</span>` : ''}</div>`;
    const draft = keep || '';
    host.innerHTML = `<h3>Telegram conversation${r.msgs.length ? ` <span class="small mut">${plural(r.msgs.length, 'message')}${r.msgs.length >= 300 ? ', the latest' : ''}</span>` : ''}</h3>
      ${!r.groups.length ? '<p class="hint">No Telegram group is linked to this driver yet. Add the bot to his group; it links itself by the name or phone in the title, or link it under Telegram groups above.</p>'
        : r.msgs.length ? `<div class="convo" id="tgcv">${r.msgs.map(bubble).join('')}</div>` : '<p class="hint">The group is linked, but nothing was written since the bot joined.</p>'}
      ${r.groups.length ? (r.canSend ? `<form class="tgsay"><textarea name="text" rows="2" maxlength="3000" placeholder="Write to the driver in his Telegram group…" aria-label="Message to the driver's Telegram group">${esc(draft)}</textarea>
        <div class="tgsayrow">${r.sendTo.length > 1 ? `<select name="kind" aria-label="Which group">${r.sendTo.map((k) => `<option value="${k}">${GK[k] || k} group</option>`).join('')}</select>` : ''}<button class="btn primary">Send through the bot</button><span class="small mut">Goes out as the bot, signed with your name.</span></div></form>`
        : `<p class="hint">${r.botOn ? 'The bot is no longer in this driver\'s group, so a message cannot be sent from here.' : 'The Telegram bot is not turned on, so a message cannot be sent from here.'}</p>`) : ''}`;
    const cv = host.querySelector('#tgcv'); if (cv) cv.scrollTop = cv.scrollHeight;
  }
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form.tgsay'); if (!f) return; e.preventDefault();
    const host = f.closest('.tgchat'); const text = f.text.value.trim(); if (!text) return;
    const b = f.querySelector('button'); b.disabled = true; b.textContent = 'Sending…';
    try { await api(`/api/drivers/${host.dataset.driver}/tg-chat`, { method: 'POST', body: { text, kind: f.kind ? f.kind.value : 'dispatch' } }); toast('Sent in the Telegram group'); await leadChat(host.dataset.driver, host); }
    catch (er) { fail(er); b.disabled = false; b.textContent = 'Send through the bot'; }
  });
  App.tgLeadChat = leadChat;
  // ---------- CDL and medical card on a driver's papers: on file or missing, with a button to ask in his Telegram group ----------
  const PAPER = { cdl: 'CDL', medical: 'Medical card' };
  async function papers(driverId, box) {
    let r; try { r = await api(`/api/drivers/${driverId}/papers`); } catch (e) { return; }
    if (!box.isConnected) return;
    let el = box.querySelector('.pstat'); if (!el) { el = document.createElement('div'); el.className = 'pstat'; box.querySelector('.dlist').before(el); }
    el.dataset.driver = driverId;
    el.innerHTML = ['cdl', 'medical'].map((k) => `<div class="prow"><b>${PAPER[k]}</b>${r[k] ? '<span class="okt">✓ On file</span>'
      : `<span class="latetag">Missing</span>${r.canAsk ? `<button type="button" class="btn plain sm" data-act="tgPaperAsk" data-kind="${k}">${r.asked[k] ? 'Ask again in Telegram' : 'Request in Telegram'}</button>` : ''}${r.asked[k] ? `<span class="small mut">The bot asked ${esc(when(r.asked[k]))}</span>` : ''}`}</div>`).join('')
      + (!r.cdl || !r.medical ? (r.canAsk ? '' : `<p class="small mut">${r.botOn ? 'To ask for them through the bot, the driver needs a Telegram group with the bot in it.' : 'The Telegram bot is not turned on, so it cannot ask for them.'}</p>`) : '');
  }
  on('tgPaperAsk', async (b) => { const el = b.closest('.pstat'); b.disabled = true;
    try { await api(`/api/drivers/${el.dataset.driver}/request-paper`, { method: 'POST', body: { kind: b.dataset.kind } }); toast(`The bot asked for the ${PAPER[b.dataset.kind].toLowerCase() === 'cdl' ? 'CDL' : 'medical card'} in his Telegram group`); await papers(el.dataset.driver, el.closest('.docsbox')); const c = document.querySelector('.tgchat'); if (c && App.tgLeadChat) App.tgLeadChat(el.dataset.driver, c); }
    catch (e) { fail(e); b.disabled = false; } });
  App.tgPapers = papers;
})();
