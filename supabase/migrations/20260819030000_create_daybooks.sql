create table public.daybooks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daybooks_state_is_object check (jsonb_typeof(state) = 'object'),
  constraint daybooks_state_has_schema_version check (state ? 'schemaVersion')
);

comment on table public.daybooks is 'One revisioned AIfoodpal AppState aggregate per authenticated user.';
comment on column public.daybooks.revision is 'Optimistic concurrency token; clients must save through save_daybook.';

alter table public.daybooks enable row level security;
alter table public.daybooks force row level security;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'aifoodpal_daybook_writer') then
    create role aifoodpal_daybook_writer nologin nobypassrls;
  end if;
end;
$$;

revoke all on table public.daybooks from anon, authenticated;
grant select on table public.daybooks to authenticated;
grant usage on schema public, auth to aifoodpal_daybook_writer;
grant execute on function auth.uid() to aifoodpal_daybook_writer;
grant select, insert, update on table public.daybooks to aifoodpal_daybook_writer;

create policy "Users can read their own daybook"
on public.daybooks
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "RPC writer can read the caller's daybook"
on public.daybooks
for select
to aifoodpal_daybook_writer
using ((select auth.uid()) = user_id);

create policy "RPC writer can create the caller's daybook"
on public.daybooks
for insert
to aifoodpal_daybook_writer
with check ((select auth.uid()) = user_id);

create policy "RPC writer can update the caller's daybook"
on public.daybooks
for update
to aifoodpal_daybook_writer
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create or replace function public.save_daybook(expected_revision bigint, next_state jsonb)
returns public.daybooks
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  saved public.daybooks%rowtype;
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;
  if expected_revision < 0 then
    raise exception using errcode = '22023', message = 'Expected revision cannot be negative.';
  end if;
  if next_state is null or jsonb_typeof(next_state) <> 'object' or not (next_state ? 'schemaVersion') then
    raise exception using errcode = '22023', message = 'Daybook state must be an object with schemaVersion.';
  end if;

  if expected_revision = 0 then
    insert into public.daybooks (user_id, state, revision)
    values (caller_id, next_state, 1)
    on conflict (user_id) do nothing
    returning * into saved;
  else
    update public.daybooks
    set state = next_state,
        revision = revision + 1,
        updated_at = now()
    where user_id = caller_id and revision = expected_revision
    returning * into saved;
  end if;

  if saved.user_id is null then
    raise exception using
      errcode = '40001',
      message = 'Daybook revision conflict.',
      detail = 'Reload the latest cloud daybook before saving again.';
  end if;
  return saved;
end;
$$;

-- Hosted Supabase migrations run as a CREATEROLE administrator rather than a
-- superuser. Membership is required only for the ownership transfer, and is
-- removed immediately afterward so the migration role does not inherit access.
grant aifoodpal_daybook_writer to current_user;
grant create on schema public to aifoodpal_daybook_writer;
alter function public.save_daybook(bigint, jsonb) owner to aifoodpal_daybook_writer;
revoke create on schema public from aifoodpal_daybook_writer;
revoke aifoodpal_daybook_writer from current_user;
revoke all on function public.save_daybook(bigint, jsonb) from public, anon;
grant execute on function public.save_daybook(bigint, jsonb) to authenticated;
