-- JARVIS database. Run once in the Supabase SQL editor (safe to re-run).
--
-- Two kinds of caller:
--   * The website, signed in as the owner. Every table is row-level secured to
--     owner_id = auth.uid(), so the browser and the API routes only ever see
--     the owner's rows.
--   * The device agent on a PC or laptop. It never signs in and never holds a
--     service key. It calls the agent_* functions below with its device token;
--     each function checks the token's hash and touches only that device's jobs.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Conversations -----------------------------------------------------------------

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null default 'Conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  conversation_id uuid not null references public.conversations on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists messages_conv_idx on public.messages (conversation_id, created_at);

-- Memory --------------------------------------------------------------------------
-- embedding has no fixed dimension on purpose: the embedding model can change
-- without a migration. Rows from another model are simply not compared
-- (embed_model must match), and a few thousand rows need no vector index.

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  content text not null check (length(content) between 1 and 1000),
  kind text not null default 'fact'
    check (kind in ('identity', 'preference', 'person', 'project', 'goal', 'routine', 'event', 'fact')),
  importance int not null default 3 check (importance between 1 and 5),
  confidence real not null default 0.9 check (confidence between 0 and 1),
  source text not null default 'chat',
  embedding extensions.vector,
  embed_model text,
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  use_count int not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists memories_owner_idx on public.memories (owner_id, importance desc);
create index if not exists memories_fts_idx on public.memories using gin (fts);

-- YouTube watch history: what Jarvis played plus an optional Google Takeout import.

create table if not exists public.watch_history (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  video_id text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  title text not null default '',
  channel text not null default '',
  watched_at timestamptz not null default now(),
  source text not null default 'jarvis' check (source in ('jarvis', 'takeout')),
  unique (owner_id, video_id, watched_at)
);
create index if not exists watch_history_owner_idx on public.watch_history (owner_id, watched_at desc);

-- Integrations: one row per owner. The arkia refresh token is AES-GCM encrypted
-- by the web server before it gets here; the database never sees it in clear.

create table if not exists public.integrations (
  owner_id uuid primary key default auth.uid() references auth.users on delete cascade,
  arkia_uid text,
  arkia_email text,
  arkia_token_enc text,
  arkia_seen jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Devices and jobs --------------------------------------------------------------

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (length(name) between 1 and 60),
  token_hash text not null unique,
  platform text not null default '',
  agent_version text not null default '',
  manifest jsonb not null default '[]'::jsonb,
  last_seen timestamptz,
  created_at timestamptz not null default now()
);

-- App streaming: where this device's stream server is reachable, and the
-- per-start secret the website signs short-lived passes with.
alter table public.devices add column if not exists stream_url text;
alter table public.devices add column if not exists stream_secret text;
alter table public.devices add column if not exists stream_info jsonb not null default '{}'::jsonb;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  device_id uuid not null references public.devices on delete cascade,
  tool text not null,
  args jsonb not null default '{}'::jsonb,
  title text not null default '',
  long_running boolean not null default false,
  status text not null default 'queued'
    check (status in ('needs_approval', 'queued', 'running', 'done', 'failed', 'cancelled', 'rejected')),
  result jsonb,
  error text,
  conversation_id uuid references public.conversations on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists jobs_owner_idx on public.jobs (owner_id, updated_at desc);
create index if not exists jobs_device_queue_idx on public.jobs (device_id, status, created_at);

create table if not exists public.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.jobs on delete cascade,
  owner_id uuid not null references auth.users on delete cascade,
  kind text not null default 'log',
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists job_events_job_idx on public.job_events (job_id, id);

-- Cloud files: downloads from the laptop (and uploads from any browser) kept in
-- Supabase Storage, so they can be fetched on any computer.
create table if not exists public.cloud_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  device_id uuid references public.devices on delete set null,
  name text not null check (length(name) between 1 and 200),
  path text not null unique,
  size bigint not null default 0,
  content_type text not null default 'application/octet-stream',
  status text not null default 'uploading' check (status in ('uploading', 'ready', 'failed')),
  source text not null default 'device',
  created_at timestamptz not null default now()
);
create index if not exists cloud_files_owner_idx on public.cloud_files (owner_id, created_at desc);

-- Tools JARVIS wrote for itself. Kept here so the code survives the device and
-- can be read, enabled or installed on another device from the website.
create table if not exists public.plugins (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (name ~ '^[a-z][a-z0-9_]{1,40}$'),
  description text not null default '',
  code text not null check (length(code) <= 200000),
  valid boolean not null default false,
  problem text,
  device_id uuid references public.devices on delete set null,
  job_id uuid references public.jobs on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

-- Row-level security: the owner sees and changes only their own rows.

do $$
declare t text;
begin
  foreach t in array array['conversations', 'messages', 'memories', 'watch_history',
                           'integrations', 'devices', 'jobs', 'job_events', 'cloud_files', 'plugins'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated
                    using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t);
  end loop;
end $$;

-- Table privileges. Newer Supabase projects do not grant these automatically.
-- Only the signed-in owner gets them (row-level security still applies);
-- anon gets none, and the device agent works only through the agent_* functions.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.conversations, public.messages, public.memories,
  public.watch_history, public.integrations, public.devices, public.jobs, public.cloud_files, public.plugins to authenticated;
grant select on public.job_events to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on all tables in schema public from anon;

-- Memory search: vector similarity blended with full-text rank, importance and
-- recent use. Runs as the caller, so row-level security still applies.

create or replace function public.match_memories(
  p_query text,
  p_embedding extensions.vector default null,
  p_model text default null,
  p_limit int default 8
) returns table (id uuid, content text, kind text, importance int, confidence real, source text, score double precision)
language sql stable security invoker
set search_path = public, extensions
as $$
  with q as (
    select case when plainto_tsquery('english', coalesce(p_query, ''))::text = '' then null
                else to_tsquery('english', replace(plainto_tsquery('english', p_query)::text, '&', '|')) end as tsq
  ),
  scored as (
    select m.id, m.content, m.kind, m.importance, m.confidence, m.source,
      case when p_embedding is not null and m.embedding is not null and m.embed_model = p_model
                and vector_dims(m.embedding) = vector_dims(p_embedding)
           then 1 - (m.embedding <=> p_embedding) else 0 end as sim,
      case when q.tsq is not null then ts_rank(m.fts, q.tsq) else 0 end as rank,
      m.last_used_at
    from public.memories m, q
  )
  select s.id, s.content, s.kind, s.importance, s.confidence, s.source,
    (s.sim * 0.65 + least(s.rank * 2, 1) * 0.25 + s.importance * 0.015
      + case when s.last_used_at > now() - interval '14 days' then 0.03 else 0 end)::double precision as score
  from scored s
  where s.sim > 0.35 or s.rank > 0
  order by score desc
  limit greatest(1, least(p_limit, 30));
$$;

-- Memories that were just used rank a little higher for two weeks.
create or replace function public.touch_memories(p_ids uuid[])
returns void
language sql security invoker
set search_path = public
as $$
  update public.memories set use_count = use_count + 1, last_used_at = now() where id = any(p_ids);
$$;

-- Device agent API -----------------------------------------------------------------
-- Callable with only the public (anon/publishable) key. Every function first
-- resolves the device from the token hash and refuses anything else.

create or replace function public.device_from_token(p_token text)
returns public.devices
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare d public.devices;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'invalid device token' using errcode = '28000';
  end if;
  select * into d from public.devices where token_hash = encode(digest(p_token, 'sha256'), 'hex');
  if not found then
    raise exception 'invalid device token' using errcode = '28000';
  end if;
  return d;
end $$;

create or replace function public.agent_hello(p_token text, p_platform text, p_version text, p_manifest jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare d public.devices;
begin
  d := public.device_from_token(p_token);
  if jsonb_typeof(p_manifest) <> 'array' or pg_column_size(p_manifest) > 200000 then
    raise exception 'manifest must be a JSON array under 200 kB';
  end if;
  update public.devices
     set platform = left(coalesce(p_platform, ''), 80), agent_version = left(coalesce(p_version, ''), 40),
         manifest = p_manifest, last_seen = now()
   where id = d.id;
  -- Jobs that were running when the agent stopped can never finish now.
  update public.jobs set status = 'failed', error = 'The device agent restarted while this was running.',
         finished_at = now(), updated_at = now()
   where device_id = d.id and status = 'running';
  return jsonb_build_object('device_id', d.id, 'name', d.name);
end $$;

create or replace function public.agent_claim(p_token text, p_max int default 1)
returns setof public.jobs
language plpgsql security definer
set search_path = public, extensions
as $$
declare d public.devices;
begin
  d := public.device_from_token(p_token);
  -- Heartbeat, written at most every 15 seconds. p_max = 0 is a heartbeat only.
  update public.devices set last_seen = now()
   where id = d.id and (last_seen is null or last_seen < now() - interval '15 seconds');
  return query
    update public.jobs j set status = 'running', started_at = now(), updated_at = now()
     where j.id in (select id from public.jobs
                     where device_id = d.id and status = 'queued'
                     order by created_at
                     limit greatest(0, least(p_max, 4))
                     for update skip locked)
    returning j.*;
end $$;

create or replace function public.agent_log(p_token text, p_job_id uuid, p_kind text, p_text text)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare d public.devices; j public.jobs;
begin
  d := public.device_from_token(p_token);
  select * into j from public.jobs where id = p_job_id and device_id = d.id;
  if not found then raise exception 'unknown job'; end if;
  insert into public.job_events (job_id, owner_id, kind, text)
  values (j.id, j.owner_id, left(coalesce(p_kind, 'log'), 20), left(coalesce(p_text, ''), 4000));
  update public.jobs set updated_at = now() where id = j.id;
end $$;

create or replace function public.agent_finish(p_token text, p_job_id uuid, p_ok boolean, p_result jsonb, p_error text)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare d public.devices;
begin
  d := public.device_from_token(p_token);
  if pg_column_size(p_result) > 400000 then
    raise exception 'result too large';
  end if;
  update public.jobs
     set status = case when p_ok then 'done' else 'failed' end,
         result = p_result, error = left(p_error, 4000), finished_at = now(), updated_at = now()
   where id = p_job_id and device_id = d.id and status = 'running';
end $$;

create or replace function public.agent_job_status(p_token text, p_job_id uuid)
returns text
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare d public.devices; s text;
begin
  d := public.device_from_token(p_token);
  select status into s from public.jobs where id = p_job_id and device_id = d.id;
  return s;
end $$;

create or replace function public.agent_stream(p_token text, p_url text, p_secret text, p_info jsonb)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare d public.devices;
begin
  d := public.device_from_token(p_token);
  if p_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' then
    raise exception 'stream url must be a bare https origin';
  end if;
  if length(coalesce(p_secret, '')) < 32 then
    raise exception 'stream secret too short';
  end if;
  update public.devices
     set stream_url = p_url, stream_secret = p_secret,
         stream_info = coalesce(p_info, '{}'::jsonb), last_seen = now()
   where id = d.id;
end $$;

-- Cloud uploads from a device. The device asks for a slot; the slot's path holds
-- a random id only that device learns, and storage accepts an anonymous upload
-- only to a slot that is still open (see the storage policies below).
create or replace function public.agent_cloud_slot(p_token text, p_name text, p_size bigint, p_type text)
returns text
language plpgsql security definer
set search_path = public, extensions
as $$
declare d public.devices; clean text; p text;
begin
  d := public.device_from_token(p_token);
  clean := left(regexp_replace(coalesce(p_name, 'file'), '[^A-Za-z0-9 ._()-]', '_', 'g'), 150);
  if clean = '' then clean := 'file'; end if;
  p := d.owner_id::text || '/' || gen_random_uuid()::text || '/' || clean;
  insert into public.cloud_files (owner_id, device_id, name, path, size, content_type, status, source)
  values (d.owner_id, d.id, left(coalesce(p_name, clean), 200), p, greatest(coalesce(p_size, 0), 0),
          left(coalesce(nullif(p_type, ''), 'application/octet-stream'), 120), 'uploading', 'device');
  return p;
end $$;

create or replace function public.agent_cloud_done(p_token text, p_path text, p_ok boolean)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare d public.devices;
begin
  d := public.device_from_token(p_token);
  update public.cloud_files set status = case when p_ok then 'ready' else 'failed' end
   where path = p_path and device_id = d.id and status = 'uploading';
end $$;

-- True while an upload slot is open (used by the storage policy; anon cannot read the table).
create or replace function public.cloud_slot_open(p_path text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.cloud_files
                  where path = p_path and status = 'uploading' and created_at > now() - interval '2 hours');
$$;

create or replace function public.agent_save_plugin(p_token text, p_job_id uuid, p_name text, p_description text,
                                                    p_code text, p_valid boolean, p_problem text)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare d public.devices; j uuid;
begin
  d := public.device_from_token(p_token);
  select id into j from public.jobs where id = p_job_id and device_id = d.id;
  insert into public.plugins (owner_id, name, description, code, valid, problem, device_id, job_id)
  values (d.owner_id, p_name, left(coalesce(p_description, ''), 600), p_code, coalesce(p_valid, false), left(p_problem, 1000), d.id, j)
  on conflict (owner_id, name) do update
     set description = excluded.description, code = excluded.code, valid = excluded.valid, problem = excluded.problem,
         device_id = excluded.device_id, job_id = excluded.job_id, updated_at = now();
end $$;

revoke all on function public.device_from_token(text) from public, anon, authenticated;
revoke all on function public.agent_cloud_slot(text, text, bigint, text) from public;
revoke all on function public.agent_cloud_done(text, text, boolean) from public;
revoke all on function public.cloud_slot_open(text) from public;
revoke all on function public.agent_save_plugin(text, uuid, text, text, text, boolean, text) from public;
grant execute on function public.agent_cloud_slot(text, text, bigint, text) to anon;
grant execute on function public.agent_cloud_done(text, text, boolean) to anon;
grant execute on function public.cloud_slot_open(text) to anon, authenticated;
grant execute on function public.agent_save_plugin(text, uuid, text, text, text, boolean, text) to anon;
revoke all on function public.agent_hello(text, text, text, jsonb) from public;
revoke all on function public.agent_claim(text, int) from public;
revoke all on function public.agent_log(text, uuid, text, text) from public;
revoke all on function public.agent_finish(text, uuid, boolean, jsonb, text) from public;
revoke all on function public.agent_job_status(text, uuid) from public;
revoke all on function public.agent_stream(text, text, text, jsonb) from public;
grant execute on function public.agent_hello(text, text, text, jsonb) to anon;
grant execute on function public.agent_claim(text, int) to anon;
grant execute on function public.agent_log(text, uuid, text, text) to anon;
grant execute on function public.agent_finish(text, uuid, boolean, jsonb, text) to anon;
grant execute on function public.agent_job_status(text, uuid) to anon;
grant execute on function public.agent_stream(text, text, text, jsonb) to anon;
grant execute on function public.match_memories(text, extensions.vector, text, int) to authenticated;
grant execute on function public.touch_memories(uuid[]) to authenticated;

-- Storage for cloud files: private bucket, 50 MB per file (the free plan's limit).
insert into storage.buckets (id, name, public, file_size_limit)
values ('jarvis-files', 'jarvis-files', false, 52428800)
on conflict (id) do nothing;

drop policy if exists jarvis_files_owner on storage.objects;
create policy jarvis_files_owner on storage.objects for all to authenticated
  using (bucket_id = 'jarvis-files' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'jarvis-files' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists jarvis_files_device_upload on storage.objects;
create policy jarvis_files_device_upload on storage.objects for insert to anon
  with check (bucket_id = 'jarvis-files' and public.cloud_slot_open(name));
