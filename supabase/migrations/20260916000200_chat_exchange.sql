create or replace function public.save_chat_exchange(
  p_conversation_id uuid,
  p_bot_id uuid,
  p_owner_user_id uuid,
  p_visitor_session_id uuid,
  p_user_content text,
  p_assistant_content text,
  p_citations jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation public.conversations;
begin
  if (p_owner_user_id is null) = (p_visitor_session_id is null) then
    raise exception using errcode = '22023', message = 'Exactly one chat actor is required';
  end if;
  if p_user_content is null or char_length(p_user_content) < 1 or char_length(p_user_content) > 20000
    or p_assistant_content is null or char_length(p_assistant_content) < 1 or char_length(p_assistant_content) > 20000
    or p_citations is null or jsonb_typeof(p_citations) <> 'array' then
    raise exception using errcode = '22023', message = 'Chat exchange content is invalid';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id
    and c.bot_id = p_bot_id
    and c.owner_user_id is not distinct from p_owner_user_id
    and c.visitor_session_id is not distinct from p_visitor_session_id
  for update;
  if not found then
    return false;
  end if;
  if coalesce(v_conversation.last_activity_at, v_conversation.created_at) < now() - interval '30 days' then
    return false;
  end if;
  if p_owner_user_id is not null and not exists (
    select 1 from public.bots b where b.id = p_bot_id and b.account_id = p_owner_user_id
  ) then
    return false;
  end if;
  if p_visitor_session_id is not null and not exists (
    select 1 from public.visitor_sessions s
    where s.id = p_visitor_session_id and s.bot_id = p_bot_id
      and s.revoked_at is null and s.expires_at > now()
  ) then
    return false;
  end if;

  insert into public.messages(conversation_id, role, content, citations)
  values (p_conversation_id, 'user', p_user_content, '[]'::jsonb),
         (p_conversation_id, 'assistant', p_assistant_content, p_citations);
  update public.conversations
  set last_activity_at = now()
  where id = p_conversation_id;
  return true;
end;
$$;

revoke all on function public.save_chat_exchange(uuid, uuid, uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_chat_exchange(uuid, uuid, uuid, uuid, text, text, jsonb)
  to service_role;
