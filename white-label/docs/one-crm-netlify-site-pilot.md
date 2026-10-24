# Staging pilot: create exactly one empty CRM Netlify site

Scope: agent/white-label-installer-foundation branch, staging installer only.
Never merge into main and never modify the live klean.ly directory Netlify site.

Approved identifiers (hardcoded as allowlist for this one pilot, never derived
from browser input):
- Test owner email: kleanlytest@gerball.co.uk
- Separate Netlify team slug: kleanlytest (Free Plan only)
- Proposed name: kleanly-business-crm-pilot.netlify.app
- Existing verified CRM: Kleanly Business Staging CRM Pilot, Frankfurt region
- No paid add-ons, no domain, no application deployment, no owner invite.

Free Plan review on 18 October 2026: owner provided a Netlify billing screenshot
showing 300 of 300 credits remaining and no payment method saved. This
information is owner-provided and MUST NOT be treated as a live API response.
The provider access check re-verifies the Free Plan, team ID, project limit,
available project name in the connected account and completed CRM schema.
Global hostname availability remains unknown until the single POST.

The create endpoint is DISABLED BY DEFAULT:
KLEANLY_TEST_CRM_SITE_CREATION_ENABLED=false (absence also means false).

Only after the owner specifically authorizes enabling the exact one-website
pilot, set this variable to true on staging only with Functions scope. Netlify
requires a new deploy before Functions see the updated environment variable.

Even when enabled, it still requires:
1. Staging hostname, same-origin, authenticated session and CSRF.
2. Approved test owner, immutable completed Supabase + CRM schema records.
3. Fresh Netlify Free Plan and team verification through the separate OAuth
   grant (not through ChatGPT's Netlify connection to the live directory).
4. A fresh capacity and account name check.
5. No previous site-creation reservation (global unique pilot-site key).
6. Two owner acknowledgements, exact typed phrase, final browser confirm.
7. Atomic Netlify Database reservation before the ONE provider POST.
8. Exactly one POST /api/v1/kleanlytest/sites with body
   {"name":"kleanly-business-crm-pilot"}.
9. Fresh GET /api/v1/sites/{id} verifying name, team and provider site ID.
10. Store success or unknown status permanently. No automatic retry.

An uncertain response, provider timeout, crash, failed verification or ledger
write failure requires manual Netlify inspection. A second automated
creation request is permanently blocked even if the OAuth account is
disconnected and reconnected. The ledger deliberately has no cascading FKs.

Netlify Database applies the new staging migration on deployment before
publishing. If migration does not apply, the approval endpoint fails closed.

Creating an empty site does NOT deploy the CRM app or configure owner login.
Those require separate milestones, tests and explicit approvals.

Do not implement a site-creation retry, auto cleanup or automatic deletion
to work around unknown outcomes. Disabling the feature flag never deletes
the site or reservation.
