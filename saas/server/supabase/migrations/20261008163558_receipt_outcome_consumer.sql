-- PREPARED ONLY. Install only with compatible v4 readers. Real SQL/EXECUTE grant
-- installation remains separately held. Reader readiness does not activate capture.
-- No ledger grant, new column, backfill, quota change, or source-action grammar change.
begin;

create function public.runvara_outcome_validate_receipt_reference(p_reference jsonb,p_workspace_id text)
returns void language plpgsql immutable security invoker set search_path='' as $$
begin
  if not public.runvara_outcome_exact(p_reference,array['schema','workspaceId','attemptId','receiptDigest','sourceDigest','commitRevision'])
    or (p_reference->>'schema'='runvara-protected-content-source/v1'
      and jsonb_typeof(p_reference->'workspaceId')='string' and p_reference->>'workspaceId'=p_workspace_id
      and char_length(p_workspace_id) between 1 and 256
      and char_length(p_workspace_id)+char_length(regexp_replace(p_workspace_id,U&'[^\+010000-\+10FFFF]','','g'))<=256
      and p_workspace_id=btrim(p_workspace_id,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') and p_workspace_id !~ '[[:cntrl:]]'
      and jsonb_typeof(p_reference->'attemptId')='string' and p_reference->>'attemptId' ~ '^content_attempt_[0-9a-f]{64}$'
      and jsonb_typeof(p_reference->'receiptDigest')='string' and p_reference->>'receiptDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(p_reference->'sourceDigest')='string' and p_reference->>'sourceDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(p_reference->'commitRevision')='string' and p_reference->>'commitRevision' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') is not true then
    raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID';
  end if;
  if octet_length(p_reference::text)>2048 or octet_length(public.runvara_outcome_canonical(p_reference))>2048 then
    raise exception using errcode='P0O10',message='OUTCOME_RECEIPT_SOURCE_TOO_LARGE'; end if;
end $$;

create function public.runvara_outcome_validate_receipt_selector(p_selector jsonb)
returns void language plpgsql immutable security invoker set search_path='' as $$
begin
  if not public.runvara_outcome_exact(p_selector,array['attemptId','receiptDigest','sourceDigest'])
    or (jsonb_typeof(p_selector->'attemptId')='string' and p_selector->>'attemptId' ~ '^content_attempt_[0-9a-f]{64}$'
      and jsonb_typeof(p_selector->'receiptDigest')='string' and p_selector->>'receiptDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(p_selector->'sourceDigest')='string' and p_selector->>'sourceDigest' ~ '^[0-9a-f]{64}$') is not true then
    raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
  if octet_length(public.runvara_outcome_canonical(p_selector))>512 then
    raise exception using errcode='P0O10',message='OUTCOME_RECEIPT_SOURCE_TOO_LARGE'; end if;
end $$;

-- Validate only immutable admission, receipt and row identities. This helper
-- deliberately never resolves current actions, approvals, connections or goals.
create function public.runvara_outcome_validate_content_rows(p_admission public.runvara_content_admissions,p_receipt public.runvara_content_receipts,p_workspace_id text)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb:=p_admission.admission; r jsonb:=p_receipt.receipt; s jsonb:=r->'source'; c jsonb:=s->'context'; result jsonb;
begin
  perform public.runvara_content_validate_admission(a,p_workspace_id);
  perform public.runvara_outcome_validate_source_action(s,p_workspace_id);
  if (p_admission.workspace_id=p_workspace_id and p_receipt.workspace_id=p_workspace_id
    and p_admission.attempt_id=p_receipt.attempt_id and a->>'attemptId'=p_admission.attempt_id
    and a->>'writeId'=p_admission.write_id
    and p_receipt.commit_revision ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and r=public.runvara_content_make_receipt(a,s)
    and public.runvara_content_source_intent(s)=a->>'intentDigest'
    and c->'workspaceId'=a->'workspaceId' and c->'writeId'=a->'writeId' and c->'requestId'=a->'requestId'
    and c->'claimId'=a->'claimId' and c->'claimIdentity'=a->'claimIdentity' and c->'executedBy'=a->'actorId'
    and c->'phase'=a->'phase' and c->'dispatchRequestDigest'=a->'dispatchRequestDigest'
    and (c->>'origin'<>'owner_objective_content' or c#>'{proposal,source,actorSessionVersion}'=a->'actorSessionVersion')
    and public.runvara_outcome_timestamp(c->'completedAt')>=public.runvara_outcome_timestamp(a->'admittedAt')) is not true then
    raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
  result:=jsonb_build_object('schema','runvara-outcome-content-source-private/v1','admission',a,'receipt',r,'commitRevision',p_receipt.commit_revision);
  if octet_length(result::text)>43008 then raise exception using errcode='P0O10',message='OUTCOME_RECEIPT_SOURCE_TOO_LARGE'; end if;
  return result;
exception when sqlstate 'P0R01' or sqlstate 'P0O01' then
  raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID';
end $$;

create function public.runvara_outcome_content_reference(p_evidence jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('schema','runvara-protected-content-source/v1','workspaceId',p_evidence#>'{receipt,workspaceId}',
    'attemptId',p_evidence#>'{receipt,attemptId}','receiptDigest',p_evidence#>'{receipt,digest}',
    'sourceDigest',p_evidence#>'{receipt,source,digest}','commitRevision',p_evidence->'commitRevision');
$$;

create function public.runvara_outcome_content_evidence(p_workspace_id text,p_selector jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare a public.runvara_content_admissions; r public.runvara_content_receipts; evidence jsonb;
begin
  perform public.runvara_outcome_validate_receipt_selector(p_selector);
  select x.* into a from public.runvara_content_admissions x where x.workspace_id=p_workspace_id and x.attempt_id=p_selector->>'attemptId';
  if not found then raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
  select x.* into r from public.runvara_content_receipts x where x.workspace_id=p_workspace_id and x.attempt_id=p_selector->>'attemptId';
  if not found then raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
  evidence:=public.runvara_outcome_validate_content_rows(a,r,p_workspace_id);
  if (r.receipt->'digest'=p_selector->'receiptDigest' and r.receipt#>'{source,digest}'=p_selector->'sourceDigest') is not true then
    raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
  return evidence;
end $$;

create or replace function public.runvara_outcome_validate_measurement(p_measurement jsonb,p_workspace_id text,p_experiment_id text,p_now timestamptz)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare m jsonb:=p_measurement; report jsonb; facts jsonb; scope_id text; observation_id text; report_id text;
  started timestamptz; ended timestamptz; observed timestamptz; recorded timestamptz; amount text; linked boolean:=m->>'schema' in ('runvara-experiment-measurement/v2','runvara-experiment-measurement/v3','runvara-experiment-measurement/v4'); protected boolean:=m->>'schema'='runvara-experiment-measurement/v4'; objective boolean:=m->>'schema'='runvara-experiment-measurement/v3' or (m->>'schema'='runvara-experiment-measurement/v4' and m#>>'{intervention,schema}'='runvara-owner-action-association/v2');
begin
  if not public.runvara_outcome_exact(m,array['schema','workspaceId','experimentId','revision','recordedBy','recordedAt','metric','amount','currency','window','coverage','method','provenance','links','report','digest']||case when linked then array['intervention'] else array[]::text[] end||case when protected then array['receiptSource'] else array[]::text[] end) then
    raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID';
  end if;
  if octet_length(public.runvara_outcome_canonical(m))>8192 or octet_length(m::text)>12288 then
    raise exception using errcode='P0O10',message='OUTCOME_PAYLOAD_TOO_LARGE';
  end if;
  if (jsonb_typeof(m->'workspaceId')='string' and jsonb_typeof(m->'experimentId')='string' and jsonb_typeof(m->'digest')='string'
      and m->>'schema' in ('runvara-experiment-measurement/v1','runvara-experiment-measurement/v2','runvara-experiment-measurement/v3','runvara-experiment-measurement/v4') and m->>'workspaceId'=p_workspace_id and m->>'experimentId'=p_experiment_id
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
  if linked then
    perform public.runvara_outcome_validate_intervention(m->'intervention',p_workspace_id);
    if protected then
      perform public.runvara_outcome_validate_receipt_reference(m->'receiptSource',p_workspace_id);
      if m#>'{receiptSource,sourceDigest}' is distinct from m#>'{intervention,action,digest}' then raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
    end if;
    if m#>>'{intervention,schema}' is distinct from (case when objective then 'runvara-owner-action-association/v2' else 'runvara-owner-action-association/v1' end) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
    if public.runvara_outcome_timestamp(m#>'{intervention,completedAt}')>recorded or m->'links' is distinct from jsonb_build_object('action',m#>'{intervention,action}','approval',m#>'{intervention,approval}','objective',null,'opportunity',null) then
      raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
    end if;
  elsif m->'links' is distinct from '{"action":null,"opportunity":null,"approval":null,"objective":null}'::jsonb then
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
  if linked then facts:=facts||jsonb_build_object('intervention',m->'intervention'); end if;
  if protected then facts:=facts||jsonb_build_object('receiptSource',m->'receiptSource'); end if;
  if (jsonb_typeof(report->'workspaceId')='string' and jsonb_typeof(report->'experimentId')='string' and jsonb_typeof(report->'digest')='string'
      and report->>'schema'=case when protected then 'runvara-measurement-report/v4' when objective then 'runvara-measurement-report/v3' when linked then 'runvara-measurement-report/v2' else 'runvara-measurement-report/v1' end and report->>'id'=report_id and report->>'workspaceId'=p_workspace_id
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

create or replace function public.runvara_publish_business_outcome(
  p_workspace_id text,p_actor_id text,p_actor_session_version bigint,p_publication_id text,p_action text,
  p_experiment_id text,p_expected_workspace_revision text,p_expected_measurement_revision bigint,
  p_expected_measurement_digest text,p_expected_head_version_id text,p_expected_head_digest text,p_withdrawal_reason text
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
<<publication>>
declare state_value jsonb; experiment jsonb; experiment_index integer; actor jsonb; actor_session bigint; source jsonb; record jsonb; action_source jsonb; association jsonb; reused public.runvara_business_outcome_versions;
  head public.runvara_business_outcome_heads; previous public.runvara_business_outcome_versions; receipt public.runvara_business_outcome_versions;
  intent_digest text; outcome_id text; payload jsonb; payload_digest text; version_id text; next_revision bigint;
  committed_at timestamptz; committed_text text; commit_revision text; verification jsonb; lineage jsonb; head_dto jsonb; result jsonb; protected_evidence jsonb;
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
  if p_action='withdraw' then
    -- Withdrawal is independent of mutable action/approval/connection/policy rows.
    action_source:=previous.source_action;
  elsif source->>'schema' in ('runvara-experiment-measurement/v2','runvara-experiment-measurement/v3','runvara-experiment-measurement/v4') then
    association:=source->'intervention';
    if association->'reuseVersionId'<>'null'::jsonb then
      if p_action<>'correct' then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
      select v.* into reused from public.runvara_business_outcome_versions v
        where v.workspace_id=p_workspace_id and v.outcome_id=publication.outcome_id and v.version_id=association->>'reuseVersionId';
      if not found or reused.source_action is null then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
      -- A protected version cannot lose or substitute its provenance during reuse.
      if source->>'schema'='runvara-experiment-measurement/v4' then
        if reused.source_measurement->>'schema' is distinct from 'runvara-experiment-measurement/v4'
          or source->'receiptSource' is distinct from reused.source_measurement->'receiptSource' then
          raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
      elsif reused.source_measurement->>'schema'='runvara-experiment-measurement/v4' then
        raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID';
      end if;
      action_source:=reused.source_action;
    elsif source->>'schema'='runvara-experiment-measurement/v4' then
      -- The exact publication replay above precedes this fresh ledger lookup.
      -- Historical source authority comes solely from the immutable completion.
      protected_evidence:=public.runvara_outcome_content_evidence(p_workspace_id,
        (source->'receiptSource')-array['schema','workspaceId','commitRevision']);
      if public.runvara_outcome_content_reference(protected_evidence) is distinct from source->'receiptSource' then
        raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
      action_source:=protected_evidence#>'{receipt,source}';
    else
      action_source:=public.runvara_outcome_resolve_action(state_value,p_workspace_id,association#>>'{action,id}');
    end if;
  end if;
  if source->>'schema' in ('runvara-experiment-measurement/v2','runvara-experiment-measurement/v3','runvara-experiment-measurement/v4') then
    perform public.runvara_outcome_validate_source_action(action_source,p_workspace_id);
    association:=source->'intervention';
    if (association->>'schema'='runvara-owner-action-association/v2' and
        (action_source->>'schema'='runvara-reviewed-source-action/v2' and association->'origin'=action_source#>'{context,origin}'
          and association->'originatingObjective'=action_source#>'{context,originatingObjective}') is not true)
      or (association->>'schema'='runvara-owner-action-association/v1' and action_source->>'schema' is distinct from 'runvara-reviewed-source-action/v1') then
      raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
    end if;
    if (association->'action'=jsonb_build_object('workspaceId',p_workspace_id,'id',action_source#>'{context,writeId}','revision',1,'digest',action_source->'digest')
        and association->'approval'=jsonb_build_object('workspaceId',p_workspace_id,'id',action_source#>'{context,approval,id}','revision',action_source#>'{context,approval,revision}','digest',action_source#>'{context,approval,digest}')
        and association->'account'=action_source#>'{context,account}' and association->'productId'=action_source#>'{input,productId}'
        and association->'completedAt'=action_source#>'{context,completedAt}') is not true then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  elsif action_source is not null then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
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
  insert into public.runvara_business_outcome_versions(workspace_id,outcome_id,version_id,revision,digest,status,payload,source_measurement,source_action,publication_id,intent_digest,committed_at,commit_revision)
    values(p_workspace_id,outcome_id,version_id,next_revision,payload_digest,payload->>'status',payload,source,action_source,p_publication_id,intent_digest,committed_at,commit_revision) returning * into receipt;
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


-- Match the unchanged action association to a independently grounded immutable
-- source. This is shape/binding validation, never a publication qualification.
create function public.runvara_outcome_validate_receipt_association(p_measurement jsonb,p_source jsonb,p_workspace_id text)
returns void language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb:=p_measurement->'intervention'; c jsonb:=p_source->'context'; expected jsonb;
begin
  perform public.runvara_outcome_validate_source_action(p_source,p_workspace_id);
  perform public.runvara_outcome_validate_intervention(a,p_workspace_id);
  perform public.runvara_outcome_validate_receipt_reference(p_measurement->'receiptSource',p_workspace_id);
  expected:=jsonb_build_object('schema',case when p_source->>'schema'='runvara-reviewed-source-action/v2' then 'runvara-owner-action-association/v2' else 'runvara-owner-action-association/v1' end,
    'relationship','owner_associated_recorded_action','comparison','not_established',
    'action',jsonb_build_object('workspaceId',p_workspace_id,'id',c->'writeId','revision',1,'digest',p_source->'digest'),
    'approval',jsonb_build_object('workspaceId',p_workspace_id,'id',c#>'{approval,id}','revision',c#>'{approval,revision}','digest',c#>'{approval,digest}'),
    'account',c->'account','productId',p_source#>'{input,productId}','completedAt',c->'completedAt','reuseVersionId',a->'reuseVersionId');
  if p_source->>'schema'='runvara-reviewed-source-action/v2' then
    expected:=expected||jsonb_build_object('origin',c->'origin','originatingObjective',c->'originatingObjective'); end if;
  if a is distinct from expected or p_measurement#>'{receiptSource,sourceDigest}' is distinct from p_source->'digest'
    or p_measurement->'receiptSource' is distinct from p_measurement#>'{report,facts,receiptSource}' then
    raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
end $$;

-- One authenticated, bounded service-only read. The legacy review remains an
-- invoker function; no direct SELECT privilege is added on protected tables.
create function public.runvara_read_outcome_content_sources(p_workspace_id text,p_experiment_id text,
  p_actor_id text,p_actor_session_version bigint,p_receipt_selector jsonb default null,p_after_attempt_id text default null,p_resolve_saved_source boolean default true)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare state_value jsonb; actor jsonb; actor_session bigint; review jsonb; measurement jsonb; selected jsonb; selector jsonb:=p_receipt_selector;
  item record; evidence jsonb; source jsonb; candidate jsonb; choices jsonb:='[]'::jsonb; result jsonb; reference jsonb;
  more boolean:=false; cursor_value text; expected_reference jsonb; saved_evidence jsonb; reused public.runvara_business_outcome_versions; outcome_key text;
begin
  if (p_workspace_id is not null and char_length(p_workspace_id) between 1 and 256 and p_workspace_id=btrim(p_workspace_id)
    and p_workspace_id !~ '[[:cntrl:]]' and p_experiment_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
    and p_actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and p_actor_session_version between 1 and 9007199254740991
    and (p_after_attempt_id is null or p_after_attempt_id ~ '^content_attempt_[0-9a-f]{64}$')
    and (p_receipt_selector is null or p_after_attempt_id is null) and p_resolve_saved_source is not null) is not true then
    raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
  if selector is not null then perform public.runvara_outcome_validate_receipt_selector(selector); end if;
  select s.state into state_value from public.saas_workspace_state s where s.workspace_id=p_workspace_id;
  if not found then raise exception using errcode='P0O09',message='OUTCOME_TARGET_NOT_FOUND'; end if;
  perform public.runvara_outcome_scope(state_value,p_workspace_id);
  perform public.runvara_outcome_scope(state_value->'workspace',p_workspace_id);
  if state_value#>'{workspace,id}' is distinct from to_jsonb(p_workspace_id) or jsonb_typeof(state_value->'users') is distinct from 'array' then
    raise exception using errcode='P0O03',message='OUTCOME_REVIEWER_REQUIRED'; end if;
  if jsonb_array_length(state_value->'users')>500 or octet_length((state_value->'users')::text)>262144 then
    raise exception using errcode='P0O10',message='OUTCOME_AUTHORITY_TOO_LARGE'; end if;
  if (select count(*) from jsonb_array_elements(state_value->'users') u where u->>'id'=p_actor_id)<>1 then
    raise exception using errcode='P0O03',message='OUTCOME_REVIEWER_REQUIRED'; end if;
  select u into actor from jsonb_array_elements(state_value->'users') u where u->>'id'=p_actor_id;
  perform public.runvara_outcome_scope(actor,p_workspace_id);
  if not (actor ? 'sessionVersion') then actor_session:=1;
  else
    if not public.runvara_outcome_safe_integer(actor->'sessionVersion',1,9007199254740991) then raise exception using errcode='P0O03',message='OUTCOME_REVIEWER_REQUIRED'; end if;
    actor_session:=(actor->>'sessionVersion')::bigint;
  end if;
  if (actor->'id'=to_jsonb(p_actor_id) and actor->>'role' in ('owner','admin') and (not (actor ? 'active') or actor->'active'='true'::jsonb)
    and actor_session=p_actor_session_version and (not (actor ? 'passwordChangeRequired') or actor->'passwordChangeRequired'='false'::jsonb)) is not true then
    raise exception using errcode='P0O03',message='OUTCOME_REVIEWER_REQUIRED'; end if;
  review:=public.runvara_read_business_outcome_review(p_workspace_id,p_experiment_id);
  -- Explicit draft replacement/reuse/detachment compatibility never needs the
  -- old draft's source. Omit it entirely instead of exposing unproved provenance.
  if not p_resolve_saved_source then review:=jsonb_set(review,'{measurement}','null'::jsonb); end if;
  measurement:=review->'measurement';
  if measurement->>'schema'='runvara-experiment-measurement/v4' then
    perform public.runvara_outcome_validate_receipt_reference(measurement->'receiptSource',p_workspace_id);
    if measurement#>'{receiptSource,sourceDigest}' is distinct from measurement#>'{intervention,action,digest}'
      or measurement->'receiptSource' is distinct from measurement#>'{report,facts,receiptSource}' then
      raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
    if measurement#>'{intervention,reuseVersionId}'='null'::jsonb then
      expected_reference:=measurement->'receiptSource';
      saved_evidence:=public.runvara_outcome_content_evidence(p_workspace_id,expected_reference-array['schema','workspaceId','commitRevision']);
      if expected_reference is distinct from public.runvara_outcome_content_reference(saved_evidence) then
        raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
      perform public.runvara_outcome_validate_receipt_association(measurement,saved_evidence#>'{receipt,source}',p_workspace_id);
      if selector is null and p_after_attempt_id is null then selected:=saved_evidence; end if;
    else
      -- A saved draft's claim of protected reuse is not proof. Resolve its exact
      -- same-outcome immutable version within this one read, without the ledger.
      perform public.runvara_outcome_validate_intervention(measurement->'intervention',p_workspace_id);
      outcome_key:='outcome_'||public.runvara_outcome_hash(jsonb_build_array(p_workspace_id,'experiment_measurement',p_experiment_id,'incrementalContribution'));
      select v.* into reused from public.runvara_business_outcome_versions v where v.workspace_id=p_workspace_id
        and v.outcome_id=outcome_key and v.version_id=measurement#>>'{intervention,reuseVersionId}';
      if not found or reused.source_action is null or reused.source_measurement->>'schema' is distinct from 'runvara-experiment-measurement/v4'
        or reused.source_measurement->'receiptSource' is distinct from measurement->'receiptSource'
        or (reused.source_measurement->'intervention')-'reuseVersionId' is distinct from (measurement->'intervention')-'reuseVersionId' then
        raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
      perform public.runvara_outcome_validate_measurement(reused.source_measurement,p_workspace_id,p_experiment_id,now());
      perform public.runvara_outcome_validate_receipt_association(measurement,reused.source_action,p_workspace_id);
      if reused.source_action->'digest' is distinct from measurement#>'{receiptSource,sourceDigest}' then
        raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
    end if;
  end if;
  if selector is not null then
    selected:=public.runvara_outcome_content_evidence(p_workspace_id,selector);
  end if;
  -- Draft compatibility does not consume any candidate ledger history. It may
  -- resolve only an explicitly selected protected receipt above.
  if p_resolve_saved_source then
  -- Defensive finite scan independent of mutable history and the paging cursor.
  if (select count(*) from (select 1 from public.runvara_content_admissions a where a.workspace_id=p_workspace_id limit 257) bounded)>256 then
    raise exception using errcode='P0O10',message='OUTCOME_RECEIPT_SOURCE_TOO_LARGE'; end if;
  for item in select a admission_row,r receipt_row from public.runvara_content_admissions a join public.runvara_content_receipts r
      on (r.workspace_id,r.attempt_id)=(a.workspace_id,a.attempt_id)
      where a.workspace_id=p_workspace_id and (p_after_attempt_id is null or a.attempt_id collate "C">p_after_attempt_id collate "C")
      order by a.attempt_id collate "C" limit 257 loop
    evidence:=public.runvara_outcome_validate_content_rows(item.admission_row,item.receipt_row,p_workspace_id);
    source:=evidence#>'{receipt,source}'; reference:=public.runvara_outcome_content_reference(evidence);
    perform public.runvara_outcome_validate_receipt_reference(reference,p_workspace_id);
    candidate:=jsonb_build_object('receiptSource',reference,'actionId',source#>'{context,writeId}',
      'account',source#>'{context,account}','productId',source#>'{input,productId}','title',source#>'{input,title}',
      'completedAt',source#>'{context,completedAt}','origin',source#>'{context,origin}','originatingObjective',source#>'{context,originatingObjective}');
    if jsonb_array_length(choices)>=20 or octet_length((choices||jsonb_build_array(candidate))::text)>16384 then
      if choices='[]'::jsonb then raise exception using errcode='P0O10',message='OUTCOME_RECEIPT_SOURCE_TOO_LARGE'; end if;
      more:=true; exit;
    end if;
    choices:=choices||jsonb_build_array(candidate); cursor_value:=reference->>'attemptId';
  end loop;
  end if;
  result:=jsonb_build_object('schema','runvara-outcome-content-source-reader/v1','review',review,'receiptChoices',choices,
    'nextCursor',case when more then cursor_value else null end,'hasMore',more,'selectedEvidence',selected);
  if octet_length(result::text)>131072 then raise exception using errcode='P0O10',message='OUTCOME_RESPONSE_TOO_LARGE'; end if;
  return result;
end $$;

revoke all on function public.runvara_outcome_validate_receipt_reference(jsonb,text),
  public.runvara_outcome_validate_receipt_selector(jsonb),public.runvara_outcome_validate_receipt_association(jsonb,jsonb,text),
  public.runvara_outcome_validate_content_rows(public.runvara_content_admissions,public.runvara_content_receipts,text),
  public.runvara_outcome_content_reference(jsonb),public.runvara_outcome_content_evidence(text,jsonb),
  public.runvara_read_outcome_content_sources(text,text,text,bigint,jsonb,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.runvara_read_outcome_content_sources(text,text,text,bigint,jsonb,text,boolean) to service_role;

commit;
