// Settings: time zone, who sees which leads, lead sources, the onboarding checklist, extension keys, import, password.
(() => {
  const { $, $$, esc, view, S, api, toast, fail, on, header, when, person } = App;
  const ZONES = [['America/New_York', 'US Eastern (New York)'], ['America/Chicago', 'US Central (Chicago)'], ['America/Denver', 'US Mountain (Denver)'], ['America/Los_Angeles', 'US Pacific (Los Angeles)'], ['Asia/Tashkent', 'Tashkent'], ['Europe/London', 'London'], ['Europe/Istanbul', 'Istanbul'], ['Asia/Dubai', 'Dubai'], ['UTC', 'UTC']];
  const AUTO_WHEN = { telegram: 'Ticks itself when the Telegram group link is saved. It can also be ticked by hand.', truck: 'Ticks itself when a truck is chosen for the driver', arrival: 'Ticks itself when the expected arrival date is set', arrived: 'Ticks itself when the arrival date is filled in' };
  let steps = [];
  const stepRows = () => steps.map((s, i) => `<li data-i="${i}"><span class="num">${i + 1}</span><input type="text" maxlength="80" value="${esc(s.label)}" aria-label="Step ${i + 1}">
    ${s.auto ? `<span class="small mut" title="${AUTO_WHEN[s.auto]}">ticks itself</span>` : ''}<button type="button" class="linkbtn" data-act="stepUp" ${i ? '' : 'disabled'} aria-label="Move up">Up</button><button type="button" class="linkbtn" data-act="stepDown" ${i < steps.length - 1 ? '' : 'disabled'} aria-label="Move down">Down</button><button type="button" class="linkbtn red" data-act="stepDrop">Remove</button></li>`).join('');
  const readSteps = () => { $$('#tplList li').forEach((li) => { steps[+li.dataset.i].label = li.querySelector('input').value; }); };
  const drawSteps = () => { $('#tplList').innerHTML = stepRows(); };

  // Backups, how long raw group messages are kept, and the server's recent errors
  async function drawSafety() {
    let r; try { r = await api('/api/admin/safety'); } catch (e) { return; }
    const box = $('#safetyBox'); if (!box) return; const L = r.backup.last;
    const mb = (b) => (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB';
    box.innerHTML = `<p class="hint">A backup is every table of the database in one file. Keep a copy outside Railway. Sign-in sessions and access keys are never in it.</p>
      <p><a class="btn primary sm" href="/api/admin/backup" download>Download a backup now</a> <a class="btn plain sm" href="/api/admin/backup?files=1" download title="Also the uploaded driver papers and pictures: a bigger file">With uploaded files</a></p>
      <form id="safetyForm" class="form"><label class="chk"><input type="checkbox" name="tg" ${r.backup.tg ? 'checked' : ''}> Send a backup to the admins in Telegram every night, after <input type="number" name="hour" min="0" max="23" value="${r.backup.hour}" style="width:56px">:00 (private chat with the bot; without uploaded files)</label>
        ${L ? `<p class="small ${L.error ? 'cbad' : 'mut'}">Last nightly backup ${esc(App.when(L.at))}: ${L.error ? 'not sent, ' + esc(L.error) : `sent to ${L.sent} admin${L.sent === 1 ? '' : 's'}, ${mb(L.bytes)}, ${L.rows} rows`}</p>` : ''}
        <label class="fld">Delete raw group messages older than (days, 0 = keep forever)<input type="number" name="keep" min="0" max="3650" value="${r.data.keepMessagesDays || 0}" style="max-width:120px"></label>
        <p class="small mut">Now: ${r.size.messages} messages${r.size.oldest ? ', the oldest from ' + esc(App.when(r.size.oldest)) : ''}; the database is ${mb(r.size.bytes)}. What the bot learned from them (summaries, updates, knowledge, profiles) stays.</p>
        <div><button class="btn primary sm">Save</button> ${r.botOn ? '<button type="button" class="btn plain sm" data-act="backupSend">Send a backup to Telegram now</button>' : ''}</div></form>
      <p class="small mut">${r.runner ? 'This server runs the bot and the background jobs.' : 'Another copy of the server runs the bot and the background jobs right now.'} If the server crashes, the admins are told on the website and in Telegram.</p>
      ${r.errors.length ? `<details><summary>Server errors (${r.errors.length} latest)</summary><table class="mini"><tbody>${r.errors.map((e) => `<tr><td class="small nowrap">${esc(App.when(e.at))}</td><td class="small">${esc(e.kind)}${e.place ? ' · ' + esc(e.place) : ''}</td><td class="small">${esc(e.message || '')}</td></tr>`).join('')}</tbody></table></details>` : '<p class="small okt">No server errors recorded.</p>'}`;
    $('#safetyForm').onsubmit = async (e) => { e.preventDefault(); const f = e.target;
      try { await api('/api/admin/safety', { method: 'PUT', body: { backup: { tg: f.tg.checked, hour: +f.hour.value }, data: { keepMessagesDays: +f.keep.value } } }); toast('Saved'); drawSafety(); } catch (er) { fail(er); } };
  }
  on('backupSend', async (b) => { b.disabled = true; try { const r = await api('/api/admin/backup/send', { method: 'POST' }); toast(r.sent ? `Sent to ${r.sent} admin${r.sent === 1 ? '' : 's'}` : 'Not sent: ' + r.error, !r.sent); } catch (e) { fail(e); } drawSafety(); });
  async function viewSettings() {
    document.title = 'Settings · FleetHire';
    const admin = S.me.role === 'admin';
    let keys = [], cfg = null, sh = null; const live = App.drawing();
    if (admin) { [keys, cfg, sh] = await Promise.all([api('/api/keys'), api('/api/settings'), api('/api/share')]); if (!live()) return; steps = cfg.checklist.map((x) => ({ ...x })); }
    const people = S.me.people.filter((p) => p.active);
    view.innerHTML = header('settings') + `<main class="narrow">${App.pageHead(admin ? 'Settings' : 'Your password', admin ? 'Time zone, working hours, lead sources, the onboarding checklist and the Chrome extension.' : '')}
      ${admin ? `
      <section class="card" id="safety"><h3>Backups and data</h3><div id="safetyBox"><p class="hint">Loading…</p></div></section>
      <section class="card"><h3>Team time zone</h3>
        <p class="hint lead">Reports count a day from midnight to midnight in this time zone, and "today" for follow-ups starts here. Pick the zone your recruiters' working day belongs to, so one shift is one day.</p>
        <form id="tzForm" class="form"><label class="fld">Time zone<select name="tz">${(ZONES.some(([z]) => z === cfg.tz) ? ZONES : [[cfg.tz, cfg.tz]].concat(ZONES)).map(([z, l]) => `<option value="${z}" ${z === cfg.tz ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label><button class="btn primary">Save</button></form></section>
      <section class="card" id="fbtargets"><h3>Facebook daily targets</h3>
        <p class="hint lead">What each recruiter should log on the Facebook page every working day. 0 means it is not asked for. The personal posts and comments keep each account looking like a real person's, so Facebook does not limit it.</p>
        <form id="fbtForm" class="form">${[['picture', 'Ad pictures made with ChatGPT'], ['post', 'Posts in groups (with the ad picture)'], ['comment', 'Comments on ads (with a screenshot)'], ['contact', 'Drivers messaged'], ['chat', 'Group chats joined'], ['ppost', 'Personal posts on their own profile'], ['pcomment', 'Comments on posts not about the job']].map(([k, l]) => `<label class="fld">${l}<input name="${k}" type="number" min="0" max="200" required value="${(cfg.fbTargets || {})[k] ?? 0}"></label>`).join('')}
          <button class="btn primary">Save targets</button></form></section>
      <section class="card" id="sharing"><h3>Sharing new leads</h3>
        <p class="hint lead">New leads from the Chrome extension go to the recruiter who has been given the fewest leads today, so everyone gets the same number. Someone on a day off is skipped. Leads a recruiter adds themselves stay theirs and don't count. Only an admin can change who a lead belongs to.</p>
        <form id="shareForm"><label class="chk"><input type="checkbox" name="on" ${sh.on ? 'checked' : ''}> Share new leads evenly</label>
          <fieldset class="sharewho"><legend>Who gets leads</legend>${S.me.people.filter((p) => p.active && p.role !== 'dispatcher').map((p) => `<label class="chk"><input type="checkbox" name="p" value="${p.id}" ${(Array.isArray(cfg.share && cfg.share.people) ? cfg.share.people.includes(p.id) : p.role !== 'admin') ? 'checked' : ''}> ${esc(p.name)}${p.role === 'admin' ? ' <span class="mut">(admin)</span>' : ''}</label>`).join('')}</fieldset>
          <label class="chk"><input type="checkbox" name="onlyOnline" ${sh.onlyOnline ? 'checked' : ''}> Only to recruiters working right now</label>
          <p class="hint" style="margin:-4px 0 10px 28px">Working right now: active on the website in the last ${sh.onlineMin} minutes. A lead that comes in while nobody is working waits, and goes to the first ones who start.</p>
          <div class="mvrow"><label for="mvA">Move a new lead its recruiter has not opened, while they are away, after</label><input id="mvA" name="moveAfter" type="number" min="0" max="1440" step="5" value="${sh.moveAfter}"><span>minutes</span><span class="mut">(0 = never)</span></div>
          <button class="btn primary">Save</button></form>
        ${sh.people.length ? `<table class="sharet"><thead><tr><th>Recruiter</th><th>Given today</th><th>Last 7 days</th><th>Right now</th></tr></thead><tbody>${sh.people.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.id === sh.next && sh.on ? ' <span class="nextpill">gets the next lead</span>' : ''}</td><td>${p.today}</td><td>${p.week}</td><td>${p.off ? 'Day off' : p.online ? '<span class="onl">Working now</span>' : `${p.working ? 'Away' : 'Not working today'}${p.lastActive ? ` <span class="mut small">last active ${esc(App.teamWhen(p.lastActive))}</span>` : ''}`}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Nobody is ticked to get leads.</p>'}
        ${sh.on && sh.onlyOnline && !sh.next && sh.people.length ? '<p class="hint">Nobody is working right now: new leads wait and go out as soon as someone starts.</p>' : ''}
        ${sh.waiting ? `<div class="drow"><span class="grow">${sh.waiting} lead${sh.waiting > 1 ? 's are' : ' is'} in progress with no recruiter.</span><button class="btn plain" data-act="shareNow">Share ${sh.waiting > 1 ? 'them' : 'it'} evenly now</button></div>` : ''}
      </section>
      <section class="card" id="noanswer"><h3>Indeed message after a missed call</h3>
        <p class="hint lead">When a recruiter logs "Called, no answer" or "Left voicemail" on a lead that came from an Indeed chat, the Chrome extension sends this message in that chat. It goes out from a Chrome profile that has the chat, with Indeed Messages open and auto-reply on. At most one every 12 hours to the same driver. {first} is the driver's first name, {me} the first name of the person who called.</p>
        <form id="naForm" class="naform"><label class="chk"><input type="checkbox" name="on" ${(cfg.noAnswer || {}).on !== false ? 'checked' : ''}> Send it</label>
          <label class="fld">Message<textarea name="text" rows="3" maxlength="600">${esc((cfg.noAnswer || {}).text || '')}</textarea></label>
          <button class="btn primary">Save</button></form></section>
      <section class="card" id="callpts"><h3>Call guide</h3>
        <p class="hint lead">What recruiters see under "Mention" on each lead, one point per line. The home time line is added from the driver's state.</p>
        <form id="callForm"><div class="grid2">
          <label class="fld">Company drivers<textarea name="company" rows="7">${esc((cfg.callPoints || {}).company ? cfg.callPoints.company.join('\n') : '')}</textarea></label>
          <label class="fld">Owner operators<textarea name="owner" rows="7">${esc((cfg.callPoints || {}).owner ? cfg.callPoints.owner.join('\n') : '')}</textarea></label></div>
          <button class="btn primary" style="margin-top:10px">Save talking points</button></form></section>
      <section class="card" id="hours"><h3>Working hours</h3>
        <p class="hint lead">The team's normal week, in ${esc(cfg.tz.split('/').pop().replace(/_/g, ' '))} time. A working day with less active time on the website (on a computer; phones and tablets do not count) than the minimum below counts as a day off. You can give one person different hours on their page under Team.</p>
        <form id="hoursForm">${App.weekFields(cfg.hours.week)}
          <div class="form" style="margin-top:12px">
            <label class="fld">A day counts as worked after<span class="fldunit"><input name="minMinutes" type="number" min="1" max="600" required value="${cfg.hours.minMinutes}"> minutes active</span></label>
            <label class="fld">Late start after<span class="fldunit"><input name="grace" type="number" min="0" max="180" required value="${cfg.hours.grace}"> minutes</span></label>
            <label class="fld">Count as idle after<span class="fldunit"><input name="idleMinutes" type="number" min="5" max="120" required value="${cfg.hours.idleMinutes || 15}"> minutes</span></label>
            <label class="fld">Alert the person and admins after<span class="fldunit"><input name="idleAlert" type="number" min="5" max="480" required value="${cfg.hours.idleAlert || 60}"> minutes idle</span></label>
            <button class="btn primary">Save working hours</button></div>
          <p class="hint" style="margin-top:8px">Idle time: a stretch inside working hours, after the person started their day, with no clicks, typing or scrolling on the website. Shorter stretches are not counted.</p></form></section>
      <section class="card"><h3>Who sees which leads</h3>
        <form id="visForm"><label class="chk radio"><input type="radio" name="visibility" value="all" ${cfg.visibility === 'all' ? 'checked' : ''}><span><b>Everyone sees every lead.</b> Good for a small team that covers for each other.</span></label>
          <label class="chk radio"><input type="radio" name="visibility" value="own" ${cfg.visibility === 'own' ? 'checked' : ''}><span><b>Recruiters see only their own leads and leads nobody has taken.</b> Admins still see everything.</span></label>
          <button class="btn primary" style="margin-top:10px">Save</button></form></section>
      <section class="card"><h3>Lead sources</h3>
        <p class="hint lead">Recruiters must choose one of these when they add a lead. One per line. Indeed always stays, because the Chrome extension files its leads there.</p>
        <form id="srcForm"><textarea name="sources" rows="8" aria-label="Lead sources, one per line">${esc(cfg.sources.join('\n'))}</textarea><button class="btn primary" style="margin-top:8px">Save sources</button></form></section>
      <section class="card"><h3>Onboarding checklist</h3>
        <p class="hint lead">Every driver who starts onboarding gets these steps. Changes also reach drivers being onboarded now: new steps are added, and removed steps disappear unless already ticked.</p>
        <form id="tplForm"><ol class="tpl" id="tplList">${stepRows()}</ol>
          <div class="form" style="margin-top:8px"><button type="button" class="btn plain" data-act="stepNew">Add a step</button><button class="btn primary">Save checklist</button></div></form></section>
      <section class="card"><h3>Connect the Chrome extension</h3>
        <p class="hint lead">Create one key for each Chrome profile. In that profile, open the extension's side panel, then Settings, then Shared database, and paste this website's address and the key. ${S.me.share ? 'New leads are shared evenly (see Sharing new leads above), so the recruiter set on a key is used only when sharing is off.' : 'New leads from that profile go to the recruiter you choose.'}</p>
        <form id="keyForm" class="form"><label class="fld">Name<input name="name" type="text" placeholder="e.g. Davy profile" required></label>
          <label class="fld">New leads go to<select name="assignTo"><option value="">Nobody (unassigned)</option>${people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><button class="btn primary">Create key</button></form>
        <div id="newKey"></div>
        <ul class="list" style="margin-top:8px">${keys.map((k) => `<li data-key="${k.id}"><span class="grow"><b>${esc(k.name)}</b><br><span class="small mut">Created ${esc(when(k.created_at))}${k.owner ? ` by ${esc(k.owner)}` : ''}, ${k.last_used_at ? `last used ${esc(when(k.last_used_at))}` : 'not used yet'}</span></span>
          <label class="small mut">New leads go to <select class="pick line" data-ch="keyAssign"><option value="">Nobody</option>${people.concat(k.assign_to && !people.some((p) => p.id === k.assign_to) ? [{ id: k.assign_to, name: k.assign_name || person(k.assign_to) }] : []).map((p) => `<option value="${p.id}" ${p.id === k.assign_to ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          <button class="btn danger sm" data-act="delKey">Revoke</button></li>`).join('') || '<li class="hint">No keys yet.</li>'}</ul>
      </section>
      <section class="card"><h3>Import a backup</h3>
        <p class="hint lead">In each Chrome profile, open the extension's database page, then More, then Download a backup. Import each file here. Drivers are merged by chat, phone, email and name, so nothing is doubled.</p>
        <div class="form"><label class="fld">Backup file<input id="impFile" type="file" accept=".json"></label><button class="btn primary" data-act="import">Import</button></div><p class="hint" id="impMsg"></p>
      </section>` : ''}
      <section class="card"><h3>Your password</h3><form id="pwForm" class="form">
        <label class="fld">Current password<input name="current" type="password" autocomplete="current-password" required></label>
        <label class="fld">New password<input name="next" type="password" autocomplete="new-password" minlength="10" required></label><button class="btn primary">Change password</button></form></section>
      ${admin ? '<p class="hint foot">People and their accounts are on the <a href="#/team">Team</a> page. Trucks are on the <a href="#/trucks">Trucks</a> page.</p>' : ''}
    </main>`;
    if (admin) drawSafety();
    $('#pwForm').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); try { await api('/api/me/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } }); e.target.reset(); toast('Password changed'); } catch (err) { fail(err); } };
    if (!admin) return;
    const save = async (body, msg) => { try { await api('/api/settings', { method: 'PUT', body }); S.me = await api('/api/me'); toast(msg); viewSettings(); } catch (err) { fail(err); } };
    $('#tzForm').onsubmit = (e) => { e.preventDefault(); save({ tz: new FormData(e.target).get('tz') }, 'Time zone saved'); };
    $('#callForm').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const lines = (k) => String(f.get(k) || '').split('\n').map((x) => x.trim()).filter(Boolean); await save({ callPoints: { company: lines('company'), owner: lines('owner') } }, 'Talking points saved'); await App.reloadMe(); };
    $('#fbtForm').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); save({ fbTargets: { picture: +f.get('picture'), post: +f.get('post'), comment: +f.get('comment'), contact: +f.get('contact'), chat: +f.get('chat'), ppost: +f.get('ppost'), pcomment: +f.get('pcomment') } }, 'Targets saved'); };
    $('#naForm').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); save({ noAnswer: { on: !!f.get('on'), text: String(f.get('text') || '') } }, 'Saved'); };
    $('#shareForm').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); save({ share: { on: !!f.get('on'), people: f.getAll('p').map(Number), onlyOnline: !!f.get('onlyOnline'), moveAfter: +f.get('moveAfter') || 0 } }, 'Saved'); };
    $('#hoursForm').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); save({ hours: { week: App.readWeek(e.target), minMinutes: +f.get('minMinutes'), grace: +f.get('grace'), idleMinutes: +f.get('idleMinutes'), idleAlert: +f.get('idleAlert') } }, 'Working hours saved'); };
    $('#visForm').onsubmit = (e) => { e.preventDefault(); save({ visibility: new FormData(e.target).get('visibility') }, 'Saved'); };
    $('#srcForm').onsubmit = (e) => { e.preventDefault(); save({ sources: String(new FormData(e.target).get('sources')).split('\n') }, 'Sources saved'); };
    $('#tplForm').onsubmit = (e) => { e.preventDefault(); readSteps(); save({ checklist: steps.filter((s) => s.label.trim()) }, 'Checklist saved'); };
    $('#keyForm').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      try { const r = await api('/api/keys', { method: 'POST', body: { name: f.get('name'), assignTo: f.get('assignTo') ? +f.get('assignTo') : null } }); await viewSettings();
        $('#newKey').innerHTML = `<div class="keybox"><b>Copy this key now. It is shown only once.</b><code id="kc">${esc(r.key)}</code><div class="small">Website address: <b>${esc(location.origin)}</b></div><button class="btn primary sm" data-act="copyKey" style="margin-top:6px">Copy key</button></div>`;
        $('#newKey').scrollIntoView({ block: 'center' });
      } catch (err) { fail(err); }
    };
  }
  on('stepNew', () => { readSteps(); steps.push({ label: '' }); drawSteps(); const all = $$('#tplList input'); all[all.length - 1].focus(); });
  on('stepDrop', (b) => { readSteps(); steps.splice(+b.closest('li').dataset.i, 1); drawSteps(); });
  on('stepUp', (b) => { readSteps(); const i = +b.closest('li').dataset.i; [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; drawSteps(); });
  on('stepDown', (b) => { readSteps(); const i = +b.closest('li').dataset.i; [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; drawSteps(); });
  on('delKey', async (b) => { if (!confirm('Revoke this key? That Chrome profile stops syncing until it gets a new key.')) return; await api('/api/keys/' + b.closest('[data-key]').dataset.key, { method: 'DELETE' }); viewSettings(); });
  on('copyKey', async (b) => { await navigator.clipboard.writeText($('#kc').textContent); b.textContent = 'Copied'; });
  App.onChange('keyAssign', async (el) => { await api('/api/keys/' + el.closest('[data-key]').dataset.key, { method: 'PATCH', body: { assignTo: el.value ? +el.value : null } }); toast('Saved'); });
  on('shareNow', async (b) => {
    b.disabled = true;
    try { const r = await api('/api/share/now', { method: 'POST' }); toast(r.shared ? `Shared ${r.shared} lead${r.shared > 1 ? 's' : ''}: ${r.given.map((g) => `${g.name} ${g.n}`).join(', ')}` : 'Nobody is in line to get leads'); viewSettings(); }
    catch (e) { fail(e); b.disabled = false; }
  });
  on('import', async () => {
    const file = $('#impFile').files[0]; if (!file) { $('#impMsg').textContent = 'Pick a backup file first.'; return; }
    let data; try { data = JSON.parse(await file.text()); } catch (err) { $('#impMsg').textContent = 'That file is not a backup from the extension.'; return; }
    $('#impMsg').textContent = 'Importing…';
    try { const r = await api('/api/import', { method: 'POST', body: { drivers: data.drivers, label: file.name.replace(/\.json$/i, '') } }); $('#impMsg').textContent = `Done: ${r.merged} drivers merged.`; }
    catch (err) { $('#impMsg').textContent = err.message; }
  });

  App.route(/^#\/settings$/, viewSettings);
})();
