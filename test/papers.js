// CDL and medical card on a lead: on file or missing, asked for in the driver's Telegram group with one click, and
// saved by the bot when a picture of one is sent in the group (by the driver or by one of us).
//   bash test/all.sh papers
const BASE = process.argv[2] || 'http://localhost:3999';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = require('../src/db');
const bot = require('../src/tg/bot');
const ai = require('../src/tg/ai');
const q = db.q;
(async () => {
  // the bot's side is faked: nothing goes to Telegram or to the AI
  const FILES = { cdl1: Buffer.from('a picture of a CDL, front'), cdl2: Buffer.from('a picture of a CDL, the back side'), med1: Buffer.from('medical examiner certificate'), dog: Buffer.from('a dog') };
  bot.download = async (id) => FILES[id]; bot.noteMedia = async () => {}; bot.log = async () => {}; bot.send = async () => ({ message_id: 1 });
  ai.on = () => true;
  ai.onbDoc = async (buf) => { const t = buf.toString();
    return /CDL/.test(t) ? { kind: 'cdl', note: 'A commercial driver license', state: 'PA', expires: '2029-05-01' } : /medical/.test(t) ? { kind: 'medical_card', note: 'A medical card', expires: '2027-02-01' } : { kind: 'other', note: 'Not a document' }; };
  const onboard = require('../src/tg/onboard');
  const r0 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }) });
  const cookie = (r0.headers.get('set-cookie') || '').split(';')[0];
  const web = async (p, body) => { const x = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) }); return { http: x.status, ...(await x.json().catch(() => ({}))) }; };
  const did = (await q(`INSERT INTO drivers (name, name_key, status) VALUES ('Pete Papers', 'pete papers', 'Interested') RETURNING id`)).rows[0].id;
  const CHAT = -770100; const chat = { chat_id: CHAT, kind: 'dispatch', driver_id: did };
  const docs = async () => (await q(`SELECT kind, name, size, mime, uploaded_by FROM docs WHERE driver_id = $1 ORDER BY id`, [did])).rows;

  // the lead page: both missing, and no group to ask in yet
  let p = await web(`/api/drivers/${did}/papers`);
  ok(p.http === 200 && p.cdl === false && p.medical === false && p.canAsk === false, 'a lead with no papers: CDL and medical card are missing');
  ok((await web(`/api/drivers/${did}/request-paper`, { kind: 'passport' })).http === 400, 'only the CDL or the medical card can be asked for');
  const rq = await web(`/api/drivers/${did}/request-paper`, { kind: 'cdl' });
  ok(rq.http === 400 || rq.http === 404, 'asking needs the bot and a Telegram group: ' + (rq.error || ''));

  // the bot looks at pictures in his group
  await q(`INSERT INTO tg_chats (chat_id, title, kind, driver_id, active) VALUES ($1, 'Pete Papers', 'dispatch', $2, true)`, [CHAT, did]);
  const pic = (id) => ({ id, mime: 'image/jpeg' });
  ok(await onboard.quietPaper(chat, { message_id: 1 }, { name: 'Pete' }, pic('dog')) === null && !(await docs()).length, 'a picture that is not a CDL or medical card is not saved');
  ok(await onboard.quietPaper(chat, { message_id: 2 }, { name: 'Pete' }, pic('cdl1')) === 'cdl', 'the driver sends his CDL: the bot recognizes it');
  let d = await docs();
  ok(d.length === 1 && d[0].kind === 'cdl' && d[0].name === 'CDL from Telegram.jpg' && d[0].size === FILES.cdl1.length && d[0].uploaded_by === null, 'and saves it with his papers');
  const drv = (await q(`SELECT cdl_expires FROM drivers WHERE id = $1`, [did])).rows[0];
  ok(drv.cdl_expires && new Date(drv.cdl_expires).toISOString().startsWith('2029-0'), 'the expiry date read from it is kept: ' + drv.cdl_expires);
  ok((await q(`SELECT 1 FROM driver_events WHERE driver_id = $1 AND text LIKE 'CDL saved from the Telegram group (sent by Pete)%'`, [did])).rows.length === 1, 'it is in the lead\'s history');
  await onboard.quietPaper(chat, { message_id: 3 }, { name: 'Pete' }, pic('cdl1'));
  ok((await docs()).length === 1, 'the same picture again is not saved twice');
  await onboard.quietPaper(chat, { message_id: 4 }, { name: 'Pete' }, pic('cdl2'));
  ok((await docs()).length === 2, 'the back of the CDL is another picture: kept too');
  // one of us posts the medical card in the group
  await bot.handlers.dispatch.onMessage({ ...chat, member_count: 3 }, { message_id: 5, chat: { id: CHAT }, photo: [{ file_id: 'small' }, { file_id: 'med1' }] }, { tg_id: 9, name: 'Rita', user_id: 1 });
  d = await docs();
  ok(d.length === 3 && d[2].kind === 'medical' && d[2].name === 'Medical card from Telegram.jpg', 'a recruiter posts his medical card in the group: saved as well');

  // the lead page now
  p = await web(`/api/drivers/${did}/papers`);
  ok(p.cdl === true && p.medical === true, 'the lead page shows both on file');
  const list = await web(`/api/docs?driverId=${did}`);
  ok(list.docs.length === 3 && list.docs.every((x) => x.by === null), 'they are in his papers list, to open or delete');
  ok((await web(`/api/drivers/${did}/request-paper`, { kind: 'cdl' })).http === 400, 'a paper already on file is not asked for');
  process.exit();
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
