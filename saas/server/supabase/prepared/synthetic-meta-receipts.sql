-- Prepared local acceptance contract only. No deployment/startup applies it.
-- Captures synthetic transport evidence, never a real Meta attestation.
begin;
create table public.runvara_meta_receipt_control (
  id boolean primary key default true check(id),
  mode text not null check(mode in ('prepared','enforced','paused'))
);
insert into public.runvara_meta_receipt_control values(true,'prepared');
create table public.runvara_meta_receipt_events (
  workspace_id text not null references public.saas_workspace_state(workspace_id) on delete restrict,
  write_id text not null, sequence integer not null check(sequence between 1 and 16),
  logical_key text not null, event_text text not null check(octet_length(event_text)<=32768),
  event_digest text not null check(event_digest ~ '^[a-f0-9]{64}$'),
  projection jsonb not null check(octet_length(projection::text)<=65536),
  request_fingerprint text not null check(request_fingerprint ~ '^[a-f0-9]{64}$'),
  expected_revision text not null, next_revision text not null,
  primary key(workspace_id,write_id,sequence), unique(workspace_id,request_fingerprint), unique(workspace_id,next_revision)
);
create unique index runvara_meta_logical_once on public.runvara_meta_receipt_events(workspace_id,logical_key) where sequence=1;
alter table public.runvara_meta_receipt_control enable row level security;
alter table public.runvara_meta_receipt_events enable row level security;
revoke all on public.runvara_meta_receipt_control,public.runvara_meta_receipt_events from public,anon,authenticated,service_role;

create function public.runvara_meta_exact(v jsonb, keys text[]) returns boolean language sql immutable set search_path='' as $$
 select jsonb_typeof(v)='object' and (select array_agg(key order by key) from jsonb_object_keys(v) key)=(select array_agg(k order by k) from unnest(keys) k);
$$;
-- Reject ambiguous duplicate keys before converting request envelopes to JSONB.
create function public.runvara_meta_unique(v json, depth integer default 0) returns boolean language plpgsql immutable set search_path='' as $$
declare child json;
begin
 if depth>32 then return false; end if;
 if json_typeof(v)='object' then
  if (select count(*)<>count(distinct key) from json_each(v)) then return false; end if;
  for child in select value from json_each(v) loop if not public.runvara_meta_unique(child,depth+1) then return false; end if; end loop;
 elsif json_typeof(v)='array' then
  for child in select value from json_array_elements(v) loop if not public.runvara_meta_unique(child,depth+1) then return false; end if; end loop;
 end if;
 return true;
end $$;
create function public.runvara_meta_projection(s jsonb, wid text) returns jsonb language plpgsql immutable set search_path='' as $$
declare w jsonb; a jsonb;
begin
 if jsonb_typeof(s->'connectionWrites') is distinct from 'array' or jsonb_array_length(s->'connectionWrites')>10000
   or jsonb_typeof(s->'approvals') is distinct from 'array' or jsonb_array_length(s->'approvals')>10000 then
  raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 if (select count(*) from jsonb_array_elements(s->'connectionWrites') r where r->>'id'=wid)<>1 then
  raise exception using errcode='P0M05',message='META_RECEIPT_PROTECTED_WRITE'; end if;
 select r into w from jsonb_array_elements(s->'connectionWrites') r where r->>'id'=wid;
 if (select count(*) from jsonb_array_elements(s->'connectionWrites') r where r->'requestId'=w->'requestId'
    or r#>'{marketingPublication,logicalKey}'=w#>'{marketingPublication,logicalKey}'
    or r#>'{dispatchClaim,id}'=w#>'{dispatchClaim,id}')<>1 then
  raise exception using errcode='P0M05',message='META_RECEIPT_PROTECTED_WRITE'; end if;
 if (select count(*) from jsonb_array_elements(s->'approvals') r where r->>'id'=w->>'approvalId')<>1 then
  raise exception using errcode='P0M05',message='META_RECEIPT_PROTECTED_WRITE'; end if;
 select r into a from jsonb_array_elements(s->'approvals') r where r->>'id'=w->>'approvalId';
 return jsonb_build_object('write',w-'metaReceiptCursor','approval',a-array['executedExternally','executionStatus','workStatus']);
end $$;
create function public.runvara_meta_actor(s jsonb, actor jsonb) returns void language plpgsql immutable set search_path='' as $$
declare u jsonb;
begin
 if not public.runvara_meta_exact(actor,array['userId','sessionVersion']) or jsonb_typeof(s->'users') is distinct from 'array'
   or (select count(*) from jsonb_array_elements(s->'users') r where r->'id'=actor->'userId')<>1 then
  raise exception using errcode='P0M02',message='META_RECEIPT_AUTHORITY_CHANGED'; end if;
 select r into u from jsonb_array_elements(s->'users') r where r->'id'=actor->'userId';
 if (u->>'role'='owner' and coalesce(u->'sessionVersion','1')=actor->'sessionVersion'
   and jsonb_typeof(actor->'sessionVersion')='number' and (actor->>'sessionVersion') ~ '^[1-9][0-9]{0,15}$'
   and coalesce(u->>'status','active')='active' and coalesce(u->>'disabled','false')='false' and coalesce(u->>'active','true')='true'
   and coalesce(u->>'passwordChangeRequired','false')='false'
   and (not u ? 'workspaceId' or u->'workspaceId'=s#>'{workspace,id}')) is not true then
  raise exception using errcode='P0M02',message='META_RECEIPT_AUTHORITY_CHANGED'; end if;
end $$;
create function public.runvara_meta_identity(w jsonb) returns jsonb language sql immutable set search_path='' as $$
 select w-array['status','startedAt','providerState','dispatchClaim','result','marketingPublicationReceipt','completedAt','errorCode','dispatchBlocked','observationErrorCode','metaReceiptCursor'];
$$;
-- These fixed evidence objects use ASCII named keys and safe integers only;
-- text values retain Unicode. Reject other numeric/key grammars rather than
-- guessing JavaScript serialization. No arbitrary workspace hashing.
create function public.runvara_meta_canonical(v jsonb,depth integer default 0) returns text language plpgsql immutable set search_path='' as $$
declare result text;
begin
 if depth>24 or octet_length(v::text)>65536 then raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 case jsonb_typeof(v)
 when 'object' then
  if exists(select 1 from jsonb_object_keys(v) k where k !~ '^[A-Za-z_][A-Za-z0-9_]*$') then raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
  select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.runvara_meta_canonical(value,depth+1),',' order by key collate "C"),'')||'}' into result from jsonb_each(v);
 when 'array' then select '['||coalesce(string_agg(public.runvara_meta_canonical(value,depth+1),',' order by ord),'')||']' into result from jsonb_array_elements(v) with ordinality x(value,ord);
 when 'number' then
  if v::text !~ '^-?(0|[1-9][0-9]*)$' or abs((v::text)::numeric)>9007199254740991 then raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
  result:=v::text;
 else result:=v::text;
 end case;
 return result;
end $$;
create function public.runvara_meta_hash(v jsonb) returns text language sql immutable set search_path='' as $$
 select encode(sha256(convert_to(public.runvara_meta_canonical(v),'UTF8')),'hex');
$$;
create function public.runvara_meta_request_hash(w jsonb,phase text) returns text language plpgsql immutable set search_path='' as $$
declare body text; path text; request text;
begin
 if phase='instagram_container' then
  body:='{"image_url":'||(w#>'{input,imageUrl}')::text||',"caption":'||(w#>'{input,caption}')::text||'}';
  path:='/'||(w#>>'{input,instagramId}')||'/media';
 elsif phase='instagram_publish' then
  body:='{"creation_id":'||(w#>'{providerState,containerId}')::text||'}';
  path:='/'||(w#>>'{input,instagramId}')||'/media_publish';
 else raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 request:='{"provider":"meta","phase":'||to_jsonb(phase)::text||',"method":"POST","path":'||to_jsonb(path)::text||',"body":'||to_jsonb(body)::text||'}';
 return encode(sha256(convert_to(request,'UTF8')),'hex');
end $$;
create function public.runvara_meta_transition(oldp jsonb,newp jsonb,first_event boolean) returns void language plpgsql immutable set search_path='' as $$
declare w jsonb:=newp->'write'; o jsonb:=oldp->'write'; b jsonb:=w->'marketingPublication'; a jsonb:=newp->'approval';
 p jsonb:=w#>'{dispatchClaim,phases}'; op jsonb:=coalesce(o#>'{dispatchClaim,phases}','{}'); k text; phase jsonb;
begin
 if (jsonb_typeof(w)='object' and public.runvara_meta_identity(w)=public.runvara_meta_identity(o)
   and newp->'approval'=oldp->'approval' and w->>'provider'='meta' and w->'requiresApproval'='true'
   and b->>'receiptContract'='runvara-synthetic-meta-receipts/v1' and b->>'schema'='runvara-meta-campaign-publication/v1'
   and b->>'dispatchIdentitySchema'='runvara-meta-publication-canonical-dispatch/v1'
   and b->>'digest'=public.runvara_meta_hash(b-'digest')
   and b->'requestedBy'=w->'requestedBy' and a->>'status'='approved' and a->>'type'='social_commerce_publish'
   and a->'decidedBy'=w->'requestedBy' and a->'payload'->'publication'=b and a#>'{payload,connectionWriteId}'=w->'id'
   and a#>'{payload,marketingPublicationDigest}'=b->'digest' and a#>'{payload,digest}'=w->'digest'
   and coalesce(a->'revision','1')='1' and w->'account'=b#>'{target,account}' and w->'connectionId'=b#>'{target,connectionId}'
   and w#>'{input,instagramId}'=b#>'{target,instagramId}' and w#>'{input,pageId}'=b#>'{target,pageId}'
   and w#>'{input,caption}'=b->'caption' and w#>'{input,imageUrl}'=b#>'{asset,url}'
   and w#>>'{input,operation}'='instagram_publish' and b->'publishingEnabled'='false'
   and public.runvara_meta_exact(w->'input',array['operation','pageId','instagramId','caption','imageUrl'])
   and jsonb_typeof(w#>'{input,pageId}')='string' and w#>>'{input,pageId}' ~ '^[0-9]{1,32}$'
   and jsonb_typeof(w#>'{input,instagramId}')='string' and w#>>'{input,instagramId}' ~ '^[0-9]{1,32}$'
   and b->>'logicalKey'=public.runvara_meta_hash(jsonb_build_object('workspaceId',b->'workspaceId','campaignId',b->'campaignId','target',
     jsonb_build_object('connectionId',b#>'{target,connectionId}','account',b#>'{target,account}','pageId',b#>'{target,pageId}','instagramId',b#>'{target,instagramId}')))
   and b->>'requestDigest'=public.runvara_meta_hash(jsonb_build_object('requestId',w->'requestId','sourceRevision',b->'sourceRevision','target',b->'target','caption',b->'caption','asset',b->'asset'))
   and w#>>'{dispatchClaim,workspaceId}'=b->>'workspaceId'
   and public.runvara_meta_exact(w->'dispatchClaim',array['id','workspaceId','identity','authority','phases'])
   and w#>>'{dispatchClaim,id}' ~ '^write_claim_[a-f0-9-]{36}$'
   and w#>>'{dispatchClaim,identity}' ~ '^[a-f0-9]{64}$' and w#>>'{dispatchClaim,authority}' ~ '^[a-f0-9]{64}$'
   and jsonb_typeof(p)='object' and p-array['instagram_container','instagram_publish']='{}') is not true then
  raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 if first_event then
  if (o->>'status' in ('ready','pending_approval') and not o ? 'dispatchClaim' and not o ? 'providerState'
    and not o ? 'metaReceiptCursor' and w->>'status'='executing' and p='{}'
    and not w ? 'providerState' and not w ? 'result' and not w ? 'marketingPublicationReceipt') is not true then
   raise exception using errcode='P0M04',message='META_RECEIPT_CONFLICT'; end if;
 else
  if ((w->'dispatchClaim')-'phases'=(o->'dispatchClaim')-'phases' and o->>'status' in ('executing','processing')
    and w->>'status' in ('executing','processing','completed','uncertain','failed')) is not true then
   raise exception using errcode='P0M04',message='META_RECEIPT_CONFLICT'; end if;
 end if;
 foreach k in array array['instagram_container','instagram_publish'] loop
  phase:=p->k;
  if phase is not null then
   if (public.runvara_meta_exact(phase,case when k='instagram_container' and phase ? 'resultId' then array['requestDigest','status','at','resultId'] else array['requestDigest','status','at'] end)
     and phase->>'requestDigest' ~ '^[a-f0-9]{64}$' and phase->>'status'='dispatching'
     and phase->>'requestDigest'=public.runvara_meta_request_hash(w,k)
     and phase->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$') is not true then
    raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
  end if;
  if op ? k and ((phase-'resultId') is distinct from ((op->k)-'resultId') or op->k ? 'resultId' and phase->'resultId' is distinct from op#>array[k,'resultId']) then
   raise exception using errcode='P0M04',message='META_RECEIPT_CONFLICT'; end if;
 end loop;
 if p ? 'instagram_container' and not op ? 'instagram_container' and (p#>'{instagram_container,resultId}' is not null or p ? 'instagram_publish') then
  raise exception using errcode='P0M04',message='META_RECEIPT_CONFLICT'; end if;
 if p ? 'instagram_publish' and not op ? 'instagram_publish' and (op#>>'{instagram_container,resultId}' is null
   or op#>'{instagram_container,resultId}' is distinct from o#>'{providerState,containerId}') then
  raise exception using errcode='P0M04',message='META_RECEIPT_CONFLICT'; end if;
 if w ? 'providerState' then
  if (jsonb_typeof(w->'providerState')='object' and (w->'providerState')-array['containerId','createdAt','checkAfter','publishStartedAt']='{}'
    and w#>>'{providerState,containerId}' ~ '^[0-9]{1,32}$' and w#>'{providerState,containerId}'=p#>'{instagram_container,resultId}') is not true then
   raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 end if;
 if (o#>'{providerState,containerId}' is not null and w#>'{providerState,containerId}' is distinct from o#>'{providerState,containerId}')
   or (o#>'{providerState,publishStartedAt}' is not null and w#>'{providerState,publishStartedAt}' is distinct from o#>'{providerState,publishStartedAt}')
   or ((p ? 'instagram_publish') is distinct from (w#>'{providerState,publishStartedAt}' is not null)) then
  raise exception using errcode='P0M04',message='META_RECEIPT_CONFLICT'; end if;
 if w->>'status'='completed' then
  if (op ? 'instagram_publish' and w#>'{result,simulated}'='true' and w#>>'{result,externalId}' ~ '^[0-9]{1,32}$'
    and w#>'{marketingPublicationReceipt,simulated}'='true' and w#>'{marketingPublicationReceipt,executedExternally}'='false'
    and w#>'{marketingPublicationReceipt,resultId}'=w#>'{result,externalId}'
    and w#>'{marketingPublicationReceipt,containerId}'=w#>'{providerState,containerId}'
    and w#>'{marketingPublicationReceipt,workspaceId}'=b->'workspaceId' and w#>'{marketingPublicationReceipt,writeId}'=w->'id'
    and w#>'{marketingPublicationReceipt,requestId}'=w->'requestId' and w#>'{marketingPublicationReceipt,claimId}'=w#>'{dispatchClaim,id}'
    and w#>'{marketingPublicationReceipt,publicationDigest}'=b->'digest'
    and w#>>'{marketingPublicationReceipt,digest}'=public.runvara_meta_hash((w->'marketingPublicationReceipt')-'digest')
    and w#>>'{marketingPublicationReceipt,claimDigest}'=public.runvara_meta_hash(to_jsonb(public.runvara_meta_canonical(w->'dispatchClaim')))
    and w#>>'{marketingPublicationReceipt,approvalDecision}'=public.runvara_meta_hash(to_jsonb(public.runvara_meta_canonical(a)))
    and w#>'{marketingPublicationReceipt,localAssetSnapshot}' is not distinct from b#>'{asset,localSnapshot}') is not true then
   raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 elsif w ? 'result' or w ? 'marketingPublicationReceipt' or w ? 'completedAt' then
  raise exception using errcode='P0M01',message='META_RECEIPT_INVALID';
 end if;
end $$;
create function public.runvara_meta_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare e record; s jsonb; w jsonb;
begin
 if tg_op='TRUNCATE' then raise exception using errcode='P0M05',message='META_RECEIPT_PROTECTED_WRITE'; end if;
 s:=case when tg_op='DELETE' then null else new.state end;
 for e in select distinct on(write_id) * from public.runvara_meta_receipt_events where workspace_id=old.workspace_id order by write_id,sequence desc loop
  if tg_op='DELETE' or new.workspace_id is distinct from old.workspace_id or public.runvara_meta_projection(s,e.write_id) is distinct from e.projection then
   raise exception using errcode='P0M05',message='META_RECEIPT_PROTECTED_WRITE'; end if;
  select r into w from jsonb_array_elements(s->'connectionWrites') r where r->>'id'=e.write_id;
  if w->'metaReceiptCursor' is distinct from jsonb_build_object('contract','runvara-synthetic-meta-receipts/v1','sequence',e.sequence,'digest',e.event_digest) then
   raise exception using errcode='P0M05',message='META_RECEIPT_PROTECTED_WRITE'; end if;
 end loop;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger runvara_meta_state_guard before update or delete on public.saas_workspace_state for each row execute function public.runvara_meta_guard();
create function public.runvara_meta_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='P0M05',message='META_RECEIPT_PROTECTED_WRITE'; end $$;
create trigger runvara_meta_events_immutable before update or delete on public.runvara_meta_receipt_events for each row execute function public.runvara_meta_immutable();
create trigger runvara_meta_events_no_truncate before truncate on public.runvara_meta_receipt_events for each statement execute function public.runvara_meta_immutable();

create function public.runvara_meta_ack(e public.runvara_meta_receipt_events,replayed boolean) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('contract','runvara-synthetic-meta-receipts/v1','workspaceId',e.workspace_id,'writeId',e.write_id,'sequence',e.sequence,
  'eventDigest',e.event_digest,'requestFingerprint',e.request_fingerprint,'expectedRevision',e.expected_revision,'nextRevision',e.next_revision,'replayed',replayed);
$$;
create function public.runvara_commit_meta_receipt(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; ev jsonb; d jsonb; s jsonb; nexts jsonb; prior public.runvara_meta_receipt_events; saved public.runvara_meta_receipt_events;
  prevp jsonb; fingerprint text; control_mode text; w jsonb; actor jsonb; c jsonb; settings jsonb; n integer;
begin
 if p_request is null or octet_length(p_request)>2162688 or not public.runvara_meta_unique(p_request::json) then
  raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 r:=p_request::jsonb; d:=r->'descriptor'; nexts:=r->'state';
 if not public.runvara_meta_exact(r,array['contract','workspaceId','expectedRevision','nextRevision','state','descriptor'])
   or not public.runvara_meta_exact(d,array['contract','eventText','digest'])
   or (r->>'contract'='runvara-synthetic-meta-receipts/v1' and d->'contract'=r->'contract'
    and jsonb_typeof(d->'eventText')='string' and octet_length(d->>'eventText')<=32768
    and r->>'workspaceId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
    and r->>'expectedRevision' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
    and r->>'nextRevision' ~ '^[a-f0-9-]{36}$' and r->'expectedRevision'<>r->'nextRevision'
    and nexts#>'{workspace,id}'=r->'workspaceId' and nexts->'_revision'=r->'nextRevision') is not true
   or octet_length(((p_request::json)->'state')::text)>=2097152 then
  raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 if not public.runvara_meta_unique((d->>'eventText')::json) then raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 ev:=(d->>'eventText')::jsonb; w:=ev#>'{projection,write}';
 if not public.runvara_meta_exact(ev,array['workspaceId','writeId','sequence','previousDigest','projection','simulated','executedExternally'])
   or not public.runvara_meta_exact(ev->'projection',array['write','approval'])
   or (ev->'workspaceId'=r->'workspaceId' and ev->'writeId'=w->'id' and ev->>'writeId' ~ '^write_[a-f0-9-]{36}$'
    and ev->'simulated'='true' and ev->'executedExternally'='false' and jsonb_typeof(ev->'sequence')='number'
    and (ev->>'sequence') ~ '^([1-9]|1[0-6])$'
    and encode(sha256(convert_to(d->>'eventText','UTF8')),'hex')=d->>'digest'
    and d->>'eventText'=public.runvara_meta_canonical(ev)
    and ev->'projection'=public.runvara_meta_projection(nexts,ev->>'writeId')
    and w#>'{marketingPublication,workspaceId}'=r->'workspaceId') is not true then
  raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 fingerprint:=encode(sha256(convert_to(p_request,'UTF8')),'hex');
 select mode into control_mode from public.runvara_meta_receipt_control where id for update;
 select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for update;
 if s is null then raise exception using errcode='P0M02',message='META_RECEIPT_AUTHORITY_CHANGED'; end if;
 actor:=jsonb_build_object('userId',w->'requestedBy','sessionVersion',w#>'{marketingPublication,actorSessionVersion}');
 -- Exact retries prove an old transaction, never current dispatch eligibility.
 select * into saved from public.runvara_meta_receipt_events where workspace_id=r->>'workspaceId' and request_fingerprint=fingerprint;
 if found then perform public.runvara_meta_actor(s,actor); return public.runvara_meta_ack(saved,true); end if;
 if control_mode is distinct from 'enforced' then raise exception using errcode='P0M03',message='META_RECEIPT_CAPACITY_OR_MODE'; end if;
 if s->'_revision' is distinct from r->'expectedRevision' then raise exception using errcode='P0M04',message='META_RECEIPT_CONFLICT'; end if;
 select * into prior from public.runvara_meta_receipt_events where workspace_id=r->>'workspaceId' and write_id=ev->>'writeId' order by sequence desc limit 1;
 if found then
  if (ev->>'sequence')::integer<>prior.sequence+1 or ev->>'previousDigest' is distinct from prior.event_digest then
   raise exception using errcode='P0M04',message='META_RECEIPT_CONFLICT'; end if;
  prevp:=prior.projection;
 else
  if ev->'sequence'<>'1' or ev->'previousDigest'<>'null' then raise exception using errcode='P0M04',message='META_RECEIPT_CONFLICT'; end if;
  if (select count(*) from public.runvara_meta_receipt_events where sequence=1)>=64
    or (select count(*) from public.runvara_meta_receipt_events where workspace_id=r->>'workspaceId' and sequence=1)>=16 then
   raise exception using errcode='P0M03',message='META_RECEIPT_CAPACITY_OR_MODE'; end if;
  prevp:=public.runvara_meta_projection(s,ev->>'writeId');
 end if;
 perform public.runvara_meta_transition(prevp,ev->'projection',prior.sequence is null);
 if ((w#>'{dispatchClaim,phases}')-array(select jsonb_object_keys(coalesce(prevp#>'{write,dispatchClaim,phases}','{}'))))<>'{}'
    and octet_length(((p_request::json)->'state')::text)>=2080768 then
  raise exception using errcode='P0M03',message='META_RECEIPT_CAPACITY_OR_MODE'; end if;
 -- Reserve completion capacity before a send, independent of caller logic.
 -- Pending/resume bookkeeping cannot consume the last two continuation rows.
 if (prior.sequence is null and octet_length(d->>'eventText')>24576)
   or ((ev->>'sequence')::integer>14 and w->>'status' in ('executing','processing')
      and not (w#>'{dispatchClaim,phases}' ? 'instagram_publish'))
   or ((ev->>'sequence')::integer>15 and w#>'{dispatchClaim,phases}' ? 'instagram_publish'
      and not (coalesce(prevp#>'{write,dispatchClaim,phases}','{}') ? 'instagram_publish')) then
  raise exception using errcode='P0M03',message='META_RECEIPT_CAPACITY_OR_MODE'; end if;
 -- Preserve an already submitted outcome if account settings subsequently
 -- change. New admissions always require current actor/connection permission.
 if not (coalesce(prevp#>'{write,dispatchClaim,phases}','{}') ? 'instagram_publish') then
  perform public.runvara_meta_actor(s,actor); perform public.runvara_meta_actor(nexts,actor);
  select count(*),jsonb_agg(row)->0 into n,c from jsonb_array_elements(s->'connections') row where row->>'provider'='meta';
  settings:=s#>'{connectionSettings,meta}';
  if (n=1 and c->'id'=w->'connectionId' and c->>'status'='connected' and c#>'{metadata,accountId}'=w->'account'
    and settings->>'permissionMode' in ('approval_gated','automatic') and coalesce(settings->>'disconnected','false')='false'
    and settings->'metaPageIds' @> jsonb_build_array(w#>'{input,pageId}')
    and c#>'{metadata,grantedScopes}' @> '["instagram_basic","instagram_content_publish","pages_read_engagement"]'
    and nexts->'connections'=s->'connections' and nexts->'connectionSettings'=s->'connectionSettings') is not true then
   raise exception using errcode='P0M02',message='META_RECEIPT_AUTHORITY_CHANGED'; end if;
 end if;
 insert into public.runvara_meta_receipt_events values(r->>'workspaceId',ev->>'writeId',(ev->>'sequence')::integer,
  w#>>'{marketingPublication,logicalKey}',d->>'eventText',d->>'digest',ev->'projection',fingerprint,r->>'expectedRevision',r->>'nextRevision') returning * into saved;
 update public.saas_workspace_state set state=nexts,updated_at=now() where workspace_id=r->>'workspaceId';
 return public.runvara_meta_ack(saved,false);
end $$;

create function public.runvara_meta_read_request(p_request text, lookup boolean) returns jsonb language plpgsql immutable set search_path='' as $$
declare r jsonb;
begin
 if p_request is null or octet_length(p_request)>2048 or not public.runvara_meta_unique(p_request::json) then raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 r:=p_request::jsonb;
 if not public.runvara_meta_exact(r,case when lookup then array['contract','workspaceId','writeId','actor','requestFingerprint'] else array['contract','workspaceId','writeId','actor'] end)
   or (r->>'contract'='runvara-synthetic-meta-receipts/v1' and r->>'workspaceId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
    and r->>'writeId' ~ '^write_[a-f0-9-]{36}$' and (not lookup or r->>'requestFingerprint' ~ '^[a-f0-9]{64}$')) is not true then
  raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 return r;
end $$;
create function public.runvara_lookup_meta_receipt(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb:=public.runvara_meta_read_request(p_request,true); s jsonb; e public.runvara_meta_receipt_events;
begin
 select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for share;
 perform public.runvara_meta_actor(s,r->'actor');
 select * into e from public.runvara_meta_receipt_events where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and request_fingerprint=r->>'requestFingerprint';
 if not found then return null; end if;
 if (e.projection#>'{write,requestedBy}'=r#>'{actor,userId}' and e.projection#>'{write,marketingPublication,actorSessionVersion}'=r#>'{actor,sessionVersion}') is not true then
  raise exception using errcode='P0M02',message='META_RECEIPT_AUTHORITY_CHANGED'; end if;
 return public.runvara_meta_ack(e,true);
end $$;
create function public.runvara_read_meta_receipt(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb:=public.runvara_meta_read_request(p_request,false); s jsonb; events jsonb; e public.runvara_meta_receipt_events;
begin
 select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId';
 perform public.runvara_meta_actor(s,r->'actor');
 select * into e from public.runvara_meta_receipt_events where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' order by sequence limit 1;
 if not found then return null; end if;
 if (e.projection#>'{write,requestedBy}'=r#>'{actor,userId}' and e.projection#>'{write,marketingPublication,actorSessionVersion}'=r#>'{actor,sessionVersion}') is not true then
  raise exception using errcode='P0M02',message='META_RECEIPT_AUTHORITY_CHANGED'; end if;
 select jsonb_agg(jsonb_build_object('contract','runvara-synthetic-meta-receipts/v1','eventText',event_text,'digest',event_digest) order by sequence)
  into events from public.runvara_meta_receipt_events where workspace_id=r->>'workspaceId' and write_id=r->>'writeId';
 return jsonb_build_object('contract','runvara-synthetic-meta-receipts/v1','workspaceId',r->'workspaceId','writeId',r->'writeId','events',events,'simulated',true,'executedExternally',false);
end $$;
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and (proname like 'runvara_meta_%' or proname in ('runvara_commit_meta_receipt','runvara_lookup_meta_receipt','runvara_read_meta_receipt')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.runvara_commit_meta_receipt(text),public.runvara_lookup_meta_receipt(text),public.runvara_read_meta_receipt(text) to service_role;
commit;
