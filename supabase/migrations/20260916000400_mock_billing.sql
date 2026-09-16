-- Local-only mock plan changes. This function intentionally has no payment or
-- webhook behavior and never touches monthly usage or source data.
create or replace function public.set_mock_account_plan(
  p_account_id uuid,
  p_plan text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.accounts;
begin
  if p_plan not in ('free', 'pro') then
    raise exception using errcode = '22023', message = 'Plan must be free or pro';
  end if;

  select * into v_account
  from public.accounts
  where id = p_account_id
  for update;
  if v_account.id is null then
    raise exception using errcode = '42501', message = 'Account not found';
  end if;

  update public.accounts
  set plan = p_plan
  where id = p_account_id
  returning * into v_account;

  return jsonb_build_object(
    'account_id', v_account.id,
    'plan', v_account.plan,
    'updated_at', v_account.updated_at
  );
end;
$$;

revoke all on function public.set_mock_account_plan(uuid, text) from public, anon, authenticated;
grant execute on function public.set_mock_account_plan(uuid, text) to service_role;

