// Database: connection, schema, and the rules for merging driver records from every Chrome profile.
const { Pool, types } = require('pg');
const crypto = require('crypto');
types.setTypeParser(1082, (v) => v); // dates (follow-up, arrival) stay plain 'YYYY-MM-DD' text, whatever the server's time zone

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set. On Railway, add a Postgres database and link it to this service.'); process.exit(1); }
const pool = new Pool({
  connectionString: url,
  max: +process.env.PG_POOL || 14, // one is held by the background-jobs lock (src/guard.js)
  connectionTimeoutMillis: 30000, // every connection busy for 30 s: fail that request (and record it) instead of hanging the website
  ssl: /localhost|127\.0\.0\.1|\/tmp|railway\.internal/.test(url) || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false }
});
const q = (text, params) => pool.query(text, params);

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT UNIQUE NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS drivers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Invited',
      status_locked BOOLEAN NOT NULL DEFAULT FALSE,
      phones TEXT[] NOT NULL DEFAULT '{}',
      emails TEXT[] NOT NULL DEFAULT '{}',
      conv_ids TEXT[] NOT NULL DEFAULT '{}',
      location TEXT, zip TEXT, mode TEXT, source TEXT, job TEXT, account TEXT,
      answers JSONB NOT NULL DEFAULT '{}',
      ai_summary TEXT, red_flags TEXT, transcript TEXT,
      conversation_url TEXT, last_message TEXT, profile_summary TEXT, last_active TEXT,
      invited_at TIMESTAMPTZ, last_contact_at TIMESTAMPTZ,
      follow_up DATE,
      tags TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      web_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS status_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS drivers_name_key ON drivers(name_key);
    CREATE INDEX IF NOT EXISTS drivers_phones ON drivers USING GIN(phones);
    CREATE INDEX IF NOT EXISTS drivers_emails ON drivers USING GIN(emails);
    CREATE INDEX IF NOT EXISTS drivers_conv ON drivers USING GIN(conv_ids);
    CREATE INDEX IF NOT EXISTS drivers_updated ON drivers(updated_at DESC);
    CREATE TABLE IF NOT EXISTS driver_events (
      id BIGSERIAL PRIMARY KEY,
      driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      t TIMESTAMPTZ NOT NULL DEFAULT now(),
      type TEXT,
      text TEXT NOT NULL,
      who TEXT,
      fp TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS driver_events_fp ON driver_events(driver_id, fp);
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      source TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS notes_driver ON notes(driver_id);
    CREATE UNIQUE INDEX IF NOT EXISTS notes_source ON notes(driver_id, source) WHERE source IS NOT NULL;
  `);
  // ----- recruiting pipeline: who owns a lead, where it came from, what each person did, onboarding, trucks -----
  await q(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_visible_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS hours JSONB; -- own working hours; empty = the team's hours
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS assign_to INT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS owner_id INT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS source_detail TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS lost_reason TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS lead_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS drivers_lead_at ON drivers(lead_at) WHERE lead_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS drivers_owner ON drivers(owner_id);
    CREATE INDEX IF NOT EXISTS drivers_status ON drivers(status);
    CREATE INDEX IF NOT EXISTS drivers_follow ON drivers(follow_up) WHERE follow_up IS NOT NULL;
    ALTER TABLE notes ADD COLUMN IF NOT EXISTS kind TEXT;
    ALTER TABLE notes ADD COLUMN IF NOT EXISTS outcome TEXT;
    CREATE TABLE IF NOT EXISTS logins (
      id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      kind TEXT NOT NULL DEFAULT 'in',
      ip TEXT, ua TEXT
    );
    CREATE INDEX IF NOT EXISTS logins_user ON logins(user_id, at DESC);
    CREATE TABLE IF NOT EXISTS activity_hours (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hour TIMESTAMPTZ NOT NULL,
      active_seconds INT NOT NULL DEFAULT 0,
      open_seconds INT NOT NULL DEFAULT 0,
      clicks INT NOT NULL DEFAULT 0,
      views INT NOT NULL DEFAULT 0,
      first_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, hour)
    );
    CREATE TABLE IF NOT EXISTS activity (
      id BIGSERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      type TEXT NOT NULL,
      driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,
      driver_name TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id, at DESC);
    CREATE INDEX IF NOT EXISTS activity_at ON activity(at DESC);
    CREATE TABLE IF NOT EXISTS status_log (
      id BIGSERIAL PRIMARY KEY,
      driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      from_status TEXT,
      to_status TEXT NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      via TEXT
    );
    CREATE INDEX IF NOT EXISTS status_log_at ON status_log(at DESC);
    CREATE INDEX IF NOT EXISTS status_log_driver ON status_log(driver_id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS trucks (
      id SERIAL PRIMARY KEY,
      unit TEXT NOT NULL,
      details TEXT, location TEXT,
      out_of_service BOOLEAN NOT NULL DEFAULT FALSE,
      driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,
      driver_name TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS trucks_unit ON trucks(lower(unit));
    CREATE UNIQUE INDEX IF NOT EXISTS trucks_driver ON trucks(driver_id) WHERE driver_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS onboarding (
      driver_id INT PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_by INT REFERENCES users(id) ON DELETE SET NULL,
      expected_arrival DATE, arrival_note TEXT, arrived_on DATE,
      telegram_link TEXT,
      completed_at TIMESTAMPTZ,
      progress_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS checklist (
      id SERIAL PRIMARY KEY,
      driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      position INT NOT NULL DEFAULT 0,
      auto TEXT,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      done_by INT REFERENCES users(id) ON DELETE SET NULL,
      done_at TIMESTAMPTZ,
      note TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS checklist_key ON checklist(driver_id, key);
    -- Facebook work recruiters log each day: posts in groups, comments, drivers messaged, group chats joined
    CREATE TABLE IF NOT EXISTS fb_images (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      mime TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      sha TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS fb_images_sha ON fb_images(sha);
    CREATE TABLE IF NOT EXISTS fb_entries (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,                       -- the working day it counts for (team time zone)
      kind TEXT NOT NULL,                      -- post | comment | contact | chat
      link TEXT,                               -- the post, the commented ad, the driver's profile, the group chat
      link_key TEXT,                           -- the link without tracking bits, to catch the same one twice
      group_name TEXT,
      group_link TEXT,
      person_name TEXT,
      answers JSONB NOT NULL DEFAULT '{}'::jsonb,  -- contact: otr, cdlA (yes/no), phone
      outcome TEXT,                            -- contact: messaged | replied | interested | not interested
      note TEXT,
      image_id INT REFERENCES fb_images(id) ON DELETE SET NULL,
      review TEXT,                             -- ok | problem (admin)
      review_note TEXT,
      reviewed_by INT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,  -- the lead made from a contact
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS fb_entries_day ON fb_entries(day, user_id);
    CREATE INDEX IF NOT EXISTS fb_entries_link ON fb_entries(kind, link_key);
    -- Facebook groups the team posts in, found and added by the recruiters, and who joined which
    CREATE TABLE IF NOT EXISTS fb_groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      link TEXT NOT NULL,
      link_key TEXT NOT NULL UNIQUE,
      audience TEXT,                 -- owner operators | company drivers | cdl drivers | dispatchers | other
      members INT,
      privacy TEXT,                  -- public | private
      approval TEXT,                 -- yes (posts are checked first) | no | unknown
      notes TEXT,
      added_by INT REFERENCES users(id) ON DELETE SET NULL,
      updated_by INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS fb_group_members (
      group_id INT NOT NULL REFERENCES fb_groups(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,          -- joined | requested (waiting for the group to accept)
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, user_id)
    );
    -- a stretch of working hours with no activity on the website (only long ones are kept)
    CREATE TABLE IF NOT EXISTS idle_spells (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ NOT NULL,
      shift_end TIMESTAMPTZ NOT NULL,
      open BOOLEAN NOT NULL DEFAULT TRUE,
      notified_at TIMESTAMPTZ,
      UNIQUE (user_id, started_at)
    );
    CREATE INDEX IF NOT EXISTS idle_spells_user ON idle_spells(user_id, started_at);
    -- messages for one person on the website (idle alerts)
    CREATE TABLE IF NOT EXISTS notices (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      link TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      seen_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS notices_user ON notices(user_id, seen_at);
    ALTER TABLE notices ADD COLUMN IF NOT EXISTS driver_id INT REFERENCES drivers(id) ON DELETE CASCADE;
    -- ---------- Telegram bot ----------
    CREATE TABLE IF NOT EXISTS tg_state (key TEXT PRIMARY KEY, value JSONB);
    -- groups the bot is in; kind: eld | accounting | updates | dispatch, linked to a driver with a code from the website
    CREATE TABLE IF NOT EXISTS tg_chats (
      chat_id BIGINT PRIMARY KEY, title TEXT, kind TEXT, driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,
      linked_by INT REFERENCES users(id) ON DELETE SET NULL, linked_at TIMESTAMPTZ, bot_admin BOOLEAN NOT NULL DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true, card_msg_id BIGINT, last_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Telegram users the bot has seen; role: driver | eld | accounting | dispatch | staff
    CREATE TABLE IF NOT EXISTS tg_people (
      tg_id BIGINT PRIMARY KEY, name TEXT, username TEXT, role TEXT, driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL, seen_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS tg_members (chat_id BIGINT NOT NULL, tg_id BIGINT NOT NULL, PRIMARY KEY (chat_id, tg_id));
    -- what was said (passwords and account numbers are hidden before saving; pictures are not kept, only what they show)
    CREATE TABLE IF NOT EXISTS tg_messages (
      id BIGSERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, msg_id BIGINT NOT NULL, from_id BIGINT, from_name TEXT, is_bot BOOLEAN NOT NULL DEFAULT false,
      text TEXT, media TEXT, media_note TEXT, reply_to BIGINT, at TIMESTAMPTZ NOT NULL, UNIQUE (chat_id, msg_id)
    );
    CREATE INDEX IF NOT EXISTS tg_messages_chat ON tg_messages(chat_id, at);
    CREATE TABLE IF NOT EXISTS tg_links (
      code TEXT PRIMARY KEY, driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), used_at TIMESTAMPTZ
    );
    -- set on the website: this Telegram account is not this driver's (the bot's guesses never link it to them again)
    CREATE TABLE IF NOT EXISTS tg_not_driver (driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, tg_id BIGINT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (driver_id, tg_id));
    ALTER TABLE tg_people ADD COLUMN IF NOT EXISTS team_dismissed_at TIMESTAMPTZ;
    -- ELD setup for one driver, step by step, then daily checks by the ELD team
    CREATE TABLE IF NOT EXISTS eld_cases (
      driver_id INT PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE, chat_id BIGINT, steps JSONB NOT NULL DEFAULT '{}',
      wait JSONB, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), setup_done_at TIMESTAMPTZ, stopped_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS eld_checks (
      id SERIAL PRIMARY KEY, driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, chat_id BIGINT, slot TEXT NOT NULL,
      asked_at TIMESTAMPTZ NOT NULL DEFAULT now(), msg_id BIGINT, reminded INT NOT NULL DEFAULT 0, escalated_at TIMESTAMPTZ,
      answer TEXT, problem TEXT, answered_by TEXT, answered_at TIMESTAMPTZ, fixed_at TIMESTAMPTZ, UNIQUE (driver_id, slot)
    );
    -- Onboarding group: the bot follows the Amazon Relay steps with the driver, reads reports, answers questions
    CREATE TABLE IF NOT EXISTS onb_cases (
      driver_id INT PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE, chat_id BIGINT, last_amazon TEXT, nudge JSONB, sent JSONB NOT NULL DEFAULT '{}',
      card_msg_id BIGINT, started_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- background reports and screenshots the bot read (only the result and findings, never personal details)
    CREATE TABLE IF NOT EXISTS tg_reports (
      id SERIAL PRIMARY KEY, driver_id INT REFERENCES drivers(id) ON DELETE CASCADE, chat_id BIGINT, msg_id BIGINT, kind TEXT, result TEXT,
      findings JSONB, note TEXT, from_name TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now(), review TEXT, reviewed_by TEXT, reviewed_at TIMESTAMPTZ
    );
    -- questions from drivers the bot could not answer, until someone does
    CREATE TABLE IF NOT EXISTS tg_questions (
      id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, driver_id INT REFERENCES drivers(id) ON DELETE CASCADE, msg_id BIGINT, bot_msg_id BIGINT,
      text TEXT NOT NULL, asked_at TIMESTAMPTZ NOT NULL DEFAULT now(), answer TEXT, answered_by TEXT, answered_at TIMESTAMPTZ
    );
    -- what the bot knows, beyond the company facts: added on the website or learned from the team's answers
    CREATE TABLE IF NOT EXISTS tg_knowledge (
      id SERIAL PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'added', added_by TEXT,
      chat_id BIGINT, uses INT NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- every message is read by the AI once (in batches); old messages count as read
    ALTER TABLE tg_messages ADD COLUMN IF NOT EXISTS digested BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE tg_messages ALTER COLUMN digested SET DEFAULT false;
    ALTER TABLE tg_chats ADD COLUMN IF NOT EXISTS invite_link TEXT;
    ALTER TABLE tg_messages ADD COLUMN IF NOT EXISTS file_id TEXT;
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'general';
    -- one dispatch group per driver (it is the onboarding group too); the old kinds become dispatch
    UPDATE tg_chats SET kind = 'dispatch' WHERE kind IN ('onboarding', 'updates');
    UPDATE tg_links SET kind = 'dispatch' WHERE kind IN ('onboarding', 'updates');
    -- a website user connects their Telegram with a code (/me 123456)
    CREATE TABLE IF NOT EXISTS tg_me_codes (code TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), used_at TIMESTAMPTZ);
    -- truck issues and service, from the drivers' groups or added by hand
    CREATE TABLE IF NOT EXISTS truck_events (
      id SERIAL PRIMARY KEY, truck_id INT REFERENCES trucks(id) ON DELETE CASCADE, driver_id INT REFERENCES drivers(id) ON DELETE SET NULL, chat_id BIGINT,
      kind TEXT NOT NULL, title TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'open', odometer INT, cost NUMERIC(10,2), shop TEXT,
      source TEXT NOT NULL DEFAULT 'telegram', added_by TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now(), fixed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS truck_events_truck ON truck_events(truck_id, at);
    -- what the team should know about a driver, noticed in the groups (habits, requests, load likes and dislikes)
    CREATE TABLE IF NOT EXISTS driver_notes (
      id SERIAL PRIMARY KEY, driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, chat_id BIGINT, kind TEXT, text TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS driver_notes_driver ON driver_notes(driver_id, at);
    -- the driver's profile for dispatchers, rebuilt by the AI from the notes; pins are the team's own lines, always kept
    CREATE TABLE IF NOT EXISTS driver_profiles (
      driver_id INT PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE, profile JSONB, pins TEXT, notes_used INT NOT NULL DEFAULT 0, built_at TIMESTAMPTZ
    );
    -- things in the groups someone should look at
    CREATE TABLE IF NOT EXISTS tg_alerts (
      id SERIAL PRIMARY KEY, chat_id BIGINT, driver_id INT REFERENCES drivers(id) ON DELETE CASCADE, kind TEXT, severity TEXT, text TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ, resolved_by TEXT
    );
    CREATE TABLE IF NOT EXISTS tg_summaries (
      id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, day DATE NOT NULL, summary TEXT, issues JSONB, mood TEXT, messages INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (chat_id, day)
    );
    -- Badge levels each person reached (1 Bronze … 5 Diamond); kept once reached
    CREATE TABLE IF NOT EXISTS user_badges (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge TEXT NOT NULL,
      level INT NOT NULL,
      earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, badge, level)
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS badges_seen BOOLEAN NOT NULL DEFAULT false;
    -- an account the bot made for a dispatcher it saw in the driver groups (his Telegram id); no email or password until an admin gives them
    ALTER TABLE users ADD COLUMN IF NOT EXISTS from_tg BIGINT;
    -- every dispatcher review the AI wrote (the newest is also in tg_people.profile), to see the trend
    -- the case playbook: what to do step by step when something happens on the road; and the cases the bot opened from the groups
    CREATE TABLE IF NOT EXISTS tg_playbooks (id SERIAL PRIMARY KEY, key TEXT UNIQUE, title TEXT NOT NULL, when_text TEXT NOT NULL, steps JSONB NOT NULL DEFAULT '[]', rules JSONB NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'team', active BOOLEAN NOT NULL DEFAULT true, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT);
    CREATE TABLE IF NOT EXISTS tg_cases (id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, driver_id INTEGER REFERENCES drivers(id) ON DELETE CASCADE, playbook_id INTEGER REFERENCES tg_playbooks(id) ON DELETE CASCADE,
      summary TEXT, msg_id BIGINT, opened_at TIMESTAMPTZ NOT NULL DEFAULT now(), done INTEGER[] NOT NULL DEFAULT '{}', step_since TIMESTAMPTZ, warned_step INTEGER, long_warned BOOLEAN NOT NULL DEFAULT false,
      last_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'open', closed_at TIMESTAMPTZ, closed_by TEXT, note TEXT, lesson TEXT);
    CREATE INDEX IF NOT EXISTS tg_cases_open ON tg_cases(status, chat_id);
    -- the first day of a new driver: a short checklist the dispatcher (or the bot, from the group) ticks
    CREATE TABLE IF NOT EXISTS orientation (driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, key TEXT NOT NULL, label TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      done BOOLEAN NOT NULL DEFAULT false, done_at TIMESTAMPTZ, done_by TEXT, PRIMARY KEY (driver_id, key));
    -- shops and services we use (shops, tire, tow, road service, detailing, locksmith...): built by the AI from the groups and by the team
    CREATE TABLE IF NOT EXISTS places (id SERIAL PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'shop', services TEXT[] NOT NULL DEFAULT '{}', phone TEXT, address TEXT, city TEXT, state TEXT, area TEXT, notes TEXT,
      good INTEGER NOT NULL DEFAULT 0, bad INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, last_cost NUMERIC, last_used_at TIMESTAMPTZ, source TEXT NOT NULL DEFAULT 'team', verified BOOLEAN NOT NULL DEFAULT false,
      hidden BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS place_events (id SERIAL PRIMARY KEY, place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE, at TIMESTAMPTZ NOT NULL DEFAULT now(), driver_id INTEGER, chat_id BIGINT, what TEXT, outcome TEXT, cost NUMERIC, by TEXT);
    -- home time: going home, at home, coming back (from the groups); confirmed 2 days before he comes back
    CREATE TABLE IF NOT EXISTS home_time (id SERIAL PRIMARY KEY, driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'planned', leave_on DATE, back_on DATE, needs_ticket BOOLEAN,
      note TEXT, confirm_asked_at TIMESTAMPTZ, confirmed_at TIMESTAMPTZ, late_told_at TIMESTAMPTZ, chat_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS home_time_driver ON home_time(driver_id, status);
    -- signs a working driver may leave (another offer, pay, home time...), from the groups
    CREATE TABLE IF NOT EXISTS tg_leaving (id SERIAL PRIMARY KEY, driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, chat_id BIGINT, at TIMESTAMPTZ NOT NULL DEFAULT now(), kind TEXT, strength TEXT, quote TEXT, dismissed_at TIMESTAMPTZ);
    ALTER TABLE tg_cases ADD COLUMN IF NOT EXISTS cost NUMERIC;
    ALTER TABLE tg_cases ADD COLUMN IF NOT EXISTS place_id INTEGER;
    ALTER TABLE tg_cases ADD COLUMN IF NOT EXISTS city TEXT;
    ALTER TABLE tg_cases ADD COLUMN IF NOT EXISTS state TEXT;
    -- the words our team uses (for the AI); the booking lists the shifts post; update notes in the driver groups; routines done once a shift
    CREATE TABLE IF NOT EXISTS tg_terms (id SERIAL PRIMARY KEY, term TEXT NOT NULL, meaning TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, source TEXT NOT NULL DEFAULT 'team', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS tg_terms_term ON tg_terms (lower(term));
    CREATE TABLE IF NOT EXISTS tg_boards (id SERIAL PRIMARY KEY, chat_id BIGINT, shift TEXT, posted_by TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now(), items JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS tg_shift_notes (id SERIAL PRIMARY KEY, chat_id BIGINT, driver_id INTEGER, by_name TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS tg_shift_notes_driver ON tg_shift_notes(driver_id, at DESC);
    CREATE TABLE IF NOT EXISTS tg_routine (id SERIAL PRIMARY KEY, shift TEXT NOT NULL, day DATE NOT NULL, kind TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (shift, day, kind));
    -- the shift desk: what the bot asked the dispatchers on shift (privately) and what they answered
    CREATE TABLE IF NOT EXISTS tg_checks (id SERIAL PRIMARY KEY, chat_id BIGINT, driver_id INTEGER REFERENCES drivers(id) ON DELETE CASCADE, kind TEXT NOT NULL, quote TEXT, until_at TIMESTAMPTZ, until_text TEXT, place TEXT, ask TEXT,
      state TEXT NOT NULL DEFAULT 'open', asked_at TIMESTAMPTZ, asked_n INTEGER NOT NULL DEFAULT 0, answered_at TIMESTAMPTZ, answered_by TEXT, answer TEXT, escalated INTEGER NOT NULL DEFAULT 0, followed_up BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS tg_check_asks (id SERIAL PRIMARY KEY, check_id INTEGER NOT NULL REFERENCES tg_checks(id) ON DELETE CASCADE, user_id INTEGER, tg_id BIGINT, msg_id BIGINT, chat_id BIGINT, asked_at TIMESTAMPTZ NOT NULL DEFAULT now(), said TEXT, said_at TIMESTAMPTZ);
    -- the reply the bot would send to a driver in onboarding (Watch and learn: shown on the website with a Send button)
    CREATE TABLE IF NOT EXISTS tg_drafts (id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, driver_id INTEGER REFERENCES drivers(id) ON DELETE CASCADE, msg_id BIGINT, driver_text TEXT, draft TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'reply', state TEXT NOT NULL DEFAULT 'open', sent_text TEXT, sent_by TEXT, decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS tg_drafts_driver ON tg_drafts(driver_id, state);
    CREATE TABLE IF NOT EXISTS tg_disp_reviews (id SERIAL PRIMARY KEY, tg_id BIGINT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), profile JSONB NOT NULL, stats JSONB);
    CREATE INDEX IF NOT EXISTS tg_disp_reviews_tg ON tg_disp_reviews(tg_id, at DESC);
    -- Indeed messages the website asks the Chrome extension to send (after a call with no answer).
    -- pending -> sending (an extension took it) -> sent | failed
    CREATE TABLE IF NOT EXISTS indeed_outbox (
      id SERIAL PRIMARY KEY,
      driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      note_id INT REFERENCES notes(id) ON DELETE SET NULL,
      created_by INT REFERENCES users(id) ON DELETE SET NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claimed_by TEXT,
      claimed_at TIMESTAMPTZ,
      done_at TIMESTAMPTZ,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS indeed_outbox_status ON indeed_outbox(status, created_at);
    CREATE INDEX IF NOT EXISTS indeed_outbox_driver ON indeed_outbox(driver_id, created_at);
    CREATE TABLE IF NOT EXISTS days_off (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      reason TEXT,
      set_by INT REFERENCES users(id) ON DELETE SET NULL,
      set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, day)
    );
    -- the carriers the drivers are dispatched for; each truck and each driver belongs to one
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      mc TEXT, dot TEXT, notes TEXT,
      color INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS companies_name ON companies(lower(name));
    ALTER TABLE trucks ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE SET NULL;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE SET NULL;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS exp_years NUMERIC(4,1); -- years of CDL-A driving
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS experience TEXT;        -- what they drove: freight, routes, past carriers
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS truck_year INT;         -- owner-operators: their own truck
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS truck_model TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS weeks_out NUMERIC(3,1);  -- how long they will stay out before going home
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS days_home INT;           -- and how many days home after that
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cdl_expires DATE;        -- active drivers: document expiry dates only, never license numbers
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS med_expires DATE;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS out_since DATE;          -- when the current stretch on the road began
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS left_on DATE;            -- a hired driver who left: no longer active
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS left_reason TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS relay_before BOOLEAN;      -- ran Amazon Relay loads before: yes / no / not known yet
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS amazon_step TEXT;          -- where the driver is with Amazon Relay (AMAZON keys)
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS amazon_log JSONB NOT NULL DEFAULT '{}'::jsonb; -- step -> when it was reached
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS lost_note TEXT;            -- the recruiter's words on why a lead was lost
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS call_prep JSONB;          -- AI call suggestions for this lead (optional)
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS call_prep_at TIMESTAMPTZ;
  `);
  // ----- fleet: each truck's own profile -----
  await q(`
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS share_moves INT NOT NULL DEFAULT 0;
    -- how the bot works in an onboarding group: watch (reads, sums up, learns; never writes), assist (answers questions), run (the whole onboarding)
    ALTER TABLE onb_cases ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'watch';
    ALTER TABLE onb_cases ALTER COLUMN mode SET DEFAULT 'watch';
    ALTER TABLE onb_cases ADD COLUMN IF NOT EXISTS ai_status JSONB;     -- the AI's view of where the onboarding stands
    ALTER TABLE onb_cases ADD COLUMN IF NOT EXISTS ai_status_at TIMESTAMPTZ;
    -- onboarding steps the AI saw done in the conversation: suggested until a person confirms or rejects (or done by itself when trusted)
    CREATE TABLE IF NOT EXISTS onb_ai_steps (id SERIAL PRIMARY KEY, driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, checklist_id INT REFERENCES checklist(id) ON DELETE CASCADE,
      label TEXT NOT NULL, evidence TEXT, state TEXT NOT NULL DEFAULT 'suggested', at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_by TEXT, decided_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS onb_ai_steps_driver ON onb_ai_steps(driver_id, state);
    -- messages brought in from a Telegram export (before the bot joined): read for notes and learning, never acted on
    ALTER TABLE tg_messages ADD COLUMN IF NOT EXISTS imported BOOLEAN NOT NULL DEFAULT false;
    -- the MVR and the drug test: CDL state, last 4 of the SSN (Pennsylvania MVR; deleted after 30 days), the private link code
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS license_state TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ssn4 TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ssn4_at TIMESTAMPTZ;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ssn4_code TEXT;
    ALTER TABLE onb_cases ADD COLUMN IF NOT EXISTS asked JSONB NOT NULL DEFAULT '{}'::jsonb;
    -- the driver said in the group he is not coming (the AI's read; the team confirms "Dropped out" or "Still with us")
    ALTER TABLE onb_cases ADD COLUMN IF NOT EXISTS drop_flag JSONB;
    ALTER TABLE onb_cases ADD COLUMN IF NOT EXISTS drop_dismissed_at TIMESTAMPTZ;
    -- who set the start date and travel details: 'ai' (from the Telegram group; the AI may change it again) or NULL (the team)
    ALTER TABLE onboarding ADD COLUMN IF NOT EXISTS arrival_by TEXT;
    -- a working driver's group: how many people are in it, and how the bot works there (watch = learn quietly; updater = also writes)
    ALTER TABLE tg_chats ADD COLUMN IF NOT EXISTS member_count INTEGER;
    -- a group pushed out when another group was linked as the same kind for the same driver (so a mistake can be undone)
    ALTER TABLE tg_chats ADD COLUMN IF NOT EXISTS prev_kind TEXT;
    ALTER TABLE tg_chats ADD COLUMN IF NOT EXISTS prev_driver_id INTEGER;
    ALTER TABLE tg_chats ADD COLUMN IF NOT EXISTS displaced_by BIGINT;
    -- what the AI costs: one row per call from the website / bot, daily totals from each Chrome profile
    CREATE TABLE IF NOT EXISTS ai_usage (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), day DATE NOT NULL, source TEXT NOT NULL, feature TEXT NOT NULL, model TEXT NOT NULL, account TEXT,
      calls INTEGER NOT NULL DEFAULT 1, failed INTEGER NOT NULL DEFAULT 0, input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0, cache_read BIGINT NOT NULL DEFAULT 0, cache_write BIGINT NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS ai_usage_day ON ai_usage(day);
    -- why AI calls failed (the last 300), in plain words for the AI usage page
    CREATE TABLE IF NOT EXISTS ai_errors (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), source TEXT, feature TEXT, model TEXT, status INTEGER, kind TEXT, message TEXT, why TEXT, tries INTEGER);
    -- papers the team uploads: the driver's CDL (and medical card), each truck's registration and paperwork.
    -- Kept for the team and shared in the ELD group only when someone types /info there.
    CREATE TABLE IF NOT EXISTS docs (id SERIAL PRIMARY KEY, driver_id INTEGER REFERENCES drivers(id) ON DELETE CASCADE, truck_id INTEGER REFERENCES trucks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BYTEA NOT NULL, uploaded_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS docs_driver ON docs(driver_id);
    CREATE INDEX IF NOT EXISTS docs_truck ON docs(truck_id);
    -- a working driver's group: the load updates seen in the chat (where the driver is with a load)
    CREATE TABLE IF NOT EXISTS tg_updates (id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, driver_id INTEGER, msg_id BIGINT, at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL, place TEXT, eta TEXT, load_ref TEXT, by_role TEXT, text TEXT);
    CREATE INDEX IF NOT EXISTS tg_updates_driver ON tg_updates(driver_id, at DESC);
    ALTER TABLE tg_updates ADD COLUMN IF NOT EXISTS checked TEXT; -- the team: ok / wrong (how often the AI reads updates right)
    -- what the driver said he would do ("I'll be there at 6", "ETA 4 PM"), and whether he did
    CREATE TABLE IF NOT EXISTS tg_promises (id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, driver_id INTEGER, msg_id BIGINT, at TIMESTAMPTZ NOT NULL DEFAULT now(), what TEXT NOT NULL, due TEXT,
      state TEXT NOT NULL DEFAULT 'open', evidence TEXT, closed_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS tg_promises_driver ON tg_promises(driver_id, at DESC);
    -- how each dispatcher works, written by the AI from their messages (admins only)
    ALTER TABLE tg_people ADD COLUMN IF NOT EXISTS profile JSONB;
    ALTER TABLE tg_people ADD COLUMN IF NOT EXISTS profile_at TIMESTAMPTZ;
    ALTER TABLE tg_people ADD COLUMN IF NOT EXISTS profile_msgs INTEGER;
    CREATE UNIQUE INDEX IF NOT EXISTS tg_updates_msg ON tg_updates(chat_id, msg_id, status) WHERE msg_id IS NOT NULL;
    ALTER TABLE tg_chats ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'watch';
    ALTER TABLE onboarding ADD COLUMN IF NOT EXISTS note_by TEXT;
    -- the bot's history: what it did, and how people reacted (buttons, emoji, replies)
    CREATE TABLE IF NOT EXISTS tg_log (id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), chat_id BIGINT, driver_id INTEGER, kind TEXT NOT NULL, text TEXT NOT NULL, who_tg BIGINT, who TEXT);
    CREATE INDEX IF NOT EXISTS tg_log_at ON tg_log(at DESC);
    CREATE INDEX IF NOT EXISTS tg_log_chat ON tg_log(chat_id, at DESC);
    -- team work waiting for someone who has not connected their Telegram to the website (a group to connect)
    CREATE TABLE IF NOT EXISTS tg_waiting (id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, tg_id BIGINT, who TEXT, driver_id INTEGER, kind TEXT, what TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), done_at TIMESTAMPTZ, done_by TEXT, done_how TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS tg_waiting_open ON tg_waiting(chat_id) WHERE done_at IS NULL;
    -- answers the AI picked up from the team's own replies: waiting for an admin to approve before the bot uses them
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS review BOOLEAN NOT NULL DEFAULT false;
    -- the knowledge base: topic, how often it came up and in which groups, other ways it was said, place (for site facts)
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS topic TEXT;
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS seen INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS chats BIGINT[] NOT NULL DEFAULT '{}';
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS variants JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS place_key TEXT;
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS city TEXT;
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS state TEXT;
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS conflict_note TEXT;
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS approved_by TEXT;
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS tidied BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
    ALTER TABLE tg_knowledge ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false;
    -- dispatcher levels (1 updates, 2 booking, 3 senior): which shift desk questions each one gets
    ALTER TABLE users ADD COLUMN IF NOT EXISTS dispatch_level INTEGER;
    -- errors nobody caught (the last 500): Settings → Backups and data
    CREATE TABLE IF NOT EXISTS server_errors (id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), kind TEXT NOT NULL, place TEXT, message TEXT, stack TEXT);
    ALTER TABLE tg_checks ADD COLUMN IF NOT EXISTS level INTEGER;
    CREATE INDEX IF NOT EXISTS tg_knowledge_kind ON tg_knowledge (kind, active);
    -- a truck filled: its driver started (hired) in it; the recruiter whose driver it is gets the credit
    CREATE TABLE IF NOT EXISTS truck_fills (id SERIAL PRIMARY KEY, truck_id INT REFERENCES trucks(id) ON DELETE SET NULL, driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL, unit TEXT, driver_name TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (truck_id, driver_id));
    CREATE INDEX IF NOT EXISTS truck_fills_at ON truck_fills(at);
    -- a recruiter's plan for the day, written in the morning
    CREATE TABLE IF NOT EXISTS day_plans (user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day DATE NOT NULL, goal TEXT NOT NULL, items JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, day));
    -- coaching: one concrete tip from a manager, about a lead or a call
    CREATE TABLE IF NOT EXISTS coaching (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, by_id INT REFERENCES users(id) ON DELETE SET NULL,
      driver_id INT REFERENCES drivers(id) ON DELETE SET NULL, tip TEXT NOT NULL, kind TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now(), seen_at TIMESTAMPTZ, reply TEXT);
    CREATE INDEX IF NOT EXISTS coaching_user ON coaching(user_id, at DESC);
    -- a call started from the website (the phone link) that still needs its outcome logged
    CREATE TABLE IF NOT EXISTS call_starts (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(), logged_at TIMESTAMPTZ, nudged_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS call_starts_open ON call_starts(user_id) WHERE logged_at IS NULL;
    -- a call-back the driver asked for: when, his words, his time zone, who set it (AI or a person), due / done / missed
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS callback_at TIMESTAMPTZ;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS callback_said TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS callback_tz TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS callback_by TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS callback_key TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS callback_state TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS callback_reminded SMALLINT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS drivers_callback ON drivers(callback_at) WHERE callback_state = 'due';   -- times a lead was moved from an away recruiter
    CREATE INDEX IF NOT EXISTS activity_driver ON activity(driver_id, type) WHERE driver_id IS NOT NULL;
    ALTER TABLE trucks ADD COLUMN IF NOT EXISTS odometer INT;                 -- the latest mileage we know
    ALTER TABLE trucks ADD COLUMN IF NOT EXISTS odometer_at TIMESTAMPTZ;
    ALTER TABLE trucks ADD COLUMN IF NOT EXISTS oil_miles INT;                -- oil change every N miles (NULL = fleet setting)
    ALTER TABLE trucks ADD COLUMN IF NOT EXISTS oil_days INT;                 -- or every N days
    ALTER TABLE trucks ADD COLUMN IF NOT EXISTS dispatcher_id INT REFERENCES users(id) ON DELETE SET NULL; -- who looks after it
    ALTER TABLE trucks ADD COLUMN IF NOT EXISTS vin TEXT;
    ALTER TABLE trucks ADD COLUMN IF NOT EXISTS plate TEXT;
    ALTER TABLE truck_events ADD COLUMN IF NOT EXISTS paid BOOLEAN;            -- the shop is paid: yes / no / not known
    ALTER TABLE truck_events ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
    ALTER TABLE truck_events ADD COLUMN IF NOT EXISTS done_on DATE;            -- the day the work was done
    -- who drove the truck, which company it was under, in and out of service: written by the database on every change
    CREATE TABLE IF NOT EXISTS truck_history (
      id SERIAL PRIMARY KEY, truck_id INT NOT NULL REFERENCES trucks(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      from_text TEXT, to_text TEXT, from_id INT, to_id INT, at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS truck_history_truck ON truck_history(truck_id, at);
    -- an oil change reminder is sent once per truck and state (soon / overdue) per oil change
    CREATE TABLE IF NOT EXISTS truck_reminders (truck_id INT NOT NULL REFERENCES trucks(id) ON DELETE CASCADE, key TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (truck_id, key));
    CREATE OR REPLACE FUNCTION truck_history_log() RETURNS trigger AS $$
    DECLARE a TEXT; b TEXT;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO truck_history (truck_id, kind, to_text) VALUES (NEW.id, 'added', NEW.unit);
        IF NEW.company_id IS NOT NULL THEN INSERT INTO truck_history (truck_id, kind, to_id, to_text) VALUES (NEW.id, 'company', NEW.company_id, (SELECT name FROM companies WHERE id = NEW.company_id)); END IF;
        IF NEW.driver_id IS NOT NULL OR NEW.driver_name IS NOT NULL THEN INSERT INTO truck_history (truck_id, kind, to_id, to_text) VALUES (NEW.id, 'driver', NEW.driver_id, coalesce((SELECT name FROM drivers WHERE id = NEW.driver_id), NEW.driver_name)); END IF;
        RETURN NEW;
      END IF;
      IF NEW.driver_id IS DISTINCT FROM OLD.driver_id OR NEW.driver_name IS DISTINCT FROM OLD.driver_name THEN
        a := coalesce((SELECT name FROM drivers WHERE id = OLD.driver_id), OLD.driver_name); b := coalesce((SELECT name FROM drivers WHERE id = NEW.driver_id), NEW.driver_name);
        IF a IS DISTINCT FROM b THEN INSERT INTO truck_history (truck_id, kind, from_id, to_id, from_text, to_text) VALUES (NEW.id, 'driver', OLD.driver_id, NEW.driver_id, a, b); END IF;
      END IF;
      IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
        INSERT INTO truck_history (truck_id, kind, from_id, to_id, from_text, to_text) VALUES (NEW.id, 'company', OLD.company_id, NEW.company_id, (SELECT name FROM companies WHERE id = OLD.company_id), (SELECT name FROM companies WHERE id = NEW.company_id));
      END IF;
      IF NEW.out_of_service IS DISTINCT FROM OLD.out_of_service THEN
        INSERT INTO truck_history (truck_id, kind, to_text) VALUES (NEW.id, 'service', CASE WHEN NEW.out_of_service THEN 'out' ELSE 'in' END);
      END IF;
      IF NEW.dispatcher_id IS DISTINCT FROM OLD.dispatcher_id THEN
        INSERT INTO truck_history (truck_id, kind, from_id, to_id, from_text, to_text) VALUES (NEW.id, 'dispatcher', OLD.dispatcher_id, NEW.dispatcher_id, (SELECT name FROM users WHERE id = OLD.dispatcher_id), (SELECT name FROM users WHERE id = NEW.dispatcher_id));
      END IF;
      IF NEW.unit IS DISTINCT FROM OLD.unit THEN INSERT INTO truck_history (truck_id, kind, from_text, to_text) VALUES (NEW.id, 'unit', OLD.unit, NEW.unit); END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trucks_history ON trucks;
    CREATE TRIGGER trucks_history AFTER INSERT OR UPDATE ON trucks FOR EACH ROW EXECUTE FUNCTION truck_history_log();
    -- trucks from before this version start their history with what they have now
    INSERT INTO truck_history (truck_id, kind, to_id, to_text, at)
      SELECT t.id, 'driver', t.driver_id, coalesce(d.name, t.driver_name), t.updated_at FROM trucks t LEFT JOIN drivers d ON d.id = t.driver_id
      WHERE (t.driver_id IS NOT NULL OR t.driver_name IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM truck_history h WHERE h.truck_id = t.id);
    INSERT INTO truck_history (truck_id, kind, to_id, to_text, at)
      SELECT t.id, 'company', t.company_id, c.name, t.created_at FROM trucks t JOIN companies c ON c.id = t.company_id
      WHERE NOT EXISTS (SELECT 1 FROM truck_history h WHERE h.truck_id = t.id AND h.kind = 'company');
    -- a truck with only a driver's name typed in: link it to the active driver with that name (one each, no truck yet)
    UPDATE trucks t SET driver_id = d.id, driver_name = NULL FROM drivers d
      WHERE t.driver_id IS NULL AND t.driver_name IS NOT NULL AND d.status = 'Hired' AND d.left_on IS NULL AND lower(trim(d.name)) = lower(trim(t.driver_name))
        AND NOT EXISTS (SELECT 1 FROM trucks x WHERE x.driver_id = d.id)
        AND (SELECT count(*) FROM drivers d2 WHERE d2.status = 'Hired' AND d2.left_on IS NULL AND lower(trim(d2.name)) = lower(trim(t.driver_name))) = 1
        AND (SELECT count(*) FROM trucks t2 WHERE t2.driver_id IS NULL AND lower(trim(t2.driver_name)) = lower(trim(t.driver_name))) = 1;
  `);
  // One-time clean-up of rows from before this version. It must never run again: later, a lead added by hand
  // (say from Facebook) can also pick up an Indeed account, and must keep its own source.
  const ran = (await q(`SELECT value FROM settings WHERE key = 'upgrades'`)).rows[0];
  const up = ran ? ran.value : {};
  if (!up.sources) {
    // Where a lead came from is now a short list (Indeed, Facebook, Referral…). Older rows kept the
    // extension's wording there; move that wording to the detail and file them under Indeed.
    await q(`UPDATE drivers SET source_detail = COALESCE(source_detail, source), source = 'Indeed'
      WHERE source IS NOT NULL AND source <> 'Indeed' AND (source ILIKE '%indeed%' OR source ILIKE '%matched candidate%' OR account IS NOT NULL OR cardinality(conv_ids) > 0)`);
    await q(`UPDATE drivers SET source = 'Indeed' WHERE source IS NULL AND (account IS NOT NULL OR cardinality(conv_ids) > 0)`);
    await q(`UPDATE drivers SET source = 'Other', source_detail = COALESCE(source_detail, 'Added by hand') WHERE source = 'Added by hand'`);
    // An invite with no reply is not a lead yet. lead_at = when someone first answered or was added by hand.
    await q(`UPDATE drivers SET lead_at = created_at WHERE lead_at IS NULL AND status <> 'Invited'`);
    up.sources = true;
    await q(`INSERT INTO settings (key, value) VALUES ('upgrades', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(up)]);
  }
  if (!up.relayBefore) {
    // "Ran Amazon Relay before" from what drivers already answered in the chat
    for (const r of (await q(`SELECT id, answers->>'relay' t FROM drivers WHERE relay_before IS NULL AND answers ? 'relay'`)).rows) {
      const v = relayFrom(r.t); if (v !== null) await q(`UPDATE drivers SET relay_before = $2 WHERE id = $1`, [r.id, v]);
    }
    up.relayBefore = true;
    await q(`INSERT INTO settings (key, value) VALUES ('upgrades', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(up)]);
  }
  if (!up.amazon) {
    // Amazon steps for drivers from before they existed: a ticked "Amazon Relay verified" means verified;
    // otherwise the Relay status (or being in onboarding) tells how far they got.
    await q(`UPDATE checklist SET auto = 'amazon' WHERE key = 'relay' AND auto IS NULL`);
    await q(`UPDATE drivers d SET amazon_step = 'verified' WHERE amazon_step IS NULL AND EXISTS (SELECT 1 FROM checklist c WHERE c.driver_id = d.id AND c.key = 'relay' AND c.done)`);
    await q(`UPDATE drivers SET amazon_step = 'profile' WHERE amazon_step IS NULL AND status IN ('Signed up on Relay', 'Onboarding', 'Hired')`);
    await q(`UPDATE drivers SET amazon_step = 'invite' WHERE amazon_step IS NULL AND status = 'Relay invite sent'`);
    const cl = (await q(`SELECT value FROM settings WHERE key = 'checklist'`)).rows[0];
    if (cl && Array.isArray(cl.value)) await q(`UPDATE settings SET value = $1::jsonb WHERE key = 'checklist'`, [JSON.stringify(cl.value.map((x) => (x.key === 'relay' && !x.auto ? { ...x, auto: 'amazon' } : x)))]);
    up.amazon = true;
    await q(`INSERT INTO settings (key, value) VALUES ('upgrades', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(up)]);
  }
  if (!up.eldMode) {
    // ELD / accounting groups: silent ('watch') for drivers already working, the setup keeps running ('updater') for the rest
    await q(`UPDATE tg_chats c SET mode = CASE WHEN d.status = 'Hired' THEN 'watch' ELSE 'updater' END
      FROM drivers d WHERE d.id = c.driver_id AND c.kind IN ('eld', 'accounting')`).catch((e) => console.error('eld mode', e.message));
    up.eldMode = true;
    await q(`INSERT INTO settings (key, value) VALUES ('upgrades', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(up)]);
  }
  if (!up.onbWatch) {
    // new onboarding groups start in "Watch and learn" (it was "Run")
    await q(`UPDATE settings SET value = jsonb_set(value, '{onbMode}', '"watch"') WHERE key = 'tg' AND value->>'onbMode' = 'run'`);
    up.onbWatch = true;
    await q(`INSERT INTO settings (key, value) VALUES ('upgrades', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(up)]);
  }
  if (!up.paperwork) {
    const NEW = [['contract_sent', 'Contract sent (safety team)'], ['contract_signed', 'Contract signed by the driver'], ['ch_registered', 'Clearinghouse: driver registered'], ['ch_query', 'Clearinghouse: query sent (safety team)'], ['ch_consent', 'Clearinghouse: driver gave consent, query clear']];
    const cl = (await q(`SELECT value FROM settings WHERE key = 'checklist'`)).rows[0];
    if (cl && Array.isArray(cl.value)) {
      const list = cl.value.filter((x) => !NEW.some(([k]) => k === x.key)); const at = Math.max(0, list.findIndex((x) => x.key === 'mvr') + 1) || list.length;
      list.splice(at, 0, ...NEW.map(([key, label]) => ({ key, label })));
      await q(`UPDATE settings SET value = $1::jsonb WHERE key = 'checklist'`, [JSON.stringify(list)]);
    }
    const tpl = cl && Array.isArray(cl.value) ? (await q(`SELECT value FROM settings WHERE key = 'checklist'`)).rows[0].value : DEFAULTS.checklist;
    for (const { id } of (await q(`SELECT d.id FROM drivers d JOIN onboarding o ON o.driver_id = d.id WHERE d.status = 'Onboarding'`)).rows) {
      let i = 0; for (const it of tpl) await q(`INSERT INTO checklist (driver_id, key, label, position, auto) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (driver_id, key) DO UPDATE SET position = EXCLUDED.position`, [id, it.key, it.label, i++, it.auto || null]);
    }
    up.paperwork = true;
    await q(`INSERT INTO settings (key, value) VALUES ('upgrades', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(up)]);
  }
  if (!up.quietNotices) {
    // the re-read of old group messages sent a notification for every old change: mark those as seen (they stay in the bot history)
    await q(`UPDATE notices SET seen_at = now() WHERE kind = 'tg' AND seen_at IS NULL AND created_at > now() - interval '12 hours' AND text NOT LIKE '%says he is not coming%'`).catch((e) => console.error('quiet notices', e.message));
    up.quietNotices = true;
    await q(`INSERT INTO settings (key, value) VALUES ('upgrades', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(up)]);
  }
  if (!up.reread) {
    // reading the groups never worked (Sonnet 5.5 refused the forced tool call), and failed batches were marked as read:
    // put the last 14 days back so the bot reads them now
    const ever = (await q(`SELECT 1 FROM ai_usage WHERE feature = 'group_digest' AND failed = 0 AND calls > 0 LIMIT 1`)).rows[0];
    if (!ever) await q(`UPDATE tg_messages SET digested = false WHERE digested AND at > now() - interval '14 days'`).catch((e) => console.error('reread', e.message));
    up.reread = true;
    await q(`INSERT INTO settings (key, value) VALUES ('upgrades', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(up)]);
  }
  if (!up.placesSites) {
    // Shops & services is for shops and services only: Amazon facilities and customer sites move to the knowledge base
    try { const n = await require('./places').cleanup(); if (n) console.log(`Moved ${n} sites from Shops & services to the knowledge base`); } catch (e) { console.error('places cleanup', e.message); }
    up.placesSites = true;
    await q(`INSERT INTO settings (key, value) VALUES ('upgrades', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(up)]);
  }
  if (!up.kb) {
    // the knowledge base: give the old entries a topic and their group; the AI tidy cleans them up over the next hours
    await require('./kb').backfill().catch((e) => console.error('kb backfill', e.message));
    up.kb = true;
    await q(`INSERT INTO settings (key, value) VALUES ('upgrades', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(up)]);
  }
  await loadSettings();
  await addWorkedAt(pool);
}

// ---------- settings (kept in memory, saved in the database) ----------
const DEFAULTS = {
  tz: 'America/New_York',     // the business day: "today" on every report starts at midnight here
  visibility: 'all',          // 'all' = recruiters see every lead; 'own' = only their own and unassigned ones
  sources: ['Indeed', 'Facebook', 'Referral', 'Craigslist', 'TruckersReport', 'Phone call', 'Walk-in', 'Other'],
  checklist: [
    { key: 'telegram', label: 'Telegram group created', auto: 'telegram' },
    { key: 'relay', label: 'Amazon Relay verified', auto: 'amazon' },
    { key: 'insurance', label: 'Insurance approved' },
    { key: 'mvr', label: 'MVR checked' },
    { key: 'contract_sent', label: 'Contract sent (safety team)' },
    { key: 'contract_signed', label: 'Contract signed by the driver' },
    { key: 'ch_registered', label: 'Clearinghouse: driver registered' },
    { key: 'ch_query', label: 'Clearinghouse: query sent (safety team)' },
    { key: 'ch_consent', label: 'Clearinghouse: driver gave consent, query clear' },
    { key: 'truck', label: 'Truck assigned', auto: 'truck' },
    { key: 'arrival_date', label: 'Arrival date set', auto: 'arrival' },
    { key: 'arrived', label: 'Driver arrived', auto: 'arrived' },
    { key: 'eld_group', label: 'ELD group set up' },
    { key: 'eld_profile', label: 'ELD profile set up' },
    { key: 'acct_group', label: 'Accounting group set up' },
    { key: 'bank', label: 'Bank details taken by accounting' }
  ],
  // Working hours in the team time zone. week[0] is Sunday; null = not a working day.
  // A working day counts as worked with at least minMinutes of active time; starting more than grace minutes late is a late start.
  // Facebook daily targets for each recruiter (0 = not asked for)
  // ppost / pcomment: personal activity (own profile, posts that are not about the job), so Facebook does not limit the account
  fbTargets: { picture: 5, post: 5, comment: 15, contact: 20, chat: 2, ppost: 1, pcomment: 5 },
  // Trucks: an oil change every oilMiles or oilDays, whichever comes first; "due soon" warnMiles / warnDays before.
  // askDriver: when it is due, the bot asks for the mileage in the driver's dispatch group.
  // the first day of a new driver (Orientation day): made when he arrives
  orientation: [
    { key: 'or_truck', label: 'Truck handed over: walk-around, keys, papers in the truck' },
    { key: 'or_eld', label: 'ELD works: he logged in on the tablet' },
    { key: 'or_fuel', label: 'Fuel card given, PIN works' },
    { key: 'or_relay', label: 'Amazon Relay app signed in on his phone' },
    { key: 'or_tolls', label: 'Toll transponder / PrePass checked' },
    { key: 'or_safety', label: 'Safety talk: rules, accidents, breakdowns, who to call' },
    { key: 'or_pay', label: 'Pay, settlements and home time explained once more' },
    { key: 'or_load', label: 'First load assigned' }
  ],
  backup: { tg: false, hour: 3 }, // the nightly backup to the admins in Telegram (off until an admin turns it on)
  data: { keepMessagesDays: 0 },  // delete raw group messages older than this (0 = keep forever, else 30+)
  ai: { budget: 0, dailyCap: 20 }, // dailyCap: the AI stops for the day at this cost in USD (0 = no cap)
  //          // AI cost: a monthly budget in USD (0 = none); admins are told at 80% and 100%
  aiPrices: {},               // USD per million tokens per model, over the built-in list (ai-usage.js)
  fleet: { oilMiles: 25000, oilDays: 90, warnMiles: 2500, warnDays: 10, askDriver: false, costLease: 5000, costInsurance: 2000, costOther: 1000 },
  // trucks the team means to fill each month: { '2026-11': 6 }; a month not set aims at the trucks empty when it started
  fillGoals: {},
  // Telegram bot: ELD team checks after the setup (times in the team's time zone, for how many days; 0 = always),
  // a second tag if nobody answers after remindMin, and the daily AI summary of each group
  // onbMode: how the bot starts in a new onboarding group (watch / assist / run); autoTick: the AI ticks onboarding steps itself
  tg: { eldTimes: ['11:00', '18:00'], eldDays: 14, remindMin: 90, summaryAt: '21:00', eldTeam: [], autoPhone: true, workMode: 'watch', onbMode: 'watch', autoTick: false, readEvery: 25, autoAccounts: true, kbAuto: true,
    // the shift desk: who is on shift (team time zone), where the bot asks (private chat with the bot, or the group), minutes before asking the others
    desk: { on: true, where: 'private', answerMin: 15, hubs: ['Chambersburg', 'Baltimore', 'Hazleton', 'Kearny'], routines: { board: true, boardMin: 45, notes: true, notesMin: 45 }, shifts: [{ name: 'Day', start: '06:00', end: '14:00', people: [] }, { name: 'Evening', start: '14:00', end: '22:00', people: [] }, { name: 'Night', start: '22:00', end: '06:00', people: [] }] } },
  // After a call with no answer (or a voicemail), the Chrome extension sends this Indeed message to the driver.
  // {first} = the driver's first name, {me} = the first name of the person who called.
  noAnswer: { on: true, text: "Hi {first}, this is {me} from the recruiting team. I just tried to call you about the driving job. When is a good time to talk? You can also answer here." },
  // New leads are shared evenly between recruiters (people: null = every active recruiter who is not an admin)
  // onlyOnline: new leads only to recruiters working right now; moveAfter: minutes before an unopened lead leaves an away recruiter (0 = never)
  share: { on: true, people: null, onlyOnline: true, moveAfter: 60 },
  // What a recruiter mentions on a call (Settings, Call guide). From the company facts the Chrome extension's AI uses.
  callPoints: {
    company: [
      'Regional Amazon freight in the Northeast: NJ, PA, DE, MD and VA. Mostly power-only drop and hook, 3 to 4 loads a day, 80 to 200 miles each.',
      'Pay is 25% of each load to start and 30% after 90 days, paid every Friday. A normal week grosses $7,000 to $10,500, so $1,750 to $2,600 for the driver at 25%.',
      'We pay for the truck, fuel, insurance, maintenance and tolls. The only deduction is escrow: $250 a week up to $2,500, all returned when you leave.',
      'Automatic Freightliner sleeper, 2022 or newer. We send photos of the actual truck first and book your flight to it.',
      'No classroom and no unpaid orientation. The only wait is Amazon\'s own background check through the Relay invite.'
    ],
    owner: [
      'You keep your truck and choose your loads: no forced dispatch, no forced home time. Dispatch works 24/7, nights and weekends too.',
      'Dispatch fee by weekly gross: 11% under $5,000, 13% from $5,000 to $8,000, 15% over $8,000. Settlements every week.',
      'We can provide insurance ($2,100 a month), ELD ($50 a week), a fuel card, plates, PrePass and IFTA filing.',
      'A new MC can lease on under ours. Amazon runs its own background check through the Relay invite.'
    ]
  },
  hours: { week: [null, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, { s: '09:00', e: '18:00' }, null], minMinutes: 30, grace: 15, idleMinutes: 15, idleAlert: 60 }
};
const settings = { ...DEFAULTS };
async function loadSettings() {
  const r = await q(`SELECT key, value FROM settings`);
  Object.assign(settings, DEFAULTS);
  const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
  // a saved group of settings gets any newer default keys it does not have yet (e.g. idle minutes in working hours)
  for (const row of r.rows) if (row.key in DEFAULTS) settings[row.key] = plain(DEFAULTS[row.key]) && plain(row.value) ? { ...DEFAULTS[row.key], ...row.value } : row.value;
}
async function saveSetting(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && DEFAULTS[key] && typeof DEFAULTS[key] === 'object' && !Array.isArray(DEFAULTS[key])) value = { ...DEFAULTS[key], ...value };
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
  settings[key] = value;
}

// ---------- passwords and tokens ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${h}`;
}
function checkPassword(pw, stored) {
  const [, salt, h] = String(stored || '').split('$');
  if (!salt || !h) return false;
  const got = crypto.scryptSync(String(pw), salt, 64);
  const want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const token = (prefix = '') => prefix + crypto.randomBytes(24).toString('base64url');

// ---------- driver records ----------
// Amazon Relay, step by step: our company account sends the invite, the driver makes an Amazon account and fills in
// the Relay profile, Accurate (accurate.com) runs the background check, then Amazon verifies the driver.
const AMAZON = [
  { key: 'invite', label: 'Invite sent', long: 'Relay invite sent from our Amazon account' },
  { key: 'account', label: 'Amazon account', long: 'Driver created their Amazon account' },
  { key: 'profile', label: 'Profile done', long: 'Driver signed up and finished the Relay profile' },
  { key: 'accurate', label: 'Background check', long: 'Background check started at Accurate (accurate.com)' },
  { key: 'waiting', label: 'Waiting for Amazon', long: 'Waiting for Amazon to verify the driver' },
  { key: 'verified', label: 'Verified', long: 'Verified by Amazon' }
];
// A notification for one person. With merge, an unread one of the same kind about the same lead is
// brought up to date instead of adding another (a chatty driver makes one notification, not ten).
async function notify(c, userId, kind, text, link, { driverId = null, merge = false } = {}) {
  if (!userId) return;
  const u = (await c.query(`SELECT 1 FROM users WHERE id = $1 AND active`, [userId])).rows[0]; if (!u) return;
  if (merge && driverId) {
    const r = await c.query(`UPDATE notices SET text = $4, created_at = now() WHERE id = (SELECT id FROM notices WHERE user_id = $1 AND kind = $2 AND driver_id = $3 AND seen_at IS NULL ORDER BY id DESC LIMIT 1) RETURNING id`, [userId, kind, driverId, String(text).slice(0, 400)]);
    if (r.rows[0]) return;
  }
  await c.query(`INSERT INTO notices (user_id, kind, text, link, driver_id) VALUES ($1, $2, $3, $4, $5)`, [userId, kind, String(text).slice(0, 400), link || null, driverId]);
}
// The driver's answer to "Ever pulled loads on Amazon Relay before?" -> true / false / null (can't tell)
function relayFrom(text) {
  const t = String(text || '').toLowerCase(); if (!t.trim()) return null;
  const no = /\b(no|nope|nah|never|not yet|haven'?t|have not|havent|first time|new to (it|relay|amazon)|didn'?t|did not)\b/.test(t);
  const yes = /\b(yes|yeah|yea|yep|yup|sure|i have|i did|did it|ran|run|pulled|worked|work(ing)? (on|with|for)|currently|been on|have an? (relay|account)|years?|months?)\b/.test(t);
  if (no && !/\byes|yeah|yep\b/.test(t)) return false;
  if (yes) return true;
  return null;
}
const amazonIdx = (k) => AMAZON.findIndex((x) => x.key === k);
// Move the Amazon step forward (never back) and log when each step was reached.
async function amazonTo(c, driverId, key, userId) {
  const d = (await c.query(`SELECT amazon_step, amazon_log FROM drivers WHERE id = $1`, [driverId])).rows[0];
  if (!d || amazonIdx(key) < 0 || amazonIdx(key) <= amazonIdx(d.amazon_step)) return false;
  await c.query(`UPDATE drivers SET amazon_step = $2, amazon_log = amazon_log || jsonb_build_object($2::text, now()) WHERE id = $1`, [driverId, key]);
  await syncAuto(c, driverId, userId);
  return true;
}
const LOCKING = ['Relay invite sent', 'Onboarding', 'Hired', 'Rejected']; // set by a person: the auto-reply must not change these
const ROUTE = ['Invited', 'Replied', 'Interested', 'Email collected', 'Relay invite sent', 'Signed up on Relay', 'Onboarding', 'Hired'];
const OTHER = ['Review', 'Stalled', 'No CDL', 'Not interested', 'Declined on Indeed', 'Rejected'];
const ORDER = ROUTE.concat(OTHER);
const ACTIVE = ['Replied', 'Interested', 'Email collected', 'Relay invite sent', 'Signed up on Relay', 'Review']; // leads a recruiter should be working
const LOST = ['No CDL', 'Not interested', 'Declined on Indeed', 'Rejected'];
const FRESH = ['Invited', 'Replied', 'Interested', 'Email collected', 'Review']; // new leads: before anyone sent the Relay invite
// The five stages recruiters work in. They are worked out from the status, which stays as it is (the extension, reports and bot use it).
//   New         given to this recruiter and not worked since. A lead given to someone else is new again.
//   In process  the recruiter talked to the driver, wrote down what they learned, or moved the lead on (worked_at)
//   Red zone    not interested, declined, rejected, no CDL, stalled
const RED = [...LOST, 'Stalled'];
const STAGES = ['new', 'process', 'onboarding', 'hired', 'red'];
const stageSql = (a = 'd') => `(CASE WHEN ${a}.status = 'Onboarding' THEN 'onboarding' WHEN ${a}.status = 'Hired' THEN 'hired' WHEN ${a}.status IN (${RED.map((s) => `'${s}'`).join(', ')}) THEN 'red'
  WHEN ${a}.worked_at IS NOT NULL AND (${a}.assigned_at IS NULL OR ${a}.worked_at >= ${a}.assigned_at) THEN 'process' ELSE 'new' END)`;
// Work counts for the lead's own recruiter (or anyone, while nobody owns it): an admin's note does not take a lead out of New.
async function markWorked(c, driverId, userId) {
  await c.query(`UPDATE drivers SET worked_at = now() WHERE id = $1 AND (owner_id IS NULL OR owner_id = $2)`, [driverId, userId]);
}
// Once, when the column is first added: leads already being worked start in In process, not in New.
async function addWorkedAt(c) {
  if ((await c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'drivers' AND column_name = 'worked_at'`)).rows[0]) return;
  // one query = one transaction: never the column without the backfill
  await c.query(`ALTER TABLE drivers ADD COLUMN worked_at TIMESTAMPTZ;
    UPDATE drivers SET worked_at = now() WHERE status IN ('Relay invite sent', 'Signed up on Relay')
      OR id IN (SELECT n.driver_id FROM notes n JOIN drivers d ON d.id = n.driver_id
        WHERE n.user_id IS NOT NULL AND (d.owner_id IS NULL OR n.user_id = d.owner_id) AND (n.kind IS NULL OR n.outcome = 'Talked') AND (d.assigned_at IS NULL OR n.created_at >= d.assigned_at))
      OR id IN (SELECT a.driver_id FROM activity a JOIN drivers d ON d.id = a.driver_id
        WHERE a.type IN ('edit', 'status') AND (d.owner_id IS NULL OR a.user_id = d.owner_id) AND (d.assigned_at IS NULL OR a.at >= d.assigned_at));`);
}
const COLD_DAYS = 3; // an active lead nobody has touched for this long is "going cold"
const keyOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const digits = (p) => { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? d : null; };
const cidOf = (u) => { try { const c = new URL(u).searchParams.get('conversationId'); return c && c.length > 12 && !/\s/.test(c) ? c : null; } catch (e) { return null; } }; // real Indeed chat ids only
const clean = (v) => (v === undefined || v === null || (typeof v === 'string' && !v.trim()) ? null : v);
const isoOrNull = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };

// Find the same person, however they reached us: the Indeed chat, a phone, an email, then name + account.
async function findDriver(c, p) {
  const tries = [];
  if (p.convIds.length) tries.push(['conv_ids && $1', [p.convIds]]);
  if (p.phones.length) tries.push(['phones && $1', [p.phones]]);
  if (p.emails.length) tries.push(['emails && $1', [p.emails]]);
  if (p.nameKey && p.account) tries.push(['name_key = $1 AND (account = $2 OR account IS NULL)', [p.nameKey, p.account]]);
  if (p.nameKey && !p.account) tries.push(['name_key = $1', [p.nameKey]]);
  for (const [where, params] of tries) {
    const r = await c.query(`SELECT * FROM drivers WHERE ${where} ORDER BY updated_at DESC LIMIT 1`, params);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

// Merge one record coming from the extension (a whole local driver record or a partial one).
// Lists are combined, answers merged, history added without duplicates. A status set by a person
// on the website or in the extension is never overwritten by the auto-reply.
async function mergeFromExtension(c, rec, sourceLabel, opts = {}) {
  const name = clean(rec.name); if (!name) return null;
  const p = {
    nameKey: keyOf(name), account: clean(rec.account),
    phones: [...new Set((rec.phones || []).map(digits).filter(Boolean))],
    emails: [...new Set((rec.emails || []).map((e) => String(e).toLowerCase().trim()).filter((e) => e.includes('@')))],
    convIds: [cidOf(rec.conversationUrl)].filter(Boolean)
  };
  let d = await findDriver(c, p);
  if (!d) {
    const at0 = isoOrNull(rec.updatedAt);
    // a new lead belongs to the recruiter this Chrome profile's key is set up for (or to nobody yet)
    const r = await c.query(`INSERT INTO drivers (name, name_key, account, created_at, updated_at, owner_id, assigned_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), LEAST(COALESCE($5::timestamptz, now()), now()), $6::int, CASE WHEN $6::int IS NULL THEN NULL ELSE now() END) RETURNING *`, [name, p.nameKey, p.account, isoOrNull(rec.createdAt), at0, opts.pick ? null : opts.assignTo || null]);
    d = r.rows[0];
  }
  const set = {}; const fields = { location: 'location', zip: 'zip', mode: 'mode', job: 'job', account: 'account', aiSummary: 'ai_summary', redFlags: 'red_flags', transcript: 'transcript', conversationUrl: 'conversation_url', lastMessage: 'last_message', profileSummary: 'profile_summary', lastActive: 'last_active' };
  for (const [k, col] of Object.entries(fields)) { const v = clean(rec[k]); if (v !== null && v !== d[col]) set[col] = String(v); }
  // everything the extension finds comes from Indeed; how we first found someone is never overwritten
  if (!d.source) set.source = 'Indeed';
  const how = clean(rec.source); if (how && !d.source_detail && how !== 'Indeed') set.source_detail = String(how).slice(0, 200);
  for (const [k, col] of [['invitedAt', 'invited_at'], ['lastContactAt', 'last_contact_at']]) { const v = isoOrNull(rec[k]); if (v && (!d[col] || new Date(v) > new Date(d[col]))) set[col] = v; }
  const phones = [...new Set([...d.phones, ...p.phones])], emails = [...new Set([...d.emails, ...p.emails])], conv = [...new Set([...d.conv_ids, ...p.convIds])];
  if (phones.length !== d.phones.length) set.phones = phones;
  if (emails.length !== d.emails.length) set.emails = emails;
  if (conv.length !== d.conv_ids.length) set.conv_ids = conv;
  if (rec.answers && typeof rec.answers === 'object' && Object.keys(rec.answers).length) {
    const merged = { ...d.answers, ...rec.answers };
    if (JSON.stringify(merged) !== JSON.stringify(d.answers)) set.answers = JSON.stringify(merged);
    // "2019 Freightliner Cascadia" from the chat fills the owner-operator's truck when nobody has yet
    const eq = clean(rec.answers.equipment);
    if (eq && !d.truck_model && !d.truck_year) {
      const y = String(eq).match(/\b(19[89]\d|20\d\d)\b/); const model = String(eq).replace(/\b(19[89]\d|20\d\d)\b/, '').replace(/^[\s,.-]+|[\s,.-]+$/g, '').slice(0, 80);
      if (y && +y[1] <= new Date().getFullYear() + 1) set.truck_year = +y[1];
      if (model && model.length > 2) set.truck_model = model;
    }
  }
  // Status: several Chrome profiles can know the same driver, each with its own view. Along the hiring
  // steps a status only moves forward; a status off the steps (Not interested, No CDL, Review…) wins only
  // when it is newer news. A status a person set by hand on the website is kept.
  const st = clean(rec.status);
  if (st && st !== d.status) {
    const byHand = !!rec.statusLocked && LOCKING.includes(st);
    const recAt = isoOrNull(rec.updatedAt) || new Date().toISOString();
    const newer = !d.status_at || new Date(recAt) > new Date(d.status_at);
    const a = ROUTE.indexOf(st), b = ROUTE.indexOf(d.status);
    const forward = a >= 0 && b >= 0 ? a > b : newer;
    if ((byHand && !d.status_locked) || (!d.status_locked && forward)) { if (byHand && st === 'Relay invite sent') set.worked_at = new Date().toISOString(); set.status = st; set.status_locked = byHand || LOCKING.includes(st); set.status_at = recAt; }
  }
  if (rec.callbackAt) await require('./callback').fromExtension(c, d, rec);
  if (d.relay_before === null && rec.answers && typeof rec.answers === 'object' && rec.answers.relay) { const v = relayFrom(rec.answers.relay); if (v !== null) set.relay_before = v; }
  // a lead nobody owns gets a recruiter: the next one in line when leads are shared evenly,
  // otherwise the recruiter this Chrome profile's key is set up for
  let given = null;
  if (!d.owner_id && Object.keys(set).length) {
    const to = opts.pick ? await opts.pick() : opts.assignTo;
    if (to) { set.owner_id = to; set.assigned_at = new Date().toISOString(); given = to; }
  }
  if (Object.keys(set).length) {
    const cols = Object.keys(set);
    const at = isoOrNull(rec.updatedAt); // keep the real time of the activity (matters for imported backups)
    await c.query(`UPDATE drivers SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = GREATEST(updated_at, LEAST(COALESCE($2::timestamptz, now()), now())) WHERE id = $1`, [d.id, at, ...cols.map((k) => set[k])]);
    if (given) {
      await notify(c, given, 'lead_new', `New lead for you: ${rec.name || d.name}${opts.pick ? ' (shared evenly)' : ''}, from Indeed`, `#/driver/${d.id}`, { driverId: d.id });
      const who = (await c.query(`SELECT name FROM users WHERE id = $1`, [given])).rows[0];
      await c.query(`INSERT INTO driver_events (driver_id, type, text, who, fp) VALUES ($1, 'web', $2, 'Website', $3)`,
        [d.id, `Assigned to ${who ? who.name : 'a recruiter'}${opts.pick ? ' (leads shared evenly)' : ''}`, require('crypto').randomBytes(12).toString('hex')]);
    }
    if (set.status) {
      // when it happened, not when it reached the website: an old backup must not look like this week's leads
      const firstReply = (Array.isArray(rec.events) ? rec.events : []).map((e) => (e && e.type === 'reply' ? isoOrNull(e.t) : null)).filter(Boolean).sort()[0];
      await statusChanged(c, d, set.status, { via: 'extension', at, leadAt: firstReply || at });
    }
  }
  // tell the lead's recruiter what is new (the website's own edits are told elsewhere)
  if (d.owner_id && !given) {
    const what = [];
    if (set.phones) what.push('new phone number');
    if (set.emails) what.push('new email');
    if (set.status) what.push(`now ${set.status}`);
    if (set.relay_before !== undefined) what.push(`ran Amazon Relay before: ${set.relay_before ? 'yes' : 'no'}`);
    if (what.length) await notify(c, d.owner_id, 'lead_update', `${rec.name || d.name}: ${what.join(', ')}`, `#/driver/${d.id}`, { driverId: d.id, merge: true });
  }
  // history
  const events = [...(Array.isArray(rec.events) ? rec.events : []), ...(rec.event && typeof rec.event === 'object' ? [{ ...rec.event, t: rec.event.t || new Date().toISOString() }] : [])];
  const said = []; // the driver's new messages, first seen now
  for (const e of events.slice(-80)) {
    if (!e || !e.text) continue;
    const t = isoOrNull(e.t) || new Date().toISOString();
    const ins = await c.query(`INSERT INTO driver_events (driver_id, t, type, text, fp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`, [d.id, t, e.type || null, String(e.text).slice(0, 2000), sha(`${t}|${e.text}`)]);
    // "their words → what we answered": a driver's message the extension just read (not an old backup)
    if (ins.rows[0] && e.type === 'reply' && Date.now() - new Date(t).getTime() < 3 * 3600 * 1000) {
      const words = String(e.text).split(' → ')[0].trim();
      if (words && !/^Applied on Indeed/.test(words)) said.push(words);
    }
  }
  // every new message from the driver: a notification for the lead's recruiter, so a chat never waits on them
  if (said.length && d.owner_id && !given) {
    const last = said[said.length - 1];
    await notify(c, d.owner_id, 'message', `${rec.name || d.name} wrote on Indeed: "${last.slice(0, 160)}"${said.length > 1 ? ` (and ${said.length - 1} more)` : ''}`, `#/driver/${d.id}`, { driverId: d.id });
  }
  // the extension's own notes box: kept as one note per Chrome profile, updated in place
  if (typeof rec.notes === 'string' && sourceLabel) {
    const src = `ext:${sourceLabel}`;
    if (rec.notes.trim()) await c.query(`INSERT INTO notes (driver_id, source, body) VALUES ($1, $2, $3) ON CONFLICT (driver_id, source) WHERE source IS NOT NULL DO UPDATE SET body = EXCLUDED.body, updated_at = now() WHERE notes.body <> EXCLUDED.body`, [d.id, src, rec.notes.trim()]);
    else await c.query(`DELETE FROM notes WHERE driver_id = $1 AND source = $2`, [d.id, src]);
  }
  return d.id;
}

// ---------- onboarding ----------
// The checklist a driver gets when onboarding starts is a copy of the template in Settings.
async function ensureOnboarding(c, driverId, userId) {
  await c.query(`INSERT INTO onboarding (driver_id, started_by) VALUES ($1, $2) ON CONFLICT (driver_id) DO UPDATE SET completed_at = NULL`, [driverId, userId || null]);
  let i = 0;
  for (const it of settings.checklist) await c.query(`INSERT INTO checklist (driver_id, key, label, position, auto) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (driver_id, key) DO NOTHING`, [driverId, it.key, it.label, i++, it.auto || null]);
  await syncAuto(c, driverId, userId);
}
// Steps that tick themselves: a truck is chosen, the arrival date is set, the driver arrived, the group link is saved.
async function syncAuto(c, driverId, userId) {
  const o = (await c.query(`SELECT o.*, (SELECT t.id FROM trucks t WHERE t.driver_id = o.driver_id) truck_id FROM onboarding o WHERE o.driver_id = $1`, [driverId])).rows[0];
  if (!o) return;
  const state = { truck: !!o.truck_id, arrival: !!o.expected_arrival, arrived: !!o.arrived_on };
  for (const [auto, v] of Object.entries(state)) {
    await c.query(`UPDATE checklist SET done = $3, done_at = CASE WHEN $3 THEN now() END, done_by = CASE WHEN $3 THEN $4::int END WHERE driver_id = $1 AND auto = $2 AND done <> $3`, [driverId, auto, v, userId || null]);
  }
  // "Amazon Relay verified" follows the Amazon steps (left alone while no step is set)
  const az = (await c.query(`SELECT amazon_step FROM drivers WHERE id = $1`, [driverId])).rows[0];
  if (az && az.amazon_step) { const v = az.amazon_step === 'verified';
    await c.query(`UPDATE checklist SET done = $2, done_at = CASE WHEN $2 THEN now() END, done_by = CASE WHEN $2 THEN $3::int END WHERE driver_id = $1 AND (auto = 'amazon' OR key = 'relay') AND done <> $2`, [driverId, v, userId || null]); }
  const groups = new Set((await c.query(`SELECT kind FROM tg_chats WHERE driver_id = $1 AND active AND kind IS NOT NULL`, [driverId])).rows.map((r) => r.kind));
  if (o.telegram_link || groups.has('dispatch')) await c.query(`UPDATE checklist SET done = TRUE, done_at = now(), done_by = $2::int WHERE driver_id = $1 AND (auto = 'telegram' OR key = 'telegram') AND NOT done`, [driverId, userId || null]);
  // Telegram groups linked with the bot, maybe before onboarding started: their steps tick too
  const tick = async (key) => c.query(`UPDATE checklist SET done = TRUE, done_at = now() WHERE driver_id = $1 AND key = $2 AND NOT done`, [driverId, key]);
  if (groups.has('eld')) await tick('eld_group');
  if (groups.has('accounting')) await tick('acct_group');
  if ((await c.query(`SELECT 1 FROM eld_cases WHERE driver_id = $1 AND setup_done_at IS NOT NULL`, [driverId])).rows[0]) await tick('eld_profile');
  if ((await c.query(`SELECT 1 FROM tg_reports WHERE driver_id = $1 AND kind = 'mvr' AND review = 'ok'`, [driverId])).rows[0]) await tick('mvr');
  if (o.arrived_on) await require('./orientation').ensure(driverId).catch((e) => console.error('orientation', e.message)); // the first day's checklist
}
async function releaseTruck(c, driverId) {
  const r = await c.query(`UPDATE trucks SET driver_id = NULL, updated_at = now() WHERE driver_id = $1 RETURNING unit`, [driverId]);
  return r.rows[0] ? r.rows[0].unit : null;
}
// Every status change goes through here: it is logged (who, from, to) and onboarding follows the status.
async function statusChanged(c, d, to, { userId = null, via = 'web', at = null, leadAt = null } = {}) {
  await c.query(`INSERT INTO status_log (driver_id, from_status, to_status, user_id, via, at) VALUES ($1, $2, $3, $4, $5, LEAST(COALESCE($6::timestamptz, now()), now()))`, [d.id, d.status, to, userId, via, at]);
  if (to !== 'Invited') await c.query(`UPDATE drivers SET lead_at = LEAST(COALESCE($2::timestamptz, now()), now()) WHERE id = $1 AND lead_at IS NULL`, [d.id, leadAt]);
  if (!LOST.includes(to) && to !== 'Stalled') await c.query(`UPDATE drivers SET lost_reason = NULL, lost_note = NULL WHERE id = $1 AND (lost_reason IS NOT NULL OR lost_note IS NOT NULL)`, [d.id]);
  const notes = [];
  // the Relay statuses carry the Amazon steps along
  if (to === 'Relay invite sent') await amazonTo(c, d.id, 'invite', userId);
  if (to === 'Signed up on Relay') await amazonTo(c, d.id, 'profile', userId);
  if (to === 'Onboarding') await ensureOnboarding(c, d.id, userId);
  if (to === 'Hired') await c.query(`UPDATE onboarding SET completed_at = COALESCE(completed_at, now()) WHERE driver_id = $1`, [d.id]);
  if (to === 'Hired') await require('./fleet').checkFill(c, d.id).catch((e) => console.error('fill', e.message));
  if (to === 'Hired') { // the onboarding group is now the driver's dispatch group: the bot learns dispatching and updates there (quietly)
    for (const g of (await c.query(`UPDATE tg_chats SET mode = 'watch' WHERE driver_id = $1 AND kind = 'dispatch' RETURNING chat_id`, [d.id])).rows)
      await require('./tg/bot').log('mode', `${d.name} is active now: this is the driver's dispatch group. The bot learns dispatching and load updates here (Watch and learn)`, { chatId: g.chat_id, driverId: d.id }).catch(() => {});
  }
  if (LOST.includes(to)) { const unit = await releaseTruck(c, d.id); if (unit) { notes.push(`Truck ${unit} is free again`); await syncAuto(c, d.id, userId); } }
  return notes;
}

module.exports = { notify, relayFrom, AMAZON, amazonIdx, amazonTo, pool, q, migrate, hashPassword, checkPassword, sha, token, keyOf, digits, mergeFromExtension, LOCKING, ROUTE, OTHER, ORDER, ACTIVE, LOST, FRESH, COLD_DAYS, RED, STAGES, stageSql, markWorked, addWorkedAt,
  settings, DEFAULTS, saveSetting, ensureOnboarding, syncAuto, releaseTruck, statusChanged };
