# Staging only: one CRM schema installation pilot

This is the next stage after the successful, separately approved Supabase
project-creation pilot. Never merge this staging installer work into the
live directory's main branch.

## Exact target

- Website: https://kleanly-business-installer-staging.netlify.app
- Source branch: agent/white-label-installer-foundation (not main)
- Supabase test organization: kleanly test database (verified server-side)
- Supabase project name: Kleanly Business Staging CRM Pilot
- Final region: eu-central-1 (Frankfurt)
- Project ref: loaded from the immutable server-side pilot project creation
  record; never from a browser form
- Schema source: blueprint/0001_foundation.sql, mirrored exactly into
  blueprint/foundation-v1-bundled.mjs for safe Netlify function packaging.
  Unit tests verify identical SQL bytes and its SHA-256.

## Default: creation is LOCKED

KLEANLY_TEST_CRM_SCHEMA_INSTALL_ENABLED defaults to false. Do not set it
to true until the owner explicitly approves enabling this specific
staging pilot and understands a later click will make real database changes.

When it is approved, set the variable to true with scope Functions on
the **staging Netlify site only**, redeploy staging and verify new deployment
metadata. Never enable it on the live Klean.ly directory.

Even after the flag is on, applying schema requires:
1. The staging hostname, same-origin request, authenticated session and CSRF.
2. Connected Supabase and Netlify grants and verified account ownership.
3. The exact original test project stored in the one-project ledger.
4. Fresh healthy project status in the eu-central-1 region.
5. A fresh read-only query showing no directory or CRM tables.
6. A separate cost/changes acknowledgement and typed confirmation phrase.
7. An additional final browser confirmation.
8. An atomic one-shot control-plane ledger reservation BEFORE any SQL write.
9. Exactly one POST with the server-bundled SQL (never browser supplied).
10. Read-back verification of eight tables, RLS on all eight and schema v1.

A provider timeout, rejected request, unexpected response, interrupted network,
or missing ledger confirmation permanently blocks automatic retries. The
operator must inspect the Supabase dashboard before attempting manual repair.

The ledger intentionally has no cascading foreign keys. Disconnecting the
OAuth account MUST NOT remove the one-attempt reservation, or allow a second
project or schema write.

## Explicit non-goals for this milestone

No customer data, owner account, live CRM site, payment, paid add-ons,
or credentials are created or copied. An applied schema is not a complete
white-label installation; separate owner bootstrap, Netlify site, and application
deployment will be developed and approved later.

To stop further schema operations, disable the staging feature flag and
publish a new deployment. Disabling does NOT roll back installed tables.
