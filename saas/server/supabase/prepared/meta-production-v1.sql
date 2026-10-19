-- Production v1 contract. Install only after explicit approval. Closed by default.
begin;
create function public.runvara_meta_prod_exact(v jsonb, keys text[]) returns boolean language sql immutable set search_path='' as $$
 select jsonb_typeof(v)='object' and (select array_agg(key order by key) from jsonb_object_keys(v) key)=(select array_agg(k order by k) from unnest(keys) k);
$$;
create function public.runvara_meta_prod_unique(v json, depth integer default 0) returns boolean language plpgsql immutable set search_path='' as $$
declare child json;
begin
 if depth>32 then return false; end if;
 if json_typeof(v)='object' then
  if (select count(*)<>count(distinct key) from json_each(v)) then return false; end if;
  for child in select value from json_each(v) loop if not public.runvara_meta_prod_unique(child,depth+1) then return false; end if; end loop;
 elsif json_typeof(v)='array' then
  for child in select value from json_array_elements(v) loop if not public.runvara_meta_prod_unique(child,depth+1) then return false; end if; end loop;
 end if;
 return true;
end $$;
create function public.runvara_meta_prod_canonical(v jsonb,depth integer default 0) returns text language plpgsql immutable set search_path='' as $$
declare result text;
begin
 if depth>24 or octet_length(v::text)>65536 then raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
 case jsonb_typeof(v)
 when 'object' then
  if exists(select 1 from jsonb_object_keys(v) k where k !~ '^[A-Za-z_][A-Za-z0-9_]*$') then raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
  select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.runvara_meta_prod_canonical(value,depth+1),',' order by key collate "C"),'')||'}' into result from jsonb_each(v);
 when 'array' then select '['||coalesce(string_agg(public.runvara_meta_prod_canonical(value,depth+1),',' order by ord),'')||']' into result from jsonb_array_elements(v) with ordinality x(value,ord);
 when 'number' then
  if v::text !~ '^-?(0|[1-9][0-9]*)$' or abs((v::text)::numeric)>9007199254740991 then raise exception using errcode='P0M01',message='META_RECEIPT_INVALID'; end if;
  result:=v::text;
 else result:=v::text;
 end case;
 return result;
end $$;
create function public.runvara_meta_prod_hash(v jsonb) returns text language sql immutable set search_path='' as $$
 select encode(sha256(convert_to(public.runvara_meta_prod_canonical(v),'UTF8')),'hex');
$$;
create function public.runvara_meta_prod_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='P0M05',message='META_RECEIPT_PROTECTED_WRITE'; end $$;
-- Standalone production namespace. No startup imports this prepared contract;
-- installation and activation each require the owner's separate authorization.
create table public.runvara_meta_prod_ledger_control_v1 (
 id boolean primary key default true check(id), mode text not null check(mode in ('prepared','active','paused')),
 barrier bigint not null default 0, last_clock timestamptz
);
insert into public.runvara_meta_prod_ledger_control_v1(id,mode) values(true,'prepared');
create table public.runvara_meta_prod_ledger_proposals_v1 (
 workspace_id text not null references public.saas_workspace_state(workspace_id) on delete restrict,
 write_id text not null, request_id text not null, logical_key text not null, binding jsonb not null,
 binding_digest text not null check(binding_digest ~ '^[a-f0-9]{64}$'),
 provenance text not null check(provenance='server_meta_publication/production-v1'),
 approval_decision jsonb not null default '{}' check(octet_length(approval_decision::text)<=8192),
 created_at timestamptz not null,
 primary key(workspace_id,write_id), unique(workspace_id,logical_key), unique(workspace_id,request_id),
 check(octet_length(binding::text)<=16384)
);
-- Each proposal permanently reserves 24 event slots. No pruning, refill or
-- lease expiry. Maximum 128 proposals globally and 16 per workspace.
create table public.runvara_meta_prod_ledger_events_v1 (
 workspace_id text not null, write_id text not null, sequence integer not null check(sequence between 1 and 24),
 request_id text not null, kind text not null check(kind in ('reserve','admit','settle','recover')),
 phase text not null check(phase in ('proposal','container','publish','read')),
 admission_digest text, event_digest text not null check(event_digest ~ '^[a-f0-9]{64}$'),
 request_fingerprint text not null check(request_fingerprint ~ '^[a-f0-9]{64}$'),
 event_text text not null check(octet_length(event_text)<=24576), event jsonb not null,
 at timestamptz not null, account_key text not null,
 primary key(workspace_id,write_id,sequence), unique(workspace_id,request_id), unique(event_digest),
 foreign key(workspace_id,write_id) references public.runvara_meta_prod_ledger_proposals_v1(workspace_id,write_id) on delete restrict
);
create unique index runvara_meta_prod_ledger_settled_once_v1 on public.runvara_meta_prod_ledger_events_v1(admission_digest) where kind='settle';
create unique index runvara_meta_prod_ledger_recovered_once_v1 on public.runvara_meta_prod_ledger_events_v1(admission_digest) where kind='recover';
alter table public.runvara_meta_prod_ledger_control_v1 enable row level security;
alter table public.runvara_meta_prod_ledger_proposals_v1 enable row level security;
alter table public.runvara_meta_prod_ledger_events_v1 enable row level security;
revoke all on public.runvara_meta_prod_ledger_control_v1,public.runvara_meta_prod_ledger_proposals_v1,public.runvara_meta_prod_ledger_events_v1 from public,anon,authenticated,service_role;
create trigger runvara_meta_prod_ledger_proposals_immutable before update or delete on public.runvara_meta_prod_ledger_proposals_v1 for each row execute function public.runvara_meta_prod_immutable();
create trigger runvara_meta_prod_ledger_proposals_truncate before truncate on public.runvara_meta_prod_ledger_proposals_v1 for each statement execute function public.runvara_meta_prod_immutable();
create trigger runvara_meta_prod_ledger_events_immutable before update or delete on public.runvara_meta_prod_ledger_events_v1 for each row execute function public.runvara_meta_prod_immutable();
create trigger runvara_meta_prod_ledger_events_truncate before truncate on public.runvara_meta_prod_ledger_events_v1 for each statement execute function public.runvara_meta_prod_immutable();

create function public.runvara_meta_prod_ledger_actor_v1(s jsonb, a jsonb, workspace text) returns void language plpgsql immutable set search_path='' as $$
declare u jsonb;
begin
 if (public.runvara_meta_prod_exact(a,array['userId','sessionVersion']) and jsonb_typeof(a->'userId')='string'
  and a->>'userId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
  and jsonb_typeof(a->'sessionVersion')='number' and a->>'sessionVersion' ~ '^[1-9][0-9]{0,15}$'
  and (a->>'sessionVersion')::numeric<=9007199254740991 and s#>>'{workspace,id}'=workspace
  and jsonb_typeof(s->'users')='array') is not true then raise exception using errcode='P0L02',message='META_LEDGER_AUTHORITY'; end if;
 if (select count(*) from jsonb_array_elements(s->'users') r where r->'id'=a->'userId')<>1 then
  raise exception using errcode='P0L02',message='META_LEDGER_AUTHORITY'; end if;
 select r into u from jsonb_array_elements(s->'users') r where r->'id'=a->'userId';
 if (u->>'role'='owner' and coalesce(u->'sessionVersion','1')=a->'sessionVersion'
   and coalesce(u->'status','"active"')='"active"' and coalesce(u->'active','true')='true'
   and coalesce(u->'disabled','false')='false' and coalesce(u->'passwordChangeRequired','false')='false'
   and (not u ? 'workspaceId' or u->>'workspaceId'=workspace)) is not true then
  raise exception using errcode='P0L02',message='META_LEDGER_AUTHORITY'; end if;
end $$;
create function public.runvara_meta_prod_ledger_conflicts_v1(s jsonb,b jsonb) returns boolean language sql immutable set search_path='' as $$
 select exists(select 1 from jsonb_array_elements(coalesce(s->'connectionWrites','[]')) w where
  w->'id'=b->'writeId' or w->'requestId'=b->'requestId' or w#>'{dispatchClaim,id}'=b->'claimId'
  or w->>'provider'='meta' and (
   w#>'{marketingPublication,logicalKey}'=b->'logicalKey'
   or w#>'{marketingPublication,campaignId}'=b->'campaignId' and w#>'{input,instagramId}'=b#>'{target,instagramId}'
   or w#>'{input,instagramId}'=b#>'{target,instagramId}' and w#>'{input,caption}'=b->'caption' and w#>'{input,imageUrl}'=b#>'{asset,url}'));
$$;
-- Statement trigger acquires the same global lock BEFORE a generic writer
-- locks workspace rows. Updating the barrier makes a stale REPEATABLE READ
-- writer serialize-fail even when its snapshot cannot see the new proposal.
create function public.runvara_meta_prod_ledger_writer_barrier_v1() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='TRUNCATE' then raise exception using errcode='P0L05',message='META_LEDGER_PROTECTED'; end if;
 update public.runvara_meta_prod_ledger_control_v1 set barrier=barrier+1 where id;
 if not found then raise exception using errcode='P0L05',message='META_LEDGER_CONTROL_MISSING'; end if;
 return null;
end $$;
create trigger runvara_meta_prod_ledger_writer_barrier before insert or update or delete or truncate on public.saas_workspace_state for each statement execute function public.runvara_meta_prod_ledger_writer_barrier_v1();
create function public.runvara_meta_prod_ledger_writer_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare p record; w jsonb; today text; legacy_before integer:=0; legacy_after integer; debt integer; allowance integer; settings jsonb;
begin
 if tg_op<>'DELETE' then
  today:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD');
  select count(*) into legacy_after from jsonb_array_elements(coalesce(new.state->'connectionWrites','[]')) legacy where legacy#>>'{marketingPublication,day}'=today;
  if tg_op='UPDATE' then select count(*) into legacy_before from jsonb_array_elements(coalesce(old.state->'connectionWrites','[]')) legacy where legacy#>>'{marketingPublication,day}'=today; end if;
  if legacy_after>legacy_before then
   settings:=new.state#>'{marketing,settings}';
   allowance:=case when jsonb_typeof(settings->'dailyOrganicLimit')='number' and (settings->>'dailyOrganicLimit')::numeric=trunc((settings->>'dailyOrganicLimit')::numeric)
    then least(8,greatest(1,(settings->>'dailyOrganicLimit')::numeric))::integer else 2 end;
   select count(*) into debt from public.runvara_meta_prod_ledger_proposals_v1 where workspace_id=new.workspace_id and (created_at at time zone 'UTC')::date=today::date;
   if debt>0 and (legacy_after+debt>allowance or (select last_clock from public.runvara_meta_prod_ledger_control_v1 where id)>clock_timestamp()) then
    raise exception using errcode='P0L05',message='META_LEDGER_SHARED_DAILY_ALLOWANCE'; end if;
  end if;
  for w in select value from jsonb_array_elements(coalesce(new.state->'connectionWrites','[]')) loop
   if w ?| array['metaProduction','metaLedger','metaLedgerCursor','productionPublication']
    or coalesce(w#>>'{marketingPublication,receiptContract}','') like 'runvara-meta-%'
    or coalesce(w#>>'{marketingPublication,schema}','') like 'runvara-meta-publication-ledger%'
    or exists(select 1 from public.runvara_meta_prod_ledger_events_v1 e where e.kind='settle' and e.phase='container'
      and e.event#>'{data,resultId}'<>'null' and (w#>'{providerState,containerId}'=e.event#>'{data,resultId}'
        or w#>'{dispatchClaim,phases,instagram_container,resultId}'=e.event#>'{data,resultId}'))
      and not (tg_op='UPDATE' and new.workspace_id=old.workspace_id
        and (select count(*) from jsonb_array_elements(coalesce(old.state->'connectionWrites','[]')) previous where previous=w)
          >=(select count(*) from jsonb_array_elements(coalesce(new.state->'connectionWrites','[]')) current_write where current_write=w)) then
     raise exception using errcode='P0L05',message='META_LEDGER_PROTECTED'; end if;
  end loop;
 end if;
 for p in select * from public.runvara_meta_prod_ledger_proposals_v1 where workspace_id=case when tg_op='INSERT' then new.workspace_id else old.workspace_id end loop
  if tg_op='DELETE' or new.workspace_id is distinct from p.workspace_id or public.runvara_meta_prod_ledger_conflicts_v1(new.state,p.binding) then
   raise exception using errcode='P0L05',message='META_LEDGER_PROTECTED'; end if;
 end loop;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger runvara_meta_prod_ledger_writer_guard before insert or update or delete on public.saas_workspace_state for each row execute function public.runvara_meta_prod_ledger_writer_guard_v1();

create function public.runvara_meta_prod_ledger_scope_v1(v jsonb,workspace text,depth integer default 0) returns boolean language plpgsql immutable set search_path='' as $$
declare k text; child jsonb;
begin
 if depth>12 or octet_length(v::text)>65536 then return false; end if;
 if jsonb_typeof(v)='object' then
  for k,child in select key,value from jsonb_each(v) loop
   if k in ('workspaceId','workspace_id','tenantId','tenant_id','workspace','tenant') then
    if k in ('workspace','tenant') and jsonb_typeof(child)='object' then
     if child->'id' is distinct from to_jsonb(workspace) then return false; end if;
    elsif child is distinct from to_jsonb(workspace) then return false; end if;
   end if;
   if k<>'encryptedCredentials' and not public.runvara_meta_prod_ledger_scope_v1(child,workspace,depth+1) then return false; end if;
  end loop;
 elsif jsonb_typeof(v)='array' then
  if jsonb_array_length(v)>1024 then return false; end if;
  for child in select value from jsonb_array_elements(v) loop if not public.runvara_meta_prod_ledger_scope_v1(child,workspace,depth+1) then return false; end if; end loop;
 end if;
 return true;
end $$;

create function public.runvara_meta_prod_ledger_binding_v1(s jsonb,b jsonb,a jsonb) returns void language plpgsql set search_path='' as $$
declare approval jsonb; c jsonb; settings jsonb; page jsonb; t jsonb:=b->'target'; asset jsonb:=b->'asset';
begin
 perform public.runvara_meta_prod_ledger_actor_v1(s,a,b->>'workspaceId');
 if (public.runvara_meta_prod_exact(b,array['workspaceId','writeId','requestId','claimId','approvalId','approvalRevision','actor','campaignId','selection','sourceRevision','target','caption','dailyLimit','asset','logicalKey','inputDigest'])
  and b->'actor'=a and jsonb_typeof(b->'approvalRevision')='number' and b->>'approvalRevision' ~ '^[1-9][0-9]{0,15}$'
  and (b->>'approvalRevision')::numeric<=9007199254740991
  and jsonb_typeof(b->'caption')='string' and length(b->>'caption') between 1 and 2200
  and jsonb_typeof(b->'dailyLimit')='number' and b->>'dailyLimit' ~ '^[1-9][0-9]{0,2}$'
  and b->>'sourceRevision' ~ '^[a-f0-9]{64}$'
  and public.runvara_meta_prod_exact(t,array['connectionId','account','pageId','instagramId','settingsRevision'])
  and jsonb_typeof(t->'connectionId')='string' and t->>'connectionId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
  and public.runvara_meta_prod_exact(b->'selection',array['pageId','creativeRequestId','assetUrl'])
  and b#>'{selection,pageId}'=t->'pageId' and b#>'{selection,assetUrl}'=asset->'url'
  and jsonb_typeof(b#>'{selection,creativeRequestId}')='string' and length(b#>>'{selection,creativeRequestId}') between 1 and 160
  and jsonb_typeof(t->'settingsRevision')='number' and t->>'settingsRevision' ~ '^(0|[1-9][0-9]{0,15})$'
  and (t->>'settingsRevision')::numeric<=9007199254740991
  and public.runvara_meta_prod_exact(asset,array['sha256','byteLength','mediaType','deliveryDigest','url','providerDeliveryVerified','provenance'])
  and asset->>'sha256' ~ '^[a-f0-9]{64}$' and asset->>'deliveryDigest' ~ '^[a-f0-9]{64}$'
  and asset->'providerDeliveryVerified'='false' and asset->>'provenance'='server_meta_publication/production-v1'
  and jsonb_typeof(asset->'byteLength')='number' and asset->>'byteLength' ~ '^[1-9][0-9]{0,7}$'
  and (asset->>'byteLength')::integer between 100 and 2097152 and asset->>'mediaType'='image/jpeg'
  and b->>'inputDigest'=public.runvara_meta_prod_hash(jsonb_build_object('caption',b->'caption','asset',asset,'target',t))
  and b->>'logicalKey'=public.runvara_meta_prod_hash(jsonb_build_object('workspaceId',b->'workspaceId','campaignId',b->'campaignId','account',t->'account','pageId',t->'pageId','instagramId',t->'instagramId'))) is not true then
   raise exception using errcode='P0L01',message='META_LEDGER_BINDING_INVALID'; end if;
 if exists(select 1 from unnest(array['workspaceId','writeId','requestId','claimId','approvalId','campaignId']) k where
  jsonb_typeof(b->k) is distinct from 'string' or b->>k !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$')
  or exists(select 1 from unnest(array['account','pageId','instagramId']) k where jsonb_typeof(t->k) is distinct from 'string' or t->>k !~ '^[0-9]{1,32}$') then
   raise exception using errcode='P0L01',message='META_LEDGER_BINDING_INVALID'; end if;
 if (select count(*) from jsonb_array_elements(s->'approvals') r where r->'id'=b->'approvalId')<>1 then
  raise exception using errcode='P0L02',message='META_LEDGER_APPROVAL'; end if;
 select r into approval from jsonb_array_elements(s->'approvals') r where r->'id'=b->'approvalId';
 if (approval->>'type'='protected_meta_production_publication' and approval->>'status'='approved' and approval->'decidedBy'=a->'userId'
  and approval->'revision'=b->'approvalRevision' and approval->'workspaceId'=b->'workspaceId'
  and approval#>>'{payload,contract}'='runvara-meta-publication-ledger/production-v1'
  and approval#>>'{payload,bindingDigest}'=public.runvara_meta_prod_hash(b)
  and approval->'metaProductionConsent'=jsonb_build_object('contract','runvara-meta-publication-ledger/production-v1',
    'bindingDigest',public.runvara_meta_prod_hash(b),'sourceRevision',b->'sourceRevision','imageSha256',b#>'{asset,sha256}',
    'byteLength',b#>'{asset,byteLength}','caption',b->'caption','target',b->'target','postCount',1)) is not true then
   raise exception using errcode='P0L02',message='META_LEDGER_APPROVAL'; end if;
 if (select count(*) from jsonb_array_elements(s->'connections') r where r->>'provider'='meta')<>1
  or (select count(*) from jsonb_array_elements(s->'connections') r where r->'id'=t->'connectionId' and r->>'provider'='meta')<>1 then
  raise exception using errcode='P0L02',message='META_LEDGER_TARGET'; end if;
 select r into c from jsonb_array_elements(s->'connections') r where r->'id'=t->'connectionId' and r->>'provider'='meta';
 settings:=s#>'{connectionSettings,meta}';
 if (c->>'status'='connected' and c#>'{metadata,accountId}'=t->'account' and settings->'revision'=t->'settingsRevision'
  and settings->>'permissionMode' in ('approval_gated','automatic')
  and (settings->>'permissionMode'<>'automatic' or settings#>'{consent,mode}'='"automatic"')
  and coalesce(settings->'disconnected','false')='false'
  and public.runvara_meta_prod_ledger_scope_v1(c,b->>'workspaceId') and public.runvara_meta_prod_ledger_scope_v1(settings,b->>'workspaceId')
  and settings->'metaPageIds' @> jsonb_build_array(t->'pageId')
  and c#>'{metadata,grantedScopes}' @> '["instagram_basic","instagram_content_publish","pages_read_engagement"]') is not true then
   raise exception using errcode='P0L02',message='META_LEDGER_TARGET'; end if;
 if (select count(*) from jsonb_array_elements(c#>'{metadata,assets,pages}') r where r->'id'=t->'pageId')<>1 then
  raise exception using errcode='P0L02',message='META_LEDGER_TARGET'; end if;
 select r into page from jsonb_array_elements(c#>'{metadata,assets,pages}') r where r->'id'=t->'pageId';
 if page#>'{instagram,id}' is distinct from t->'instagramId' then raise exception using errcode='P0L02',message='META_LEDGER_TARGET'; end if;
end $$;
create function public.runvara_meta_prod_ledger_ack_v1(e public.runvara_meta_prod_ledger_events_v1,replayed boolean) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('contract','runvara-meta-publication-ledger/production-v1','provenance','server_meta_publication/production-v1',
  'eventText',e.event_text,'digest',e.event_digest,'replayed',replayed,'transportPermitted',false);
$$;
create function public.runvara_commit_meta_prod_ledger_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; b jsonb; s jsonb; clock_now timestamptz; control public.runvara_meta_prod_ledger_control_v1;
 proposal public.runvara_meta_prod_ledger_proposals_v1; prior public.runvara_meta_prod_ledger_events_v1;
 head public.runvara_meta_prod_ledger_events_v1; admission public.runvara_meta_prod_ledger_events_v1; saved public.runvara_meta_prod_ledger_events_v1;
 fingerprint text; v_account_key text; ev jsonb; txt text; n integer; active_count integer; first_read timestamptz; last_read timestamptz; data jsonb; container_conflict boolean:=false; decision jsonb;
begin
 if p_request is null or octet_length(p_request)>2200000 or not public.runvara_meta_prod_unique(p_request::json) then
  raise exception using errcode='P0L01',message='META_LEDGER_INVALID'; end if;
 r:=p_request::jsonb; b:=r->'binding'; data:=r->'data';
 if (public.runvara_meta_prod_exact(r,array['contract','provenance','workspaceId','writeId','actor','binding','expectedState','kind','requestId','phase','expectedHead','admissionDigest','data'])
  and r->>'contract'='runvara-meta-publication-ledger/production-v1' and r->>'provenance'='server_meta_publication/production-v1'
  and r->'workspaceId'=b->'workspaceId' and r->'writeId'=b->'writeId' and jsonb_typeof(r->'requestId')='string'
  and r->>'requestId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
  and r->>'kind' in ('reserve','admit','settle','recover') and r->>'phase' in ('proposal','container','publish','read')
  and (r->'expectedHead'='null' or jsonb_typeof(r->'expectedHead')='string' and r->>'expectedHead' ~ '^[a-f0-9]{64}$')
  and (r->'admissionDigest'='null' or jsonb_typeof(r->'admissionDigest')='string' and r->>'admissionDigest' ~ '^[a-f0-9]{64}$')) is not true then
   raise exception using errcode='P0L01',message='META_LEDGER_INVALID'; end if;
 perform public.runvara_meta_prod_canonical(b);
 select * into control from public.runvara_meta_prod_ledger_control_v1 where id for update;
 if not found then raise exception using errcode='P0L03',message='META_LEDGER_CLOSED'; end if;
 -- An older protected RPC may already hold a workspace row before reaching
 -- the generic statement barrier. NOWAIT fails closed instead of creating a
 -- global/workspace lock cycle with that predecessor.
 select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for share nowait;
 clock_now:=clock_timestamp(); -- Never transaction_timestamp or a caller clock.
 if control.last_clock>clock_now then raise exception using errcode='P0L03',message='META_LEDGER_CLOCK_BACKWARDS'; end if;
 fingerprint:=public.runvara_meta_prod_hash(r-'expectedState');
 select * into proposal from public.runvara_meta_prod_ledger_proposals_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId';
 if r->>'kind'<>'reserve' and (proposal.binding is distinct from b or proposal.provenance is distinct from r->>'provenance') then
  raise exception using errcode='P0L04',message='META_LEDGER_BINDING_CONFLICT'; end if;
 if r->>'kind'='settle' then
  -- Narrow exact admitted outcome survives revocation. Does not disclose any
  -- other workspace state and never changes it or authorizes another request.
  select * into admission from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and event_digest=r->>'admissionDigest' and kind='admit';
  if not found or admission.event->'actor' is distinct from r->'actor' or admission.phase is distinct from r->>'phase'
   or r->'expectedState'<>'null' or r->'expectedHead'<>'null' then raise exception using errcode='P0L04',message='META_LEDGER_ADMISSION_REQUIRED'; end if;
 else perform public.runvara_meta_prod_ledger_actor_v1(s,r->'actor',r->>'workspaceId'); end if;
 select * into prior from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and request_id=r->>'requestId';
 if found then
  if prior.request_fingerprint<>fingerprint or prior.write_id<>r->>'writeId' then raise exception using errcode='P0L04',message='META_LEDGER_REQUEST_CONFLICT'; end if;
  return public.runvara_meta_prod_ledger_ack_v1(prior,true);
 end if;
 select * into head from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' order by sequence desc limit 1;
 if r->>'kind'<>'settle' and (r->>'expectedHead') is distinct from head.event_digest then raise exception using errcode='P0L04',message='META_LEDGER_HEAD_CHANGED'; end if;
 n:=coalesce(head.sequence,0)+1;
 if n>24 then raise exception using errcode='P0L03',message='META_LEDGER_CAPACITY'; end if;
 v_account_key:='meta:'||(b#>>'{target,account}')||':'||(b#>>'{target,instagramId}');
 if r->>'kind' in ('reserve','admit') then
  if control.mode<>'active' then raise exception using errcode='P0L03',message='META_LEDGER_CLOSED'; end if;
  if s is distinct from r->'expectedState' then raise exception using errcode='P0L04',message='META_LEDGER_SOURCE_CHANGED'; end if;
  perform public.runvara_meta_prod_ledger_binding_v1(s,b,r->'actor');
  select a-array['executedExternally','executionStatus','workStatus'] into decision from jsonb_array_elements(s->'approvals') a where a->'id'=b->'approvalId';
  if r->>'kind'='admit' and proposal.approval_decision is distinct from decision then
   raise exception using errcode='P0L04',message='META_LEDGER_APPROVAL_DECISION_CHANGED'; end if;
  if data<>'{}' or r->'admissionDigest'<>'null' or public.runvara_meta_prod_ledger_conflicts_v1(s,b) then
   raise exception using errcode='P0L04',message='META_LEDGER_LEGACY_OR_DATA_CONFLICT'; end if;
 end if;
 if r->>'kind'='reserve' then
  if proposal.write_id is not null or r->>'phase'<>'proposal' or r->'requestId'<>b->'requestId'
   or (select count(*) from public.runvara_meta_prod_ledger_proposals_v1)>=128
   or (select count(*) from public.runvara_meta_prod_ledger_proposals_v1 where workspace_id=r->>'workspaceId')>=16
   or (select count(*) from public.runvara_meta_prod_ledger_proposals_v1 where workspace_id=r->>'workspaceId' and (created_at at time zone 'UTC')::date=(clock_now at time zone 'UTC')::date)
     +(select count(*) from jsonb_array_elements(coalesce(s->'connectionWrites','[]')) w where w#>>'{marketingPublication,day}'=to_char(clock_now at time zone 'UTC','YYYY-MM-DD'))>=(b->>'dailyLimit')::integer then
    raise exception using errcode='P0L03',message='META_LEDGER_CAPACITY_OR_DUPLICATE'; end if;
  insert into public.runvara_meta_prod_ledger_proposals_v1(workspace_id,write_id,request_id,logical_key,binding,binding_digest,provenance,approval_decision,created_at)
   values(r->>'workspaceId',r->>'writeId',r->>'requestId',b->>'logicalKey',b,public.runvara_meta_prod_hash(b),r->>'provenance',decision,clock_now) returning * into proposal;
 elsif r->>'kind'='admit' then
  if (select count(*) from public.runvara_meta_prod_ledger_proposals_v1 where workspace_id=r->>'workspaceId' and (created_at at time zone 'UTC')::date=(clock_now at time zone 'UTC')::date)
    +(select count(*) from jsonb_array_elements(coalesce(s->'connectionWrites','[]')) w where w#>>'{marketingPublication,day}'=to_char(clock_now at time zone 'UTC','YYYY-MM-DD'))>(b->>'dailyLimit')::integer then
   raise exception using errcode='P0L03',message='META_LEDGER_SHARED_DAILY_ALLOWANCE'; end if;
  if r->>'phase'='proposal' then raise exception using errcode='P0L01',message='META_LEDGER_PHASE'; end if;
  if r->>'phase' in ('container','publish') and exists(select 1 from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit' and phase=r->>'phase') then
   raise exception using errcode='P0L04',message='META_LEDGER_PERMANENT_PHASE_FENCE'; end if;
  if r->>'phase'='container' and n<>2 then raise exception using errcode='P0L04',message='META_LEDGER_PHASE'; end if;
  if r->>'phase'='publish' and not exists(select 1 from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='settle' and phase='container' and event->'containerConflict'='false' and event#>>'{data,resultId}' ~ '^[0-9]{1,32}$') then
   raise exception using errcode='P0L04',message='META_LEDGER_KNOWN_CONTAINER_REQUIRED'; end if;
  if r->>'phase'='read' then
   if not exists(select 1 from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit' and phase='publish')
    or exists(select 1 from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='settle' and phase='publish' and event#>'{data,resultId}'<>'null') then
     raise exception using errcode='P0L04',message='META_LEDGER_UNRESOLVED_PUBLICATION_REQUIRED'; end if;
   select count(*),min(at) into active_count,first_read from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit' and phase='read';
   select max(at) into last_read from public.runvara_meta_prod_ledger_events_v1 e where e.account_key=v_account_key and kind='admit' and phase='read';
   -- Lifetime five attempts. Window only closes admission; it never resets.
   if active_count>=5 or first_read is not null and clock_now>first_read+interval '5 minutes'
    or last_read is not null and clock_now<last_read+interval '60 seconds' then
     raise exception using errcode='P0L03',message='META_LEDGER_READ_BUDGET'; end if;
  end if;
  select count(*) into active_count from public.runvara_meta_prod_ledger_events_v1 e where e.kind='admit' and not exists(select 1 from public.runvara_meta_prod_ledger_events_v1 done where done.kind='settle' and done.event->'containerConflict'='false' and done.admission_digest=e.event_digest);
  if active_count>=2 or exists(select 1 from public.runvara_meta_prod_ledger_events_v1 e where e.kind='admit' and e.account_key=v_account_key and not exists(select 1 from public.runvara_meta_prod_ledger_events_v1 done where done.kind='settle' and done.event->'containerConflict'='false' and done.admission_digest=e.event_digest)) then
   raise exception using errcode='P0L03',message='META_LEDGER_ACTIVE_CAPACITY'; end if;
 elsif r->>'kind'='settle' then
  if exists(select 1 from public.runvara_meta_prod_ledger_events_v1 where kind='settle' and admission_digest=admission.event_digest) then raise exception using errcode='P0L04',message='META_LEDGER_SETTLEMENT_CONFLICT'; end if;
  if (public.runvara_meta_prod_exact(data,array['contract','resultId','statusCode','outcome','provenance','simulated','executedExternally','providerReadPerformed','replayPermitted'])
    and data->>'contract'=case when r->>'phase'='read' then 'runvara-meta-container-observation/production-v1' else 'runvara-meta-publication-ledger/production-v1' end
    and data->>'provenance'='server_meta_publication/production-v1' and data->'simulated'='false'
    and data->'executedExternally'=to_jsonb(r->>'phase'<>'read' and data->'resultId'<>'null')
    and data->'providerReadPerformed'=to_jsonb(r->>'phase'='read' and data->'statusCode'<>'null') and data->'replayPermitted'='false'
    and (data->'resultId'='null' or jsonb_typeof(data->'resultId')='string' and data->>'resultId' ~ '^[0-9]{1,32}$')
    and data->>'outcome'=case when data->'resultId'='null' then 'unresolved_do_not_resend' else 'provider_result_retained' end
    and case when r->>'phase'='read' then data->'resultId'='null' and (data->'statusCode'='null' or data->>'statusCode' in ('IN_PROGRESS','FINISHED','PUBLISHED','ERROR','EXPIRED')) else data->'statusCode'='null' end) is not true then
     raise exception using errcode='P0L01',message='META_LEDGER_OUTCOME_INVALID'; end if;
  if r->>'phase'='container' and data->'resultId'<>'null' and (
   exists(select 1 from public.saas_workspace_state ws cross join lateral jsonb_array_elements(coalesce(ws.state->'connectionWrites','[]')) w
     where w#>'{providerState,containerId}'=data->'resultId' or w#>'{dispatchClaim,phases,instagram_container,resultId}'=data->'resultId')
   or exists(select 1 from public.runvara_meta_prod_ledger_events_v1 e where e.kind='settle' and e.phase='container' and e.event#>'{data,resultId}'=data->'resultId')) then
    container_conflict:=true; -- Retain exact admitted evidence, keep its hold,
    -- and permanently refuse publication. Never discard a late outcome.
  end if;
 elsif r->>'kind'='recover' then
  select * into admission from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and event_digest=r->>'admissionDigest' and kind='admit' and phase='read';
  if not found or r->>'phase'<>'read' or r->'expectedState'<>'null'
   or exists(select 1 from public.runvara_meta_prod_ledger_events_v1 where admission_digest=admission.event_digest and kind in ('settle','recover'))
   or (public.runvara_meta_prod_exact(data,array['contract','reason','evidenceRef','action']) and data->>'contract'='runvara-meta-read-recovery/production-v1'
    and data->>'action'='close_unresolved_retain_hold' and jsonb_typeof(data->'reason')='string' and length(data->>'reason') between 1 and 500
    and jsonb_typeof(data->'evidenceRef')='string' and length(data->>'evidenceRef') between 1 and 500) is not true then
     raise exception using errcode='P0L04',message='META_LEDGER_RECOVERY_CONFLICT'; end if;
  -- Audit closes the logical read but retains its concurrency hold. Only the
  -- exact eventual settlement can release it; a flag/lease is not proof.
 end if;
 ev:=jsonb_build_object('contract','runvara-meta-publication-ledger/production-v1','provenance','server_meta_publication/production-v1',
  'workspaceId',r->'workspaceId','writeId',r->'writeId','sequence',n,'requestId',r->'requestId','kind',r->'kind','phase',r->'phase',
  'phaseContract',case when r->>'kind'='recover' then 'runvara-meta-read-recovery/production-v1' when r->>'phase'='read' and r->>'kind'='admit' then 'runvara-meta-read-admission/production-v1' when r->>'phase'='read' and r->>'kind'='settle' then 'runvara-meta-container-observation/production-v1' else 'runvara-meta-publication-ledger/production-v1' end,
  'approvalDigest',public.runvara_meta_prod_hash(proposal.approval_decision),
  'actor',r->'actor','bindingDigest',public.runvara_meta_prod_hash(b),'requestFingerprint',fingerprint,'previousDigest',head.event_digest,
  'admissionDigest',r->'admissionDigest','data',data,'containerConflict',container_conflict,'at',to_char(clock_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'containerId',(select e.event#>'{data,resultId}' from public.runvara_meta_prod_ledger_events_v1 e where e.workspace_id=r->>'workspaceId' and e.write_id=r->>'writeId' and e.kind='settle' and e.phase='container'),
  'publicationAdmission',(select e.event_digest from public.runvara_meta_prod_ledger_events_v1 e where e.workspace_id=r->>'workspaceId' and e.write_id=r->>'writeId' and e.kind='admit' and e.phase='publish'));
 txt:=public.runvara_meta_prod_canonical(ev);
 insert into public.runvara_meta_prod_ledger_events_v1 values(r->>'workspaceId',r->>'writeId',n,r->>'requestId',r->>'kind',r->>'phase',r->>'admissionDigest',public.runvara_meta_prod_hash(ev),fingerprint,txt,ev,clock_now,v_account_key) returning * into saved;
 update public.runvara_meta_prod_ledger_control_v1 set barrier=barrier+1,last_clock=clock_now where id;
 return public.runvara_meta_prod_ledger_ack_v1(saved,false);
end $$;
create function public.runvara_lookup_meta_prod_ledger_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; s jsonb; e public.runvara_meta_prod_ledger_events_v1;
begin
 if p_request is null or octet_length(p_request)>4096 or not public.runvara_meta_prod_unique(p_request::json) then raise exception using errcode='P0L01',message='META_LEDGER_INVALID'; end if;
 r:=p_request::jsonb;
 if (public.runvara_meta_prod_exact(r,array['contract','workspaceId','writeId','actor','requestId','requestFingerprint']) and r->>'contract'='runvara-meta-publication-ledger/production-v1'
  and r->>'requestFingerprint' ~ '^[a-f0-9]{64}$') is not true then raise exception using errcode='P0L01',message='META_LEDGER_INVALID'; end if;
 select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for share;
 perform public.runvara_meta_prod_ledger_actor_v1(s,r->'actor',r->>'workspaceId');
 select * into e from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and request_id=r->>'requestId' and request_fingerprint=r->>'requestFingerprint';
 if not found then return null; end if;
 return public.runvara_meta_prod_ledger_ack_v1(e,true);
end $$;
create function public.runvara_read_meta_prod_ledger_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; s jsonb; e public.runvara_meta_prod_ledger_events_v1;
begin
 if p_request is null or octet_length(p_request)>4096 or not public.runvara_meta_prod_unique(p_request::json) then raise exception using errcode='P0L01',message='META_LEDGER_INVALID'; end if;
 r:=p_request::jsonb;
 if (public.runvara_meta_prod_exact(r,array['contract','workspaceId','writeId','requestId','bindingDigest','actor']) and r->>'contract'='runvara-meta-publication-ledger/production-v1'
  and jsonb_typeof(r->'bindingDigest')='string' and r->>'bindingDigest' ~ '^[a-f0-9]{64}$') is not true
  or exists(select 1 from unnest(array['workspaceId','writeId','requestId']) k where jsonb_typeof(r->k) is distinct from 'string' or r->>k !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$') then
   raise exception using errcode='P0L01',message='META_LEDGER_INVALID'; end if;
 select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for share;
 perform public.runvara_meta_prod_ledger_actor_v1(s,r->'actor',r->>'workspaceId');
 select * into e from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and request_id=r->>'requestId' and event->'bindingDigest'=r->'bindingDigest';
 if not found then return null; end if;
 return public.runvara_meta_prod_ledger_ack_v1(e,true);
end $$;
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and
  (proname like 'runvara_meta_prod_ledger_%' or proname in ('runvara_commit_meta_prod_ledger_v1','runvara_lookup_meta_prod_ledger_v1','runvara_read_meta_prod_ledger_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.runvara_commit_meta_prod_ledger_v1(text),public.runvara_lookup_meta_prod_ledger_v1(text),public.runvara_read_meta_prod_ledger_v1(text) to service_role;

-- Retained bytes use the existing database. Anonymous database roles have no
-- access; the bounded server route is the only bearer delivery interface.
create table public.runvara_meta_prod_asset_control_v1 (
 id boolean primary key default true check(id), mode text not null check(mode in ('prepared','active','paused')),
 last_clock timestamptz
);
insert into public.runvara_meta_prod_asset_control_v1 values(true,'prepared',null);
create table public.runvara_meta_prod_assets_v1 (
 workspace_id text not null references public.saas_workspace_state(workspace_id) on delete restrict,
 asset_id text not null, request_id text not null, descriptor jsonb not null,
 digest text not null unique check(digest ~ '^[a-f0-9]{64}$'), bytes bytea not null check(octet_length(bytes) between 100 and 2097152),
 created_at timestamptz not null, expires_at timestamptz not null,
 primary key(workspace_id,asset_id), unique(workspace_id,request_id), check(octet_length(descriptor::text)<=16384)
);
alter table public.runvara_meta_prod_asset_control_v1 enable row level security;
alter table public.runvara_meta_prod_assets_v1 enable row level security;
revoke all on public.runvara_meta_prod_asset_control_v1,public.runvara_meta_prod_assets_v1 from public,anon,authenticated,service_role;
create trigger runvara_meta_prod_assets_immutable before update or delete on public.runvara_meta_prod_assets_v1 for each row execute function public.runvara_meta_prod_immutable();
create trigger runvara_meta_prod_assets_truncate before truncate on public.runvara_meta_prod_assets_v1 for each statement execute function public.runvara_meta_prod_immutable();
create function public.runvara_meta_prod_asset_ack_v1(a public.runvara_meta_prod_assets_v1,replayed boolean) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('contract','runvara-meta-durable-asset/production-v1','descriptorText',public.runvara_meta_prod_canonical(a.descriptor),
  'digest',a.digest,'bytesBase64',replace(encode(a.bytes,'base64'),E'\n',''),'replayed',replayed,'providerDeliveryVerified',false);
$$;
create function public.runvara_commit_meta_prod_asset_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; d jsonb; i jsonb; s jsonb; b bytea; prior public.runvara_meta_prod_assets_v1; saved public.runvara_meta_prod_assets_v1;
 control public.runvara_meta_prod_asset_control_v1; now_at timestamptz; expires timestamptz;
begin
 if p_request is null or octet_length(p_request)>5100000 or not public.runvara_meta_prod_unique(p_request::json) then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 r:=p_request::jsonb; d:=r->'descriptor'; i:=d->'image';
 if (public.runvara_meta_prod_exact(r,array['contract','descriptor','expectedState','bytesBase64']) and r->>'contract'='runvara-meta-durable-asset/production-v1'
  and public.runvara_meta_prod_exact(d,array['contract','provenance','workspaceId','campaignId','requestId','assetId','actor','selection','sourceRevision','referenceDigest','image','origin','tokenDigest','expiresAt','providerDeliveryVerified'])
  and d->>'contract'='runvara-meta-durable-asset/production-v1' and d->>'provenance'='server_meta_publication/production-v1'
  and d->'providerDeliveryVerified'='false' and d->>'origin'='https://packsmart-ops.onrender.com'
  and d->>'assetId'=public.runvara_meta_prod_hash(jsonb_build_object('workspaceId',d->'workspaceId','campaignId',d->'campaignId','requestId',d->'requestId','sha256',i->'sha256'))
  and public.runvara_meta_prod_exact(d->'selection',array['pageId','creativeRequestId','assetUrl'])
  and jsonb_typeof(d#>'{selection,pageId}')='string' and d#>>'{selection,pageId}' ~ '^[0-9]{1,32}$'
  and jsonb_typeof(d#>'{selection,creativeRequestId}')='string' and d#>>'{selection,creativeRequestId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
  and jsonb_typeof(d#>'{selection,assetUrl}')='string' and length(d#>>'{selection,assetUrl}') between 1 and 2000
  and jsonb_typeof(d->'expiresAt')='number' and d->>'expiresAt' ~ '^[1-9][0-9]{12}$'
  and public.runvara_meta_prod_exact(i,array['schema','mediaType','sha256','byteLength','width','height','pixelSha256','pixelByteLength','decoder','decoded','providerDeliveryVerified'])
  and i->>'schema'='runvara-local-jpeg-1080-baseline/v1' and i->>'mediaType'='image/jpeg'
  and i->'width'='1080' and i->'height'='1080' and i->'pixelByteLength'='4665600'
  and i->>'decoder'='jpeg-js@0.4.4/strict-baseline-ycbcr/v1' and i->'decoded'='true' and i->'providerDeliveryVerified'='false'
  and i->>'sha256' ~ '^[a-f0-9]{64}$' and i->>'pixelSha256' ~ '^[a-f0-9]{64}$'
  and jsonb_typeof(i->'byteLength')='number' and i->>'byteLength' ~ '^[1-9][0-9]{1,6}$'
  and (i->>'byteLength')::integer between 100 and 2097152
  and jsonb_typeof(r->'bytesBase64')='string' and length(r->>'bytesBase64')<=2796204
  and r->>'bytesBase64' ~ '^[A-Za-z0-9+/]+={0,2}$') is not true then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 if exists(select 1 from unnest(array['workspaceId','campaignId','requestId']) k where jsonb_typeof(d->k) is distinct from 'string' or d->>k !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$')
  or exists(select 1 from unnest(array['sourceRevision','referenceDigest','tokenDigest','assetId']) k where jsonb_typeof(d->k) is distinct from 'string' or d->>k !~ '^[a-f0-9]{64}$') then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 b:=decode(r->>'bytesBase64','base64');
 if octet_length(b)<>(i->>'byteLength')::integer or encode(sha256(b),'hex')<>i->>'sha256'
  or replace(encode(b,'base64'),E'\n','')<>r->>'bytesBase64' or substring(b from 1 for 2)<>decode('ffd8','hex') or substring(b from octet_length(b)-1 for 2)<>decode('ffd9','hex') then
  raise exception using errcode='P0A01',message='META_ASSET_BYTES_INVALID'; end if;
 select * into control from public.runvara_meta_prod_asset_control_v1 where id for update;
 if not found or control.mode<>'active' then raise exception using errcode='P0A03',message='META_ASSET_CLOSED'; end if;
 -- Nonwaiting lock avoids a cycle with old workspace writers. Clock sampled
 -- only after both locks; expiry and permanent capacity cannot be renewed.
 select state into s from public.saas_workspace_state where workspace_id=d->>'workspaceId' for share nowait;
 now_at:=clock_timestamp();
 if control.last_clock>now_at then raise exception using errcode='P0A03',message='META_ASSET_CLOCK'; end if;
 perform public.runvara_meta_prod_ledger_actor_v1(s,d->'actor',d->>'workspaceId');
 select * into prior from public.runvara_meta_prod_assets_v1 where workspace_id=d->>'workspaceId' and request_id=d->>'requestId';
 if found then
  if prior.descriptor is distinct from d or prior.bytes is distinct from b then raise exception using errcode='P0A04',message='META_ASSET_REQUEST_CONFLICT'; end if;
  return public.runvara_meta_prod_asset_ack_v1(prior,true);
 end if;
 if s is distinct from r->'expectedState' then raise exception using errcode='P0A04',message='META_ASSET_SOURCE_CHANGED'; end if;
 if (select count(*) from jsonb_array_elements(s#>'{marketing,campaigns}') c where c->'id'=d->'campaignId')<>1 then raise exception using errcode='P0A04',message='META_ASSET_CAMPAIGN'; end if;
 if (select count(*) from public.runvara_meta_prod_assets_v1)>=128 or (select count(*) from public.runvara_meta_prod_assets_v1 where workspace_id=d->>'workspaceId')>=16 then raise exception using errcode='P0A03',message='META_ASSET_CAPACITY'; end if;
 expires:=to_timestamp((d->>'expiresAt')::numeric/1000);
 if expires<now_at+interval '5 minutes' or expires>now_at+interval '24 hours' then raise exception using errcode='P0A03',message='META_ASSET_EXPIRY'; end if;
 insert into public.runvara_meta_prod_assets_v1 values(d->>'workspaceId',d->>'assetId',d->>'requestId',d,public.runvara_meta_prod_hash(d),b,now_at,expires) returning * into saved;
 update public.runvara_meta_prod_asset_control_v1 set last_clock=now_at where id;
 return public.runvara_meta_prod_asset_ack_v1(saved,false);
end $$;
create function public.runvara_read_meta_prod_asset_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; s jsonb; a public.runvara_meta_prod_assets_v1;
begin
 if p_request is null or octet_length(p_request)>4096 or not public.runvara_meta_prod_unique(p_request::json) then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 r:=p_request::jsonb;
 if (public.runvara_meta_prod_exact(r,array['contract','workspaceId','assetId','digest','actor']) and r->>'contract'='runvara-meta-durable-asset/production-v1'
  and jsonb_typeof(r->'workspaceId')='string' and r->>'workspaceId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
  and jsonb_typeof(r->'assetId')='string' and r->>'assetId' ~ '^[a-f0-9]{64}$'
  and jsonb_typeof(r->'digest')='string' and r->>'digest' ~ '^[a-f0-9]{64}$') is not true then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for share;
 perform public.runvara_meta_prod_ledger_actor_v1(s,r->'actor',r->>'workspaceId');
 select * into a from public.runvara_meta_prod_assets_v1 where workspace_id=r->>'workspaceId' and asset_id=r->>'assetId' and digest=r->>'digest';
 if not found then return null; end if;
 return public.runvara_meta_prod_asset_ack_v1(a,true);
end $$;
create function public.runvara_deliver_meta_prod_asset_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; a public.runvara_meta_prod_assets_v1; c public.runvara_meta_prod_asset_control_v1; now_at timestamptz; s jsonb; b jsonb;
begin
 if p_request is null or octet_length(p_request)>1024 or not public.runvara_meta_prod_unique(p_request::json) then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 r:=p_request::jsonb;
 if (public.runvara_meta_prod_exact(r,array['contract','digest','token']) and r->>'contract'='runvara-meta-durable-asset/production-v1'
  and jsonb_typeof(r->'digest')='string' and r->>'digest' ~ '^[a-f0-9]{64}$'
  and jsonb_typeof(r->'token')='string' and r->>'token' ~ '^[a-f0-9]{64}$') is not true then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 select * into c from public.runvara_meta_prod_asset_control_v1 where id for update; now_at:=clock_timestamp();
 if not found or c.mode<>'active' or c.last_clock>now_at then raise exception using errcode='P0A03',message='META_ASSET_CLOSED'; end if;
 -- Preserve the high-water clock even on expiry/missing-token denial. A later
 -- backwards clock must never make an already expired delivery work again.
 update public.runvara_meta_prod_asset_control_v1 set last_clock=now_at where id;
 select * into a from public.runvara_meta_prod_assets_v1 where digest=r->>'digest' and descriptor->>'tokenDigest'=encode(sha256(convert_to(r->>'token','UTF8')),'hex') and expires_at>now_at;
 if not found then return null; end if;
 select state into s from public.saas_workspace_state where workspace_id=a.workspace_id for share nowait;
 perform public.runvara_meta_prod_ledger_actor_v1(s,a.descriptor->'actor',a.workspace_id);
 if (select count(*) from jsonb_array_elements(coalesce(s->'approvals','[]')) approval
  where approval->>'type'='protected_meta_production_publication' and approval#>>'{payload,binding,asset,deliveryDigest}'=a.digest and approval->>'status'='approved')<>1 then return null; end if;
 select approval#>'{payload,binding}' into b from jsonb_array_elements(s->'approvals') approval
  where approval->>'type'='protected_meta_production_publication' and approval#>>'{payload,binding,asset,deliveryDigest}'=a.digest and approval->>'status'='approved';
 perform public.runvara_meta_prod_ledger_binding_v1(s,b,a.descriptor->'actor');
 return public.runvara_meta_prod_asset_ack_v1(a,true);
end $$;
-- Every production proposal and admission must name the immutable retained JPEG.
create function public.runvara_meta_prod_asset_ledger_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare b jsonb; a public.runvara_meta_prod_assets_v1; c public.runvara_meta_prod_asset_control_v1; now_at timestamptz;
begin
 if tg_table_name='runvara_meta_prod_ledger_proposals_v1' then b:=new.binding;
 elsif new.kind='admit' and new.phase in ('container','publish') then
  select binding into b from public.runvara_meta_prod_ledger_proposals_v1 where workspace_id=new.workspace_id and write_id=new.write_id;
 else return new; end if;
 if b#>>'{asset,mediaType}' is distinct from 'image/jpeg' then raise exception using errcode='P0A04',message='META_ASSET_BINDING_REQUIRED'; end if;
 select * into c from public.runvara_meta_prod_asset_control_v1 where id for share nowait; now_at:=clock_timestamp();
 if not found or c.mode<>'active' or c.last_clock>now_at then raise exception using errcode='P0A03',message='META_ASSET_CLOSED'; end if;
 select * into a from public.runvara_meta_prod_assets_v1 where workspace_id=b->>'workspaceId' and digest=b#>>'{asset,deliveryDigest}';
 if not found or a.expires_at<now_at+interval '60 seconds' or a.descriptor->'actor' is distinct from b->'actor'
  or a.descriptor->'campaignId' is distinct from b->'campaignId' or a.descriptor->'sourceRevision' is distinct from b->'sourceRevision'
  or a.descriptor->'selection' is distinct from b->'selection' or a.descriptor#>'{image,sha256}' is distinct from b#>'{asset,sha256}'
  or a.descriptor#>'{image,byteLength}' is distinct from b#>'{asset,byteLength}' then raise exception using errcode='P0A04',message='META_ASSET_BINDING_REQUIRED'; end if;
 return new;
end $$;
create trigger runvara_meta_prod_asset_proposal_guard before insert on public.runvara_meta_prod_ledger_proposals_v1 for each row execute function public.runvara_meta_prod_asset_ledger_guard_v1();
create trigger runvara_meta_prod_asset_admission_guard before insert on public.runvara_meta_prod_ledger_events_v1 for each row execute function public.runvara_meta_prod_asset_ledger_guard_v1();
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and
  (proname like 'runvara_meta_prod_asset_%' or proname in ('runvara_commit_meta_prod_asset_v1','runvara_read_meta_prod_asset_v1','runvara_deliver_meta_prod_asset_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.runvara_commit_meta_prod_asset_v1(text),public.runvara_read_meta_prod_asset_v1(text),public.runvara_deliver_meta_prod_asset_v1(text) to service_role;

-- PREPARED ONLY. Exact-container readiness before publication, sharing the
-- existing ledger's lock, lifetime read budget, account cadence and held slots.
-- Existing post-publication observation contract/provenance is unchanged.
create table public.runvara_meta_prod_readiness_v1 (
 workspace_id text not null, write_id text not null, request_id text not null,
 kind text not null check(kind in ('admit','settle')), attempt integer not null check(attempt between 1 and 5),
 admission_digest text, event jsonb not null, event_text text not null check(octet_length(event_text)<=4096),
 digest text not null unique, fingerprint text not null, at timestamptz not null, account_key text not null,
 primary key(workspace_id,request_id),
 foreign key(workspace_id,write_id) references public.runvara_meta_prod_ledger_proposals_v1(workspace_id,write_id) on delete restrict
);
create unique index runvara_meta_prod_readiness_settled_once on public.runvara_meta_prod_readiness_v1(admission_digest) where kind='settle';
alter table public.runvara_meta_prod_readiness_v1 enable row level security;
revoke all on public.runvara_meta_prod_readiness_v1 from public,anon,authenticated,service_role;
create trigger runvara_meta_prod_readiness_immutable before update or delete on public.runvara_meta_prod_readiness_v1 for each row execute function public.runvara_meta_prod_immutable();
create trigger runvara_meta_prod_readiness_truncate before truncate on public.runvara_meta_prod_readiness_v1 for each statement execute function public.runvara_meta_prod_immutable();
create function public.runvara_meta_prod_readiness_ack_v1(e public.runvara_meta_prod_readiness_v1,replayed boolean) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('eventText',e.event_text,'digest',e.digest,'replayed',replayed);
$$;
create function public.runvara_commit_meta_prod_readiness_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; b jsonb; s jsonb; p public.runvara_meta_prod_ledger_proposals_v1; c public.runvara_meta_prod_ledger_control_v1;
 a public.runvara_meta_prod_readiness_v1; old public.runvara_meta_prod_readiness_v1; saved public.runvara_meta_prod_readiness_v1;
 now_at timestamptz; first_at timestamptz; last_at timestamptz; n integer; v_account text; container text; fingerprint text; ev jsonb; decision jsonb;
begin
 if p_request is null or octet_length(p_request)>2200000 or not public.runvara_meta_prod_unique(p_request::json) then raise exception using errcode='P0R01',message='META_READINESS_INVALID'; end if;
 r:=p_request::jsonb; b:=r->'binding'; fingerprint:=public.runvara_meta_prod_hash(r-'expectedState');
 if (public.runvara_meta_prod_exact(r,array['contract','workspaceId','writeId','requestId','kind','actor','binding','expectedState','admissionDigest','statusCode'])
  and r->>'contract'='runvara-meta-container-readiness/production-v1' and r->>'kind' in ('admit','settle')
  and r->'workspaceId'=b->'workspaceId' and r->'writeId'=b->'writeId'
  and (r->'admissionDigest'='null' or jsonb_typeof(r->'admissionDigest')='string' and r->>'admissionDigest' ~ '^[a-f0-9]{64}$')) is not true
  or exists(select 1 from unnest(array['workspaceId','writeId','requestId']) k where jsonb_typeof(r->k) is distinct from 'string' or r->>k !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$') then raise exception using errcode='P0R01',message='META_READINESS_INVALID'; end if;
 select * into c from public.runvara_meta_prod_ledger_control_v1 where id for update;
 if not found then raise exception using errcode='P0R03',message='META_READINESS_CLOSED'; end if;
 select * into p from public.runvara_meta_prod_ledger_proposals_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId';
 if not found or p.binding is distinct from b then raise exception using errcode='P0R04',message='META_READINESS_BINDING'; end if;
 if r->>'kind'='admit' then
  select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for share nowait;
  perform public.runvara_meta_prod_ledger_actor_v1(s,r->'actor',r->>'workspaceId');
 else
  select * into a from public.runvara_meta_prod_readiness_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and digest=r->>'admissionDigest' and kind='admit';
  if not found or a.event->'actor' is distinct from r->'actor' or r->'expectedState'<>'null' then raise exception using errcode='P0R04',message='META_READINESS_ADMISSION_REQUIRED'; end if;
 end if;
 now_at:=clock_timestamp(); if c.last_clock>now_at then raise exception using errcode='P0R03',message='META_READINESS_CLOCK'; end if;
 select * into old from public.runvara_meta_prod_readiness_v1 where workspace_id=r->>'workspaceId' and request_id=r->>'requestId';
 if found then if old.fingerprint<>fingerprint then raise exception using errcode='P0R04',message='META_READINESS_REPLAY_CONFLICT'; end if;
  return public.runvara_meta_prod_readiness_ack_v1(old,true); end if;
 v_account:='meta:'||(b#>>'{target,account}')||':'||(b#>>'{target,instagramId}');
 select event#>>'{data,resultId}' into container from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='settle' and phase='container' and event->'containerConflict'='false';
 if container is null or container !~ '^[0-9]{1,32}$' then raise exception using errcode='P0R04',message='META_READINESS_CONTAINER_REQUIRED'; end if;
 if r->>'kind'='admit' then
  if c.mode<>'active' or r->'admissionDigest'<>'null' or r->'statusCode'<>'null' or s is distinct from r->'expectedState'
   or exists(select 1 from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit' and phase='publish') then raise exception using errcode='P0R03',message='META_READINESS_CLOSED_OR_CHANGED'; end if;
  perform public.runvara_meta_prod_ledger_binding_v1(s,b,r->'actor');
  select value-array['executedExternally','executionStatus','workStatus'] into decision from jsonb_array_elements(s->'approvals') where value->'id'=b->'approvalId';
  if decision is distinct from p.approval_decision then raise exception using errcode='P0R04',message='META_READINESS_APPROVAL_CHANGED'; end if;
  select count(*),min(at) into n,first_at from (
   select at from public.runvara_meta_prod_readiness_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit'
   union all select at from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit' and phase='read') attempts;
  select max(at) into last_at from (
   select at from public.runvara_meta_prod_readiness_v1 where account_key=v_account and kind='admit'
   union all select at from public.runvara_meta_prod_ledger_events_v1 where account_key=v_account and kind='admit' and phase='read') attempts;
  if n>=5 or first_at is not null and now_at>first_at+interval '5 minutes' or last_at is not null and now_at<last_at+interval '60 seconds' then raise exception using errcode='P0R03',message='META_READINESS_BUDGET'; end if;
  if (select count(*) from (
   select e.account_key from public.runvara_meta_prod_readiness_v1 e where kind='admit' and not exists(select 1 from public.runvara_meta_prod_readiness_v1 x where x.kind='settle' and x.admission_digest=e.digest)
   union all select e.account_key from public.runvara_meta_prod_ledger_events_v1 e where kind='admit' and not exists(select 1 from public.runvara_meta_prod_ledger_events_v1 x where x.kind='settle' and x.admission_digest=e.event_digest and x.event->'containerConflict'='false')) held)>=2
   or exists(select 1 from (
    select e.account_key from public.runvara_meta_prod_readiness_v1 e where kind='admit' and not exists(select 1 from public.runvara_meta_prod_readiness_v1 x where x.kind='settle' and x.admission_digest=e.digest)
    union all select e.account_key from public.runvara_meta_prod_ledger_events_v1 e where kind='admit' and not exists(select 1 from public.runvara_meta_prod_ledger_events_v1 x where x.kind='settle' and x.admission_digest=e.event_digest and x.event->'containerConflict'='false')) held where account_key=v_account) then raise exception using errcode='P0R03',message='META_READINESS_ACTIVE_LIMIT'; end if;
  n:=n+1;
 else
  n:=a.attempt;
  if r->>'statusCode' not in ('IN_PROGRESS','FINISHED','PUBLISHED','ERROR','EXPIRED') or jsonb_typeof(r->'statusCode') is distinct from 'string'
   or exists(select 1 from public.runvara_meta_prod_readiness_v1 where kind='settle' and admission_digest=a.digest) then raise exception using errcode='P0R04',message='META_READINESS_SETTLEMENT'; end if;
 end if;
 ev:=jsonb_build_object('contract','runvara-meta-container-readiness/production-v1','provenance','server_meta_publication/production-v1',
  'workspaceId',r->'workspaceId','writeId',r->'writeId','requestId',r->'requestId','kind',r->'kind','actor',r->'actor',
  'bindingDigest',p.binding_digest,'containerId',container,'attempt',n,'admissionDigest',r->'admissionDigest','statusCode',r->'statusCode',
  'approvalDigest',public.runvara_meta_prod_hash(p.approval_decision),'at',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'requestFingerprint',fingerprint,'providerReadPerformed',r->>'kind'='settle');
 insert into public.runvara_meta_prod_readiness_v1 values(r->>'workspaceId',r->>'writeId',r->>'requestId',r->>'kind',n,r->>'admissionDigest',ev,public.runvara_meta_prod_canonical(ev),public.runvara_meta_prod_hash(ev),fingerprint,now_at,v_account) returning * into saved;
 update public.runvara_meta_prod_ledger_control_v1 set barrier=barrier+1,last_clock=now_at where id;
 return public.runvara_meta_prod_readiness_ack_v1(saved,false);
end $$;
create function public.runvara_read_meta_prod_readiness_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; s jsonb; a public.runvara_meta_prod_readiness_v1; done public.runvara_meta_prod_readiness_v1;
 p public.runvara_meta_prod_ledger_proposals_v1; n integer; first_at timestamptz; last_at timestamptz; v_account text;
begin
 if p_request is null or octet_length(p_request)>4096 or not public.runvara_meta_prod_unique(p_request::json) then raise exception using errcode='P0R01',message='META_READINESS_INVALID'; end if;
 r:=p_request::jsonb;
 if (public.runvara_meta_prod_exact(r,array['contract','workspaceId','writeId','bindingDigest','actor']) and r->>'contract'='runvara-meta-container-readiness/production-v1'
  and r->>'bindingDigest' ~ '^[a-f0-9]{64}$') is not true then raise exception using errcode='P0R01',message='META_READINESS_INVALID'; end if;
 select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for share;
 perform public.runvara_meta_prod_ledger_actor_v1(s,r->'actor',r->>'workspaceId');
 select * into p from public.runvara_meta_prod_ledger_proposals_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and binding_digest=r->>'bindingDigest';
 if not found then return null; end if;
 v_account:='meta:'||(p.binding#>>'{target,account}')||':'||(p.binding#>>'{target,instagramId}');
 select * into a from public.runvara_meta_prod_readiness_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit' and event->'bindingDigest'=r->'bindingDigest' order by attempt desc limit 1;
 select * into done from public.runvara_meta_prod_readiness_v1 where kind='settle' and admission_digest=a.digest;
 select count(*),min(at) into n,first_at from (
  select at from public.runvara_meta_prod_readiness_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit'
  union all select at from public.runvara_meta_prod_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit' and phase='read') attempts;
 select max(at) into last_at from (
  select at from public.runvara_meta_prod_readiness_v1 where account_key=v_account and kind='admit'
  union all select at from public.runvara_meta_prod_ledger_events_v1 where account_key=v_account and kind='admit' and phase='read') attempts;
 return jsonb_build_object('admission',case when a.digest is null then null else public.runvara_meta_prod_readiness_ack_v1(a,true) end,
  'settlement',case when done.digest is null then null else public.runvara_meta_prod_readiness_ack_v1(done,true) end,
  'budget',jsonb_build_object('attempts',n,'firstAt',to_char(first_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'lastAt',to_char(last_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
end $$;
-- Sharing the lock is insufficient unless admissions in both contracts count
-- both kinds of held work and read debt. This guard enforces the reverse order.
create function public.runvara_meta_prod_readiness_ledger_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.runvara_meta_prod_readiness_v1; done public.runvara_meta_prod_readiness_v1; ready_count integer; held_count integer; first_at timestamptz; last_at timestamptz;
begin
 if new.kind<>'admit' then return new; end if;
 select count(*) into held_count from public.runvara_meta_prod_readiness_v1 r where kind='admit' and not exists(select 1 from public.runvara_meta_prod_readiness_v1 x where x.kind='settle' and x.admission_digest=r.digest);
 if held_count+(select count(*) from public.runvara_meta_prod_ledger_events_v1 e where kind='admit' and not exists(select 1 from public.runvara_meta_prod_ledger_events_v1 x where x.kind='settle' and x.admission_digest=e.event_digest and x.event->'containerConflict'='false'))>=2
  or exists(select 1 from public.runvara_meta_prod_readiness_v1 r where kind='admit' and account_key=new.account_key and not exists(select 1 from public.runvara_meta_prod_readiness_v1 x where x.kind='settle' and x.admission_digest=r.digest)) then raise exception using errcode='P0R03',message='META_READINESS_SHARED_ACTIVE'; end if;
 if new.phase='read' then
  select count(*),min(at) into ready_count,first_at from public.runvara_meta_prod_readiness_v1 where workspace_id=new.workspace_id and write_id=new.write_id and kind='admit';
  select max(at) into last_at from public.runvara_meta_prod_readiness_v1 where account_key=new.account_key and kind='admit';
  if ready_count+(select count(*) from public.runvara_meta_prod_ledger_events_v1 where workspace_id=new.workspace_id and write_id=new.write_id and kind='admit' and phase='read')>=5
   or first_at is not null and new.at>first_at+interval '5 minutes' or last_at is not null and new.at<last_at+interval '60 seconds' then raise exception using errcode='P0R03',message='META_READINESS_SHARED_BUDGET'; end if;
 end if;
 if new.phase='publish' and exists(select 1 from public.runvara_meta_prod_ledger_proposals_v1 p where p.workspace_id=new.workspace_id and p.write_id=new.write_id and p.binding#>>'{asset,mediaType}'='image/jpeg') then
  select * into a from public.runvara_meta_prod_readiness_v1 where workspace_id=new.workspace_id and write_id=new.write_id and kind='admit' order by attempt desc limit 1;
  select * into done from public.runvara_meta_prod_readiness_v1 where kind='settle' and admission_digest=a.digest;
  if a.digest is null or done.event->>'statusCode' is distinct from 'FINISHED' or a.at<=new.at-interval '60 seconds' or done.at<a.at or done.at>new.at or a.event->'containerId' is distinct from new.event->'containerId'
   or a.event->'actor' is distinct from new.event->'actor' or a.event->'approvalDigest' is distinct from new.event->'approvalDigest' then raise exception using errcode='P0R04',message='META_READINESS_REQUIRED'; end if;
 end if;
 return new;
end $$;
create trigger runvara_meta_prod_readiness_admission_guard before insert on public.runvara_meta_prod_ledger_events_v1 for each row execute function public.runvara_meta_prod_readiness_ledger_guard_v1();
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and
  (proname like 'runvara_meta_prod_readiness_%' or proname in ('runvara_commit_meta_prod_readiness_v1','runvara_read_meta_prod_readiness_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.runvara_commit_meta_prod_readiness_v1(text),public.runvara_read_meta_prod_readiness_v1(text) to service_role;


-- Protect the pending approval too: an older JSONB writer must not remove or
-- rewrite it before the first durable ledger admission. This has no trusted
-- writer flag and is enforced for every service-role workspace write.
create function public.runvara_meta_prod_approval_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare a jsonb; previous jsonb; b jsonb; d jsonb; consent jsonb; checked jsonb; review_state jsonb; retained public.runvara_meta_prod_assets_v1;
begin
 if tg_op<>'INSERT' then
  for previous in select value from jsonb_array_elements(coalesce(old.state->'approvals','[]')) where value->>'type'='protected_meta_production_publication' loop
   if tg_op='DELETE' or old.workspace_id is distinct from new.workspace_id
    or (select count(*) from jsonb_array_elements(coalesce(new.state->'approvals','[]')) r where r->'id'=previous->'id')<>1 then
    raise exception using errcode='P0L05',message='META_PRODUCTION_APPROVAL_PROTECTED'; end if;
   select r into a from jsonb_array_elements(new.state->'approvals') r where r->'id'=previous->'id';
   if (a-array['status','decidedAt','decidedBy','metaProductionConsent','history']) is distinct from
      (previous-array['status','decidedAt','decidedBy','metaProductionConsent','history'])
    or a is distinct from previous and not (previous->>'status'='pending' and a->>'status' in ('approved','rejected')
      or previous->>'status'='approved' and a->>'status'='rejected') then
    raise exception using errcode='P0L05',message='META_PRODUCTION_APPROVAL_PROTECTED'; end if;
  end loop;
 end if;
 if tg_op='DELETE' then return old; end if;
 for a in select value from jsonb_array_elements(coalesce(new.state->'approvals','[]')) where value->>'type'='protected_meta_production_publication' loop
  b:=a#>'{payload,binding}'; d:=a#>'{payload,delivery}'; previous:=null;
  if tg_op='UPDATE' then select r into previous from jsonb_array_elements(coalesce(old.state->'approvals','[]')) r where r->'id'=a->'id'; end if;
  if public.runvara_meta_prod_ledger_conflicts_v1(new.state,b) then raise exception using errcode='P0L05',message='META_LEDGER_PROTECTED'; end if;
  if a is not distinct from previous then continue; end if;
  consent:=jsonb_build_object('contract','runvara-meta-publication-ledger/production-v1','bindingDigest',public.runvara_meta_prod_hash(b),
   'sourceRevision',b->'sourceRevision','imageSha256',b#>'{asset,sha256}','byteLength',b#>'{asset,byteLength}',
   'caption',b->'caption','target',b->'target','postCount',1);
  if a->'workspaceId' is distinct from to_jsonb(new.workspace_id) or a->'id' is distinct from b->'approvalId'
   or a#>>'{payload,contract}' is distinct from 'runvara-meta-publication-ledger/production-v1'
   or a#>>'{payload,bindingDigest}' is distinct from public.runvara_meta_prod_hash(b)
   or b#>>'{asset,deliveryDigest}' is distinct from public.runvara_meta_prod_hash(d)
   or a->'revision' is distinct from '1'::jsonb or b->'approvalRevision' is distinct from '1'::jsonb then
   raise exception using errcode='P0L05',message='META_PRODUCTION_APPROVAL_PROTECTED'; end if;
  if previous is null then
   if a->>'status' is distinct from 'pending' or a->'decidedBy' is distinct from 'null'::jsonb
    or coalesce(a->'metaProductionConsent','null')<>'null' then raise exception using errcode='P0L05',message='META_PRODUCTION_APPROVAL_PROTECTED'; end if;
   select * into retained from public.runvara_meta_prod_assets_v1 where workspace_id=new.workspace_id and digest=b#>>'{asset,deliveryDigest}';
   if not found or retained.descriptor is distinct from d or d->'actor' is distinct from b->'actor'
    or d->'campaignId' is distinct from b->'campaignId' or d->'sourceRevision' is distinct from b->'sourceRevision'
    or d->'selection' is distinct from b->'selection' or d#>'{image,sha256}' is distinct from b#>'{asset,sha256}'
    or d#>'{image,byteLength}' is distinct from b#>'{asset,byteLength}' then raise exception using errcode='P0L05',message='META_PRODUCTION_ASSET_REQUIRED'; end if;
  elsif a->'metaProductionConsent' is distinct from consent then
   raise exception using errcode='P0L05',message='META_PRODUCTION_CONSENT_REQUIRED';
  end if;
  if previous is null or a->>'status'='approved' then
   if (select mode from public.runvara_meta_prod_ledger_control_v1 where id) is distinct from 'active'
    or (select mode from public.runvara_meta_prod_asset_control_v1 where id) is distinct from 'active' then raise exception using errcode='P0L03',message='META_PRODUCTION_CLOSED'; end if;
   checked:=a||jsonb_build_object('status','approved','decidedBy',b#>'{actor,userId}','metaProductionConsent',consent);
   review_state:=jsonb_set(new.state,'{approvals}',(select jsonb_agg(case when r->'id'=a->'id' then checked else r end) from jsonb_array_elements(new.state->'approvals') r));
   perform public.runvara_meta_prod_ledger_binding_v1(review_state,b,b->'actor');
   if a->>'status'='approved' and a->'decidedBy' is distinct from b#>'{actor,userId}' then raise exception using errcode='P0L02',message='META_LEDGER_AUTHORITY'; end if;
  end if;
 end loop;
 return new;
end $$;
create trigger runvara_meta_prod_approval_guard before insert or update or delete on public.saas_workspace_state for each row execute function public.runvara_meta_prod_approval_guard_v1();

-- Pure helpers also have no caller grants. Only bounded RPC entry points are
-- callable by the existing service role; no direct table privilege is added.
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'runvara_meta_prod_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
commit;
