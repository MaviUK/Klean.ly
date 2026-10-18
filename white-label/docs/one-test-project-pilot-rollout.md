# Staging-only: single test Supabase project pilot

This document records the controlled pilot deployment for the separately hosted
**Klean.ly Business staging installer**. It does not alter the live
`https://klean.ly` directory or any existing customer database.

## Pilot controls

The user approved **enabling the pilot creation option**, not creating a project.
The feature is protected by a **staging-site-only** Netlify Functions variable
(`KLEANLY_TEST_PROJECT_CREATION_ENABLED=true`) and an additional allowlist
using `KLEANLY_PILOT_OWNER_EMAIL` and
`KLEANLY_PILOT_ORGANIZATION_NAME`, kept in staging environment settings.

The pilot:
- shows a read-only proposal first, with the connected organisation and region;
- requires a valid same-origin session, CSRF token, both authorised providers and
  a fresh Free Plan capacity check;
- requires a separate typed confirmation, explicit cost acknowledgement and a
  final browser confirmation **after the owner elects to create the project**;
- generates a random database password server-side and stores it encrypted;
- writes an atomic, **single globally unique** project reservation in the
  isolated installer database **before** submitting its one provider POST;
- permanently blocks automated retry on uncertain outcomes;
- requests no paid add-ons or premium instance size;
- never creates a Netlify website or installs CRM tables in this milestone.

The Supabase Free Plan project's eligibility is **not a guarantee** of
availability or zero costs. Supabase ultimately enforces quotas, regions and
billing. Only the owner may approve the real test creation.

## Deliberate rollout separation

Enabling the option in the staging Functions environment is an infrastructure
configuration change. It does **not** invoke the create endpoint. That requires
a fresh interactive approval from the user's staging browser session.

To disable future creation access without touching existing provider grants,
set `KLEANLY_TEST_PROJECT_CREATION_ENABLED=false` on the staging Netlify site
and publish a new deployment. Do not set this option on any live website.
