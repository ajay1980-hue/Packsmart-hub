-- PREPARED ONLY: not applied, not migration history, no activation or data rewriting.
-- Install only after disposable PostgreSQL proof and separate production review.
-- Existing function signatures/owners/grants, guards, quotas and ledger rows remain.
-- Source hashes:
-- 20261007175355_reviewed_action_outcome_snapshot.sql sha256=db938e3566937f07420f934d4026bb19df306071d0688db1e9173bb95fbc49af
-- 20261008055400_objective_action_outcome_snapshot.sql sha256=9856b7e6cba64b5b598e0b07dc75f0d113f176c287ac6da99e6daf5916dde76d
-- 20261008144414_protected_content_execution_receipts.sql sha256=92133a5f448e8dcd7f921eef2d01afee8e7f69f189d9c92bdc53f8248be00113
-- 20261008163558_receipt_outcome_consumer.sql sha256=d64e54094f0a86ff85bc6f7c7fd6eb4ddb7a9700ff4117bba7c8f679ad3e8327
begin;

-- Source for the prepared forward contract. No table writes or activation.
create function public.runvara_description_replace(p_html text,p_paragraph text,p_text text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare pos integer:=1; stop integer; n integer; token text; name text; parent text; tail text; hit text[];
  names text[]:=array[]::text[]; starts integer[]:=array[]::integer[]; inners integer[]:=array[]::integer[];
  depth integer; matches integer:=0; inner_start integer; inner_end integer; result text;
  inline_tags text[]:=array['a','span','strong','em','b','i','u','s','small','sub','sup','code','br','img'];
  all_tags text[]:=array['a','span','strong','em','b','i','u','s','small','sub','sup','code','br','img','p','div','section','h1','h2','h3','h4','h5','h6','ul','ol','li'];
  trim_chars text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if p_html is null or p_paragraph is null or p_text is null or octet_length(p_html)>12000
    or p_html ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'
    or p_text ~ U&'[\0001-\0009\000B-\001F\007F]' or btrim(p_text,trim_chars)=''
    or char_length(p_text)+char_length(regexp_replace(p_text,U&'[^\+010000-\+10FFFF]','','g'))>4000 then
    raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  while pos<=char_length(p_html) loop
    tail:=substr(p_html,pos); depth:=cardinality(names); parent:=names[depth];
    if left(tail,1)<>'<' then
      stop:=strpos(tail,'<'); n:=case when stop=0 then char_length(tail) else stop-1 end;
      if parent in ('ul','ol') and btrim(left(tail,n),trim_chars)<>'' then
        raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
      pos:=pos+n; continue;
    end if;
    if left(tail,4)='<!--' then
      stop:=strpos(substr(tail,5),'-->');
      if stop=0 or strpos(substr(tail,5,stop-1),'--')>0 then
        raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
      pos:=pos+stop+6; continue;
    end if;
    hit:=regexp_match(tail,E'^(</([A-Za-z][A-Za-z0-9]*)[ \\t\\r\\n]*>)');
    if hit is not null then
      token:=hit[1]; name:=lower(hit[2]);
      if depth=0 or parent<>name then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
      if name='p' and substr(p_html,starts[depth],pos+char_length(token)-starts[depth])=p_paragraph then
        matches:=matches+1; inner_start:=inners[depth]; inner_end:=pos;
      end if;
      names:=names[1:depth-1]; starts:=starts[1:depth-1]; inners:=inners[1:depth-1];
      pos:=pos+char_length(token); continue;
    end if;
    hit:=regexp_match(tail,E'^(<([A-Za-z][A-Za-z0-9]*)(?:[ \\t\\r\\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t\\r\\n]*=[ \\t\\r\\n]*(?:"[^"]*"|''[^'']*''))?)*[ \\t\\r\\n]*(/?)>)');
    if hit is null then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
    token:=hit[1]; name:=lower(hit[2]);
    if not(name=any(all_tags)) or (hit[3]='/' and name not in ('br','img')) or depth>=32
      or (exists(select 1 from unnest(names) x where x=any(inline_tags) or x='p' or x ~ '^h[1-6]$') and not(name=any(inline_tags)))
      or (parent in ('ul','ol') and name<>'li') or (name='li' and coalesce(parent,'') not in ('ul','ol'))
      or (name='a' and 'a'=any(names)) then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
    if name not in ('br','img') then
      names:=array_append(names,name); starts:=array_append(starts,pos); inners:=array_append(inners,pos+char_length(token));
    end if;
    pos:=pos+char_length(token);
  end loop;
  if cardinality(names)<>0 or matches<>1 then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  result:=left(p_html,inner_start-1)||replace(replace(replace(replace(p_text,'&','&amp;'),'<','&lt;'),'>','&gt;'),E'\n','<br>')||substr(p_html,inner_end);
  if result=p_html or octet_length(result)>12000 then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  return result;
end $$;

create function public.runvara_description_validate_input(p_input jsonb)
returns void language plpgsql immutable security invoker set search_path='' as $$
declare field text; stamp text;
begin
  if not public.runvara_outcome_exact(p_input,array['schema','productId','operation','baselineHtml','baselineUpdatedAt','paragraphHtml','replacementText','descriptionHtml']) then
    raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  foreach field in array array['schema','productId','operation','baselineHtml','baselineUpdatedAt','paragraphHtml','replacementText','descriptionHtml'] loop
    if jsonb_typeof(p_input->field) is distinct from 'string' then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  end loop;
  if (p_input->>'schema'='runvara-description-edit/v1' and p_input->>'operation'='product_content'
    and p_input->>'productId' ~ '^gid://shopify/Product/[0-9]+$' and char_length(p_input->>'productId')<=100
    and p_input->>'baselineUpdatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$'
    and p_input->>'descriptionHtml'=public.runvara_description_replace(p_input->>'baselineHtml',p_input->>'paragraphHtml',p_input->>'replacementText')) is not true then
    raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  stamp:=p_input->>'baselineUpdatedAt';
  if char_length(stamp)=20 then stamp:=replace(stamp,'Z','.000Z'); end if;
  perform public.runvara_outcome_timestamp(to_jsonb(stamp));
end $$;

revoke all on function public.runvara_description_replace(text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.runvara_description_validate_input(jsonb) from public,anon,authenticated,service_role;


create or replace function public.runvara_outcome_action_input_text(p_input jsonb)
returns text language sql immutable security invoker set search_path='' as $$
  select case when p_input->>'schema'='runvara-description-edit/v1' then '{"schema":'||(p_input->'schema')::text||',"productId":'||(p_input->'productId')::text||',"operation":'||(p_input->'operation')::text||',"baselineHtml":'||(p_input->'baselineHtml')::text||',"baselineUpdatedAt":'||(p_input->'baselineUpdatedAt')::text||',"paragraphHtml":'||(p_input->'paragraphHtml')::text||',"replacementText":'||(p_input->'replacementText')::text||',"descriptionHtml":'||(p_input->'descriptionHtml')::text||'}'
  else '{"productId":'||(p_input->'productId')::text||',"operation":'||(p_input->'operation')::text||',"title":'||(p_input->'title')::text||',"description":'||(p_input->'description')::text||'}' end
$$;

create or replace function public.runvara_outcome_action_request_digest(p_input jsonb,p_account text,p_api_version text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare query_text text:='mutation RunvaraProductContent($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id title } userErrors { field message } } }'; html text; body text; request_text text;
begin
  if p_input->>'schema'='runvara-description-edit/v1' then
    perform public.runvara_description_validate_input(p_input);
    query_text:='mutation RunvaraProductDescription($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }';
    body:='{"query":'||to_jsonb(query_text)::text||',"variables":{"product":{"id":'||(p_input->'productId')::text||',"descriptionHtml":'||(p_input->'descriptionHtml')::text||'}}}';
    request_text:='{"provider":"shopify","phase":"shopify_mutation","method":"POST","url":'||to_jsonb('https://'||p_account||'/admin/api/'||p_api_version||'/graphql.json')::text||',"body":'||to_jsonb(body)::text||'}';
    return encode(sha256(convert_to(request_text,'UTF8')),'hex');
  end if;
  html:='<p>'||replace(replace(replace(replace(p_input->>'description','&','&amp;'),'<','&lt;'),'>','&gt;'),E'\n','<br>')||'</p>';
  body:='{"query":'||to_jsonb(query_text)::text||',"variables":{"product":{"id":'||(p_input->'productId')::text||',"title":'||(p_input->'title')::text||',"descriptionHtml":'||to_jsonb(html)::text||'}}}';
  request_text:='{"provider":"shopify","phase":"shopify_mutation","method":"POST","url":'||to_jsonb('https://'||p_account||'/admin/api/'||p_api_version||'/graphql.json')::text||',"body":'||to_jsonb(body)::text||'}';
  return encode(sha256(convert_to(request_text,'UTF8')),'hex');
end $$;

create or replace function public.runvara_description_validate_source(p_source jsonb,p_workspace_id text)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare c jsonb; a jsonb; input jsonb; proposal jsonb; policy jsonb; field text; completed timestamptz;
begin
  if not public.runvara_outcome_exact(p_source,array['schema','revision','context','input','digest']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if octet_length(p_source::text)>32768 then raise exception using errcode='P0O10',message='OUTCOME_ACTION_TOO_LARGE'; end if;
  if octet_length(public.runvara_outcome_canonical(p_source))>24576 then raise exception using errcode='P0O10',message='OUTCOME_ACTION_TOO_LARGE'; end if;
  perform public.runvara_outcome_action_scope(p_source,p_workspace_id);
  c:=p_source->'context'; input:=p_source->'input';
  perform public.runvara_description_validate_input(input);
  if not public.runvara_outcome_exact(c,array['schema','workspaceId','writeId','requestId','claimId','claimIdentity','provider','operation','connectionId','account','requestedBy','executedBy','inputDigest','phase','apiVersion','dispatchRequestDigest','resultId','completedAt','origin','originatingObjective','approval','proposal','policies']) then raise exception using errcode='P0O01',message='OUTCOME_ACTION_INVALID'; end if;
  if (p_source->>'schema'='runvara-reviewed-source-action/v3' and p_source->'revision'='1'::jsonb
      and jsonb_typeof(p_source->'digest')='string' and p_source->>'digest'=public.runvara_outcome_hash(p_source-'digest')
      and c->>'schema'='runvara-recorded-action-context/v3' and c->'workspaceId'=to_jsonb(p_workspace_id)
      and c->>'provider'='shopify' and c->>'operation'='product_content' and input->>'operation'='product_content'
      and jsonb_typeof(c->'claimIdentity')='string' and c->>'claimIdentity' ~ '^[0-9a-f]{64}$'
      and c->>'phase'='shopify_mutation' and c->>'origin'='owner_manual' and c->'originatingObjective'='null'::jsonb
      and jsonb_typeof(c->'account')='string' and c->>'account' ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' and char_length(c->>'account')<=253
      and jsonb_typeof(c->'connectionId')='string' and c->>'connectionId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and jsonb_typeof(c->'requestId')='string' and c->>'requestId' ~ '^[A-Za-z0-9_-]{16,100}$'
      and jsonb_typeof(input->'productId')='string' and input->>'productId' ~ '^gid://shopify/Product/[0-9]+$' and char_length(input->>'productId')<=160
      and c->'resultId'=input->'productId'
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

revoke all on function public.runvara_description_validate_source(jsonb,text) from public,anon,authenticated,service_role;

create or replace function public.runvara_outcome_validate_source_action(p_source jsonb,p_workspace_id text)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare c jsonb; a jsonb; input jsonb; proposal jsonb; policy jsonb; field text; completed timestamptz;
begin
  if p_source->>'schema'='runvara-reviewed-source-action/v3' then return public.runvara_description_validate_source(p_source,p_workspace_id); end if;
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
  source:=jsonb_build_object('schema',case when c->>'schema'='runvara-recorded-action-context/v3' then 'runvara-reviewed-source-action/v3' when c->>'schema'='runvara-recorded-action-context/v2' then 'runvara-reviewed-source-action/v2' else 'runvara-reviewed-source-action/v1' end,'revision',1,'context',c-'snapshotDigest','input',w->'input','digest',c->'snapshotDigest');
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

create or replace function public.runvara_content_request(p_request_json text,p_kind text)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb;
begin
  if p_request_json is null or octet_length(p_request_json)>2162688 or p_kind not in ('reserve','finalize') then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_INPUT_INVALID';
  end if;
  begin r:=p_request_json::jsonb;
  exception when others then raise exception using errcode='P0R01',message='CONTENT_RECEIPT_INPUT_INVALID'; end;
  -- json (not jsonb) preserves the original state serialization. Do not try to
  -- emulate JavaScript formatting of arbitrary workspace numbers to count it.
  if octet_length(((p_request_json::json)->'state')::text)>=2097152 then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_STATE_TOO_LARGE'; end if;
  if not public.runvara_outcome_exact(r,array['contract','kind','workspaceId','expectedRevision','nextRevision','state','admission',
      case when p_kind='reserve' then 'sourceTemplate' else 'receipt' end])
    or (r->>'contract'=case when r#>>'{admission,schema}'='runvara-content-execution-admission/v2' then 'runvara-content-execution-receipts/v2' else 'runvara-content-execution-receipts/v1' end and r->>'kind'=p_kind
      and jsonb_typeof(r->'workspaceId')='string' and char_length(r->>'workspaceId') between 1 and 256
      and r->>'workspaceId'=btrim(r->>'workspaceId') and r->>'workspaceId' !~ '[[:cntrl:]]'
      and jsonb_typeof(r->'expectedRevision')='string' and r->>'expectedRevision' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(r->'nextRevision')='string' and r->>'nextRevision' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and r->>'nextRevision'<>r->>'expectedRevision' and jsonb_typeof(r->'state')='object'
      and r#>>'{state,workspace,id}'=r->>'workspaceId' and r#>>'{state,_revision}'=r->>'nextRevision') is not true then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_INPUT_INVALID';
  end if;
  return r;
end $$;

create or replace function public.runvara_content_validate_admission(p_admission jsonb,p_workspace_id text)
returns void language plpgsql immutable security invoker set search_path='' as $$
declare k text;
begin
  if not public.runvara_outcome_exact(p_admission,array['schema','workspaceId','attemptId','writeId','requestId','claimId','claimIdentity',
      'authorityDigest','actorId','actorSessionVersion','phase','dispatchRequestDigest','intentDigest','admittedAt','reservedBytes','digest'])
    or octet_length(p_admission::text)>4096 then raise exception using errcode='P0R01',message='CONTENT_RECEIPT_ADMISSION_INVALID'; end if;
  if (p_admission->>'schema' in ('runvara-content-execution-admission/v1','runvara-content-execution-admission/v2') and p_admission->'workspaceId'=to_jsonb(p_workspace_id)
      and p_admission->>'phase'='shopify_mutation' and p_admission->'reservedBytes'='40960'::jsonb
      and p_admission->>'attemptId'='content_attempt_'||public.runvara_outcome_hash(jsonb_build_array(p_workspace_id,p_admission->>'claimId','shopify_mutation'))
      and p_admission->>'digest'=public.runvara_outcome_hash(p_admission-'digest')
      and public.runvara_outcome_safe_integer(p_admission->'actorSessionVersion',1,9007199254740991)
      and p_admission->>'requestId' ~ '^[A-Za-z0-9_-]{16,100}$') is not true then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_ADMISSION_INVALID';
  end if;
  foreach k in array array['writeId','claimId','actorId'] loop
    if (jsonb_typeof(p_admission->k)='string' and p_admission->>k ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$') is not true then
      raise exception using errcode='P0R01',message='CONTENT_RECEIPT_ADMISSION_INVALID'; end if;
  end loop;
  foreach k in array array['claimIdentity','authorityDigest','dispatchRequestDigest','intentDigest','digest'] loop
    if (jsonb_typeof(p_admission->k)='string' and p_admission->>k ~ '^[0-9a-f]{64}$') is not true then
      raise exception using errcode='P0R01',message='CONTENT_RECEIPT_ADMISSION_INVALID'; end if;
  end loop;
  perform public.runvara_outcome_timestamp(p_admission->'admittedAt');
end $$;

create or replace function public.runvara_content_validate_source(p_state jsonb,p_admission jsonb,p_source jsonb,p_template boolean)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare w jsonb; a jsonb; connection jsonb; c jsonb:=p_source->'context'; field text;
  write_index integer; approval_index integer; probe jsonb; resolved jsonb;
begin
  if ((p_admission->>'schema'='runvara-content-execution-admission/v2') = (p_source->>'schema'='runvara-reviewed-source-action/v3')) is not true then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_SOURCE_INVALID'; end if;
  perform public.runvara_outcome_validate_source_action(p_source,p_admission->>'workspaceId');
  if (public.runvara_content_source_intent(p_source)=p_admission->>'intentDigest'
      and c->'workspaceId'=p_admission->'workspaceId' and c->'writeId'=p_admission->'writeId'
      and c->'requestId'=p_admission->'requestId' and c->'claimId'=p_admission->'claimId'
      and c->'claimIdentity'=p_admission->'claimIdentity' and c->'executedBy'=p_admission->'actorId'
      and c->'phase'=p_admission->'phase' and c->'dispatchRequestDigest'=p_admission->'dispatchRequestDigest'
      and (c->>'origin'<>'owner_objective_content' or c#>'{proposal,source,actorSessionVersion}'=p_admission->'actorSessionVersion')
      and (not p_template or c->'completedAt'=p_admission->'admittedAt')) is not true then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_SOURCE_INVALID';
  end if;
  -- Execution already supports bounded retained arrays up to 10,000 rows. Check
  -- the complete arrays and all aliases before narrowing the detached source
  -- resolver input; do not widen the existing publication helper's 500-row cap.
  foreach field in array array['connectionWrites','approvals','connections'] loop
    if jsonb_typeof(p_state->field) is distinct from 'array' then
      raise exception using errcode='P0R01',message='CONTENT_RECEIPT_SOURCE_INVALID'; end if;
    if jsonb_array_length(p_state->field)>10000 or octet_length((p_state->field)::text)>2097152 then
      raise exception using errcode='P0R01',message='CONTENT_RECEIPT_SOURCE_TOO_LARGE'; end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_state->'connectionWrites') x where x->>'id'=p_admission->>'writeId')<>1 then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_SOURCE_INVALID';
  end if;
  select value,(ordinality-1)::integer into w,write_index from jsonb_array_elements(p_state->'connectionWrites') with ordinality
    where value->>'id'=p_admission->>'writeId';
  if (select count(*) from jsonb_array_elements(p_state->'connectionWrites') x where x->>'requestId'=w->>'requestId')<>1
      or (select count(*) from jsonb_array_elements(p_state->'connectionWrites') x where x#>>'{dispatchClaim,id}'=w#>>'{dispatchClaim,id}')<>1
      or (select count(*) from jsonb_array_elements(p_state->'approvals') x where x->>'id'=w->>'approvalId')<>1
      or (select count(*) from jsonb_array_elements(p_state->'connections') x where x->>'id'=w->>'connectionId')<>1 then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_SOURCE_INVALID'; end if;
  select value,(ordinality-1)::integer into a,approval_index from jsonb_array_elements(p_state->'approvals') with ordinality
    where value->>'id'=w->>'approvalId';
  select x into connection from jsonb_array_elements(p_state->'connections') x where x->>'id'=w->>'connectionId';
  if (w#>'{dispatchClaim,authority}'=p_admission->'authorityDigest'
      and w#>'{dispatchClaim,phases,shopify_mutation,at}'=p_admission->'admittedAt'
      and (not p_template or w->>'status'='executing')) is not true then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_SOURCE_INVALID'; end if;
  if p_template then
    w:=w||jsonb_build_object('status','completed','completedAt',c->'completedAt','result',jsonb_build_object('externalId',c->'resultId'),
      'errorCode',null,'observationErrorCode',null,'dispatchBlocked',false);
  end if;
  w:=w||jsonb_build_object('recordedActionContext',c||jsonb_build_object('snapshotDigest',p_source->'digest'));
  if p_template then
    -- Conservative preflight of the actual future arrays, before narrowing.
    -- Include optional context and the larger permitted success flags, even
    -- when the executor may later omit them. Only fixed-width completion time
    -- and digest strings vary after dispatch. These simulated values are never
    -- persisted or used as evidence of a completed provider request.
    if octet_length(jsonb_set(p_state->'connectionWrites',array[write_index::text],w)::text)>2097152
      or octet_length(jsonb_set(p_state->'approvals',array[approval_index::text],a||jsonb_build_object(
        'executedExternally',true,'executionStatus','completed','workStatus','COMPLETED'))::text)>2097152 then
      raise exception using errcode='P0R01',message='CONTENT_RECEIPT_FUTURE_SOURCE_TOO_LARGE';
    end if;
  end if;
  probe:=jsonb_build_object('connectionWrites',jsonb_build_array(w),'approvals',jsonb_build_array(a),'connections',jsonb_build_array(connection));
  resolved:=public.runvara_outcome_resolve_action(probe,p_admission->>'workspaceId',p_admission->>'writeId');
  if resolved is distinct from p_source then raise exception using errcode='P0R01',message='CONTENT_RECEIPT_SOURCE_INVALID'; end if;
  return resolved;
end $$;

create or replace function public.runvara_content_make_receipt(p_admission jsonb,p_source jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare receipt jsonb;
begin
  if ((p_admission->>'schema'='runvara-content-execution-admission/v2') = (p_source->>'schema'='runvara-reviewed-source-action/v3')) is not true then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_SOURCE_INVALID'; end if;
  receipt:=jsonb_build_object('schema',case when p_admission->>'schema'='runvara-content-execution-admission/v2' then 'runvara-content-execution-receipt/v2' else 'runvara-content-execution-receipt/v1' end,'workspaceId',p_admission->'workspaceId',
    'attemptId',p_admission->'attemptId','admissionDigest',p_admission->'digest','intentDigest',p_admission->'intentDigest',
    'observation','provider_confirmed','source',p_source);
  receipt:=receipt||jsonb_build_object('digest',public.runvara_content_receipt_hash(receipt));
  if octet_length(receipt::text)>36864 then raise exception using errcode='P0R01',message='CONTENT_RECEIPT_TOO_LARGE'; end if;
  return receipt;
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
    'experiment',jsonb_build_object('id',p_experiment_id,'title',title,'status',status),'measurement',measurement,'current',current_value,'actionLinkContract','runvara-reviewed-action/v3','actionChoices',choices,'currentActionAssociation',current_association);
  if octet_length(result::text)>131072 then raise exception using errcode='P0O10',message='OUTCOME_RESPONSE_TOO_LARGE'; end if;
  return result;
end $$;

create or replace function public.runvara_read_outcome_content_sources(p_workspace_id text,p_experiment_id text,
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
      'account',source#>'{context,account}','productId',source#>'{input,productId}','title',case when source->>'schema'='runvara-reviewed-source-action/v3' then to_jsonb('Shopify description change'::text) else source#>'{input,title}' end,
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
    if action_source->>'schema'='runvara-reviewed-source-action/v3' and source->>'schema'<>'runvara-experiment-measurement/v4' then raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;
    if (association->>'schema'='runvara-owner-action-association/v2' and
        (action_source->>'schema'='runvara-reviewed-source-action/v2' and association->'origin'=action_source#>'{context,origin}'
          and association->'originatingObjective'=action_source#>'{context,originatingObjective}') is not true)
      or (association->>'schema'='runvara-owner-action-association/v1' and coalesce(action_source->>'schema','') not in ('runvara-reviewed-source-action/v1','runvara-reviewed-source-action/v3')) then
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

commit;
