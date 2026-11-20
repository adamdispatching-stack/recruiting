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

  async function viewSettings() {
    document.title = 'Settings · Recruiting';
    const admin = S.me.role === 'admin';
    let keys = [], cfg = null; const live = App.drawing();
    if (admin) { keys = await api('/api/keys'); cfg = await api('/api/settings'); if (!live()) return; steps = cfg.checklist.map((x) => ({ ...x })); }
    const people = S.me.people.filter((p) => p.active);
    view.innerHTML = header('settings') + `<main class="narrow">
      ${admin ? `
      <section class="card"><h3>Team time zone</h3>
        <p class="hint lead">Reports count a day from midnight to midnight in this time zone, and "today" for follow-ups starts here. Pick the zone your recruiters' working day belongs to, so one shift is one day.</p>
        <form id="tzForm" class="form"><label class="fld">Time zone<select name="tz">${(ZONES.some(([z]) => z === cfg.tz) ? ZONES : [[cfg.tz, cfg.tz]].concat(ZONES)).map(([z, l]) => `<option value="${z}" ${z === cfg.tz ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label><button class="btn primary">Save</button></form></section>
      <section class="card" id="hours"><h3>Working hours</h3>
        <p class="hint lead">The team's normal week, in ${esc(cfg.tz.split('/').pop().replace(/_/g, ' '))} time. A working day with less active time than the minimum below counts as a day off. You can give one person different hours on their page under Team.</p>
        <form id="hoursForm">${App.weekFields(cfg.hours.week)}
          <div class="form" style="margin-top:12px">
            <label class="fld">A day counts as worked after<span class="fldunit"><input name="minMinutes" type="number" min="1" max="600" required value="${cfg.hours.minMinutes}"> minutes active</span></label>
            <label class="fld">Late start after<span class="fldunit"><input name="grace" type="number" min="0" max="180" required value="${cfg.hours.grace}"> minutes</span></label>
            <button class="btn primary">Save working hours</button></div></form></section>
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
        <p class="hint lead">Create one key for each Chrome profile. In that profile, open the extension's side panel, then Settings, then Shared database, and paste this website's address and the key. New leads from that profile go to the recruiter you choose.</p>
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
    $('#pwForm').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); try { await api('/api/me/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } }); e.target.reset(); toast('Password changed'); } catch (err) { fail(err); } };
    if (!admin) return;
    const save = async (body, msg) => { try { await api('/api/settings', { method: 'PUT', body }); S.me = await api('/api/me'); toast(msg); viewSettings(); } catch (err) { fail(err); } };
    $('#tzForm').onsubmit = (e) => { e.preventDefault(); save({ tz: new FormData(e.target).get('tz') }, 'Time zone saved'); };
    $('#hoursForm').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); save({ hours: { week: App.readWeek(e.target), minMinutes: +f.get('minMinutes'), grace: +f.get('grace') } }, 'Working hours saved'); };
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
  on('import', async () => {
    const file = $('#impFile').files[0]; if (!file) { $('#impMsg').textContent = 'Pick a backup file first.'; return; }
    let data; try { data = JSON.parse(await file.text()); } catch (err) { $('#impMsg').textContent = 'That file is not a backup from the extension.'; return; }
    $('#impMsg').textContent = 'Importing…';
    try { const r = await api('/api/import', { method: 'POST', body: { drivers: data.drivers, label: file.name.replace(/\.json$/i, '') } }); $('#impMsg').textContent = `Done: ${r.merged} drivers merged.`; }
    catch (err) { $('#impMsg').textContent = err.message; }
  });

  App.route(/^#\/settings$/, viewSettings);
})();
