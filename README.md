# Recruiting

One website for the whole driver-recruiting pipeline: leads from Indeed (through the **Indeed Match Rotator** Chrome extension) and from anywhere else, follow-ups, onboarding, trucks, and what each recruiter did.

## What is in it

- **Leads.** Every driver in one list, across every Chrome profile and Indeed account. Filter by status, recruiter, source, follow-ups due, or leads going cold. Each lead has a page with notes, a contact log (calls, texts, emails), a follow-up date, tags, the Indeed conversation and its history.
- **Recruiter accounts.** An admin creates an account for each recruiter. Each lead belongs to one recruiter; admins can move leads, and a recruiter can take a lead nobody has.
- **Leads from other sources.** Recruiters add leads by hand and must say where each came from (Facebook, referral and so on). Someone already in the list is not added twice.
- **Onboarding.** Start onboarding on a lead and it gets a checklist (Telegram group, Amazon Relay, insurance, MVR, truck, arrival, ELD, accounting). The Onboarding page shows every driver being set up, one row per driver and one column per step. The checklist is edited under Settings.
- **Trucks.** Which trucks are empty, which have a driver, which are out of service. A truck gets its driver on the driver's onboarding card.
- **Team.** For each person: when they were first and last seen, time on the site and active time, clicks, leads opened, notes, calls, leads added, leads moved forward, drivers hired, follow-ups due. Each person has a page with time by hour or by day, sign-ins, and a list of everything they did.
- **Dashboard.** What needs attention today (follow-ups due, leads with no recruiter, leads going cold, late arrivals, stuck onboardings, empty trucks), the pipeline, where leads came from, and the latest activity. Recruiters get their own "My day" with a call list.

## Who can do what

| | Recruiter | Admin |
|---|---|---|
| Work leads, notes, follow-ups, onboarding steps | Yes | Yes |
| Add leads, take an unassigned lead | Yes | Yes |
| See their own activity | Yes | Yes |
| See everyone's activity, move leads between recruiters | No | Yes |
| Create accounts, trucks, access keys; change settings | No | Yes |
| Export all leads, delete a driver | No | Yes |

Under **Settings → Who sees which leads** an admin can limit recruiters to their own leads plus unassigned ones.

## What is recorded about people who use the site

While someone is signed in, the site sends a small signal every 30 seconds: whether the page was on screen, whether the person clicked, typed or scrolled since the last signal, and how many clicks. From that it works out time on the site and active time. It also records sign-ins (time, browser, network address), pages opened, and every change made to a lead. It never records what is typed, and nothing outside this website.

The sign-in page tells people this, and each person can see their own numbers under **My activity**. In many places employees must be told about monitoring like this; check what applies to your team.

Days on the reports run from midnight to midnight in the team time zone (Settings). The activity log is kept for about 13 months.

Bank and routing numbers are never stored here. The "Bank details taken by accounting" step is a tick box only.

## Put it on Railway

1. In Railway, click **New Project → Deploy from GitHub repo** and pick this repository.
2. In the same project, click **New → Database → PostgreSQL**.
3. Open the web service → **Variables** and add:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (pick it from the list Railway offers) |
   | `ADMIN_EMAIL` | your email; this becomes the first admin login |
   | `ADMIN_PASSWORD` | a password of at least 10 characters |
   | `ADMIN_NAME` | your name as it appears on notes (optional) |

4. Open **Settings → Networking → Generate Domain**. Your website address looks like `https://recruiting-production-xxxx.up.railway.app`.
5. Open the address and sign in. You can change your password under **Settings**. The admin variables are only used the first time; after that they can be removed.

Updating: push to the repository (or run `deploy.bat`) and Railway deploys the new version. The database is upgraded on start; nothing is lost.

## First setup after signing in

1. **Team → Add a person** for each recruiter. Give each person their password yourself.
2. **Trucks → Add truck** for each truck; fill in "Current driver" for trucks that already have one.
3. **Settings**: check the time zone, the lead sources and the onboarding checklist.
4. **Settings → Connect the Chrome extension**: create one key for each Chrome profile and choose which recruiter gets that profile's new leads.

## Connect the Chrome extension

For each Chrome profile:

1. On the website, go to **Settings → Connect the Chrome extension**, name the key after the profile, choose who gets its new leads, and click **Create key**. Copy it; it is shown only once.
2. In that Chrome profile, open the extension's side panel → **Settings → Shared database**, paste the website address and the key, and click **Connect**.

Every driver in that profile is uploaded right away, and changes are sent within seconds after that. Notes, follow-ups and statuses set on the website go back to the extension. The same driver seen from several accounts is matched by Indeed chat, phone, email, then name, so they show up once.

**Older drivers:** existing drivers are uploaded when you connect. To bring in a profile you don't use anymore, download a backup on its database page (**More → Download a backup**) and import it on the website under **Settings → Import a backup**.

## Run it on your computer

```
npm install
DATABASE_URL=postgres://… ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=… npm start
```

Then open http://localhost:3000. `npm test -- http://localhost:3000 you@example.com yourpassword` runs the API test against a server with an **empty** database.

## Privacy

Driver records include phone numbers, emails and driving history. The website requires a login for everything. Each Chrome profile uses its own access key, which an admin can revoke under **Settings**. Your Anthropic and Telegram keys stay in the extension and are never sent here.
