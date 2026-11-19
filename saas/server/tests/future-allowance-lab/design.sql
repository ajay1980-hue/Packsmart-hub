-- DISPOSABLE DESIGN PROTOTYPE ONLY. Not a Supabase migration or dispatch RPC.
-- Every result explicitly denies dispatch. No production objects are modified.
do $$ begin
  if current_database() <> 'runvara_future_allowance_test' then
    raise exception 'Disposable design database required';
  end if;
end $$;
create schema future_allowance_lab;
revoke all on schema future_allowance_lab from public;
create role future_allowance_reader nologin;
create role future_allowance_service nologin;
grant usage on schema future_allowance_lab to future_allowance_service;

create table future_allowance_lab.grants (
  workspace_id text primary key,
  grant_id text not null unique,
  provider text not null check (provider = 'openai'),
  currency text not null default 'USD' check (currency = 'USD'),
  accounting_scope text not null default 'additional_after_cutover' check (accounting_scope = 'additional_after_cutover'),
  account_binding_hash text not null check (account_binding_hash ~ '^[a-f0-9]{64}$'),
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz not null,
  retired_at timestamptz not null,
  started_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  max_requests bigint not null check (max_requests between 1 and 9007199254740991),
  max_input bigint not null check (max_input between 1 and 9007199254740991),
  max_output bigint not null check (max_output between 1 and 9007199254740991),
  max_total bigint not null check (max_total between 1 and 9007199254740991),
  max_cost_micros bigint not null check (max_cost_micros between 1 and 9007199254740991),
  -- Unknown is a retained fact, not a numeric zero or a reconciled attestation.
  historical_exposure jsonb not null check (
    historical_exposure = '{"status":"unknown","costMicros":null,"reconciled":false}'::jsonb),
  historical_evidence_hash text not null check (historical_evidence_hash ~ '^[a-f0-9]{64}$'),
  check (isfinite(approved_at) and isfinite(retired_at) and isfinite(started_at) and isfinite(expires_at)),
  check (approved_at <= started_at and retired_at <= started_at and expires_at > started_at)
);
create table future_allowance_lab.control (
  workspace_id text primary key references future_allowance_lab.grants,
  -- This exercises accounting in the laboratory; it never enables a provider.
  exercise_enabled boolean not null default false,
  paid_dispatch_enabled boolean not null default false check (paid_dispatch_enabled = false),
  account_binding_hash text not null,
  used_requests bigint not null default 0,
  used_input bigint not null default 0,
  used_output bigint not null default 0,
  used_total bigint not null default 0,
  used_cost_micros bigint not null default 0
);
create table future_allowance_lab.jobs (
  workspace_id text not null references future_allowance_lab.grants,
  job_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  worker_id text not null,
  attempt integer not null check (attempt > 0),
  lease_until timestamptz not null,
  status text not null check (status in ('running','complete')),
  check (isfinite(created_at) and isfinite(lease_until)),
  primary key (workspace_id,job_id)
);
create table future_allowance_lab.calls (
  workspace_id text not null,
  call_key text not null,
  grant_id text not null references future_allowance_lab.grants(grant_id),
  job_id text not null,
  fingerprint text not null,
  input_bound bigint not null,
  output_bound bigint not null,
  cost_bound_micros bigint not null,
  status text not null default 'held' check (status in ('held','uncertain','settled')),
  primary key (workspace_id,call_key),
  foreign key (workspace_id,job_id) references future_allowance_lab.jobs
);
create table future_allowance_lab.audit (
  workspace_id text not null,
  call_key text not null,
  grant_id text not null,
  event text not null check (event = 'synthetic_reservation'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,call_key,event),
  foreign key(workspace_id,call_key) references future_allowance_lab.calls
);
revoke all on all tables in schema future_allowance_lab from public, future_allowance_service, future_allowance_reader;

-- No settlement/refund or renewal path is proposed by this small experiment.
-- All admitted upper bounds remain consumed, even after a synthetic settlement.
-- Owner-approved allowances therefore cannot be replenished by changing status.
create function future_allowance_lab.reserve(
  p_workspace text, p_grant text, p_job text, p_worker text, p_attempt integer,
  p_call text, p_fingerprint text, p_binding text,
  p_input bigint, p_output bigint, p_cost bigint
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare
  g future_allowance_lab.grants;
  c future_allowance_lab.control;
  j future_allowance_lab.jobs;
  previous future_allowance_lab.calls;
  checked_at timestamptz;
  reason text;
begin
  -- Match the production-facing fail-closed outcome even in successful experiments.
  if p_input is null or p_output is null or p_cost is null or p_attempt is null
    or p_input < 0 or p_output < 0 or p_cost < 0
    or p_input > 9007199254740991 or p_output > 9007199254740991 or p_cost > 9007199254740991
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('dispatch_allowed',false,'simulation_reserved',false,'reason','INVALID');
  end if;
  select * into g from future_allowance_lab.grants where workspace_id=p_workspace;
  if not found or g.grant_id is distinct from p_grant then
    return jsonb_build_object('dispatch_allowed',false,'simulation_reserved',false,'reason','GRANT');
  end if;
  select * into c from future_allowance_lab.control where workspace_id=p_workspace for update;
  if not found or not c.exercise_enabled then
    return jsonb_build_object('dispatch_allowed',false,'simulation_reserved',false,'reason','DISABLED');
  end if;
  select * into j from future_allowance_lab.jobs where workspace_id=p_workspace and job_id=p_job for update;
  checked_at := clock_timestamp(); -- Fresh AFTER every potentially blocking lock.
  if not found or j.worker_id is distinct from p_worker or j.attempt is distinct from p_attempt
    or j.status <> 'running' or j.lease_until <= checked_at or j.created_at < g.started_at or j.created_at > checked_at
    or p_call is distinct from p_job || ':operator-brief:v1' then reason := 'JOB';
  elsif g.expires_at <= checked_at or g.started_at > checked_at then reason := 'EXPIRED';
  elsif g.account_binding_hash is distinct from p_binding
    or c.account_binding_hash is distinct from g.account_binding_hash then reason := 'BINDING';
  end if;
  if reason is not null then
    return jsonb_build_object('dispatch_allowed',false,'simulation_reserved',false,'reason',reason);
  end if;
  select * into previous from future_allowance_lab.calls where workspace_id=p_workspace and call_key=p_call;
  if found then
    return jsonb_build_object('dispatch_allowed',false,'simulation_reserved',false,'reason',
      case when previous.fingerprint=p_fingerprint then 'REPLAY' else 'CONFLICT' end);
  end if;
  -- Subtraction avoids overflow. There is no month key or automatic grant rollover.
  if c.used_requests >= g.max_requests or p_input > g.max_input-c.used_input
    or p_output > g.max_output-c.used_output or p_input+p_output > g.max_total-c.used_total
    or p_cost > g.max_cost_micros-c.used_cost_micros then
    return jsonb_build_object('dispatch_allowed',false,'simulation_reserved',false,'reason','ALLOWANCE');
  end if;
  update future_allowance_lab.control set used_requests=used_requests+1,
    used_input=used_input+p_input,used_output=used_output+p_output,
    used_total=used_total+p_input+p_output,used_cost_micros=used_cost_micros+p_cost
    where workspace_id=p_workspace;
  insert into future_allowance_lab.calls values
    (p_workspace,p_call,p_grant,p_job,p_fingerprint,p_input,p_output,p_cost,'held');
  insert into future_allowance_lab.audit(workspace_id,call_key,grant_id,event)
    values(p_workspace,p_call,p_grant,'synthetic_reservation');
  return jsonb_build_object('dispatch_allowed',false,'simulation_reserved',true,'reason','LAB_ONLY');
end $$;
revoke all on function future_allowance_lab.reserve(text,text,text,text,integer,text,text,text,bigint,bigint,bigint) from public;
grant execute on function future_allowance_lab.reserve(text,text,text,text,integer,text,text,text,bigint,bigint,bigint) to future_allowance_service;
