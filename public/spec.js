// Product map (техническое задание): one page for admins that shows how the parts connect, what each part does,
// what is built, what could be built next and what is good to have. "Copy request" puts a ready request on the
// clipboard to paste into a chat with Claude when you want to improve that part.
(() => {
  const { esc, view, S, toast, on, header } = App;

  // s: built | setup (built, needs something from you) | partial | next (could build next) | idea (good to have)
  const ST = {
    built: ['✅', 'Built', 'Works now'],
    setup: ['⚙️', 'Needs setup', 'Built, needs a step from you to work'],
    partial: ['🟡', 'Partly built', 'Works, with a part still missing'],
    next: ['🔜', 'Could build next', 'Clear plan, ready to build'],
    idea: ['💡', 'Good to have', 'An idea worth doing later']
  };
  const P = (name, s, what, where, link) => ({ name, s, what, where, link });

  const AREAS = [
    { id: 'ext', title: 'Chrome extension (Indeed Match Rotator)', icon: '🧩', runs: 'In every Chrome profile that is signed in to an Indeed employer account. Version 1.26.0, files in the indeed-match-rotator folder on your desktop.',
      groups: [
        { title: 'Finding drivers on Indeed', items: [
          P('Job rotation', 'built', 'Opens each job, sets it Open, opens Matches, invites recently active candidates with Indeed\'s Standard message up to the daily cap, then pauses the job with a reason ("I am evaluating current applicants") and moves on.', 'Side panel → Job rotation'),
          P('New applicants reader', 'built', 'Opens the Jobs page in the background, goes through people who applied today or yesterday, reads phone and email, saves them and sends a first message if there is no chat yet.', 'Runs by itself (apps.js)'),
          P('Never spends money on Indeed', 'built', 'Never clicks Upgrade, never opens unread chats, never touches old ads; invites use the Standard message only.', 'Rules in the extension'),
          P('Pick the best matches first', 'idea', 'Rank matched candidates (experience, location, Class A, active recently) before inviting, so the daily cap goes to the best ones.', 'Job rotation')
        ] },
        { title: 'Talking to drivers (auto-reply)', items: [
          P('Screening auto-reply', 'built', 'Watches Messages (Sourcing and Inbox) and walks each driver through the screening questions; different flows for company drivers and owner-operators.', 'Indeed Messages tab'),
          P('AI replies', 'setup', 'The AI writes the replies and understands free text. Needs the Anthropic key pasted in the extension settings.', 'Side panel → Settings'),
          P('Phone and contacts from the chat', 'built', 'Finds phone numbers in any format (+1 917 555 1234, 410.596.9751) and saves them every time; a one-time backfill fixed older leads.', 'Driver database'),
          P('Call-back detection', 'built', '"Call me at 3 pm" or "in 4 hours" becomes a call-back time on the lead; the website reminds the recruiter.', 'Side panel chip, lead page'),
          P('Waits while you use the page', 'built', 'Auto-reply pauses while you type or click on Indeed; Pause 15 min and Reply now buttons on the page.', 'Bar at the bottom of Indeed'),
          P('"Needs you" queue', 'built', 'Chats the auto-reply cannot handle go to a queue for a person, with a Telegram alert.', 'Side panel → Needs you'),
          P('Missed-call message', 'built', 'When a recruiter logs a call with no answer, the website asks the extension to send "I just tried to call you…" in the Indeed chat (once per 12 h).', 'Settings → Indeed message after a missed call'),
          P('Indeed human check (Cloudflare)', 'built', 'Stops on "Verify you are human", never ticks it, alerts you (Telegram, notification, red !), goes on slower for 2 hours after you tick it.', 'Any Indeed tab'),
          P('Best reply time per driver', 'idea', 'Learn when each driver usually answers and time the follow-ups then.', 'Auto-reply')
        ] },
        { title: 'Data and alerts', items: [
          P('Driver database in the browser', 'built', 'Every driver from every Chrome profile, merged; statuses, answers, chats.', 'Database page (db.html)'),
          P('Sync to the website', 'setup', 'Sends drivers to the website with the access key from Settings → Connect the Chrome extension.', 'Side panel → Settings'),
          P('Telegram alerts', 'setup', 'Needs you, human check, errors to your Telegram (bot token and chat id in the extension).', 'Side panel → Settings'),
          P('Show button on key fields', 'built', 'Show / Hide next to every key and token so you can check what you pasted.', 'Settings fields')
        ] }
      ] },
    { id: 'web', title: 'Website (FleetHire Recruiting)', icon: '🌐', runs: 'On Railway (Node, Express, Postgres). Every push to GitHub main deploys. Roles: admin, recruiter, dispatcher.',
      groups: [
        { title: 'Leads and the pipeline', items: [
          P('Leads list and pipeline', 'built', 'Every lead with status, source, recruiter; filters; going cold; why leads were lost; where leads came from.', 'Leads, Dashboard', '#/leads'),
          P('Lead page', 'built', 'Profile, experience, their truck, Amazon Relay step, conversation from Indeed, notes and contact log, history.', 'Leads → a lead'),
          P('Fair sharing of new leads', 'built', 'New leads go to the recruiter working now with the fewest today; untouched leads move after 60 min; leads wait when nobody works.', 'Settings → Sharing new leads'),
          P('Who opened a lead', 'built', 'Counter of opens and who opened it.', 'Lead page'),
          P('Call-backs', 'built', 'Reminder 10 min before, alert if not called 15 min after, admins after an hour.', 'Lead page, notifications'),
          P('Required call notes', 'built', 'A call marked "Talked" needs a real note (what he said, what was agreed, what comes next).', 'Lead page → log a call'),
          P('AI call guide', 'setup', 'Talking points for a call with this lead (needs ANTHROPIC_API_KEY on Railway).', 'Lead page → Call guide'),
          P('Chance to make it', 'built', 'Score 0-100 for drivers in onboarding from how they respond (silence, unanswered messages, calls, Amazon, start date, mood), with reasons.', 'Onboarding page, lead page', '#/onboarding'),
          P('Learn the score from results', 'next', 'Compare the chance score with who started and who dropped, tune the weights, show how often it was right.', 'Onboarding'),
          P('Early warning: leaving signs', 'idea', 'AI flags "another offer", repeated pay questions, family trouble.', 'Lead page, management group')
        ] },
        { title: 'Onboarding', items: [
          P('Onboarding board', 'built', 'Drivers in onboarding, Amazon verified first, arrival, truck, checklist progress, recruiter.', 'Onboarding', '#/onboarding'),
          P('Coaching for dispatchers', 'built', 'On a dispatcher\'s Trucks page: How you write to drivers (keep doing / try this), from the driver groups. Only he and the admins see it.', 'Trucks (dispatcher)'),
          P('AI health', 'built', 'AI usage page: Is the AI working? with a Test AI now button and why calls failed, in plain words (wrong key, no credit, model not allowed, busy). Busy or network errors are tried again; a model the key cannot use is swapped; on key or credit problems the bot pauses 10 minutes and admins are told; messages missed meanwhile are read later.', 'AI usage'),
          P('Dropped out', 'built', 'One button on the onboarding list, the lead page and the dashboard: saves the driver as Rejected with why. When a driver writes he is not coming, the AI flags him (Dropped out / Still with us) and tells the recruiter.', 'Onboarding, lead page, dashboard'),
          P('Checklist per driver', 'built', 'Steps from the template (Settings), some tick themselves (Telegram group created, Amazon verified, arrival date set…).', 'Lead page → Onboarding'),
          P('Amazon Relay steps', 'built', 'Invite → account → profile → background check → waiting → verified, with dates.', 'Lead page'),
          P('What a verified driver still needs', 'built', 'Arrival date, company and truck before the start; reminders to the recruiter.', 'Notifications'),
          P('MVR and drug test info', 'built', 'CDL state, ZIP for the drug test, last 4 of SSN for a Pennsylvania MVR (hidden, logged, deleted after 30 days).', 'Lead page → Onboarding'),
          P('Book the drug test', 'next', 'From the ZIP, find nearby facilities and save the appointment.', 'Lead page'),
          P('Driver papers (CDL, medical card)', 'built', 'Recruiters upload the CDL photo or PDF on the lead; shown only to the team.', 'Lead page → Driver papers'),
          P('Start date and travel from the chat', 'built', '"Ready Monday" becomes the start date (never overwrites the team\'s date; tells the recruiter instead).', 'Lead page')
        ] },
        { title: 'Trucks and companies', items: [
          P('Trucks by company', 'built', 'One table per company, empty trucks on top, the driver on each truck.', 'Trucks', '#/trucks'),
          P('Truck profile', 'built', 'Drivers and companies over time, shop history, oil changes, mileage, costs, open issues.', 'Trucks → a truck'),
          P('Truck papers', 'built', 'Registration, insurance card, lease and other paperwork per truck.', 'Truck page → Truck papers'),
          P('Oil change reminders', 'built', 'By miles and days, with warnings ahead.', 'Notifications'),
          P('Empty-truck cost', 'built', '$8,000 a month per truck (lease $5,000, insurance $2,000, other $1,000), counted per day.', 'Dashboard, /empty'),
          P('Companies', 'built', 'Each company with its trucks and drivers.', 'Companies', '#/companies'),
          P('Dispatchers on trucks', 'built', 'Dispatchers see trucks and active drivers, log oil changes and shop visits.', 'Trucks (dispatcher)')
        ] },
        { title: 'Active drivers', items: [
          P('Active drivers by company', 'built', 'CDL and medical card expiry, working period (weeks out, days home), 14-day mood.', 'Active drivers', '#/active'),
          P('Active driver page', 'built', 'Mood day by day, alerts, truck issues, notes from the bot, load updates, keeps his word, Telegram groups.', 'Active drivers → a driver')
        ] },
        { title: 'Team and motivation', items: [
          P('Activity and working hours', 'built', 'Active time, sign-ins, idle time alerts, days off, monthly report.', 'Team', '#/team'),
          P('Morning plan and coaching', 'built', 'Plan the day first; manager tips acknowledged by the recruiter.', 'My day'),
          P('Team goal and filled-by credit', 'built', 'Monthly goal to fill trucks, who filled which truck, personal bests.', 'Dashboard'),
          P('Badges and daily challenge', 'built', 'Five levels per badge; Facebook targets streak.', 'Badges', '#/badges'),
          P('Facebook work tracking', 'built', 'Pictures, group posts, comments, contacts, chats against daily targets, with the admin\'s checks.', 'Facebook', '#/facebook')
        ] },
        { title: 'Admin', items: [
          P('People and roles', 'built', 'Admins, recruiters, dispatchers; who sees which leads.', 'Team, Settings'),
          P('Settings', 'built', 'Checklist template, lead sources, sharing, working hours, time zone, Facebook targets, call guide, extension access keys, import / export.', 'Settings', '#/settings'),
          P('Product map', 'built', 'This page.', 'Account → Product map')
        ] }
      ] },
    { id: 'tg', title: 'Telegram bot', icon: '🤖', runs: 'Inside the website server on Railway. Needs TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY in Railway Variables, privacy mode off in BotFather (/setprivacy → Disable), and admin rights in each group.',
      groups: [
        { title: 'Connecting groups', items: [
          P('Connects from the group title', 'built', 'Name and phone in any format, a truck number, ELD / Accounting / Management words (also on a Russian keyboard). Phone match connects by itself.', 'Adding the bot to a group'),
          P('Groups to connect', 'built', 'When it is not sure: pick the group type and any driver, add a new driver from the title, mark the person as our team.', 'Telegram → Groups', '#/telegram'),
          P('Silent in the groups', 'built', 'Writes nothing when it joins or connects; /register gets a 👍.', 'All groups'),
          P('Working drivers\' groups', 'built', 'More than 10 people or an active driver: no onboarding, it learns quietly.', 'Adding the bot'),
          P('Command menu', 'built', '/register /mode /status /sum /help in groups; /onboard /empty /me /driver /help in private.', 'Telegram / menu'),
          P('Bot history', 'built', 'What the bot did and how people reacted (buttons, emoji, replies).', 'Telegram → Bot history')
        ] },
        { title: 'Onboarding groups', items: [
          P('Watch and learn (default)', 'built', 'Reads everything, sums it up on the website, learns from the team, never writes.', 'Driver page, /mode'),
          P('Answer questions / Run the onboarding', 'built', 'Answers from what it learned; runs the Amazon steps, reminders, arrival details, asks CDL state, ZIP, start day.', '/mode, driver page'),
          P('AI onboarding status', 'built', 'Summary, who it waits on, next step, blockers, mood; steps it saw done to confirm.', 'Driver page, Onboarding'),
          P('Onboarding autopilot readiness', 'built', 'How often the bot was right; when it can run alone.', 'Telegram → Knowledge'),
          P('Import past messages', 'built', 'Telegram chat export into a group so it learns from history.', 'Group page → Bring in earlier messages'),
          P('"Still with us?" nudge', 'idea', 'In Run mode, after 2 days of silence the bot asks the driver itself.', 'Onboarding groups')
        ] },
        { title: 'Dispatch groups (working drivers)', items: [
          P('Load updates', 'built', 'At pickup, loaded, rolling, ETA, delivered, delayed… with place and load number; checked ✓ / ✗ by the team.', 'Active driver page, group page'),
          P('Truck issues and service', 'built', 'From the chat into the truck\'s history.', 'Truck profile'),
          P('Driver notes and profile for dispatchers', 'built', 'Rebuilt daily; never shown in the driver\'s groups.', '/driver Name, active driver page'),
          P('Keeps his word', 'built', 'Promises with a time and whether they were kept.', 'Active driver page'),
          P('Alerts', 'built', 'Container or location mix-ups, upset driver, safety; important ones notify the team.', 'Telegram → Groups'),
          P('Updater mode', 'partial', 'Today it only asks about mix-ups and confirms appointment changes. Full updater (ETA checks, check calls) waits for your decision on what Smart Update keeps doing.', 'Group page → Updater'),
          P('Full updater', 'next', 'ETA check-ins, check calls, seal / BOL reminders following the approved dispatching practices.', 'Dispatch groups')
        ] },
        { title: 'Learning the team', items: [
          P('Who is who', 'built', 'Learns the driver, dispatchers, ELD and accounting people from what they write.', 'Telegram → People'),
          P('Dispatcher reply time', 'built', 'How fast each person answers drivers (median, 7 days).', 'Telegram → People'),
          P('Dispatcher profiles', 'built', 'Tone, clarity, professionalism, how they run updates, typical messages, strengths, what to improve.', 'Telegram → Knowledge → Dispatch autopilot'),
          P('How our dispatchers work', 'built', 'Situation → what the dispatcher does; the team approves; the updater will follow them.', 'Telegram → Knowledge'),
          P('Dispatch autopilot readiness', 'built', 'Groups watched, updates read right, practices approved, promises kept.', 'Telegram → Knowledge'),
          P('Knowledge base', 'built', 'Answers the bot uses, approved by the team.', 'Telegram → Knowledge')
        ] },
        { title: 'ELD and accounting groups', items: [
          P('/info in the ELD group', 'built', 'The team types /info: the bot posts name, phone, email, company, truck (VIN, plate) and sends the CDL and the truck papers uploaded on the website. Nothing is sent by itself.', 'ELD groups'),
          P('ELD setup and daily log checks', 'built', 'Info, login, manual, then log checks at set times. Off by default; switch on per group.', 'ELD group page → Run the ELD setup'),
          P('Silent for active drivers', 'built', 'ELD and accounting groups of drivers already working only read; switch on per group.', 'Group page'),
          P('Accounting answers', 'built', 'Answers pay and settlement questions, tags accounting when unsure, learns.', 'Accounting groups (switched on)')
        ] },
        { title: 'Team commands and management groups', items: [
          P('/onboard', 'built', 'Plain onboarding list: Amazon verified and Amazon pending, each split into CD and OO, with each driver\'s start date.', 'Private chat, management group'),
          P('/oil', 'built', 'Every truck in service, overdue first: truck, driver, miles now, when the oil was done (miles, date) and when it is due (miles left, date).', 'Private chat, management group'),
          P('/empty', 'built', 'Empty trucks by company, days and cost, who is coming.', 'Private chat, management group'),
          P('Morning report', 'built', 'Empty trucks and the onboarding list at a set time.', 'Management groups'),
          P('Follow-ups tagging recruiters', 'built', 'Driver waiting 3+ h, missed call-back, Amazon stuck 5+ days, silence 2 / 4 / 7 days.', 'Management groups'),
          P('Recruiters\' Telegram connected', 'setup', 'Each recruiter sends /me CODE to the bot so tags reach them.', 'Telegram → Connect my Telegram'),
          P('/leads and /calls today', 'idea', 'New leads and today\'s call list per recruiter in Telegram.', 'Private chat')
        ] }
      ] },
    { id: 'ai', title: 'AI (Claude)', icon: '🧠', runs: 'Two keys: one in the Chrome extension (auto-reply), one on Railway (website and bot). Pictures are read and forgotten; numbers like SSN or card numbers are never kept.',
      groups: [
        { title: 'What the AI does', items: [
          P('Screening replies on Indeed', 'setup', 'In the extension, with its own key.', 'Extension'),
          P('Group digests', 'built', 'Every few minutes after a conversation settles: notes, truck issues, alerts, load updates, promises, practices, who is who.', 'Bot'),
          P('Daily summaries', 'built', 'A few lines per group every evening.', 'Telegram → group page'),
          P('Profiles', 'built', 'Driver profile for dispatchers, dispatcher profiles.', 'Bot'),
          P('Documents', 'built', 'Reads CDL / medical card expiry and state, Amazon screenshots, background reports (results only).', 'Onboarding groups'),
          P('Cost and usage on the website', 'built', 'What Claude costs today, 7 days, this month and where the month is heading; by purpose, model and part (website, bot, extension); a monthly budget with alerts at 80% and 100%; prices editable.', 'Account → AI usage', '#/ai')
        ] }
      ] }
  ];

  // things that need you (no code can do them)
  const TODO = [
    ['Railway Variables: TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY', 'The bot and every AI feature on the website stay off without them.'],
    ['BotFather → /setprivacy → Disable', 'Otherwise the bot only sees commands in groups, not the conversation.'],
    ['Make the bot an admin in every group', 'Needed to read every message and to see emoji reactions.'],
    ['Reload the extension (1.26.0) in every Chrome profile', 'chrome://extensions → reload; allow notifications if asked.'],
    ['Each recruiter: /me CODE to the bot', 'So management groups can tag them and they can use /onboard and /empty.'],
    ['Mark each driver Company driver or Owner-operator', 'The verified list splits by it.'],
    ['Approve the AI\'s suggestions', 'Knowledge → answers to approve, How our dispatchers work; ✓ / ✗ on load updates.']
  ];

  // the map: how the parts talk to each other
  const DIAGRAM = `<svg class="pmap" viewBox="0 0 1000 460" role="img" aria-labelledby="pmt">
    <title id="pmt">How the parts connect: Indeed, the Chrome extension, the website with the Telegram bot inside, Telegram groups, the AI and your team</title>
    <defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#5B6B63"/></marker></defs>
    <g class="pml">
      <path d="M170 86 L170 170" marker-end="url(#ar)" marker-start="url(#ar)"/><text x="180" y="122">reads chats, replies,</text><text x="180" y="136">invites, applicants</text>
      <path d="M500 86 L500 170" marker-end="url(#ar)" marker-start="url(#ar)"/><text x="510" y="146">pipeline, onboarding,</text><text x="510" y="160">trucks, team</text>
      <path d="M840 86 L840 170" marker-end="url(#ar)" marker-start="url(#ar)"/><text x="850" y="122">reads all,</text><text x="850" y="136">writes per mode</text>
      <path d="M280 215 L390 215" marker-end="url(#ar)" marker-start="url(#ar)"/><text x="335" y="206" class="c">sync drivers</text><text x="335" y="234" class="c">missed-call msgs</text>
      <path d="M610 215 L720 215" marker-end="url(#ar)" marker-start="url(#ar)"/><text x="665" y="206" class="c">same server</text>
      <path d="M280 180 C330 118 360 108 400 108 L690 108 C715 108 728 100 738 90" marker-end="url(#ar)"/><text x="600" y="126">alerts to your Telegram</text>
      <path d="M170 260 C170 340 300 408 388 408" marker-end="url(#ar)"/><text x="158" y="322" class="e">screening replies</text>
      <path d="M500 260 L500 378" marker-end="url(#ar)"/><text x="510" y="324">call guide</text>
      <path d="M840 260 C840 340 700 408 612 408" marker-end="url(#ar)"/><text x="852" y="322">digests, profiles</text>
    </g>
    <g class="pmn">
      <rect x="60" y="30" width="220" height="56" rx="10"/><text x="170" y="54" class="t">Indeed</text><text x="170" y="73">employer accounts</text>
      <rect x="390" y="30" width="220" height="56" rx="10" class="pp"/><text x="500" y="54" class="t">Your team</text><text x="500" y="73">admins, recruiters, dispatchers</text>
      <rect x="710" y="30" width="260" height="56" rx="10"/><text x="840" y="54" class="t">Telegram</text><text x="840" y="73">driver, ELD, accounting, team groups</text>
      <rect x="60" y="170" width="220" height="90" rx="12" class="k"/><text x="170" y="203" class="t">🧩 Chrome extension</text><text x="170" y="223">each Chrome profile</text><text x="170" y="241">auto-reply, job rotation</text>
      <rect x="390" y="170" width="220" height="90" rx="12" class="k"/><text x="500" y="203" class="t">🌐 Website</text><text x="500" y="223">Railway: server + Postgres</text><text x="500" y="241">leads, onboarding, trucks</text>
      <rect x="720" y="170" width="240" height="90" rx="12" class="k"/><text x="840" y="203" class="t">🤖 Telegram bot</text><text x="840" y="223">inside the website server</text><text x="840" y="241">reads, learns, reports</text>
      <rect x="390" y="380" width="220" height="56" rx="10" class="ai"/><text x="500" y="404" class="t">🧠 Claude AI</text><text x="500" y="423">two keys: extension, Railway</text>
    </g></svg>`;

  let filter = 'all', query = '';
  const count = (s) => AREAS.reduce((n, a) => n + a.groups.reduce((m, g) => m + g.items.filter((i) => s === 'all' || i.s === s).length, 0), 0);
  const request = (a, g, i) => `FleetHire → ${a.title} → ${g.title} → ${i.name}\nStatus now: ${ST[i.s][1]}\nWhat it does now: ${i.what}\nWhere: ${i.where}\n\nWhat I want: `;

  function viewMap() {
    if (S.me.role !== 'admin') { location.hash = '#/'; return; }
    const ql = query.trim().toLowerCase();
    const match = (i, g, a) => (filter === 'all' || i.s === filter) && (!ql || `${i.name} ${i.what} ${i.where} ${g.title} ${a.title}`.toLowerCase().includes(ql));
    const body = AREAS.map((a) => {
      const gs = a.groups.map((g) => ({ g, items: g.items.filter((i) => match(i, g, a)) })).filter((x) => x.items.length);
      if (!gs.length) return '';
      return `<section class="card parea" id="pa-${a.id}"><h2>${a.icon} ${esc(a.title)}</h2><p class="hint">${esc(a.runs)}</p>
        ${gs.map(({ g, items }) => `<h3 class="pgt">${esc(g.title)}</h3><ul class="plist">${items.map((i) => `<li class="ps-${i.s}">
          <span class="pst" title="${esc(ST[i.s][2])}">${ST[i.s][0]} ${ST[i.s][1]}</span>
          <div class="grow"><b>${i.link ? `<a href="${i.link}">${esc(i.name)}</a>` : esc(i.name)}</b><div>${esc(i.what)}</div><div class="small mut">Where: ${esc(i.where)}</div></div>
          <button type="button" class="btn plain sm" data-act="pmCopy" data-a="${a.id}" data-n="${esc(i.name)}" title="Copy a request about this part, to paste into a chat with Claude">Copy request</button></li>`).join('')}</ul>`).join('')}</section>`;
    }).join('') || '<p class="hint">Nothing matches.</p>';
    view.innerHTML = header('map') + `<main class="o pmap-page"><div class="pagehead"><h1>Product map</h1><p class="hint">How the extension, the website, the Telegram bot and the AI connect, what each part does, and what is built, what could be next and what is good to have. Use <b>Copy request</b> to ask for a change to one part.</p></div>
      <section class="card">${DIAGRAM}</section>
      <section class="card ptodo"><h2>Needs you</h2><ol>${TODO.map(([t, w]) => `<li><b>${esc(t)}</b><div class="small mut">${esc(w)}</div></li>`).join('')}</ol></section>
      <div class="pmbar"><nav class="fbtabs" aria-label="Show">${[['all', 'Everything'], ...Object.entries(ST).map(([k, v]) => [k, `${v[0]} ${v[1]}`])].map(([k, l]) => `<button type="button" class="${filter === k ? 'on' : ''}" data-act="pmF" data-k="${k}">${l} <span class="cnt">${count(k)}</span></button>`).join('')}</nav>
        <input type="search" id="pmQ" placeholder="Search, e.g. Amazon, ELD, call" value="${esc(query)}" aria-label="Search the map"></div>
      <nav class="pjump" aria-label="Parts">${AREAS.map((a) => `<a href="#/map" data-act="pmJump" data-id="${a.id}">${a.icon} ${esc(a.title.split(' (')[0])}</a>`).join('')}</nav>
      ${body}</main>`;
    const qi = document.getElementById('pmQ');
    qi.addEventListener('input', () => { query = qi.value; const pos = qi.selectionStart; viewMap(); const n = document.getElementById('pmQ'); n.focus(); n.setSelectionRange(pos, pos); });
  }
  on('pmF', (b) => { filter = b.dataset.k; viewMap(); });
  on('pmJump', (b, e) => { if (e) e.preventDefault(); const el = document.getElementById('pa-' + b.dataset.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  on('pmCopy', async (b) => {
    const a = AREAS.find((x) => x.id === b.dataset.a); let g, i;
    for (const gg of a.groups) { const f = gg.items.find((x) => x.name === b.dataset.n); if (f) { g = gg; i = f; break; } }
    try { await navigator.clipboard.writeText(request(a, g, i)); toast('Copied. Paste it in a chat with Claude and add what you want.'); } catch (e) { toast('Could not copy'); }
  });
  App.route(/^#\/map$/, viewMap);
})();
