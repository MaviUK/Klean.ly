# Klean.ly Business — first CRM test deployment

**Approval recorded:** user authorised ONE deployment to the existing test
Netlify website. Deployment is NOT an approval to invite the owner, create
accounts, import customers, change RLS or use the production Klean.ly project.

## Approved target

- Existing website: `https://kleanly-business-crm-pilot.netlify.app`
- Netlify site ID: `c4632a28-a4b0-4e77-a54e-7a8bf05a8882`
- Free Plan Netlify team: `kleanlytest`
- Test Supabase project: `nlupgjwcyivepzggffss`
- CRM package: nine audited static files plus a generated JSON object that
  contains ONLY a publishable key, public project URL and site URL

## Activation and audit safeguards

- Deployment endpoint: `/.netlify/functions/crm-app-deploy-once`, on the
  staging installer host ONLY.
- Gated by `KLEANLY_TEST_CRM_DEPLOY_ENABLED=true`, set on the INSTALLER
  Netlify site's production Functions environment ONLY (not on the CRM site).
- Revalidates the original immutable project, schema and Netlify site records.
- Uses ONLY the OAuth credential connected to the `kleanlytest` Netlify
  account inside the installer. Never use the ChatGPT-connected production
  Netlify account or the Klean.ly directory's production Supabase.
- Requires exactly two consent checkboxes, a precise confirmation phrase and
  a TEST Supabase publishable key beginning `sb_publishable_`.
- Re-reads live test Netlify account/team/website state: Free Plan, exact site
  ID, no previous deploys, no linked repository.
- Revalidates the publishable key against the TEST Supabase Auth endpoint and
  ensures public signups are disabled.
- Saves one permanent global unique deployment reservation in the INSTALLER
  control-plane database, then marks `submitted` BEFORE issuing one Netlify
  ZIP POST. The status persists across logouts and OAuth reconnects.
- Unknown, interrupted and rejected provider outcomes are **never
  automatically retried**. Only read-only GET status checks are permitted.
- No personal credentials, publishable key, owner invitation, customer
  records or Netlify access tokens are written to the audit ledger.

## Next real-world user action

1. Open the Klean.ly Business staging installer.
2. Under **Deploy ONE test CRM application**, press **Check deployment
   status (read-only)** to confirm the one-time ledger is installed and unused.
3. Paste the previously verified TEST Supabase **publishable** key into the
   dedicated deployment field. Do not paste a secret key or share any key
   in a chat.
4. Tick the two deployment confirmations, type
   `DEPLOY ONE TEST CRM`, and submit ONE time.
5. If the result is processing, use the READ-ONLY status button. Never retry
   submission if the outcome is uncertain.
6. When Netlify confirms ready, visit the exact TEST URL. Owner authentication,
   invitations and customer workflows remain separate, future approvals.
