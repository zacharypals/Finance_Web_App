# Finance Pal

Personal finance web app. Front end: single-file React on GitHub Pages. Back end: Cloudflare Worker `finance-api` with D1. Bank data via Plaid (Phase 1+). Full spec lives in the Claude project doc `finance-app-spec.md`.

```
index.html          the app (React via CDN, no build step)
config.js           public config: Worker URL, Google client ID, redirect URI
oauth.html          Google sign-in redirect target
plaid-oauth.html    Plaid bank-OAuth redirect target (used from Phase 1)
manifest.json, icon.svg, icon-192.png, icon-512.png   PWA files
worker/
  wrangler.toml     Worker config (IDs and non-secret vars only)
  migrations/       D1 schema, numbered
  src/index.js      the Worker
```

## Phase 0 deploy (Windows PowerShell)

Run these from the `worker` folder.

```powershell
cd worker

# 1. Create the tables in your D1 database
wrangler d1 migrations apply finance-db --remote

# 2. Deploy the Worker — note the URL it prints
wrangler deploy

# 3. Add secrets (each command prompts you to paste the value)
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put PLAID_CLIENT_ID
wrangler secret put PLAID_SECRET
wrangler secret put TOKEN_ENC_KEY

# 4. Check it's alive (should print {"ok":true,"version":"0.1.0"})
curl.exe https://finance-api.plannertracker.workers.dev/health
```

If the URL from step 2 isn't `https://finance-api.plannertracker.workers.dev`, put the real one in `config.js` (`API_URL`).

Then commit and push everything to GitHub, wait a minute for Pages, and open
https://zacharypals.github.io/Finance_Web_App/

**Phase 0 is done when:** you can sign in on your computer and phone and see the four Phase 0 checks, and signing in with any other Google account shows "That Google account isn't allowed."

## Phase 1 deploy (Plaid)

From the `worker` folder:

```powershell
wrangler d1 migrations apply finance-db --remote   # applies 0002_plaid_sync.sql
wrangler deploy                                     # also registers the hourly sync cron
```

Then push the repo (new `index.html` / `config.js`) and open **Settings** in the app.

**Sandbox test logins** (Plaid's fake banks):
- Pick any bank, e.g. "First Platypus Bank" — username `user_good`, password `pass_good`, MFA code `1234` if asked.
- "Platypus OAuth Bank" tests the Chase/Wells-style redirect flow.
- Transactions can take a minute or two to appear after linking — press **Sync now** again.

**Going live (Trial plan, real banks):** remove the Sandbox test connections in the app first, then:

```powershell
wrangler secret put PLAID_SECRET        # paste the Production secret
```

change `PLAID_ENV = "production"` in `wrangler.toml`, and `wrangler deploy`.

## Phase 2 deploy (Accounts & net worth)

From the `worker` folder: `wrangler d1 migrations apply finance-db --remote` (applies 0003), then `wrangler deploy`. From the repo root: commit and push.

## Phase 3 deploy (Transactions & reports)

No database migration this time. From the `worker` folder: `wrangler deploy`. From the repo root: commit and push.
The first time you open Transactions, Reports or Settings, the starter categories are created and all history is categorized once.

## Phase 4 deploy (Plan)

From the `worker` folder: `wrangler d1 migrations apply finance-db --remote` (applies 0004), then `wrangler deploy`. From the repo root: commit and push.

## Conventions

- Version lives in two places and must match: the `<!-- Finance Pal vX.Y.Z -->` comment and `APP_VERSION` in `index.html`. Worker version is `WORKER_VERSION` in `worker/src/index.js`.
- Schema changes are new numbered files in `worker/migrations/`; never edit an applied one.
- No secrets in the repo. `config.js` and `wrangler.toml` are public by design.
- No bare `catch {}`; errors surface in the persistent bottom toast.
