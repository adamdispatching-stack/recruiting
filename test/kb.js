// Test of the knowledge base: learning from several groups (the same answer counts up, approved by itself at 3 groups,
// other wordings kept), site notes, the AI tidy (duplicates, disagreements), search, /kb in Telegram, the bot reading
// only the entries that fit, dispatchers read-only, the page and the handbook.
//   node test/kb.js
const http = require('http');
const { execSync } = require('child_process');
const BASE = 'http://localhost:3999';
const DB = 'postgresql://postgres@localhost:5433/recruiting_test?host=/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

// ---------- fake Telegram ----------
const tg = { updates: [], nextUpdate: 1, sent: [], nextMsg: 1000 };
const BOT = { id: 999, is_bot: true, first_name: 'FleetHire', username: 'fleethire_test_bot' };
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const out = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
    const p = JSON.parse(body || '{}'); const method = req.url.split('/').pop();
    if (method === 'getMe') return out(BOT);
    if (method === 'getUpdates') { for (let i = 0; i < 10 && !tg.updates.some((u) => u.update_id >= (p.offset || 0)); i++) await sleep(100); return out(tg.updates.filter((u) => u.update_id >= (p.offset || 0))); }
    if (method === 'sendMessage') { const m = { message_id: ++tg.nextMsg, date: Math.floor(Date.now() / 1000), chat: { id: p.chat_id }, text: p.text }; tg.sent.push({ ...p, message_id: m.message_id }); return out(m); }
    if (method === 'getChatMember') return out({ status: 'administrator', user: BOT });
    return out(true);
  });
}).listen(4999);
// ---------- fake AI ----------
const AI = { replySystems: [], tidyCalls: 0, tidyText: '' };
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body); const tool = (j.tools || [])[0] && j.tools[0].name;
    const text = j.messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'))).join('\n');
    const system = (Array.isArray(j.system) ? j.system.map((b) => b.text).join('\n') : j.system || '');
    let input;
    if (tool === 'group_digest') {
      const fresh = text.split('NEW MESSAGES:')[1] || '';
      input = { truck_events: [], driver_notes: [], alerts: [], learned: [], site_notes: [] };
      if (/We pay every Friday, direct deposit/.test(fresh)) input.learned.push({ question: 'When is pay day?', answer: 'Every Friday, by direct deposit.', topic: 'pay' });
      if (/Friday is pay day for everybody/.test(fresh)) input.learned.push({ question: 'When is payday?', answer: 'Every Friday by direct deposit.', topic: 'pay' });
      if (/Fridays, the money comes Friday morning/.test(fresh)) input.learned.push({ question: 'When is pay day?', answer: 'Pay day is Friday; the money is in the bank Friday morning.', topic: 'pay' });
      if (/KRB1 use gate 3/.test(fresh)) input.site_notes.push({ place: 'KRB1', city: 'Kearny', state: 'NJ', fact: 'Check in at gate 3; wait on the right shoulder, not on the street.', topic: 'sites' });
      if (/Love's card only/.test(fresh)) input.learned.push({ question: 'Where can I fuel?', answer: "Only at Love's with the company fuel card.", topic: 'fuel' });
      if (/fuel at Pilot too/.test(fresh)) input.learned.push({ question: 'Which truck stops can I use for fuel?', answer: 'Pilot and Flying J with the company card.', topic: 'fuel' });
    } else if (tool === 'reply_plan') {
      AI.replySystems.push(system + '\n' + text);
      const knows = /Every Friday/.test(system + text);
      input = knows ? { is_question: true, confident: true, answer: 'Every Friday, by direct deposit.', progress: 'none', mood: 'good' } : { is_question: true, confident: false, answer: '', progress: 'none', mood: 'neutral' };
    } else if (tool === 'kb_tidy') {
      AI.tidyCalls++; AI.tidyText = text;
      const ids = [...text.split('OTHER ENTRIES')[0].matchAll(/\[(\d+)\] \((\w+)[^)]*\) Q: ([^|]*)\| A: ([^|\n]*)/g)].map((m) => ({ id: +m[1], kind: m[2], q: m[3].trim(), a: m[4].trim() }));
      const fuelA = ids.find((x) => /Where can I fuel/.test(x.q)), fuelB = ids.find((x) => /Which truck stops/.test(x.q));
      input = { items: ids.map((x) => ({ id: x.id, topic: x.kind === 'site' ? 'sites' : /fuel|stops/i.test(x.q) ? 'fuel' : 'pay',
        question: /pay/i.test(x.q) ? 'When is pay day?' : '', answer: '',
        duplicate_of: fuelB && x.id === fuelB.id && fuelA ? fuelA.id : 0,
        conflict: fuelA && x.id === fuelA.id ? 'One group says only Love\'s, another says Pilot and Flying J.' : '' })) };
    } else input = { summary: 'A day.', issues: [], mood: 'good' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input }] }));
  });
}).listen(4998);

const push = (u) => { u.update_id = tg.nextUpdate++; tg.updates.push(u); };
const RITA = { id: 11, is_bot: false, first_name: 'Rita', last_name: 'Recruiter', username: 'rita_r' };
const D = [['Ann Able', 201], ['Ben Brown', 202], ['Cal Cole', 203], ['Dee Dunn', 204]];
const CH = D.map(([n], i) => ({ id: -100700 - i, type: 'supergroup', title: 'Onboarding ' + n }));
const DRV = D.map(([n, id]) => ({ id, is_bot: false, first_name: n.split(' ')[0], last_name: n.split(' ')[1] }));
let mid = 1;
const say = (from, chat, text) => push({ message: { message_id: mid++, from, chat, date: Math.floor(Date.now() / 1000), text } });
const priv = (from, text) => push({ message: { message_id: mid++, from, chat: { id: from.id, type: 'private', first_name: from.first_name }, date: Math.floor(Date.now() / 1000), text } });
async function until(f, ms = 10000, what = '') { for (let i = 0; i < ms / 100; i++) { const v = await f(); if (v) return v; await sleep(100); } console.log('   (timed out waiting for ' + what + ')'); return null; }

(async () => {
  execSync(`pkill -f "node src/serve[r].js" || true; sleep 0.4; su postgres -c "psql -q -h /tmp -p 5433 -c 'DROP DATABASE IF EXISTS recruiting_test' -c 'CREATE DATABASE recruiting_test'"`, { stdio: 'ignore' });
  const env = { ...process.env, DATABASE_URL: DB, PGSSL: 'off', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-password-123', PORT: '3999', KB_TIDY_MS: '3600000',
    TELEGRAM_BOT_TOKEN: '999:test', TG_API_BASE: 'http://localhost:4999', TG_POLL_SECONDS: '1', TG_TICK_MS: '1000', TG_NO_QUIET: '1', TG_DIGEST_MS: '1000', TG_DIGEST_SETTLE_MIN: '0.03', TG_PROFILE_MS: '600000', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4998' };
  require('child_process').spawn('node', ['src/server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', require('fs').openSync('/tmp/server.log', 'w'), require('fs').openSync('/tmp/server.log', 'a')], detached: true }).unref();
  let cookie = '';
  const web = async (path, opts = {}) => { const r = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: opts.cookie || cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc && !opts.cookie) cookie = sc.split(';')[0]; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch (e) { return { status: r.status, text: t }; } };
  await until(async () => { try { return (await fetch(BASE + '/healthz')).ok; } catch (e) { return false; } }, 15000, 'server');
  await web('/api/login', { method: 'POST', body: { email: 'admin@example.com', password: 'test-password-123' } });
  await until(async () => { const s = await web('/api/tg/status'); return s.running && s.bot; }, 10000, 'bot');
  const { Client } = require('pg'); const pg = new Client({ connectionString: DB }); await pg.connect();
  const rita = (await web('/api/users', { method: 'POST', body: { name: 'Rita Recruiter', email: 'rita@example.com', password: 'rita-pass-1234' } })).id;
  const ids = [];
  for (const [n] of D) { const id = (await web('/api/drivers', { method: 'POST', body: { name: n, source: 'Indeed', phone: '21555501' + (10 + ids.length), ownerId: rita } })).id; await web('/api/drivers/' + id, { method: 'PATCH', body: { status: 'Onboarding' } }); ids.push(id); }
  const me = await web('/api/tg/me-code', { method: 'POST', body: {} });
  priv(RITA, '/me ' + me.code);
  await until(() => tg.sent.some((m) => /Connected: you are/.test(m.text)), 8000, 'connect');
  for (let i = 0; i < CH.length; i++) { say(RITA, CH[i], '/register'); await until(async () => ((await pg.query(`SELECT driver_id FROM tg_chats WHERE chat_id = $1`, [CH[i].id])).rows[0] || {}).driver_id === ids[i], 8000, 'register ' + i); }
  const kbOf = async () => (await web('/api/kb')).entries;

  // ---------- the same answer in three groups ----------
  say(DRV[0], CH[0], 'When is payday?'); say(RITA, CH[0], 'We pay every Friday, direct deposit');
  const e1 = await until(async () => (await kbOf()).find((x) => x.kind === 'general' && /pay day/i.test(x.question)), 15000, 'first entry');
  ok(e1 && !e1.active && e1.review && e1.topic === 'pay' && e1.seen === 1 && e1.ngroups === 1, 'learned in one group: new, waiting for approval, topic Pay, came up once');
  say(DRV[1], CH[1], 'payday?'); say(RITA, CH[1], 'Friday is pay day for everybody');
  const e2 = await until(async () => { const x = (await kbOf()).find((y) => y.id === e1.id); return x && x.seen === 2 ? x : null; }, 15000, 'second group');
  ok(e2 && (await kbOf()).filter((x) => x.kind === 'general' && /pa(y|id)/i.test(x.question)).length === 1 && e2.ngroups === 2 && !e2.active, 'a second group says it: the same entry, came up twice in 2 groups (no duplicate)');
  ok(e2 && (e2.groups || []).length === 2 && e2.groups.includes('Ann Able') && e2.groups.includes('Ben Brown'), 'which groups it came from: Ann Able, Ben Brown');
  say(DRV[2], CH[2], 'when do we get paid'); say(RITA, CH[2], 'Fridays, the money comes Friday morning');
  const e3 = await until(async () => { const x = (await kbOf()).find((y) => y.id === e1.id); return x && x.seen === 3 ? x : null; }, 15000, 'third group');
  ok(e3 && e3.ngroups === 3 && (e3.variants || []).some((v) => /Friday morning/.test(v.answer)), 'the third group worded it differently: kept as another way the team said it');
  ok(e3 && !e3.active, 'a different wording does not approve it by itself');
  // the fourth group says it the usual way: 3+ groups agree → approved by itself
  say(DRV[3], CH[3], 'payday?'); say(RITA, CH[3], 'Friday is pay day for everybody');
  const e4 = await until(async () => { const x = (await kbOf()).find((y) => y.id === e1.id); return x && x.seen === 4 ? x : null; }, 15000, 'fourth group');
  ok(e4 && e4.active && !e4.review && /3\+ groups/.test(e4.approved_by || ''), 'came up the same way in 4 groups: approved by itself (the bot uses it now)');

  // ---------- site notes ----------
  say(RITA, CH[0], 'At KRB1 use gate 3 and wait on the right shoulder');
  const site = await until(async () => (await kbOf()).find((x) => x.kind === 'site'), 15000, 'site');
  ok(site && site.question === 'KRB1' && site.city === 'Kearny' && site.state === 'NJ' && /gate 3/.test(site.answer) && site.topic === 'sites', 'a fact about a site: KRB1, Kearny NJ, "check in at gate 3", topic Sites & facilities');
  say(RITA, CH[1], 'Reminder: KRB1 use gate 3 and wait on the right shoulder');
  ok(await until(async () => { const x = (await kbOf()).find((y) => y.id === (site || {}).id); return x && x.seen === 2; }, 15000, 'site again'), 'the same site fact from another group: came up twice, no duplicate');

  // ---------- the bot reads what fits ----------
  await pg.query(`UPDATE onb_cases SET mode = 'assist'`).catch(() => {});
  await pg.query(`UPDATE tg_chats SET bot_mode = 'assist'`).catch(() => {});
  await web('/api/kb/' + site.id, { method: 'PATCH', body: { active: true } });
  await pg.query(`UPDATE tg_messages SET at = at - interval '1 hour' WHERE chat_id = $1`, [CH[0].id]); // nobody from the team is talking with the driver right now
  let n = tg.sent.length; const rs = AI.replySystems.length;
  say(DRV[0], CH[0], 'Hey when is pay day this week?');
  await until(() => AI.replySystems.length > rs, 10000, 'reply plan');
  const sys = AI.replySystems[AI.replySystems.length - 1] || '';
  ok(/Every Friday/.test(sys) && /About KRB1/.test(sys), 'the bot answering a driver reads the approved pay answer (and places & roads)');
  ok(await until(() => tg.sent.slice(n).some((m) => String(m.chat_id) === String(CH[0].id) && /Every Friday/.test(m.text)), 8000, 'answer'), 'and answers the driver with it');
  ok(await until(async () => ((await kbOf()).find((y) => y.id === e1.id) || {}).uses >= 1, 5000), 'the entry counts the bot using it');

  // ---------- disagreements and duplicates: the AI tidy ----------
  say(RITA, CH[2], "Love's card only for fuel"); say(RITA, CH[3], 'You can fuel at Pilot too with the card');
  await until(async () => (await kbOf()).filter((x) => x.topic === 'fuel' || /fuel/i.test(x.question)).length >= 2, 15000, 'fuel entries');
  const before = (await kbOf()).length;
  const t = await web('/api/kb/tidy', { method: 'POST' });
  ok(t.status === 200 && AI.tidyCalls === 1 && t.tidied >= 1, `Tidy now: one AI call (${t.tidied} tidied, ${t.merged} merged, ${t.conflicts} disagree)`);
  const after = await kbOf();
  const fuel = after.find((x) => /Where can I fuel/.test(x.question));
  ok(after.length === before - 1 && fuel && fuel.seen === 2 && (fuel.variants || []).some((v) => /Pilot/.test(v.answer)), 'the AI found a duplicate: merged (counts add up, the other answer kept)');
  ok(fuel && /only Love's, another says Pilot/.test(fuel.conflict_note || ''), 'and flagged that the answers disagree');
  ok(after.every((x) => x.tidied), 'everything tidied: nothing waits');
  // fix it: use the other answer, mark it right
  const vi = fuel.variants.findIndex((v) => /Pilot/.test(v.answer));
  await web('/api/kb/' + fuel.id, { method: 'PATCH', body: { useVariant: vi } });
  await web('/api/kb/' + fuel.id, { method: 'PATCH', body: { resolved: true, active: true } });
  const fixed = (await kbOf()).find((x) => x.id === fuel.id);
  ok(fixed && /Pilot/.test(fixed.answer) && !fixed.conflict_note && fixed.active && fixed.variants.some((v) => /Love's/.test(v.answer)) && fixed.locked, 'picked the right answer: in use, the old one kept, locked from AI rewording');
  // a person's edit is not reworded by the tidy
  await pg.query(`UPDATE tg_knowledge SET tidied = false WHERE id = $1`, [fixed.id]);
  await web('/api/kb/tidy', { method: 'POST' });
  ok(/\[\d+\] \(general, LOCKED\) Q: Where can I fuel/.test(AI.tidyText), 'edited by a person: sent to the tidy as LOCKED');

  // ---------- add, search, /kb in Telegram ----------
  const add = await web('/api/kb', { method: 'POST', body: { kind: 'dispatch', question: 'The driver says he will be late to the delivery', answer: 'Ask for the new ETA right away and update the broker.' } });
  const added = (await kbOf()).find((x) => x.id === add.id);
  ok(added && added.active && added.topic === 'delivery' && added.source === 'added', 'added on the website: in use right away, topic guessed (Pickup & delivery)');
  await pg.query(`INSERT INTO places (name, kind, services, city, state) VALUES ('Kearny Truck Repair', 'shop', '{DPF cleaning}', 'Kearny', 'NJ')`);
  await pg.query(`INSERT INTO tg_terms (term, meaning) VALUES ('didn''t catch', 'could not book the load offered') ON CONFLICT DO NOTHING`);
  const s1 = await web('/api/kb/search?q=' + encodeURIComponent('kearny'));
  ok(s1.results.some((r) => r.type === 'kb' && r.title === 'KRB1') === false && s1.results.some((r) => r.type === 'place' && /Kearny Truck Repair/.test(r.title)), 'search "kearny": the shop in Shops & services');
  const s2 = await web('/api/kb/search?q=' + encodeURIComponent('gate 3'));
  ok(s2.results.some((r) => r.type === 'kb' && r.title === 'KRB1'), 'search "gate 3": the KRB1 site fact');
  const s3 = await web('/api/kb/search?q=' + encodeURIComponent("didn't catch"));
  ok(s3.results.some((r) => r.type === 'term'), 'search a team word: found in the team words');
  n = tg.sent.length; priv(RITA, '/kb pay day');
  ok(await until(() => tg.sent.slice(n).some((m) => m.chat_id === RITA.id && /📘 <b>When is pay day\?<\/b>/.test(m.text) && /Friday/.test(m.text)), 8000, '/kb'), '/kb pay day in Telegram: the answer, no AI');
  n = tg.sent.length; push({ message: { message_id: mid++, from: DRV[0], chat: { id: DRV[0].id, type: 'private', first_name: 'Ann' }, date: Math.floor(Date.now() / 1000), text: '/kb pay' } });
  ok(await until(() => tg.sent.slice(n).some((m) => m.chat_id === DRV[0].id && /for our team/.test(m.text)), 8000), '/kb from a driver: only for the team');

  // ---------- merge by hand, dispatchers read only ----------
  const extra = await web('/api/kb', { method: 'POST', body: { kind: 'general', question: 'Is direct deposit the only way to get paid?', answer: 'Yes, direct deposit only.' } });
  const m = await web(`/api/kb/${extra.id}/merge`, { method: 'POST', body: { into: e1.id } });
  const merged = (await kbOf()).find((x) => x.id === e1.id);
  ok(m.ok && !(await kbOf()).some((x) => x.id === extra.id) && merged.seen === 5 && merged.variants.some((v) => /direct deposit only/.test(v.answer)), 'merged by hand: one entry, counts add up, the other answer kept');
  await web('/api/users', { method: 'POST', body: { name: 'Dan Dispatch', email: 'dan@example.com', password: 'dan-pass-12345', role: 'dispatcher' } });
  let dc = ''; const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dan@example.com', password: 'dan-pass-12345' }) }); dc = (r.headers.get('set-cookie') || '').split(';')[0];
  const dk = await web('/api/kb', { cookie: dc });
  ok(dk.status === 200 && dk.entries.length && dk.entries.every((x) => x.active) && !dk.canEdit, 'a dispatcher reads the knowledge base (only what is in use)');
  const dp = await web('/api/kb/' + e1.id, { method: 'PATCH', body: { active: false }, cookie: dc });
  const da = await web('/api/kb', { method: 'POST', body: { question: 'x?', answer: 'y' }, cookie: dc });
  ok(dp.status === 403 && da.status === 403, 'a dispatcher cannot change it');
  ok((await web('/api/kb/search?q=pay', { cookie: dc })).results.length >= 1, 'a dispatcher can search it');
  // the setting
  await web('/api/kb/settings', { method: 'PUT', body: { auto: false } });
  ok((await web('/api/kb')).auto === false && (await web('/api/settings')).tg.kbAuto === false, 'admin turns off approving by itself');

  // ---------- the old entries (upgrade): get a topic and their group ----------
  await pg.query(`INSERT INTO tg_knowledge (question, answer, chat_id, kind) VALUES ('How do I do a 34 hour reset on the ELD?', 'Go off duty for 34 hours in a row.', $1, 'general')`, [CH[0].id]);
  await pg.query(`UPDATE tg_knowledge SET topic = NULL WHERE question LIKE 'How do I do a 34%'`);
  execSync(`node -e "require('./src/kb').backfill().then(() => process.exit(0))"`, { cwd: __dirname + '/..', env: { ...process.env, DATABASE_URL: DB, PGSSL: 'off' } });
  const old = (await pg.query(`SELECT topic, chats FROM tg_knowledge WHERE question LIKE 'How do I do a 34%'`)).rows[0];
  ok(old.topic === 'eld' && String(old.chats[0]) === String(CH[0].id), 'old entries get a topic (Logs & hours) and their group');

  // ---------- the page and the handbook ----------
  try {
    const { chromium } = require('playwright'); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE + '/'); await p.fill('input[type=email]', 'admin@example.com'); await p.fill('input[type=password]', 'test-password-123'); await p.click('button[type=submit], .btn.primary');
    await p.waitForSelector('.rail, nav', { timeout: 8000 }).catch(() => {});
    await p.goto(BASE + '/#/kb'); await p.waitForSelector('.kbe', { timeout: 8000 });
    ok(await p.$('a[href="#/kb"]') && (await p.textContent('.kbnav')).includes('Pay & settlements') && (await p.$$('.kbe')).length >= 3, 'the page: Knowledge base in the menu, topics on the left, entries');
    ok((await p.textContent('.kbmain')).includes('Came up 5 times'), 'an entry shows how often it came up');
    await p.screenshot({ path: '/tmp/shot/kb.png', fullPage: false });
    await p.fill('#kbFind', 'gate'); await p.waitForSelector('.kbres', { timeout: 5000 });
    ok((await p.textContent('.kbres')).includes('KRB1'), 'searching on the page');
    await p.screenshot({ path: '/tmp/shot/kb-search.png' });
    await p.fill('#kbFind', ''); await sleep(500);
    await p.click('[data-act=kbShow][data-k=review]').catch(() => {}); await sleep(400);
    await p.screenshot({ path: '/tmp/shot/kb-review.png' });
    await p.goto(BASE + '/#/kb/handbook'); await p.waitForSelector('.hbpart', { timeout: 5000 });
    const hb = await p.textContent('.handbook');
    ok(/How we dispatch/.test(hb) && /Places & roads/.test(hb) && /Answers for drivers/.test(hb) && /KRB1/.test(hb), 'the handbook: dispatching, places & roads, answers for drivers');
    await p.screenshot({ path: '/tmp/shot/kb-handbook.png' });
    await p.setViewportSize({ width: 390, height: 840 }); await p.goto(BASE + '/#/kb'); await p.waitForSelector('.kbe'); await p.screenshot({ path: '/tmp/shot/kb-mobile.png' });
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } catch (e) { ok(false, 'page: ' + e.message); }

  await pg.end();
  execSync('pkill -f "node src/serve[r].js" || true');
  process.exit();
})().catch((e) => { console.error(e); execSync('pkill -f "node src/serve[r].js" || true'); process.exit(1); });
