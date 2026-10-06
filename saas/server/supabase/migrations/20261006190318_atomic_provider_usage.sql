-- Server-only, opt-in provider accounting in the EXISTING Runvara database.
-- Deploy inactive. Drain every legacy paid dispatcher before activating governance.
-- accountingStartAt is an operator-attested clean UTC month boundary.
-- configuredAt is the INITIAL platform attestation time, never a last-edited
-- timestamp. Configure before that boundary; never backdate mid-month activation.
-- Tenant-facing settings must not expose this platform-managed policy. Existing
-- unaccounted measured usage in that window blocks admission; historical unknown
-- exposure requires reconciliation before a clean boundary may be attested.
-- No provider activation, credentials, new roles, or production data backfill.
begin;
set local lock_timeout = '5s';

-- Preserve every measured amount and scale while allowing an extreme overrun
-- to be recorded atomically rather than overflowing the old USD 1m range.
-- Grants and RLS are unchanged; rollback must never narrow financial history.
alter table public.runvara_ai_usage alter column estimated_cost_usd type numeric(30,8);

-- Exact integer NUMERIC aggregates intentionally exceed BIGINT: many already-
-- held calls may report truthful token/cost overruns after admission stops.
create table public.runvara_provider_usage_windows (
  workspace_id text not null references public.workspaces(id),
  scope_key text not null check (scope_key = 'tenant' or scope_key ~ '^provider:[a-z][a-z0-9-]{0,31}(:[a-z0-9][a-z0-9-]{0,47})?$'),
  window_start date not null check (extract(day from window_start) = 1),
  currency text not null default 'USD' check (currency = 'USD'),
  held_requests numeric(60,0) not null default 0 check (held_requests >= 0 and held_requests < 1e60 and held_requests = trunc(held_requests)),
  held_input_tokens numeric(60,0) not null default 0 check (held_input_tokens >= 0 and held_input_tokens < 1e60 and held_input_tokens = trunc(held_input_tokens)),
  held_output_tokens numeric(60,0) not null default 0 check (held_output_tokens >= 0 and held_output_tokens < 1e60 and held_output_tokens = trunc(held_output_tokens)),
  held_total_tokens numeric(60,0) not null default 0 check (held_total_tokens >= 0 and held_total_tokens < 1e60 and held_total_tokens = trunc(held_total_tokens)),
  held_cost_micros numeric(60,0) not null default 0 check (held_cost_micros >= 0 and held_cost_micros < 1e60 and held_cost_micros = trunc(held_cost_micros)),
  settled_requests numeric(60,0) not null default 0 check (settled_requests >= 0 and settled_requests < 1e60 and settled_requests = trunc(settled_requests)),
  settled_input_tokens numeric(60,0) not null default 0 check (settled_input_tokens >= 0 and settled_input_tokens < 1e60 and settled_input_tokens = trunc(settled_input_tokens)),
  settled_output_tokens numeric(60,0) not null default 0 check (settled_output_tokens >= 0 and settled_output_tokens < 1e60 and settled_output_tokens = trunc(settled_output_tokens)),
  settled_total_tokens numeric(60,0) not null default 0 check (settled_total_tokens >= 0 and settled_total_tokens < 1e60 and settled_total_tokens = trunc(settled_total_tokens)),
  settled_cost_micros numeric(60,0) not null default 0 check (settled_cost_micros >= 0 and settled_cost_micros < 1e60 and settled_cost_micros = trunc(settled_cost_micros)),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, scope_key, window_start),
  check (held_total_tokens = held_input_tokens + held_output_tokens),
  check (settled_total_tokens = settled_input_tokens + settled_output_tokens)
);

create table public.runvara_provider_usage_reservations (
  id text primary key default ('provider_usage_' || gen_random_uuid()::text),
  workspace_id text not null references public.workspaces(id),
  job_id text not null references public.runvara_agent_jobs(id),
  call_key text not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  provider text not null,
  adapter_id text not null,
  model text not null,
  window_start date not null check (extract(day from window_start) = 1),
  currency text not null default 'USD' check (currency = 'USD'),
  reserved_requests bigint not null default 1 check (reserved_requests = 1),
  reserved_input_tokens bigint not null check (reserved_input_tokens >= 0),
  reserved_output_tokens bigint not null check (reserved_output_tokens >= 0),
  reserved_total_tokens bigint not null check (reserved_total_tokens = reserved_input_tokens + reserved_output_tokens),
  reserved_cost_micros numeric(60,0) not null check (reserved_cost_micros >= 0 and reserved_cost_micros < 1e60 and reserved_cost_micros = trunc(reserved_cost_micros)),
  pricing_version text not null,
  pricing_snapshot jsonb not null check (jsonb_typeof(pricing_snapshot) = 'object'),
  status text not null default 'held' check (status in ('held','uncertain','settled','cancelled_pre_dispatch','overrun')),
  observed_input_tokens bigint check (observed_input_tokens >= 0),
  observed_cached_input_tokens bigint check (observed_cached_input_tokens >= 0),
  observed_cache_write_tokens bigint check (observed_cache_write_tokens >= 0),
  observed_output_tokens bigint check (observed_output_tokens >= 0),
  observed_total_tokens bigint check (observed_total_tokens >= 0),
  accounted_cost_micros numeric(60,0) check (accounted_cost_micros >= 0 and accounted_cost_micros < 1e60 and accounted_cost_micros = trunc(accounted_cost_micros)),
  provider_request_id text,
  settlement_fingerprint text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (workspace_id, call_key),
  check (observed_total_tokens = observed_input_tokens + observed_output_tokens),
  check (observed_cached_input_tokens + observed_cache_write_tokens <= observed_input_tokens)
);
create index runvara_provider_usage_reservations_workspace_provider_idx
  on public.runvara_provider_usage_reservations (workspace_id, provider, created_at desc);
create index runvara_provider_usage_reservations_job_idx
  on public.runvara_provider_usage_reservations (job_id);
create index runvara_provider_usage_reservations_overrun_idx
  on public.runvara_provider_usage_reservations (workspace_id, provider) where status = 'overrun';

alter table public.runvara_provider_usage_windows enable row level security;
alter table public.runvara_provider_usage_reservations enable row level security;
revoke all on table public.runvara_provider_usage_windows, public.runvara_provider_usage_reservations from public, anon, authenticated, service_role;
grant select, insert, update on table public.runvara_provider_usage_windows, public.runvara_provider_usage_reservations to service_role;

create function public.runvara_reserve_provider_usage(
  p_workspace_id text,
  p_job_id text,
  p_worker_id text,
  p_job_attempt integer,
  p_call_key text,
  p_request_fingerprint text,
  p_provider text,
  p_adapter_id text,
  p_model text,
  p_input_token_bound bigint,
  p_output_token_bound bigint,
  p_pricing_version text,
  p_route_valid_until timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '15s'
as $$
declare
  workspace_state jsonb;
  governance jsonb;
  provider_policy jsonb;
  price jsonb;
  snapshot jsonb;
  limits jsonb;
  item jsonb;
  field text;
  scope text;
  current_time_value timestamptz;
  current_ms numeric;
  start_ms numeric;
  window_date date;
  total_bound bigint;
  cost_bound bigint;
  cost_value numeric;
  monthly_cost_ceiling numeric;
  pricing_count integer;
  usage_window public.runvara_provider_usage_windows%rowtype;
  reservation public.runvara_provider_usage_reservations%rowtype;
begin
  if p_workspace_id is null or length(p_workspace_id) not between 1 and 200
    or p_job_id is null or length(p_job_id) not between 1 and 200
    or p_worker_id is null or length(p_worker_id) not between 8 and 200
    or p_job_attempt is null or p_job_attempt < 1
    or p_call_key is distinct from p_job_id || ':operator-brief:v1'
    or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_provider is null or p_provider !~ '^[a-z][a-z0-9-]{0,31}(:[a-z0-9][a-z0-9-]{0,47})?$'
    or p_adapter_id is null or p_adapter_id !~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$'
    or p_model is null or p_model !~ '^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$'
    or p_input_token_bound is null or p_input_token_bound not between 0 and 1000000
    or p_output_token_bound is null or p_output_token_bound not between 0 and 128000
    or p_pricing_version is null or length(p_pricing_version) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'AI_RESERVATION_INPUT_INVALID';
  end if;

  -- One tenant lock serializes admission, settlement and authoritative policy
  -- updates across replicas. Refresh wall time AFTER waiting for this lock.
  select s.state into workspace_state from public.saas_workspace_state s
    where s.workspace_id = p_workspace_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'AI_WORKSPACE_NOT_FOUND';
  end if;
  current_time_value := clock_timestamp();
  current_ms := floor(extract(epoch from current_time_value) * 1000);
  window_date := date_trunc('month', current_time_value at time zone 'UTC')::date;

  -- A retry can discover a reservation after policy/lease expiry, but can NEVER
  -- reacquire dispatch entitlement, even after known cancellation or settlement.
  select r.* into reservation from public.runvara_provider_usage_reservations r
    where r.workspace_id = p_workspace_id and r.call_key = p_call_key;
  if found then
    if reservation.request_fingerprint is distinct from p_request_fingerprint
      or reservation.job_id is distinct from p_job_id
      or reservation.provider is distinct from p_provider
      or reservation.adapter_id is distinct from p_adapter_id
      or reservation.model is distinct from p_model then
      raise exception using errcode = '22023', message = 'AI_RESERVATION_FINGERPRINT_CONFLICT';
    end if;
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_LOGICAL_CALL_EXISTS',
      'reservation_id', reservation.id, 'status', reservation.status,
      'window_start', reservation.window_start, 'reserved_cost_micros', reservation.reserved_cost_micros);
  end if;

  perform 1 from public.runvara_agent_jobs j
    where j.id = p_job_id and j.workspace_id = p_workspace_id and j.status = 'running'
      and j.worker_id = p_worker_id and j.attempts = p_job_attempt
      and j.lease_until > current_time_value for share;
  if not found then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_JOB_LEASE_INVALID');
  end if;
  -- Locking the job may also have waited on a claim/retry operation.
  current_time_value := clock_timestamp();
  current_ms := floor(extract(epoch from current_time_value) * 1000);
  if not exists (select 1 from public.runvara_agent_jobs j where j.id = p_job_id
      and j.lease_until > current_time_value) then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_JOB_LEASE_INVALID');
  end if;
  window_date := date_trunc('month', current_time_value at time zone 'UTC')::date;
  if p_route_valid_until is null or not isfinite(p_route_valid_until) or p_route_valid_until <= current_time_value then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_ROUTE_EXPIRED');
  end if;

  governance := workspace_state #> '{aiEconomics,governance}';
  if jsonb_typeof(governance) is distinct from 'object'
    or governance->'version' is distinct from '1'::jsonb
    or governance->'enabled' is distinct from 'true'::jsonb
    or governance->>'currency' is distinct from 'USD' then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_GOVERNANCE_NOT_CONFIGURED');
  end if;
  -- No fabricated opening balance: first activation is a reviewed clean month.
  if jsonb_typeof(governance->'accountingStartAt') is distinct from 'number'
    or (governance->>'accountingStartAt') !~ '^[0-9]{1,16}$'
    or (governance->>'accountingStartAt')::numeric > current_ms
    or jsonb_typeof(governance->'configuredAt') is distinct from 'number'
    or (governance->>'configuredAt') !~ '^[0-9]{1,16}$'
    or (governance->>'configuredAt')::numeric > (governance->>'accountingStartAt')::numeric then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
  end if;
  start_ms := (governance->>'accountingStartAt')::numeric;
  if start_ms > 8640000000000000 or
      to_timestamp((start_ms / 1000)::double precision) at time zone 'UTC'
      <> date_trunc('month', to_timestamp((start_ms / 1000)::double precision) at time zone 'UTC') then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
  end if;
  -- A legacy measured row not produced by settlement would otherwise silently
  -- disappear from a fresh counter. Deny; do not guess historical uncertainty.
  if exists (select 1 from public.runvara_ai_usage u
      where u.workspace_id = p_workspace_id
        and u.occurred_at >= window_date::timestamp at time zone 'UTC'
        and u.occurred_at < (window_date::timestamp + interval '1 month') at time zone 'UTC'
        and not exists (select 1 from public.runvara_provider_usage_reservations r
          where r.workspace_id = p_workspace_id and u.id = 'provider_settlement_' || r.id
            and r.status in ('settled','overrun'))) then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
  end if;

  provider_policy := governance->'providers'->p_provider;
  if jsonb_typeof(provider_policy) is distinct from 'object'
    or provider_policy->'enabled' is distinct from 'true'::jsonb
    or provider_policy->'adapters'->p_adapter_id->'enabled' is distinct from 'true'::jsonb
    or jsonb_typeof(provider_policy->'allowedAdapters') is distinct from 'array'
    or jsonb_typeof(provider_policy->'allowedModels') is distinct from 'array'
    or not (provider_policy->'allowedAdapters' @> jsonb_build_array(p_adapter_id))
    or not (provider_policy->'allowedModels' @> jsonb_build_array(p_model)) then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_PROVIDER_NOT_ALLOWED');
  end if;
  if exists (select 1 from public.runvara_provider_usage_reservations r
      where r.workspace_id = p_workspace_id and r.provider = p_provider and r.status = 'overrun') then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_PROVIDER_OVERRUN_BLOCKED');
  end if;

  -- Every dimension is compulsory at both scopes. Null, fractional, negative,
  -- stringly-typed, unsafe and absent values fail closed; zero stays zero.
  foreach scope in array array['tenant', 'provider:' || p_provider] loop
    limits := case when scope = 'tenant' then governance->'tenantLimits' else provider_policy->'limits' end;
    if jsonb_typeof(limits) is distinct from 'object' then
      return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_POLICY_LIMIT_INVALID');
    end if;
    foreach field in array array['maxRequests','maxInputTokens','maxOutputTokens','maxTotalTokens','maxCostMicros'] loop
      if jsonb_typeof(limits->field) is distinct from 'number'
        or (limits->>field) !~ '^[0-9]{1,16}$'
        or (limits->>field)::numeric > 9007199254740991 then
        return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_POLICY_LIMIT_INVALID');
      end if;
    end loop;
  end loop;
  monthly_cost_ceiling := (governance #>> '{tenantLimits,maxCostMicros}')::numeric;
  item := workspace_state #> '{aiEconomics,monthlyCostLimitUsd}';
  if item is not null and item <> 'null'::jsonb then
    if jsonb_typeof(item) is distinct from 'number' or item::text !~ '^[0-9]+(\.[0-9]+)?$'
      or item::text::numeric > 1000000 then
      return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_POLICY_LIMIT_INVALID');
    end if;
    monthly_cost_ceiling := least(monthly_cost_ceiling, floor(item::text::numeric * 1000000));
  end if;

  if jsonb_typeof(provider_policy->'pricing') is distinct from 'array' then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_PRICING_UNVERIFIED');
  end if;
  if jsonb_array_length(provider_policy->'pricing') > 128 then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_PRICING_UNVERIFIED');
  end if;
  select count(*), jsonb_agg(e.value)->0 into pricing_count, price
    from jsonb_array_elements(provider_policy->'pricing') e
    where e.value->>'version' = p_pricing_version and e.value->>'adapterId' = p_adapter_id
      and e.value->>'modelId' = p_model;
  if pricing_count <> 1 or price->'verified' is distinct from 'true'::jsonb
    or price->'allInUpperBound' is distinct from 'true'::jsonb
    or price->>'currency' is distinct from 'USD' then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_PRICING_UNVERIFIED');
  end if;
  foreach field in array array['checkedAt','expiresAt','inputMicrosPerMillionTokens','cachedInputMicrosPerMillionTokens','cacheWriteMicrosPerMillionTokens','outputMicrosPerMillionTokens','requestMicros'] loop
    if jsonb_typeof(price->field) is distinct from 'number'
      or (price->>field) !~ '^[0-9]{1,16}$'
      or (price->>field)::numeric > 9007199254740991 then
      return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_PRICING_UNVERIFIED');
    end if;
  end loop;
  if (price->>'checkedAt')::numeric > current_ms
    or (price->>'checkedAt')::numeric < current_ms - 2592000000
    or (price->>'expiresAt')::numeric <= current_ms
    or (price->>'expiresAt')::numeric > (price->>'checkedAt')::numeric + 2592000000
    or extract(epoch from p_route_valid_until) * 1000 > (price->>'expiresAt')::numeric then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_PRICING_EXPIRED');
  end if;
  -- Use the maximum applicable input category; never assume a cache discount.
  total_bound := p_input_token_bound + p_output_token_bound;
  cost_value := ceil(p_input_token_bound::numeric * greatest(
      (price->>'inputMicrosPerMillionTokens')::numeric,
      (price->>'cachedInputMicrosPerMillionTokens')::numeric,
      (price->>'cacheWriteMicrosPerMillionTokens')::numeric) * 0.000001)
    + ceil(p_output_token_bound::numeric * (price->>'outputMicrosPerMillionTokens')::numeric * 0.000001)
    + (price->>'requestMicros')::numeric;
  if cost_value > 9007199254740991 then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_COST_BOUND_INVALID');
  end if;
  cost_bound := cost_value::bigint;
  snapshot := jsonb_build_object('currency','USD','version',p_pricing_version,
    'adapterId',p_adapter_id,'modelId',p_model,'verified',true,'allInUpperBound',true,
    'checkedAt',price->'checkedAt','expiresAt',price->'expiresAt',
    'inputMicrosPerMillionTokens',price->'inputMicrosPerMillionTokens',
    'cachedInputMicrosPerMillionTokens',price->'cachedInputMicrosPerMillionTokens',
    'cacheWriteMicrosPerMillionTokens',price->'cacheWriteMicrosPerMillionTokens',
    'outputMicrosPerMillionTokens',price->'outputMicrosPerMillionTokens','requestMicros',price->'requestMicros');

  -- Consistent lock order: tenant state, job, tenant counters, provider counters.
  -- Empty windows are harmless on a denial; no held exposure is changed.
  foreach scope in array array['tenant', 'provider:' || p_provider] loop
    insert into public.runvara_provider_usage_windows (workspace_id,scope_key,window_start)
      values (p_workspace_id,scope,window_date) on conflict do nothing;
    select w.* into usage_window from public.runvara_provider_usage_windows w
      where w.workspace_id = p_workspace_id and w.scope_key = scope and w.window_start = window_date for update;
    limits := case when scope = 'tenant' then governance->'tenantLimits' else provider_policy->'limits' end;
    if usage_window.held_requests::numeric + usage_window.settled_requests + 1 > (limits->>'maxRequests')::numeric
      or usage_window.held_input_tokens::numeric + usage_window.settled_input_tokens + p_input_token_bound > (limits->>'maxInputTokens')::numeric
      or usage_window.held_output_tokens::numeric + usage_window.settled_output_tokens + p_output_token_bound > (limits->>'maxOutputTokens')::numeric
      or usage_window.held_total_tokens::numeric + usage_window.settled_total_tokens + total_bound > (limits->>'maxTotalTokens')::numeric
      or usage_window.held_cost_micros::numeric + usage_window.settled_cost_micros + cost_bound >
        (case when scope = 'tenant' then monthly_cost_ceiling else (limits->>'maxCostMicros')::numeric end) then
      return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_BUDGET_EXCEEDED', 'scope', scope);
    end if;
  end loop;

  -- No expiry/window boundary may be crossed while a counter lock waits.
  current_time_value := clock_timestamp();
  if p_route_valid_until <= current_time_value
    or (price->>'expiresAt')::numeric <= extract(epoch from current_time_value) * 1000
    or not exists (select 1 from public.runvara_agent_jobs j where j.id = p_job_id and j.lease_until > current_time_value) then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_ADMISSION_EVIDENCE_EXPIRED');
  end if;
  if date_trunc('month', current_time_value at time zone 'UTC')::date <> window_date then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_ADMISSION_WINDOW_CHANGED');
  end if;

  insert into public.runvara_provider_usage_reservations
    (workspace_id,job_id,call_key,request_fingerprint,provider,adapter_id,model,window_start,
     reserved_input_tokens,reserved_output_tokens,reserved_total_tokens,reserved_cost_micros,pricing_version,pricing_snapshot,created_at,updated_at)
  values (p_workspace_id,p_job_id,p_call_key,p_request_fingerprint,p_provider,p_adapter_id,p_model,window_date,
    p_input_token_bound,p_output_token_bound,total_bound,cost_bound,p_pricing_version,snapshot,current_time_value,current_time_value)
  returning * into reservation;
  update public.runvara_provider_usage_windows
    set held_requests = held_requests + 1, held_input_tokens = held_input_tokens + p_input_token_bound,
      held_output_tokens = held_output_tokens + p_output_token_bound, held_total_tokens = held_total_tokens + total_bound,
      held_cost_micros = held_cost_micros + cost_bound, updated_at = current_time_value
    where workspace_id = p_workspace_id and window_start = window_date and scope_key in ('tenant','provider:' || p_provider);
  return jsonb_build_object('dispatch_allowed', true, 'reservation_id', reservation.id, 'status', 'held',
    'window_start', window_date, 'reserved_requests', 1, 'reserved_input_tokens', p_input_token_bound,
    'reserved_output_tokens', p_output_token_bound, 'reserved_total_tokens', total_bound,
    'reserved_cost_micros', cost_bound, 'currency', 'USD', 'pricing_version', p_pricing_version);
end;
$$;

create function public.runvara_settle_provider_usage(
  p_workspace_id text,
  p_reservation_id text,
  p_request_fingerprint text,
  p_outcome text,
  p_receipt jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '15s'
as $$
declare
  reservation public.runvara_provider_usage_reservations%rowtype;
  price jsonb;
  normalized jsonb;
  receipt_fingerprint text;
  field text;
  scope text;
  task_type_value text;
  input_value bigint;
  cached_value bigint;
  cache_write_value bigint;
  output_value bigint;
  total_value bigint;
  cost_value numeric;
  cost_micros numeric(60,0);
  request_id_value text;
  error_value text;
  next_status text;
  valid_usage boolean := true;
  changed integer;
  current_time_value timestamptz;
begin
  if p_workspace_id is null or length(p_workspace_id) not between 1 and 200
    or p_reservation_id is null or length(p_reservation_id) not between 1 and 200
    or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_outcome is null or p_outcome not in ('complete','uncertain','cancelled_pre_dispatch')
    or jsonb_typeof(p_receipt) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'AI_SETTLEMENT_INPUT_INVALID';
  end if;
  -- The same first lock as admission. No lease expiry ever releases exposure.
  perform 1 from public.saas_workspace_state s where s.workspace_id = p_workspace_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'AI_WORKSPACE_NOT_FOUND';
  end if;
  select r.* into reservation from public.runvara_provider_usage_reservations r
    where r.id = p_reservation_id and r.workspace_id = p_workspace_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'AI_RESERVATION_NOT_FOUND';
  end if;
  if reservation.request_fingerprint is distinct from p_request_fingerprint then
    raise exception using errcode = '22023', message = 'AI_RESERVATION_FINGERPRINT_CONFLICT';
  end if;
  select j.type into task_type_value from public.runvara_agent_jobs j
    where j.id = reservation.job_id and j.workspace_id = p_workspace_id;
  if not found or jsonb_typeof(p_receipt->'jobId') is distinct from 'string'
    or p_receipt->>'jobId' is distinct from reservation.job_id then
    raise exception using errcode = '22023', message = 'AI_SETTLEMENT_JOB_MISMATCH';
  end if;
  -- Accept accounting evidence only. Never persist response text, prompts,
  -- credentials, arbitrary provider errors or client-supplied pricing records.
  if exists (select 1 from jsonb_object_keys(p_receipt) k(key) where k.key not in
      ('jobId','providerRequestId','inputTokens','cachedInputTokens','cacheWriteTokens',
       'outputTokens','totalTokens','billedCostMicros','errorCode','dispatchStarted','proof')) then
    raise exception using errcode = '22023', message = 'AI_SETTLEMENT_INPUT_INVALID';
  end if;
  current_time_value := clock_timestamp();

  if p_outcome = 'cancelled_pre_dispatch' then
    if p_receipt->'dispatchStarted' is distinct from 'false'::jsonb
      or p_receipt->>'proof' is distinct from 'local_pre_dispatch'
      or exists (select 1 from jsonb_object_keys(p_receipt) k(key)
        where k.key not in ('jobId','dispatchStarted','proof')) then
      raise exception using errcode = '22023', message = 'AI_PRE_DISPATCH_PROOF_REQUIRED';
    end if;
    normalized := jsonb_build_object('outcome',p_outcome,'jobId',reservation.job_id,
      'dispatchStarted',false,'proof','local_pre_dispatch');
    receipt_fingerprint := encode(sha256(convert_to(normalized::text,'UTF8')),'hex');
    if reservation.status = 'cancelled_pre_dispatch' and reservation.settlement_fingerprint = receipt_fingerprint then
      return jsonb_build_object('reservation_id',reservation.id,'status',reservation.status,'idempotent',true);
    end if;
    -- Once dispatch might have happened, an assertion of no dispatch is no
    -- longer acceptable. Only affirmative measured reconciliation can settle it.
    if reservation.status <> 'held' then
      raise exception using errcode = '22023', message = 'AI_SETTLEMENT_CONFLICT';
    end if;
    next_status := 'cancelled_pre_dispatch';
    input_value := 0; output_value := 0; total_value := 0; cost_micros := 0;
  elsif p_outcome = 'complete' then
    foreach field in array array['inputTokens','cachedInputTokens','cacheWriteTokens','outputTokens','totalTokens'] loop
      if jsonb_typeof(p_receipt->field) is distinct from 'number'
        or (p_receipt->>field) !~ '^[0-9]{1,16}$'
        or (p_receipt->>field)::numeric > 9007199254740991 then
        valid_usage := false;
      end if;
    end loop;
    if p_receipt ? 'billedCostMicros' then
      if jsonb_typeof(p_receipt->'billedCostMicros') is distinct from 'number'
        or (p_receipt->>'billedCostMicros') !~ '^[0-9]{1,16}$'
        or (p_receipt->>'billedCostMicros')::numeric > 9007199254740991 then
        valid_usage := false;
      end if;
    end if;
    if jsonb_typeof(p_receipt->'providerRequestId') is distinct from 'string'
      or length(p_receipt->>'providerRequestId') not between 1 and 180
      or (p_receipt->>'providerRequestId') ~ '[[:cntrl:]]' then
      valid_usage := false;
    end if;
    if valid_usage then
      input_value := (p_receipt->>'inputTokens')::bigint;
      cached_value := (p_receipt->>'cachedInputTokens')::bigint;
      cache_write_value := (p_receipt->>'cacheWriteTokens')::bigint;
      output_value := (p_receipt->>'outputTokens')::bigint;
      total_value := (p_receipt->>'totalTokens')::bigint;
      if cached_value::numeric + cache_write_value > input_value
        or input_value::numeric + output_value <> total_value then
        valid_usage := false;
      end if;
    end if;
    if valid_usage then
      price := reservation.pricing_snapshot;
      -- Exact decimal multiplication avoids PostgreSQL numeric division choosing
      -- insufficient fractional scale for very large monetary amounts.
      -- One rounded input subtotal preserves the reservation's maximum-rate
      -- bound even when measured input spans three billing categories.
      cost_value := ceil(((input_value - cached_value - cache_write_value)::numeric
          * (price->>'inputMicrosPerMillionTokens')::numeric
        + cached_value::numeric * (price->>'cachedInputMicrosPerMillionTokens')::numeric
        + cache_write_value::numeric * (price->>'cacheWriteMicrosPerMillionTokens')::numeric) * 0.000001)
        + ceil(output_value::numeric * (price->>'outputMicrosPerMillionTokens')::numeric * 0.000001)
        + (price->>'requestMicros')::numeric;
      -- An explicit billed receipt can raise accounting above the estimate;
      -- never hide a provider's bound violation by clamping it to a reservation.
      if p_receipt ? 'billedCostMicros' then
        cost_value := greatest(cost_value,(p_receipt->>'billedCostMicros')::numeric);
      end if;
      -- At most MAX_SAFE_INTEGER tokens and rates imply < 10^27 micros
      -- per receipt; even MAX_SAFE_INTEGER held calls remain below 10^43.
      -- NUMERIC(60,0) records that supported arithmetic without clamping.
      cost_micros := cost_value;
      request_id_value := p_receipt->>'providerRequestId';
      normalized := jsonb_build_object('outcome','complete','jobId',reservation.job_id,
        'providerRequestId',request_id_value,'inputTokens',input_value,'cachedInputTokens',cached_value,
        'cacheWriteTokens',cache_write_value,'outputTokens',output_value,'totalTokens',total_value,
        'accountedCostMicros',cost_micros,'billedCostMicros',p_receipt->'billedCostMicros');
      receipt_fingerprint := encode(sha256(convert_to(normalized::text,'UTF8')),'hex');
      if reservation.status in ('settled','overrun') and reservation.settlement_fingerprint = receipt_fingerprint then
        return jsonb_build_object('reservation_id',reservation.id,'status',reservation.status,
          'accounted_cost_micros',case when reservation.accounted_cost_micros > 9007199254740991
            then to_jsonb(reservation.accounted_cost_micros::text) else to_jsonb(reservation.accounted_cost_micros) end,'idempotent',true);
      end if;
      if reservation.status not in ('held','uncertain') then
        raise exception using errcode = '22023', message = 'AI_SETTLEMENT_CONFLICT';
      end if;
      next_status := case when input_value > reservation.reserved_input_tokens
        or output_value > reservation.reserved_output_tokens or total_value > reservation.reserved_total_tokens
        or cost_micros > reservation.reserved_cost_micros then 'overrun' else 'settled' end;
    end if;
  end if;

  if p_outcome = 'uncertain' or not valid_usage then
    if reservation.status not in ('held','uncertain') then
      raise exception using errcode = '22023', message = 'AI_SETTLEMENT_CONFLICT';
    end if;
    error_value := case when not valid_usage then 'AI_USAGE_UNVERIFIED'
      when jsonb_typeof(p_receipt->'errorCode') = 'string'
        and (p_receipt->>'errorCode') ~ '^[A-Z0-9_]{1,80}$' then p_receipt->>'errorCode'
      else 'AI_PROVIDER_OUTCOME_UNCERTAIN' end;
    normalized := jsonb_build_object('outcome','uncertain','jobId',reservation.job_id,'errorCode',error_value);
    receipt_fingerprint := encode(sha256(convert_to(normalized::text,'UTF8')),'hex');
    if reservation.status = 'uncertain' and reservation.settlement_fingerprint is distinct from receipt_fingerprint then
      raise exception using errcode = '22023', message = 'AI_SETTLEMENT_CONFLICT';
    end if;
    update public.runvara_provider_usage_reservations
      set status = 'uncertain', error_code = error_value, settlement_fingerprint = receipt_fingerprint, updated_at = current_time_value
      where id = reservation.id;
    return jsonb_build_object('reservation_id',reservation.id,'status','uncertain',
      'held_cost_micros',reservation.reserved_cost_micros,'reason',error_value,
      'idempotent',reservation.status = 'uncertain');
  end if;

  foreach scope in array array['tenant','provider:' || reservation.provider] loop
    perform 1 from public.runvara_provider_usage_windows w where w.workspace_id = p_workspace_id
      and w.scope_key = scope and w.window_start = reservation.window_start for update;
    if not found then
      raise exception using errcode = '22023', message = 'AI_ACCOUNTING_WINDOW_MISSING';
    end if;
  end loop;
  if next_status in ('settled','overrun') then
    -- Deterministic usage identity plus the existing provider request-id unique
    -- index makes duplicates/conflicts roll back the ENTIRE accounting change.
    insert into public.runvara_ai_usage
      (id,workspace_id,job_id,task_type,provider,model,input_tokens,cached_input_tokens,
       cache_write_tokens,output_tokens,estimated_cost_usd,request_id,occurred_at)
    values ('provider_settlement_' || reservation.id,p_workspace_id,reservation.job_id,
      task_type_value,reservation.provider,reservation.model,input_value,cached_value,
      cache_write_value,output_value,cost_micros::numeric * 0.000001,request_id_value,reservation.created_at);
  end if;
  update public.runvara_provider_usage_windows
    set held_requests = held_requests - reservation.reserved_requests,
      held_input_tokens = held_input_tokens - reservation.reserved_input_tokens,
      held_output_tokens = held_output_tokens - reservation.reserved_output_tokens,
      held_total_tokens = held_total_tokens - reservation.reserved_total_tokens,
      held_cost_micros = held_cost_micros - reservation.reserved_cost_micros,
      settled_requests = settled_requests + case when next_status = 'cancelled_pre_dispatch' then 0 else 1 end,
      settled_input_tokens = settled_input_tokens + input_value,
      settled_output_tokens = settled_output_tokens + output_value,
      settled_total_tokens = settled_total_tokens + total_value,
      settled_cost_micros = settled_cost_micros + cost_micros,
      updated_at = current_time_value
    where workspace_id = p_workspace_id and window_start = reservation.window_start
      and scope_key in ('tenant','provider:' || reservation.provider);
  get diagnostics changed = row_count;
  if changed <> 2 then
    raise exception using errcode = '22023', message = 'AI_ACCOUNTING_WINDOW_MISSING';
  end if;
  update public.runvara_provider_usage_reservations
    set status = next_status, observed_input_tokens = input_value,
      observed_cached_input_tokens = coalesce(cached_value,0), observed_cache_write_tokens = coalesce(cache_write_value,0),
      observed_output_tokens = output_value, observed_total_tokens = total_value,
      accounted_cost_micros = cost_micros, provider_request_id = request_id_value,
      settlement_fingerprint = receipt_fingerprint,
      error_code = case when next_status = 'overrun' then 'AI_PROVIDER_BOUND_OVERRUN' else null end,
      updated_at = current_time_value, settled_at = current_time_value
    where id = reservation.id;
  return jsonb_build_object('reservation_id',reservation.id,'status',next_status,
    'accounted_cost_micros',case when cost_micros > 9007199254740991
      then to_jsonb(cost_micros::text) else to_jsonb(cost_micros) end,
    'window_start',reservation.window_start,'idempotent',false);
end;
$$;

-- Existing service_role may mutate only settlement fields; request identity,
-- original window, reservation bounds and pricing snapshot remain immutable.
revoke update on public.runvara_provider_usage_reservations from service_role;
grant update (status,observed_input_tokens,observed_cached_input_tokens,observed_cache_write_tokens,
  observed_output_tokens,observed_total_tokens,accounted_cost_micros,provider_request_id,
  settlement_fingerprint,error_code,updated_at,settled_at)
  on public.runvara_provider_usage_reservations to service_role;
revoke all on function public.runvara_reserve_provider_usage(text,text,text,integer,text,text,text,text,text,bigint,bigint,text,timestamptz) from public, anon, authenticated;
grant execute on function public.runvara_reserve_provider_usage(text,text,text,integer,text,text,text,text,text,bigint,bigint,text,timestamptz) to service_role;
revoke all on function public.runvara_settle_provider_usage(text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.runvara_settle_provider_usage(text,text,text,text,jsonb) to service_role;

comment on table public.runvara_provider_usage_windows is 'Server-only USD monthly counters, including durable held uncertainty; never a browser authorization surface.';
comment on table public.runvara_provider_usage_reservations is 'Server-only at-most-once logical provider dispatch and immutable request/pricing evidence; no prompts, responses or secrets.';
comment on function public.runvara_reserve_provider_usage(text,text,text,integer,text,text,text,text,text,bigint,bigint,text,timestamptz) is 'Opt-in admission using platform-managed state.aiEconomics.governance and tenant row locking. A returned duplicate never authorizes dispatch.';
comment on function public.runvara_settle_provider_usage(text,text,text,text,jsonb) is 'Atomic append-only measured usage plus held-to-settled accounting. Uncertain calls retain full exposure indefinitely; overrun blocks the provider.';
-- Deliberately leave runvara_ai_usage grants unchanged: SELECT/INSERT only.
commit;
