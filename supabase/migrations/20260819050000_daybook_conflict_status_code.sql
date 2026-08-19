-- SQLSTATE 40001 is Postgres's serialization_failure class. PostgREST treats it
-- as a retryable transaction failure, so a stale-revision save was retried
-- instead of returned: the request hung and the client never saw the conflict.
-- PT409 is a PostgREST status-mapping code, returned to the client as HTTP 409.

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
      errcode = 'PT409',
      message = 'Daybook revision conflict.',
      detail = 'Reload the latest cloud daybook before saving again.';
  end if;
  return saved;
end;
$$;

revoke aifoodpal_daybook_writer from current_user;
revoke all on function public.save_daybook(bigint, jsonb) from public, anon;
grant execute on function public.save_daybook(bigint, jsonb) to authenticated;
