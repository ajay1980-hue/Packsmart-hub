-- Local candidate only. Empty policies and the application switch fail closed.
-- Existing database, no provider activation, credentials, grants to browser roles,
-- production backfill, invented opening balance or fabricated provider prices.
begin;
set local lock_timeout = '5s';

create table public.runvara_creative_budgets (
  scope_key text primary key,
  workspace_id text references public.workspaces(id),
  provider text,
  provider_account_id text,
  policy_revision text not null check (policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'),
  enabled boolean not null default false,
  baseline_verified boolean not null default false,
  not_before timestamptz not null,
  valid_until timestamptz not null,
  limit_cost_micros bigint not null check (limit_cost_micros between 0 and 9007199254740991),
  reserved_cost_micros numeric(60,0) not null default 0 check (reserved_cost_micros >= 0),
  held_cost_micros numeric(60,0) not null default 0 check (held_cost_micros >= 0),
  spent_cost_micros numeric(60,0) not null default 0 check (spent_cost_micros >= 0),
  released_cost_micros numeric(60,0) not null default 0 check (released_cost_micros >= 0),
  uncertain_cost_micros numeric(60,0) not null default 0 check (uncertain_cost_micros between 0 and held_cost_micros),
  overrun_cost_micros numeric(60,0) not null default 0 check (overrun_cost_micros >= 0),
  overrun_blocked boolean not null default false,
  check (reserved_cost_micros + overrun_cost_micros = held_cost_micros + spent_cost_micros + released_cost_micros),
  check (isfinite(not_before) and isfinite(valid_until) and valid_until > not_before),
  check ((workspace_id is not null and provider is null and provider_account_id is null and scope_key='tenant:'||workspace_id)
    or (workspace_id is null and provider is not null and provider_account_id is not null and provider in ('canva','runway') and provider_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'
      and scope_key='account:'||provider||':'||provider_account_id))
);
-- A finite allocation for this tenant's creative work, not a claim about the
-- provider account's total balance or a resettable monthly counter. Unknown and
-- completed-but-unbilled work retains its entire hold. No automatic refunds.
create table public.runvara_creative_prices (
  workspace_id text not null references public.workspaces(id),
  provider text not null,
  phase text not null,
  contract_id text not null,
  account_binding text not null check (account_binding ~ '^[a-f0-9]{64}$'),
  provider_account_id text not null check (provider_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'),
  price_revision text not null check (price_revision ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'),
  verified boolean not null default false,
  entitlement_verified boolean not null default false,
  max_cost_micros bigint not null check (max_cost_micros between 0 and 9007199254740991),
  valid_until timestamptz not null check (isfinite(valid_until)),
  evidence_reference text not null check (length(evidence_reference) between 1 and 500),
  primary key (workspace_id, provider, phase),
  check ((provider, phase, contract_id) in (
    ('canva','asset_upload','canva-asset-upload/v1'), ('canva','autofill','canva-autofill/v1'),
    ('canva','export','canva-export-png-pro/v1'), ('runway','generation','runway-product-ad-10s/v1')))
);
create table public.runvara_creative_approvals (
  id text primary key default ('creative_approval_' || gen_random_uuid()::text),
  workspace_id text not null references public.workspaces(id),
  operation_id uuid not null,
  approval_type text not null default 'creative_phase/v1' check (approval_type='creative_phase/v1'),
  campaign_id text not null,
  request_id text not null,
  provider text not null,
  phase text not null,
  binding jsonb not null check (jsonb_typeof(binding) = 'object'),
  owner_id text not null,
  session_version bigint not null check (session_version > 0),
  status text not null default 'pending' check (status in ('pending','approved','rejected','revoked')),
  revision integer not null default 1 check (revision > 0),
  policy_revision text not null,
  account_scope_key text not null references public.runvara_creative_budgets(scope_key),
  price_revision text not null,
  max_cost_micros bigint not null check (max_cost_micros between 0 and 9007199254740991),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  unique (workspace_id, operation_id),
  unique (workspace_id, request_id, phase)
);
create table public.runvara_creative_reservations (
  id text primary key default ('creative_reservation_' || gen_random_uuid()::text),
  workspace_id text not null references public.workspaces(id),
  approval_id text not null unique references public.runvara_creative_approvals(id),
  approval_revision integer not null,
  request_id text not null,
  phase text not null,
  input_digest text not null check (input_digest ~ '^[a-f0-9]{64}$'),
  held_cost_micros bigint not null check (held_cost_micros between 0 and 9007199254740991),
  account_scope_key text not null references public.runvara_creative_budgets(scope_key),
  admission_month date not null default date_trunc('month',clock_timestamp() at time zone 'UTC')::date,
  accounting_status text not null default 'held' check (accounting_status in ('held','uncertain','settled','cancelled_pre_dispatch','overrun')),
  accounted_cost_micros numeric(60,0),
  status text not null default 'held' check (status in ('held','dispatching','uncertain','accepted','completed','cancelled_pre_dispatch')),
  claim_id text,
  upstream_id text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, request_id, phase)
);
create table public.runvara_creative_audit (
  id bigint generated always as identity primary key,
  workspace_id text not null references public.workspaces(id),
  approval_id text not null references public.runvara_creative_approvals(id),
  event text not null check (event in ('prepared','approved','rejected','revoked','reserved','dispatching','uncertain','accepted','completed','settled','overrun','cancelled_pre_dispatch')),
  actor_id text,
  occurred_at timestamptz not null default clock_timestamp()
);
create table public.runvara_creative_settlements (
  reservation_id text primary key references public.runvara_creative_reservations(id),
  workspace_id text not null references public.workspaces(id),
  account_scope_key text not null references public.runvara_creative_budgets(scope_key),
  receipt_id text not null,
  receipt jsonb not null,
  accounted_cost_micros numeric(60,0) not null check (accounted_cost_micros >= 0),
  outcome text not null check (outcome in ('settled','overrun','cancelled_pre_dispatch')),
  created_at timestamptz not null default clock_timestamp(),
  unique(account_scope_key,receipt_id)
);
create index runvara_creative_audit_workspace on public.runvara_creative_audit(workspace_id, id);
alter table public.runvara_creative_budgets enable row level security;
alter table public.runvara_creative_prices enable row level security;
alter table public.runvara_creative_approvals enable row level security;
alter table public.runvara_creative_reservations enable row level security;
alter table public.runvara_creative_audit enable row level security;
alter table public.runvara_creative_settlements enable row level security;
revoke all on public.runvara_creative_budgets, public.runvara_creative_prices, public.runvara_creative_approvals,
  public.runvara_creative_reservations, public.runvara_creative_audit, public.runvara_creative_settlements from public, anon, authenticated, service_role;
-- Policies/baseline/actual billing reconciliation are privileged operational
-- inputs, never tenant settings or client-supplied prices. No provisioning RPC.

create function public.runvara_creative_scope(p_workspace_id text, p_revision text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s jsonb;
begin
  select state into s from public.saas_workspace_state where workspace_id = p_workspace_id for update;
  if s is null or s #>> '{workspace,id}' is distinct from p_workspace_id
    or (p_revision is not null and s->>'_revision' is distinct from p_revision) then
    raise exception using errcode='P0001', message='CREATIVE_STATE_CONFLICT';
  end if;
  return s;
end $$;
create function public.runvara_creative_owner(s jsonb, p_actor_id text, p_session_version bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare u jsonb; n integer;
begin
  select count(*), jsonb_agg(value)->0 into n,u from jsonb_array_elements(s->'users') where value->>'id'=p_actor_id;
  if n<>1 or u->>'role' is distinct from 'owner' or u->'active'='false'::jsonb
    or u->'passwordChangeRequired' is distinct from 'false'::jsonb
    or coalesce(u->>'sessionVersion','1') is distinct from p_session_version::text
    or (u ? 'workspaceId' and u->>'workspaceId' is distinct from s #>> '{workspace,id}') then
    raise exception using errcode='P0001', message='CREATIVE_OWNER_INVALID';
  end if;
end $$;
create function public.runvara_creative_binding(s jsonb, b jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare c jsonb; r jsonb; n integer; endpoint text; contract text;
begin
  if jsonb_typeof(b) is distinct from 'object' or (select count(*) from jsonb_object_keys(b))<>13
    or not (b ?& array['workspaceId','campaignId','requestId','provider','phase','endpoint','payloadDigest','accountBinding','sourceDigest','inputDigest','contractId','sourcePreview','payloadPreview'])
    or b->>'workspaceId' is distinct from s #>> '{workspace,id}' then
    raise exception using errcode='P0001', message='CREATIVE_BINDING_INVALID';
  end if;
  if exists(select 1 from jsonb_each(b) where jsonb_typeof(value)<>'string')
    or b->>'campaignId' !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'
    or b->>'requestId' !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'
    or exists(select 1 from jsonb_each_text(b) where key in ('payloadDigest','accountBinding','sourceDigest','inputDigest') and value !~ '^[a-f0-9]{64}$') then
    raise exception using errcode='P0001', message='CREATIVE_BINDING_INVALID';
  end if;
  select x.endpoint,x.contract into endpoint,contract from (values
    ('canva','asset_upload','https://api.canva.com/rest/v1/asset-uploads','canva-asset-upload/v1'),
    ('canva','autofill','https://api.canva.com/rest/v1/autofills','canva-autofill/v1'),
    ('canva','export','https://api.canva.com/rest/v1/exports','canva-export-png-pro/v1'),
    ('runway','generation','https://api.dev.runwayml.com/v1/recipes/product_ad','runway-product-ad-10s/v1')
  ) x(provider,phase,endpoint,contract) where x.provider=b->>'provider' and x.phase=b->>'phase';
  if endpoint is null or b->>'endpoint'<>endpoint or b->>'contractId'<>contract then
    raise exception using errcode='P0001', message='CREATIVE_BINDING_INVALID';
  end if;
  if octet_length(b->>'sourcePreview')>32768 or octet_length(b->>'payloadPreview')>32768
    or jsonb_typeof((b->>'sourcePreview')::jsonb)<>'object' or jsonb_typeof((b->>'payloadPreview')::jsonb)<>'object'
    or encode(sha256(convert_to(b->>'sourcePreview','UTF8')),'hex')<>b->>'sourceDigest'
    or encode(sha256(convert_to(b->>'payloadPreview','UTF8')),'hex')<>b->>'payloadDigest'
    or encode(sha256(convert_to(format('{"workspaceId":%s,"campaignId":%s,"requestId":%s,"provider":%s,"phase":%s,"endpoint":%s,"payloadDigest":%s,"accountBinding":%s,"sourceDigest":%s}',
      to_json(b->>'workspaceId'),to_json(b->>'campaignId'),to_json(b->>'requestId'),to_json(b->>'provider'),to_json(b->>'phase'),
      to_json(b->>'endpoint'),to_json(b->>'payloadDigest'),to_json(b->>'accountBinding'),to_json(b->>'sourceDigest')),'UTF8')),'hex')<>b->>'inputDigest' then
    raise exception using errcode='P0001',message='CREATIVE_PREVIEW_DIGEST_INVALID';
  end if;
  select count(*),jsonb_agg(value)->0 into n,c from jsonb_array_elements(s #> '{marketing,campaigns}') where value->>'id'=b->>'campaignId';
  if n<>1 then raise exception using errcode='P0001', message='CREATIVE_CAMPAIGN_INVALID'; end if;
  select count(*),jsonb_agg(value)->0 into n,r from jsonb_array_elements(c->'creativeRequests') where value->>'id'=b->>'requestId';
  if n<>1 or r->>'provider' is distinct from b->>'provider' or r #>> '{safety,origin}' is distinct from 'server_created'
    or r #>> '{safety,workspaceId}' is distinct from b->>'workspaceId'
    or r #>> '{safety,campaignId}' is distinct from b->>'campaignId'
    or r #>> '{safety,requestId}' is distinct from b->>'requestId'
    or r #>> '{safety,provider}' is distinct from b->>'provider'
    or r #>> '{safety,schema}' is distinct from 'runvara-creative-safety/v1' then
    raise exception using errcode='P0001', message='CREATIVE_REQUEST_INVALID';
  end if;
  -- Fingerprinting an old snapshot is not proof it is still the saved creative.
  -- This projection mirrors the existing adapter's sourcePreview, excluding
  -- transient cursors and admission records while retaining all creative inputs.
  if (b->>'sourcePreview')::jsonb is distinct from jsonb_build_object(
    'campaignId',c->'id','requestId',r->'id','provider',r->'provider',
    'stage',coalesce(nullif(r->'stage','""'::jsonb),'null'::jsonb),'status',r->'status',
    'assetId',coalesce(nullif(r->'assetId','""'::jsonb),'null'::jsonb),
    'designId',coalesce(nullif(r->'designId','""'::jsonb),'null'::jsonb),
    'jobId',coalesce(nullif(r->'jobId','""'::jsonb),'null'::jsonb),
    'taskId',coalesce(nullif(r->'taskId','""'::jsonb),'null'::jsonb),
    'product',jsonb_build_object('title',c#>'{product,title}','sku',c#>'{product,sku}','image',c#>'{product,image}','price',c#>'{product,price}'),
    'copy',jsonb_build_object('videoHook',c#>'{copy,videoHook}','headline',c#>'{copy,headline}','longCaption',c#>'{copy,longCaption}','cta',c#>'{copy,cta}'))
    then raise exception using errcode='P0001',message='CREATIVE_SOURCE_CHANGED'; end if;
end $$;
create function public.runvara_creative_budget_summary(p_scope text) returns jsonb
language sql security definer set search_path = '' as $$
 select jsonb_build_object('limitMicros',limit_cost_micros::text,'reservedMicros',reserved_cost_micros::text,'heldMicros',held_cost_micros::text,
 'spentMicros',spent_cost_micros::text,'releasedMicros',released_cost_micros::text,'uncertainMicros',uncertain_cost_micros::text,
 'overrunMicros',overrun_cost_micros::text,'overrunBlocked',overrun_blocked,'availableMicros',greatest(0,limit_cost_micros-held_cost_micros-spent_cost_micros)::text)
 from public.runvara_creative_budgets where scope_key=p_scope
$$;
create function public.runvara_creative_summary(p_id text) returns jsonb
language sql security definer set search_path = '' as $$
 select jsonb_build_object('id',a.id,'approvalType',a.approval_type,'workspaceId',a.workspace_id,'campaignId',a.campaign_id,'requestId',a.request_id,
 'provider',a.provider,'phase',a.phase,'inputDigest',a.binding->>'inputDigest','accountBinding',a.binding->>'accountBinding',
 'contractId',a.binding->>'contractId','status',a.status,'revision',a.revision,'maxCostMicros',a.max_cost_micros,'currency','USD',
 'expiresAt',a.expires_at,'policyRevision',a.policy_revision,'priceRevision',a.price_revision,'reservationStatus',r.status,'upstreamId',r.upstream_id,
 'sourcePreview',a.binding->>'sourcePreview','payloadPreview',a.binding->>'payloadPreview','providerAccountId',b.provider_account_id,
 'accountingStatus',r.accounting_status,'accountedCostMicros',r.accounted_cost_micros::text,
 'heldCostMicros',case when r.accounting_status in ('held','uncertain') then r.held_cost_micros::text else '0' end,
 'tenantBudget',public.runvara_creative_budget_summary('tenant:'||a.workspace_id),'accountBudget',public.runvara_creative_budget_summary(a.account_scope_key))
 from public.runvara_creative_approvals a join public.runvara_creative_budgets b on b.scope_key=a.account_scope_key
 left join public.runvara_creative_reservations r on r.approval_id=a.id where a.id=p_id
$$;
create function public.runvara_creative_policy(p_workspace_id text, b jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare budget public.runvara_creative_budgets; account public.runvara_creative_budgets; price public.runvara_creative_prices; t timestamptz; account_key text;
begin
  select * into price from public.runvara_creative_prices where workspace_id=p_workspace_id and provider=b->>'provider' and phase=b->>'phase' for share;
  account_key:='account:'||(b->>'provider')||':'||price.provider_account_id;
  -- The same canonical provider account budget is shared across credentials,
  -- tenants and all phases. Deterministic account-then-tenant locking.
  perform 1 from public.runvara_creative_budgets where scope_key in ('tenant:'||p_workspace_id,account_key) order by scope_key for update;
  select * into budget from public.runvara_creative_budgets where scope_key='tenant:'||p_workspace_id;
  select * into account from public.runvara_creative_budgets where scope_key=account_key;
  t:=clock_timestamp();
  if budget.workspace_id is null or not budget.enabled or not budget.baseline_verified
    or account.scope_key is null or not account.enabled or not account.baseline_verified
    or budget.overrun_blocked or account.overrun_blocked
    or budget.held_cost_micros+budget.spent_cost_micros>budget.limit_cost_micros
    or account.held_cost_micros+account.spent_cost_micros>account.limit_cost_micros
    or t<account.not_before or t>=account.valid_until
    or t<budget.not_before or t>=budget.valid_until or price.workspace_id is null or not price.verified or not price.entitlement_verified
    or price.valid_until<=t or price.account_binding<>b->>'accountBinding' or price.contract_id<>b->>'contractId' then
    raise exception using errcode='P0001', message='CREATIVE_POLICY_UNVERIFIED';
  end if;
  return jsonb_build_object('policyRevision','creative-policy:'||md5(budget.policy_revision||'|'||account.policy_revision||'|'||account_key),
    'priceRevision',price.price_revision,'maxCostMicros',price.max_cost_micros,'accountScopeKey',account_key,
    'expiresAt',least(budget.valid_until,account.valid_until,price.valid_until),'notBefore',greatest(budget.not_before,account.not_before));
end $$;
create function public.runvara_creative_prepare(p_workspace_id text,p_actor_id text,p_session_version bigint,p_expected_revision text,p_operation_id uuid,p_binding jsonb) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout='5s' set statement_timeout='15s' as $$
declare s jsonb; a public.runvara_creative_approvals; policy jsonb; r jsonb; n integer;
begin
  s:=public.runvara_creative_scope(p_workspace_id,p_expected_revision);
  perform public.runvara_creative_owner(s,p_actor_id,p_session_version);
  perform public.runvara_creative_binding(s,p_binding);
  select count(*) into n from public.runvara_creative_approvals where workspace_id=p_workspace_id and (operation_id=p_operation_id or (request_id=p_binding->>'requestId' and phase=p_binding->>'phase'));
  if n>1 then raise exception using errcode='P0001',message='CREATIVE_APPROVAL_CONFLICT'; end if;
  select * into a from public.runvara_creative_approvals where workspace_id=p_workspace_id and (operation_id=p_operation_id or (request_id=p_binding->>'requestId' and phase=p_binding->>'phase'));
  if found then
    if a.binding<>p_binding or a.owner_id<>p_actor_id then raise exception using errcode='P0001',message='CREATIVE_APPROVAL_CONFLICT'; end if;
    return public.runvara_creative_summary(a.id);
  end if;
  policy:=public.runvara_creative_policy(p_workspace_id,p_binding);
  select r0 into r from jsonb_array_elements(s #> '{marketing,campaigns}') c,
    lateral jsonb_array_elements(c->'creativeRequests') r0 where c->>'id'=p_binding->>'campaignId' and r0->>'id'=p_binding->>'requestId';
  if r #>> '{safety,createdAt}' is null or not isfinite((r #>> '{safety,createdAt}')::timestamptz)
    or (r #>> '{safety,createdAt}')::timestamptz > clock_timestamp()
    or (r #>> '{safety,createdAt}')::timestamptz < (policy->>'notBefore')::timestamptz
    or r->>'status' is distinct from 'pending' or (r #> '{safety,phases}') ? (p_binding->>'phase')
    or (p_binding->>'phase'='autofill' and r->>'stage' is distinct from 'autofill_ready')
    or (p_binding->>'phase'='export' and r->>'stage' is distinct from 'export_ready')
    or (p_binding->>'phase' in ('asset_upload','generation') and (r->>'stage' is not null or r->>'jobId' is not null or r->>'taskId' is not null)) then
    raise exception using errcode='P0001',message='CREATIVE_REQUEST_NOT_FRESH';
  end if;
  insert into public.runvara_creative_approvals(workspace_id,operation_id,campaign_id,request_id,provider,phase,binding,owner_id,session_version,policy_revision,account_scope_key,price_revision,max_cost_micros,expires_at)
  values(p_workspace_id,p_operation_id,p_binding->>'campaignId',p_binding->>'requestId',p_binding->>'provider',p_binding->>'phase',p_binding,p_actor_id,p_session_version,
    policy->>'policyRevision',policy->>'accountScopeKey',policy->>'priceRevision',(policy->>'maxCostMicros')::bigint,least((policy->>'expiresAt')::timestamptz,clock_timestamp()+interval '30 minutes')) returning * into a;
  insert into public.runvara_creative_audit(workspace_id,approval_id,event,actor_id) values(p_workspace_id,a.id,'prepared',p_actor_id);
  return public.runvara_creative_summary(a.id);
end $$;
create function public.runvara_creative_review(p_workspace_id text,p_actor_id text,p_session_version bigint,p_request_id text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout='5s' set statement_timeout='15s' as $$
declare s jsonb; result jsonb;
begin
  s:=public.runvara_creative_scope(p_workspace_id);
  perform public.runvara_creative_owner(s,p_actor_id,p_session_version);
  select coalesce(jsonb_agg(public.runvara_creative_summary(id) order by created_at),'[]'::jsonb) into result
    from public.runvara_creative_approvals where workspace_id=p_workspace_id and request_id=p_request_id and owner_id=p_actor_id;
  return result;
end $$;
create function public.runvara_creative_decide(p_workspace_id text,p_actor_id text,p_session_version bigint,p_approval_id text,p_expected_approval_revision integer,p_decision text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout='5s' set statement_timeout='15s' as $$
declare s jsonb; a public.runvara_creative_approvals; policy jsonb;
begin
  s:=public.runvara_creative_scope(p_workspace_id); perform public.runvara_creative_owner(s,p_actor_id,p_session_version);
  select * into a from public.runvara_creative_approvals where id=p_approval_id and workspace_id=p_workspace_id for update;
  if not found or a.owner_id<>p_actor_id or a.session_version<>p_session_version or p_decision not in ('approved','rejected','revoked') then
    raise exception using errcode='P0001',message='CREATIVE_APPROVAL_INVALID'; end if;
  if a.status=p_decision and a.revision=p_expected_approval_revision+1 then return public.runvara_creative_summary(a.id); end if;
  if a.revision<>p_expected_approval_revision or not (a.status='pending' and p_decision in ('approved','rejected') or a.status='approved' and p_decision='revoked') then
    raise exception using errcode='P0001',message='CREATIVE_APPROVAL_CONFLICT'; end if;
  if p_decision='approved' then
    perform public.runvara_creative_binding(s,a.binding); policy:=public.runvara_creative_policy(p_workspace_id,a.binding);
    if a.expires_at<=clock_timestamp() or a.expires_at>(policy->>'expiresAt')::timestamptz or a.account_scope_key<>policy->>'accountScopeKey'
      or a.policy_revision<>policy->>'policyRevision' or a.price_revision<>policy->>'priceRevision'
      or a.max_cost_micros<>(policy->>'maxCostMicros')::bigint then raise exception using errcode='P0001',message='CREATIVE_APPROVAL_EXPIRED'; end if;
  end if;
  update public.runvara_creative_approvals set status=p_decision,revision=revision+1,decided_at=clock_timestamp() where id=a.id;
  insert into public.runvara_creative_audit(workspace_id,approval_id,event,actor_id) values(p_workspace_id,a.id,p_decision,p_actor_id);
  return public.runvara_creative_summary(a.id);
end $$;
create function public.runvara_creative_reserve(p_workspace_id text,p_expected_revision text,p_binding jsonb) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout='5s' set statement_timeout='15s' as $$
declare s jsonb; a public.runvara_creative_approvals; r public.runvara_creative_reservations; policy jsonb; budget public.runvara_creative_budgets;
begin
  s:=public.runvara_creative_scope(p_workspace_id,p_expected_revision); perform public.runvara_creative_binding(s,p_binding);
  select * into a from public.runvara_creative_approvals where workspace_id=p_workspace_id and request_id=p_binding->>'requestId' and phase=p_binding->>'phase' for update;
  if not found then return jsonb_build_object('allowed',false,'reason','CREATIVE_APPROVAL_REQUIRED'); end if;
  if a.binding<>p_binding then raise exception using errcode='P0001',message='CREATIVE_INPUT_CHANGED'; end if;
  select * into r from public.runvara_creative_reservations where approval_id=a.id;
  if found then return jsonb_build_object('allowed',false,'reason','CREATIVE_SUBMISSION_ALREADY_CLAIMED'); end if;
  perform public.runvara_creative_owner(s,a.owner_id,a.session_version); policy:=public.runvara_creative_policy(p_workspace_id,p_binding);
  if a.status<>'approved' or a.expires_at<=clock_timestamp() or a.expires_at>(policy->>'expiresAt')::timestamptz or a.account_scope_key<>policy->>'accountScopeKey'
    or a.policy_revision<>policy->>'policyRevision' or a.price_revision<>policy->>'priceRevision'
    or a.max_cost_micros<>(policy->>'maxCostMicros')::bigint then raise exception using errcode='P0001',message='CREATIVE_APPROVAL_INVALID'; end if;
  if exists(select 1 from public.runvara_creative_budgets where scope_key in ('tenant:'||p_workspace_id,a.account_scope_key)
    and limit_cost_micros-held_cost_micros-spent_cost_micros<a.max_cost_micros) then return jsonb_build_object('allowed',false,'reason','CREATIVE_BUDGET_EXCEEDED'); end if;
  insert into public.runvara_creative_reservations(workspace_id,approval_id,approval_revision,request_id,phase,input_digest,held_cost_micros,account_scope_key)
    values(p_workspace_id,a.id,a.revision,a.request_id,a.phase,p_binding->>'inputDigest',a.max_cost_micros,a.account_scope_key) returning * into r;
  update public.runvara_creative_budgets set held_cost_micros=held_cost_micros+a.max_cost_micros,reserved_cost_micros=reserved_cost_micros+a.max_cost_micros
    where scope_key in ('tenant:'||p_workspace_id,a.account_scope_key);
  insert into public.runvara_creative_audit(workspace_id,approval_id,event) values(p_workspace_id,a.id,'reserved');
  return jsonb_build_object('allowed',true,'workspaceId',p_workspace_id,'campaignId',a.campaign_id,'requestId',a.request_id,'provider',a.provider,'phase',a.phase,
    'inputDigest',p_binding->>'inputDigest','approvalId',a.id,'approvalRevision',a.revision,'reservationId',r.id,'policyRevision',a.policy_revision,
    'currency','USD','maxCostMicros',a.max_cost_micros,'verifiedUpperBound',true,'expiresAt',a.expires_at);
end $$;
create function public.runvara_creative_confirm(p_workspace_id text,p_expected_revision text,p_reservation_id text,p_claim_id text,p_input_digest text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout='5s' set statement_timeout='15s' as $$
declare s jsonb; a public.runvara_creative_approvals; r public.runvara_creative_reservations; policy jsonb; claim jsonb;
begin
  s:=public.runvara_creative_scope(p_workspace_id,p_expected_revision);
  select * into r from public.runvara_creative_reservations where id=p_reservation_id and workspace_id=p_workspace_id for update;
  if not found or r.status<>'held' or r.input_digest<>p_input_digest then raise exception using errcode='P0001',message='CREATIVE_DISPATCH_ALREADY_CLAIMED'; end if;
  select * into a from public.runvara_creative_approvals where id=r.approval_id for update;
  perform public.runvara_creative_owner(s,a.owner_id,a.session_version); perform public.runvara_creative_binding(s,a.binding);
  policy:=public.runvara_creative_policy(p_workspace_id,a.binding);
  if a.status<>'approved' or a.revision<>r.approval_revision or a.expires_at<=clock_timestamp()
    or a.expires_at>(policy->>'expiresAt')::timestamptz or a.account_scope_key<>policy->>'accountScopeKey'
    or a.policy_revision<>policy->>'policyRevision' or a.price_revision<>policy->>'priceRevision'
    or a.max_cost_micros<>(policy->>'maxCostMicros')::bigint then raise exception using errcode='P0001',message='CREATIVE_APPROVAL_INVALID'; end if;
  select q #> array['safety','phases',a.phase] into claim from jsonb_array_elements(s #> '{marketing,campaigns}') c,
    lateral jsonb_array_elements(c->'creativeRequests') q where c->>'id'=a.campaign_id and q->>'id'=a.request_id;
  if claim->>'id' is distinct from p_claim_id or claim->>'status' is distinct from 'dispatching' or claim->>'inputDigest' is distinct from r.input_digest
    or claim #>> '{allowance,reservationId}' is distinct from r.id or claim #>> '{allowance,approvalId}' is distinct from a.id
    or claim #>> '{allowance,approvalRevision}' is distinct from a.revision::text
    or claim #>> '{allowance,policyRevision}' is distinct from a.policy_revision
    or claim #>> '{allowance,currency}' is distinct from 'USD'
    or claim #>> '{allowance,maxCostMicros}' is distinct from a.max_cost_micros::text
    or claim #> '{allowance,verifiedUpperBound}' is distinct from 'true'::jsonb
    or (claim #>> '{allowance,expiresAt}')::timestamptz is distinct from a.expires_at
    or claim->>'payloadDigest' is distinct from a.binding->>'payloadDigest' or claim->>'sourceDigest' is distinct from a.binding->>'sourceDigest'
    or claim->>'accountBinding' is distinct from a.binding->>'accountBinding' or claim->>'endpoint' is distinct from a.binding->>'endpoint' then
    raise exception using errcode='P0001',message='CREATIVE_CLAIM_ACK_INVALID'; end if;
  -- A lost response never permits this entitlement to be acquired again.
  update public.runvara_creative_reservations set status='dispatching',claim_id=p_claim_id,updated_at=clock_timestamp() where id=r.id;
  insert into public.runvara_creative_audit(workspace_id,approval_id,event) values(p_workspace_id,a.id,'dispatching');
  return jsonb_build_object('ok',true,'reservationId',r.id,'status','dispatching');
end $$;
create function public.runvara_creative_observe(p_workspace_id text,p_reservation_id text,p_input_digest text,p_outcome text,p_upstream_id text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout='5s' set statement_timeout='15s' as $$
declare r public.runvara_creative_reservations;
begin
  perform public.runvara_creative_scope(p_workspace_id);
  select * into r from public.runvara_creative_reservations where id=p_reservation_id and workspace_id=p_workspace_id for update;
  if not found or r.input_digest<>p_input_digest or r.status in ('held','cancelled_pre_dispatch') or p_outcome not in ('uncertain','accepted','completed')
    or (p_outcome in ('accepted','completed') and (p_upstream_id is null or p_upstream_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'))
    or (r.upstream_id is not null and p_upstream_id is distinct from r.upstream_id) then
    raise exception using errcode='P0001',message='CREATIVE_RECEIPT_CONFLICT'; end if;
  if r.status=p_outcome then return jsonb_build_object('ok',true,'reservationId',r.id,'status',r.status); end if;
  if r.status='completed' or (r.status='accepted' and p_outcome='uncertain') then raise exception using errcode='P0001',message='CREATIVE_RECEIPT_CONFLICT'; end if;
  -- A known job may be reconciled after an accepted-receipt acknowledgement was
  -- lost. This never permits a POST or returns a dispatch entitlement.
  if p_outcome='uncertain' and r.accounting_status='held' then
    perform 1 from public.runvara_creative_budgets where scope_key in ('tenant:'||p_workspace_id,r.account_scope_key) order by scope_key for update;
    update public.runvara_creative_budgets set uncertain_cost_micros=uncertain_cost_micros+r.held_cost_micros
      where scope_key in ('tenant:'||p_workspace_id,r.account_scope_key);
    update public.runvara_creative_reservations set accounting_status='uncertain' where id=r.id;
  end if;
  update public.runvara_creative_reservations set status=p_outcome,upstream_id=coalesce(p_upstream_id,upstream_id),updated_at=clock_timestamp() where id=r.id;
  insert into public.runvara_creative_audit(workspace_id,approval_id,event) values(p_workspace_id,r.approval_id,p_outcome);
  -- A job completing is not billing proof. Keep the full hold and cost unknown.
  return jsonb_build_object('ok',true,'reservationId',r.id,'status',p_outcome);
end $$;

-- Deliberately not called by job completion. Only a trusted billing receipt or
-- proof that the one-use dispatch admission was never issued can release funds.
-- No browser route, expiry sweep, restart or monthly reset invokes settlement.
create function public.runvara_creative_settle(p_workspace_id text,p_reservation_id text,p_input_digest text,p_receipt jsonb) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout='5s' set statement_timeout='15s' as $$
declare r public.runvara_creative_reservations; prior public.runvara_creative_settlements; amount numeric(60,0); excess numeric(60,0); outcome text; account public.runvara_creative_budgets;
begin
  perform public.runvara_creative_scope(p_workspace_id);
  select * into r from public.runvara_creative_reservations where id=p_reservation_id and workspace_id=p_workspace_id for update;
  if not found or r.input_digest<>p_input_digest or jsonb_typeof(p_receipt) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_receipt))<>7
    or not(p_receipt ?& array['type','id','providerAccountId','currency','costMicros','upstreamId','evidenceDigest'])
    or exists(select 1 from jsonb_each(p_receipt) where jsonb_typeof(value)<>'string')
    or p_receipt->>'type' not in ('provider_bill/v1','not_dispatched/v1')
    or p_receipt->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'
    or p_receipt->>'currency'<>'USD' or p_receipt->>'costMicros' !~ '^(0|[1-9][0-9]{0,59})$'
    or p_receipt->>'evidenceDigest' !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='P0001',message='CREATIVE_SETTLEMENT_INVALID'; end if;
  perform 1 from public.runvara_creative_budgets where scope_key in ('tenant:'||p_workspace_id,r.account_scope_key) order by scope_key for update;
  select * into account from public.runvara_creative_budgets where scope_key=r.account_scope_key;
  if p_receipt->>'providerAccountId' is distinct from account.provider_account_id then
    raise exception using errcode='P0001',message='CREATIVE_SETTLEMENT_INVALID'; end if;
  select * into prior from public.runvara_creative_settlements where reservation_id=r.id;
  if found then
    if prior.receipt is distinct from p_receipt then raise exception using errcode='P0001',message='CREATIVE_SETTLEMENT_CONFLICT'; end if;
    return jsonb_build_object('ok',true,'reservationId',r.id,'status',prior.outcome,'accountedCostMicros',prior.accounted_cost_micros::text);
  end if;
  amount:=(p_receipt->>'costMicros')::numeric;
  if p_receipt->>'type'='not_dispatched/v1' then
    if r.status<>'held' or r.claim_id is not null or r.upstream_id is not null or amount<>0 or p_receipt->>'upstreamId'<>'' then
      raise exception using errcode='P0001',message='CREATIVE_DISPATCH_OUTCOME_UNKNOWN'; end if;
    outcome:='cancelled_pre_dispatch';
  else
    if r.status not in ('accepted','completed') or r.upstream_id is null or p_receipt->>'upstreamId' is distinct from r.upstream_id then
      raise exception using errcode='P0001',message='CREATIVE_DISPATCH_OUTCOME_UNKNOWN'; end if;
    outcome:=case when amount>r.held_cost_micros then 'overrun' else 'settled' end;
  end if;
  excess:=greatest(0,amount-r.held_cost_micros);
  insert into public.runvara_creative_settlements(reservation_id,workspace_id,account_scope_key,receipt_id,receipt,accounted_cost_micros,outcome)
    values(r.id,p_workspace_id,r.account_scope_key,p_receipt->>'id',p_receipt,amount,outcome);
  update public.runvara_creative_budgets set held_cost_micros=held_cost_micros-r.held_cost_micros,
    uncertain_cost_micros=uncertain_cost_micros-case when r.accounting_status='uncertain' then r.held_cost_micros else 0 end,
    spent_cost_micros=spent_cost_micros+amount,released_cost_micros=released_cost_micros+greatest(0,r.held_cost_micros-amount),
    overrun_cost_micros=overrun_cost_micros+excess,overrun_blocked=overrun_blocked or excess>0
    where scope_key in ('tenant:'||p_workspace_id,r.account_scope_key);
  update public.runvara_creative_reservations set accounting_status=outcome,accounted_cost_micros=amount,
    status=case when outcome='cancelled_pre_dispatch' then outcome else status end,updated_at=clock_timestamp() where id=r.id;
  insert into public.runvara_creative_audit(workspace_id,approval_id,event) values(p_workspace_id,r.approval_id,outcome);
  return jsonb_build_object('ok',true,'reservationId',r.id,'status',outcome,'accountedCostMicros',amount::text);
end $$;

revoke all on function public.runvara_creative_scope(text,text), public.runvara_creative_owner(jsonb,text,bigint),
 public.runvara_creative_binding(jsonb,jsonb),public.runvara_creative_summary(text),public.runvara_creative_budget_summary(text),public.runvara_creative_policy(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.runvara_creative_prepare(text,text,bigint,text,uuid,jsonb),public.runvara_creative_review(text,text,bigint,text),
 public.runvara_creative_decide(text,text,bigint,text,integer,text),public.runvara_creative_reserve(text,text,jsonb),
 public.runvara_creative_confirm(text,text,text,text,text),public.runvara_creative_observe(text,text,text,text,text),public.runvara_creative_settle(text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.runvara_creative_prepare(text,text,bigint,text,uuid,jsonb),public.runvara_creative_review(text,text,bigint,text),
 public.runvara_creative_decide(text,text,bigint,text,integer,text),public.runvara_creative_reserve(text,text,jsonb),
 public.runvara_creative_confirm(text,text,text,text,text),public.runvara_creative_observe(text,text,text,text,text),public.runvara_creative_settle(text,text,text,jsonb) to service_role;
commit;
