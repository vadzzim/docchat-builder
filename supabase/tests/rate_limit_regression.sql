-- Run against the local database with a privileged psql connection.
-- The transaction guarantees that the fixture leaves no rows behind:
-- docker exec <db-container> psql -U postgres -d postgres -f /path/to/rate_limit_regression.sql
begin;

do $$
declare
  first_result jsonb;
  rollover_result jsonb;
  released_result jsonb;
  first_lease uuid;
  second_lease uuid;
begin
  select public.reserve_rate_limit('__docchat_rate_test__', 1, 10, 1, 60)
    into first_result;
  if coalesce((first_result->>'allowed')::boolean, false) is not true then
    raise exception 'first rate-limit reservation was rejected: %', first_result;
  end if;
  first_lease := (first_result->>'lease_id')::uuid;

  select public.reserve_rate_limit('__docchat_rate_test__', 1, 10, 1, 60)
    into rollover_result;
  if coalesce((rollover_result->>'allowed')::boolean, false) then
    raise exception 'concurrent reservation unexpectedly succeeded: %', rollover_result;
  end if;
  if rollover_result->>'reason' <> 'concurrency' then
    raise exception 'expected concurrency rejection, got: %', rollover_result;
  end if;

  -- Move only the rolling request window. The active lease remains live.
  update public.rate_limits
  set window_started_at = now() - interval '2 seconds'
  where scope_key = '__docchat_rate_test__';
  select public.reserve_rate_limit('__docchat_rate_test__', 1, 10, 1, 60)
    into rollover_result;
  if coalesce((rollover_result->>'allowed')::boolean, false) then
    raise exception 'window rollover bypassed active concurrency: %', rollover_result;
  end if;

  perform public.release_rate_limit('__docchat_rate_test__', first_lease);
  -- Duplicate release is a no-op and cannot underflow active_count.
  perform public.release_rate_limit('__docchat_rate_test__', first_lease);
  select public.reserve_rate_limit('__docchat_rate_test__', 1, 10, 1, 60)
    into released_result;
  if coalesce((released_result->>'allowed')::boolean, false) is not true then
    raise exception 'reservation after release was rejected: %', released_result;
  end if;
  second_lease := (released_result->>'lease_id')::uuid;
  perform public.release_rate_limit('__docchat_rate_test__', second_lease);
end;
$$;

rollback;
