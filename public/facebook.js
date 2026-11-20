// Facebook work: each recruiter logs the day's posts, comments, drivers messaged and group chats, with links and
// pictures, against the daily targets. Admins see the team's day, open anyone's day and mark each entry OK or Problem.
(() => {
  const { $, esc, view, S, api, toast, fail, on, header, dialog, plural, dateText, addDays, when } = App;
  const KINDS = [
    { k: 'post', title: 'Posts in groups', one: 'post', what: 'An ad picture (made with ChatGPT) posted in a Facebook group: the group, the link to your post, and the picture.' },
    { k: 'comment', title: 'Comments on ads', one: 'comment', what: "A comment under another company's driver ad: the link to that post and a screenshot of your comment." },
    { k: 'contact', title: 'Drivers messaged', one: 'driver', what: "A driver you messaged: their profile link, name, and what they said about OTR and a Class A CDL. Interested drivers can become leads." },
    { k: 'chat', title: 'Group chats joined', one: 'group chat', what: 'A Facebook group chat for truck drivers you were added to.' }
  ];
  const OUT = { messaged: 'Messaged', replied: 'Replied', interested: 'Interested', 'not interested': 'Not interested' };
  let st = { user: 'me', day: null };
  const short = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, '').slice(0, 48); } catch (e) { return u || ''; } };
  const img = (id, cls = '') => (id ? `<a class="fbimg ${cls}" href="/api/fb/images/${id}" target="_blank" rel="noopener" title="Open the full picture"><img src="/api/fb/images/${id}" alt="" loading="lazy"></a>` : '');
  const yn = (v) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '?');

  // ---------- pictures: choose, drop or paste; made smaller before upload ----------
  function shrink(file) {
    return new Promise((res, rej) => {
      if (!/^image\//.test(file.type)) return rej(new Error('That file is not a picture'));
      const r = new FileReader(); r.onerror = () => rej(new Error('Could not read the picture'));
      r.onload = () => { const im = new Image(); im.onerror = () => rej(new Error('Could not read the picture')); im.onload = () => {
        const max = 1600; const k = Math.min(1, max / Math.max(im.width, im.height));
        const c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.82)); }; im.src = r.result; };
      r.readAsDataURL(file);
    });
  }
  async function upload(file, box) {
    const st2 = box.querySelector('.drop'); st2.classList.add('busy'); st2.querySelector('span').textContent = 'Uploading…';
    try {
      const data = await shrink(file); const r = await api('/api/fb/images', { method: 'POST', body: { data } });
      box.querySelector('[name=imageId]').value = r.id;
      st2.innerHTML = `<img src="${data}" alt="Picture to save"><span>Picture added. Drop or paste another to change it.</span>`;
    } catch (e) { st2.querySelector('span').textContent = e.message; fail(e); }
    st2.classList.remove('busy');
  }
  function wirePicture(form) {
    const box = form.querySelector('.picbox'); if (!box) return;
    const input = box.querySelector('input[type=file]'); const drop = box.querySelector('.drop');
    input.onchange = () => input.files[0] && upload(input.files[0], box);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) upload(f, box); };
    form.addEventListener('paste', (e) => { const f = [...(e.clipboardData || {}).files || []][0]; if (f) { e.preventDefault(); upload(f, box); } });
  }
  const picField = (label) => `<div class="fld picbox">${label}<input type="hidden" name="imageId"><label class="drop" tabindex="0"><input type="file" accept="image/*" hidden><span>Choose a picture, drop it here, or paste it (Ctrl+V)</span></label></div>`;

  // ---------- the add form of each kind ----------
  function form(k, groups) {
    const dl = `<datalist id="fbGroups">${groups.map((g) => `<option value="${esc(g.name)}">`).join('')}</datalist>`;
    const f = {
      post: `<label class="fld">Group name<input type="text" name="groupName" list="fbGroups" required maxlength="150" placeholder="e.g. CDL Truck Drivers USA"></label>
        <label class="fld">Group link<input name="groupLink" type="url" placeholder="https://www.facebook.com/groups/…"></label>
        <label class="fld wide">Link to your post<input name="link" type="url" required placeholder="https://www.facebook.com/groups/…/posts/…"></label>${picField('The ad picture')}`,
      comment: `<label class="fld wide">Link to the post you commented on<input name="link" type="url" required placeholder="https://www.facebook.com/…"></label>${picField('Screenshot of your comment')}`,
      contact: `<label class="fld wide">Driver's profile link<input name="link" type="url" required placeholder="https://www.facebook.com/…"></label>
        <label class="fld">Name<input type="text" name="personName" maxlength="120"></label>
        <label class="fld">Drives OTR?<select name="otr"><option value="">Not asked</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        <label class="fld">Class A CDL?<select name="cdlA"><option value="">Not asked</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        <label class="fld">Phone, if they gave it<input name="phone" type="tel" maxlength="30"></label>
        <label class="fld">How it went<select name="outcome">${Object.entries(OUT).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label class="fld">Group they came from<input type="text" name="groupName" list="fbGroups" maxlength="150"></label>`,
      chat: `<label class="fld">Group chat name<input type="text" name="groupName" maxlength="150" placeholder="e.g. NJ CDL drivers"></label>
        <label class="fld wide">Link (if there is one)<input name="link" type="url" placeholder="https://www.facebook.com/messages/t/… or https://m.me/…"></label>`
    }[k];
    return `<form class="fbform" data-kind="${k}">${k === 'post' || k === 'contact' ? dl : ''}<div class="fbgrid">${f}
      <label class="fld wide">Note (optional)<input type="text" name="note" maxlength="1000"></label></div>
      <p class="err" role="alert"></p><div class="drow"><button class="btn primary">Save ${KINDS.find((x) => x.k === k).one}</button></div></form>`;
  }

  // ---------- one entry ----------
  function entryHtml(e, admin, mine, editable) {
    const rv = e.review === 'ok' ? '<span class="rvtag ok">✓ Checked</span>' : e.review === 'problem' ? `<span class="rvtag bad">Problem</span>` : '<span class="rvtag wait">Waiting for review</span>';
    const main = {
      post: `<b>${esc(e.groupName || '')}</b>${e.groupLink ? ` <a href="${esc(e.groupLink)}" target="_blank" rel="noopener" class="small">group</a>` : ''}<div><a href="${esc(e.link)}" target="_blank" rel="noopener">${esc(short(e.link))}</a></div>`,
      comment: `<a href="${esc(e.link)}" target="_blank" rel="noopener">${esc(short(e.link))}</a>`,
      contact: `<b>${esc(e.personName || 'No name')}</b> <a href="${esc(e.link)}" target="_blank" rel="noopener" class="small">profile</a>
        <div class="small">OTR: <b>${yn(e.answers.otr)}</b> · Class A CDL: <b>${yn(e.answers.cdlA)}</b>${e.answers.phone ? ` · ${esc(e.answers.phone)}` : ''} · <span class="otag o-${esc((e.outcome || '').replace(' ', '-'))}">${esc(OUT[e.outcome] || e.outcome || '')}</span>${e.groupName ? ` · from ${esc(e.groupName)}` : ''}</div>`,
      chat: `<b>${esc(e.groupName || 'Group chat')}</b>${e.link ? ` <a href="${esc(e.link)}" target="_blank" rel="noopener" class="small">${esc(short(e.link))}</a>` : ''}`
    }[e.kind];
    const lead = e.kind === 'contact' ? (e.driverId ? `<a class="btn plain sm" href="#/driver/${e.driverId}">Open lead</a>` : `<button class="btn plain sm" data-act="fbLead">Make a lead</button>`) : '';
    return `<li class="fbe${e.review === 'problem' ? ' problem' : e.review === 'ok' ? ' okd' : ''}" data-e="${e.id}">${img(e.imageId)}
      <div class="fbmain">${main}${e.note ? `<div class="small mut">${esc(e.note)}</div>` : ''}${e.review === 'problem' ? `<div class="rvnote"><b>Admin:</b> ${esc(e.reviewNote || '')}</div>` : ''}</div>
      <div class="fbside"><span class="small mut">${esc(new Date(e.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span>${rv}
        <div class="fbacts">${lead}${admin ? `<button class="btn plain sm ok" data-act="fbOk" ${e.review === 'ok' ? 'disabled' : ''}>OK</button><button class="btn plain sm bad" data-act="fbBad">Problem</button>` : ''}
        ${(mine || admin) && editable && e.review !== 'ok' ? '<button class="linkbtn" data-act="fbEdit">Edit</button>' : ''}${(mine && editable && e.review !== 'ok') || admin ? '<button class="linkbtn red" data-act="fbDel">Remove</button>' : ''}</div></div></li>`;
  }

  let shown = null;
  async function viewFb(params) {
    const admin = S.me.role === 'admin';
    st.user = params.get('user') || (admin ? 'team' : 'me'); st.day = params.get('day') || null;
    document.title = 'Facebook · FleetHire';
    if (admin && st.user === 'team') return viewTeamFb();
    const live = App.drawing();
    const r = await api(`/api/fb/day?user=${encodeURIComponent(st.user)}${st.day ? '&day=' + st.day : ''}`); if (!live()) return; shown = r;
    const mine = r.person.id === S.me.id; const isToday = r.day === r.today;
    const t = r.targets; const c = r.counts;
    const nav = (d) => `#/facebook?user=${st.user}&day=${d}`;
    const tile = (x) => { const n = c[x.k] || 0, goal = t[x.k] || 0; const pc = goal ? Math.min(100, Math.round((n / goal) * 100)) : 100;
      return `<a class="fbtile${goal && n >= goal ? ' done' : ''}" href="#fb-${x.k}"><span class="n"><b>${n}</b>${goal ? ` of ${goal}` : ''}</span><span class="l">${x.title}</span><span class="pbar"><i style="width:${pc}%"></i></span></a>`; };
    const list = (k) => r.entries.filter((e) => e.kind === k);
    view.innerHTML = header('facebook') + `<main>${App.pageHead(mine ? 'Facebook work' : `Facebook work: ${esc(r.person.name)}`,
      mine ? 'Log each post, comment, driver and group chat as you do it, with the link and the picture. The admin checks them.' : `What ${esc(r.person.name)} logged. Mark each entry OK, or Problem with a note they will see.`,
      admin ? '<a class="btn plain" href="#/facebook?user=team">Team</a>' : '')}
      <div class="fbday"><a class="btn plain sm" href="${nav(addDays(r.day, -1))}" aria-label="Day before">‹</a><b>${esc(dateText(r.day, { weekday: 'long', month: 'long', day: 'numeric' }))}${isToday ? ' (today)' : ''}</b>
        ${r.day < r.today ? `<a class="btn plain sm" href="${nav(addDays(r.day, 1))}" aria-label="Next day">›</a>${`<a class="linkbtn" href="${nav(r.today)}">Today</a>`}` : ''}
        <span class="grow"></span><span class="fbscore${r.score.met ? ' met' : ''}">${r.score.met ? '✓ Daily target met' : `${r.score.done} of ${r.score.target} done`}</span>
        ${admin && r.entries.some((e) => !e.review) ? '<button class="btn plain sm" data-act="fbAllOk">Mark the rest OK</button>' : ''}</div>
      <div class="fbtiles">${KINDS.filter((x) => (t[x.k] || 0) > 0 || (c[x.k] || 0) > 0).map(tile).join('')}</div>
      ${r.flagged.length ? `<section class="card fbflag"><h3>Problems the admin found on earlier days</h3><ul class="fblist">${r.flagged.map((e) => entryHtml(e, admin, mine, true).replace('<li class="fbe', `<li data-day="${e.day}" class="fbe`)).join('')}</ul>
        <p class="hint">Fix the link or the picture with Edit; it then goes back to the admin.</p></section>` : ''}
      ${KINDS.map((x) => `<section class="card fbsec" id="fb-${x.k}"><h3><span class="grow">${x.title}</span><span class="cnt">${list(x.k).length}${t[x.k] ? ` of ${t[x.k]}` : ''}</span></h3>
        <p class="hint">${x.what}</p>
        ${list(x.k).length ? `<ul class="fblist">${list(x.k).map((e) => entryHtml(e, admin, mine, isToday)).join('')}</ul>` : '<p class="hint fbnone">Nothing logged yet.</p>'}
        ${(mine && isToday) || admin ? `<details class="fbadd"${mine && isToday && list(x.k).length < (t[x.k] || 0) && x.k === firstOpen(r) ? ' open' : ''}><summary>Add a ${x.one}</summary>${form(x.k, r.groups)}</details>` : ''}</section>`).join('')}
    </main>`;
    document.querySelectorAll('.fbform').forEach((f) => { wirePicture(f); f.onsubmit = (e) => save(e, f); });
  }
  const firstOpen = (r) => (KINDS.find((x) => (r.counts[x.k] || 0) < (r.targets[x.k] || 0)) || {}).k;

  async function save(e, f) {
    e.preventDefault(); const body = Object.fromEntries(new FormData(f)); body.kind = f.dataset.kind;
    if (S.me.role === 'admin' && shown && shown.person.id !== S.me.id) { body.userId = shown.person.id; body.day = shown.day; }
    f.querySelector('.err').textContent = '';
    try { await api('/api/fb/entries', { method: 'POST', body }); toast('Saved'); App.render(); }
    catch (err) { f.querySelector('.err').textContent = err.message; }
  }

  // ---------- the team's day (admin) ----------
  async function viewTeamFb() {
    const live = App.drawing(); const day = st.day;
    const [r, g] = await Promise.all([api('/api/fb/team' + (day ? '?day=' + day : '')), api('/api/fb/groups')]); if (!live()) return;
    const t = r.targets; const nav = (d) => `#/facebook?user=team&day=${d}`;
    const cell = (p, k) => { const n = p.counts[k] || 0, goal = t[k] || 0; return `<td class="n${goal && n >= goal ? ' fbok' : goal && n < goal && r.day < r.today ? ' fbshort' : ''}">${n}${goal ? `<span class="mut"> / ${goal}</span>` : ''}</td>`; };
    view.innerHTML = header('facebook') + `<main>${App.pageHead('Facebook work', "Each recruiter's posts, comments, drivers messaged and group chats against the daily targets. Open a person to check their links and pictures.", '<a class="btn plain" href="#/settings">Daily targets</a>')}
      <div class="fbday"><a class="btn plain sm" href="${nav(addDays(r.day, -1))}" aria-label="Day before">‹</a><b>${esc(dateText(r.day, { weekday: 'long', month: 'long', day: 'numeric' }))}${r.day === r.today ? ' (today)' : ''}</b>
        ${r.day < r.today ? `<a class="btn plain sm" href="${nav(addDays(r.day, 1))}" aria-label="Next day">›</a><a class="linkbtn" href="${nav(r.today)}">Today</a>` : ''}</div>
      <div class="sheet"><table class="fbteam"><thead><tr><th>Recruiter</th><th class="n">Posts</th><th class="n">Comments</th><th class="n">Drivers messaged</th><th class="n">Group chats</th><th>Done</th><th class="n">To check</th><th class="n">Problems</th><th>Last entry</th></tr></thead>
        <tbody>${r.people.map((p) => `<tr data-u="${p.id}"><th scope="row"><a href="#/facebook?user=${p.id}&day=${r.day}">${esc(p.name)}</a></th>${['post', 'comment', 'contact', 'chat'].map((k) => cell(p, k)).join('')}
          <td><div class="fbdone"><span class="pbar"><i style="width:${p.score.target ? Math.round((p.score.done / p.score.target) * 100) : 0}%"></i></span><b>${p.score.target ? Math.round((p.score.done / p.score.target) * 100) : 0}%</b></div></td>
          <td class="n">${p.counts.unreviewed || '<span class="none">0</span>'}</td><td class="n${p.counts.problems ? ' bad' : ''}">${p.counts.problems || '<span class="none">0</span>'}</td>
          <td class="small">${p.lastAt ? esc(new Date(p.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) : '<span class="none">Nothing yet</span>'}</td></tr>`).join('') || '<tr><td colspan="9" class="hint">No recruiters yet.</td></tr>'}</tbody></table></div>
      <section class="card" style="margin-top:16px"><h3>Groups the team posts in</h3>
        ${g.groups.length ? `<div class="scroll"><table class="mini"><thead><tr><th>Group</th><th class="n">Posts</th><th>Last post</th></tr></thead><tbody>${g.groups.map((x) => `<tr><td>${x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.name)}</a>` : esc(x.name)}</td><td class="n">${x.posts}</td><td>${esc(dateText(x.lastDay))} by ${esc(x.lastBy)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="hint">No posts logged yet.</p>'}</section></main>`;
  }
  document.addEventListener('click', (e) => { const r = e.target.closest('table.fbteam tr[data-u]'); if (r && !e.target.closest('a')) App.go(`#/facebook?user=${r.dataset.u}&day=${shown && st.day ? st.day : ''}`); });

  // ---------- actions ----------
  const idOf = (b) => +b.closest('[data-e]').dataset.e;
  const entryOf = (b) => shown && [...shown.entries, ...shown.flagged].find((x) => x.id === idOf(b));
  on('fbOk', async (b) => { await api('/api/fb/entries/' + idOf(b), { method: 'PATCH', body: { review: 'ok' } }); App.render(); });
  on('fbAllOk', async () => { for (const e of shown.entries.filter((x) => !x.review)) await api('/api/fb/entries/' + e.id, { method: 'PATCH', body: { review: 'ok' } }); toast('Marked OK'); App.render(); });
  on('fbBad', (b) => {
    const id = idOf(b);
    dialog(`<form class="dform" id="badForm"><h2>What is wrong?</h2><p class="hint">The recruiter sees this note and can fix the entry.</p>
      <div class="chips">${['The link does not open', 'Not a truck driver group', 'Screenshot does not show the comment', 'Same picture as before', 'Wrong person or profile'].map((x) => `<button type="button" class="chip" data-v="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      <label class="fld">Note<textarea name="note" rows="3" maxlength="500" required></textarea></label><p class="err" role="alert"></p>
      <div class="drow"><button class="btn primary">Save</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
      d.querySelectorAll('.chip').forEach((c) => { c.onclick = () => { d.querySelector('[name=note]').value = c.dataset.v; }; });
      $('#badForm', d).onsubmit = async (e) => { e.preventDefault(); try { await api('/api/fb/entries/' + id, { method: 'PATCH', body: { review: 'problem', reviewNote: e.target.note.value } }); d.close(); toast('Marked as a problem'); App.render(); } catch (err) { $('#badForm .err', d).textContent = err.message; } };
    });
  });
  on('fbDel', async (b) => { if (!confirm('Remove this entry?')) return; await api('/api/fb/entries/' + idOf(b), { method: 'DELETE' }); toast('Removed'); App.render(); });
  on('fbLead', async (b) => {
    const e = entryOf(b); let name = e.personName;
    if (!name) { name = prompt("The driver's name:"); if (!name) return; }
    const r = await api(`/api/fb/entries/${e.id}/lead`, { method: 'POST', body: { name } });
    toast(r.existing ? 'Already in the leads' : 'Added to the leads'); App.go('#/driver/' + r.id);
  });
  on('fbEdit', (b) => {
    const e = entryOf(b);
    dialog(`<div class="dform"><h2>Edit the ${KINDS.find((x) => x.k === e.kind).one}</h2>${e.review === 'problem' ? `<p class="rvnote"><b>Admin:</b> ${esc(e.reviewNote || '')}</p>` : ''}${form(e.kind, shown.groups)}
      <div class="drow"><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></div>`, (d) => {
      const f = d.querySelector('.fbform'); wirePicture(f);
      const set = (n, v) => { const el = f.querySelector(`[name=${n}]`); if (el && v !== undefined && v !== null) el.value = v; };
      set('link', e.link); set('groupName', e.groupName); set('groupLink', e.groupLink); set('personName', e.personName); set('note', e.note); set('outcome', e.outcome);
      set('otr', e.answers.otr || ''); set('cdlA', e.answers.cdlA || ''); set('phone', e.answers.phone); set('imageId', e.imageId || '');
      if (e.imageId) f.querySelector('.drop span').textContent = 'The saved picture stays. Drop or paste a new one to change it.';
      f.querySelector('button.primary').textContent = 'Save changes';
      f.onsubmit = async (ev) => { ev.preventDefault(); const body = Object.fromEntries(new FormData(f)); body.imageId = body.imageId ? +body.imageId : e.imageId;
        try { await api('/api/fb/entries/' + e.id, { method: 'PATCH', body }); d.close(); toast('Saved'); App.render(); } catch (err) { f.querySelector('.err').textContent = err.message; } };
    });
  });

  App.route(/^#\/facebook$/, viewFb);
})();
