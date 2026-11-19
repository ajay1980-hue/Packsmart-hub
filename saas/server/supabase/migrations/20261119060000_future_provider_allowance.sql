-- Optional, explicitly approved ADDITIONAL usage scope. No tenant is installed,
-- no amount is supplied and no dispatch is enabled by applying this migration.
begin;
set local lock_timeout = '5s';
create table public.runvara_provider_future_allowances (
  workspace_id text primary key references public.workspaces(id),
  grant_id text not null unique,
  accounting_start_at bigint not null,
  attestation jsonb not null,
  policy jsonb not null,
  recorded_at timestamptz not null,
  recorded_by name not null
);
alter table public.runvara_provider_future_allowances enable row level security;
revoke all on public.runvara_provider_future_allowances from public, anon, authenticated, service_role;
grant select on public.runvara_provider_future_allowances to service_role;
comment on table public.runvara_provider_future_allowances is
  'Immutable initial additional-use grants. Historical exposure remains unknown, outside the grant. No renewal, refund, reset or activation API.';

-- Prevent the old verified-opening installer from creating a competing baseline.
create function public.runvara_reject_competing_opening() returns trigger
language plpgsql security invoker set search_path='' as $$ begin
  if exists(select 1 from public.runvara_provider_future_allowances where workspace_id=new.workspace_id) then
    raise exception using errcode='22023', message='AI_ACCOUNTING_SCOPE_CONFLICT';
  end if;
  return new;
end $$;
revoke all on function public.runvara_reject_competing_opening() from public,anon,authenticated,service_role;
create trigger runvara_opening_scope_guard before insert on public.runvara_provider_usage_openings
  for each row execute function public.runvara_reject_competing_opening();

create function public.runvara_install_future_provider_allowance(p_workspace_id text,p_attestation jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare
  state jsonb;
  existing public.runvara_provider_future_allowances%rowtype;
  recorded timestamptz;
  ms bigint;
  field text;
  policy jsonb;
begin
  if p_workspace_id is null or length(p_workspace_id) not between 1 and 200
    or jsonb_typeof(p_attestation) is distinct from 'object' then
    raise exception using errcode='22023',message='AI_FUTURE_ATTESTATION_INVALID';
  end if;
  select s.state into state from public.saas_workspace_state s where s.workspace_id=p_workspace_id for update;
  if not found then raise exception using errcode='22023',message='AI_WORKSPACE_NOT_FOUND'; end if;
  select * into existing from public.runvara_provider_future_allowances where workspace_id=p_workspace_id;
  if found then
    if existing.attestation is distinct from p_attestation then
      raise exception using errcode='22023',message='AI_FUTURE_GRANT_CONFLICT';
    end if;
    return jsonb_build_object('futureAllowance',existing.policy,'accountingStartAt',existing.accounting_start_at,'idempotent',true);
  end if;
  if state#>'{aiEconomics,governance,enabled}' is distinct from 'false'::jsonb then
    raise exception using errcode='22023',message='AI_FUTURE_REQUIRES_DISABLED_GOVERNANCE';
  end if;
  if exists(select 1 from public.runvara_provider_usage_openings where workspace_id=p_workspace_id)
    or exists(select 1 from public.runvara_provider_usage_windows where workspace_id=p_workspace_id)
    or exists(select 1 from public.runvara_provider_usage_reservations where workspace_id=p_workspace_id) then
    raise exception using errcode='22023',message='AI_FUTURE_GOVERNED_HISTORY_EXISTS';
  end if;
  recorded:=clock_timestamp(); ms:=floor(extract(epoch from recorded)*1000);
  if p_attestation-array['version','workspaceId','grantId','currency','scope','historicalExposure','evidenceHash',
    'verifiedAt','approvedAt','expiresAt','legacyDispatchStoppedAt','legacyDispatchersRetired','inflightDrained',
    'futureAccountVerified','exclusiveDispatchScope','legacyUsageFingerprint','credentialDigest','organizationId','projectId','limits']<>'{}'::jsonb
    or p_attestation->'version' is distinct from '1'::jsonb
    or p_attestation->>'workspaceId' is distinct from p_workspace_id
    or p_attestation->>'currency' is distinct from 'USD'
    or p_attestation->>'scope' is distinct from 'additional_after_cutover'
    or p_attestation->'historicalExposure' is distinct from '{"status":"unknown","costMicros":null,"reconciled":false}'::jsonb
    or p_attestation->'legacyDispatchersRetired' is distinct from 'true'::jsonb
    or p_attestation->'inflightDrained' is distinct from 'true'::jsonb
    or p_attestation->'futureAccountVerified' is distinct from 'true'::jsonb
    or p_attestation->'exclusiveDispatchScope' is distinct from 'true'::jsonb then
    raise exception using errcode='22023',message='AI_FUTURE_ATTESTATION_INVALID';
  end if;
  foreach field in array array['grantId','organizationId','projectId'] loop
    if jsonb_typeof(p_attestation->field) is distinct from 'string' or (p_attestation->>field)!~'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$' then
      raise exception using errcode='22023',message='AI_FUTURE_ATTESTATION_INVALID';
    end if;
  end loop;
  foreach field in array array['evidenceHash','legacyUsageFingerprint','credentialDigest'] loop
    if jsonb_typeof(p_attestation->field) is distinct from 'string' or (p_attestation->>field)!~'^[a-f0-9]{64}$' then
      raise exception using errcode='22023',message='AI_FUTURE_ATTESTATION_INVALID';
    end if;
  end loop;
  foreach field in array array['verifiedAt','approvedAt','expiresAt','legacyDispatchStoppedAt'] loop
    if jsonb_typeof(p_attestation->field) is distinct from 'number' or (p_attestation->>field)!~'^[0-9]{1,16}$'
      or (p_attestation->>field)::numeric>8640000000000000 then
      raise exception using errcode='22023',message='AI_FUTURE_ATTESTATION_INVALID';
    end if;
  end loop;
  if (p_attestation->>'verifiedAt')::numeric not between ms-86400000 and ms
    or (p_attestation->>'approvedAt')::numeric>(p_attestation->>'verifiedAt')::numeric
    or (p_attestation->>'legacyDispatchStoppedAt')::numeric>(p_attestation->>'verifiedAt')::numeric
    or (p_attestation->>'expiresAt')::numeric<=ms then
    raise exception using errcode='22023',message='AI_FUTURE_ATTESTATION_INVALID';
  end if;
  if jsonb_typeof(p_attestation->'limits') is distinct from 'object'
    or (p_attestation->'limits')-array['maxRequests','maxInputTokens','maxOutputTokens','maxTotalTokens','maxCostMicros']<>'{}'::jsonb then
    raise exception using errcode='22023',message='AI_FUTURE_LIMIT_INVALID';
  end if;
  foreach field in array array['maxRequests','maxInputTokens','maxOutputTokens','maxTotalTokens','maxCostMicros'] loop
    if jsonb_typeof(p_attestation->'limits'->field) is distinct from 'number'
      or (p_attestation->'limits'->>field)!~'^[0-9]{1,16}$'
      or (p_attestation->'limits'->>field)::numeric>9007199254740991 then
      raise exception using errcode='22023',message='AI_FUTURE_LIMIT_INVALID';
    end if;
  end loop;
  if public.runvara_legacy_usage_fingerprint(p_workspace_id) is distinct from p_attestation->>'legacyUsageFingerprint'
    or exists(select 1 from public.runvara_ai_usage where workspace_id=p_workspace_id and occurred_at>recorded) then
    raise exception using errcode='22023',message='AI_FUTURE_LEGACY_HISTORY_CHANGED';
  end if;
  -- Exact immutable projection used by SQL and the runtime's policy fingerprint.
  policy:=p_attestation-array['workspaceId','verifiedAt','approvedAt','legacyDispatchersRetired','inflightDrained',
    'futureAccountVerified','exclusiveDispatchScope','legacyUsageFingerprint'];
  policy:=policy||jsonb_build_object('accountingStartAt',ms);
  insert into public.runvara_provider_future_allowances values(p_workspace_id,p_attestation->>'grantId',ms,p_attestation,policy,recorded,session_user);
  if (p_attestation->>'expiresAt')::numeric<=extract(epoch from clock_timestamp())*1000 then
    raise exception using errcode='22023',message='AI_FUTURE_ATTESTATION_EXPIRED';
  end if;
  return jsonb_build_object('futureAllowance',policy,'accountingStartAt',ms,'idempotent',false);
end $$;
revoke all on function public.runvara_install_future_provider_allowance(text,jsonb) from public,anon,authenticated,service_role;

-- Reservation definitions appended below; settlement remains unchanged.
create or replace function public.runvara_reserve_provider_usage(
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
  p_route_valid_until timestamptz,
  p_future_grant_id text,
  p_credential_digest text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '15s'
as $$
declare
  opening public.runvara_provider_usage_openings%rowtype;
  opening_balance jsonb;
  future_grant public.runvara_provider_future_allowances%rowtype;
  future_used record;
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
  select o.* into opening from public.runvara_provider_usage_openings o where o.workspace_id = p_workspace_id;
  select * into future_grant from public.runvara_provider_future_allowances where workspace_id=p_workspace_id;
  if future_grant.workspace_id is not null then
    if opening.workspace_id is not null
      or p_provider <> 'openai' or p_adapter_id <> 'openai-responses'
      or p_future_grant_id is distinct from future_grant.grant_id
      or p_credential_digest is distinct from future_grant.policy->>'credentialDigest'
      or governance->'futureAllowance' is distinct from future_grant.policy
      or governance->'accountingStartAt' is distinct from to_jsonb(future_grant.accounting_start_at)
      or governance#>'{providers,openai,adapters,openai-responses,atomicUsageCutoverAt}' is distinct from future_grant.policy->'legacyDispatchStoppedAt'
      or jsonb_typeof(governance->'configuredAt') is distinct from 'number'
      or (governance->>'configuredAt') !~ '^[0-9]{1,16}$'
      or (governance->>'configuredAt')::numeric not between future_grant.accounting_start_at and current_ms
      or current_ms < future_grant.accounting_start_at
      or (future_grant.policy->>'expiresAt')::numeric <= current_ms
      or extract(epoch from p_route_valid_until)*1000 > (future_grant.policy->>'expiresAt')::numeric
      or not exists(select 1 from public.runvara_agent_jobs where id=p_job_id and workspace_id=p_workspace_id
        and created_at>=future_grant.recorded_at and created_at<=current_time_value)
      or public.runvara_legacy_usage_fingerprint(p_workspace_id) is distinct from future_grant.attestation->>'legacyUsageFingerprint' then
      return jsonb_build_object('dispatch_allowed',false,'reason','AI_FUTURE_ALLOWANCE_UNVERIFIED');
    end if;
  elsif governance ? 'futureAllowance' or p_future_grant_id is not null or p_credential_digest is not null then
    return jsonb_build_object('dispatch_allowed',false,'reason','AI_FUTURE_ALLOWANCE_UNVERIFIED');
  elsif opening.workspace_id is not null then
    -- An installed opening cannot be bypassed by switching to a different clean
    -- boundary. Activation is a separate, truthfully dated platform action.
    if governance->'accountingStartAt' is distinct from to_jsonb(opening.accounting_start_at)
      or jsonb_typeof(governance->'configuredAt') is distinct from 'number'
      or (governance->>'configuredAt') !~ '^[0-9]{1,16}$'
      or (governance->>'configuredAt')::numeric < opening.accounting_start_at
      or (governance->>'configuredAt')::numeric > current_ms
      or opening.accounting_start_at > current_ms
      or not (opening.attestation->'providers' ? p_provider)
      or not exists (select 1 from public.runvara_agent_jobs j where j.id = p_job_id
        and j.created_at >= opening.recorded_at)
      or public.runvara_legacy_usage_fingerprint(p_workspace_id) is distinct from opening.attestation->>'legacyUsageFingerprint' then
      return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
    end if;
  else
    -- Existing clean-month contract is unchanged when no opening is installed.
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

  if future_grant.workspace_id is not null then
    -- Reuse immutable reservation upper bounds across ALL months/statuses.
    -- Settlement/cancellation never replenishes this additional grant. The tenant
    -- lock above serializes the aggregate and insert across every replica.
    select coalesce(sum(reserved_requests),0) as requests,coalesce(sum(reserved_input_tokens),0) as inputs,
      coalesce(sum(reserved_output_tokens),0) as outputs,coalesce(sum(reserved_total_tokens),0) as total,
      coalesce(sum(reserved_cost_micros),0) as cost into future_used
      from public.runvara_provider_usage_reservations where workspace_id=p_workspace_id;
    limits:=future_grant.policy->'limits';
    if future_used.requests+1>(limits->>'maxRequests')::numeric
      or future_used.inputs+p_input_token_bound>(limits->>'maxInputTokens')::numeric
      or future_used.outputs+p_output_token_bound>(limits->>'maxOutputTokens')::numeric
      or future_used.total+total_bound>(limits->>'maxTotalTokens')::numeric
      or future_used.cost+cost_bound>(limits->>'maxCostMicros')::numeric then
      return jsonb_build_object('dispatch_allowed',false,'reason','AI_FUTURE_ALLOWANCE_EXHAUSTED');
    end if;
    snapshot:=snapshot||jsonb_build_object('accountingScope','additional_after_cutover','futureGrantId',future_grant.grant_id,
      'historicalExposure','{"status":"unknown","costMicros":null,"reconciled":false}'::jsonb);
  end if;

  -- Consistent lock order: tenant state, job, tenant counters, provider counters.
  -- Empty windows are harmless on a denial; no held exposure is changed.
  foreach scope in array array['tenant', 'provider:' || p_provider] loop
    insert into public.runvara_provider_usage_windows (workspace_id,scope_key,window_start)
      values (p_workspace_id,scope,window_date) on conflict do nothing;
    select w.* into usage_window from public.runvara_provider_usage_windows w
      where w.workspace_id = p_workspace_id and w.scope_key = scope and w.window_start = window_date for update;
    if opening.workspace_id is not null and window_date = opening.window_start then
      opening_balance := case when scope = 'tenant' then opening.tenant_balance else opening.attestation->'providers'->p_provider end;
      if usage_window.settled_requests < (opening_balance->>'requests')::numeric
        or usage_window.settled_input_tokens < (opening_balance->>'inputTokens')::numeric
        or usage_window.settled_output_tokens < (opening_balance->>'outputTokens')::numeric
        or usage_window.settled_total_tokens < (opening_balance->>'totalTokens')::numeric
        or usage_window.settled_cost_micros < (opening_balance->>'costMicros')::numeric then
        return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
      end if;
    end if;
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

  -- Legacy appenders do not take the tenant lock. A late receipt committed while
  -- counters waited must invalidate this admission as well as subsequent ones.
  if opening.workspace_id is not null and
    public.runvara_legacy_usage_fingerprint(p_workspace_id) is distinct from opening.attestation->>'legacyUsageFingerprint' then
    return jsonb_build_object('dispatch_allowed', false, 'reason', 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
  end if;

  if future_grant.workspace_id is not null and
    public.runvara_legacy_usage_fingerprint(p_workspace_id) is distinct from future_grant.attestation->>'legacyUsageFingerprint' then
    return jsonb_build_object('dispatch_allowed',false,'reason','AI_FUTURE_ALLOWANCE_UNVERIFIED');
  end if;

  -- No expiry/window boundary may be crossed while a counter lock waits.
  current_time_value := clock_timestamp();
  if p_route_valid_until <= current_time_value
    or (price->>'expiresAt')::numeric <= extract(epoch from current_time_value) * 1000
    or (future_grant.workspace_id is not null and (future_grant.policy->>'expiresAt')::numeric<=extract(epoch from current_time_value)*1000)
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

revoke all on function public.runvara_reserve_provider_usage(text,text,text,integer,text,text,text,text,text,bigint,bigint,text,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.runvara_reserve_provider_usage(text,text,text,integer,text,text,text,text,text,bigint,bigint,text,timestamptz,text,text) to service_role;

-- Preserve the old RPC signature. It cannot bypass an installed future grant.
create or replace function public.runvara_reserve_provider_usage(
 p_workspace_id text,p_job_id text,p_worker_id text,p_job_attempt integer,p_call_key text,
 p_request_fingerprint text,p_provider text,p_adapter_id text,p_model text,p_input_token_bound bigint,
 p_output_token_bound bigint,p_pricing_version text,p_route_valid_until timestamptz
) returns jsonb language sql security invoker set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
 select public.runvara_reserve_provider_usage(p_workspace_id,p_job_id,p_worker_id,p_job_attempt,p_call_key,
 p_request_fingerprint,p_provider,p_adapter_id,p_model,p_input_token_bound,p_output_token_bound,p_pricing_version,p_route_valid_until,null,null);
$$;
revoke all on function public.runvara_reserve_provider_usage(text,text,text,integer,text,text,text,text,text,bigint,bigint,text,timestamptz) from public,anon,authenticated;
grant execute on function public.runvara_reserve_provider_usage(text,text,text,integer,text,text,text,text,text,bigint,bigint,text,timestamptz) to service_role;
commit;
