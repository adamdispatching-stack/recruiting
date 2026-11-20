# Recruiting database

One shared database for the drivers the **Indeed Match Rotator** Chrome extension finds, across every Chrome profile and Indeed account.

- **Website:** driver list with status filters and search, a page for each driver with editable notes, follow-up dates, tags, contact details, the Indeed conversation and its history.
- **Team logins:** admins and members; each note shows who wrote it.
- **Sync with the extension:** each Chrome profile sends its drivers here. Notes, follow-ups and statuses set on the website go back to the extension.
- **Same driver from several accounts:** matched by Indeed chat, phone, email, then name, so they show up once.

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

## Connect the Chrome extension

For each Chrome profile:

1. On the website, go to **Settings → Connect the Chrome extension**, name the key after the profile, and click **Create key**. Copy it; it is shown only once.
2. In that Chrome profile, open the extension's side panel → **Settings → Shared database**, paste the website address and the key, and click **Connect**.

Every driver in that profile is uploaded right away, and changes are sent within seconds after that.

**Older drivers:** existing drivers are uploaded when you connect. To bring in a profile you don't use anymore, download a backup on its database page (**More → Download a backup**) and import it on the website under **Settings → Import a backup**.

## Run it on your computer

```
npm install
DATABASE_URL=postgres://… ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=… npm start
```

Then open http://localhost:3000. `npm test -- http://localhost:3000 you@example.com yourpassword` runs a quick check against a server with an empty database.

## Privacy

Driver records include phone numbers, emails and driving history. The website requires a login for everything. Each Chrome profile uses its own access key, which you can revoke under **Settings**. Your Anthropic and Telegram keys stay in the extension and are never sent here.
