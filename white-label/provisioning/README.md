# Klean.ly Business — first-owner pilot provisioning (source-only plan)

**Status:** OFF / not deployed / no invitation sent / no owner assigned.

This is the next milestone after the dedicated test database + empty Netlify site
were created. None of the files in this directory is imported by the
\`white-label/netlify/functions\` directory. \`netlify.toml\` still publishes
only \`installer/\`. The proposed ledger SQL is NOT an active migration.

## Ground-truth environment (the only allowed pilot)

- Supabase test project \`nlupgjwcyivepzggffss\` — Frankfurt
- Empty CRM site \`https://kleanly-business-crm-pilot.netlify.app\`
- Test owner \`kleanlytest@gerball.co.uk\`
- Callback \`https://kleanly-business-crm-pilot.netlify.app/auth/callback\`
- Schema version 1 / eight public business tables / eight enabled RLS policies
- No customer records copied from the Klean.ly directory

Do not use the main Klean.ly project's Supabase database or Netlify team.

## Operation sequence: NEVER reorder

1. **Review**: verify the dedicated CRM project, eight RLS tables, no owner,
   no staff, zero Auth users; verify Netlify site identity and Free Plan.
2. **Build and test** \`crm-runtime\`; configure a dedicated test project's
   \`sb_publishable_\` API key into \`tenant-config.json\` in an approved build
   pipeline. Never publish a \`service_role\` or \`sb_secret_\` value.
3. **Separate approval to deploy** the tested runtime to the existing single
   Netlify test site. Check both \`/\` and \`/auth/callback\` are live and
   accessible; verify expected asset fingerprints and CSP.
4. **Review the Supabase Auth Invite User email template**. Supabase's default
   \`{{ .ConfirmationURL }}\` can be pre-fetched and consumed by email scanners.
   Prefer the staged \`{{ .TokenHash }}\` custom link to the live callback,
   where the user must click Accept invitation before token verification.
5. **Verify outbound email**: Supabase's default SMTP is limited and typically
   only sends to members of that Supabase project's organisation. Custom SMTP
   is required for general customer delivery. Verify this test recipient or
   configure a trusted SMTP service before attempting delivery.
6. **Separate explicit approval to invite one owner**. Recheck all external
   evidence from trusted APIs, with actual Auth users count ZERO and callback
   serving the correct code. The server-only adapter must use the test
   project's Supabase Auth Admin API and a secret credential stored ONLY in
   a secure provider runtime, not in browser config or ChatGPT text.
7. **Reserve one permanent unique invitation attempt** in the *installer
   control-plane* ledger. Before ANY Auth API request, mark it submitted. Call
   \`auth.admin.inviteUserByEmail\` ONCE with the exact pilot email and callback.
   On timeout/unknown, do NOT retry or revoke/resend automatically.
8. The recipient opens the invite email and explicitly clicks Accept
   invitation. The callback verifies the email/one-time Auth token and lets
   that person set a password. The temporary setup session signs out.
   This DOES NOT grant owner status; all CRM data remains protected by RLS.
9. **Separate explicit approval to bind the owner** after checking exactly
   one confirmed invited Auth user who has signed in and set a password.
   Reserve and submit a separate one-time operation. Execute
   \`ASSIGN_FIRST_OWNER_SQL\` once on the verified test project using the
   server-side Supabase Management SQL endpoint with the verified OAuth grant.
   The one SQL transaction resolves the user UUID from \`auth.users\` (never
   from browser input) and inserts BOTH the singleton \`business_profile\`
   and owner \`team_members\` record, or rolls back.
10. Verify that the two records match, then test RLS with a real test owner
    and a deliberately unauthorised test account before allowing any data
    import or customer-facing workflow. If either attempt's ledger is
    \`submitted\` or \`unknown\`, stop and manually reconcile before proceeding.

## Security properties

- The invitation and owner-binding functions are **not public endpoints**.
  A future activation must require a verified installer portal session,
  same-origin validation, CSRF, immutable test organisation/project allowlists,
  signed approval evidence read from server-side providers, and explicit
  single-use user consent; do not trust form fields to attest provider state.
- The staging switches remain OFF:
  \`KLEANLY_TEST_FIRST_OWNER_INVITE_ENABLED\` and
  \`KLEANLY_TEST_FIRST_OWNER_ASSIGN_ENABLED\`.
- \`control-plane-owner-ledger.proposed.sql\` must not be executed until the
  migration is explicitly approved and the portal database is backed up.
  Its UNIQUE keys survive OAuth disconnects, logouts and repeated requests.
- A private Supabase secret/service-role key is never placed in frontend
  bundles, Netlify build logs, ChatGPT or the OAuth access token.
- Server-side email APIs can report \`submitted\`, NOT guaranteed delivered.
- Management OAuth with \`database:write\` authorisation is a different grant
  from Supabase Auth Admin. Never use Management OAuth as an Auth user JWT.
- Supabase RLS must remain ON for all public business tables. Never grant
  anonymous CRM access; never use editable \`user_metadata\` to grant roles.
- No sample secrets, actual customer details or privileged JWTs are committed.

## Activation blockers / need the user's action

The dedicated CRM test site has NO deployed app, no approved
\`tenant-config.json\`, no first-owner invitation, and no control-plane ledger
migration. The available ChatGPT Supabase connector currently does not expose
this test CRM project, so it cannot independently verify live Auth-user counts,
table privileges or project keys. Any required provider authorisation and
deployment approval must be explicit, and credentials must be handled only
through the provider's secure UI/secret manager.

**Next consent point:** approval to prepare/deploy the new CRM web app on the
existing test Netlify site (NOT the live Klean.ly website). Even that approval
does not authorise an invitation, account creation or owner assignment.

## Testing

\`node --test tests/first-owner-pilot.test.mjs tests/owner-server-adapters.test.mjs\`

These are mocked/offline server-contract tests. Before launch, run a real
end-to-end invitation and JWT/RLS access test under the approved test project.
