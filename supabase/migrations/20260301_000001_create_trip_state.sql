-- Shared trip state for couple sync (budget + packing list)
create table if not exists public.trip_state (
  trip_id text primary key,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trip_state_trip_id_format_chk
    check (trip_id ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  constraint trip_state_payload_object_chk
    check (jsonb_typeof(payload) = 'object')
);

comment on table public.trip_state is 'Shared PWA state per trip code (local-first sync payload).';
comment on column public.trip_state.trip_id is 'Shared trip code used by both devices.';
comment on column public.trip_state.payload is 'JSON payload containing packItems and budgetState.';

create index if not exists trip_state_updated_at_idx on public.trip_state (updated_at desc);

create or replace function public.set_trip_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_trip_state_updated_at on public.trip_state;
create trigger trg_trip_state_updated_at
before update on public.trip_state
for each row
execute function public.set_trip_state_updated_at();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'trip_state'
  ) then
    alter publication supabase_realtime add table public.trip_state;
  end if;
end;
$$;

alter table public.trip_state enable row level security;

-- App uses a publishable/anon key from the browser.
grant usage on schema public to anon, authenticated;
grant select, insert, update on table public.trip_state to anon, authenticated;

drop policy if exists trip_state_select_shared on public.trip_state;
create policy trip_state_select_shared
on public.trip_state
for select
to anon, authenticated
using (true);

drop policy if exists trip_state_insert_shared on public.trip_state;
create policy trip_state_insert_shared
on public.trip_state
for insert
to anon, authenticated
with check (
  trip_id ~ '^[a-z0-9][a-z0-9-]{2,79}$'
  and jsonb_typeof(payload) = 'object'
);

drop policy if exists trip_state_update_shared on public.trip_state;
create policy trip_state_update_shared
on public.trip_state
for update
to anon, authenticated
using (true)
with check (
  trip_id ~ '^[a-z0-9][a-z0-9-]{2,79}$'
  and jsonb_typeof(payload) = 'object'
);
