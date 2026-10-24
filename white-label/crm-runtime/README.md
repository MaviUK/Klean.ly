# Klean.ly Business — test-owner CRM runtime (UNDEPLOYED)

This directory contains a first read-only, invite-only runtime source for the
separate \`kleanly-business-crm-pilot.netlify.app\` pilot. It is **not** the live
directory, is **not** the staging installer, and has NOT been deployed.

The existing \`crm-app/\` remains the publicly viewable STATIC design preview.
The two directories are independent.

## Implemented in source (not live)

- Owner email/password sign-in against the **dedicated test Supabase project**.
- Server-issued Auth access tokens held in **memory only**; no cookies,
  localStorage or sessionStorage. Refresh tokens use the Supabase Auth API
  while the tab remains open, with serialized refresh calls.
- Before showing any private data, inspect \`auth/v1/user\` **and** retrieve the
  owner-only \`business_profile\` via its RLS policy. Non-owner signed-in users
  remain outside the CRM.
- Explicit, paged, owner-only **read-only** REST queries for customers, rounds,
  customer services, jobs, payments, message log and team.
- No public registration, no browser invitations, no admin/service keys, no
  payments or messages sent, no CRM database writes.
- Text-only safe rendering (no \`innerHTML\` or arbitrary HTML from private data).
- An exact-origin, staging-only allowlist for the Supabase project and Netlify
  site. The built-in CSP has no wildcard connect-src or external scripts.

## NOT implemented / STOP conditions

This package is intentionally **not deployable**. The callback code has not been security-tested with a real invited owner and the first-owner bootstrap is not implemented. It is missing
\`tenant-config.json\`, deliberately contains **no** real publishable key, and
the separate pilot Netlify site remains empty. Do not publish these files
before a reviewed owner-bootstrap flow and a separately approved deploy.

The UI supports a verified existing owner login, and the separate source-only callback now implements invited-owner password creation. It does NOT implement invitation sending or trusted owner bootstrap. Those still require dedicated, audited server-side provisioning and separate approval before any invitation is sent.
The Supabase Auth Site URL and redirect allowlist can already be configured,
but a registered redirect alone does not make that callback route functional.

No RLS has been verified under a real owner JWT because no owner has been
created. The existing schema grants owner-only READ access; staff are blocked
in v1; payments and message writes require future trusted server handlers.
Review data API grants and run tenant-isolation/RLS tests before deployment.
All test/staging providers, especially the dedicated Netlify team, must be
checked again at the time of final approval.

At the future, SEPARATELY approved deploy milestone, a controlled builder
must generate \`tenant-config.json\` with ONLY these public fields, validated
against the approved pilot:
- \`projectUrl\`: https://nlupgjwcyivepzgqffss.supabase.co
- \`siteUrl\`: https://kleanly-business-crm-pilot.netlify.app
- \`publishableKey\`: the dedicated test Supabase \`sb_publishable_\` key

Do not send the publishable key through ChatGPT. The installer can obtain
it via a future reviewed provider integration. Do NOT supply \`service_role\`,
OAuth grants, database connection strings or administrator keys.

Security and source tests are at \`tests/crm-runtime.test.mjs\`.

This pilot does NOT implement password creation or callback exchange yet.
The package is not deployable without a separately approved configuration and owner provisioning.


## Owner invitation source — prepared, not enabled

- New \`auth/callback/index.html\` and \`invite-callback.mjs\` implement a
  **user-confirmed** invite acceptance screen. It never consumes an invitation
  automatically on a GET request or when an email security scanner opens it.
- \`invite-link.mjs\` accepts only this pilot's exact HTTPS callback and
  Supabase \`type=invite\` tokens, including default Supabase verified-session
  fragments and the preferred email template \`token_hash\` flow.
- Query tokens and session fragments are removed from the browser URL **before**
  loading configuration or contacting Supabase. No invite tokens are stored.
- On explicit acceptance, Supabase verifies the one-time invitation token.
  The resulting user must match the fixed staging test-owner email. A password
  may then be created, and the temporary Auth session is signed out.
- Setting a password grants **no access** to CRM records. All private records
  require the trusted, separately provisioned \`business_profile.owner_user_id\`
  and verified owner-only RLS. Do not offer an owner self-claim endpoint.
- Supabase's **Invite user** email template can be prepared using the example
  \`owner-invitation-email-template.html\`. The template is NOT applied by this
  commit, and no invitation is sent.
- A future server-only, single-attempt invite send requires a per-customer
  Supabase admin credential, an audited reservation and explicit approval.
  Project OAuth tokens cannot substitute for an Auth admin secret. No admin
  credential may enter the public CRM runtime.
- IMPORTANT: Supabase default \`{{ .ConfirmationURL }}\` may be pre-fetched
  by email scanners before the user clicks it. The preferred custom
  \`token_hash\` link is verified only when the user taps Accept invitation.

See \`tests/crm-invite-callback.test.mjs\` for scripted no-invite/no-data checks.
No Netlify project, database or Supabase Auth settings were changed.
