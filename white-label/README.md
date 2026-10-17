# Klean.ly Business — Independent White-Label Foundation

This directory is an **independent application**, not a new page of the live Klean.ly directory. Its contents do not run in the existing directory build or touch the directory's Supabase database.

## Intended model

One **master source repository** and versioned database blueprint. Each customer signs up through the Klean.ly provisioning portal and authorises connections to their own:

- Supabase project (their customers, authentication and storage)
- Netlify site (their domain, hosting and server functions)
- Google Maps billing/API project (restricted browser key and, when needed, server key)
- Resend sending domain, Stripe and/or GoCardless, optional Android SMS gateway

Each deployment is logically and physically separate: no shared customer database or payment account. Support staff cannot access customer secrets without explicitly authorised administration.

## Available now: foundation, not automated sign-up yet

- Portable static **installer planning wizard** at installer/index.html.
- The wizard records **only non-secret company branding choices** in browser localStorage. It never asks for API tokens.
- Download a redacted deployment manifest. It is NOT proof of connected providers.
- Supabase OAuth **verification-only** via three Netlify Functions: secure PKCE/state, server-side code exchange, then discard access/refresh tokens. Status is signed in an HttpOnly temporary cookie; it is never a durable company connection.
- A separate Supabase OAuth Client ID is set on the **staging site's Functions environment**. The client secret must be configured by the administrator directly in Netlify, never pasted into chat or checked into GitHub.
- Versioned, dedicated-database-only SQL schema in blueprint/0001_foundation.sql.
- A guarded **operator-run pilot installer** in provisioner/install.mjs. It can install the schema into an explicitly approved, already-created customer Supabase project via the Management API. Tokens are supplied as secure server/terminal environment variables and are never sent to the browser.

### Not implemented yet

Supabase OAuth callback and encrypted token vault; automatic project creation; Netlify OAuth and deploy; DNS; Google Maps key verification; Resend, Stripe and GoCardless connection and webhooks; Android gateway pairing; billing/licence administration; tenant app and owner invitation; zero-touch updates. Do not publish the wizard as a live installation system before these are implemented and tested.

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
- Client ID: `a3ff2237-4e0a-41de-982f-079176f54599` (not a secret; stored in staging Netlify Functions environment)
- Client Secret: supply `SUPABASE_OAUTH_CLIENT_SECRET` via **Netlify > Project configuration > Environment variables**, marking it as **secret** and scoped to **Functions** in the **production** context of the installer staging site.
- Deploy again after adding or rotating secrets; Netlify runtime environment is bound to the deployment.

Never supply the secret in chat, source code or a browser form. It belongs only to the **staging** Netlify project. The static HTML has no access to it.

The Supabase OAuth API redirects to the callback above. The server verifies signed state and PKCE, exchanges the code with Supabase, and discards all credentials; a signed HttpOnly cookie only confirms the proof for fifteen minutes. The UI always says **Test verified**, never permanently connected. Production onboarding requires verified Klean.ly user identity, customer association, a durable encrypted token vault, revocation, scope checks and explicit billing consent *before* storing or using any company access tokens.

The OAuth app scopes can include project/database write, but **this test never writes to a project**; no SQL or Supabase Management API resource calls occur.
