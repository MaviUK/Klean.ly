# Klean.ly Business — Independent White-Label Foundation

This directory is an **independent application**, not a new page of the live Klean.ly directory. Its contents do not run in the existing directory build or touch the directory's Supabase database.

## Intended model

One **master source repository** and versioned database blueprint. Each customer signs up through the Klean.ly provisioning portal and authorises connections to their own:

- Supabase project (their customers, authentication and storage)
- Netlify site (their domain, hosting and server functions)
- Google Maps billing/API project (restricted browser key and, when needed, server key)
- Resend sending domain, Stripe and/or GoCardless, optional Android SMS gateway

Each deployment is logically and physically separate: no shared customer database or payment account. Support staff cannot access customer secrets without explicitly authorised administration.

## Available in the currently deployed staging site: foundation and verification-only OAuth

- Portable static **installer planning wizard** at installer/index.html.
- The wizard records **only non-secret company branding choices** in browser localStorage. It never asks for API tokens.
- Download a redacted deployment manifest. It is NOT proof of connected providers.
- Supabase OAuth **verification-only** via three Netlify Functions: secure PKCE/state, server-side code exchange, then discard access/refresh tokens. Status is signed in an HttpOnly temporary cookie; it is never a durable company connection.
- A separate Supabase OAuth Client ID is set on the **staging site's Functions environment**. The client secret must be configured by the administrator directly in Netlify, never pasted into chat or checked into GitHub.
- Versioned, dedicated-database-only SQL schema in blueprint/0001_foundation.sql.
- A guarded **operator-run pilot installer** in provisioner/install.mjs. It can install the schema into an explicitly approved, already-created customer Supabase project via the Management API. Tokens are supplied as secure server/terminal environment variables and are never sent to the browser.

### Not implemented yet on the deployed staging site

A permanent Supabase grant (the new feature branch is reviewed separately); automatic project creation; Netlify OAuth and deploy; DNS; Google Maps key verification; Resend, Stripe and GoCardless connection and webhooks; Android gateway pairing; billing/licence administration; tenant app and owner invitation; zero-touch updates. Do not publish the wizard as a live installation system before these are implemented and tested.

## Test

No npm packages or external accounts are required:

    cd white-label
    npm test

Run `python3 -m http.server 8080 --directory installer` from the `white-label` directory and visit http://localhost:8080 to inspect the setup planning wizard (ES modules do not work reliably from file://). For hosting as its **own** Netlify site, use the dedicated installer staging project and **never** repurpose the existing directory's Netlify project.

### Installer staging configuration

Netlify site: `kleanly-business-installer-staging`

- Repository: `MaviUK/Klean.ly`
- Production branch: `agent/white-label-installer-foundation` (not `main`)
- Base directory: `white-label`
- Package directory: blank
- Build command: `npm test` (enforced by `white-label/netlify.toml`)
- Publish directory: `installer` (enforced by `white-label/netlify.toml`)
- Functions: **none**. The directory's root `netlify/functions` must not be deployed here.

To correct a site created with the repository's default `main` branch, go to **Project configuration > Developer settings > Continuous deployment > Branches and deploy contexts** and change the production branch. Then open **Build settings** under Continuous deployment, set the base directory and deploy again.

Before configuring any provider credentials, inspect the new deploy. It should use a commit from `agent/white-label-installer-foundation` and list **no directory functions** or scheduled billing tasks. The static wizard has no authentication or OAuth yet; avoid entering API keys or real customer data.

Do NOT change the settings of the live Klean.ly Netlify project.

## Pilot (NI Bin Guy)

1. Set up a **new dedicated Supabase project**, with an owner-managed billing account and backups. Never select the directory project.
2. Review blueprint/0001_foundation.sql, especially the RLS owner bootstrap rules.
3. Run: node provisioner/install.mjs --ref YOUR_NEW_REF (dry run; no network writes).
4. To install, set SUPABASE_ACCESS_TOKEN in your local secure environment, then run:
   node provisioner/install.mjs --ref YOUR_NEW_REF --apply --confirm YOUR_NEW_REF
5. Verify the new tables and RLS. The schema does **not** pre-create a business profile or user. A trusted owner invitation/bootstrap flow is the next milestone.
6. When ready, deploy the tenant application separately, with ONLY publishable client configuration in the frontend.

The installer uses Supabase's Management API beta SQL endpoint, not a partner-only migration endpoint. Provider API behaviour, partner access and pricing may change, so the long-term automated OAuth installer needs provider-specific tests and error handling.

## Safety

- DO NOT paste keys into the wizard or GitHub, or expose secret/service-role tokens to Vite.
- The SQL refuses to run if directory-specific tables exist.
- Payment provider connections always belong to the individual company.
- Provider permissions will be requested and revocable, and secrets encrypted at rest in the **Klean.ly control plane**, not in the tenant frontends.
- Always run isolated security tests before any real customer information is imported.

Supabase docs:
- https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration
- https://supabase.com/docs/reference/api/v1-run-a-query
- https://supabase.com/docs/guides/database/postgres/row-level-security

## Supabase authorisation test (staging only)

The site uses an OAuth app configured with:

- Callback URL: `https://kleanly-business-installer-staging.netlify.app/.netlify/functions/supabase-oauth-callback`
- Client ID: `7f3c6a9f-2063-4424-bacf-24a71b0c8321` (not a secret; stored in staging Netlify Functions environment)
- Client Secret: supply `SUPABASE_OAUTH_CLIENT_SECRET` via **Netlify > Project configuration > Environment variables**, marking it as **secret** and scoped to **Functions** in the **production** context of the installer staging site.
- Deploy again after adding or rotating secrets; Netlify runtime environment is bound to the deployment.

Never supply the secret in chat, source code or a browser form. It belongs only to the **staging** Netlify project. The static HTML has no access to it.

The Supabase OAuth API redirects to the callback above. The server verifies signed state and PKCE, exchanges the code with Supabase, and discards all credentials; a signed HttpOnly cookie only confirms the proof for fifteen minutes. The UI always says **Test verified**, never permanently connected. Production onboarding requires verified Klean.ly user identity, customer association, a durable encrypted token vault, revocation, scope checks and explicit billing consent *before* storing or using any company access tokens.

The OAuth app scopes can include project/database write, but **this test never writes to a project**; no SQL or Supabase Management API resource calls occur.

## Permanent Supabase connection — development branch, not enabled on staging yet

Branch: `agent/white-label-supabase-connection-vault`. Do not merge this into the live Klean.ly directory, and do **not** enable permanent credentials until the following prerequisites have been checked.

### What this branch implements

- **Supabase OAuth sign-in + organisation grant** using the existing OAuth callback, PKCE S256 and one-time state cookie. The Management API `GET /v1/profile` verifies the provider account's stable user ID. `GET /v1/organizations` must resolve to **exactly one** consented organisation; otherwise onboarding is rejected without storing tokens.
- Per-owner, per-organisation encrypted connection vault using AES-256-GCM, a fresh IV for every write, and authenticated encryption associated with the provider user ID, organisation ID and connection row ID. An encryption key is never sent to the browser.
- One-way SHA-256 of random 256-bit session cookies in a **private control-plane Postgres database**. Seven-day server-side sessions are bound to the provider owner and their specific organisation grant. HttpOnly, Secure, SameSite=Lax, `__Host-` cookies.
- Origin + server-generated CSRF checks for all `POST` actions. Credentials stay on the server. The UI can check connection status, sign out (keep grant), reconnect via OAuth, or disconnect (delete the local encrypted grant and all its sessions).
- Provider refresh token rotation under a database row lock to avoid losing single-use refresh tokens. Rejected OAuth grants are marked as requiring reauthorisation; transient provider outages do not erase grants.
- **No provisioning calls**: no new Supabase projects, no SQL application to customer databases and no customer Netlify sites until separate explicit installation confirmation.

The control-plane DB stores only portal users, provider grants and sessions. It is **not** a shared customer CRM/database, and no directory data or customer business data are copied into it. Two Supabase users consenting to the same organisation remain separate account owners in this pilot.

### Mandatory deployment prerequisites

1. **Check Netlify billing and database availability first.** Netlify Database requires a Credit-based Netlify plan and consumes compute/bandwidth credits while active. This team is currently reported as **Pro**; do not assume it is an eligible credit-based plan or silently change plans. Keep this development branch unmerged until the owner approves any billing implications.
2. Provision a **new, separate Netlify Database** on the **installer staging site** (NOT the live directory site). On eligible Netlify plans, deploying `@netlify/database` with the committed `netlify/database/migrations/20261018020000_portal_connections.sql` migration can automatically create its database. The migration must be applied and verified before enabling credential persistence. Never edit this migration after it has been applied.
3. Generate an independent random 32-byte encryption key and save its Base64URL value as a **secret, Functions-only** Netlify environment variable `KLEANLY_OAUTH_ENCRYPTION_KEY` on the installer staging site. **Never** paste or commit it, store it in the browser or share it in chat. Back it up securely: losing/rotating it without a planned decrypt-and-reencrypt migration makes all stored Supabase grants unreadable.
4. Once the staging database migration and encryption key have been verified, set **Functions-only** `KLEANLY_PERMANENT_OAUTH_ENABLED=true` on the installer staging site and redeploy. Until then the known-working verification-only OAuth flow stays enabled and does **not** persist any credentials.
5. Verify in a non-production Supabase organisation first, including success, state mismatch, expiry, connection isolation, reauthorisation, concurrent refresh, check, sign out and disconnect. Avoid authorising the live Klean.ly Supabase project for installation.
6. Before inviting businesses, add the separate business registration/membership records, individual Netlify connection, idempotent provisioning, billing consent, and an owner installation approval screen. A saved Supabase OAuth grant is **not** an installed system.

### Important limitations

- In this pilot, **Supabase OAuth is the portal owner's login proof**. An independent Klean.ly email/password login, team invitations, role delegation, password recovery, and full business-account memberships are planned for the next milestone. Users sign in again through Supabase after their session expires.
- The **Disconnect** button removes our stored copy and invalidates Klean.ly Business sessions. Supabase's original application grant must also be revoked in the Supabase dashboard if the user wants to revoke it at the provider; we do not rely on Supabase's experimental revoke endpoint.
- No original provider tokens are exposed in frontend responses, logs, URLs or `localStorage`. Browser `localStorage` holds only the pre-existing, non-secret branding draft.
- Production usage requires monitoring, backups, scheduled expired-session cleanup, tested encryption-key rotation, org grant review, incident handling, and idempotent deployment flows.
- The package pins Netlify Database at `2.0.1`, and `package-lock.json` was generated from npm on GitHub Actions and committed. The branch CI runs `npm ci` and the unit suite before any deployment. Do not run `npm audit fix --force` automatically.
