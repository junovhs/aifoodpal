-- Hosted Supabase owns the auth schema as supabase_admin, so the migration
-- administrator's `grant usage on schema auth` in the initial migration is
-- accepted without effect. The SECURITY DEFINER writer role therefore could not
-- call auth.uid() and every save failed with "permission denied for schema
-- auth". Resolve the caller from the request JWT claims instead, which needs no
-- privilege on the auth schema and matches auth.uid()'s own definition.

create or replace function public.daybook_caller_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid;
$$;

comment on function public.daybook_caller_id() is
  'Authenticated caller id read from the request JWT, without requiring auth schema access.';

revoke all on function public.daybook_caller_id() from public, anon;
grant execute on function public.daybook_caller_id() to authenticated, aifoodpal_daybook_writer;

drop policy if exists "RPC writer can read the caller's daybook" on public.daybooks;
drop policy if exists "RPC writer can create the caller's daybook" on public.daybooks;
drop policy if exists "RPC writer can update the caller's daybook" on public.daybooks;

create policy "RPC writer can read the caller's daybook"
on public.daybooks
for select
to aifoodpal_daybook_writer
using ((select public.daybook_caller_id()) = user_id);

create policy "RPC writer can create the caller's daybook"
on public.daybooks
for insert
to aifoodpal_daybook_writer
with check ((select public.daybook_caller_id()) = user_id);

create policy "RPC writer can update the caller's daybook"
on public.daybooks
for update
to aifoodpal_daybook_writer
using ((select public.daybook_caller_id()) = user_id)
with check ((select public.daybook_caller_id()) = user_id);

-- Replacing a function owned by the writer role requires membership, granted
-- only for the replacement and revoked immediately afterward.
grant aifoodpal_daybook_writer to current_user;

create or replace function public.save_daybook(expected_revision bigint, next_state jsonb)
returns public.daybooks
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := public.daybook_caller_id();
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

revoke aifoodpal_daybook_writer from current_user;
revoke all on function public.save_daybook(bigint, jsonb) from public, anon;
grant execute on function public.save_daybook(bigint, jsonb) to authenticated;
