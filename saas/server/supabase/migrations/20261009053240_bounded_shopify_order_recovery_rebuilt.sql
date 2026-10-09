-- NEW CANDIDATE rebuilt from accepted 0cebdb5c, not recovered historical bytes.
-- PREPARED ONLY: no activation, abandonment, expiry, purge or backfill.
-- Logical quotas include immutable receipts; they are not physical/dollar caps.
begin;
create table public.runvara_order_recovery_control (
  id boolean primary key default true check(id),
  mode text not null check(mode in ('prepared','enforced','paused'))
);
insert into public.runvara_order_recovery_control values(true,'prepared');
create table public.runvara_order_recovery_quota (
  id boolean primary key default true check(id),
  unfinished_stages integer not null check(unfinished_stages between 0 and 8),
  logical_bytes bigint not null check(logical_bytes between 4096 and 16777216)
);
insert into public.runvara_order_recovery_quota values(true,0,4096);
create table public.runvara_order_recovery_stages (
  workspace_id text primary key references public.saas_workspace_state(workspace_id) on delete restrict,
  stage_id text not null unique,
  stage jsonb not null,
  operations jsonb not null default '[]',
  superseded boolean not null default false,
  logical_bytes integer not null check(logical_bytes between 0 and 2097152),
  pending_revision text,
  pending_digest text,
  unique(workspace_id,stage_id)
);
create table public.runvara_order_recovery_pages (
  workspace_id text not null,
  stage_id text not null,
  page_index integer not null check(page_index between 0 and 9),
  page jsonb not null,
  primary key(workspace_id,stage_id,page_index),
  foreign key(workspace_id,stage_id) references public.runvara_order_recovery_stages(workspace_id,stage_id) on delete restrict
);
create table public.runvara_order_recovery_receipts (
  workspace_id text not null references public.saas_workspace_state(workspace_id) on delete restrict,
  stage_id text not null unique,
  receipt jsonb not null,
  logical_bytes integer not null check(logical_bytes between 1 and 16384),
  primary key(workspace_id,stage_id)
);

create function public.runvara_recovery_exact(v jsonb,keys text[]) returns boolean
language sql immutable security invoker set search_path='' as $$
 select case when jsonb_typeof(v)='object' then v ?& keys and v-keys='{}'::jsonb else false end
$$;
create function public.runvara_recovery_compact(v jsonb) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare t text;
begin
 case jsonb_typeof(v)
 when 'object' then select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.runvara_recovery_compact(value),',' order by key collate "C"),'')||'}' into t from jsonb_each(v);
 when 'array' then select '['||coalesce(string_agg(public.runvara_recovery_compact(value),',' order by ordinality),'')||']' into t from jsonb_array_elements(v) with ordinality;
 when 'number' then t:=(v::numeric)::text; if strpos(t,'.')>0 then t:=rtrim(rtrim(t,'0'),'.'); end if;
 else t:=v::text;
 end case;
 return t;
end $$;
create function public.runvara_recovery_hash(v jsonb) returns text language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to(public.runvara_recovery_compact(v),'UTF8')),'hex')
$$;
create function public.runvara_recovery_utf16(t text) returns integer language sql immutable security invoker set search_path='' as $$
 select coalesce(sum(case when ascii(ch)>65535 then 2 else 1 end),0)::integer from regexp_split_to_table(t,'') ch
$$;
create function public.runvara_recovery_trim(t text) returns text language sql immutable security invoker set search_path='' as $$
 select btrim(t,U&'\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff')
$$;
create function public.runvara_recovery_id(v jsonb) returns boolean language sql immutable security invoker set search_path='' as $$
 select coalesce(jsonb_typeof(v)='string' and public.runvara_recovery_utf16(v#>>'{}') between 1 and 256 and (v#>>'{}')=public.runvara_recovery_trim(v#>>'{}') and (v#>>'{}')!~'[[:cntrl:]]',false)
$$;
create function public.runvara_recovery_int(v jsonb,lo bigint,hi bigint) returns boolean language sql immutable security invoker set search_path='' as $$
 select case when jsonb_typeof(v)='number' then (v::text)::numeric between lo and hi and trunc((v::text)::numeric)=(v::text)::numeric else false end
$$;
create function public.runvara_recovery_date(v jsonb,canonical boolean default true) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare d timestamptz; t text:=v#>>'{}';
begin
 if jsonb_typeof(v) is distinct from 'string' or t!~'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d' then return false; end if;
 d:=t::timestamptz;
 return isfinite(d) and t ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$' and (not canonical or (t ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' and to_char(d at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=t));
 exception when others then return false;
end $$;
create function public.runvara_recovery_actor(s jsonb,a jsonb) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare u jsonb; n integer;
begin
 if not public.runvara_recovery_exact(a,array['id','sessionVersion','sessionDigest','expiresAt'])
   or not public.runvara_recovery_id(a->'id') or not public.runvara_recovery_int(a->'sessionVersion',1,9007199254740991)
   or (jsonb_typeof(a->'sessionDigest')='string' and a->>'sessionDigest' ~ '^[0-9a-f]{64}$') is not true
   or not public.runvara_recovery_date(a->'expiresAt') then raise exception using errcode='P0Q02',message='ORDER_RECOVERY_ACTOR_INVALID'; end if;
 select count(*),jsonb_agg(value)->0 into n,u from jsonb_array_elements(s->'users') where value->>'id'=a->>'id';
 if n is distinct from 1 or (u->>'role' in ('owner','admin')) is not true or coalesce(u->'active','true') is distinct from 'true'::jsonb
   or coalesce(u->'passwordChangeRequired','false') is distinct from 'false'::jsonb or coalesce(u->'sessionVersion','1') is distinct from a->'sessionVersion'
   or (a->>'expiresAt')::timestamptz<=clock_timestamp() then raise exception using errcode='P0Q02',message='ORDER_RECOVERY_AUTHORITY_CHANGED'; end if;
end $$;
create function public.runvara_recovery_binding(s jsonb,b jsonb) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare src jsonb; c jsonb; n integer; w jsonb; f jsonb; lower_bound text;
begin
 if not public.runvara_recovery_exact(b,array['schema','workspaceId','source','parserPolicy','queryPolicy','settingsRevision','sourceGeneration','startedAt','window','firstSync'])
   or b->>'schema' is distinct from 'shopify-order-recovery-binding/v1' or b->>'workspaceId' is distinct from s#>>'{workspace,id}'
   or b->>'parserPolicy' is distinct from 'shopify-order-source/v1' or b->>'queryPolicy' is distinct from 'shopify-orders-v2:90-day-updated-window:10-pages:50-orders:100-lines'
   or not public.runvara_recovery_date(b->'startedAt') or not public.runvara_recovery_int(b->'settingsRevision',0,9007199254740991)
   or b->'settingsRevision' is distinct from coalesce(s#>'{connectionSettings,shopify,revision}','0'::jsonb)
   or coalesce(s#>'{connectionSettings,shopify,disconnected}','false') is distinct from 'false'::jsonb
   or not (b->'sourceGeneration'='null'::jsonb or jsonb_typeof(b->'sourceGeneration')='string' and b->>'sourceGeneration' ~ '^sor[123]:[0-9a-f]{64}$')
   or b->'sourceGeneration' is distinct from coalesce(s#>'{channelData,shopify,orderReads,lastSuccess}','null') then
   raise exception using errcode='P0Q02',message='ORDER_RECOVERY_SOURCE_CHANGED'; end if;
 src:=b->'source';
 if not public.runvara_recovery_exact(src,array['schema','workspaceId','provider','domain','connectionId','accountId','apiVersion','sourcePolicy'])
   or src->>'schema' is distinct from 'shopify-order-hold/v1' or src->'workspaceId' is distinct from b->'workspaceId' or src->>'provider' is distinct from 'shopify'
   or src->>'sourcePolicy' is distinct from b->>'queryPolicy' or not public.runvara_recovery_id(src->'connectionId')
   or (src->>'domain' ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' and src->>'apiVersion' ~ '^20\d\d-(01|04|07|10)$') is not true
   or exists(select 1 from jsonb_each(src) where jsonb_typeof(value) is distinct from 'string' or public.runvara_recovery_utf16(value#>>'{}')>300 or value#>>'{}' is distinct from public.runvara_recovery_trim(value#>>'{}') or value#>>'{}' ~ '[[:cntrl:]]') then
   raise exception using errcode='P0Q02',message='ORDER_RECOVERY_SOURCE_INVALID'; end if;
 select count(*),jsonb_agg(value)->0 into n,c from jsonb_array_elements(s->'connections') where value->>'provider'='shopify';
 if n is distinct from 1 or c->'id' is distinct from src->'connectionId' or c->>'status' in ('disconnected','auth_expired')
   or lower(c#>>'{metadata,shopDomain}') is distinct from src->>'domain'
   or coalesce(c#>>'{metadata,shopId}',c#>>'{metadata,accountId}','') is distinct from src->>'accountId'
   or (jsonb_typeof(c->'encryptedCredentials')='string' and char_length(c->>'encryptedCredentials')>0) is not true then
   raise exception using errcode='P0Q02',message='ORDER_RECOVERY_CONNECTION_CHANGED'; end if;
 w:=b->'window'; lower_bound:=to_char(((b->>'startedAt')::timestamptz at time zone 'UTC')-interval '90 days','YYYY-MM-DD')||'T00:00:00.000Z';
 if w is distinct from jsonb_build_object('requestedLowerBound',lower_bound,'requestedUpperBound',b->'startedAt','sortKey','UPDATED_AT','reverse',false,
   'query','updated_at:>='''||lower_bound||''' AND updated_at:<'''||(b->>'startedAt')||'''') then raise exception using errcode='P0Q02',message='ORDER_RECOVERY_WINDOW_INVALID'; end if;
 f:=nullif(s#>'{connectionFirstSync,shopify}','null'::jsonb);
 if (f#>>'{areas,orders}' in ('pending','running','failed') and public.runvara_recovery_date(f->'startedAt') and public.runvara_recovery_date(f->'identityVerifiedAt') and jsonb_typeof(f->'actor')='string' and public.runvara_recovery_utf16(f->>'actor') between 1 and 300 and f->>'actor'=public.runvara_recovery_trim(f->>'actor') and f->>'actor' !~ '[[:cntrl:]]') is not true then f:=null; end if;
 if b->'firstSync' is distinct from 'null'::jsonb and (not public.runvara_recovery_exact(b->'firstSync',array['startedAt','actor','identityVerifiedAt']) or not public.runvara_recovery_date(b#>'{firstSync,startedAt}') or jsonb_typeof(b#>'{firstSync,actor}') is distinct from 'string' or public.runvara_recovery_utf16(b#>>'{firstSync,actor}') not between 1 and 300 or b#>>'{firstSync,actor}' is distinct from public.runvara_recovery_trim(b#>>'{firstSync,actor}') or b#>>'{firstSync,actor}' ~ '[[:cntrl:]]' or not (b#>'{firstSync,identityVerifiedAt}'='null'::jsonb or public.runvara_recovery_date(b#>'{firstSync,identityVerifiedAt}'))) then raise exception using errcode='P0Q02',message='ORDER_RECOVERY_FIRST_SYNC_INVALID'; end if;
 if b->'firstSync' is distinct from (case when f is null then 'null'::jsonb else jsonb_build_object('startedAt',f->'startedAt','actor',f->'actor','identityVerifiedAt',f->'identityVerifiedAt') end) then
   raise exception using errcode='P0Q02',message='ORDER_RECOVERY_FIRST_SYNC_CHANGED'; end if;
 if coalesce(s#>'{integrationStatus,shopify,orderReadHold}','null') is distinct from 'null'::jsonb then raise exception using errcode='P0Q02',message='ORDER_RECOVERY_SOURCE_HELD'; end if;
end $$;
create function public.runvara_recovery_admission(s jsonb,a jsonb,actor jsonb,b jsonb,active boolean) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare r jsonb; n integer;
begin
 perform public.runvara_recovery_actor(s,actor); perform public.runvara_recovery_binding(s,b);
 if not active and public.runvara_recovery_date(s#>'{connectionDoctor,shopify,leaseUntil}') and (s#>>'{connectionDoctor,shopify,leaseUntil}')::timestamptz>clock_timestamp() then raise exception using errcode='P0Q02',message='ORDER_RECOVERY_DOCTOR_LEASE'; end if;
 if not public.runvara_recovery_exact(a,array['runId','leaseUntil','attempt','workspaceRevision','actorId','actorSessionVersion','sessionDigest'])
   or not public.runvara_recovery_id(a->'runId') or (a->>'workspaceRevision' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') is not true
   or not public.runvara_recovery_int(a->'attempt',1,5) or not public.runvara_recovery_date(a->'leaseUntil')
   or a->'actorId' is distinct from actor->'id' or a->'actorSessionVersion' is distinct from actor->'sessionVersion' or a->'sessionDigest' is distinct from actor->'sessionDigest'
   or (a->>'leaseUntil')::timestamptz<=clock_timestamp() or (a->>'leaseUntil')::timestamptz>clock_timestamp()+interval '10 minutes'
   then raise exception using errcode='P0Q02',message='ORDER_RECOVERY_ADMISSION_INVALID'; end if;
 if active then
  select count(*),jsonb_agg(value)->0 into n,r from jsonb_array_elements(s->'connectionSyncs') where value->'id'=a->'runId';
  if n is distinct from 1 or r->>'provider' is distinct from 'shopify' or r->'areas' is distinct from '["orders"]'::jsonb or r->>'status' is distinct from 'running'
    or r->'actor' is distinct from actor->'id' or r->'leaseUntil' is distinct from a->'leaseUntil' then raise exception using errcode='P0Q02',message='ORDER_RECOVERY_LEASE_CHANGED'; end if;
 end if;
 if exists(select 1 from jsonb_array_elements(coalesce(s->'connectionSyncs','[]')) v where v->>'provider'='shopify' and v->>'status'='running'
   and v->'id' is distinct from a->'runId' and public.runvara_recovery_date(v->'leaseUntil') and (v->>'leaseUntil')::timestamptz>clock_timestamp()) then
   raise exception using errcode='P0Q02',message='ORDER_RECOVERY_LEASE_CONFLICT'; end if;
 return r;
end $$;
create function public.runvara_recovery_stage(workspace text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select s.stage||jsonb_build_object('pages',coalesce((select jsonb_agg(p.page order by p.page_index) from public.runvara_order_recovery_pages p where p.workspace_id=s.workspace_id and p.stage_id=s.stage_id),'[]'::jsonb))
 from public.runvara_order_recovery_stages s where s.workspace_id=workspace
$$;
create function public.runvara_recovery_bytes(s jsonb) returns integer language sql immutable security invoker set search_path='' as $$
 select octet_length(public.runvara_recovery_compact(s||'{"logicalBytes":0,"status":"superseded","revision":99,"continued":false}'::jsonb))+2048*(jsonb_array_length(s->'admissions')+jsonb_array_length(s->'pages')+1)
$$;
create function public.runvara_recovery_marker(s jsonb) returns jsonb language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('schema','shopify-order-recovery-marker/v1','stageId',s->'id','runId',s#>'{admissions,-1,runId}','status',s->'status','attempt',s#>'{admissions,-1,attempt}')
$$;
create function public.runvara_recovery_ack(r jsonb,f text,s jsonb,replayed boolean default false) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare ack jsonb;
begin
 ack:=jsonb_build_object('schema','shopify-order-recovery-ack/v1','kind',r->'kind','workspaceId',r->'workspaceId','stageId',r->'stageId',
 'requestFingerprint',f,'stageRevision',s->'revision','expectedRevision',coalesce(r->'expectedRevision','null'),'nextRevision',coalesce(r->'nextRevision','null'),
 'logicalBytes',s->'logicalBytes','status',s->'status','replayed',replayed);
 if octet_length(ack::text)>2048 then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_ACK_CAPACITY'; end if;
 return ack;
end $$;
create function public.runvara_recovery_request(raw text,kind text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb; keys text[];
begin
 if raw is null or octet_length(raw)>(case when kind in ('read','lookup') then 8192 else 2162688 end) then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_INPUT_SIZE'; end if;
 begin r:=raw::jsonb; exception when others then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_INPUT_INVALID'; end;
 keys:=array['schema','workspaceId','stageId','actor'];
 if kind='read' then keys:=keys||array['view']; if r->>'view'='context' then keys:=keys||array['context']; end if; elsif kind='lookup' then keys:=keys||array['kind','requestFingerprint']; else
 keys:=keys||array['kind','admission','expectedStageRevision'];
 if kind in ('reserve','finalize') then keys:=keys||array['expectedRevision','nextRevision','state']; end if;
 if kind='reserve' then keys:=keys||array['binding']; elsif kind='append' then keys:=keys||array['page']; end if;
 end if;
 if not public.runvara_recovery_exact(r,keys) or r->>'schema' is distinct from 'runvara-order-recovery/v1' or not public.runvara_recovery_id(r->'workspaceId')
   or not (kind='read' and r->'stageId'='null' or public.runvara_recovery_id(r->'stageId')) then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_INPUT_INVALID'; end if;
 if kind in ('reserve','append','finalize') and (r->>'kind' is distinct from kind or not public.runvara_recovery_int(r->'expectedStageRevision',0,100)) then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_INPUT_INVALID'; end if;
 if kind in ('reserve','finalize') and (not public.runvara_recovery_id(r->'expectedRevision') or not public.runvara_recovery_id(r->'nextRevision')
   or r->'expectedRevision'=r->'nextRevision' or r#>'{state,_revision}' is distinct from r->'nextRevision' or r#>'{state,workspace,id}' is distinct from r->'workspaceId'
   or octet_length(((raw::json)->'state')::text)>=2097152) then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_STATE_INVALID'; end if;
 return r;
end $$;
-- Validate each complete normalized page before any retained row is changed.
create function public.runvara_recovery_page(s jsonb,p jsonb) returns void
language plpgsql immutable security invoker set search_path='' as $$
declare o jsonb; l jsonb; v jsonb; k text; prior jsonb; seen text[]:=array[]::text[]; line_ids text[]; last_time timestamptz;
  fields text[]:=array['id','externalId','provider','name','createdAt','updatedAt','cancelledAt','financialStatus','fulfillmentStatus','customerEmailHash','statusPageUrl','total','currentTotal','currency','refunds','tax','currentTax','discounts','shippingCharged','paymentGatewayNames','paymentFees','channelFees','advertisingCost','actualShippingCost','otherVariableCosts','lineItems'];
begin
 if not public.runvara_recovery_exact(p,array['schema','index','after','cursor','orders','legacyBytes','evidence','capturedAt'])
  or p->>'schema' is distinct from 'shopify-order-recovery-page/v1' or not public.runvara_recovery_int(p->'index',0,9)
  or (p->>'index')::integer is distinct from jsonb_array_length(s->'pages') or p->'after' is distinct from s->'after'
  or not public.runvara_recovery_int(p->'legacyBytes',2,2097152) or not public.runvara_recovery_date(p->'capturedAt')
  or (p->>'capturedAt')::timestamptz<(s#>>'{binding,startedAt}')::timestamptz
  or (jsonb_typeof(p->'orders')='array' and jsonb_array_length(p->'orders')<=50) is not true
  or not (p->'cursor'='null' or jsonb_typeof(p->'cursor')='string' and octet_length(p->>'cursor') between 1 and 4096)
  or not public.runvara_recovery_exact(p->'evidence',array['rows','hasNextPage','cursorDigest','apiVersion'])
  or p#>'{evidence,rows}' is distinct from to_jsonb(jsonb_array_length(p->'orders')) or jsonb_typeof(p#>'{evidence,hasNextPage}') is distinct from 'boolean'
  or p#>'{evidence,cursorDigest}' is distinct from (case when p->'cursor'='null' then 'null'::jsonb else to_jsonb(public.runvara_recovery_hash(p->'cursor')) end)
  or not (p#>'{evidence,apiVersion}'='null' or p#>>'{evidence,apiVersion}' ~ '^20\d\d-(01|04|07|10)$')
  or (p#>'{evidence,hasNextPage}'='true' and (jsonb_array_length(p->'orders')=0 or p->'cursor'='null' or p->'cursor'=p->'after')) then
  raise exception using errcode='P0Q01',message='ORDER_RECOVERY_PAGE_INVALID'; end if;
 for prior in select value from jsonb_array_elements(s->'pages') loop
  if p->'cursor' is distinct from 'null' and p->'cursor'=prior->'cursor' then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_DUPLICATE_CURSOR'; end if;
  if (p->>'capturedAt')::timestamptz<(prior->>'capturedAt')::timestamptz then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_CAPTURE_ORDER'; end if;
  for o in select value from jsonb_array_elements(prior->'orders') loop seen:=array_append(seen,o->>'id'); last_time:=(o->>'updatedAt')::timestamptz; end loop;
 end loop;
 for o in select value from jsonb_array_elements(p->'orders') loop
  if not public.runvara_recovery_exact(o,fields||case when o?'sourceCurrencyOverrides' then array['sourceCurrencyOverrides'] else array[]::text[] end)
   or not public.runvara_recovery_id(o->'id') or o->'id' is distinct from o->'externalId' or o->>'provider' is distinct from 'shopify' or o->>'id'=any(seen)
   or not public.runvara_recovery_date(o->'createdAt',false) or not public.runvara_recovery_date(o->'updatedAt',false)
   or not (o->'cancelledAt'='null' or public.runvara_recovery_date(o->'cancelledAt',false))
   or (o->>'updatedAt')::timestamptz<(s#>>'{binding,window,requestedLowerBound}')::timestamptz
   or (o->>'updatedAt')::timestamptz>=(s#>>'{binding,window,requestedUpperBound}')::timestamptz
   or (last_time is not null and (o->>'updatedAt')::timestamptz<last_time)
   or not (o->'currency'='null' or o->>'currency' ~ '^[A-Z]{3}$')
   or o->'tax' is distinct from 'null' or o->'refunds' is distinct from 'null'
   or o->'actualShippingCost' is distinct from 'null' or o->'paymentFees' is distinct from 'null' or o->'channelFees' is distinct from 'null' or o->'advertisingCost' is distinct from 'null' or o->'otherVariableCosts' is distinct from 'null'
   or (jsonb_typeof(o->'lineItems')='array' and jsonb_array_length(o->'lineItems')<=100) is not true
   or (jsonb_typeof(o->'paymentGatewayNames')='array' and jsonb_array_length(o->'paymentGatewayNames')<=10) is not true
   or exists(select 1 from jsonb_array_elements(o->'paymentGatewayNames') where jsonb_typeof(value) is distinct from 'string')
   or exists(select 1 from unnest(array['name','financialStatus','fulfillmentStatus']) t where jsonb_typeof(o->t) is distinct from 'string')
   or not (o->'customerEmailHash'='null' or jsonb_typeof(o->'customerEmailHash')='string' and o->>'customerEmailHash' ~ '^[0-9a-f]{64}$')
   or not (o->'statusPageUrl'='null' or jsonb_typeof(o->'statusPageUrl')='string') then
   raise exception using errcode='P0Q01',message='ORDER_RECOVERY_ORDER_INVALID'; end if;
  foreach k in array array['total','currentTotal','currentTax','discounts','shippingCharged'] loop
   v:=o->k;
   if not (v='null' or jsonb_typeof(v)='string' and length(v#>>'{}')<=33 and (v#>>'{}') ~ '^[+-]?([0-9]+(\.[0-9]{1,6})?|\.[0-9]{1,6})$'
     and length(coalesce(nullif(regexp_replace(split_part(regexp_replace(v#>>'{}','^[+-]',''),'.',1),'^0+',''),''),'0'))<=24) then
    raise exception using errcode='P0Q01',message='ORDER_RECOVERY_MONEY_INVALID'; end if;
  end loop;
  line_ids:=array[]::text[];
  for l in select value from jsonb_array_elements(o->'lineItems') loop
   if not public.runvara_recovery_exact(l,array['id','name','sku','quantity','gross','net']) or not public.runvara_recovery_id(l->'id')
    or l->>'id'=any(line_ids) or jsonb_typeof(l->'name') is distinct from 'string' or jsonb_typeof(l->'sku') is distinct from 'string'
    or not public.runvara_recovery_int(l->'quantity',0,9007199254740991) then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_LINE_INVALID'; end if;
   foreach k in array array['gross','net'] loop
    v:=l->k;
    if not (v='null' or jsonb_typeof(v)='string' and length(v#>>'{}')<=33 and (v#>>'{}') ~ '^[+-]?([0-9]+(\.[0-9]{1,6})?|\.[0-9]{1,6})$'
      and length(coalesce(nullif(regexp_replace(split_part(regexp_replace(v#>>'{}','^[+-]',''),'.',1),'^0+',''),''),'0'))<=24) then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_MONEY_INVALID'; end if;
   end loop;
   line_ids:=array_append(line_ids,l->>'id');
  end loop;
  if o?'sourceCurrencyOverrides' then
   if jsonb_typeof(o->'sourceCurrencyOverrides') is distinct from 'object' or (select count(*) from jsonb_each(o->'sourceCurrencyOverrides'))>205 then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_CURRENCY_INVALID'; end if;
   for k,v in select key,value from jsonb_each(o->'sourceCurrencyOverrides') loop
    if not (k=any(array['total','currentTotal','currentTax','discounts','shippingCharged']) or k ~ '^lineItems/(0|[1-9][0-9]?)/(gross|net)$' and split_part(k,'/',2)::integer<jsonb_array_length(o->'lineItems'))
     or not (v='null' or jsonb_typeof(v)='string' and v#>>'{}' ~ '^[A-Z]{3}$') then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_CURRENCY_INVALID'; end if;
   end loop;
  end if;
  seen:=array_append(seen,o->>'id'); last_time:=(o->>'updatedAt')::timestamptz;
 end loop;
end $$;
-- Trusted store maintenance is intentionally narrow; no new authority over
-- users, credentials, settings, approvals, commerce, or security is conferred.
create function public.runvara_recovery_stable(s jsonb) returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare v jsonb; k text;
begin
 v:=s-array['_revision','storageReady','audit','workRecords','automationRuns','connectionSyncs','agentRuns','dailyBriefs','orders']
  #-'{workspace,updatedAt}' #-'{integrationStatus,supabase}' #-'{integrationStatus,reporting}'
  #-'{integrationStatus,shopify}' #-'{connectionDoctor,shopify}' #-'{connectionFirstSync,shopify}' #-'{channelData,shopify,orderReads}';
 if v#>'{channelData,shopify}'='{}'::jsonb then v:=v#-'{channelData,shopify}'; end if;
 foreach k in array array['integrationStatus','connectionDoctor','connectionFirstSync','channelData'] loop if v->k='{}'::jsonb then v:=v-k; end if; end loop;
 return v;
end $$;
create function public.runvara_recovery_failed_areas(status jsonb,first_sync jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(area) order by first_pos),'[]') from (
  select area,min(pos) first_pos from (
   select value#>>'{}' area,ordinality pos from jsonb_array_elements(coalesce(status->'failedAreas','[]')) with ordinality
   union all select key,100+row_number() over(order by octet_length(key),key collate "C") from jsonb_each(coalesce(first_sync->'failures','{}'))
   union all select key,200+row_number() over(order by octet_length(key),key collate "C") from jsonb_each(coalesce(first_sync->'areas','{}')) where value is distinct from '"completed"'::jsonb
  ) rows where area<>'orders' group by area
 ) dedup
$$;
create function public.runvara_recovery_validation(s jsonb,at_value jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare products jsonb; orders jsonb; problems jsonb:='[]'; product_bad boolean; variant_bad boolean; order_bad boolean; variant_count integer;
begin
 select coalesce(jsonb_agg(value),'[]') into products from jsonb_array_elements(coalesce(s->'products','[]')) where value->>'provider'='shopify';
 select coalesce(jsonb_agg(value),'[]') into orders from jsonb_array_elements(s->'orders') where value->>'provider'='shopify';
 product_bad:=exists(select 1 from jsonb_array_elements(products) where coalesce(value->>'id',value->>'externalId',value->>'sku','')='') or exists(select 1 from jsonb_array_elements(products) group by coalesce(value->>'id',value->>'externalId',value->>'sku') having count(*)>1);
 order_bad:=exists(select 1 from jsonb_array_elements(orders) where coalesce(value->>'id',value->>'externalId',value->>'sku','')='') or exists(select 1 from jsonb_array_elements(orders) group by coalesce(value->>'id',value->>'externalId',value->>'sku') having count(*)>1);
 variant_bad:=exists(select 1 from jsonb_array_elements(products) p cross join lateral jsonb_array_elements(coalesce(p->'variants','[]')) v where coalesce(v->>'id','')='')
  or exists(select 1 from jsonb_array_elements(products) p cross join lateral jsonb_array_elements(coalesce(p->'variants','[]')) v group by p->'id',v->>'id' having count(*)>1);
 if product_bad then problems:=problems||'"products"'::jsonb; end if;
 if order_bad then problems:=problems||'"orders"'::jsonb; end if;
 if variant_bad then problems:=problems||'"variants"'::jsonb; end if;
 select coalesce(sum(jsonb_array_length(coalesce(value->'variants','[]'))),0) into variant_count from jsonb_array_elements(products);
 return jsonb_build_object('ok',jsonb_array_length(problems)=0,'counts',jsonb_build_object('products',jsonb_array_length(products),'orders',jsonb_array_length(orders),'variants',variant_count),
  'unavailableAreas','[]'::jsonb,'problemAreas',problems,'checkedAt',at_value);
end $$;
create function public.runvara_recovery_check_state(old_s jsonb,new_s jsonb,stage jsonb,kind text) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare a jsonb:=stage#>'{admissions,-1}'; old_status jsonb:=coalesce(old_s#>'{integrationStatus,shopify}','{}'); new_status jsonb:=coalesce(new_s#>'{integrationStatus,shopify}','{}');
 old_d jsonb:=coalesce(old_s#>'{connectionDoctor,shopify}','{}'); new_d jsonb:=coalesce(new_s#>'{connectionDoctor,shopify}','{}');
 old_f jsonb:=nullif(old_s#>'{connectionFirstSync,shopify}','null'::jsonb); new_f jsonb:=nullif(new_s#>'{connectionFirstSync,shopify}','null'::jsonb); r jsonb; old_r jsonb; debt integer; failed jsonb; validation jsonb;
begin
 if public.runvara_recovery_stable(old_s) is distinct from public.runvara_recovery_stable(new_s)
  or new_status->'orderRecovery' is distinct from public.runvara_recovery_marker(stage)
  or exists(select 1 from jsonb_array_elements(coalesce(new_s->'connectionSyncs','[]')) v group by v->>'id' having count(*) is distinct from 1) then
  raise exception using errcode='P0Q05',message='ORDER_RECOVERY_STATE_SCOPE'; end if;
 select value into r from jsonb_array_elements(new_s->'connectionSyncs') where value->'id'=a->'runId';
 if r is null or r->>'provider' is distinct from 'shopify' or r->'areas' is distinct from '["orders"]' or r->'actor' is distinct from a->'actorId' or r->'leaseUntil' is distinct from a->'leaseUntil'
  or r->'orderRecoveryStageId' is distinct from stage->'id' then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_RUN_INVALID'; end if;
 -- Existing runs survive compaction only if they were selected by the store;
 -- a retained admitted run is separately pinned by the generic writer guard.
 if exists(select 1 from jsonb_array_elements(new_s->'connectionSyncs') n where n->'id' is distinct from a->'runId'
   and not exists(select 1 from jsonb_array_elements(old_s->'connectionSyncs') o where o=n or (o->>'status'='running' and public.runvara_recovery_date(o->'leaseUntil') and (o->>'leaseUntil')::timestamptz<=clock_timestamp() and o-array['status','completedAt','errorCode']=n-array['status','completedAt','errorCode'] and n->>'status'='failed'))) then
  raise exception using errcode='P0Q05',message='ORDER_RECOVERY_RUN_SCOPE'; end if;
 if kind='reserve' then
  if old_s->'orders' is distinct from new_s->'orders' or old_s#>'{channelData,shopify,orderReads}' is distinct from new_s#>'{channelData,shopify,orderReads}'
   or old_f is distinct from new_f or old_status is distinct from new_status-'orderRecovery'
      and old_status-'orderRecovery' is distinct from new_status-'orderRecovery'
   or r->>'status' is distinct from 'running' or r->'automatic' is distinct from 'false' or not public.runvara_recovery_date(r->'startedAt')
   or (r->>'leaseUntil')::timestamptz-(r->>'startedAt')::timestamptz>interval '10 minutes'
   or old_d-array['attempts','exhausted','orderReadBinding'] is distinct from new_d-array['attempts','exhausted','orderReadBinding']
   or new_d->'attempts' is distinct from a->'attempt' or new_d->'exhausted' is distinct from to_jsonb((a->>'attempt')::integer>=5)
   or new_d->'orderReadBinding' is distinct from stage#>'{binding,source}' then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_RESERVE_SCOPE'; end if;
  if not public.runvara_recovery_int(coalesce(old_d->'attempts','0'),0,5) or not public.runvara_recovery_int(coalesce(old_d->'pendingReadAttempts','0'),0,5) then raise exception using errcode='P0Q02',message='ORDER_RECOVERY_DEBT_INVALID'; end if;
  debt:=greatest(coalesce((old_d->>'attempts')::integer,0),coalesce((old_d->>'pendingReadAttempts')::integer,0));
  if old_d->'exhausted'='true' or (a->>'attempt')::integer is distinct from debt+1 then raise exception using errcode='P0Q02',message='ORDER_RECOVERY_DEBT_CHANGED'; end if;
 else
  failed:=public.runvara_recovery_failed_areas(old_status,old_f);
  if new_status->'failedAreas' is distinct from failed or new_status->>'status' is distinct from (case when jsonb_array_length(failed)>0 then 'degraded' else 'connected' end)
    or new_status->'lastError' is distinct from (case when jsonb_array_length(failed)>0 then coalesce(old_status->'lastError','null') else 'null'::jsonb end) then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_UNRELATED_FAILURE'; end if;
  select value into old_r from jsonb_array_elements(old_s->'connectionSyncs') where value->'id'=a->'runId';
  if old_r-array['status','stage','completedAt','errorCode'] is distinct from r-array['status','stage','completedAt','errorCode']
   or r->>'status' is distinct from 'completed' or r->>'stage' is distinct from 'Finished' or r->'errorCode' is distinct from 'null' or not public.runvara_recovery_date(r->'completedAt')
   or new_d is distinct from old_d
   or old_status-array['orderRecovery','lastSyncAt','lastSuccessfulSyncAt','lastError','orderReadAttempt','orderReadHold','areaSuccessAt','status','failedAreas'] is distinct from new_status-array['orderRecovery','lastSyncAt','lastSuccessfulSyncAt','lastError','orderReadAttempt','orderReadHold','areaSuccessAt','status','failedAreas']
   or coalesce(old_status->'areaSuccessAt','{}')-'orders' is distinct from coalesce(new_status->'areaSuccessAt','{}')-'orders'
   or new_status->'lastSyncAt' is distinct from stage#>'{binding,startedAt}' or new_status->'lastSuccessfulSyncAt' is distinct from stage#>'{binding,startedAt}'
   or new_status#>'{areaSuccessAt,orders}' is distinct from stage#>'{binding,startedAt}'
   or new_status?'orderReadHold' or new_status->'orderReadAttempt' is distinct from jsonb_build_object('status','complete','at',stage#>'{binding,startedAt}','retryable',false) then
   raise exception using errcode='P0Q05',message='ORDER_RECOVERY_FINAL_SCOPE'; end if;
  if stage#>'{binding,firstSync}'='null'::jsonb then if old_s#>'{connectionFirstSync,shopify}' is distinct from new_s#>'{connectionFirstSync,shopify}' then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_FIRST_SYNC_SCOPE'; end if;
  else
   validation:=public.runvara_recovery_validation(new_s,new_f#>'{validation,checkedAt}');
   if not public.runvara_recovery_date(new_f#>'{validation,checkedAt}') or new_f->'validation' is distinct from validation then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_FIRST_SYNC_VALIDATION'; end if;
   if old_f-array['status','completedAt','areas','failures','validation'] is distinct from new_f-array['status','completedAt','areas','failures','validation']
    or (old_f->'areas')-'orders' is distinct from (new_f->'areas')-'orders' or (old_f->'failures')-'orders' is distinct from (new_f->'failures')-'orders'
    or new_f#>'{areas,orders}' is distinct from '"completed"' or new_f#>'{failures,orders}' is not null
    or new_f->>'status' is distinct from (case when exists(select 1 from jsonb_each(new_f->'areas') where value is distinct from '"completed"') or new_f->'failures' is distinct from '{}' or validation->'ok' is distinct from 'true'::jsonb then 'partial' else 'completed' end)
    or not public.runvara_recovery_date(new_f->'completedAt') then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_FIRST_SYNC_SCOPE'; end if;
  end if;
 end if;
end $$;
create function public.runvara_recovery_operation(ack jsonb) returns jsonb language sql immutable security invoker set search_path='' as $$
 select jsonb_build_array(ack->'kind',ack->'requestFingerprint',ack->'stageRevision',ack->'expectedRevision',ack->'nextRevision',ack->'logicalBytes',ack->'status')
$$;
create function public.runvara_recovery_find_ack(workspace text,stage_id_value text,kind text,fingerprint text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare ops jsonb; op jsonb;
begin
 select s.operations into ops from public.runvara_order_recovery_stages s where s.workspace_id=workspace and s.stage_id=stage_id_value;
 if not found then select receipt->'operations' into ops from public.runvara_order_recovery_receipts r where r.workspace_id=workspace and r.stage_id=stage_id_value; end if;
 select value into op from jsonb_array_elements(coalesce(ops,'[]')) where value->>0=kind and value->>1=fingerprint;
 if op is null then return null; end if;
 return jsonb_build_object('schema','shopify-order-recovery-ack/v1','kind',op->0,'workspaceId',workspace,'stageId',stage_id_value,
  'requestFingerprint',op->1,'stageRevision',op->2,'expectedRevision',op->3,'nextRevision',op->4,'logicalBytes',op->5,'status',op->6,'replayed',true);
end $$;
create function public.runvara_recovery_receipt_preflight(stage jsonb) returns void language plpgsql immutable security invoker set search_path='' as $$
declare worst jsonb;
begin
 -- Fixed fully conservative text maxima: sixteen compact operation identities,
 -- ten evidence records and observation times, source reference, hash and wrapper.
 worst:=jsonb_build_object('binding',stage->'binding','workspaceId',stage#>'{binding,workspaceId}','stageId',stage->'id');
 if octet_length(public.runvara_recovery_compact(worst))+12288>16384 then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_RECEIPT_CAPACITY'; end if;
end $$;
create function public.runvara_recovery_source_record(o jsonb) returns jsonb language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('id',o->'id','externalId',o->'externalId','provider',o->'provider','createdAt',o->'createdAt','updatedAt',o->'updatedAt','cancelledAt',o->'cancelledAt',
 'financialStatus',o->'financialStatus','fulfillmentStatus',o->'fulfillmentStatus','currency',o->'currency',
 'money',jsonb_build_object('total',o->'total','currentTotal',o->'currentTotal','currentTax',o->'currentTax','discounts',o->'discounts','shippingCharged',o->'shippingCharged'),
 'currencyOverrides',coalesce(o->'sourceCurrencyOverrides','{}'),
 'lines',coalesce((select jsonb_agg(jsonb_build_object('id',value->'id','sku',value->'sku','quantity',value->'quantity','gross',value->'gross','net',value->'net') order by ordinality) from jsonb_array_elements(o->'lineItems') with ordinality),'[]'))
$$;
create function public.runvara_recovery_promotion(old_s jsonb,new_s jsonb,stage jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare b jsonb:=stage->'binding'; incoming jsonb; records jsonb; pages jsonb; observation jsonb; manifest jsonb; ref text; got jsonb;
 merged jsonb:='[]'; o jsonb; old_o jsonb; m jsonb; field text; container jsonb; candidate jsonb; prior jsonb; entry record; refs text[]; n integer;
begin
 select coalesce(jsonb_agg(o.value order by p.ordinality,o.ordinality),'[]'),coalesce(jsonb_agg(public.runvara_recovery_source_record(o.value) order by p.ordinality,o.ordinality),'[]')
  into incoming,records from jsonb_array_elements(stage->'pages') with ordinality p cross join lateral jsonb_array_elements(p.value->'orders') with ordinality o;
 select jsonb_agg(value->'evidence' order by ordinality) into pages from jsonb_array_elements(stage->'pages') with ordinality;
 observation:=jsonb_build_object('schema','shopify-order-recovery-observation/v1','stageId',stage->'id','continued',stage->'continued','originalStartedAt',b->'startedAt',
 'lastCapturedAt',stage#>'{pages,-1,capturedAt}','pageCaptureTimes',(select jsonb_agg(value->'capturedAt' order by ordinality) from jsonb_array_elements(stage->'pages') with ordinality),'snapshotConsistency','unverified');
 ref:=new_s#>>'{channelData,shopify,orderReads,lastSuccess}'; got:=new_s#>'{channelData,shopify,orderReads,manifests}'->ref;
 if not public.runvara_recovery_date(got->'finishedAt') or (got->>'finishedAt')::timestamptz<(stage#>>'{pages,-1,capturedAt}')::timestamptz then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_MANIFEST_INVALID'; end if;
 manifest:=jsonb_build_object('schema','shopify-order-read/v3','workspaceId',b->'workspaceId','provider','shopify','requestDomain',b#>'{source,domain}',
  'requestedApiVersion',b#>'{source,apiVersion}','sourceAccountId',null,'currentScopes','not_observed','query',b#>'{window,query}',
  'requestedLowerBound',b#>'{window,requestedLowerBound}','requestedUpperBound',b#>'{window,requestedUpperBound}','sortKey','UPDATED_AT','reverse',false,
  'startedAt',b->'startedAt','finishedAt',got->'finishedAt','first',50,'pageLimit',10,'lineLimit',100,'ordersRead',jsonb_array_length(incoming),
  'linesRead',(select coalesce(sum(jsonb_array_length(value->'lineItems')),0) from jsonb_array_elements(incoming)),
  'recordsDigest',public.runvara_recovery_hash(records),'pages',pages,'allReturnedLinePagesExhausted',true,'queryExhaustion','observed_exhausted','sourcePeriod','unverified','moneyBasis','shopMoney','recovery',observation);
 if got is distinct from manifest or ref is distinct from 'sor3:'||public.runvara_recovery_hash(manifest) or octet_length(public.runvara_recovery_compact(manifest))>4096 then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_MANIFEST_INVALID'; end if;
 if jsonb_typeof(old_s->'orders') is distinct from 'array' or exists(select 1 from jsonb_array_elements(old_s->'orders') v where jsonb_typeof(v) is distinct from 'object')
  or exists(select 1 from jsonb_array_elements(old_s->'orders') v where v->>'provider'='shopify' group by v->>'id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(old_s->'orders') v where v->>'provider'='shopify' group by coalesce(v->>'externalId',v->>'id') having count(*)>1) then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_CANONICAL_INVALID'; end if;
 for o in select value from jsonb_array_elements(incoming) loop
  select value into old_o from jsonb_array_elements(old_s->'orders') where value->>'provider'='shopify' and value->'id'=o->'id';
  m:=coalesce(old_o,'{}')||o||jsonb_build_object('sourceReadRef',ref);
  if not o?'sourceCurrencyOverrides' then m:=m-'sourceCurrencyOverrides'; end if;
  foreach field in array array['actualShippingCost','paymentFees','channelFees','advertisingCost','otherVariableCosts'] loop
   if old_o->'costOverrides'?field then m:=jsonb_set(m,array[field],old_o->'costOverrides'->field);
   elsif coalesce(old_o->'costUpdatedAt','null') not in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) and old_o?field then m:=jsonb_set(m,array[field],old_o->field); end if;
  end loop;
  merged:=merged||jsonb_build_array(m);
 end loop;
 select merged||coalesce(jsonb_agg(e.value order by e.ordinality),'[]') into merged from jsonb_array_elements(old_s->'orders') with ordinality e
  where e.value->>'provider' is distinct from 'shopify' or not exists(select 1 from jsonb_array_elements(incoming) i where i->'id'=e.value->'id');
 if new_s->'orders' is distinct from merged then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_MERGE_INVALID'; end if;
 prior:=old_s#>'{channelData,shopify,orderReads}';
 if prior is not null and prior is distinct from 'null' then
  if prior->>'schema' is distinct from 'shopify-order-reads/v1' or jsonb_typeof(prior->'manifests') is distinct from 'object' or (select count(*) from jsonb_each(prior->'manifests'))>8
    or octet_length(public.runvara_recovery_compact(prior))>16384 then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_PRIOR_MANIFEST_INVALID'; end if;
 end if;
 container:=jsonb_build_object('schema','shopify-order-reads/v1','workspaceId',b->'workspaceId','manifests',jsonb_build_object(ref,manifest),'lastSuccess',ref,
  'lastAttempt',jsonb_build_object('status','complete','at',manifest->'finishedAt','retryable',false));
 select array_agg(value->>'sourceReadRef') into refs from jsonb_array_elements(merged) where value?'sourceReadRef';
 n:=1;
 for entry in select key,value from jsonb_each(coalesce(prior->'manifests','{}')) where key is distinct from ref
  order by coalesce(key=any(refs),false) desc,value->>'finishedAt' desc,octet_length(key),key collate "C" loop
  exit when n>=8;
  candidate:=jsonb_set(container,'{manifests}',container->'manifests'||jsonb_build_object(entry.key,entry.value));
  if octet_length(public.runvara_recovery_compact(candidate))<=16384 then container:=candidate; n:=n+1; end if;
 end loop;
 if new_s#>'{channelData,shopify,orderReads}' is distinct from container then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_RETENTION_INVALID'; end if;
 return jsonb_build_object('sourceReadRef',ref,'manifestDigest',public.runvara_recovery_hash(manifest),'finishedAt',manifest->'finishedAt','pageEvidence',pages,'observation',observation);
end $$;
create function public.runvara_recovery_guard_private() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='TRUNCATE' then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_TRUNCATE_FORBIDDEN'; end if;
 -- Ordinary roles have no privileges; only owner-created RPCs can write.
 if current_user is distinct from (select pg_get_userbyid(relowner) from pg_class where oid=tg_relid) then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_PRIVATE'; end if;
 if tg_table_name='runvara_order_recovery_receipts' and tg_op is distinct from 'INSERT' then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_RECEIPT_IMMUTABLE'; end if;
 if tg_table_name='runvara_order_recovery_pages' and tg_op='UPDATE' then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_PAGE_IMMUTABLE'; end if;
 if tg_op='DELETE' and tg_table_name in ('runvara_order_recovery_stages','runvara_order_recovery_pages') and not exists(
  select 1 from public.runvara_order_recovery_receipts r where r.workspace_id=to_jsonb(old)->>'workspace_id' and r.stage_id=to_jsonb(old)->>'stage_id') then
  raise exception using errcode='P0Q05',message='ORDER_RECOVERY_CLEANUP_INELIGIBLE'; end if;
 if tg_table_name='runvara_order_recovery_stages' and tg_op='UPDATE' and to_jsonb(old)->'superseded'='true' and to_jsonb(new)->'superseded' is distinct from 'true'::jsonb then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_SUPERSEDED'; end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create function public.runvara_recovery_cost_edits(old_orders jsonb,new_orders jsonb) returns void
language plpgsql immutable security invoker set search_path='' as $$
declare old_o jsonb; new_o jsonb; field text; v jsonb; fields text[]:=array['actualShippingCost','paymentFees','channelFees','advertisingCost','otherVariableCosts'];
begin
 for new_o in select value from jsonb_array_elements(new_orders) where value->>'provider'='shopify' loop
  select value into old_o from jsonb_array_elements(old_orders) where value->>'provider'='shopify' and value->'id'=new_o->'id';
  if coalesce(nullif(new_o->'costOverrides','null'::jsonb),'{}')-fields is distinct from coalesce(nullif(old_o->'costOverrides','null'::jsonb),'{}')-fields then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_COST_SCOPE'; end if;
  if new_o->'costUpdatedAt' is distinct from old_o->'costUpdatedAt' and not public.runvara_recovery_date(new_o->'costUpdatedAt') then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_COST_SCOPE'; end if;
  foreach field in array fields loop
   if new_o->field is distinct from old_o->field or new_o->'costOverrides'->field is distinct from old_o->'costOverrides'->field then
    v:=new_o->field;
    if v is null or (v is distinct from 'null'::jsonb and (jsonb_typeof(v) is distinct from 'number' or (v::text)::numeric<0 or (v::text)::numeric>10000000 or round((v::text)::numeric,4) is distinct from (v::text)::numeric))
     or new_o->'costOverrides'->field is distinct from v or not public.runvara_recovery_date(new_o->'costUpdatedAt') then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_COST_SCOPE'; end if;
   end if;
  end loop;
 end loop;
end $$;
create function public.runvara_recovery_guard_workspace() returns trigger
language plpgsql security definer set search_path='' as $$
declare retained public.runvara_order_recovery_stages; s jsonb; r jsonb; n integer:=0; actor jsonb; pinned jsonb; old_pinned jsonb;
 marker jsonb; debt integer; fresh boolean:=false;
begin
 if tg_op='TRUNCATE' then
  if exists(select 1 from public.runvara_order_recovery_stages) or exists(select 1 from public.runvara_order_recovery_receipts) then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_PARENT_TRUNCATE'; end if;
  return null;
 end if;
 if tg_op='DELETE' then
  if exists(select 1 from public.runvara_order_recovery_stages where workspace_id=old.workspace_id) or exists(select 1 from public.runvara_order_recovery_receipts where workspace_id=old.workspace_id) then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_PARENT_DELETE'; end if;
  return old;
 end if;
 select * into retained from public.runvara_order_recovery_stages where workspace_id=new.workspace_id for update;
 if not found then return new; end if;
 if retained.pending_revision=new.state->>'_revision' and retained.pending_digest=encode(sha256(convert_to(new.state::text,'UTF8')),'hex') then return new; end if;
 if tg_op is distinct from 'UPDATE' then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_PROTECTED'; end if;
 if new.state is distinct from old.state and new.state->'_revision' is not distinct from old.state->'_revision' then raise exception using errcode='P0Q04',message='ORDER_RECOVERY_REVISION_REQUIRED'; end if;
 s:=retained.stage;
 for r in select value from jsonb_array_elements(coalesce(new.state->'connectionSyncs','[]')) loop
  if not retained.superseded and r->>'provider'='shopify' and r->'areas' @> '["orders"]'::jsonb
   and not exists(select 1 from jsonb_array_elements(coalesce(old.state->'connectionSyncs','[]')) o where o->'id'=r->'id') then
   if r?'orderRecoveryStageId' or r->'automatic' is distinct from 'false'::jsonb or r->>'status' is distinct from 'running'
    or not public.runvara_recovery_date(r->'leaseUntil') or not public.runvara_recovery_date(r->'startedAt')
    or (r->>'leaseUntil')::timestamptz<=clock_timestamp() or (r->>'leaseUntil')::timestamptz>clock_timestamp()+interval '10 minutes'
    or (r->>'leaseUntil')::timestamptz-(r->>'startedAt')::timestamptz>interval '10 minutes' then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_ORDERS_ADMISSION'; end if;
   select count(*),jsonb_agg(value)->0 into n,actor from jsonb_array_elements(old.state->'users') where value->'id'=r->'actor';
   if n is distinct from 1 or old.state->'users' is distinct from new.state->'users' or (actor->>'role' in ('owner','admin')) is not true or actor->'active'='false' or actor->'passwordChangeRequired'='true' then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_ORDERS_AUTHORITY'; end if;
   fresh:=true;
  end if;
 end loop;
 marker:=new.state#>'{integrationStatus,shopify,orderRecovery}';
 if marker is null or marker->'stageId' is distinct from s->'id' or marker->'runId' is distinct from s#>'{admissions,-1,runId}'
  or marker->'attempt' is distinct from s#>'{admissions,-1,attempt}' or marker->>'schema' is distinct from 'shopify-order-recovery-marker/v1' then
  raise exception using errcode='P0Q05',message='ORDER_RECOVERY_MARKER_REQUIRED'; end if;
 select value into old_pinned from jsonb_array_elements(old.state->'connectionSyncs') where value->'id'=s#>'{admissions,-1,runId}';
 select count(*),jsonb_agg(value)->0 into n,pinned from jsonb_array_elements(new.state->'connectionSyncs') where value->'id'=s#>'{admissions,-1,runId}';
 if n is distinct from 1 or pinned-array['status','stage','completedAt','errorCode'] is distinct from old_pinned-array['status','stage','completedAt','errorCode']
  or (old_pinned->>'status' is distinct from 'running' and pinned is distinct from old_pinned)
  or (pinned->>'status' in ('running','failed','partial')) is not true then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_ADMITTED_RUN_REQUIRED'; end if;
 if fresh or retained.superseded then
  if fresh and not retained.superseded then
   update public.runvara_order_recovery_stages set superseded=true,stage=jsonb_set(stage,'{status}','"superseded"') where workspace_id=new.workspace_id;
  end if;
  new.state:=jsonb_set(new.state,'{integrationStatus,shopify,orderRecovery,status}','"superseded"');
 else
  if (marker->>'status' in ('reading','complete','failed','paused','unknown')) is not true then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_MARKER_STATUS'; end if;
  if not public.runvara_recovery_int(coalesce(new.state#>'{connectionDoctor,shopify,attempts}','null'),0,5)
   or (new.state#>>'{connectionDoctor,shopify,attempts}')::integer<greatest((s#>>'{admissions,-1,attempt}')::integer,coalesce((old.state#>>'{connectionDoctor,shopify,attempts}')::integer,0))
   or new.state#>'{connectionDoctor,shopify,orderReadBinding}' is distinct from old.state#>'{connectionDoctor,shopify,orderReadBinding}'
   or old.state#>'{connectionDoctor,shopify,exhausted}'='true' and new.state#>'{connectionDoctor,shopify,exhausted}' is distinct from 'true'::jsonb
   or not public.runvara_recovery_int(coalesce(new.state#>'{connectionDoctor,shopify,pendingReadAttempts}','0'),0,5)
   or greatest((new.state#>>'{connectionDoctor,shopify,attempts}')::integer,coalesce((new.state#>>'{connectionDoctor,shopify,pendingReadAttempts}')::integer,0))<greatest(coalesce((old.state#>>'{connectionDoctor,shopify,attempts}')::integer,0),coalesce((old.state#>>'{connectionDoctor,shopify,pendingReadAttempts}')::integer,0),(s#>>'{admissions,-1,attempt}')::integer)
   then raise exception using errcode='P0Q05',message='ORDER_RECOVERY_DEBT_REQUIRED'; end if;
  if (select jsonb_agg(value-array['actualShippingCost','paymentFees','channelFees','advertisingCost','otherVariableCosts','costOverrides','costUpdatedAt'] order by ordinality) from jsonb_array_elements(new.state->'orders') with ordinality where value->>'provider'='shopify') is distinct from (select jsonb_agg(value-array['actualShippingCost','paymentFees','channelFees','advertisingCost','otherVariableCosts','costOverrides','costUpdatedAt'] order by ordinality) from jsonb_array_elements(old.state->'orders') with ordinality where value->>'provider'='shopify') or new.state#>'{channelData,shopify,orderReads}' is distinct from old.state#>'{channelData,shopify,orderReads}' then
   raise exception using errcode='P0Q05',message='ORDER_RECOVERY_CANONICAL_PROTECTED'; end if;
  perform public.runvara_recovery_cost_edits(old.state->'orders',new.state->'orders');
 end if;
 return new;
end $$;
create trigger runvara_order_recovery_workspace_guard before insert or update or delete on public.saas_workspace_state
 for each row execute function public.runvara_recovery_guard_workspace();
create trigger runvara_order_recovery_workspace_truncate before truncate on public.saas_workspace_state
 for each statement execute function public.runvara_recovery_guard_workspace();

create function public.runvara_reserve_order_recovery(p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb:=public.runvara_recovery_request(p_request,'reserve'); state_value jsonb; s jsonb; old_stage jsonb;
 row_value public.runvara_order_recovery_stages; q public.runvara_order_recovery_quota; ack jsonb; f text:='sha256:'||encode(sha256(convert_to(p_request,'UTF8')),'hex'); new_bytes integer;
begin
 select state into state_value from public.saas_workspace_state where workspace_id=r->>'workspaceId' for update;
 perform public.runvara_recovery_actor(state_value,r->'actor');
 ack:=public.runvara_recovery_find_ack(r->>'workspaceId',r->>'stageId','reserve',f); if ack is not null then return ack; end if;
 if (select mode from public.runvara_order_recovery_control where id) is distinct from 'enforced' then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_INACTIVE'; end if;
 select * into q from public.runvara_order_recovery_quota where id for update;
 perform 1 from public.runvara_order_recovery_control where id and mode='enforced' for share;
 if not found then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_INACTIVE'; end if;
 select * into row_value from public.runvara_order_recovery_stages where workspace_id=r->>'workspaceId' for update;
 if state_value->'_revision' is distinct from r->'expectedRevision' or r#>'{admission,workspaceRevision}' is distinct from r->'expectedRevision' then raise exception using errcode='P0Q04',message='ORDER_RECOVERY_WORKSPACE_CONFLICT'; end if;
 perform public.runvara_recovery_admission(state_value,r->'admission',r->'actor',r->'binding',false);
 if row_value.workspace_id is null then
  if r->'expectedStageRevision' is distinct from '0' or exists(select 1 from public.runvara_order_recovery_receipts where stage_id=r->>'stageId') or q.unfinished_stages>=8 then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_SLOTS_FULL'; end if;
  s:=jsonb_build_object('schema','shopify-order-recovery-stage/v1','id',r->'stageId','binding',r->'binding','revision',1,'status','reading',
   'admissions',jsonb_build_array(r->'admission'),'pages','[]'::jsonb,'after',null,'legacyBytes',2,'logicalBytes',0,'continued',false);
 else
  old_stage:=public.runvara_recovery_stage(r->>'workspaceId');
  if row_value.stage_id is distinct from r->>'stageId' or row_value.superseded or old_stage->'revision' is distinct from r->'expectedStageRevision' or old_stage->'binding' is distinct from r->'binding'
    or (old_stage->>'status' in ('reading','failed','complete')) is not true or jsonb_array_length(old_stage->'admissions')>=5
    or exists(select 1 from jsonb_array_elements(old_stage->'admissions') where value->'runId'=r#>'{admission,runId}')
    or (r#>>'{admission,attempt}')::integer<=(old_stage#>>'{admissions,-1,attempt}')::integer
    then raise exception using errcode='P0Q04',message='ORDER_RECOVERY_STAGE_CONFLICT'; end if;
  s:=old_stage||jsonb_build_object('revision',(old_stage->>'revision')::integer+1,'admissions',(old_stage->'admissions')||jsonb_build_array(r->'admission'),'continued',true);
 end if;
 perform public.runvara_recovery_receipt_preflight(s);
 new_bytes:=public.runvara_recovery_bytes(s); s:=s||jsonb_build_object('logicalBytes',new_bytes);
 if octet_length(s::text)+1024>2162688 or new_bytes>2097152 or q.logical_bytes-coalesce(row_value.logical_bytes,0)+new_bytes>16777216 then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_BYTES_FULL'; end if;
 perform public.runvara_recovery_check_state(state_value,r->'state',s,'reserve');
 perform public.runvara_recovery_admission(r->'state',r->'admission',r->'actor',r->'binding',true);
 ack:=public.runvara_recovery_ack(r,f,s);
 insert into public.runvara_order_recovery_stages(workspace_id,stage_id,stage,operations,logical_bytes,pending_revision,pending_digest)
  values(r->>'workspaceId',r->>'stageId',s-'pages',jsonb_build_array(public.runvara_recovery_operation(ack)),new_bytes,r->>'nextRevision',encode(sha256(convert_to((r->'state')::text,'UTF8')),'hex'))
 on conflict(workspace_id) do update set stage=excluded.stage,operations=public.runvara_order_recovery_stages.operations||excluded.operations,
  logical_bytes=excluded.logical_bytes,pending_revision=excluded.pending_revision,pending_digest=excluded.pending_digest;
 update public.runvara_order_recovery_quota set unfinished_stages=unfinished_stages+case when row_value.workspace_id is null then 1 else 0 end,
  logical_bytes=logical_bytes-coalesce(row_value.logical_bytes,0)+new_bytes where id;
 -- clock_timestamp checks repeat immediately before the durable CAS.
 perform public.runvara_recovery_admission(r->'state',r->'admission',r->'actor',r->'binding',true);
 update public.saas_workspace_state set state=r->'state',updated_at=clock_timestamp() where workspace_id=r->>'workspaceId' and state->'_revision'=r->'expectedRevision';
 if not found then raise exception using errcode='P0Q04',message='ORDER_RECOVERY_WORKSPACE_CONFLICT'; end if;
 update public.runvara_order_recovery_stages set pending_revision=null,pending_digest=null where workspace_id=r->>'workspaceId';
 return ack;
end $$;
create function public.runvara_append_order_recovery(p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb:=public.runvara_recovery_request(p_request,'append'); state_value jsonb; old_s jsonb; s jsonb;
 row_value public.runvara_order_recovery_stages; q public.runvara_order_recovery_quota; ack jsonb; f text:='sha256:'||encode(sha256(convert_to(p_request,'UTF8')),'hex'); new_bytes integer; legacy integer; nonempty integer; overflow boolean:=false;
begin
 select state into state_value from public.saas_workspace_state where workspace_id=r->>'workspaceId' for update;
 perform public.runvara_recovery_actor(state_value,r->'actor');
 ack:=public.runvara_recovery_find_ack(r->>'workspaceId',r->>'stageId','append',f); if ack is not null then return ack; end if;
 if (select mode from public.runvara_order_recovery_control where id) is distinct from 'enforced' then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_INACTIVE'; end if;
 select * into q from public.runvara_order_recovery_quota where id for update;
 perform 1 from public.runvara_order_recovery_control where id and mode='enforced' for share;
 if not found then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_INACTIVE'; end if;
 select * into row_value from public.runvara_order_recovery_stages where workspace_id=r->>'workspaceId' for update;
 old_s:=public.runvara_recovery_stage(r->>'workspaceId');
 if row_value.stage_id is distinct from r->>'stageId' or row_value.superseded or old_s->'revision' is distinct from r->'expectedStageRevision'
   or old_s->>'status' is distinct from 'reading' or old_s#>'{admissions,-1}' is distinct from r->'admission' then raise exception using errcode='P0Q04',message='ORDER_RECOVERY_STAGE_CONFLICT'; end if;
 perform public.runvara_recovery_admission(state_value,r->'admission',r->'actor',old_s->'binding',true);
 perform public.runvara_recovery_page(old_s,r->'page');
 s:=old_s||jsonb_build_object('revision',(old_s->>'revision')::integer+1,'pages',(old_s->'pages')||jsonb_build_array(r->'page'),'after',r#>'{page,cursor}',
  'status',case when r#>'{page,evidence,hasNextPage}'='false' then 'complete' when jsonb_array_length(old_s->'pages')=9 then 'paused' else 'reading' end);
 select 2+coalesce(sum((value->>'legacyBytes')::integer-2),0)+greatest(count(*) filter(where jsonb_array_length(value->'orders')>0)-1,0) into legacy from jsonb_array_elements(s->'pages');
 s:=s||jsonb_build_object('legacyBytes',legacy); new_bytes:=public.runvara_recovery_bytes(s);
 if legacy>2097152 or octet_length(s::text)+1024>2162688 or new_bytes>2097152 or q.logical_bytes-row_value.logical_bytes+new_bytes>16777216 then
  overflow:=true; s:=old_s||jsonb_build_object('revision',(old_s->>'revision')::integer+1,'status','paused');
  -- Final ACK reserve covers this terminal rejected append; no page prefix accepted.
  new_bytes:=greatest(row_value.logical_bytes,public.runvara_recovery_bytes(s));
  if q.logical_bytes-row_value.logical_bytes+new_bytes>16777216 or new_bytes>2097152 then new_bytes:=row_value.logical_bytes; end if;
 end if;
 s:=s||jsonb_build_object('logicalBytes',new_bytes); ack:=public.runvara_recovery_ack(r,f,s);
 perform public.runvara_recovery_admission(state_value,r->'admission',r->'actor',old_s->'binding',true);
 if not overflow then insert into public.runvara_order_recovery_pages values(r->>'workspaceId',r->>'stageId',(r#>>'{page,index}')::integer,r->'page'); end if;
 update public.runvara_order_recovery_stages set stage=s-'pages',logical_bytes=new_bytes,operations=operations||jsonb_build_array(public.runvara_recovery_operation(ack)) where workspace_id=r->>'workspaceId';
 update public.runvara_order_recovery_quota set logical_bytes=logical_bytes-row_value.logical_bytes+new_bytes where id;
 return ack;
end $$;
create function public.runvara_finalize_order_recovery(p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb:=public.runvara_recovery_request(p_request,'finalize'); state_value jsonb; old_s jsonb; s jsonb; proof jsonb; receipt jsonb;
 row_value public.runvara_order_recovery_stages; q public.runvara_order_recovery_quota; ack jsonb; f text:='sha256:'||encode(sha256(convert_to(p_request,'UTF8')),'hex'); receipt_bytes integer;
begin
 select state into state_value from public.saas_workspace_state where workspace_id=r->>'workspaceId' for update;
 perform public.runvara_recovery_actor(state_value,r->'actor');
 ack:=public.runvara_recovery_find_ack(r->>'workspaceId',r->>'stageId','finalize',f); if ack is not null then return ack; end if;
 if (select mode from public.runvara_order_recovery_control where id) is distinct from 'enforced' then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_INACTIVE'; end if;
 select * into q from public.runvara_order_recovery_quota where id for update;
 perform 1 from public.runvara_order_recovery_control where id and mode='enforced' for share;
 if not found then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_INACTIVE'; end if;
 select * into row_value from public.runvara_order_recovery_stages where workspace_id=r->>'workspaceId' for update;
 old_s:=public.runvara_recovery_stage(r->>'workspaceId');
 if state_value->'_revision' is distinct from r->'expectedRevision' then raise exception using errcode='P0Q04',message='ORDER_RECOVERY_WORKSPACE_CONFLICT'; end if;
 if row_value.stage_id is distinct from r->>'stageId' or row_value.superseded or old_s->'revision' is distinct from r->'expectedStageRevision'
  or old_s->>'status' is distinct from 'complete' or old_s#>'{admissions,-1}' is distinct from r->'admission'
  or old_s#>'{pages,-1,evidence,hasNextPage}' is distinct from 'false'::jsonb then raise exception using errcode='P0Q04',message='ORDER_RECOVERY_STAGE_CONFLICT'; end if;
 perform public.runvara_recovery_admission(state_value,r->'admission',r->'actor',old_s->'binding',true);
 s:=old_s||jsonb_build_object('revision',(old_s->>'revision')::integer+1,'status','committed');
 s:=s||jsonb_build_object('logicalBytes',public.runvara_recovery_bytes(s));
 perform public.runvara_recovery_check_state(state_value,r->'state',s,'finalize');
 proof:=public.runvara_recovery_promotion(state_value,r->'state',s);
 ack:=public.runvara_recovery_ack(r,f,s);
 receipt:=jsonb_build_object('schema','shopify-order-recovery-receipt/v1','workspaceId',r->'workspaceId','stageId',r->'stageId','binding',s->'binding',
   'operations',row_value.operations||jsonb_build_array(public.runvara_recovery_operation(ack)))||proof;
 receipt_bytes:=octet_length(public.runvara_recovery_compact(receipt));
 if receipt_bytes>16384 or q.logical_bytes-row_value.logical_bytes+receipt_bytes>16777216 then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_RECEIPT_CAPACITY'; end if;
 insert into public.runvara_order_recovery_receipts values(r->>'workspaceId',r->>'stageId',receipt,receipt_bytes);
 update public.runvara_order_recovery_stages set pending_revision=r->>'nextRevision',pending_digest=encode(sha256(convert_to((r->'state')::text,'UTF8')),'hex') where workspace_id=r->>'workspaceId';
 perform public.runvara_recovery_admission(state_value,r->'admission',r->'actor',old_s->'binding',true);
 update public.saas_workspace_state set state=r->'state',updated_at=clock_timestamp() where workspace_id=r->>'workspaceId' and state->'_revision'=r->'expectedRevision';
 if not found then raise exception using errcode='P0Q04',message='ORDER_RECOVERY_WORKSPACE_CONFLICT'; end if;
 -- Atomic cleanup disposes raw cursors and expired lease/control data only
 -- after promotion and the immutable reconstruction receipt exist together.
 delete from public.runvara_order_recovery_pages where workspace_id=r->>'workspaceId';
 delete from public.runvara_order_recovery_stages where workspace_id=r->>'workspaceId';
 update public.runvara_order_recovery_quota set unfinished_stages=unfinished_stages-1,logical_bytes=logical_bytes-row_value.logical_bytes+receipt_bytes where id;
 return ack;
end $$;
create function public.runvara_read_order_recovery(p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb:=public.runvara_recovery_request(p_request,'read'); state_value jsonb; s jsonb; q jsonb; result jsonb; ctx jsonb; mode_value text;
begin
 if (r->>'view' in ('summary','full','context')) is not true then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_VIEW_INVALID'; end if;
 -- Locking read settles a started transaction. A later new admission fences
 -- old requests which had not yet arrived. Reads never mutate stage status.
 select state into state_value from public.saas_workspace_state where workspace_id=r->>'workspaceId' for update;
 perform public.runvara_recovery_actor(state_value,r->'actor');
 if r->>'view'='context' then
  ctx:=r->'context';
  if not public.runvara_recovery_exact(ctx,array['workspaceId','revision','actorId','connectionId','runId','actorIndex','connectionIndex','runIndex'])
   or ctx->'workspaceId' is distinct from r->'workspaceId' or ctx->'revision' is distinct from state_value->'_revision'
   or ctx->'actorId' is distinct from r#>'{actor,id}' or not public.runvara_recovery_id(ctx->'connectionId') or not public.runvara_recovery_id(ctx->'runId')
   or not public.runvara_recovery_int(ctx->'actorIndex',0,4095) or not public.runvara_recovery_int(ctx->'connectionIndex',0,4095) or not public.runvara_recovery_int(ctx->'runIndex',0,4095) then raise exception using errcode='P0Q04',message='ORDER_RECOVERY_CONTEXT_CHANGED'; end if;
  select stage into s from public.runvara_order_recovery_stages where workspace_id=r->>'workspaceId' and stage_id=r->>'stageId' and not superseded;
  if s is null or s#>'{admissions,-1,runId}' is distinct from ctx->'runId'
   or state_value->'users'->(ctx->>'actorIndex')::integer->'id' is distinct from ctx->'actorId'
   or state_value->'connections'->(ctx->>'connectionIndex')::integer->'id' is distinct from ctx->'connectionId'
   or state_value->'connectionSyncs'->(ctx->>'runIndex')::integer->'id' is distinct from ctx->'runId' then raise exception using errcode='P0Q04',message='ORDER_RECOVERY_CONTEXT_CHANGED'; end if;
  perform public.runvara_recovery_admission(state_value,s#>'{admissions,-1}',r->'actor',s->'binding',true);
  select mode into mode_value from public.runvara_order_recovery_control where id;
  if mode_value is distinct from 'enforced' then raise exception using errcode='P0Q03',message='ORDER_RECOVERY_INACTIVE'; end if;
  result:=jsonb_build_object('schema','shopify-order-recovery-context/v1','mode',mode_value,'workspace_id',r->'workspaceId','revision',state_value->'_revision',
   'workspace',state_value->'workspace','actor',state_value->'users'->(ctx->>'actorIndex')::integer,'connection',state_value->'connections'->(ctx->>'connectionIndex')::integer,
   'run',state_value->'connectionSyncs'->(ctx->>'runIndex')::integer,'settings',state_value#>'{connectionSettings,shopify}','doctor',state_value#>'{connectionDoctor,shopify}',
   'status',state_value#>'{integrationStatus,shopify}','firstSync',state_value#>'{connectionFirstSync,shopify}','sourceGeneration',state_value#>'{channelData,shopify,orderReads,lastSuccess}');
  if octet_length(result::text)>32768 then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_CONTEXT_SIZE'; end if;
  return result;
 end if;
 s:=public.runvara_recovery_stage(r->>'workspaceId');
 if r->'stageId'  is distinct from 'null' and s->'id' is distinct from r->'stageId' then s:=null; end if;
 if s is not null and r->>'view'='summary' then
  s:=s-array['pages','after']||jsonb_build_object('pageCount',jsonb_array_length(s->'pages'),
   'ordersRead',(select coalesce(sum(jsonb_array_length(value->'orders')),0) from jsonb_array_elements(s->'pages')),
   'lastCapturedAt',coalesce(s#>'{pages,-1,capturedAt}','null'),
   'pageCaptureTimes',(select coalesce(jsonb_agg(value->'capturedAt' order by ordinality),'[]') from jsonb_array_elements(s->'pages') with ordinality),
   'snapshotConsistency','unverified');
 end if;
 select jsonb_build_object('unfinishedStages',unfinished_stages,'logicalBytes',logical_bytes,'maxStages',8,'maxBytes',16777216) into q from public.runvara_order_recovery_quota where id;
 result:=jsonb_build_object('schema','shopify-order-recovery-read/v1','mode',(select mode from public.runvara_order_recovery_control where id),'stage',s,'quota',q);
 if octet_length(result::text)>(case when r->>'view'='summary' then 32768 else 2162688 end) then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_RESPONSE_SIZE'; end if;
 return result;
end $$;
create function public.runvara_lookup_order_recovery(p_request text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb:=public.runvara_recovery_request(p_request,'lookup'); state_value jsonb; ack jsonb;
begin
 if (r->>'kind' in ('reserve','append','finalize')) is not true or (r->>'requestFingerprint' ~ '^sha256:[0-9a-f]{64}$') is not true then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_LOOKUP_INVALID'; end if;
 select state into state_value from public.saas_workspace_state where workspace_id=r->>'workspaceId' for update;
 perform public.runvara_recovery_actor(state_value,r->'actor');
 ack:=public.runvara_recovery_find_ack(r->>'workspaceId',r->>'stageId',r->>'kind',r->>'requestFingerprint');
 if octet_length(ack::text)>2048 then raise exception using errcode='P0Q01',message='ORDER_RECOVERY_ACK_SIZE'; end if;
 return ack;
end $$;

do $$
declare t text; f record;
begin
 foreach t in array array['runvara_order_recovery_control','runvara_order_recovery_quota','runvara_order_recovery_stages','runvara_order_recovery_pages','runvara_order_recovery_receipts'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t);
  execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.runvara_recovery_guard_private()',t||'_guard',t);
  execute format('create trigger %I before truncate on public.%I for each statement execute function public.runvara_recovery_guard_private()',t||'_no_truncate',t);
 end loop;
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and (p.proname like 'runvara_recovery_%' or p.proname in ('runvara_reserve_order_recovery','runvara_append_order_recovery','runvara_finalize_order_recovery','runvara_read_order_recovery','runvara_lookup_order_recovery')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.runvara_reserve_order_recovery(text),public.runvara_append_order_recovery(text),public.runvara_finalize_order_recovery(text),
 public.runvara_read_order_recovery(text),public.runvara_lookup_order_recovery(text) to service_role;
commit;
