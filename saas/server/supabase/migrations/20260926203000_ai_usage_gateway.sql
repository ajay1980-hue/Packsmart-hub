begin;

create table if not exists public.ai_usage_events (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_id text,
  campaign_id text,
  request_key text,
  provider text not null,
  operation text not null,
  credits integer not null check (credits >= 0),
  status text not null check (status in ('reserved', 'settled', 'released')),
  estimated_provider_cost_minor integer not null default 0 check (estimated_provider_cost_minor >= 0),
  actual_provider_cost_minor integer check (actual_provider_cost_minor is null or actual_provider_cost_minor >= 0),
  provider_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  released_at timestamptz
);
create index if not exists ai_usage_workspace_created_idx on public.ai_usage_events (workspace_id, created_at desc);
create index if not exists ai_usage_workspace_status_idx on public.ai_usage_events (workspace_id, status, created_at desc);

alter table public.ai_usage_events enable row level security;
revoke all on public.ai_usage_events from anon, authenticated;
grant select, insert, update, delete on public.ai_usage_events to service_role;

comment on table public.ai_usage_events is
  'Server-only tenant-isolated AI provider usage ledger. Browser roles have no direct table access.';

commit;
