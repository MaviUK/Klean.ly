-- PROPOSED ONLY — NOT AN ACTIVE MIGRATION.
-- This belongs to the installer CONTROL PLANE database, NEVER the customer
-- Supabase project. It may be promoted to netlify/database/migrations ONLY
-- with separately reviewed provisioning approval and a backup.
--
-- Intentionally NO foreign keys to OAuth connections, portal_users or sites.
-- Disconnect/reconnect must never reset a one-time approval or audit lock.
create table portal_test_crm_first_owner_operations (
  request_id uuid primary key,
  operation_key text not null unique
    check (operation_key in ('pilot-first-owner-invite-v1',
                             'pilot-first-owner-bind-v1')),
  user_id text not null check (length(user_id) between 1 and 128),
  organization_id text not null check (length(organization_id) between 1 and 128),
  project_ref text not null
    check (project_ref = 'nlupgjwcyivepzggffss'),
  owner_email text not null
    check (owner_email = 'kleanlytest@gerball.co.uk'),
  target_site text not null default
    'https://kleanly-business-crm-pilot.netlify.app'
    check (target_site = 'https://kleanly-business-crm-pilot.netlify.app'),
  status text not null
    check (status in ('reserved','submitted','sent','applied','unknown')),
  approved_at timestamptz not null default now(),
  submitted_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, organization_id, operation_key)
);

create index portal_test_crm_first_owner_operations_status_idx
  on portal_test_crm_first_owner_operations (status, approved_at desc);
