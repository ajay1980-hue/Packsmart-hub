-- PREPARED ONLY: existing database; no startup/migration import, live mode or
-- anonymous storage grant. Requires meta-publication-ledger-v1.sql helpers.
begin;
create table public.runvara_meta_asset_control_v1 (
 id boolean primary key default true check(id), mode text not null check(mode in ('prepared','fixture','paused')),
 last_clock timestamptz
);
insert into public.runvara_meta_asset_control_v1 values(true,'prepared',null);
create table public.runvara_meta_assets_v1 (
 workspace_id text not null references public.saas_workspace_state(workspace_id) on delete restrict,
 asset_id text not null, request_id text not null, descriptor jsonb not null,
 digest text not null unique check(digest ~ '^[a-f0-9]{64}$'), bytes bytea not null check(octet_length(bytes) between 100 and 2097152),
 created_at timestamptz not null, expires_at timestamptz not null,
 primary key(workspace_id,asset_id), unique(workspace_id,request_id), check(octet_length(descriptor::text)<=16384)
);
alter table public.runvara_meta_asset_control_v1 enable row level security;
alter table public.runvara_meta_assets_v1 enable row level security;
revoke all on public.runvara_meta_asset_control_v1,public.runvara_meta_assets_v1 from public,anon,authenticated,service_role;
create trigger runvara_meta_assets_immutable before update or delete on public.runvara_meta_assets_v1 for each row execute function public.runvara_meta_immutable();
create trigger runvara_meta_assets_truncate before truncate on public.runvara_meta_assets_v1 for each statement execute function public.runvara_meta_immutable();
create function public.runvara_meta_asset_ack_v1(a public.runvara_meta_assets_v1,replayed boolean) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('contract','runvara-meta-durable-asset/v1','descriptorText',public.runvara_meta_canonical(a.descriptor),
  'digest',a.digest,'bytesBase64',replace(encode(a.bytes,'base64'),E'\n',''),'replayed',replayed,'providerDeliveryVerified',false);
$$;
create function public.runvara_commit_meta_asset_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; d jsonb; i jsonb; s jsonb; b bytea; prior public.runvara_meta_assets_v1; saved public.runvara_meta_assets_v1;
 control public.runvara_meta_asset_control_v1; now_at timestamptz; expires timestamptz;
begin
 if p_request is null or octet_length(p_request)>5100000 or not public.runvara_meta_unique(p_request::json) then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 r:=p_request::jsonb; d:=r->'descriptor'; i:=d->'image';
 if (public.runvara_meta_exact(r,array['contract','descriptor','expectedState','bytesBase64']) and r->>'contract'='runvara-meta-durable-asset/v1'
  and public.runvara_meta_exact(d,array['contract','provenance','workspaceId','campaignId','requestId','assetId','actor','selection','sourceRevision','referenceDigest','image','origin','tokenDigest','expiresAt','providerDeliveryVerified'])
  and d->>'contract'='runvara-meta-durable-asset/v1' and d->>'provenance'='native_fixture_no_provider_action/v1'
  and d->'providerDeliveryVerified'='false' and d->>'origin' ~ '^https://[a-z0-9-]+(\.[a-z0-9-]+)*\.invalid$'
  and d->>'assetId'=public.runvara_meta_hash(jsonb_build_object('workspaceId',d->'workspaceId','campaignId',d->'campaignId','requestId',d->'requestId','sha256',i->'sha256'))
  and public.runvara_meta_exact(d->'selection',array['pageId','creativeRequestId','assetUrl'])
  and jsonb_typeof(d#>'{selection,pageId}')='string' and d#>>'{selection,pageId}' ~ '^[0-9]{1,32}$'
  and jsonb_typeof(d#>'{selection,creativeRequestId}')='string' and d#>>'{selection,creativeRequestId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
  and jsonb_typeof(d#>'{selection,assetUrl}')='string' and length(d#>>'{selection,assetUrl}') between 1 and 2000
  and jsonb_typeof(d->'expiresAt')='number' and d->>'expiresAt' ~ '^[1-9][0-9]{12}$'
  and public.runvara_meta_exact(i,array['schema','mediaType','sha256','byteLength','width','height','pixelSha256','pixelByteLength','decoder','decoded','providerDeliveryVerified'])
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
 select * into control from public.runvara_meta_asset_control_v1 where id for update;
 if not found or control.mode<>'fixture' then raise exception using errcode='P0A03',message='META_ASSET_CLOSED'; end if;
 -- Nonwaiting lock avoids a cycle with old workspace writers. Clock sampled
 -- only after both locks; expiry and permanent capacity cannot be renewed.
 select state into s from public.saas_workspace_state where workspace_id=d->>'workspaceId' for share nowait;
 now_at:=clock_timestamp();
 if control.last_clock>now_at then raise exception using errcode='P0A03',message='META_ASSET_CLOCK'; end if;
 perform public.runvara_meta_ledger_actor_v1(s,d->'actor',d->>'workspaceId');
 select * into prior from public.runvara_meta_assets_v1 where workspace_id=d->>'workspaceId' and request_id=d->>'requestId';
 if found then
  if prior.descriptor is distinct from d or prior.bytes is distinct from b then raise exception using errcode='P0A04',message='META_ASSET_REQUEST_CONFLICT'; end if;
  return public.runvara_meta_asset_ack_v1(prior,true);
 end if;
 if s is distinct from r->'expectedState' then raise exception using errcode='P0A04',message='META_ASSET_SOURCE_CHANGED'; end if;
 if (select count(*) from jsonb_array_elements(s#>'{marketing,campaigns}') c where c->'id'=d->'campaignId')<>1 then raise exception using errcode='P0A04',message='META_ASSET_CAMPAIGN'; end if;
 if (select count(*) from public.runvara_meta_assets_v1)>=128 or (select count(*) from public.runvara_meta_assets_v1 where workspace_id=d->>'workspaceId')>=16 then raise exception using errcode='P0A03',message='META_ASSET_CAPACITY'; end if;
 expires:=to_timestamp((d->>'expiresAt')::numeric/1000);
 if expires<now_at+interval '5 minutes' or expires>now_at+interval '24 hours' then raise exception using errcode='P0A03',message='META_ASSET_EXPIRY'; end if;
 insert into public.runvara_meta_assets_v1 values(d->>'workspaceId',d->>'assetId',d->>'requestId',d,public.runvara_meta_hash(d),b,now_at,expires) returning * into saved;
 update public.runvara_meta_asset_control_v1 set last_clock=now_at where id;
 return public.runvara_meta_asset_ack_v1(saved,false);
end $$;
create function public.runvara_read_meta_asset_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; s jsonb; a public.runvara_meta_assets_v1;
begin
 if p_request is null or octet_length(p_request)>4096 or not public.runvara_meta_unique(p_request::json) then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 r:=p_request::jsonb;
 if (public.runvara_meta_exact(r,array['contract','workspaceId','assetId','digest','actor']) and r->>'contract'='runvara-meta-durable-asset/v1'
  and jsonb_typeof(r->'workspaceId')='string' and r->>'workspaceId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
  and jsonb_typeof(r->'assetId')='string' and r->>'assetId' ~ '^[a-f0-9]{64}$'
  and jsonb_typeof(r->'digest')='string' and r->>'digest' ~ '^[a-f0-9]{64}$') is not true then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for share;
 perform public.runvara_meta_ledger_actor_v1(s,r->'actor',r->>'workspaceId');
 select * into a from public.runvara_meta_assets_v1 where workspace_id=r->>'workspaceId' and asset_id=r->>'assetId' and digest=r->>'digest';
 if not found then return null; end if;
 return public.runvara_meta_asset_ack_v1(a,true);
end $$;
create function public.runvara_deliver_meta_asset_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; a public.runvara_meta_assets_v1; c public.runvara_meta_asset_control_v1; now_at timestamptz; s jsonb;
begin
 if p_request is null or octet_length(p_request)>1024 or not public.runvara_meta_unique(p_request::json) then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 r:=p_request::jsonb;
 if (public.runvara_meta_exact(r,array['contract','digest','token']) and r->>'contract'='runvara-meta-durable-asset/v1'
  and jsonb_typeof(r->'digest')='string' and r->>'digest' ~ '^[a-f0-9]{64}$'
  and jsonb_typeof(r->'token')='string' and r->>'token' ~ '^[a-f0-9]{64}$') is not true then raise exception using errcode='P0A01',message='META_ASSET_INVALID'; end if;
 select * into c from public.runvara_meta_asset_control_v1 where id for update; now_at:=clock_timestamp();
 if not found or c.mode<>'fixture' or c.last_clock>now_at then raise exception using errcode='P0A03',message='META_ASSET_CLOSED'; end if;
 -- Preserve the high-water clock even on expiry/missing-token denial. A later
 -- backwards clock must never make an already expired delivery work again.
 update public.runvara_meta_asset_control_v1 set last_clock=now_at where id;
 select * into a from public.runvara_meta_assets_v1 where digest=r->>'digest' and descriptor->>'tokenDigest'=encode(sha256(convert_to(r->>'token','UTF8')),'hex') and expires_at>now_at;
 if not found then return null; end if;
 select state into s from public.saas_workspace_state where workspace_id=a.workspace_id for share nowait;
 perform public.runvara_meta_ledger_actor_v1(s,a.descriptor->'actor',a.workspace_id);
 return public.runvara_meta_asset_ack_v1(a,true);
end $$;
-- When this prepared extension is installed, JPEG proposals and admissions
-- must name the immutable retained delivery, never an invented digest. The
-- pre-existing PNG fixture contract is unchanged and has no transport issuer.
create function public.runvara_meta_asset_ledger_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare b jsonb; a public.runvara_meta_assets_v1; c public.runvara_meta_asset_control_v1; now_at timestamptz;
begin
 if tg_table_name='runvara_meta_ledger_proposals_v1' then b:=new.binding;
 elsif new.kind='admit' and new.phase in ('container','publish') then
  select binding into b from public.runvara_meta_ledger_proposals_v1 where workspace_id=new.workspace_id and write_id=new.write_id;
 else return new; end if;
 if b#>>'{asset,mediaType}'<>'image/jpeg' then return new; end if;
 select * into c from public.runvara_meta_asset_control_v1 where id for share nowait; now_at:=clock_timestamp();
 if not found or c.mode<>'fixture' or c.last_clock>now_at then raise exception using errcode='P0A03',message='META_ASSET_CLOSED'; end if;
 select * into a from public.runvara_meta_assets_v1 where workspace_id=b->>'workspaceId' and digest=b#>>'{asset,deliveryDigest}';
 if not found or a.expires_at<now_at+interval '60 seconds' or a.descriptor->'actor' is distinct from b->'actor'
  or a.descriptor->'campaignId' is distinct from b->'campaignId' or a.descriptor->'sourceRevision' is distinct from b->'sourceRevision'
  or a.descriptor->'selection' is distinct from b->'selection' or a.descriptor#>'{image,sha256}' is distinct from b#>'{asset,sha256}'
  or a.descriptor#>'{image,byteLength}' is distinct from b#>'{asset,byteLength}' then raise exception using errcode='P0A04',message='META_ASSET_BINDING_REQUIRED'; end if;
 return new;
end $$;
create trigger runvara_meta_asset_proposal_guard before insert on public.runvara_meta_ledger_proposals_v1 for each row execute function public.runvara_meta_asset_ledger_guard_v1();
create trigger runvara_meta_asset_admission_guard before insert on public.runvara_meta_ledger_events_v1 for each row execute function public.runvara_meta_asset_ledger_guard_v1();
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and
  (proname like 'runvara_meta_asset_%' or proname in ('runvara_commit_meta_asset_v1','runvara_read_meta_asset_v1','runvara_deliver_meta_asset_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.runvara_commit_meta_asset_v1(text),public.runvara_read_meta_asset_v1(text),public.runvara_deliver_meta_asset_v1(text) to service_role;
commit;
