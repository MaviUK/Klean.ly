# Klean.ly Business — Customers (Milestone 1)

This feature adds a **business-only CRM**, separate from the public cleaning directory.

## Routes

- `/business` — workspace home
- `/business/customers` — customer list, search, add, edit, archive and restore
- Existing directory routes, registrations, sponsorship and `cleaner_booking_requests` are unchanged.

## Database setup

1. Confirm the **correct** Supabase project behind Klean.ly. Do **not** apply this to an unrelated Supabase project.
2. Take a backup and use a staging database / preview branch.
3. Apply `database/business_customers.sql` using your normal migration process.
4. Verify the `authenticated` role has SELECT/INSERT/UPDATE; the `anon` role has no permissions.
5. Test with two independent cleaner-owner accounts (A and B): A can create, read and edit A's records but not B's; B cannot access A's records. Test rejected cross-business writes by supplying the other business's `cleaner_id`.
6. Confirm customer search, pagination, archiving and restoration work. Check `npm run build`.
7. Apply the reviewed schema to the live project before enabling the feature in production.

The business table references the existing `cleaners.id` and verifies ownership through `cleaners.user_id = auth.uid()`. The authenticated user is checked by Supabase RLS, not a client-supplied identity field.

## Scope and future development

- First milestone intentionally supports business **owners** only; staff accounts and delegated permissions need explicit membership policies later.
- Customer records are independent of booking requests. We will add an explicit conversion flow rather than silently copying enquiries into the CRM.
- The application uses archiving, not permanent deletion. Data export, erasure, and retention controls must be added before broad use.
- Recurring services, rounds, staff, payments, bulk CSV imports and SMS integrations will be separate milestones.
- White-label company deployments can eventually use isolated database instances. For now, RLS isolates business data within Klean.ly; **this is not yet a separate database per company**.

## Supabase API change

Current Supabase projects may require explicit grants to expose newly created public tables via the Data API. The schema script includes those grants, together with RLS policies.
