// The knowledge base: what the team knows, learned from the driver and dispatch groups and added here.
// Browse by topic, search everything (with the team's words, shops & services, road case playbooks), approve what the
// bot learned, fix answers that disagree, merge duplicates. Dispatchers read it. A printable handbook for new people.
(() => {
  const { $, esc, view, S, api, toast, fail, on, onChange, header, dialog, plural, when, dateText } = App;
  let data = null, words = '', found = null, topic = '', kind = '', show = 'use';
  const day = (d) => (d ? dateText(String(d).slice(0, 10), { month: 'short', day: 'numeric' }) : '');
  const sourceText = (x) => (x.source === 'added' ? `Added by ${esc(x.added_by || 'the team')}` : x.source === 'learned' ? `Answered by ${esc(x.added_by || 'the team')}` : esc(x.added_by || 'Learned from the groups'));
  const groupsText = (x) => { const g = (x.groups || []).filter(Boolean); return g.length ? `${g.slice(0, 3).map(esc).join(', ')}${g.length > 3 ? ` and ${g.length - 3} more` : ''}` : ''; };
  // how sure: the number of different groups where it came up (5 marks, like mile markers)
  const marks = (x) => { const n = Math.max(1, +x.ngroups || 0); return `<span class="kbm" title="Came up ${plural(x.seen || 1, 'time')} in ${plural(n, 'group')}" aria-label="Came up in ${plural(n, 'group')}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`; };
  const Q = { general: ['Question', 'Answer'], accounting: ['Question', 'Answer'], dispatch: ['When', 'Do'], site: ['Place', 'Fact'] };

  function entry(x) {
    const [ql, al] = Q[x.kind] || Q.general; const vs = x.variants || [];
    const state = x.conflict_note ? '<span class="kbs warn">Answers disagree</span>' : x.active ? '' : x.review ? '<span class="kbs new">New, not used yet</span>' : '<span class="kbs off">Turned off</span>';
    const tools = data.canEdit ? `<div class="kbact">${x.active ? `<button class="linkbtn" data-act="kbOff">Turn off</button>` : `<button class="btn primary sm" data-act="kbOn">${x.review ? 'Approve' : 'Turn on'}</button>`}
        <button class="linkbtn" data-act="kbEdit">Edit</button><button class="linkbtn" data-act="kbMerge">Same as…</button>${data.admin ? '<button class="linkbtn danger" data-act="kbDel">Delete</button>' : ''}</div>` : '';
    return `<article class="kbe ${x.active ? '' : 'idle'}" data-kb="${x.id}">
      <div class="kbq"><span class="kbl">${ql}</span><span><b>${esc(x.question)}</b>${x.kind === 'site' && (x.city || x.state) ? ` <span class="small mut">${esc([x.city, x.state].filter(Boolean).join(', '))}</span>` : ''}${state}</span></div>
      <div class="kba"><span class="kbl">${al}</span><span>${esc(x.answer)}</span></div>
      ${x.conflict_note ? `<p class="kbwarn">${esc(x.conflict_note)}${data.canEdit ? ' <button class="linkbtn" data-act="kbResolved">It is right now</button>' : ''}</p>` : ''}
      ${vs.length ? `<details class="kbv"><summary>${plural(vs.length, 'other way', 'other ways')} the team said it</summary><ul>${vs.map((v, i) => `<li data-v="${i}"><span>${esc(v.answer)}</span>${v.by || v.at ? ` <span class="small mut">${esc([v.by, day(v.at)].filter(Boolean).join(', '))}</span>` : ''}${data.canEdit ? ` <button class="linkbtn" data-act="kbUseV">Use this one</button> <button class="linkbtn mutd" data-act="kbDropV">Remove</button>` : ''}</li>`).join('')}</ul></details>` : ''}
      <footer>${marks(x)}<span class="small mut">${x.seen > 1 ? `Came up ${plural(x.seen, 'time')}` : 'Came up once'}${groupsText(x) ? ` · ${groupsText(x)}` : ''} · last ${esc(day(x.last_seen))} · ${sourceText(x)}${x.approved_by && x.active ? `, approved by ${esc(x.approved_by)}` : ''}${x.uses ? ` · the bot used it ${plural(x.uses, 'time')}` : ''}</span>${tools}</footer></article>`;
  }

  function filtered() {
    const all = data.entries;
    return all.filter((x) => (!kind || x.kind === kind || (kind === 'general' && x.kind === 'accounting'))
      && (show === 'use' ? x.active : show === 'review' ? !x.active && x.review : show === 'conflict' ? !!x.conflict_note : !x.active && !x.review));
  }

  async function viewKb() {
    const live = App.drawing(); data = await api('/api/kb'); if (!live()) return;
    document.title = 'Knowledge base · FleetHire';
    const all = data.entries, T = data.topics;
    const nReview = all.filter((x) => !x.active && x.review).length, nConf = all.filter((x) => x.conflict_note).length, nOff = all.filter((x) => !x.active && !x.review).length;
    if (!data.canEdit) show = 'use';
    const base = filtered();
    const byTopic = {}; for (const x of base) (byTopic[x.topic || 'other'] = byTopic[x.topic || 'other'] || []).push(x);
    const order = Object.keys(T).filter((k) => byTopic[k]);
    const shown = topic ? order.filter((k) => k === topic) : order;
    const kinds = [['', 'Everything'], ['general', 'Answers for drivers'], ['dispatch', 'How we dispatch'], ['site', 'Places & roads']];
    const section = (k) => {
      const list = byTopic[k];
      // places & roads: one block per place
      const sites = list.filter((x) => x.kind === 'site'), rest = list.filter((x) => x.kind !== 'site');
      const byPlace = {}; for (const x of sites) (byPlace[x.place_key || x.question] = byPlace[x.place_key || x.question] || []).push(x);
      return `<section class="kbt" id="kbt-${k}"><h2>${esc(T[k])} <span class="cnt">${list.length}</span></h2>${rest.map(entry).join('')}
        ${Object.values(byPlace).map((g) => (g.length > 1 ? `<div class="kbplace"><h3>${esc(g[0].question)}${g[0].city || g[0].state ? ` <span class="small mut">${esc([g[0].city, g[0].state].filter(Boolean).join(', '))}</span>` : ''}</h3>${g.map(entry).join('')}</div>` : entry(g[0]))).join('')}</section>`;
    };
    const results = found ? `<section class="card kbres"><h2>${found.length ? `${plural(found.length, 'result')} for "${esc(words)}"` : `Nothing for "${esc(words)}"`}</h2>
      ${found.length ? `<ul>${found.map((r) => `<li class="kbr t-${r.type}"><span class="kbty">${{ kb: (data.kinds[r.kind] || 'Knowledge'), term: 'Team word', place: 'Shops & services', playbook: 'Road case playbook' }[r.type]}</span>
        ${r.type === 'kb' ? `<a href="#/kb" data-act="kbGo" data-id="${r.id}" data-topic="${esc(r.topic || '')}"><b>${esc(r.title)}</b></a>` : r.type === 'place' ? `<a href="#/places"><b>${esc(r.title)}</b></a>` : r.type === 'playbook' ? `<a href="#/playbook"><b>${esc(r.title)}</b></a>` : `<b>${esc(r.title)}</b>`}${r.type === 'kb' && !r.active ? ' <span class="kbs new">not used yet</span>' : ''}
        <div>${esc(r.text || '')}</div></li>`).join('')}</ul>` : '<p class="hint">The bot keeps learning from the groups. If you know the answer, add it.</p>'}</section>` : '';
    view.innerHTML = header('kb') + `<main class="kbpage">${App.pageHead('Knowledge base', 'What the team knows, learned from the driver and dispatch groups and added here. The bot answers drivers with the approved answers, and new dispatchers learn how we work. The more groups say the same thing, the surer it is.',
      `${data.canEdit ? `<button class="btn primary lg" data-act="kbAdd">${App.plus} Add</button>` : ''}<a class="btn plain lg" href="#/kb/handbook">Handbook</a>`)}
      <div class="kbsearch"><input type="search" id="kbFind" placeholder="Search everything: Kearny parking, pay day, DPF, 34 reset, didn't catch…" value="${esc(words)}" aria-label="Search the knowledge base"></div>
      ${results}
      <div class="pagebar">${data.canEdit ? `<div class="seg" role="group" aria-label="Show">${[['use', 'In use', all.filter((x) => x.active).length], ['review', 'To approve', nReview], ['conflict', 'Disagree', nConf], ['off', 'Turned off', nOff]].filter(([k, , n]) => n || k === 'use' || k === show)
        .map(([k, l, n]) => `<button data-act="kbShow" data-k="${k}" class="${show === k ? 'on' : ''}">${l} ${n}</button>`).join('')}</div>` : ''}
        <div class="seg" role="group" aria-label="Kind">${kinds.map(([k, l]) => `<button data-act="kbKind" data-k="${k}" class="${kind === k ? 'on' : ''}">${l}</button>`).join('')}</div><span class="grow"></span></div>
      <div class="kbgrid"><div class="kbleft"><nav class="kbnav" aria-label="Topics"><button data-act="kbTopic" data-k="" class="${topic ? '' : 'on'}">All topics <span>${base.length}</span></button>
          ${order.map((k) => `<button data-act="kbTopic" data-k="${k}" class="${topic === k ? 'on' : ''}">${esc(T[k])} <span>${byTopic[k].length}</span></button>`).join('')}</nav>
          <div class="kbside"><div class="kbmore"><b>Also what the team knows</b><a href="#/places">Shops & services <span>${data.more.places}</span></a><a href="#/playbook">Road case playbooks <span>${data.more.playbooks}</span></a>${S.me.role === 'admin' ? `<a href="#/telegram?tab=desk">Team words <span>${data.more.terms}</span></a>` : `<span class="kbml">Team words <span>${data.more.terms}</span></span>`}</div>
          ${data.admin ? `<div class="kbmore"><label class="chk"><input type="checkbox" data-ch="kbAuto" ${data.auto ? 'checked' : ''}> Approve by itself when ${data.autoGroups} different groups say the same thing</label>
            ${data.untidied ? `<p class="small mut">${plural(data.untidied, 'new entry', 'new entries')} wait for the AI tidy (wording, topic, duplicates), every 6 hours. <button class="linkbtn" data-act="kbTidy">Tidy now</button></p>` : ''}</div>` : ''}
          <p class="small mut kbtip">In Telegram, message the bot <b>/kb</b> and a few words to search this from the road.</p></div></div>
        <div class="kbmain">${shown.length ? shown.map(section).join('') : `<section class="card"><p class="hint">${show === 'review' ? 'Nothing to approve.' : show === 'conflict' ? 'No answers disagree.' : all.length ? 'Nothing here with these filters.' : 'Nothing yet. The bot fills this as it reads the groups: answers the team gives drivers, how dispatchers handle things, and facts about sites and roads.'}</p></section>`}</div></div></main>`;
  }

  // ---------- the handbook: everything approved, by kind and topic, ready to print or save as PDF ----------
  async function viewHandbook() {
    const live = App.drawing(); const d = await api('/api/kb'); if (!live()) return;
    document.title = 'Handbook · FleetHire';
    const use = d.entries.filter((x) => x.active), T = d.topics;
    const part = (title, intro, list, [ql, al]) => {
      if (!list.length) return '';
      const byT = {}; for (const x of list) (byT[x.topic || 'other'] = byT[x.topic || 'other'] || []).push(x);
      return `<section class="hbpart"><h2>${title}</h2><p class="hint">${intro}</p>${Object.keys(T).filter((k) => byT[k]).map((k) => `<h3>${esc(T[k])}</h3><dl>${byT[k].map((x) => `<dt>${ql ? `<span class="kbl">${ql}</span>` : ''}${esc(x.question)}${x.kind === 'site' && (x.city || x.state) ? `, ${esc([x.city, x.state].filter(Boolean).join(', '))}` : ''}</dt><dd>${al ? `<span class="kbl">${al}</span>` : ''}${esc(x.answer)}</dd>`).join('')}</dl>`).join('')}</section>`;
    };
    view.innerHTML = header('kb') + `<main class="handbook"><a class="back noprint" href="#/kb">← Knowledge base</a>
      <div class="phead"><div><h1>Team handbook</h1><p>Everything the team approved in the knowledge base, ${esc(dateText(App.today(), { month: 'long', day: 'numeric', year: 'numeric' }))}. For new dispatchers and recruiters.</p></div><div class="pacts noprint"><button class="btn primary lg" data-act="kbPrint">Print or save as PDF</button></div></div>
      ${part('How we dispatch', 'What our dispatchers do in each situation.', use.filter((x) => x.kind === 'dispatch'), ['When', 'Do'])}
      ${part('Places & roads', 'Sites, yards, parking and roads: what to know before going there.', use.filter((x) => x.kind === 'site'), ['', ''])}
      ${part('Answers for drivers', 'What drivers ask, and what we answer.', use.filter((x) => x.kind === 'general' || x.kind === 'accounting'), ['Q', 'A'])}
      ${use.length ? '' : '<section class="card"><p class="hint">Nothing approved yet.</p></section>'}</main>`;
  }

  // ---------- actions ----------
  const byId = (b) => data.entries.find((x) => x.id === +b.closest('[data-kb]').dataset.kb);
  const patch = async (b, body, msg) => { try { await api('/api/kb/' + byId(b).id, { method: 'PATCH', body }); if (msg) toast(msg); viewKb(); } catch (e) { fail(e); } };
  on('kbShow', (b) => { show = b.dataset.k; topic = ''; viewKb(); });
  on('kbKind', (b) => { kind = b.dataset.k; topic = ''; viewKb(); });
  on('kbTopic', (b) => { topic = b.dataset.k; viewKb().then(() => window.scrollTo(0, 0)); });
  on('kbOn', (b) => patch(b, { active: true }, 'Approved: the bot uses it now'));
  on('kbOff', (b) => patch(b, { active: false }, 'Turned off'));
  on('kbResolved', (b) => patch(b, { resolved: true }));
  on('kbUseV', (b) => patch(b, { useVariant: +b.closest('[data-v]').dataset.v }, 'Answer changed'));
  on('kbDropV', (b) => patch(b, { dropVariant: +b.closest('[data-v]').dataset.v }));
  on('kbDel', async (b) => { if (!confirm('Delete this for good?')) return; try { await api('/api/kb/' + byId(b).id, { method: 'DELETE' }); viewKb(); } catch (e) { fail(e); } });
  on('kbPrint', () => window.print());
  on('kbTidy', async (b) => { b.disabled = true; b.textContent = 'Tidying…'; try { const r = await api('/api/kb/tidy', { method: 'POST' }); toast(`Tidied ${r.tidied || 0}${r.merged ? `, merged ${r.merged}` : ''}${r.conflicts ? `, ${r.conflicts} disagree` : ''}`); viewKb(); } catch (e) { fail(e); b.disabled = false; b.textContent = 'Tidy now'; } });
  on('kbGo', (b, e) => { e.preventDefault(); const x = data.entries.find((y) => y.id === +b.dataset.id); if (x) { show = x.conflict_note ? 'conflict' : x.active ? 'use' : x.review ? 'review' : 'off'; kind = ''; topic = x.topic || ''; } words = ''; found = null;
    viewKb().then(() => { const el = document.querySelector(`[data-kb="${b.dataset.id}"]`); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); } }); });
  onChange('kbAuto', async (el) => { try { await api('/api/kb/settings', { method: 'PUT', body: { auto: el.checked } }); toast('Saved'); } catch (e) { fail(e); } });
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'kbFind') return; words = e.target.value.trim();
    clearTimeout(viewKb.t); viewKb.t = setTimeout(async () => {
      found = words.length >= 2 ? (await api('/api/kb/search?q=' + encodeURIComponent(words)).catch(() => ({ results: [] }))).results : null;
      await viewKb(); const i = document.getElementById('kbFind'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
    }, 300);
  });
  function form(x) {
    const k = x ? x.kind : kind || 'general'; const T = data.topics;
    dialog(`<form id="kbForm" class="dform wide"><h2>${x ? 'Edit' : 'Add to the knowledge base'}</h2>
      ${x ? '' : `<label class="fld">What is it<select name="kind" id="kbKindSel">${Object.entries(data.kinds).map(([v, l]) => `<option value="${v}" ${v === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`}
      <label class="fld"><span id="kbQl">${(Q[k] || Q.general)[0]}</span><input name="question" required maxlength="600" value="${esc(x ? x.question : '')}" placeholder="${k === 'site' ? 'KRB1, Amazon Hazleton, Chambersburg drop yard…' : k === 'dispatch' ? 'The driver says he will be late to the delivery' : 'When is pay day?'}"></label>
      <label class="fld"><span id="kbAl">${(Q[k] || Q.general)[1]}</span><textarea name="answer" rows="3" required maxlength="1500">${esc(x ? x.answer : '')}</textarea></label>
      <div class="frow"><label class="fld">Topic<select name="topic"><option value="">Let the AI choose</option>${Object.entries(T).map(([v, l]) => `<option value="${v}" ${x && x.topic === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        ${x ? '' : '<label class="fld">City (places)<input name="city" maxlength="60"></label><label class="fld">State<input name="state" maxlength="2" size="2"></label>'}</div>
      <p class="err" id="kbErr" role="alert"></p><div class="drow"><button class="btn primary">${x ? 'Save' : 'Add'}</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
      const sel = $('#kbKindSel', d); if (sel) sel.onchange = () => { const [a, b] = Q[sel.value] || Q.general; $('#kbQl', d).textContent = a; $('#kbAl', d).textContent = b; };
      $('#kbForm', d).onsubmit = async (e) => { e.preventDefault(); const body = Object.fromEntries(new FormData(e.target)); if (!body.topic) delete body.topic;
        try { await api(x ? '/api/kb/' + x.id : '/api/kb', { method: x ? 'PATCH' : 'POST', body }); d.close(); toast(x ? 'Saved' : 'Added: the bot uses it now'); viewKb(); } catch (er) { $('#kbErr').textContent = er.message; } };
    });
  }
  on('kbAdd', () => form(null));
  on('kbEdit', (b) => form(byId(b)));
  on('kbMerge', (b) => {
    const x = byId(b); const same = data.entries.filter((y) => y.id !== x.id && y.kind === x.kind);
    const close = same.map((y) => ({ y, s: overlap(x, y) })).sort((a, c) => c.s - a.s).slice(0, 30);
    dialog(`<form id="kbMergeForm" class="dform wide"><h2>Same as…</h2><p class="hint">Pick the entry that says the same thing. This one goes into it: the counts and groups add up, and its answer is kept as another way the team said it.</p>
      <p><b>${esc(x.question)}</b><br><span class="small">${esc(x.answer)}</span></p>
      <label class="fld">Merge into<select name="into" required>${close.map(({ y }) => `<option value="${y.id}">${esc(y.question.slice(0, 90))} — ${esc(y.answer.slice(0, 60))}</option>`).join('')}</select></label>
      <p class="err" id="kbmErr" role="alert"></p><div class="drow"><button class="btn primary"${close.length ? '' : ' disabled'}>Merge</button><button type="button" class="btn plain" data-act="closeDialog">Cancel</button></div></form>`, (d) => {
      $('#kbMergeForm', d).onsubmit = async (e) => { e.preventDefault(); try { await api(`/api/kb/${x.id}/merge`, { method: 'POST', body: { into: +e.target.into.value } }); d.close(); toast('Merged'); viewKb(); } catch (er) { $('#kbmErr').textContent = er.message; } };
    });
  });
  const wordsOf = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  function overlap(a, b) { const x = wordsOf(a.question + ' ' + a.answer), y = wordsOf(b.question + ' ' + b.answer); let n = 0; for (const w of x) if (y.has(w)) n++; return n / Math.max(1, x.size + y.size - n); }

  App.route(/^#\/kb$/, () => { if (!words) found = null; return viewKb(); });
  App.route(/^#\/kb\/handbook$/, viewHandbook);
})();
