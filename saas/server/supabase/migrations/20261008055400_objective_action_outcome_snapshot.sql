-- Prepared only: reader-first objective-content association union.
-- Install only after compatible readers/executors. No historical edits, backfill,
-- execution-time receipt, provider truth, goal progress or causal authority.
-- Existing nullable destination, RPC signatures, owners, ACLs, RLS and triggers
-- remain unchanged. All new implementation helpers have closed EXECUTE ACLs.
begin;


create or replace function public.runvara_outcome_action_identity_digest(p_source jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare c jsonb:=p_source->'context'; p jsonb:=c->'proposal'; proposal_text text; policies_text text; identity_text text; source_text text; field text;
begin
  if p<>'null'::jsonb then
    select '['||coalesce(string_agg('{"objectiveId":'||(value->'objectiveId')::text||',"revision":'||public.runvara_outcome_canonical(value->'revision')||',"digest":'||(value->'digest')::text||'}',',' order by ordinality),'')||']'
      into policies_text from jsonb_array_elements(p->'policies') with ordinality;
    proposal_text:='{"schema":'||(p->'schema')::text||',"workspaceId":'||(p->'workspaceId')::text||',"origin":'||(p->'origin')::text
      ||',"writeId":'||(p->'writeId')::text||',"provider":'||(p->'provider')::text||',"operation":'||(p->'operation')::text
      ||',"inputDigest":'||(p->'inputDigest')::text||',"connectionId":'||(p->'connectionId')::text||',"account":'||(p->'account')::text
      ||',"requestedBy":'||(p->'requestedBy')::text||',"approvalKind":'||(p->'approvalKind')::text||',"policies":'||policies_text
      ||',"evidenceQualification":'||(p->'evidenceQualification')::text;
    if p->>'schema'='runvara-objective-dispatch-proposal/v2' then
      source_text:='';
      foreach field in array array['schema','objectiveId','objectiveRevision','objectiveDigest','jobId','jobIdentityDigest','reportId','payloadDigest','resultDigest','actorId','actorSessionVersion','inputFingerprint','opportunityId','opportunityDigest','productId','productDigest','approvalSourceDigest'] loop
        source_text:=source_text||case when source_text='' then '' else ',' end||to_jsonb(field)::text||':'||public.runvara_outcome_canonical(p#>array['source',field]);
      end loop;
      proposal_text:=proposal_text||',"source":{'||source_text||'},"approvalId":'||(p->'approvalId')::text||',"approvalDigest":'||(p->'approvalDigest')::text;
    end if;
    proposal_text:=proposal_text||',"digest":'||(p->'digest')::text||'}';
  end if;
  identity_text:='{"id":'||(c->'writeId')::text||',"requestId":'||(c->'requestId')::text||',"provider":'||(c->'provider')::text
    ||',"input":'||public.runvara_outcome_action_input_text(p_source->'input')||',"digest":'||(c->'inputDigest')::text
    ||',"connectionId":'||(c->'connectionId')::text||',"account":'||(c->'account')::text||',"requestedBy":'||(c->'requestedBy')::text
    ||',"requiresApproval":true,"approvalId":'||(c#>'{approval,id}')::text
    ||case when p='null'::jsonb then '' else ',"objectivePolicyProposal":'||proposal_text end||'}';
  return encode(sha256(convert_to(identity_text,'UTF8')),'hex');
end $$;

create or replace function public.runvara_outcome_validate_objective_action(p_source jsonb,p_workspace_id text)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare c jsonb; a jsonb; input jsonb; proposal jsonb; policy jsonb; field text; completed timestamptz; s jsonb; stable jsonb; evidence jsonb; origin_ref jsonb; text_limit integer; minimum integer;
begin
  if not public.runvara_outcome_exact(p_source,array['schema','revision','context','input','digest']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if octet_length(p_source::text)>32768 then raise exception using errcode='P0O10',message='OUTCOME_ACTION_TOO_LARGE'; end if;
  if octet_length(public.runvara_outcome_canonical(p_source))>24576 then raise exception using errcode='P0O10',message='OUTCOME_ACTION_TOO_LARGE'; end if;
  perform public.runvara_outcome_action_scope(p_source,p_workspace_id);
  c:=p_source->'context'; input:=p_source->'input';
  if not public.runvara_outcome_exact(c,array['schema','workspaceId','writeId','requestId','claimId','claimIdentity','provider','operation','connectionId','account','requestedBy','executedBy','inputDigest','phase','apiVersion','dispatchRequestDigest','resultId','completedAt','origin','originatingObjective','approval','proposal','policies','stableApproval'])
      or not public.runvara_outcome_exact(input,array['productId','operation','title','description']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if (p_source->>'schema'='runvara-reviewed-source-action/v2' and p_source->'revision'='1'::jsonb
      and jsonb_typeof(p_source->'digest')='string' and p_source->>'digest'=public.runvara_outcome_hash(p_source-'digest')
      and c->>'schema'='runvara-recorded-action-context/v2' and c->'workspaceId'=to_jsonb(p_workspace_id)
      and c->>'provider'='shopify' and c->>'operation'='product_content' and input->>'operation'='product_content'
      and jsonb_typeof(c->'claimIdentity')='string' and c->>'claimIdentity' ~ '^[0-9a-f]{64}$'
      and c->>'phase'='shopify_mutation' and c->>'origin'='owner_objective_content'
      and jsonb_typeof(c->'account')='string' and c->>'account' ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' and char_length(c->>'account')<=253
      and jsonb_typeof(c->'connectionId')='string' and c->>'connectionId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and jsonb_typeof(c->'requestId')='string' and c->>'requestId' ~ '^[A-Za-z0-9_-]{16,100}$'
      and jsonb_typeof(input->'productId')='string' and input->>'productId' ~ '^gid://shopify/Product/[0-9]+$' and char_length(input->>'productId')<=100
      and c->'resultId'=input->'productId' and jsonb_typeof(input->'title')='string' and char_length(input->>'title') between 1 and 200
      and char_length(input->>'title')+char_length(regexp_replace(input->>'title',U&'[^\+010000-\+10FFFF]','','g'))<=200
      and input->>'title'=btrim(input->>'title',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
      and jsonb_typeof(input->'description')='string'
      and char_length(input->>'description')+char_length(regexp_replace(input->>'description',U&'[^\+010000-\+10FFFF]','','g'))<=10000
      and c->>'inputDigest'=encode(sha256(convert_to(public.runvara_outcome_action_input_text(input),'UTF8')),'hex')
      and jsonb_typeof(c->'apiVersion')='string' and c->>'apiVersion' ~ '^[0-9]{4}-(01|04|07|10)$'
      and jsonb_typeof(c->'dispatchRequestDigest')='string' and c->>'dispatchRequestDigest'=public.runvara_outcome_action_request_digest(input,c->>'account',c->>'apiVersion')) is not true then
    raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
  foreach field in array array['writeId','claimId','requestedBy','executedBy'] loop
    if (jsonb_typeof(c->field)='string' and c->>field ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$') is not true then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  end loop;
  completed:=public.runvara_outcome_timestamp(c->'completedAt'); a:=c->'approval';
  if not public.runvara_outcome_exact(a,array['workspaceId','id','revision','status','decidedBy','decidedAt','payload','digest']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if (a->'workspaceId'=to_jsonb(p_workspace_id) and jsonb_typeof(a->'id')='string' and a->>'id' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and a->'revision'='1'::jsonb and a->>'status'='approved'
      and jsonb_typeof(a->'decidedBy')='string' and a->>'decidedBy' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and jsonb_typeof(a->'digest')='string' and a->>'digest'=public.runvara_outcome_hash(a-'digest')
      and a#>'{payload,connectionWriteId}'=c->'writeId' and a#>'{payload,digest}'=c->'inputDigest') is not true then
    raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
  if public.runvara_outcome_timestamp(a->'decidedAt')>completed then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if jsonb_typeof(c->'policies') is distinct from 'array' then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if jsonb_array_length(c->'policies')>50 then raise exception using errcode='P0O10',message='OUTCOME_ACTION_TOO_LARGE'; end if;
  if (select count(distinct p->>'objectiveId') from jsonb_array_elements(c->'policies') p)<>jsonb_array_length(c->'policies') then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  for policy in select value from jsonb_array_elements(c->'policies') loop
    if not public.runvara_outcome_exact(policy,array['objectiveId','revision','digest']) or
        (jsonb_typeof(policy->'objectiveId')='string' and policy->>'objectiveId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
        and public.runvara_outcome_safe_integer(policy->'revision',1,9007199254740991) and jsonb_typeof(policy->'digest')='string' and policy->>'digest' ~ '^[0-9a-f]{64}$') is not true then
      raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
    end if;
  end loop;
  proposal:=c->'proposal'; s:=proposal->'source'; stable:=c->'stableApproval';
  if not public.runvara_outcome_exact(proposal,array['schema','workspaceId','origin','writeId','provider','operation','inputDigest','connectionId','account','requestedBy','approvalKind','policies','evidenceQualification','source','approvalId','approvalDigest','digest'])
      or not public.runvara_outcome_exact(a->'payload',array['connectionWriteId','digest','objectivePolicyProposalDigest'])
      or not public.runvara_outcome_exact(s,array['schema','objectiveId','objectiveRevision','objectiveDigest','jobId','jobIdentityDigest','reportId','payloadDigest','resultDigest','actorId','actorSessionVersion','inputFingerprint','opportunityId','opportunityDigest','productId','productDigest','approvalSourceDigest']) then
    raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
  if (proposal->>'schema'='runvara-objective-dispatch-proposal/v2' and proposal->>'approvalKind'='customer_facing_publish'
      and proposal->>'evidenceQualification'='no_financial_execution_evidence' and jsonb_array_length(c->'policies')>0
      and jsonb_typeof(proposal->'digest')='string' and proposal->>'digest'=public.runvara_outcome_hash(proposal-'digest')
      and a#>'{payload,objectivePolicyProposalDigest}'=proposal->'digest' and proposal->'approvalId'=a->'id'
      and jsonb_typeof(proposal->'approvalDigest')='string' and proposal->>'approvalDigest' ~ '^[0-9a-f]{64}$'
      and s->>'schema'='runvara-objective-content-source/v1'
      and jsonb_typeof(s->'objectiveId')='string' and s->>'objectiveId' ~ '^objective_[0-9a-f-]{36}$'
      and public.runvara_outcome_safe_integer(s->'objectiveRevision',1,9007199254740991)
      and jsonb_typeof(s->'jobId')='string' and s->>'jobId' ~ '^job_[A-Za-z0-9_-]{1,100}$'
      and jsonb_typeof(s->'reportId')='string' and s->>'reportId' ~ '^objective_review_[0-9a-f]{32}$'
      and s->>'reportId'='objective_review_'||substr(public.runvara_outcome_hash(jsonb_build_array(p_workspace_id,s->'objectiveId',s->'objectiveRevision',s->'jobId')),1,32)
      and s->'actorId'=c->'requestedBy' and c->'executedBy'=c->'requestedBy'
      and public.runvara_outcome_safe_integer(s->'actorSessionVersion',1,9007199254740991)
      and jsonb_typeof(s->'inputFingerprint')='string' and s->>'inputFingerprint' ~ '^[0-9a-f]{32}$'
      and jsonb_typeof(s->'opportunityId')='string' and s->>'opportunityId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$'
      and s->'productId'=input->'productId'
      and s->>'payloadDigest'=public.runvara_outcome_hash(jsonb_build_object('schema','runvara-objective-prepare/v1','objectiveId',s->'objectiveId','objectiveRevision',s->'objectiveRevision','typedInputFingerprint',s->'inputFingerprint','actorSessionVersion',s->'actorSessionVersion'))) is not true then
    raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
  -- Payload/report identity can be reconstructed from captured fields. Full
  -- diagnostic job/report/product bodies are not retained; their digests remain
  -- captured references, never independent provider or execution authentication.
  if octet_length(public.runvara_outcome_canonical(proposal))>8192 then raise exception using errcode='P0O10',message='OUTCOME_ACTION_TOO_LARGE'; end if;
  foreach field in array array['objectiveDigest','jobIdentityDigest','payloadDigest','resultDigest','opportunityDigest','productDigest','approvalSourceDigest'] loop
    if (jsonb_typeof(s->field)='string' and s->>field ~ '^[0-9a-f]{64}$') is not true then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  end loop;
  foreach field in array array['workspaceId','origin','writeId','provider','operation','inputDigest','connectionId','account','requestedBy','policies'] loop
    if proposal->field is distinct from c->field then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  end loop;
  origin_ref:=jsonb_build_object('workspaceId',p_workspace_id,'id',s->'objectiveId','revision',s->'objectiveRevision','digest',s->'objectiveDigest');
  if c->'originatingObjective' is distinct from origin_ref or (select count(*) from jsonb_array_elements(c->'policies') p where p=jsonb_build_object('objectiveId',s->'objectiveId','revision',s->'objectiveRevision','digest',s->'objectiveDigest'))<>1 then
    raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
  -- Capture all stable approval bytes. Immutable correction revalidates this
  -- independent binding without needing any current approval/goal/job row.
  if not public.runvara_outcome_exact(stable,array['id','type','action','reason','financialImpact','expectedBenefit','risk','requestedBy','source','payload','evidence','revision','agentId','createdAt'])
      or not public.runvara_outcome_exact(stable->'payload',array['connectionWriteId','digest']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if octet_length(public.runvara_outcome_canonical(stable))>8192 then raise exception using errcode='P0O10',message='OUTCOME_ACTION_TOO_LARGE'; end if;
  if (stable->'id'=a->'id' and stable->'revision'=a->'revision' and stable->>'type'='customer_facing_publish'
      and stable->'financialImpact'='null'::jsonb and stable->>'source'='objective-content'
      and stable->'requestedBy'=c->'requestedBy' and stable->'payload'=(a->'payload')-'objectivePolicyProposalDigest'
      and proposal->>'approvalDigest'=public.runvara_outcome_hash(stable)) is not true then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  foreach field in array array['action','reason','expectedBenefit','risk','source','agentId'] loop
    text_limit:=case field when 'action' then 180 when 'source' then 120 when 'agentId' then 80 else 1000 end;
    minimum:=case when field='agentId' then 0 else 1 end;
    if (jsonb_typeof(stable->field)='string' and char_length(stable->>field)>=minimum
        and char_length(stable->>field)+char_length(regexp_replace(stable->>field,U&'[^\+010000-\+10FFFF]','','g'))<=text_limit
        and (minimum=0 or char_length(btrim(stable->>field))>0)
        and stable->>field=ltrim(stable->>field,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
        and (char_length(stable->>field)+char_length(regexp_replace(stable->>field,U&'[^\+010000-\+10FFFF]','','g'))=text_limit or stable->>field=rtrim(stable->>field,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))) is not true then
      raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
    end if;
  end loop;
  if public.runvara_outcome_timestamp(stable->'createdAt')>public.runvara_outcome_timestamp(a->'decidedAt') then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if jsonb_typeof(stable->'evidence') is distinct from 'array' then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if jsonb_array_length(stable->'evidence')<>2 then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if (stable#>>'{evidence,0,type}'='objective_review' and stable#>'{evidence,0,id}'=s->'reportId'
      and stable#>>'{evidence,1,type}'='product' and stable#>'{evidence,1,id}'=input->'productId') is not true then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  for evidence in select value from jsonb_array_elements(stable->'evidence') loop
    if not public.runvara_outcome_exact(evidence,array['type','id','detail']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
    foreach field in array array['type','id','detail'] loop
      text_limit:=case field when 'type' then 40 when 'id' then 180 else 1000 end;
      if (jsonb_typeof(evidence->field)='string'
          and char_length(evidence->>field)+char_length(regexp_replace(evidence->>field,U&'[^\+010000-\+10FFFF]','','g'))<=text_limit
          and evidence->>field=ltrim(evidence->>field,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
          and (char_length(evidence->>field)+char_length(regexp_replace(evidence->>field,U&'[^\+010000-\+10FFFF]','','g'))=text_limit or evidence->>field=rtrim(evidence->>field,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))) is not true then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
    end loop;
  end loop;
  if c->>'claimIdentity' is distinct from public.runvara_outcome_action_identity_digest(p_source) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  return p_source;
end $$;

create or replace function public.runvara_outcome_validate_source_action(p_source jsonb,p_workspace_id text)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare c jsonb; a jsonb; input jsonb; proposal jsonb; policy jsonb; field text; completed timestamptz;
begin
  if p_source->>'schema'='runvara-reviewed-source-action/v2' then return public.runvara_outcome_validate_objective_action(p_source,p_workspace_id); end if;
  if not public.runvara_outcome_exact(p_source,array['schema','revision','context','input','digest']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if octet_length(p_source::text)>32768 then raise exception using errcode='P0O10',message='OUTCOME_ACTION_TOO_LARGE'; end if;
  if octet_length(public.runvara_outcome_canonical(p_source))>24576 then raise exception using errcode='P0O10',message='OUTCOME_ACTION_TOO_LARGE'; end if;
  perform public.runvara_outcome_action_scope(p_source,p_workspace_id);
  c:=p_source->'context'; input:=p_source->'input';
  if not public.runvara_outcome_exact(c,array['schema','workspaceId','writeId','requestId','claimId','claimIdentity','provider','operation','connectionId','account','requestedBy','executedBy','inputDigest','phase','apiVersion','dispatchRequestDigest','resultId','completedAt','origin','originatingObjective','approval','proposal','policies'])
      or not public.runvara_outcome_exact(input,array['productId','operation','title','description']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if (p_source->>'schema'='runvara-reviewed-source-action/v1' and p_source->'revision'='1'::jsonb
      and jsonb_typeof(p_source->'digest')='string' and p_source->>'digest'=public.runvara_outcome_hash(p_source-'digest')
      and c->>'schema'='runvara-recorded-action-context/v1' and c->'workspaceId'=to_jsonb(p_workspace_id)
      and c->>'provider'='shopify' and c->>'operation'='product_content' and input->>'operation'='product_content'
      and jsonb_typeof(c->'claimIdentity')='string' and c->>'claimIdentity' ~ '^[0-9a-f]{64}$'
      and c->>'phase'='shopify_mutation' and c->>'origin'='owner_manual' and c->'originatingObjective'='null'::jsonb
      and jsonb_typeof(c->'account')='string' and c->>'account' ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' and char_length(c->>'account')<=253
      and jsonb_typeof(c->'connectionId')='string' and c->>'connectionId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and jsonb_typeof(c->'requestId')='string' and c->>'requestId' ~ '^[A-Za-z0-9_-]{16,100}$'
      and jsonb_typeof(input->'productId')='string' and input->>'productId' ~ '^gid://shopify/Product/[0-9]+$' and char_length(input->>'productId')<=160
      and c->'resultId'=input->'productId' and jsonb_typeof(input->'title')='string' and char_length(input->>'title') between 1 and 200
      and char_length(input->>'title')+char_length(regexp_replace(input->>'title',U&'[^\+010000-\+10FFFF]','','g'))<=200
      and input->>'title'=btrim(input->>'title',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
      and jsonb_typeof(input->'description')='string'
      and char_length(input->>'description')+char_length(regexp_replace(input->>'description',U&'[^\+010000-\+10FFFF]','','g'))<=10000
      and c->>'inputDigest'=encode(sha256(convert_to(public.runvara_outcome_action_input_text(input),'UTF8')),'hex')
      and jsonb_typeof(c->'apiVersion')='string' and c->>'apiVersion' ~ '^[0-9]{4}-(01|04|07|10)$'
      and jsonb_typeof(c->'dispatchRequestDigest')='string' and c->>'dispatchRequestDigest'=public.runvara_outcome_action_request_digest(input,c->>'account',c->>'apiVersion')) is not true then
    raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
  foreach field in array array['writeId','claimId','requestedBy','executedBy'] loop
    if (jsonb_typeof(c->field)='string' and c->>field ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$') is not true then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  end loop;
  completed:=public.runvara_outcome_timestamp(c->'completedAt'); a:=c->'approval';
  if not public.runvara_outcome_exact(a,array['workspaceId','id','revision','status','decidedBy','decidedAt','payload','digest']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if (a->'workspaceId'=to_jsonb(p_workspace_id) and jsonb_typeof(a->'id')='string' and a->>'id' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and a->'revision'='1'::jsonb and a->>'status'='approved'
      and jsonb_typeof(a->'decidedBy')='string' and a->>'decidedBy' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and jsonb_typeof(a->'digest')='string' and a->>'digest'=public.runvara_outcome_hash(a-'digest')
      and a#>'{payload,connectionWriteId}'=c->'writeId' and a#>'{payload,digest}'=c->'inputDigest') is not true then
    raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
  if public.runvara_outcome_timestamp(a->'decidedAt')>completed then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if jsonb_typeof(c->'policies') is distinct from 'array' then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if jsonb_array_length(c->'policies')>50 then raise exception using errcode='P0O10',message='OUTCOME_ACTION_TOO_LARGE'; end if;
  if (select count(distinct p->>'objectiveId') from jsonb_array_elements(c->'policies') p)<>jsonb_array_length(c->'policies') then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  for policy in select value from jsonb_array_elements(c->'policies') loop
    if not public.runvara_outcome_exact(policy,array['objectiveId','revision','digest']) or
        (jsonb_typeof(policy->'objectiveId')='string' and policy->>'objectiveId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
        and public.runvara_outcome_safe_integer(policy->'revision',1,9007199254740991) and jsonb_typeof(policy->'digest')='string' and policy->>'digest' ~ '^[0-9a-f]{64}$') is not true then
      raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
    end if;
  end loop;
  proposal:=c->'proposal';
  if jsonb_array_length(c->'policies')=0 then
    if proposal is distinct from 'null'::jsonb or not public.runvara_outcome_exact(a->'payload',array['connectionWriteId','digest']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  else
    if not public.runvara_outcome_exact(proposal,array['schema','workspaceId','origin','writeId','provider','operation','inputDigest','connectionId','account','requestedBy','approvalKind','policies','evidenceQualification','digest'])
        or not public.runvara_outcome_exact(a->'payload',array['connectionWriteId','digest','objectivePolicyProposalDigest']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
    if (proposal->>'schema'='runvara-objective-dispatch-proposal/v1' and proposal->>'approvalKind'='customer_facing_publish'
        and proposal->>'evidenceQualification'='no_financial_execution_evidence'
        and jsonb_typeof(proposal->'digest')='string' and proposal->>'digest'=public.runvara_outcome_hash(proposal-'digest')
        and a#>'{payload,objectivePolicyProposalDigest}'=proposal->'digest') is not true then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
    foreach field in array array['workspaceId','origin','writeId','provider','operation','inputDigest','connectionId','account','requestedBy','policies'] loop
      if proposal->field is distinct from c->field then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
    end loop;
  end if;
  if c->>'claimIdentity' is distinct from public.runvara_outcome_action_identity_digest(p_source) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  return p_source;
end $$;

create or replace function public.runvara_outcome_resolve_action(p_state jsonb,p_workspace_id text,p_action_id text)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare w jsonb; c jsonb; a jsonb; connection jsonb; source jsonb; field text; decision jsonb;
begin
  if jsonb_typeof(p_state->'connectionWrites') is distinct from 'array' or jsonb_typeof(p_state->'approvals') is distinct from 'array'
      or jsonb_typeof(p_state->'connections') is distinct from 'array' then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  foreach field in array array['connectionWrites','approvals','connections'] loop
    if jsonb_array_length(p_state->field)>500 or octet_length((p_state->field)::text)>2097152 then raise exception using errcode='P0O10',message='OUTCOME_ACTION_TOO_LARGE'; end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_state->'connectionWrites') x where x->>'id'=p_action_id)<>1 then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  select x into w from jsonb_array_elements(p_state->'connectionWrites') x where x->>'id'=p_action_id;
  if (select count(*) from jsonb_array_elements(p_state->'connectionWrites') x where x->>'requestId'=w->>'requestId')<>1
      or (select count(*) from jsonb_array_elements(p_state->'connectionWrites') x where x#>>'{dispatchClaim,id}'=w#>>'{dispatchClaim,id}')<>1 then
    raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
  perform public.runvara_outcome_action_scope(w,p_workspace_id);
  c:=w->'recordedActionContext';
  if jsonb_typeof(c) is distinct from 'object' or not(c ? 'snapshotDigest') then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  source:=jsonb_build_object('schema',case when c->>'schema'='runvara-recorded-action-context/v2' then 'runvara-reviewed-source-action/v2' else 'runvara-reviewed-source-action/v1' end,'revision',1,'context',c-'snapshotDigest','input',w->'input','digest',c->'snapshotDigest');
  perform public.runvara_outcome_validate_source_action(source,p_workspace_id);
  if (w->>'status'='completed' and w->>'provider'='shopify' and w->'id'=c->'writeId' and w->'id'=to_jsonb(p_action_id)
      and w->'requestId'=c->'requestId' and w->'connectionId'=c->'connectionId' and w->'account'=c->'account'
      and w->'requestedBy'=c->'requestedBy' and w->'digest'=c->'inputDigest' and w->'approvalId'=c#>'{approval,id}'
      and w->'requiresApproval'='true'::jsonb and w->'completedAt'=c->'completedAt' and w#>'{result,externalId}'=c->'resultId'
      and (not(w ? 'errorCode') or w->'errorCode'='null'::jsonb) and (not(w ? 'observationErrorCode') or w->'observationErrorCode'='null'::jsonb)
      and (not(w ? 'dispatchBlocked') or w->'dispatchBlocked'='false'::jsonb)
      and w#>'{dispatchClaim,id}'=c->'claimId' and w#>'{dispatchClaim,workspaceId}'=to_jsonb(p_workspace_id)
      and w#>'{dispatchClaim,identity}'=c->'claimIdentity' and jsonb_typeof(w#>'{dispatchClaim,authority}')='string' and w#>>'{dispatchClaim,authority}' ~ '^[0-9a-f]{64}$'
      and w#>'{dispatchClaim,phases,shopify_mutation,requestDigest}'=c->'dispatchRequestDigest'
      and w#>>'{dispatchClaim,phases,shopify_mutation,status}'='dispatching'
      and coalesce(w->'objectivePolicyProposal','null'::jsonb)=c->'proposal') is not true then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if not public.runvara_outcome_exact(w->'result',array['externalId']) or not public.runvara_outcome_exact(w#>'{dispatchClaim,phases}',array['shopify_mutation']) or not public.runvara_outcome_exact(w#>'{dispatchClaim,phases,shopify_mutation}',array['requestDigest','status','at']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if public.runvara_outcome_timestamp(w#>'{dispatchClaim,phases,shopify_mutation,at}')>public.runvara_outcome_timestamp(c->'completedAt') then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if (select count(*) from jsonb_array_elements(p_state->'approvals') x where x->>'id'=w->>'approvalId')<>1 then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  select x into a from jsonb_array_elements(p_state->'approvals') x where x->>'id'=w->>'approvalId';
  perform public.runvara_outcome_action_scope(a,p_workspace_id);
  decision:=jsonb_build_object('workspaceId',p_workspace_id,'id',a->'id','revision',coalesce(a->'revision','1'::jsonb),'status',a->'status','decidedBy',a->'decidedBy','decidedAt',a->'decidedAt','payload',a->'payload');
  if a->>'type' is distinct from 'customer_facing_publish' or decision is distinct from ((c->'approval')-'digest') then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if c->>'schema'='runvara-recorded-action-context/v2' and
      (not public.runvara_outcome_exact(a,array['id','type','action','reason','financialImpact','expectedBenefit','risk','requestedBy','source','payload','evidence','revision','agentId','createdAt','status','decidedAt','decidedBy','decisionNote','history','workStatus','executedExternally','executionStatus']) or
      jsonb_set(a-array['status','decidedAt','decidedBy','decisionNote','history','workStatus','executedExternally','executionStatus'],'{payload}',(a->'payload')-'objectivePolicyProposalDigest') is distinct from c->'stableApproval') then
    raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
  if (select count(*) from jsonb_array_elements(p_state->'connections') x where x->>'id'=w->>'connectionId')<>1 then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  select x into connection from jsonb_array_elements(p_state->'connections') x where x->>'id'=w->>'connectionId';
  perform public.runvara_outcome_action_scope(connection,p_workspace_id);
  if connection->'id' is distinct from c->'connectionId' or connection->>'provider' is distinct from 'shopify' or connection#>'{metadata,shopDomain}' is distinct from c->'account' then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  return source;
end $$;

create or replace function public.runvara_outcome_validate_intervention(p_value jsonb,p_workspace_id text)
returns void language plpgsql immutable security invoker set search_path='' as $$
declare ref jsonb; field text; objective boolean:=p_value->>'schema'='runvara-owner-action-association/v2';
begin
  if not public.runvara_outcome_exact(p_value,array['schema','relationship','comparison','action','approval','account','productId','completedAt','reuseVersionId']||case when objective then array['origin','originatingObjective'] else array[]::text[] end) then
    raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
  perform public.runvara_outcome_action_scope(p_value,p_workspace_id);
  if (p_value->>'schema' in ('runvara-owner-action-association/v1','runvara-owner-action-association/v2') and p_value->>'relationship'='owner_associated_recorded_action'
      and p_value->>'comparison'='not_established' and jsonb_typeof(p_value->'account')='string'
      and p_value->>'account' ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' and char_length(p_value->>'account')<=253
      and jsonb_typeof(p_value->'productId')='string' and p_value->>'productId' ~ '^gid://shopify/Product/[0-9]+$'
      and char_length(p_value->>'productId')<=160
      and (p_value->'reuseVersionId'='null'::jsonb or (jsonb_typeof(p_value->'reuseVersionId')='string' and p_value->>'reuseVersionId' ~ '^outcome_version_[0-9a-f]{64}$'))) is not true then
    raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
  end if;
  perform public.runvara_outcome_timestamp(p_value->'completedAt');
  foreach field in array array['action','approval'] loop
    ref:=p_value->field;
    if not public.runvara_outcome_exact(ref,array['workspaceId','id','revision','digest']) or
        (ref->'workspaceId'=to_jsonb(p_workspace_id) and jsonb_typeof(ref->'id')='string' and ref->>'id' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
        and ref->'revision'='1'::jsonb
        and jsonb_typeof(ref->'digest')='string' and ref->>'digest' ~ '^[0-9a-f]{64}$') is not true then
      raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID';
    end if;
  end loop;
  if objective then
    ref:=p_value->'originatingObjective';
    if not public.runvara_outcome_exact(ref,array['workspaceId','id','revision','digest']) or
        (p_value->>'origin'='owner_objective_content' and ref->'workspaceId'=to_jsonb(p_workspace_id)
          and jsonb_typeof(ref->'id')='string' and ref->>'id' ~ '^objective_[0-9a-f-]{36}$'
          and public.runvara_outcome_safe_integer(ref->'revision',1,9007199254740991)
          and jsonb_typeof(ref->'digest')='string' and ref->>'digest' ~ '^[0-9a-f]{64}$') is not true then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  end if;
  if p_value#>'{action,revision}' is distinct from '1'::jsonb then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
end $$;

create or replace function public.runvara_outcome_validate_measurement(p_measurement jsonb,p_workspace_id text,p_experiment_id text,p_now timestamptz)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare m jsonb:=p_measurement; report jsonb; facts jsonb; scope_id text; observation_id text; report_id text;
  started timestamptz; ended timestamptz; observed timestamptz; recorded timestamptz; amount text; linked boolean:=m->>'schema' in ('runvara-experiment-measurement/v2','runvara-experiment-measurement/v3'); objective boolean:=m->>'schema'='runvara-experiment-measurement/v3';
begin
  if not public.runvara_outcome_exact(m,array['schema','workspaceId','experimentId','revision','recordedBy','recordedAt','metric','amount','currency','window','coverage','method','provenance','links','report','digest']||case when linked then array['intervention'] else array[]::text[] end) then
    raise exception using errcode='P0O01',message='OUTCOME_SOURCE_INVALID';
  end if;
  if octet_length(public.runvara_outcome_canonical(m))>8192 or octet_length(m::text)>12288 then
    raise exception using errcode='P0O10',message='OUTCOME_PAYLOAD_TOO_LARGE';
  end if;
  if (jsonb_typeof(m->'workspaceId')='string' and jsonb_typeof(m->'experimentId')='string' and jsonb_typeof(m->'digest')='string'
      and m->>'schema' in ('runvara-experiment-measurement/v1','runvara-experiment-measurement/v2','runvara-experiment-measurement/v3') and m->>'workspaceId'=p_workspace_id and m->>'experimentId'=p_experiment_id
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
  if (jsonb_typeof(report->'workspaceId')='string' and jsonb_typeof(report->'experimentId')='string' and jsonb_typeof(report->'digest')='string'
      and report->>'schema'=case when objective then 'runvara-measurement-report/v3' when linked then 'runvara-measurement-report/v2' else 'runvara-measurement-report/v1' end and report->>'id'=report_id and report->>'workspaceId'=p_workspace_id
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
  if p_action='withdraw' then
    -- Withdrawal is independent of mutable action/approval/connection/policy rows.
    action_source:=previous.source_action;
  elsif source->>'schema' in ('runvara-experiment-measurement/v2','runvara-experiment-measurement/v3') then
    association:=source->'intervention';
    if association->'reuseVersionId'<>'null'::jsonb then
      if p_action<>'correct' then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
      select v.* into reused from public.runvara_business_outcome_versions v
        where v.workspace_id=p_workspace_id and v.outcome_id=publication.outcome_id and v.version_id=association->>'reuseVersionId';
      if not found or reused.source_action is null then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
      action_source:=reused.source_action;
    else
      action_source:=public.runvara_outcome_resolve_action(state_value,p_workspace_id,association#>>'{action,id}');
    end if;
  end if;
  if source->>'schema' in ('runvara-experiment-measurement/v2','runvara-experiment-measurement/v3') then
    perform public.runvara_outcome_validate_source_action(action_source,p_workspace_id);
    association:=source->'intervention';
    if (source->>'schema'='runvara-experiment-measurement/v3' and
        (action_source->>'schema'='runvara-reviewed-source-action/v2' and association->'origin'=action_source#>'{context,origin}'
          and association->'originatingObjective'=action_source#>'{context,originatingObjective}') is not true)
      or (source->>'schema'='runvara-experiment-measurement/v2' and action_source->>'schema' is distinct from 'runvara-reviewed-source-action/v1') then
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

create or replace function public.runvara_read_business_outcome_review(p_workspace_id text,p_experiment_id text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare state_value jsonb; experiment jsonb; current_value jsonb; current_association jsonb; result jsonb; outcome_key text;
  scoped jsonb; key text; marker jsonb; measurement jsonb; title jsonb; status jsonb; choices jsonb:='[]'::jsonb;
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
    ,(select v.source_measurement->'intervention' from public.runvara_business_outcome_heads h join public.runvara_business_outcome_versions v
      on (v.workspace_id,v.outcome_id,v.version_id)=(h.workspace_id,h.outcome_id,h.version_id)
      where h.workspace_id=p_workspace_id and h.outcome_id=outcome_key)
    into state_value,current_value,current_association from public.saas_workspace_state s where s.workspace_id=p_workspace_id;
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
  -- Candidate projection only. Saving and publishing independently validate the
  -- entire source. The invoker reader never calls or gains EXECUTE on helpers.
  if jsonb_typeof(state_value->'connectionWrites')='array' then
    -- Optional candidates cannot make an otherwise valid legacy review fail.
    -- Keep complete rows, but admit fewer when their cumulative JSONB text
    -- reaches the adapter's 16 KiB cap (including array separators/brackets).
    if jsonb_array_length(state_value->'connectionWrites')<=500 and octet_length((state_value->'connectionWrites')::text)<=2097152 then
    select coalesce(jsonb_agg(candidate order by ordinality),'[]'::jsonb) into choices from (
      select candidate,ordinality,sum(octet_length(candidate::text)+2) over (order by ordinality rows unbounded preceding) cumulative_bytes from (
      select w.ordinality,jsonb_build_object('id',w.value->'id','account',w.value->'account','productId',w.value#>'{input,productId}',
        'title',w.value#>'{input,title}','completedAt',w.value->'completedAt','digest',w.value#>'{recordedActionContext,snapshotDigest}')||
        case when w.value#>>'{recordedActionContext,schema}'='runvara-recorded-action-context/v2'
          then jsonb_build_object('origin','owner_objective_content','originatingObjective',w.value#>'{recordedActionContext,originatingObjective}') else '{}'::jsonb end candidate
      from jsonb_array_elements(state_value->'connectionWrites') with ordinality w
      where w.value->>'status'='completed' and w.value->>'provider'='shopify' and w.value#>>'{input,operation}'='product_content'
        and w.value#>>'{recordedActionContext,schema}' in ('runvara-recorded-action-context/v1','runvara-recorded-action-context/v2')
        and (w.value#>>'{recordedActionContext,schema}'='runvara-recorded-action-context/v1' or
          (w.value#>>'{recordedActionContext,origin}'='owner_objective_content'
            and jsonb_typeof(w.value#>'{recordedActionContext,originatingObjective}')='object'
            and case when jsonb_typeof(w.value#>'{recordedActionContext,originatingObjective}')='object' then (w.value#>'{recordedActionContext,originatingObjective}')-array['workspaceId','id','revision','digest']='{}'::jsonb else false end
            and w.value#>'{recordedActionContext,originatingObjective,workspaceId}'=to_jsonb(p_workspace_id)
            and jsonb_typeof(w.value#>'{recordedActionContext,originatingObjective,id}')='string'
            and w.value#>>'{recordedActionContext,originatingObjective,id}' ~ '^objective_[0-9a-f-]{36}$'
            and case when jsonb_typeof(w.value#>'{recordedActionContext,originatingObjective,revision}')='number' then
              (w.value#>>'{recordedActionContext,originatingObjective,revision}')::numeric between 1 and 9007199254740991
              and trunc((w.value#>>'{recordedActionContext,originatingObjective,revision}')::numeric)=(w.value#>>'{recordedActionContext,originatingObjective,revision}')::numeric else false end
            and jsonb_typeof(w.value#>'{recordedActionContext,originatingObjective,digest}')='string'
            and w.value#>>'{recordedActionContext,originatingObjective,digest}' ~ '^[0-9a-f]{64}$'))
        and w.value#>'{recordedActionContext,workspaceId}'=to_jsonb(p_workspace_id)
        and jsonb_typeof(w.value->'id')='string' and w.value->>'id' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
        and (select count(*) from jsonb_array_elements(state_value->'connectionWrites') d where d->>'id'=w.value->>'id')=1
        and jsonb_typeof(w.value->'account')='string' and w.value->>'account' ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' and char_length(w.value->>'account')<=253
        and jsonb_typeof(w.value#>'{input,productId}')='string' and w.value#>>'{input,productId}' ~ '^gid://shopify/Product/[0-9]+$' and char_length(w.value#>>'{input,productId}')<=160
        and jsonb_typeof(w.value#>'{input,title}')='string' and char_length(w.value#>>'{input,title}') between 1 and 200
        and char_length(w.value#>>'{input,title}')+char_length(regexp_replace(w.value#>>'{input,title}',U&'[^\+010000-\+10FFFF]','','g'))<=200
        and jsonb_typeof(w.value->'completedAt')='string' and w.value->>'completedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        and jsonb_typeof(w.value#>'{recordedActionContext,snapshotDigest}')='string' and w.value#>>'{recordedActionContext,snapshotDigest}' ~ '^[0-9a-f]{64}$'
      order by w.ordinality limit 20
      ) candidates
    ) selected where cumulative_bytes<=16384;
    end if;
  end if;
  result:=jsonb_build_object('workspaceId',p_workspace_id,'workspaceRevision',state_value->'_revision',
    'experiment',jsonb_build_object('id',p_experiment_id,'title',title,'status',status),'measurement',measurement,'current',current_value,'actionLinkContract','runvara-reviewed-action/v2','actionChoices',choices,'currentActionAssociation',current_association);
  if octet_length(result::text)>131072 then raise exception using errcode='P0O10',message='OUTCOME_RESPONSE_TOO_LARGE'; end if;
  return result;
end $$;

revoke all on function public.runvara_outcome_validate_objective_action(jsonb,text) from public,anon,authenticated,service_role;
commit;
