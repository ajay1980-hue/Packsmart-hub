-- Prepared for explicit owner review. Never apply as part of an application start.
-- Dedicated immutable publication ledger; generic history writes prove nothing.
-- Browser roles have no access. The server can SELECT, and publish only through
-- the fixed-purpose transaction. A compact fixed-shape audit_events row is
-- inserted in the same transaction; audit failure rolls everything back and
-- receipt replay never emits another event. Embedded state.audit is untouched.
-- No replacement workspace/candidate is accepted.
begin;

create table public.runvara_business_outcome_versions (
  workspace_id text not null references public.workspaces(id) on delete restrict,
  outcome_id text not null check (outcome_id ~ '^outcome_[0-9a-f]{64}$'),
  version_id text not null check (version_id ~ '^outcome_version_[0-9a-f]{64}$'),
  revision bigint not null check (revision between 1 and 9007199254740991),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('recorded','withdrawn')),
  payload jsonb not null check (jsonb_typeof(payload)='object' and octet_length(payload::text)<=16384),
  source_measurement jsonb not null check (jsonb_typeof(source_measurement)='object' and octet_length(source_measurement::text)<=12288),
  publication_id text not null check (publication_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
  intent_digest text not null check (intent_digest ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz not null,
  commit_revision text not null,
  primary key (workspace_id,version_id),
  unique (workspace_id,outcome_id,revision),
  unique (workspace_id,outcome_id,version_id),
  unique (workspace_id,publication_id)
);
create table public.runvara_business_outcome_heads (
  workspace_id text not null,
  outcome_id text not null,
  version_id text not null,
  primary key (workspace_id,outcome_id),
  constraint runvara_outcome_head_version_fk foreign key (workspace_id,outcome_id,version_id)
    references public.runvara_business_outcome_versions(workspace_id,outcome_id,version_id) on delete restrict
);
alter table public.runvara_business_outcome_versions enable row level security;
alter table public.runvara_business_outcome_heads enable row level security;
revoke all on public.runvara_business_outcome_versions,public.runvara_business_outcome_heads from public,anon,authenticated,service_role;
grant select on public.runvara_business_outcome_versions,public.runvara_business_outcome_heads to service_role;

-- Internal helpers are not RPC capabilities. Canonical object keys in all
-- validated contracts are ASCII. Values are strings, booleans, null, or safe
-- integer numbers. Normalize integer scale before hashing; never hash jsonb::text.
create function public.runvara_outcome_canonical(p_value jsonb,p_depth integer default 0)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare kind text:=jsonb_typeof(p_value); result text; number numeric;
begin
  if p_depth>16 or p_value is null or (p_depth=0 and octet_length(p_value::text)>32768) then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  if kind='object' then
    if exists(select 1 from jsonb_object_keys(p_value) k where k !~ '^[A-Za-z][A-Za-z0-9]*$') then
      raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID';
    end if;
    select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.runvara_outcome_canonical(value,p_depth+1),',' order by key collate "C"),'')||'}' into result from jsonb_each(p_value);
    return result;
  elsif kind='array' then
    if jsonb_array_length(p_value)>500 then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
    select '['||coalesce(string_agg(public.runvara_outcome_canonical(value,p_depth+1),',' order by ordinality),'')||']' into result from jsonb_array_elements(p_value) with ordinality;
    return result;
  elsif kind='number' then
    number:=p_value::text::numeric;
    if number<>trunc(number) or abs(number)>9007199254740991 then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
    return number::bigint::text;
  end if;
  return p_value::text;
end $$;
create function public.runvara_outcome_hash(p_value jsonb)
returns text language sql immutable security invoker set search_path='' as $$
  select encode(sha256(convert_to(public.runvara_outcome_canonical(p_value),'UTF8')),'hex')
$$;
create function public.runvara_outcome_exact(p_value jsonb,p_keys text[])
returns boolean language plpgsql immutable security invoker set search_path='' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'object' then return false; end if;
  return coalesce((select array_agg(k order by k collate "C") from jsonb_object_keys(p_value) k)=(select array_agg(k order by k collate "C") from unnest(p_keys) k),false);
end $$;
create function public.runvara_outcome_timestamp(p_value jsonb)
returns timestamptz language plpgsql immutable security invoker set search_path='' as $$
declare value text; parsed timestamptz;
begin
  if jsonb_typeof(p_value) is distinct from 'string' then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  value:=p_value#>>'{}';
  if value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  parsed:=value::timestamptz;
  if to_char(parsed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>value then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  return parsed;
exception when datetime_field_overflow or invalid_datetime_format then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID';
end $$;
create function public.runvara_outcome_safe_integer(p_value jsonb,p_min bigint,p_max bigint)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare n numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then return false; end if;
  n:=p_value::text::numeric;
  return n=trunc(n) and n between p_min and p_max and abs(n)<=9007199254740991;
end $$;

-- Common optional tenant markers may never contradict the authoritative row.
-- Only the documented marker keys are inspected; unrelated legacy fields stay
-- untouched and are never used as publication evidence.
create function public.runvara_outcome_scope(p_record jsonb,p_workspace_id text)
returns void language plpgsql immutable security invoker set search_path='' as $$
declare key text; marker jsonb;
begin
  if jsonb_typeof(p_record) is distinct from 'object' then raise exception using errcode='P0O01',message='OUTCOME_SCOPE_INVALID'; end if;
  foreach key in array array['workspaceId','workspace_id','tenantId','tenant_id'] loop
    if p_record ? key and p_record->key is distinct from to_jsonb(p_workspace_id) then raise exception using errcode='P0O01',message='OUTCOME_SCOPE_INVALID'; end if;
  end loop;
  foreach key in array array['workspace','tenant'] loop
    if p_record ? key then
      marker:=p_record->key;
      if jsonb_typeof(marker)='object' then marker:=marker->'id'; end if;
      if marker is distinct from to_jsonb(p_workspace_id) then raise exception using errcode='P0O01',message='OUTCOME_SCOPE_INVALID'; end if;
    end if;
  end loop;
end $$;

-- Initial evidence resolver accepts exactly one report recorded with the typed
-- measurement. Legacy impact.verified, generic history and caller refs are never
-- consulted. Non-null links await an independently implemented version resolver.
create function public.runvara_outcome_validate_measurement(p_measurement jsonb,p_workspace_id text,p_experiment_id text,p_now timestamptz)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare m jsonb:=p_measurement; report jsonb; facts jsonb; scope_id text; observation_id text; report_id text;
  started timestamptz; ended timestamptz; observed timestamptz; recorded timestamptz; amount text;
begin
  if not public.runvara_outcome_exact(m,array['schema','workspaceId','experimentId','revision','recordedBy','recordedAt','metric','amount','currency','window','coverage','method','provenance','links','report','digest']) then
    raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID';
  end if;
  if octet_length(public.runvara_outcome_canonical(m))>8192 or octet_length(m::text)>12288 then
    raise exception using errcode='P0O10',message='OUTCOME_PAYLOAD_TOO_LARGE';
  end if;
  if (jsonb_typeof(m->'workspaceId')='string' and jsonb_typeof(m->'experimentId')='string' and jsonb_typeof(m->'digest')='string'
      and m->>'schema'='runvara-experiment-measurement/v1' and m->>'workspaceId'=p_workspace_id and m->>'experimentId'=p_experiment_id
      and public.runvara_outcome_safe_integer(m->'revision',1,9007199254740991)
      and jsonb_typeof(m->'recordedBy')='string' and m->>'recordedBy' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and m->>'metric'='incrementalContribution' and m->>'digest' ~ '^[0-9a-f]{64}$'
      and m->>'digest'=public.runvara_outcome_hash(m-'digest')) is not true then
    raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID';
  end if;
  recorded:=public.runvara_outcome_timestamp(m->'recordedAt');
  if recorded>p_now then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  amount:=m->>'amount';
  if m->'amount'='null'::jsonb or m->'currency'='null'::jsonb or m->'window'='null'::jsonb then
    raise exception using errcode='P0O02',message='OUTCOME_MEASUREMENT_UNQUALIFIED';
  end if;
  if (jsonb_typeof(m->'amount')='string' and amount ~ '^-?(0|[1-9][0-9]{0,17})(\.[0-9]{0,5}[1-9])?$' and amount<>'-0'
      and jsonb_typeof(m->'currency')='string'
      -- runvara-supported-currencies/v1: frozen contract shared with JS.
      -- Supported measurement units, not an assertion of legal-tender status.
      and m->>'currency'=any(string_to_array('AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XDR XOF XPF XSU YER ZAR ZMW ZWG ZWL',' '))) is not true then
    raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID';
  end if;
  if not public.runvara_outcome_exact(m->'window',array['startsAt','endsAt']) then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  started:=public.runvara_outcome_timestamp(m#>'{window,startsAt}'); ended:=public.runvara_outcome_timestamp(m#>'{window,endsAt}');
  if started>=ended or ended-started>interval '366 days' or ended>recorded then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  if not public.runvara_outcome_exact(m->'coverage',array['status','scopeId','observedCount','expectedCount'])
      or not public.runvara_outcome_exact(m->'method',array['kind','definitionVersion']) then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  if (m#>>'{coverage,status}'='complete' and m#>>'{method,kind}' in ('holdout','before_after','reconciled_manual')) is not true then raise exception using errcode='P0O02',message='OUTCOME_MEASUREMENT_UNQUALIFIED'; end if;
  scope_id:='whole_business_'||public.runvara_outcome_hash(jsonb_build_array(p_workspace_id,'whole-business'));
  if (m#>>'{coverage,scopeId}'=scope_id and public.runvara_outcome_safe_integer(m#>'{coverage,observedCount}',0,1000000000)
      and public.runvara_outcome_safe_integer(m#>'{coverage,expectedCount}',0,1000000000)
      and m#>'{coverage,observedCount}'=m#>'{coverage,expectedCount}' and ((m#>>'{coverage,observedCount}')::numeric<>0 or amount='0')
      and m#>>'{method,kind}' in ('holdout','before_after','reconciled_manual')
      and m#>>'{method,definitionVersion}'='incremental-contribution/v1') is not true then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  if m->'links' is distinct from '{"action":null,"opportunity":null,"approval":null,"objective":null}'::jsonb then
    raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID';
  end if;
  report:=m->'report';
  if not public.runvara_outcome_exact(report,array['schema','id','workspaceId','experimentId','measurementRevision','recordedBy','recordedAt','description','costsComplete','facts','digest'])
      or not public.runvara_outcome_exact(m->'provenance',array['observationId','sourceRefs','observedAt','aggregation']) then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  observed:=public.runvara_outcome_timestamp(m#>'{provenance,observedAt}');
  if observed<ended or observed>recorded then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  report_id:='measurement_report_'||public.runvara_outcome_hash(jsonb_build_array(p_workspace_id,p_experiment_id,(m->>'revision')::bigint));
  observation_id:='measurement_observation_'||public.runvara_outcome_hash(jsonb_build_array(p_workspace_id,p_experiment_id));
  facts:=jsonb_build_object('metric',m->'metric','amount',m->'amount','currency',m->'currency','window',m->'window','coverage',m->'coverage','method',m->'method','observedAt',m#>'{provenance,observedAt}');
  if (jsonb_typeof(report->'workspaceId')='string' and jsonb_typeof(report->'experimentId')='string' and jsonb_typeof(report->'digest')='string'
      and report->>'schema'='runvara-measurement-report/v1' and report->>'id'=report_id and report->>'workspaceId'=p_workspace_id
      and report->>'experimentId'=p_experiment_id and report->'measurementRevision'=m->'revision'
      and report->'recordedBy'=m->'recordedBy' and report->'recordedAt'=m->'recordedAt'
      and jsonb_typeof(report->'description')='string' and char_length(report->>'description') between 1 and 1000
      and report->>'description' !~ '[[:cntrl:]]'
      and char_length(report->>'description')+char_length(regexp_replace(report->>'description',U&'[^\+010000-\+10FFFF]','','g'))<=1000
      and report->>'description'=btrim(report->>'description',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
      and report->'facts'=facts and report->>'digest'=public.runvara_outcome_hash(report-'digest')
      and m->'provenance'=jsonb_build_object('observationId',observation_id,'sourceRefs',jsonb_build_array(jsonb_build_object('type','measurement_report','id',report_id,'digest',report->'digest')),'observedAt',m#>'{provenance,observedAt}','aggregation','standalone')) is not true then
    raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID';
  end if;
  if report->'costsComplete' is distinct from 'true'::jsonb then raise exception using errcode='P0O02',message='OUTCOME_MEASUREMENT_UNQUALIFIED'; end if;
  return jsonb_build_object('source',jsonb_build_object('type','experiment_measurement','experimentId',p_experiment_id,'measurementRevision',(m->>'revision')::bigint,'measurementDigest',m->>'digest'),
    'metric',m->'metric','amount',m->'amount','currency',m->'currency','window',m->'window','coverage',m->'coverage','method',m->'method','provenance',m->'provenance','links',m->'links');
end $$;

create function public.runvara_outcome_receipt(p_version public.runvara_business_outcome_versions,p_replayed boolean,p_current boolean)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('publication',jsonb_build_object('head',jsonb_build_object(
    'schema','runvara-outcome-head/v1','workspaceId',p_version.workspace_id,'outcomeId',p_version.outcome_id,
    'revision',p_version.revision,'versionId',p_version.version_id,'digest',p_version.digest,
    'status',case when p_version.status='recorded' then 'published' else 'withdrawn' end,
    'publicationId',p_version.publication_id,'committedAt',to_char(p_version.committed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'commitRevision',p_version.commit_revision),'version',p_version.payload),'replayed',p_replayed,'isCurrent',p_current)
$$;

create function public.runvara_publish_business_outcome(
  p_workspace_id text,p_actor_id text,p_actor_session_version bigint,p_publication_id text,p_action text,
  p_experiment_id text,p_expected_workspace_revision text,p_expected_measurement_revision bigint,
  p_expected_measurement_digest text,p_expected_head_version_id text,p_expected_head_digest text,p_withdrawal_reason text
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
<<publication>>
declare state_value jsonb; experiment jsonb; experiment_index integer; actor jsonb; actor_session bigint; source jsonb; record jsonb;
  head public.runvara_business_outcome_heads; previous public.runvara_business_outcome_versions; receipt public.runvara_business_outcome_versions;
  intent_digest text; outcome_id text; payload jsonb; payload_digest text; version_id text; next_revision bigint;
  committed_at timestamptz; committed_text text; commit_revision text; verification jsonb; lineage jsonb; head_dto jsonb; result jsonb;
begin
  if (p_workspace_id is not null and char_length(p_workspace_id) between 1 and 256 and p_workspace_id=btrim(p_workspace_id)
      and p_workspace_id !~ '[[:cntrl:]]' and p_actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and p_actor_session_version between 1 and 9007199254740991 and p_publication_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and p_action in ('publish','correct','withdraw') and p_experiment_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and p_expected_workspace_revision ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and p_expected_measurement_revision between 1 and 9007199254740991 and p_expected_measurement_digest ~ '^[0-9a-f]{64}$'
      and ((p_action='publish' and p_expected_head_version_id is null and p_expected_head_digest is null)
        or (p_action<>'publish' and p_expected_head_version_id ~ '^outcome_version_[0-9a-f]{64}$' and p_expected_head_digest ~ '^[0-9a-f]{64}$'))
      and ((p_action='withdraw' and p_withdrawal_reason in ('incorrect_measurement','duplicate_observation','incorrect_scope','evidence_retracted'))
        or (p_action<>'withdraw' and p_withdrawal_reason is null))) is not true then
    raise exception using errcode='P0O01',message='OUTCOME_INPUT_INVALID';
  end if;
  select s.state into state_value from public.saas_workspace_state s where s.workspace_id=p_workspace_id for update;
  if not found then raise exception using errcode='P0O09',message='OUTCOME_TARGET_NOT_FOUND'; end if;
  -- All mutable authority and time checks happen after acquiring the workspace
  -- row lock. Existing full-state CAS writes serialize against this same row.
  committed_at:=date_trunc('milliseconds',clock_timestamp());
  committed_text:=to_char(committed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  perform public.runvara_outcome_scope(state_value,p_workspace_id);
  perform public.runvara_outcome_scope(state_value->'workspace',p_workspace_id);
  if state_value#>>'{workspace,id}' is distinct from p_workspace_id or jsonb_typeof(state_value->'users') is distinct from 'array' then
    raise exception using errcode='P0O03',message='OUTCOME_OWNER_REQUIRED';
  end if;
  if jsonb_array_length(state_value->'users')>500 or octet_length((state_value->'users')::text)>262144 then raise exception using errcode='P0O10',message='OUTCOME_AUTHORITY_TOO_LARGE'; end if;
  if (select count(*) from jsonb_array_elements(state_value->'users') u where u->>'id'=p_actor_id)<>1 then
    raise exception using errcode='P0O03',message='OUTCOME_OWNER_REQUIRED';
  end if;
  select u into actor from jsonb_array_elements(state_value->'users') u where u->>'id'=p_actor_id;
  perform public.runvara_outcome_scope(actor,p_workspace_id);
  -- Match documented legacy auth defaults only for absent fields. Explicit
  -- false/null/malformed values never gain an active account or valid session.
  if not (actor ? 'sessionVersion') then actor_session:=1;
  else
    if not public.runvara_outcome_safe_integer(actor->'sessionVersion',1,9007199254740991) then raise exception using errcode='P0O03',message='OUTCOME_OWNER_REQUIRED'; end if;
    actor_session:=(actor->>'sessionVersion')::bigint;
  end if;
  if (actor->'id'=to_jsonb(p_actor_id) and actor->>'role'='owner' and (not (actor ? 'active') or actor->'active'='true'::jsonb)
      and actor_session=p_actor_session_version
      and (not (actor ? 'passwordChangeRequired') or actor->'passwordChangeRequired'='false'::jsonb)) is not true then
    raise exception using errcode='P0O03',message='OUTCOME_OWNER_REQUIRED';
  end if;
  intent_digest:=public.runvara_outcome_hash(jsonb_build_array(p_workspace_id,p_actor_id,p_actor_session_version,p_publication_id,p_action,p_experiment_id,
    p_expected_workspace_revision,p_expected_measurement_revision,p_expected_measurement_digest,p_expected_head_version_id,p_expected_head_digest,p_withdrawal_reason));
  select v.* into receipt from public.runvara_business_outcome_versions v where v.workspace_id=p_workspace_id and v.publication_id=p_publication_id;
  if found then
    if receipt.intent_digest<>intent_digest then raise exception using errcode='P0O06',message='OUTCOME_PUBLICATION_ID_CONFLICT'; end if;
    return public.runvara_outcome_receipt(receipt,true,exists(select 1 from public.runvara_business_outcome_heads h where h.workspace_id=p_workspace_id and h.outcome_id=receipt.outcome_id and h.version_id=receipt.version_id));
  end if;
  if state_value->>'_revision' is distinct from p_expected_workspace_revision then raise exception using errcode='P0O04',message='OUTCOME_WORKSPACE_CONFLICT'; end if;
  perform public.runvara_outcome_scope(state_value->'revenueEngine',p_workspace_id);
  if jsonb_typeof(state_value#>'{revenueEngine,experiments}') is distinct from 'array' then raise exception using errcode='P0O09',message='OUTCOME_TARGET_NOT_FOUND'; end if;
  if jsonb_array_length(state_value#>'{revenueEngine,experiments}')>500 or octet_length((state_value#>'{revenueEngine,experiments}')::text)>4194304 then raise exception using errcode='P0O10',message='OUTCOME_EXPERIMENTS_TOO_LARGE'; end if;
  if (select count(*) from jsonb_array_elements(state_value#>'{revenueEngine,experiments}') e where e->>'id'=p_experiment_id)<>1 then
    raise exception using errcode='P0O09',message='OUTCOME_TARGET_NOT_FOUND';
  end if;
  select e.value,(e.ordinality-1)::integer into experiment,experiment_index from jsonb_array_elements(state_value#>'{revenueEngine,experiments}') with ordinality e where e.value->>'id'=p_experiment_id;
  perform public.runvara_outcome_scope(experiment,p_workspace_id);
  if experiment->'id' is distinct from to_jsonb(p_experiment_id) then raise exception using errcode='P0O09',message='OUTCOME_TARGET_NOT_FOUND'; end if;
  outcome_id:='outcome_'||public.runvara_outcome_hash(jsonb_build_array(p_workspace_id,'experiment_measurement',p_experiment_id,'incrementalContribution'));
  select h.* into head from public.runvara_business_outcome_heads h where h.workspace_id=p_workspace_id and h.outcome_id=publication.outcome_id;
  if head.version_id is not null then
    select v.* into previous from public.runvara_business_outcome_versions v where v.workspace_id=p_workspace_id and v.version_id=head.version_id;
    if p_action='publish' or head.version_id is distinct from p_expected_head_version_id or previous.digest is distinct from p_expected_head_digest then
      raise exception using errcode='P0O05',message='OUTCOME_HEAD_CONFLICT';
    end if;
    if previous.status='withdrawn' then raise exception using errcode='P0O08',message='OUTCOME_WITHDRAWAL_FINAL'; end if;
  elsif p_action<>'publish' then raise exception using errcode='P0O05',message='OUTCOME_HEAD_CONFLICT';
  end if;
  source:=case when p_action='withdraw' then previous.source_measurement else experiment->'outcomeMeasurement' end;
  if (source->>'revision') is distinct from p_expected_measurement_revision::text or source->>'digest' is distinct from p_expected_measurement_digest then
    raise exception using errcode='P0O07',message='OUTCOME_MEASUREMENT_CHANGED';
  end if;
  record:=public.runvara_outcome_validate_measurement(source,p_workspace_id,p_experiment_id,committed_at);
  if p_action='correct' and ((source->>'revision')::bigint<=(previous.payload#>>'{source,measurementRevision}')::bigint
      or source->>'digest'=previous.payload#>>'{source,measurementDigest}') then raise exception using errcode='P0O07',message='OUTCOME_MEASUREMENT_CHANGED'; end if;
  if previous.committed_at>committed_at then raise exception using errcode='P0O01',message='OUTCOME_CLOCK_INVALID'; end if;
  if previous.revision=9007199254740991 then raise exception using errcode='P0O01',message='OUTCOME_REVISION_EXHAUSTED'; end if;
  next_revision:=coalesce(previous.revision,0)+1;
  verification:=jsonb_build_object('kind','owner_attestation','actorId',p_actor_id,'verifiedAt',committed_text,'measurementDigest',source->>'digest');
  lineage:=jsonb_build_object('previousVersionId',previous.version_id,'previousDigest',previous.digest,'previousRevision',previous.revision,
    'reason',case when p_action='publish' then 'initial' when p_action='correct' then 'correction' else p_withdrawal_reason end);
  payload:=jsonb_build_object('schema','runvara-business-outcome/v1','workspaceId',p_workspace_id,'outcomeId',outcome_id,'revision',next_revision,
    'status',case when p_action='withdraw' then 'withdrawn' else 'recorded' end,'verification',verification,'lineage',lineage,
    'publicationAuthority',false,'sourceReferencesResolved',false,'runvaraAttribution','unestablished')||record;
  payload_digest:=public.runvara_outcome_hash(payload);
  version_id:='outcome_version_'||public.runvara_outcome_hash(jsonb_build_array(outcome_id,next_revision,payload_digest));
  payload:=payload||jsonb_build_object('digest',payload_digest,'versionId',version_id);
  if octet_length(payload::text)>16384 then raise exception using errcode='P0O10',message='OUTCOME_PAYLOAD_TOO_LARGE'; end if;
  commit_revision:=gen_random_uuid()::text;
  insert into public.runvara_business_outcome_versions(workspace_id,outcome_id,version_id,revision,digest,status,payload,source_measurement,publication_id,intent_digest,committed_at,commit_revision)
    values(p_workspace_id,outcome_id,version_id,next_revision,payload_digest,payload->>'status',payload,source,p_publication_id,intent_digest,committed_at,commit_revision) returning * into receipt;
  insert into public.runvara_business_outcome_heads(workspace_id,outcome_id,version_id) values(p_workspace_id,outcome_id,version_id)
    on conflict on constraint runvara_business_outcome_heads_pkey do update set version_id=excluded.version_id;
  result:=public.runvara_outcome_receipt(receipt,false,true);
  head_dto:=result#>'{publication,head}';
  experiment:=jsonb_set(jsonb_set(experiment,'{outcomeVerification}',verification,true),'{currentOutcome}',head_dto,true);
  state_value:=jsonb_set(jsonb_set(state_value,array['revenueEngine','experiments',experiment_index::text],experiment,false),'{_revision}',to_jsonb(commit_revision),true);
  -- Match the existing store's 2 MiB safety ceiling conservatively: JSONB text
  -- includes separator whitespace, so some near-boundary JSON.stringify states
  -- may be refused earlier, never committed above the existing limit.
  if octet_length(state_value::text)>2097152 then raise exception using errcode='P0O10',message='OUTCOME_WORKSPACE_TOO_LARGE'; end if;
  update public.saas_workspace_state s set state=state_value,updated_at=committed_at
    where s.workspace_id=p_workspace_id and s.state->>'_revision'=p_expected_workspace_revision;
  if not found then raise exception using errcode='P0O04',message='OUTCOME_WORKSPACE_CONFLICT'; end if;
  insert into public.audit_events(id,workspace_id,type,actor,detail,created_at) values(
    'outcome_audit_'||public.runvara_outcome_hash(jsonb_build_array(p_workspace_id,p_publication_id)),p_workspace_id,
    case when p_action='publish' then 'outcome-published' when p_action='correct' then 'outcome-corrected' else 'outcome-withdrawn' end,
    p_actor_id,jsonb_build_object('outcomeId',outcome_id,'versionId',version_id,'publicationId',p_publication_id),committed_at);
  return result;
end $$;

-- Explicit prepare/review read: one snapshot, one experiment, no workspace or
-- collection returned over the wire. SECURITY INVOKER retains existing SELECT
-- and RLS privileges; it grants no publication authority and takes no row locks.
-- Scope checks are intentionally inline: no private helper EXECUTE is exposed.
create function public.runvara_read_business_outcome_review(p_workspace_id text,p_experiment_id text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare state_value jsonb; experiment jsonb; current_value jsonb; result jsonb; outcome_key text;
  scoped jsonb; key text; marker jsonb; measurement jsonb; title jsonb; status jsonb;
begin
  if (p_workspace_id is not null and char_length(p_workspace_id) between 1 and 256 and p_workspace_id=btrim(p_workspace_id)
      and p_workspace_id !~ '[[:cntrl:]]' and p_experiment_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$') is not true then
    raise exception using errcode='P0O01',message='OUTCOME_INPUT_INVALID';
  end if;
  -- Equivalent to the fixed four-string canonical JS logical-identity array.
  -- No jsonb object rendering or numeric serialization participates in this hash.
  outcome_key:='outcome_'||encode(sha256(convert_to('['||to_jsonb(p_workspace_id)::text||',"experiment_measurement",'||to_jsonb(p_experiment_id)::text||',"incrementalContribution"]','UTF8')),'hex');
  select s.state,(select jsonb_build_object('workspace_id',h.workspace_id,'outcome_id',h.outcome_id,'version_id',h.version_id,
      'version',jsonb_build_object('workspace_id',v.workspace_id,'outcome_id',v.outcome_id,'revision',v.revision,'version_id',v.version_id,
        'digest',v.digest,'status',v.status,'payload',v.payload,'publication_id',v.publication_id,'intent_digest',v.intent_digest,
        'committed_at',v.committed_at,'commit_revision',v.commit_revision))
    from public.runvara_business_outcome_heads h join public.runvara_business_outcome_versions v
      on (v.workspace_id,v.outcome_id,v.version_id)=(h.workspace_id,h.outcome_id,h.version_id)
    where h.workspace_id=p_workspace_id and h.outcome_id=outcome_key)
    into state_value,current_value from public.saas_workspace_state s where s.workspace_id=p_workspace_id;
  if not found then raise exception using errcode='P0O09',message='OUTCOME_TARGET_NOT_FOUND'; end if;
  if jsonb_typeof(state_value#>'{revenueEngine,experiments}') is distinct from 'array' then raise exception using errcode='P0O09',message='OUTCOME_TARGET_NOT_FOUND'; end if;
  if jsonb_array_length(state_value#>'{revenueEngine,experiments}')>500 or octet_length((state_value#>'{revenueEngine,experiments}')::text)>4194304 then
    raise exception using errcode='P0O10',message='OUTCOME_EXPERIMENTS_TOO_LARGE';
  end if;
  if (select count(*) from jsonb_array_elements(state_value#>'{revenueEngine,experiments}') e where e->>'id'=p_experiment_id)<>1 then
    raise exception using errcode='P0O09',message='OUTCOME_TARGET_NOT_FOUND';
  end if;
  select e into experiment from jsonb_array_elements(state_value#>'{revenueEngine,experiments}') e where e->>'id'=p_experiment_id;
  foreach scoped in array array[state_value,state_value->'workspace',state_value->'revenueEngine',experiment] loop
    if jsonb_typeof(scoped) is distinct from 'object' then raise exception using errcode='P0O01',message='OUTCOME_SCOPE_INVALID'; end if;
    foreach key in array array['workspaceId','workspace_id','tenantId','tenant_id'] loop
      if scoped ? key and scoped->key is distinct from to_jsonb(p_workspace_id) then raise exception using errcode='P0O01',message='OUTCOME_SCOPE_INVALID'; end if;
    end loop;
    foreach key in array array['workspace','tenant'] loop
      if scoped ? key then
        marker:=scoped->key;
        if jsonb_typeof(marker)='object' then marker:=marker->'id'; end if;
        if marker is distinct from to_jsonb(p_workspace_id) then raise exception using errcode='P0O01',message='OUTCOME_SCOPE_INVALID'; end if;
      end if;
    end loop;
  end loop;
  if experiment->'id' is distinct from to_jsonb(p_experiment_id) or state_value#>'{workspace,id}' is distinct from to_jsonb(p_workspace_id)
      or jsonb_typeof(state_value->'_revision') is distinct from 'string' or (state_value->>'_revision' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$') is not true then
    raise exception using errcode='P0O01',message='OUTCOME_SCOPE_INVALID';
  end if;
  title:=coalesce(experiment->'title','null'::jsonb); status:=coalesce(experiment->'status','null'::jsonb);
  if title<>'null'::jsonb and (jsonb_typeof(title)='string' and char_length(title#>>'{}')+char_length(regexp_replace(title#>>'{}',U&'[^\+010000-\+10FFFF]','','g'))<=180 and (title#>>'{}') !~ '[[:cntrl:]]') is not true then
    raise exception using errcode='P0O01',message='OUTCOME_EXPERIMENT_INVALID';
  end if;
  if status<>'null'::jsonb and (jsonb_typeof(status)='string' and char_length(status#>>'{}')<=40 and (status#>>'{}') !~ '[[:cntrl:]]') is not true then
    raise exception using errcode='P0O01',message='OUTCOME_EXPERIMENT_INVALID';
  end if;
  measurement:=coalesce(experiment->'outcomeMeasurement','null'::jsonb);
  if measurement<>'null'::jsonb and jsonb_typeof(measurement) is distinct from 'object' then raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID'; end if;
  if octet_length(measurement::text)>12288 then raise exception using errcode='P0O10',message='OUTCOME_PAYLOAD_TOO_LARGE'; end if;
  result:=jsonb_build_object('workspaceId',p_workspace_id,'workspaceRevision',state_value->'_revision',
    'experiment',jsonb_build_object('id',p_experiment_id,'title',title,'status',status),'measurement',measurement,'current',current_value);
  if octet_length(result::text)>131072 then raise exception using errcode='P0O10',message='OUTCOME_RESPONSE_TOO_LARGE'; end if;
  return result;
end $$;
revoke all on function public.runvara_read_business_outcome_review(text,text) from public,anon,authenticated,service_role;
grant execute on function public.runvara_read_business_outcome_review(text,text) to service_role;
comment on function public.runvara_read_business_outcome_review(text,text) is 'Service-only stable invoker review read. Existing SELECT privileges, one statement snapshot, bounded 128 KiB response, no row locks or writes; API authenticates owner/admin and validates source/current pair. This additional scoped EXECUTE grant requires owner approval.';

-- Defense in depth: immutable versions also reject privileged accidental edits.
-- Database administrators can still remove a trigger; this is not a claim of
-- tamper-resistance against the migration owner.
create function public.runvara_guard_business_outcome_version()
returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception using errcode='P0O11',message='OUTCOME_VERSION_IMMUTABLE'; end $$;
create trigger runvara_business_outcome_version_immutable before update or delete on public.runvara_business_outcome_versions
for each row execute function public.runvara_guard_business_outcome_version();
create trigger runvara_business_outcome_version_no_truncate before truncate on public.runvara_business_outcome_versions
for each statement execute function public.runvara_guard_business_outcome_version();

revoke all on function public.runvara_outcome_canonical(jsonb,integer),public.runvara_outcome_hash(jsonb),public.runvara_outcome_exact(jsonb,text[]),
  public.runvara_outcome_timestamp(jsonb),public.runvara_outcome_scope(jsonb,text),public.runvara_outcome_safe_integer(jsonb,bigint,bigint),public.runvara_outcome_validate_measurement(jsonb,text,text,timestamptz),
  public.runvara_outcome_receipt(public.runvara_business_outcome_versions,boolean,boolean),public.runvara_guard_business_outcome_version()
  from public,anon,authenticated,service_role;
revoke all on function public.runvara_publish_business_outcome(text,text,bigint,text,text,text,text,bigint,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.runvara_publish_business_outcome(text,text,bigint,text,text,text,text,bigint,text,text,text,text) to service_role;
comment on table public.runvara_business_outcome_versions is 'Immutable owner-published outcomes and source evidence; generic history and legacy verification never qualify.';
comment on table public.runvara_business_outcome_heads is 'Authoritative current outcome selection. Read tenant-filtered head plus FK version in one statement snapshot; never infer current from archived versions.';
comment on function public.runvara_publish_business_outcome(text,text,bigint,text,text,text,text,bigint,text,text,text,text) is 'Server-only owner/session/CAS/source/head-checked publication. One atomic receipt, immutable version, head, targeted workspace patch and fixed-shape audit event. Owner approval required before applying this privileged RPC.';
commit;
