-- MC Pulse initial Supabase schema (PostgreSQL)
-- Run in Supabase SQL Editor. The backend uses the service-role key only.

create extension if not exists pgcrypto;

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(label) between 1 and 64),
  key_hash char(64) not null unique,
  scopes text[] not null default array['servers:read']::text[],
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
);

create table if not exists public.server_checks (
  id bigint generated always as identity primary key,
  host text not null,
  port integer not null check (port between 1024 and 65535),
  edition text not null check (edition in ('java', 'bedrock')),
  online boolean not null,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  checked_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create index if not exists server_checks_lookup_idx
  on public.server_checks (host, port, edition, checked_at desc);
create index if not exists server_checks_retention_idx
  on public.server_checks (checked_at);

create table if not exists public.api_usage (
  id bigint generated always as identity primary key,
  api_key_id uuid not null references public.api_keys(id) on delete cascade,
  route text not null,
  status_code integer not null,
  duration_ms integer not null check (duration_ms >= 0),
  created_at timestamptz not null default now()
);
create index if not exists api_usage_key_date_idx
  on public.api_usage (api_key_id, created_at desc);
create index if not exists api_usage_retention_idx
  on public.api_usage (created_at);

-- No browser/client-side access. Only the backend service-role key may access these tables.
alter table public.api_keys enable row level security;
alter table public.server_checks enable row level security;
alter table public.api_usage enable row level security;

revoke all on public.api_keys from anon, authenticated;
revoke all on public.server_checks from anon, authenticated;
revoke all on public.api_usage from anon, authenticated;

-- Compact daily aggregates preserve long-term charts without retaining every ping forever.
create table if not exists public.server_daily_stats (
  host text not null,
  port integer not null check (port between 1024 and 65535),
  edition text not null check (edition in ('java', 'bedrock')),
  day date not null,
  total_checks bigint not null,
  online_checks bigint not null,
  avg_latency_ms integer,
  min_latency_ms integer,
  max_latency_ms integer,
  primary key (host, port, edition, day)
);

alter table public.server_daily_stats enable row level security;
revoke all on public.server_daily_stats from anon, authenticated;

-- Roll up completed UTC days atomically, then discard raw checks older than today.
-- Daily aggregates are retained for 365 days. API usage is pruned separately by the backend.
create or replace function public.rollup_server_history()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  insert into public.server_daily_stats (
    host, port, edition, day, total_checks, online_checks,
    avg_latency_ms, min_latency_ms, max_latency_ms
  )
  select
    host, port, edition, (checked_at at time zone 'UTC')::date,
    count(*), count(*) filter (where online),
    round(avg(latency_ms))::integer, min(latency_ms), max(latency_ms)
  from public.server_checks
  where checked_at < cutoff
  group by host, port, edition, (checked_at at time zone 'UTC')::date
  on conflict (host, port, edition, day) do update set
    total_checks = excluded.total_checks,
    online_checks = excluded.online_checks,
    avg_latency_ms = excluded.avg_latency_ms,
    min_latency_ms = excluded.min_latency_ms,
    max_latency_ms = excluded.max_latency_ms;

  delete from public.server_checks where checked_at < cutoff;
  delete from public.server_daily_stats where day < ((now() at time zone 'UTC')::date - 365);
end;
$$;

revoke all on function public.rollup_server_history() from public, anon, authenticated;
grant execute on function public.rollup_server_history() to service_role;

-- Explicit backend privileges; no public client role receives access.
grant all on public.api_keys, public.server_checks, public.api_usage, public.server_daily_stats to service_role;
grant usage, select on all sequences in schema public to service_role;
