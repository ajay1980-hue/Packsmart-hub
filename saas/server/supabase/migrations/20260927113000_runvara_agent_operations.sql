begin;
set local lock_timeout = '5s';

create table if not exists public.runvara_agent_jobs (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  type text not null check (type in ('agent_command','connection_sync','connection_doctor','marketing_plan')),
  provider text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  status text not null default 'queued' check (status in ('queued','running','succeeded','blocked','dead_letter')),
  priority smallint not null default 50 check (priority between 0 and 100),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  ai_units numeric(12,2) not null default 0 check (ai_units >= 0),
  concurrency_limit smallint not null default 2 check (concurrency_limit between 1 and 10),
  idempotency_key text not null,
  actor text not null default 'system',
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  worker_id text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, idempotency_key)
);

create index if not exists runvara_agent_jobs_ready_idx
  on public.runvara_agent_jobs (status, available_at, priority desc, created_at)
  where status = 'queued';
create index if not exists runvara_agent_jobs_workspace_idx
  on public.runvara_agent_jobs (workspace_id, status, created_at desc);
create index if not exists runvara_agent_jobs_provider_idx
  on public.runvara_agent_jobs (workspace_id, provider, status)
  where provider is not null and status = 'running';

alter table public.runvara_agent_jobs enable row level security;
revoke all on table public.runvara_agent_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.runvara_agent_jobs to service_role;

create or replace function public.runvara_claim_agent_jobs(
  p_worker_id text,
  p_limit integer default 8,
  p_lease_seconds integer default 300
)
returns setof public.runvara_agent_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_worker_id is null or length(trim(p_worker_id)) < 8 then
    raise exception using errcode = '22023', message = 'Invalid worker id';
  end if;
  return query
  with candidates as (
    select j.id
    from public.runvara_agent_jobs j
    where j.status = 'queued'
      and j.available_at <= now()
      and (
        select count(*) from public.runvara_agent_jobs r
        where r.workspace_id = j.workspace_id
          and r.status = 'running'
          and r.lease_until > now()
      ) < j.concurrency_limit
      and (
        j.provider is null or not exists (
          select 1 from public.runvara_agent_jobs p
          where p.workspace_id = j.workspace_id
            and p.provider = j.provider
            and p.status = 'running'
            and p.lease_until > now()
        )
      )
    order by j.priority desc, j.available_at, j.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit,8), 50))
  )
  update public.runvara_agent_jobs j
  set status = 'running',
      attempts = j.attempts + 1,
      worker_id = p_worker_id,
      lease_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds,300), 1800))),
      updated_at = now()
  from candidates c
  where j.id = c.id
  returning j.*;
end;
$$;

revoke all on function public.runvara_claim_agent_jobs(text,integer,integer) from public, anon, authenticated;
grant execute on function public.runvara_claim_agent_jobs(text,integer,integer) to service_role;
comment on table public.runvara_agent_jobs is 'Server-only durable Runvara agent operations queue with tenant-scoped jobs, leases, retries and dead-letter state.';
comment on function public.runvara_claim_agent_jobs(text,integer,integer) is 'Server-only atomic job claim using SKIP LOCKED. No browser role has execute access.';

commit;
