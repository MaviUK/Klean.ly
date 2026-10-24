-- Klean.ly Business: dedicated single-company database blueprint v1
-- NEVER apply to the existing Klean.ly directory database.
-- No customer information, payment keys, or test data are copied.
begin;

do $guard$
begin
  if to_regclass('public.cleaners') is not null then
    raise exception 'Dedicated database required: this database has the Klean.ly directory cleaners table.';
  end if;
  if to_regclass('public.business_customers') is not null then
    raise exception 'Dedicated database required: legacy directory CRM table detected.';
  end if;
end
$guard$;

create schema if not exists kleanly_internal;
revoke all on schema kleanly_internal from public, anon, authenticated;

create table if not exists kleanly_internal.schema_versions (
  version integer primary key,
  applied_at timestamptz not null default now()
);
revoke all on table kleanly_internal.schema_versions from public, anon, authenticated;

-- Singleton record, created by privileged provisioning after owner account exists.
-- Do not enable public signup to claim an empty installation.
create table if not exists public.business_profile (
  id smallint primary key default 1 check (id = 1),
  owner_user_id uuid not null references auth.users(id),
  business_name text not null check (char_length(trim(business_name)) between 1 and 160),
  logo_url text,
  primary_color text not null default '#059669'
    check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  support_email text,
  contact_phone text,
  timezone text not null default 'Europe/London',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null check (role in ('owner','admin','worker')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(trim(full_name)) between 1 and 160),
  phone text,
  email text,
  address_line1 text,
  address_line2 text,
  town text,
  postcode text,
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customers_name_idx on public.customers (lower(full_name));
create index if not exists customers_postcode_idx on public.customers (postcode);
create index if not exists customers_archived_created_idx on public.customers (archived_at, created_at desc);

create table if not exists public.rounds (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  cadence_days integer not null default 28 check (cadence_days between 1 and 365),
  route_day smallint check (route_day between 0 and 6),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.customer_services (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  round_id uuid references public.rounds(id) on delete set null,
  service_name text not null,
  service_variant text,
  quantity integer not null default 1 check (quantity > 0),
  unit_price_pence integer not null default 0 check (unit_price_pence >= 0),
  cadence_days integer not null default 28 check (cadence_days between 1 and 365),
  next_visit_on date,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists customer_services_customer_idx on public.customer_services (customer_id);
create index if not exists customer_services_due_idx on public.customer_services (next_visit_on) where is_active;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  customer_service_id uuid not null references public.customer_services(id) on delete restrict,
  scheduled_for date not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','completed','missed','cancelled')),
  assigned_user_id uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  unique (customer_service_id, scheduled_for)
);
create index if not exists jobs_scheduled_status_idx on public.jobs (scheduled_for, status);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  job_id uuid references public.jobs(id) on delete set null,
  provider text not null check (provider in ('stripe','gocardless','bank','cash','other')),
  provider_reference text,
  amount_pence integer not null,
  currency text not null default 'GBP' check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('pending','paid','failed','refunded')),
  created_at timestamptz not null default now()
);
create index if not exists payments_customer_created_idx on public.payments (customer_id, created_at desc);

create table if not exists public.message_log (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete restrict,
  channel text not null check (channel in ('email','sms','whatsapp')),
  provider text,
  status text not null check (status in ('queued','sent','delivered','failed')),
  external_id text,
  subject text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- No anonymous access. Customer data is readable only after the owner has
-- been provisioned by a trusted backend (not self-claimed by signups).
alter table public.business_profile enable row level security;
revoke all on public.business_profile from anon, authenticated;
grant select on public.business_profile to authenticated;
grant update (business_name, logo_url, primary_color, support_email, contact_phone, timezone, updated_at)
  on public.business_profile to authenticated;

drop policy if exists business_profile_owner_read on public.business_profile;
create policy business_profile_owner_read on public.business_profile for select to authenticated
using (owner_user_id = (select auth.uid()));

drop policy if exists business_profile_owner_update on public.business_profile;
create policy business_profile_owner_update on public.business_profile for update to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));

-- Keep all other tables owner-only in v1. Staff permissions will be introduced
-- with explicit membership and assignment checks in a later migration.
do $policies$
declare
  target text;
  owner_predicate text :=
    'exists (select 1 from public.business_profile b where b.id=1 and b.owner_user_id=(select auth.uid()))';
begin
  foreach target in array array['team_members','customers','rounds','customer_services','jobs','payments','message_log']
  loop
    execute format('alter table public.%I enable row level security', target);
    execute format('revoke all on public.%I from anon, authenticated', target);
    execute format('grant select on public.%I to authenticated', target);
    execute format('drop policy if exists kb_owner_select on public.%I', target);
    execute format('create policy kb_owner_select on public.%I for select to authenticated using (%s)', target, owner_predicate);
    if target in ('customers','rounds','customer_services','jobs','team_members') then
      execute format('grant insert, update on public.%I to authenticated', target);
      execute format('drop policy if exists kb_owner_insert on public.%I', target);
      execute format('create policy kb_owner_insert on public.%I for insert to authenticated with check (%s)', target, owner_predicate);
      execute format('drop policy if exists kb_owner_update on public.%I', target);
      execute format('create policy kb_owner_update on public.%I for update to authenticated using (%s) with check (%s)',
        target, owner_predicate, owner_predicate);
    end if;
  end loop;
end
$policies$;

-- payment and message records are written only by trusted server functions;
-- signed-in owners may inspect them but cannot forge payment status/delivery.
insert into kleanly_internal.schema_versions (version) values (1)
on conflict (version) do nothing;

commit;
