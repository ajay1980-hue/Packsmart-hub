-- Add a deterministic, preparation-only job to the existing queue. Reports live
-- only in runvara_agent_jobs.result; this migration creates no persistence table,
-- provider path, role, credential or grant. Legacy job types keep their behavior.
begin;
set local lock_timeout = '5s';

alter table public.runvara_agent_jobs drop constraint runvara_agent_jobs_type_check;
alter table public.runvara_agent_jobs add constraint runvara_agent_jobs_type_check
  check (type in ('agent_command','connection_sync','connection_doctor','marketing_plan','objective_prepare'));
alter table public.runvara_agent_jobs add constraint runvara_objective_prepare_no_provider_check
  check (type <> 'objective_prepare' or (
    provider is null and ai_provider is null and ai_model is null
    and ai_units = 0 and (ai_tier is null or ai_tier = 'deterministic')
  ));

create function public.runvara_guard_objective_prepare_job()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  checked_at timestamptz;
  mutable_fields constant text[] := array[
    'status','attempts','result','worker_id','lease_until','error_code',
    'available_at','updated_at','completed_at'
  ];
begin
  if tg_op <> 'UPDATE' or tg_when <> 'BEFORE' or tg_level <> 'ROW'
    or tg_table_schema <> 'public' or tg_table_name <> 'runvara_agent_jobs' then
    raise exception using errcode = 'P0L03', message = 'OBJECTIVE_JOB_TRANSITION_INVALID';
  end if;
  if old.type <> 'objective_prepare' and new.type <> 'objective_prepare' then
    return new;
  end if;

  -- This executes only after PostgreSQL has locked this row. Never replace with
  -- now()/statement_timestamp(): the statement may have waited past its lease.
  -- No table reads, advisory locks, workspace saves or further row locks occur.
  checked_at := clock_timestamp();
  if old.type is distinct from new.type
    or (to_jsonb(new) - mutable_fields) is distinct from (to_jsonb(old) - mutable_fields) then
    raise exception using errcode = 'P0L02', message = 'OBJECTIVE_JOB_IMMUTABLE';
  end if;

  if old.status = 'running' then
    -- Recognize only the CURRENT claim RPC's exact first-step recovery shape.
    -- Below the retry bound it is unchanged. Exhausted objective leases become
    -- terminal here so the unchanged second-step queued selector excludes them.
    -- A well-formed running objective job already has completed_at NULL.
    if old.lease_until is not null and isfinite(old.lease_until) and old.lease_until <= checked_at
      and new.status = 'queued' and new.worker_id is null and new.lease_until is null
      and new.completed_at is null and new.error_code = 'WORKER_LEASE_EXPIRED'
      and new.available_at = transaction_timestamp() and new.updated_at = transaction_timestamp()
      and (to_jsonb(new) - array['status','worker_id','lease_until','completed_at','error_code','available_at','updated_at'])
        is not distinct from
        (to_jsonb(old) - array['status','worker_id','lease_until','completed_at','error_code','available_at','updated_at']) then
      if old.attempts >= old.max_attempts then
        new.status := 'dead_letter';
        new.error_code := 'OBJECTIVE_LEASE_ATTEMPTS_EXHAUSTED';
        new.completed_at := checked_at;
        new.updated_at := checked_at;
      end if;
      return new;
    end if;

    if old.lease_until is null or not isfinite(old.lease_until) or old.lease_until <= checked_at
      or old.worker_id is null or length(old.worker_id) < 8 or old.attempts < 1 then
      raise exception using errcode = 'P0L01', message = 'OBJECTIVE_JOB_LEASE_EXPIRED';
    end if;
    if new.attempts is distinct from old.attempts then
      raise exception using errcode = 'P0L02', message = 'OBJECTIVE_JOB_IMMUTABLE';
    end if;

    if new.status in ('succeeded','blocked','dead_letter') then
      if new.worker_id is not null or new.lease_until is not null
        or new.completed_at is null or not isfinite(new.completed_at)
        or new.available_at is distinct from old.available_at then
        raise exception using errcode = 'P0L03', message = 'OBJECTIVE_JOB_TRANSITION_INVALID';
      end if;
      return new;
    elsif new.status = 'queued' then
      if new.worker_id is not null or new.lease_until is not null or new.completed_at is not null
        or new.result is distinct from old.result
        or new.error_code = 'WORKER_LEASE_EXPIRED'
        or not isfinite(new.available_at) then
        raise exception using errcode = 'P0L03', message = 'OBJECTIVE_JOB_TRANSITION_INVALID';
      end if;
      return new;
    elsif new.status = 'running'
      and (to_jsonb(new) - 'updated_at') is not distinct from (to_jsonb(old) - 'updated_at') then
      -- Harmless metadata touch. This is NOT a lease extension/heartbeat API.
      return new;
    end if;
    raise exception using errcode = 'P0L03', message = 'OBJECTIVE_JOB_TRANSITION_INVALID';

  elsif old.status = 'queued' then
    -- Preserve the CURRENT claim RPC's second step; no new claim API or rights.
    if new.status = 'running' and new.attempts = old.attempts + 1
      and new.worker_id is not null and length(new.worker_id) >= 8
      and new.lease_until is not null and isfinite(new.lease_until) and new.lease_until > checked_at
      and new.completed_at is null
      and (to_jsonb(new) - array['status','attempts','worker_id','lease_until','updated_at'])
        is not distinct from
        (to_jsonb(old) - array['status','attempts','worker_id','lease_until','updated_at']) then
      return new;
    end if;
    if new.status = 'queued'
      and (to_jsonb(new) - array['available_at','updated_at'])
        is not distinct from (to_jsonb(old) - array['available_at','updated_at'])
      and isfinite(new.available_at) then
      return new;
    end if;
    raise exception using errcode = 'P0L03', message = 'OBJECTIVE_JOB_TRANSITION_INVALID';

  elsif old.status in ('succeeded','blocked','dead_letter') then
    -- A finalized attempt's report cannot be rewritten in place. Fresh manual
    -- retry of a blocked/dead-letter job preserves the old result until a new
    -- attempt owns the row; its server route must revalidate actor and source.
    if new.result is distinct from old.result then
      raise exception using errcode = 'P0L02', message = 'OBJECTIVE_JOB_IMMUTABLE';
    end if;
    if old.status in ('blocked','dead_letter') and new.status = 'queued'
      and new.attempts = 0 and new.worker_id is null and new.lease_until is null
      and new.completed_at is null and new.error_code is null and isfinite(new.available_at)
      and (to_jsonb(new) - array['status','attempts','worker_id','lease_until','completed_at','error_code','available_at','updated_at'])
        is not distinct from
        (to_jsonb(old) - array['status','attempts','worker_id','lease_until','completed_at','error_code','available_at','updated_at']) then
      return new;
    end if;
    if (to_jsonb(new) - 'updated_at') is not distinct from (to_jsonb(old) - 'updated_at') then
      return new;
    end if;
    raise exception using errcode = 'P0L03', message = 'OBJECTIVE_JOB_TRANSITION_INVALID';
  end if;
  raise exception using errcode = 'P0L03', message = 'OBJECTIVE_JOB_TRANSITION_INVALID';
end;
$$;

-- Trigger invocation needs no new service-role EXECUTE grant. Revoke inherited
-- function defaults as well; this helper is not a PostgREST RPC endpoint.
revoke all on function public.runvara_guard_objective_prepare_job() from public, anon, authenticated, service_role;
create trigger runvara_objective_prepare_job_guard
  before update on public.runvara_agent_jobs
  for each row
  when (old.type = 'objective_prepare' or new.type = 'objective_prepare')
  execute function public.runvara_guard_objective_prepare_job();

comment on function public.runvara_guard_objective_prepare_job() is
  'Server-only objective_prepare row transition/lease fence. Invoker, empty search_path, no table reads. Existing worker/attempt/exact-lease predicates remain independently required.';
comment on trigger runvara_objective_prepare_job_guard on public.runvara_agent_jobs is
  'Checks objective writes against post-lock wall time; preserves under-limit expiry recovery and claim, and dead-letters exhausted objective leases without aborting shared claims. Legacy job types are unaffected.';
commit;
