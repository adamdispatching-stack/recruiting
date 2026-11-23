// Driver journey: every step a driver goes through with us (onboarding, then dispatching), what he does, what our team
// does, and what the AI is there to do at that moment. The tag on each AI job says whether it works today.
// Keep it in step with the bot: src/tg/*.js.
(() => {
  const { esc, view, header, on } = App;
  const TAG = { on: 'Works today', draft: 'Draft for a person', run: 'Run mode only', setting: 'Needs a setting', later: 'Not built yet' };
  const J = {
onb: [
 { n: 'Finds us and applies', feel: 'He sees the job on Indeed and sends a message or applies.',
   driver: ['Applies or writes on Indeed', 'Answers the first questions: CDL, experience, home time'],
   team: ['A recruiter reads the lead and calls him'],
   ai: [['on', 'Reply to him on Indeed right away and draft the recruiter\'s replies (Chrome extension).'],
        ['on', 'Once he gives his phone and email, ask him on Indeed to install Telegram with the same number, as its own step. The bot waits until he says it is installed (asking once more after an "ok") before the Relay invite message; if he still has not confirmed, or cannot use Telegram, a person takes over (Chrome extension).', 'One thing before I send the invite: all our drivers work through Telegram… Let me know here once it is on your phone'],
        ['on', 'After a missed call ("No answer", "Left voicemail"), send him a short Indeed message so he calls back. At most once every 12 hours.']],
   done: 'He talks to a recruiter.' },
 { n: 'First call with the recruiter', feel: 'He hears the offer: pay, home time, the truck, the Amazon Relay work.',
   driver: ['Talks to the recruiter', 'Says yes, or needs time to think'],
   team: ['Explains the job and pay', 'Sends the Amazon Relay invite', 'Sets the status to Onboarding'],
   ai: [['on', 'Keep the status the recruiter set: the auto-reply never moves a lead the team has decided on.'],
        ['on', 'From the day after the Relay invite, ask the team if he signed up (even before onboarding). "Signed up" moves the lead to Signed up on Relay.', 'Mike Smith got the Amazon Relay invite 26 h ago. Has he signed up yet? [✅ Signed up] [Not yet]']],
   done: 'Status is Onboarding and the onboarding checklist is made.' },
 { n: 'Joins his Telegram group', feel: 'He is added to a group with his recruiter and our team. This is where onboarding happens.',
   driver: ['Joins the group from the invite link', 'Says hello'],
   team: ['Creates the group with the driver\'s name in the title', 'Adds the bot and makes it an admin'],
   ai: [['on', 'Link the group to the right driver by the name or phone in the title. Ask the team on the website when unsure.'],
        ['on', 'Show on the board that the bot is in the group: Bot connected, not admin, or removed.'],
        ['on', 'Work out which Telegram account is the driver\'s, and ask "Who is the driver?" on the board when it cannot tell.'],
        ['run', 'Welcome him, post his status card, and the button "🚚 I am the driver".', 'Hi Mike! Welcome to FleetHire…'],
        ['on', 'Follow up with the recruiter in the management group when he has no group yet, or the bot was removed or is not an admin.', '@rita, Mike Smith is in onboarding but has no Telegram group yet. Can you create one and add me to it?'],
        ['on', 'When the group is there but he has not joined it, ask the recruiter to check he has Telegram and send him the invite link.', '@rita, Mike Smith has not joined his Telegram group yet. Has he installed Telegram? Here is the invite link to send him: …'],
        ['on', 'Ask the team which account is the driver, with a button for each person who wrote.', 'Which one is Mike Smith in his group? [Mike S] [Mary] [None of them]']],
   done: 'The group is linked and the driver\'s account is known.' },
 { n: 'Signs up on Amazon Relay', feel: 'The longest step. He creates his Relay account, fills his profile, and waits for Amazon\'s background check.',
   driver: ['Accepts the Relay invite', 'Creates the account and fills the profile', 'Waits for Amazon to approve him', 'Sends screenshots when asked'],
   team: ['Checks his progress in Relay', 'Confirms when Amazon has verified him'],
   ai: [['run', 'Guide him one step at a time and send the next step when one is done.'],
        ['run', 'Remind him when a step is stuck 24 hours (daytime, up to 3 times), then tell the recruiter.', '⏰ Reminder: …'],
        ['run', 'Read his Relay screenshots. When it looks approved, ask the recruiter to confirm in Relay.', 'This looks like Amazon approved Mike! @recruiter, please confirm in Relay'],
        ['on', 'Read the group 2 minutes after it goes quiet: what we are waiting on, the next step, what is holding it up, his mood. Shown on the board.'],
        ['on', 'Tell the recruiter when he has waited for Amazon more than 7 days.'],
        ['on', 'Ask the team if the Relay invite went out, a day into onboarding.', 'Has the Amazon Relay invite gone out to Mike Smith? [✅ Sent] [Not yet]'],
        ['on', 'Once he signed up, ask the team every 2 days if Amazon verified him. "Verified" marks it on the website.', 'Is Mike Smith\'s Amazon Relay account verified yet? [✅ Verified] [⏳ Not yet]'],
        ['draft', 'Follow up with him when the invite is a day old and he has not signed up.', 'Hi Mike! Just checking: did you get the Amazon Relay invite email?']],
   done: 'Amazon verified (confirmed by a person).' },
 { n: 'Asks questions', feel: 'All through onboarding he asks: pay, the truck, when he starts, what to bring.',
   driver: ['Writes his questions in the group'],
   team: ['The recruiter answers what the bot cannot'],
   ai: [['draft', 'Write the answer from company facts and approved knowledge. In Watch it waits on his page with Send or Not needed.'],
        ['run', 'Answer by itself when sure, or say it will check with the recruiter.', 'Good question. Let me check with @recruiter.'],
        ['on', 'Learn the recruiter\'s answers, for the team to approve in Knowledge base.'],
        ['on', 'Tell the recruiter when a question has waited 2 hours, and when he seems upset.']],
   done: 'Every question is answered.' },
 { n: 'Checks and documents', feel: 'He gets his background check, MVR, PSP and drug test done, and sends his CDL and medical card.',
   driver: ['Goes for the drug test', 'Sends photos of his CDL and medical card', 'Gives the last 4 of his SSN if his state needs it'],
   team: ['Orders the checks', 'Reviews the results'],
   ai: [['run', 'Read the reports he posts and show the result with Approve / Needs a look for the team.'],
        ['run', 'Warn him and the recruiter when the CDL or medical card expires within 60 days.'],
        ['run', 'Ask him once for his CDL state and ZIP code, and send a private link for the SSN when needed.'],
        ['on', 'Hide the last 4 of his SSN if he types it in the group, and save the CDL state and ZIP he mentions.'],
        ['draft', 'Ask him for his CDL state and ZIP code when they are missing.'],
        ['on', 'Remind the team what is still open on our side: insurance, MVR, the contract, the Clearinghouse query, the ELD and accounting groups, his bank details.']],
   done: 'MVR approved and the checks are clear.' },
 { n: 'Paperwork', feel: 'He signs the contract and registers in the FMCSA Clearinghouse.',
   driver: ['Signs the contract from the safety team', 'Registers in the Clearinghouse and gives consent', 'Sends his bank details'],
   team: ['Sends the contract and the Clearinghouse query', 'Ticks each step'],
   ai: [['draft', 'Remind him about the Clearinghouse and the contract. Sent by the bot in Answer questions or Run; a draft in Watch.'],
        ['on', 'Tick the steps it sees done in the group, for a person to confirm.']],
   done: 'Contract signed, Clearinghouse clear, bank details in.' },
 { n: 'ELD and accounting set up', feel: 'He joins two more groups: one to set up his ELD, one for pay and accounting questions.',
   driver: ['Sends CDL and registration photos for the ELD', 'Logs in to the ELD app', 'Asks accounting about pay'],
   team: ['The ELD team sends his login', 'Accounting answers pay questions'],
   ai: [['setting', 'Walk him through the ELD setup: documents, login, check. Remind after 90 minutes; never at night.'],
        ['setting', 'Answer pay questions it knows in the accounting group and tag accounting for the rest.'],
        ['on', 'Otherwise read both groups quietly.']],
   done: 'ELD set up and checked; accounting group linked.' },
 { n: 'Gets ready to travel', feel: 'He gets a start date, a truck, and his trip to the yard is planned.',
   driver: ['Agrees on a start date', 'Travels to the truck'],
   team: ['Assigns a truck and a company', 'Books his travel', 'Sets the expected arrival'],
   ai: [['on', 'Pick up the start date and travel plans from the chat. A date the team typed is never changed.'],
        ['on', 'Ask the recruiter in the management group for the missing start date, company or truck once he is verified.'],
        ['on', 'When the start date has passed, ask the team if he arrived. "He arrived" marks it on the website.', 'Mike Smith was due to start Mon, Nov 24. Did he arrive? [✅ He arrived] [Not yet]'],
        ['run', 'The day before: remind him with his travel and truck details.', '🗓 Mike, tomorrow is your start day!']],
   done: 'He arrives (marked Arrived on his page).' },
 { n: 'Orientation day', feel: 'His first day: the truck is handed over, ELD, fuel card, Relay app, tolls, the safety talk, his first load.',
   driver: ['Takes over the truck', 'Goes through each item with the dispatcher'],
   team: ['The dispatcher goes through the orientation steps and ticks them'],
   ai: [['on', 'Send him the plan for the day in his group (in Watch, it waits on his page to send).', 'Welcome, Mike! Today is your orientation day. The plan:\n• Truck handed over\n• ELD login works\n…'],
        ['on', 'Tick the orientation steps the group shows done.'],
        ['on', 'When every orientation step is done, ask the team to mark him Hired.']],
   done: 'Status set to Hired. His group becomes his dispatch group.' },
 { risk: true, n: 'May drop out (any step)', feel: 'Some drivers go quiet or say they are not coming.',
   driver: ['Goes silent, gets another offer, or says he is not coming'],
   team: ['Calls him', 'Marks him Dropped out, or Still with us'],
   ai: [['on', 'Keep a chance score for each driver (🟢 🟡 🔴) from silence, reply speed, Amazon progress and mood.'],
        ['on', 'Flag "Says he is not coming" with his words, and tell the recruiter. Never changes his status itself.'],
        ['on', 'Morning report and follow-ups in the management group: no reply for 3 hours, a missed call-back, Amazon stuck 5 days.'],
        ['draft', 'Check in with him when he has been quiet for 3 days.', 'Hey Mike, how is it going? Anything holding you up?'],
        ['on', 'Follow-ups stop by themselves once the thing is done. After the last try, the admins get a website notice.'],
        ['on', 'The team answers with the buttons, or by replying to the bot in words ("yes", "not yet", "done"). The bot asks the team around the clock, one thing per driver at most every 6 hours; drivers hear from it in the daytime, at most once a day.']],
   done: 'A person decides.' }
],
disp: [
 { n: 'Starts driving', feel: 'He is hired and takes his first loads. His onboarding group is now his dispatch group.',
   driver: ['Runs his first loads', 'Sends updates in his group'],
   team: ['His dispatcher books loads and follows him'],
   ai: [['on', 'Tell everyone the truck is filled.', '🎉 Truck 214 is filled: Mike started. Great work, Rita!'],
        ['on', 'Switch his group to quiet watching: the bot reads, learns dispatching, and writes nothing.']],
   done: 'He is running loads.' },
 { n: 'Every day on the road', feel: 'Pickups, deliveries, check calls, appointments, rolling to the next load.',
   driver: ['Sends pickup and delivery updates', 'Reports delays and appointment changes'],
   team: ['Dispatchers on shift follow every driver', 'Post the booking list each shift'],
   ai: [['on', 'Read his group every 25 minutes (at once on words like breakdown or accident): save load updates, promises, notes about him.'],
        ['on', 'Ask the dispatcher on shift privately when he needs a load, is resting, or has a problem. Escalate after 15 minutes.', 'Mike needs a load. Send me the best option you see now, and why.'],
        ['on', 'Ask where he is rolling when there is no update for 6 hours.'],
        ['setting', 'In Updater mode: ask him when the location does not match the load, and note appointment changes.', '📌 Noted: appointment moved to 14:00.'],
        ['on', 'Remind the shift to post the booking list and the update notes.'],
        ['on', 'Sum up his day at 21:00 with his mood.']],
   done: 'Every load delivered and noted.' },
 { n: 'Rest and hours', feel: 'He takes his breaks and resets.',
   driver: ['Says when he goes to sleep and when he will be up'],
   team: ['Leaves him alone while he rests'],
   ai: [['on', 'Tell the dispatcher on shift he is resting until a time, and ask at that time if he checked in.', 'Mike says he will be up at 10:30 AM. Got it? No calls until then.']],
   done: 'He is back on duty.' },
 { n: 'A problem on the road', feel: 'A flat tire, a breakdown, an accident, a late load, a refused load, an inspection.',
   driver: ['Tells the group what happened', 'Sends photos and where he is'],
   team: ['The dispatcher handles it, step by step', 'Books the shop, pays the bill'],
   ai: [['on', 'Open a road case from the right playbook and tell the dispatcher the first step.', 'Mike: flat tire on I-80. First step: …'],
        ['draft', 'Write each step\'s message to the driver. Sent by the bot in Updater; a draft on Road cases in Watch.'],
        ['on', 'Remind the dispatcher when a step is late, then the admins. Save the cost, the shop and the lesson.']],
   done: 'The case is closed.' },
 { n: 'Truck care', feel: 'Oil changes, repairs and the shop.',
   driver: ['Tells us the mileage', 'Takes the truck to the shop'],
   team: ['Plans the oil change and repairs'],
   ai: [['on', 'Save truck events from the chat: breakdowns, repairs, mileage. Tell the admins about damage or a warning light.'],
        ['on', 'Tell the dispatcher and admins when the oil change is due.'],
        ['on', 'Ask him for the mileage: sent in Updater, a draft on his page in Watch.', '🛢 Mike, truck 214 is due for an oil change. What is the mileage now?']],
   done: 'The truck is serviced.' },
 { n: 'Pay and paperwork', feel: 'Questions about his pay, deductions and settlements.',
   driver: ['Asks accounting in his accounting group'],
   team: ['Accounting answers'],
   ai: [['setting', 'Answer what it knows and tag accounting for the rest (only if the group is switched out of Watch).'],
        ['later', 'Answer drivers in the dispatch group. Waiting for the dispatch readiness check to pass.']],
   done: 'He is paid and has no open questions.' },
 { n: 'Home time', feel: 'After his weeks out he goes home, rests, and comes back.',
   driver: ['Says when he goes home and when he comes back', 'Asks for a ticket if he needs one'],
   team: ['Plans his home time', 'Books his ticket back'],
   ai: [['on', 'Track going home, at home and coming back from the chat. Show who is due home on the home planner.'],
        ['draft', 'Two days before he comes back, ask if he needs a ticket. Sent in Updater; a draft in Watch.', 'Hi Mike! You are coming back on Dec 2, right? Do you need a bus or plane ticket?'],
        ['on', 'Tell the recruiter and dispatcher, and again if he is a day late.']],
   done: 'He is back on the road.' },
 { risk: true, n: 'Staying with us', feel: 'Some drivers get unhappy or get other offers.',
   driver: ['Complains, goes quiet, or mentions another company'],
   team: ['The recruiter calls him'],
   ai: [['on', 'Score his risk of leaving from his words, moods, late home time and silence.'],
        ['on', 'Tell the recruiter when he may leave: "Worth a call today."', 'Mike may leave (another offer): "…". Worth a call today.'],
        ['on', 'Tell the dispatcher in the management group when he wrote and got no answer for 3 hours.']],
   done: 'A person talks to him ("Talked to him").' },
 { end: true, n: 'Leaves', feel: 'He quits or is let go.',
   driver: ['Hands back the truck'],
   team: ['Sets "Left" on his page'],
   ai: [['on', 'Free the truck and take him off every list.'],
        ['on', 'Stop reading his groups. The messages are still saved, but the AI no longer reads them or raises alerts.']],
   done: 'The truck is empty and ready for the next driver.' },
 { end: true, n: 'Behind the scenes', feel: 'What the AI does for the team, not for one driver.',
   driver: [], team: ['Admins read the reviews and approve knowledge'],
   ai: [['on', 'Build a profile of each driver for dispatchers: routines, loads he likes or refuses.'],
        ['on', 'Review each dispatcher every few days, with links to the real messages. Red flags go to admins only.'],
        ['on', 'Collect what the team teaches into the Knowledge base, for a person to approve.']],
   done: '' }
]};
  const OPEN = [
    ['The bot is in Watch for every onboarding', 'A past update moved every onboarding group from Run to Watch, so the jobs tagged "Run mode only" do not happen. Switch it per driver on his lead page (Onboarding bot), or for new drivers in Settings.'],
    ['The dispatch bot does not answer drivers yet', 'On purpose: it waits for the readiness check on the Telegram page (3+ groups for 14 days, 10+ approved practices, 20+ checked updates at 90%).'],
    ['Indeed replies are in the Chrome extension', 'The Indeed auto-reply and reply drafts are set up in the extension, not on this website.']
  ];
  let cur = 'onb';
  try { if (J[localStorage.getItem('journey')]) cur = localStorage.getItem('journey'); } catch (e) { /* storage off */ }
  function viewJourney() {
    document.title = 'Driver journey · FleetHire';
    let i = 0;
    const list = (a) => `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    const stops = J[cur].map((s, k) => {
      const num = s.risk ? '!' : s.end ? '◼' : ++i;
      return `<div class="djstop${s.risk ? ' risk' : ''}${s.end ? ' end' : ''}"><div class="djpin"><b>${num}</b></div>
        <details class="djcard" ${k === 0 ? 'open' : ''}><summary><h3>${esc(s.n)}</h3><span class="djchev" aria-hidden="true">▼</span><span class="djfeel">${esc(s.feel)}</span></summary>
        <div class="djbody">
          ${s.driver.length ? `<div class="djcol"><h4>The driver</h4>${list(s.driver)}</div>` : ''}
          <div class="djcol"><h4>Our team</h4>${list(s.team)}</div>
          <div class="djai djcol"><h4><span class="djdot">AI</span>What the AI is there to do</h4><ul>${s.ai.map(([t, x, said]) => `<li><span>${esc(x)}${said ? `<q>${esc(said)}</q>` : ''}</span><span class="djst ${t}">${TAG[t]}</span></li>`).join('')}</ul></div>
          ${s.done ? `<div class="djdone"><b>Done when</b><span>${esc(s.done)}</span></div>` : ''}
        </div></details></div>`;
    }).join('');
    const pick = (k, l) => `<button type="button" data-act="djPick" data-j="${k}" class="${cur === k ? 'on' : ''}" aria-pressed="${cur === k}">${l}</button>`;
    view.innerHTML = header('journey') + `<main class="djpage">${App.pageHead('Driver journey', 'Every step a driver goes through with us, from the first Indeed message to his last load: what he does, what our team does, and what the AI is there to do at that moment. The tag on each AI job says whether it works today. The bot follows up with whoever owes the next move, like a person: our team in the management group, the driver in his group (a draft to send while the group is in Watch).')}
      <div class="pagebar"><div class="seg" role="group" aria-label="Journey">${pick('onb', 'Onboarding')}${pick('disp', 'Dispatching')}</div>
        <span class="grow"></span><button type="button" class="btn plain" data-act="djAll">Open all</button></div>
      <div class="djlegend"><span class="small mut">AI jobs:</span>${Object.entries(TAG).map(([k, l]) => `<span class="djst ${k}">${l}</span>`).join('')}</div>
      <div class="djroad">${stops}</div>
      <section class="card" style="margin-top:22px"><h3>Not done yet</h3><ul class="list">${OPEN.map(([h, p]) => `<li><span class="grow"><b>${esc(h)}</b><br><span class="small mut">${esc(p)}</span></span></li>`).join('')}</ul></section></main>`;
  }
  on('djPick', (b) => { cur = b.dataset.j; try { localStorage.setItem('journey', cur); } catch (e) { /* storage off */ } viewJourney(); });
  on('djAll', (b) => { const all = [...document.querySelectorAll('.djcard')]; const any = all.some((d) => !d.open); all.forEach((d) => { d.open = any; }); b.textContent = any ? 'Close all' : 'Open all'; });
  App.route(/^#\/journey$/, viewJourney);
})();
