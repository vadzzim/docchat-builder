-- Durable storage cleanup uses only paths recorded by document deletion.
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create index if not exists deleted_storage_objects_created_idx
  on public.deleted_storage_objects (created_at);

create table public.storage_cleanup_leases (
  lease_name text primary key check (lease_name = 'storage'),
  lease_id uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.storage_cleanup_leases(lease_name)
values ('storage')
on conflict (lease_name) do nothing;

create or replace function public.acquire_storage_cleanup_lease(
  p_lease_id uuid,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acquired boolean;
begin
  if p_lease_id is null then
    raise exception using errcode = '22023', message = 'Cleanup lease id is required';
  end if;
  update public.storage_cleanup_leases
  set lease_id = p_lease_id,
      lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 60)),
      updated_at = now()
  where lease_name = 'storage'
    and (lease_expires_at is null or lease_expires_at <= now())
  returning true into v_acquired;
  return coalesce(v_acquired, false);
end;
$$;

create or replace function public.release_storage_cleanup_lease(p_lease_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.storage_cleanup_leases
  set lease_id = null, lease_expires_at = null, updated_at = now()
  where lease_name = 'storage' and lease_id = p_lease_id;
end;
$$;

-- Delete the complete bot tree in one transaction. The account-then-bot lock
-- order matches document slots, quota, and billing changes. Storage paths are
-- returned to the caller for a bounded best-effort delete; tombstones remain
-- until the scheduled cleaner confirms the object is gone.
create or replace function public.delete_bot(p_owner_id uuid, p_bot_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
  v_locked_account_id uuid;
  v_paths jsonb;
begin
  select b.account_id into v_account_id
  from public.bots b
  where b.id = p_bot_id;

  if v_account_id is null then
    return jsonb_build_object(
      'deleted', false,
      'already_deleted', true,
      'storage_paths', '[]'::jsonb
    );
  end if;
  if p_owner_id is distinct from v_account_id then
    raise exception using errcode = '42501', message = 'Bot access denied';
  end if;

  select a.id into v_locked_account_id
  from public.accounts a
  where a.id = v_account_id
  for update;
  if v_locked_account_id is null then
    raise exception using errcode = '42501', message = 'Bot access denied';
  end if;

  -- Re-check under the locks so a concurrent delete cannot make us return a
  -- path list for a replacement row. Bot UUIDs are never reused.
  select b.account_id into v_account_id
  from public.bots b
  where b.id = p_bot_id
  for update;
  if v_account_id is null then
    return jsonb_build_object(
      'deleted', false,
      'already_deleted', true,
      'storage_paths', '[]'::jsonb
    );
  end if;
  if p_owner_id is distinct from v_account_id then
    raise exception using errcode = '42501', message = 'Bot access denied';
  end if;

  select coalesce(jsonb_agg(d.storage_path order by d.storage_path), '[]'::jsonb)
    into v_paths
  from public.documents d
  where d.bot_id = p_bot_id;

  delete from public.bots where id = p_bot_id;
  return jsonb_build_object(
    'deleted', true,
    'already_deleted', false,
    'storage_paths', v_paths
  );
end;
$$;

-- Messages age independently from conversation activity. Keep expired visitor
-- sessions while a retained conversation still references them.
create or replace function public.cleanup_expired_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.messages where created_at < now() - interval '30 days';
  delete from public.conversations
  where coalesce(last_activity_at, created_at) < now() - interval '30 days';
  delete from public.visitor_sessions s
  where (s.expires_at < now() or s.revoked_at is not null)
    and not exists (
      select 1 from public.conversations c where c.visitor_session_id = s.id
    );
  delete from public.rate_limits
  where updated_at < now() - interval '2 hours';
  delete from public.rate_limit_leases where expires_at <= now();
end;
$$;

-- pg_cron invokes this function once per minute. The secret is populated by
-- scripts/local-setup.mjs and is never stored in a migration.
create or replace function public.enqueue_storage_cleanup()
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'docchat-cron-secret';
  if v_secret is null or char_length(v_secret) < 32 then
    raise exception using errcode = '22023', message = 'DocChat cleanup secret is not configured';
  end if;
  v_request_id := net.http_post(
    url := 'http://kong:8000/functions/v1/cleanup-storage',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secret
    ),
    timeout_milliseconds := 60000
  );
  return v_request_id;
end;
$$;

alter table public.storage_cleanup_leases enable row level security;
revoke all on public.storage_cleanup_leases from public, anon, authenticated;

revoke all on function public.acquire_storage_cleanup_lease(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_storage_cleanup_lease(uuid) from public, anon, authenticated;
revoke all on function public.delete_bot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.enqueue_storage_cleanup() from public, anon, authenticated;
grant execute on function public.acquire_storage_cleanup_lease(uuid, integer) to service_role;
grant execute on function public.release_storage_cleanup_lease(uuid) to service_role;
grant execute on function public.delete_bot(uuid, uuid) to service_role;
grant execute on function public.enqueue_storage_cleanup() to service_role;

select cron.schedule(
  'docchat-storage-cleanup',
  '* * * * *',
  'select public.enqueue_storage_cleanup()'
);
