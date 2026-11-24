# Momentum

Jasmine Daya's private staff platform: the JD&Co Law Firm workspace (clients, matters, PNC tracker, opening checklist, client expenses), the Marketing workspace (contacts, companies, opportunities, follow-ups, campaigns, programs, marketing expenses), email lists and mass mailings for each business, team work and approvals, the team calendar, daily and weekly staff updates, the attention centre and reminders, division contact directories, Office and JD Publishing folders, imports, and people and division access.

Rebuilt in October 2026 from *Momentum Complete Website Handoff* (Box › W Momentum) because the original source on ChatGPT Sites wasn't available. Phases 1 (firm core) and 2 (marketing and team) are built. What's still open is listed at the end.

## Stack

- **One Node.js server** (`src/server/main.ts`) runs the API (`src/worker`, using Hono), serves the screens (`src/web`, React and Vite) and sends queued email once a minute.
- **SQLite** (Node's built-in driver, `src/worker/db.ts`) holds the data in one file. The schema is in `migrations/`, applied automatically when the server starts. Money is stored as integer cents.
- **Sign in with Google** is built in (`src/worker/google.ts`): Google confirms who the person is, Momentum sets a signed session cookie (12 hours by default), and `src/worker/auth.ts` maps the email to an active member on every API request.
- **Hosting:** code on **GitHub**; a Docker image built by GitHub Actions runs on an **Akamai (Linode)** server in Toronto behind Caddy (HTTPS), with Litestream streaming every database change to Akamai Object Storage. See `deploy/` and GO-LIVE.md.

## Access rules (enforced on the server, and mirrored on screen)

- Roles: **Owner**, **Administrator** and **Member**. Divisions are granted per person. The Owner sees everything.
- **Every division is restricted:** only the Owner grants division access, including **Office** (Human Resources, SOPs & Templates) and **Properties**. Administrators can add and edit ordinary Members but can't give or remove division access.
- **Properties** (owner-granted) holds each property's details, a tenants folder and a service providers folder. Provider passwords are encrypted with `DATA_ENCRYPTION_KEY`, never listed, and each viewing is logged. Property activity is hidden from staff without Properties access.
- Every route checks access itself (`src/worker/policy.ts`), whether or not the menu shows it. Firm activity is hidden from the audit log for staff without JD&Co access.
- **Marketing** pages and their API (`/api/marketing/*`, marketing expenses) need the Marketing division. Marketing programs can also be limited to JD&Co staff or to administrators.
- **Team work** is open to every active member, but only administrators can approve or publish work, or move it back out of Approved or Published. Linking work to a campaign needs Marketing access.
- **Staff updates**: each person writes only their own. Drafts are private; administrators see only that a draft exists. The Owner reviews everyone's submitted updates; administrators review ordinary Members' only, and firm updates only with JD&Co access. Editing an update clears its review. Days and Monday-to-Sunday weeks follow America/New_York.
- **Attention centre**: alerts come only from work the person can see. Read, dismissed and snoozed are per person; snoozes end on their business date. Members create reminders for themselves; firm reminders need JD&Co access for both the creator and the assignee. Firm dates on the team calendar are opt-in and need JD&Co access.
- **Email**: each business has its own list. A list needs Marketing plus that business's division (so the JD&Co and JD Publishing lists need Owner-granted access). Staff add people one at a time with consent evidence, write drafts and send tests to themselves; administrators import, change sender settings, and send, schedule, pause or cancel. Unsubscribes are per business; hard bounces and spam complaints block an address for every business, and a complaint can never be unblocked. Someone who unsubscribed can only be re-added with new express consent dated after they left.
- Edits carry a revision number, so stale saves are rejected (409). Writes must be same-origin JSON. Responses are `no-store`.

## Run it on this computer

```bash
cp .env.example .env    # local stand-in sign-in (localhost only); the database goes in ./data
npm run dev             # http://localhost:5173 (API server on :8787)
```

The sidebar footer has a **View as** switcher (local only) for checking what each member sees.

## Tests

```bash
npm test        # 75 API tests against a fresh in-memory database
npm run check   # TypeScript
npm run build   # web app (dist/client) and bundled server (dist/server/main.mjs)
npm start       # run the built server
```

The tests cover sign-in and Owner setup, division isolation on every firm route, who can grant what, unique file numbers, closing rules, checklist attribution and stale saves, PNC consent and conversion, expense totals, voids and formula-safe CSV export, imports (preview, commit, no double commit), and that the local sign-in stand-in can't work on a real hostname.

Sign-in tests (`test/signin.test.ts`) cover: nothing opens until Google sign-in is configured; no session means sign in; the development header is ignored in production; tampered, expired and wrongly signed sessions are rejected; Google accounts that aren't members are refused; sign-in uses state, nonce and PKCE, and never redirects off-site; mismatched callbacks are rejected; sign-out only from Momentum itself.

Phase 2 tests (`test/phase2.test.ts`) cover Marketing isolation on every route, duplicate-email confirmation, email permission date and evidence, open-opportunity requirements, stage history, won/lost probability and lost reasons, per-currency weighted totals rounded per opportunity, the follow-up queue, campaign results (spend incl. HST without voids, by currency, remaining budget, cost per contact, win rate), UTM links, program visibility and edit rights, admin-only approval and publishing, calendar scoping, staff-update privacy, review and review reset, New York periods and 5 p.m. cutoffs across daylight-saving changes, per-person alert states and snooze expiry, and reminder rules.

Email tests (`test/email.test.ts`) cover list isolation per business, admin-only imports, sender settings and sending, consent declarations, skipped rows (invalid, repeated, blocked, unsubscribed, expired implied consent), retry-safe import chunks, resubscription rules, the deliverability checks, one-click unsubscribe headers and links (including tampered links), daily limits and re-checking unsubscribes before each message, scheduling and cancelling, SES bounce and complaint notifications, and the automatic pause.

## Project layout

```
migrations/          database schema (append new numbered files; never edit applied ones)
src/server/          Node entry point: settings, migrations on start-up, static files, the email timer
src/shared/          divisions, brands, pipelines, statuses, import targets, quotes; time.ts (New York periods and cutoffs); email.ts (consent, rendering, spam checks)
src/worker/          API: db (SQLite), google (sign-in), session, auth, policy, routes/{people,firm,pncs,expenses,directory,imports,marketing,campaigns,team,reports,attention,email};
                     email/ (Amazon SES sending, unsubscribe page, bounce webhook, once-a-minute queue)
src/web/             screens: App shell, pages/*, ui.tsx (forms, tables, dialogs)
public/brand/        banner images (from Box › W Momentum › Images)
test/                API tests
deploy/              server files: compose.yml, Caddyfile, litestream.yml, setup-server.sh, server.env.example
.github/workflows/   ci.yml (tests on every branch), deploy.yml (main → image → Akamai server)
Dockerfile           server image
GO-LIVE.md           step-by-step deployment
```

## Phases

- **Phase 1 (built):** sign-in, people and division access, JD&Co clients, matters, PNCs, opening checklist and client expenses, division contacts, Office and JD Publishing folders, imports.
- **Phase 2 (built):** Marketing workspace (contacts with brands and email permission, companies, opportunities in six pipelines with stage history, follow-up queue, campaigns with budget, UTM link builder and linked results, marketing programs, marketing expenses), team workspace with administrator approval and publishing, team calendar, daily and weekly staff updates with review, and the attention centre with reminders. Migration `0003_marketing_team.sql` adds the tables.
- **Email (built):** per-business lists, bulk CSV import from Sender, HubSpot or spreadsheets (any size, in batches of 500), consent tracking with implied-consent expiry, mailings with a live preview and spam checks, test sends, scheduling, daily limits for warm-up, one-click unsubscribe, bounce and complaint suppression through Amazon SES, and automatic pausing. Migration `0004_email.sql`; setup is in GO-LIVE.md section 12. Not built: open and click tracking, A/B tests, automated sequences, sign-up forms on the websites.
- **Not built yet:** CSV import for marketing contacts, an office programs directory, PNC contact-history import, pagination beyond current limits, email or push delivery of alerts and recaps, and integrations (Box, email and calendar, QuickBooks, analytics).
