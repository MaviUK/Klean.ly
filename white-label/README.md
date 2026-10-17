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
- Versioned, dedicated-database-only SQL schema in blueprint/0001_foundation.sql.
- A guarded **operator-run pilot installer** in provisioner/install.mjs. It can install the schema into an explicitly approved, already-created customer Supabase project via the Management API. Tokens are supplied as secure server/terminal environment variables and are never sent to the browser.

### Not implemented yet

Supabase OAuth callback and encrypted token vault; automatic project creation; Netlify OAuth and deploy; DNS; Google Maps key verification; Resend, Stripe and GoCardless connection and webhooks; Android gateway pairing; billing/licence administration; tenant app and owner invitation; zero-touch updates. Do not publish the wizard as a live installation system before these are implemented and tested.

## Test

No npm packages or external accounts are required:

    cd white-label
    npm test

Run `python3 -m http.server 8080 --directory installer` from the `white-label` directory and visit http://localhost:8080 to inspect the setup planning wizard (ES modules do not work reliably from file://). For hosting as its **own** Netlify site, configure Base directory = white-label and Publish directory = installer. Do NOT change the settings of the live Klean.ly Netlify project.

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
