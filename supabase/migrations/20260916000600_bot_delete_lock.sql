-- Keep bot deletion compatible with document processing/deletion locks. Those
-- paths lock documents before the joined bot row, so deletion does the same
-- after taking the account lock that blocks new document slots.
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

  -- Explicit ordering prevents a processing worker holding a document lock
  -- from deadlocking against the bot lock below.
  perform 1
  from public.documents d
  where d.bot_id = p_bot_id
  order by d.id
  for update;

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

revoke all on function public.delete_bot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_bot(uuid, uuid) to service_role;
