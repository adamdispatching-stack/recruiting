// Is this person in their working hours right now? Their own hours (Team page), else the team's hours (Settings);
// never on a day off. The bot tags a recruiter in Telegram only then: a follow-up waits for their next working hour.
// Nobody named (no recruiter on the lead): the team's hours.
const db = require('./db');
const { q } = db;
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };

function localNow() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: db.settings.tz || 'America/Chicago', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const g = (k) => (p.find((x) => x.type === k) || {}).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')), min: (+g('hour') % 24) * 60 + +g('minute') };
}
async function working(userId) {
  if (process.env.TG_NO_QUIET) return true; // tests only
  const now = localNow(); let week = (db.settings.hours || {}).week || [];
  if (userId) {
    const u = (await q(`SELECT hours FROM users WHERE id = $1 AND active`, [userId])).rows[0];
    if (!u) return false; // gone: nobody to tag
    if (Array.isArray(u.hours) && u.hours.length === 7) week = u.hours;
    if ((await q(`SELECT 1 FROM days_off WHERE user_id = $1 AND day = $2::date`, [userId, now.date])).rows[0]) return false;
  }
  const d = week[now.dow];
  return !!d && now.min >= mins(d.s) && now.min < mins(d.e);
}
module.exports = { working, localNow };
