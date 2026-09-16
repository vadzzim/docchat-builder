alter table public.messages
  add column if not exists message_order bigint generated always as identity;

create index if not exists messages_conversation_order_idx
  on public.messages (conversation_id, message_order);
