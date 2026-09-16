-- DocChat's single owner / single bot MVP schema.
create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create table public.accounts (
  id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null unique references public.accounts(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  greeting text not null default 'Hi! How can I help?' check (char_length(greeting) between 1 and 500),
  accent_color text not null default '#7064D8' check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  public_enabled boolean not null default false,
  allowed_origins text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(allowed_origins) <= 20),
  constraint bots_published_requires_origin check (not public_enabled or cardinality(allowed_origins) > 0)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  file_name text not null check (char_length(file_name) between 1 and 120),
  storage_path text not null unique check (char_length(storage_path) between 1 and 512),
  content_type text not null check (content_type in ('text/plain', 'text/markdown')),
  source_size_bytes integer not null check (source_size_bytes between 1 and 102400),
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'error', 'deleting')),
  generation bigint not null default 1 check (generation > 0),
  process_attempts integer not null default 0 check (process_attempts >= 0),
  processing_lease uuid,
  lease_expires_at timestamptz,
  process_error text check (process_error is null or char_length(process_error) <= 1000),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  bot_id uuid not null references public.bots(id) on delete cascade,
  generation bigint not null check (generation > 0),
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (char_length(content) between 1 and 8000),
  embedding extensions.vector(1024) not null,
  created_at timestamptz not null default now(),
  unique (document_id, generation, chunk_index)
);

create index document_chunks_bot_idx on public.document_chunks (bot_id, document_id, generation);
create index documents_bot_status_idx on public.documents (bot_id, status);

create table public.visitor_sessions (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  bound_origin text not null check (char_length(bound_origin) between 1 and 2048),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index visitor_sessions_bot_idx on public.visitor_sessions (bot_id, expires_at);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete cascade,
  visitor_session_id uuid references public.visitor_sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  check ((owner_user_id is not null and visitor_session_id is null) or (owner_user_id is null and visitor_session_id is not null))
);

create index conversations_owner_idx on public.conversations (owner_user_id, last_activity_at desc);
create index conversations_visitor_idx on public.conversations (visitor_session_id, last_activity_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 20000),
  citations jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  created_at timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

create table public.monthly_usage (
  account_id uuid not null references public.accounts(id) on delete cascade,
  month_start date not null,
  reserved_requests integer not null default 0 check (reserved_requests >= 0),
  updated_at timestamptz not null default now(),
  primary key (account_id, month_start)
);

create table public.rate_limits (
  scope_key text primary key check (char_length(scope_key) between 1 and 255),
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0),
  active_count integer not null default 0 check (active_count >= 0),
  updated_at timestamptz not null default now()
);

create table public.rate_limit_leases (
  id uuid primary key default gen_random_uuid(),
  scope_key text not null references public.rate_limits(scope_key) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index rate_limit_leases_scope_idx on public.rate_limit_leases (scope_key, expires_at);

-- Deletes can happen while an Edge Function is reading or processing a source.
-- Keep a tombstone so the private Storage object can be retried by cleanup.
create table public.deleted_storage_objects (
  storage_path text primary key check (char_length(storage_path) between 1 and 512),
  created_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger accounts_touch_updated_at before update on public.accounts
for each row execute function public.touch_updated_at();
create trigger bots_touch_updated_at before update on public.bots
for each row execute function public.touch_updated_at();
create trigger documents_touch_updated_at before update on public.documents
for each row execute function public.touch_updated_at();
create trigger monthly_usage_touch_updated_at before update on public.monthly_usage
for each row execute function public.touch_updated_at();
create trigger rate_limits_touch_updated_at before update on public.rate_limits
for each row execute function public.touch_updated_at();

create or replace function public.remember_document_storage_path()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.deleted_storage_objects(storage_path)
  values (old.storage_path)
  on conflict (storage_path) do nothing;
  return old;
end;
$$;

create trigger documents_storage_tombstone before delete on public.documents
for each row execute function public.remember_document_storage_path();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounts(id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.create_document_slot(
  p_owner_id uuid,
  p_bot_id uuid,
  p_document_id uuid,
  p_file_name text,
  p_storage_path text,
  p_content_type text,
  p_source_size_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_account_id uuid;
  v_plan text;
  v_max_documents integer;
  v_max_source_bytes integer;
  v_document_count integer;
  v_total_source_bytes integer;
  v_document public.documents;
begin
  select b.account_id into v_account_id
  from public.bots b where b.id = p_bot_id;
  if v_account_id is null or p_owner_id is distinct from v_account_id then
    raise exception using errcode = '42501', message = 'Bot access denied';
  end if;

  -- Account then bot is the lock order used by quota and billing changes.
  select a.plan into v_plan from public.accounts a where a.id = v_account_id for update;
  perform 1 from public.bots b where b.id = p_bot_id and b.account_id = v_account_id for update;
  v_max_documents := case when v_plan = 'pro' then 25 else 5 end;
  v_max_source_bytes := case when v_plan = 'pro' then 2560000 else 512000 end;
  if p_source_size_bytes < 1 or p_source_size_bytes > 102400 then
    raise exception using errcode = '22023', message = 'Source file exceeds the 100 KiB limit';
  end if;

  select count(*)::integer, coalesce(sum(d.source_size_bytes), 0)::integer
    into v_document_count, v_total_source_bytes
  from public.documents d
  where d.bot_id = p_bot_id;
  if v_document_count >= v_max_documents then
    raise exception using errcode = '54000', message = 'Document limit reached for this plan';
  end if;
  if v_total_source_bytes + p_source_size_bytes > v_max_source_bytes then
    raise exception using errcode = '54000', message = 'Total source text limit reached for this plan';
  end if;

  insert into public.documents(id, bot_id, file_name, storage_path, content_type, source_size_bytes)
  values (p_document_id, p_bot_id, p_file_name, p_storage_path, p_content_type, p_source_size_bytes)
  returning * into v_document;
  return to_jsonb(v_document);
end;
$$;

create or replace function public.cancel_document_upload(p_owner_id uuid, p_document_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.documents d
  using public.bots b
  where d.id = p_document_id and d.bot_id = b.id and b.account_id = p_owner_id and d.status = 'pending';
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

create or replace function public.begin_document_delete(p_owner_id uuid, p_document_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_path text;
begin
  select d.storage_path into v_path
  from public.documents d join public.bots b on b.id = d.bot_id
  where d.id = p_document_id and b.account_id = p_owner_id
  for update;
  if v_path is null then
    raise exception using errcode = '42501', message = 'Document access denied';
  end if;
  update public.documents
  set status = 'deleting', processing_lease = null, lease_expires_at = null,
      process_error = null, updated_at = now()
  where id = p_document_id;
  insert into public.deleted_storage_objects(storage_path)
  values (v_path) on conflict (storage_path) do nothing;
  delete from public.document_chunks where document_id = p_document_id;
  return v_path;
end;
$$;

create or replace function public.finish_document_delete(p_owner_id uuid, p_document_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.documents d
  using public.bots b
  where d.id = p_document_id and d.bot_id = b.id and b.account_id = p_owner_id and d.status = 'deleting';
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

create or replace function public.complete_storage_cleanup(p_storage_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.documents
  where storage_path = p_storage_path and status = 'deleting';
  delete from public.deleted_storage_objects where storage_path = p_storage_path;
end;
$$;

create or replace function public.claim_document_processing(
  p_owner_id uuid,
  p_document_id uuid,
  p_lease_id uuid,
  p_lease_seconds integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document public.documents;
begin
  select d.* into v_document
  from public.documents d join public.bots b on b.id = d.bot_id
  where d.id = p_document_id and b.account_id = p_owner_id
  for update;
  if v_document.id is null then
    raise exception using errcode = '42501', message = 'Document access denied';
  end if;
  if v_document.status = 'deleting' then
    return jsonb_build_object('claimed', false, 'status', 'deleting');
  end if;
  if v_document.status = 'ready' then
    return jsonb_build_object('claimed', false, 'status', 'ready', 'document_id', v_document.id);
  end if;
  if v_document.status = 'processing' and v_document.lease_expires_at > now() then
    return jsonb_build_object('claimed', false, 'status', 'processing', 'document_id', v_document.id);
  end if;

  delete from public.document_chunks where document_id = p_document_id;
  update public.documents
  set status = 'processing', generation = generation + 1, process_attempts = process_attempts + 1,
      processing_lease = p_lease_id, lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 60)),
      process_error = null, chunk_count = 0, processed_at = null, updated_at = now()
  where id = p_document_id
  returning * into v_document;
  return jsonb_build_object(
    'claimed', true, 'status', v_document.status, 'document_id', v_document.id,
    'bot_id', v_document.bot_id, 'storage_path', v_document.storage_path,
    'generation', v_document.generation, 'lease_id', v_document.processing_lease
  );
end;
$$;

create or replace function public.insert_document_chunks(
  p_document_id uuid,
  p_lease_id uuid,
  p_generation bigint,
  p_chunks jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_bot_id uuid;
begin
  select d.bot_id into v_bot_id
  from public.documents d
  where d.id = p_document_id and d.status = 'processing'
    and d.processing_lease = p_lease_id and d.generation = p_generation
    and (d.lease_expires_at is null or d.lease_expires_at > now())
  for update;
  if v_bot_id is null then
    return false;
  end if;
  insert into public.document_chunks(document_id, bot_id, generation, chunk_index, content, embedding)
  select p_document_id, v_bot_id, p_generation, x.chunk_index, x.content, x.embedding::extensions.vector
  from jsonb_to_recordset(p_chunks) as x(chunk_index integer, content text, embedding text);
  return true;
end;
$$;

create or replace function public.finalize_document_processing(
  p_document_id uuid,
  p_lease_id uuid,
  p_generation bigint,
  p_chunk_count integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  update public.documents
  set status = 'ready', processing_lease = null, lease_expires_at = null,
      process_error = null, chunk_count = p_chunk_count, processed_at = now(), updated_at = now()
  where id = p_document_id and status = 'processing' and processing_lease = p_lease_id
    and generation = p_generation and (lease_expires_at is null or lease_expires_at > now())
    and p_chunk_count > 0
    and (select count(*) from public.document_chunks c
         where c.document_id = p_document_id and c.generation = p_generation) = p_chunk_count;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.fail_document_processing(
  p_document_id uuid,
  p_lease_id uuid,
  p_generation bigint,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  update public.documents
  set status = 'error', processing_lease = null, lease_expires_at = null,
      process_error = left(coalesce(p_error, 'Processing failed'), 1000), updated_at = now()
  where id = p_document_id and status = 'processing' and processing_lease = p_lease_id
    and generation = p_generation and (lease_expires_at is null or lease_expires_at > now());
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.match_document_chunks(
  p_bot_id uuid,
  p_query_embedding extensions.vector(1024),
  p_match_count integer default 6,
  p_min_similarity real default 0.35
)
returns table(document_id uuid, document_name text, chunk_index integer, excerpt text, similarity real)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select c.document_id, d.file_name, c.chunk_index, c.content,
         (1 - (c.embedding <=> p_query_embedding))::real
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
    and d.bot_id = p_bot_id and d.status = 'ready' and d.generation = c.generation
  where c.bot_id = p_bot_id
    and (1 - (c.embedding <=> p_query_embedding)) >= p_min_similarity
  order by c.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 12);
$$;

create or replace function public.reserve_ai_request(p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text;
  v_limit integer;
  v_month date := date_trunc('month', timezone('utc', now()))::date;
  v_used integer;
begin
  select plan into v_plan from public.accounts where id = p_account_id for update;
  if v_plan is null then
    raise exception using errcode = '42501', message = 'Account not found';
  end if;
  v_limit := case when v_plan = 'pro' then 1000 else 100 end;
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text || ':' || v_month::text, 0));
  insert into public.monthly_usage(account_id, month_start) values (p_account_id, v_month)
  on conflict (account_id, month_start) do nothing;
  update public.monthly_usage
  set reserved_requests = reserved_requests + 1, updated_at = now()
  where account_id = p_account_id and month_start = v_month and reserved_requests < v_limit
  returning reserved_requests into v_used;
  if v_used is null then
    select reserved_requests into v_used from public.monthly_usage
    where account_id = p_account_id and month_start = v_month;
    return jsonb_build_object('allowed', false, 'used', v_used, 'limit', v_limit, 'month_start', v_month);
  end if;
  return jsonb_build_object('allowed', true, 'used', v_used, 'limit', v_limit, 'month_start', v_month);
end;
$$;

create or replace function public.reserve_rate_limit(
  p_scope_key text,
  p_window_seconds integer,
  p_max_requests integer,
  p_max_concurrent integer,
  p_lease_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.rate_limits;
  v_active integer;
  v_window_seconds integer := greatest(p_window_seconds, 1);
  v_lease_id uuid := gen_random_uuid();
begin
  if p_scope_key is null or char_length(p_scope_key) > 255 then
    raise exception using errcode = '22023', message = 'Invalid rate limit scope';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_scope_key, 0));
  insert into public.rate_limits(scope_key) values (p_scope_key) on conflict (scope_key) do nothing;
  select * into v_row from public.rate_limits where scope_key = p_scope_key for update;
  delete from public.rate_limit_leases where scope_key = p_scope_key and expires_at <= now();
  select count(*)::integer into v_active from public.rate_limit_leases where scope_key = p_scope_key;
  update public.rate_limits set active_count = v_active, updated_at = now() where scope_key = p_scope_key returning * into v_row;
  if v_row.window_started_at + make_interval(secs => v_window_seconds) <= now() then
    update public.rate_limits set window_started_at = now(), request_count = 0, updated_at = now()
    where scope_key = p_scope_key returning * into v_row;
  end if;
  if v_row.request_count >= greatest(p_max_requests, 1) then
    return jsonb_build_object('allowed', false, 'reason', 'rate', 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_row.window_started_at + make_interval(secs => v_window_seconds) - now())))::integer));
  end if;
  if v_active >= greatest(p_max_concurrent, 1) then
    return jsonb_build_object('allowed', false, 'reason', 'concurrency', 'retry_after_seconds', 1);
  end if;
  insert into public.rate_limit_leases(id, scope_key, expires_at)
  values (v_lease_id, p_scope_key, now() + make_interval(secs => greatest(p_lease_seconds, 60)));
  update public.rate_limits set request_count = request_count + 1, active_count = v_active + 1, updated_at = now()
  where scope_key = p_scope_key returning * into v_row;
  return jsonb_build_object('allowed', true, 'lease_id', v_lease_id,
    'request_count', v_row.request_count, 'active_count', v_row.active_count);
end;
$$;

create or replace function public.release_rate_limit(p_scope_key text, p_lease_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.rate_limit_leases where scope_key = p_scope_key and id = p_lease_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 1 then
    update public.rate_limits
    set active_count = greatest(active_count - 1, 0), updated_at = now()
    where scope_key = p_scope_key;
  end if;
end;
$$;

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
  delete from public.visitor_sessions
  where expires_at < now() or revoked_at is not null;
  delete from public.rate_limits
  where updated_at < now() - interval '2 hours';
  delete from public.rate_limit_leases where expires_at <= now();
end;
$$;

-- Private source bucket. Browser clients have no Storage object policies; functions use service_role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 102400, array['text/plain', 'text/markdown'])
on conflict (id) do update set public = false, file_size_limit = 102400,
  allowed_mime_types = array['text/plain', 'text/markdown'];

alter table public.accounts enable row level security;
alter table public.bots enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.visitor_sessions enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.monthly_usage enable row level security;
alter table public.rate_limits enable row level security;
alter table public.rate_limit_leases enable row level security;
alter table public.deleted_storage_objects enable row level security;

create policy accounts_select_own on public.accounts for select to authenticated using (id = auth.uid());
create policy bots_select_own on public.bots for select to authenticated using (account_id = auth.uid());
create policy documents_select_own on public.documents for select to authenticated
using (exists (select 1 from public.bots b where b.id = documents.bot_id and b.account_id = auth.uid()));
create policy conversations_select_own on public.conversations for select to authenticated using (owner_user_id = auth.uid());
create policy messages_select_own on public.messages for select to authenticated
using (exists (select 1 from public.conversations c where c.id = messages.conversation_id and c.owner_user_id = auth.uid()));
create policy monthly_usage_select_own on public.monthly_usage for select to authenticated using (account_id = auth.uid());

revoke all on public.accounts, public.bots, public.documents, public.document_chunks, public.visitor_sessions,
  public.conversations, public.messages, public.monthly_usage, public.rate_limits, public.rate_limit_leases, public.deleted_storage_objects
  from anon;
revoke all on public.accounts, public.bots, public.documents, public.document_chunks, public.visitor_sessions,
  public.conversations, public.messages, public.monthly_usage, public.rate_limits, public.rate_limit_leases, public.deleted_storage_objects
  from authenticated;
grant select on public.accounts, public.bots, public.documents, public.conversations, public.messages, public.monthly_usage
  to authenticated;

revoke all on function public.create_document_slot(uuid, uuid, uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.cancel_document_upload(uuid, uuid) from public, anon, authenticated;
revoke all on function public.begin_document_delete(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_document_delete(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_document_processing(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.insert_document_chunks(uuid, uuid, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.finalize_document_processing(uuid, uuid, bigint, integer) from public, anon, authenticated;
revoke all on function public.fail_document_processing(uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.complete_storage_cleanup(text) from public, anon, authenticated;
revoke all on function public.match_document_chunks(uuid, extensions.vector, integer, real) from public, anon, authenticated;
revoke all on function public.reserve_ai_request(uuid) from public, anon, authenticated;
revoke all on function public.reserve_rate_limit(text, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.release_rate_limit(text, uuid) from public, anon, authenticated;
revoke all on function public.cleanup_expired_data() from public, anon, authenticated;
grant execute on function public.create_document_slot(uuid, uuid, uuid, text, text, text, integer) to service_role;
grant execute on function public.cancel_document_upload(uuid, uuid) to service_role;
grant execute on function public.begin_document_delete(uuid, uuid) to service_role;
grant execute on function public.finish_document_delete(uuid, uuid) to service_role;
grant execute on function public.claim_document_processing(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.insert_document_chunks(uuid, uuid, bigint, jsonb) to service_role;
grant execute on function public.finalize_document_processing(uuid, uuid, bigint, integer) to service_role;
grant execute on function public.fail_document_processing(uuid, uuid, bigint, text) to service_role;
grant execute on function public.complete_storage_cleanup(text) to service_role;
grant execute on function public.match_document_chunks(uuid, extensions.vector, integer, real) to service_role;
grant execute on function public.reserve_ai_request(uuid) to service_role;
grant execute on function public.reserve_rate_limit(text, integer, integer, integer, integer) to service_role;
grant execute on function public.release_rate_limit(text, uuid) to service_role;
grant execute on function public.cleanup_expired_data() to service_role;

select cron.schedule('docchat-cleanup', '0 3 * * *', 'select public.cleanup_expired_data()');
