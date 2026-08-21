-- Per-user ledger for AI capture calls. Kept out of the daybook aggregate on purpose:
-- DEC-01 makes every daybook save an optimistic read-modify-write of one JSONB row, and
-- metering a spend against that would lose races with the open tab and could not be
-- enforced server-side. This table is append-and-increment only, and nothing but the
-- consume_ai_credit RPC ever writes it.

create table public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('label', 'estimate')),
  calls integer not null default 0 check (calls >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day, kind)
);

comment on table public.ai_usage is 'One row per user, day, and capture kind; incremented only by consume_ai_credit.';
comment on column public.ai_usage.kind is 'label = nutrition panel transcription (cheap model); estimate = plate judgement (stronger model).';

create index ai_usage_user_month_idx on public.ai_usage (user_id, day);

alter table public.ai_usage enable row level security;
alter table public.ai_usage force row level security;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'aifoodpal_ai_usage_writer') then
    create role aifoodpal_ai_usage_writer nologin nobypassrls;
  end if;
end;
$$;

revoke all on table public.ai_usage from anon, authenticated;
grant select on table public.ai_usage to authenticated;
grant usage on schema public to aifoodpal_ai_usage_writer;
grant select, insert, update on table public.ai_usage to aifoodpal_ai_usage_writer;

-- Resolve the caller from the request JWT, never from the auth schema: hosted Supabase
-- owns auth as supabase_admin, so a grant on it is accepted without effect (see the
-- daybook_caller_id migration, which exists for exactly that failure).
grant execute on function public.daybook_caller_id() to aifoodpal_ai_usage_writer;

create policy "Users can read their own AI usage"
on public.ai_usage
for select
to authenticated
using ((select public.daybook_caller_id()) = user_id);

create policy "RPC writer can read the caller's AI usage"
on public.ai_usage
for select
to aifoodpal_ai_usage_writer
using ((select public.daybook_caller_id()) = user_id);

create policy "RPC writer can create the caller's AI usage"
on public.ai_usage
for insert
to aifoodpal_ai_usage_writer
with check ((select public.daybook_caller_id()) = user_id);

create policy "RPC writer can update the caller's AI usage"
on public.ai_usage
for update
to aifoodpal_ai_usage_writer
using ((select public.daybook_caller_id()) = user_id)
with check ((select public.daybook_caller_id()) = user_id);

create type public.ai_credit_grant as (
  remaining_today integer,
  remaining_month integer
);

comment on type public.ai_credit_grant is 'What is left of the caller''s allowance after the call that was just charged.';

-- Caps live here, not in the client or the Edge Function, so a caller cannot raise its own
-- ceiling. Chosen so ordinary use never reaches them: ten captures a day is heavy use, and
-- the AI cost of a full month at these caps is well under a dollar.
-- The parameter is not called `kind`: an unqualified `kind` inside the INSERT would be
-- ambiguous against ai_usage.kind and fail at runtime with SQLSTATE 42702.
create or replace function public.consume_ai_credit(capture_kind text)
returns public.ai_credit_grant
language plpgsql
security definer
set search_path = ''
as $$
declare
  daily_cap constant integer := 40;
  monthly_cap constant integer := 500;
  caller_id uuid := public.daybook_caller_id();
  today date := (now() at time zone 'utc')::date;
  used_today integer;
  used_month integer;
  granted public.ai_credit_grant;
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;
  if capture_kind is null or capture_kind not in ('label', 'estimate') then
    raise exception using errcode = '22023', message = 'Unknown capture kind.';
  end if;

  insert into public.ai_usage (user_id, day, kind, calls)
  values (caller_id, today, capture_kind, 1)
  on conflict (user_id, day, kind)
  do update set calls = public.ai_usage.calls + 1, updated_at = now();

  select coalesce(sum(calls), 0) into used_today
  from public.ai_usage
  where user_id = caller_id and day = today;

  select coalesce(sum(calls), 0) into used_month
  from public.ai_usage
  where user_id = caller_id and date_trunc('month', day) = date_trunc('month', today);

  -- Raising here aborts the calling statement, so the increment above is rolled back and a
  -- refused call is never charged. PT429 is a PostgREST status-mapping code returned to the
  -- client as HTTP 429; a plain Postgres errcode would surface as an opaque 500.
  if used_today > daily_cap then
    raise exception using
      errcode = 'PT429',
      message = 'Daily AI limit reached.',
      detail = 'Today''s capture allowance is used up. It resets tomorrow.';
  end if;
  if used_month > monthly_cap then
    raise exception using
      errcode = 'PT429',
      message = 'Monthly AI limit reached.',
      detail = 'This month''s capture allowance is used up.';
  end if;

  granted.remaining_today := daily_cap - used_today;
  granted.remaining_month := monthly_cap - used_month;
  return granted;
end;
$$;

comment on function public.consume_ai_credit(text) is
  'Charges one AI capture against the caller''s allowance and returns what remains, or raises PT429.';

-- Hosted Supabase migrations run as a CREATEROLE administrator rather than a superuser.
-- Membership is required only for the ownership transfer and is removed immediately after.
grant aifoodpal_ai_usage_writer to current_user;
grant create on schema public to aifoodpal_ai_usage_writer;
alter function public.consume_ai_credit(text) owner to aifoodpal_ai_usage_writer;
revoke create on schema public from aifoodpal_ai_usage_writer;
revoke aifoodpal_ai_usage_writer from current_user;
revoke all on function public.consume_ai_credit(text) from public, anon;
grant execute on function public.consume_ai_credit(text) to authenticated;
