// "How to": everything a recruiter needs to know before doing the Facebook work, in the order of the day.
(() => {
  const { esc, view, S, header, toast, on } = App;
  const T = () => S.me.fbTargets || {};
  const n = (k, d) => (T()[k] ?? d);

  const PROMPTS = [
    ['Company drivers', `Create a square (1:1) recruiting ad image for a trucking company. Scene: a clean white Freightliner sleeper truck pulling a 53-foot dry van trailer on an East Coast highway at sunrise, realistic photo style. Big bold headline at the top: "CDL-A DRIVERS WANTED". Under it, three short lines in clean white text on a dark band: "Regional East Coast: NJ, PA, MD, DE", "Paid every Friday", "Newer automatic trucks". At the bottom: "Message me to apply". No company logos, no brand names, no phone numbers, no faces. Spell every word exactly as written.`],
    ['Owner-operators', `Create a square (1:1) recruiting ad image for a trucking company. Scene: a shiny owner-operator semi truck (no trailer logos) at a truck stop at dusk, realistic photo style. Big bold headline: "OWNER-OPERATORS WANTED". Under it, three short lines on a dark band: "Power-only loads up and down the East Coast", "Weekly pay", "Dispatch fee from 11%". At the bottom: "Message me to lease on". No company logos, no brand names, no phone numbers, no faces. Spell every word exactly as written.`]
  ];
  const VARY = ['at night with city lights and wet road reflections', 'in light rain on a bridge', 'parked at a fuel island', 'a close-up of the front of the truck', 'a red (or blue, or black) truck instead of white', 'a clean flat illustration instead of a photo', 'a bold yellow background with the truck cut out', 'driving through green hills in autumn'];
  const POSTS = [
    `🚛 CDL-A drivers: regional East Coast work, not long haul\n✅ Mostly NJ, PA, MD, DE\n✅ Paid every Friday\n✅ Newer automatic Freightliner sleepers, fully equipped\n✅ Home time on a set rotation\nComment "info" or message me and I'll send the details.`,
    `Looking for Class A drivers who want steady regional runs on the East Coast 🛣️\nWeekly pay, newer trucks, dispatch 24/7.\n2+ years preferred, but we look at every driver.\nDrop a comment or DM me.`,
    `Owner-operators 👋 Want steady power-only loads up and down the East Coast?\nYou keep your truck, we keep you loaded. Weekly pay, dispatch fee from 11%.\nMessage me for details.`
  ];
  const DM = `Hi {name}, I saw your comment in {group}. I'm hiring CDL-A drivers for regional East Coast runs (NJ, PA, MD, DE), paid every Friday. Do you have a Class A CDL, and are you driving OTR right now?`;
  const COMMENTS = ['Drivers who want regional East Coast work and to be home more, message me 👍', 'Good luck with the hire! Drivers: we also have regional runs in NJ/PA/MD, paid weekly. DM me.', 'If anyone is looking for steady East Coast work with newer automatic trucks, send me a message.'];
  const copyBox = (text, label) => `<div class="gcopy"><pre>${esc(text)}</pre><button type="button" class="btn plain sm" data-act="fbCopy">Copy${label ? ' ' + esc(label) : ''}</button></div>`;

  function guideHtml() {
    return `<article class="fbguide">
      <p class="lead">Your Facebook work brings in drivers the Indeed ads don't reach. Read this once before you start, and come back whenever you are unsure. Log each thing on your Facebook page <b>right after you do it</b>, not at the end of the day.</p>
      <nav class="gtoc" aria-label="On this page"><a href="#g-setup">Before you start</a><a href="#g-day">Every day, in order</a><a href="#g-check">What the admin checks</a><a href="#g-safe">Keep the account safe</a></nav>

      <section class="card" id="g-setup"><h2>Before you start (once)</h2>
        <ol class="gsteps">
          <li><b>Set up a real-looking personal account.</b> Profile photo, cover photo, your city, "Recruiter" under work, and some friends. A new, empty account gets limited fast.</li>
          <li><b>Warm up a new account for a week.</b> Personal posts, likes and comments, and join 5 to 10 groups (trucking and not trucking) before your first job post.</li>
          <li><b>Join the team's groups.</b> Open the <a href="#/facebook/groups">Groups</a> tab. Join the groups there and mark each one "Joined" (or "Asked to join"), so the team sees who is in which group. Found a good group? Add it to the list.</li>
          <li><b>Open ChatGPT</b> at chatgpt.com with the account your admin gave you (or your own). You will use it every morning for the ad pictures.</li>
          <li><b>Keep this website open</b> in another tab while you work on Facebook.</li>
        </ol></section>

      <section id="g-day"><h2 class="ghead">Every day, in this order</h2>
      <section class="card gstep"><h3><span class="gn">1</span>Make ${n('picture', 5)} ad pictures with ChatGPT <small>about 15 minutes</small></h3>
        <ol class="gsteps">
          <li>In ChatGPT, paste one of the prompts below and send it. Wait for the picture.</li>
          <li>Check it: every word spelled right, no other company's name or logo, no Amazon logo, looks real. If something is wrong, tell ChatGPT, for example: <i>"Fix the spelling of DRIVERS"</i> or <i>"Remove the logo on the trailer"</i>.</li>
          <li>Download it (the download arrow on the picture).</li>
          <li>Make ${n('picture', 5)} different ones: change the scene or the words each time with the ideas below. Never post the same picture twice; Facebook flags copies as spam.</li>
          <li>On your Facebook page, under <b>Ad pictures</b>, choose all of them at once (or drop them in). They are saved for today's posts.</li>
        </ol>
        ${PROMPTS.map(([l, p]) => `<h4>Prompt: ${esc(l)}</h4>${copyBox(p, 'prompt')}`).join('')}
        <h4>To make each picture different, add one of these to the prompt</h4><ul class="gvary">${VARY.map((v) => `<li>"…${esc(v)}"</li>`).join('')}</ul></section>

      <section class="card gstep"><h3><span class="gn">2</span>Post in ${n('post', 5)} groups, one picture each <small>spread over the day</small></h3>
        <ol class="gsteps">
          <li>Open a group from the <a href="#/facebook/groups">Groups</a> tab. Pick groups you haven't posted in for a few days.</li>
          <li>Write the post: start from a sample below and <b>change some words every time</b>. Add one of today's pictures. Post.</li>
          <li>If the group checks posts first, it says "pending". Log it once it is approved and you can open it.</li>
          <li><b>Copy the link to your post, not to the group.</b> Click the time under your name on the post (like "2m" or "Just now"). The post opens by itself; copy the address from the top of the browser. A post link has <code>/posts/</code> or <code>/permalink/</code> in it. A link that ends with the group's name or number is the group, and the website won't take it.</li>
          <li>On your Facebook page, under <b>Posts in groups</b>: the group's name (the link fills itself for groups on the list), the post link, and pick the picture you used.</li>
          <li><b>Wait 15 to 20 minutes</b> before the next group post.</li>
        </ol>
        <h4>Sample posts (change the words each time)</h4>${POSTS.map((p) => copyBox(p, 'text')).join('')}</section>

      <section class="card gstep"><h3><span class="gn">3</span>Comment on ${n('comment', 15)} driver ads from other companies</h3>
        <ol class="gsteps">
          <li>In driver groups, look for posts like "CDL-A drivers needed" or "Hiring Class A". Drivers read the comments there.</li>
          <li>Leave a short, friendly comment. Change the words; never paste the same comment everywhere.</li>
          <li>Take a screenshot of your comment: on Windows press <kbd>Win</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd> and drag over it.</li>
          <li>Copy the link to that post (click the time on the post), and log it under <b>Comments on ads</b>: paste the link, then click in the picture box and press <kbd>Ctrl</kbd> + <kbd>V</kbd> to add the screenshot.</li>
        </ol>
        <h4>Comment ideas</h4>${COMMENTS.map((c) => copyBox(c)).join('')}</section>

      <section class="card gstep"><h3><span class="gn">4</span>Message ${n('contact', 20)} drivers</h3>
        <ol class="gsteps">
          <li>Who: people who comment "interested" or "info" on driver ads (yours and others'), and members of driver groups whose profile says CDL or truck driver.</li>
          <li>Send a short first message (sample below) and ask the two questions: <b>Class A CDL?</b> and <b>driving OTR now?</b></li>
          <li>Log each driver under <b>Drivers messaged</b>: their profile link (open the profile, copy the address), name, the answers, the phone if they gave it, and how it went.</li>
          <li>Interested? Press <b>Make a lead</b> on that entry. The driver becomes your lead, and you call them like any other lead.</li>
          <li>Come back to your Facebook messages a few times a day and answer quickly. Update "How it went" with Edit.</li>
          <li>No more than about 10 new people an hour. If Facebook says you are sending too many messages, stop messaging for the day.</li>
        </ol>
        <h4>First message</h4>${copyBox(DM, 'message')}</section>

      <section class="card gstep"><h3><span class="gn">5</span>Join ${n('chat', 2)} group chats</h3>
        <p><b>Why:</b> drivers talk to each other in group chats all day. Far fewer recruiters are in them than in the groups, so a message there gets noticed. Every chat you join keeps paying off for weeks.</p>
        <ol class="gsteps">
          <li>In a group, open the <b>Chats</b> tab (on a phone, under "More") and join the chats listed there.</li>
          <li>Look for chat links in group posts and comments ("join our drivers chat").</li>
          <li>Ask: in a group or a chat you are already in, ask <i>"Is there a group chat for drivers here?"</i> Group admins and drivers often add you.</li>
          <li>Log each chat under <b>Group chats joined</b>: its name and link.</li>
          <li>In the chat: wait a day, then introduce yourself in one line. Don't post ads over and over; answer people who ask about work, and message drivers who talk about looking for a job.</li>
        </ol></section>

      <section class="card gstep"><h3><span class="gn">6</span>Personal activity: ${n('ppost', 1)} post and ${n('pcomment', 5)} comments</h3>
        <p>Facebook limits accounts that only post job ads. A little personal use every day keeps the account safe.</p>
        <ol class="gsteps">
          <li>Post something of your own on your profile: a photo, a meal, a place, a funny video you share, a quote.</li>
          <li>Comment on friends' posts and on pages or groups that have nothing to do with trucking jobs (sports, local news, hobbies).</li>
          <li>Log the links under <b>Personal activity</b>. Like and react freely; you don't need to log likes.</li>
        </ol></section>
      </section>

      <section class="card" id="g-check"><h2>What the admin checks</h2>
        <ul class="gsteps">
          <li>Every entry: the link opens, it is yours, and the picture or screenshot matches. Each is marked <b>OK</b> or <b>Problem</b> with a note.</li>
          <li>A problem shows at the top of your Facebook page and in your notifications. Fix it with <b>Edit</b>; it goes back to the admin.</li>
          <li>The website catches the same post, comment, driver or picture logged twice, and the group link used instead of a post link.</li>
          <li>Hitting every target on a working day counts toward your streak, and your badges grow with your totals.</li>
        </ul></section>

      <section class="card" id="g-safe"><h2>Keep the account safe</h2>
        <ul class="gsteps">
          <li>Use the account like a person every day, not only for ads.</li>
          <li>Space group posts 15 to 20 minutes apart. Change the words and the picture for every group.</li>
          <li>Only a few friend requests and messages to strangers each hour.</li>
          <li>Never share phone numbers of other drivers, and never ask for a driver's SSN, license number or bank details on Facebook.</li>
          <li>If Facebook warns you, blocks a feature, or asks you to confirm who you are: stop the job work for the day, keep only personal use, and tell your admin.</li>
        </ul></section>
    </article>`;
  }
  async function viewGuide() {
    document.title = 'How to: Facebook work · FleetHire';
    try { localStorage.setItem('fhFbGuide', '1'); } catch (e) { /* storage blocked */ }
    view.innerHTML = header('facebook') + `<main class="narrow">${App.fbTabs('guide')}${App.pageHead('How to do the Facebook work', 'What to do each day, in order, and how. Read it once before you start.')}${guideHtml()}</main>`;
  }
  on('fbCopy', async (b) => {
    const t = b.closest('.gcopy').querySelector('pre').textContent;
    try { await navigator.clipboard.writeText(t); toast('Copied'); } catch (e) { const r = document.createRange(); r.selectNodeContents(b.closest('.gcopy').querySelector('pre')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Selected: press Ctrl+C to copy'); }
  });
  App.route(/^#\/facebook\/guide$/, viewGuide);
})();
