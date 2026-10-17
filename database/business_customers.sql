-- Klean.ly Business: first customer CRM table.
-- IMPORTANT: apply to the correct Klean.ly Supabase project only after testing.
-- Each business's records are linked to its existing cleaners.id.
-- Directory booking requests remain untouched.

create table if not exists public.business_customers (
  id uuid primary key default gen_random_uuid(),
  cleaner_id uuid not null references public.cleaners(id) on delete cascade,
  full_name text not null,
  phone text,
  email text,
  address_line1 text,
  address_line2 text,
  town text,
  postcode text,
  notes text,
  status text not null default 'active'
    check (status in ('active', 'archived')),
  search_text text generated always as (
    lower(
      coalesce(full_name, '') || ' ' ||
      coalesce(phone, '') || ' ' ||
      coalesce(email, '') || ' ' ||
      coalesce(address_line1, '') || ' ' ||
      coalesce(address_line2, '') || ' ' ||
      coalesce(town, '') || ' ' ||
      coalesce(postcode, '')
    )
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_customers_name_required
    check (char_length(btrim(full_name)) between 1 and 160)
);

create index if not exists business_customers_business_status_created_idx
  on public.business_customers (cleaner_id, status, created_at desc);

alter table public.business_customers enable row level security;

drop policy if exists "Business owners can read customers" on public.business_customers;
create policy "Business owners can read customers"
on public.business_customers for select to authenticated
using (
  exists (
    select 1 from public.cleaners c
    where c.id = business_customers.cleaner_id
      and c.user_id = (select auth.uid())
  )
);

drop policy if exists "Business owners can create customers" on public.business_customers;
create policy "Business owners can create customers"
on public.business_customers for insert to authenticated
with check (
  exists (
    select 1 from public.cleaners c
    where c.id = business_customers.cleaner_id
      and c.user_id = (select auth.uid())
  )
);

drop policy if exists "Business owners can update customers" on public.business_customers;
create policy "Business owners can update customers"
on public.business_customers for update to authenticated
using (
  exists (
    select 1 from public.cleaners c
    where c.id = business_customers.cleaner_id
      and c.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.cleaners c
    where c.id = business_customers.cleaner_id
      and c.user_id = (select auth.uid())
  )
);

-- Explicit grants are important: newly created tables are no longer
-- automatically exposed via Supabase's Data API on some projects.
-- No DELETE grant or DELETE policy: the UI uses reversible archiving.
revoke all on public.business_customers from anon;
revoke all on public.business_customers from authenticated;
grant select, insert, update on public.business_customers to authenticated;

comment on table public.business_customers is
  'Private customer records for a Klean.ly business. Not directory listings.';