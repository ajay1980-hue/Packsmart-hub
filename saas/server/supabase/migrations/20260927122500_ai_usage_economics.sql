begin;
set local lock_timeout = '5s';

alter table public.runvara_agent_jobs
  add column if not exists ai_provider text,
  add column if not exists ai_model text,
  add column if not exists ai_tier text;

create table if not exists public.runvara_ai_usage (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  job_id text references public.runvara_agent_jobs(id) on delete set null,
  task_type text not null,
  provider text not null,
  model text not null,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  estimated_cost_usd numeric(14,8) not null default 0 check (estimated_cost_usd >= 0),
  request_id text,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  check (cached_input_tokens + cache_write_tokens <= input_tokens)
);

create unique index if not exists runvara_ai_usage_request_unique
  on public.runvara_ai_usage (workspace_id, provider, request_id)
  where request_id is not null;
create index if not exists runvara_ai_usage_workspace_time_idx
  on public.runvara_ai_usage (workspace_id, occurred_at desc);
create index if not exists runvara_ai_usage_model_time_idx
  on public.runvara_ai_usage (model, occurred_at desc);

alter table public.runvara_ai_usage enable row level security;
revoke all on table public.runvara_ai_usage from public, anon, authenticated;
grant select, insert on table public.runvara_ai_usage to service_role;

comment on table public.runvara_ai_usage is 'Server-only measured AI token and estimated provider-cost ledger. No customer prompt or response content is stored.';
commit;