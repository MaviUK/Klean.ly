# Klean.ly Business development progress on the homepage

The public-facing **staging** homepage is at:
https://kleanly-business-installer-staging.netlify.app/

The installer remains on the **same staging site** at `/#setup`. OAuth
callbacks still land at the root with `supabase_test` or `netlify_result`
query parameters; `landing.js` recognises them and opens the wizard.
The static CRM design preview remains at `/crm-preview/`.

## Where the build percentage comes from

`white-label/installer/progress.json` is the progress source of truth.
The homepage fetches that JSON on first load and every two minutes while open.
Netlify republishes it whenever the staging branch successfully builds.

These are **reviewed planning estimates** (not commits, test counts,
GitHub workflow success rate, or measured feature completeness). The overall
percentage and first-installation percentage are independently estimated and
should not be computed as a naive average of the subsystem estimates.

When completing a verified Klean.ly Business development milestone:

1. Read the current `progress.json` and current implementation/tests.
2. Update only percentages supported by completed, verified work. It is fine
   to leave percentages unchanged for fixes, drafts or incomplete tasks.
3. Update `asOf` (ISO date), `nextMilestone`, and the latest `updates`.
4. Commit the JSON change to `agent/white-label-installer-foundation`,
   not `main`. Let the staging CI and Netlify deploy complete.
5. Verify the homepage shows the new estimate and that `/#setup`
   still works. Do not change the live klean.ly directory site.

**Important:** This ChatGPT Project's private conversations cannot be read
automatically by an unauthenticated public website. The linked source is the
GitHub development branch. During future coding sessions, update the
JSON alongside the relevant tested milestone so publishing is automatic.
No customer records, OAuth secrets or billing credentials belong in JSON.

## Deployment safety

- Netlify site: `kleanly-business-installer-staging`
- Repository: `MaviUK/Klean.ly`
- Branch: `agent/white-label-installer-foundation`
- Base directory: `white-label`
- Publish directory: `white-label/installer` relative to repository root
  (the Netlify configuration uses `publish = "installer"` from its base directory)
- Never merge the installer branch into the live Klean.ly directory's `main`
  solely to publish marketing updates.
- The staging site remains `noindex` until a separate production marketing
  launch is reviewed. Avoid presenting the pilot installer as a complete,
  self-service commercial product.
