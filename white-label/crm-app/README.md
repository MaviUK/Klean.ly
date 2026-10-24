# Klean.ly Business CRM interface — prototype v0.1

This folder is the *source package* for the future customer-owned CRM
application. It is not the Klean.ly directory and must never be merged into
the directory's production branch.

Status: **design and navigation prototype only**. There is no login,
Supabase connection, customer data, or payment integration. Actions that
would alter private business records are intentionally disabled. The static
dashboard uses an em dash instead of inventing counts or examples.

All eight planned modules are visible: overview, customers, cleaning rounds,
jobs and schedules, payments, message history, team, and settings. Navigation
is functional on mobile and desktop but no API calls occur.

Staging preview is copied from this folder into the **staging installer
website's** /crm-preview/ route at build time. The separate Netlify CRM
pilot site kleanly-business-crm-pilot.netlify.app remains EMPTY.

Important deploy gate
---------------------
The deployment-manifest.json file has deployable=false. Do **not** upload this
prototype to the customer CRM site, which must eventually have:

1. Server-verified tenant identity and initial owner invitation.
2. Supabase Auth session/callback and secure logout.
3. Owner-only RLS and table-grant checks against the dedicated database.
4. Publishable client Supabase configuration only; NEVER ship service_role
   keys, Netlify OAuth tokens, database passwords or payment secrets.
5. Business data reads/writes backed by the eight-table schema, with tests.
6. Signed/guarded one-time deployment approval in the staging installer.

Production hosting must be independently authorised; this prototype was not
approved for actual deployment. If Netlify preview access is publicly
reachable, only the static demo is exposed. No real customer data is stored
or displayed.

The future deploy workflow should use the separate company's encrypted
Netlify OAuth grant and a package fingerprint/immutable deployment ledger.
It must not link the private master repository to each customer website.
