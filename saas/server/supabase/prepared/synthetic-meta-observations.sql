-- Prepared local acceptance only; not run by deployment/startup.
-- Requires synthetic-meta-receipts.sql. Never grants real publishing authority.
begin;
create table public.runvara_meta_observation_control (
 id boolean primary key default true check(id), mode text not null check(mode in ('prepared','enforced','paused'))
);
insert into public.runvara_meta_observation_control values(true,'prepared');
create table public.runvara_meta_observations (
 workspace_id text not null, write_id text not null, sequence integer not null check(sequence between 1 and 8),
 receipt_sequence integer not null, request_id text not null,
 observation_text text not null check(octet_length(observation_text)<=4096),
 observation_digest text not null check(observation_digest ~ '^[a-f0-9]{64}$'), retained_at timestamptz not null default now(),
 primary key(workspace_id,write_id,sequence), unique(workspace_id,write_id,request_id),
 foreign key(workspace_id,write_id,receipt_sequence) references public.runvara_meta_receipt_events(workspace_id,write_id,sequence) on delete restrict
);
alter table public.runvara_meta_observation_control enable row level security;
alter table public.runvara_meta_observations enable row level security;
revoke all on public.runvara_meta_observation_control,public.runvara_meta_observations from public,anon,authenticated,service_role;
create trigger runvara_meta_observations_immutable before update or delete on public.runvara_meta_observations for each row execute function public.runvara_meta_immutable();
create trigger runvara_meta_observations_no_truncate before truncate on public.runvara_meta_observations for each statement execute function public.runvara_meta_immutable();

create function public.runvara_meta_observation_request(p_request text, appending boolean) returns jsonb language plpgsql immutable set search_path='' as $$
declare r jsonb;
begin
 if p_request is null or octet_length(p_request)>10240 or not public.runvara_meta_unique(p_request::json) then
  raise exception using errcode='P0O01',message='META_OBSERVATION_INVALID'; end if;
 r:=p_request::jsonb;
 if not public.runvara_meta_exact(r,case when appending then array['contract','workspaceId','writeId','actor','descriptor'] else array['contract','workspaceId','writeId','actor'] end)
  or (r->>'contract'='runvara-synthetic-meta-observations/v1' and jsonb_typeof(r->'workspaceId')='string' and jsonb_typeof(r->'writeId')='string'
   and r->>'workspaceId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
   and r->>'writeId' ~ '^write_[a-f0-9-]{36}$') is not true then
  raise exception using errcode='P0O01',message='META_OBSERVATION_INVALID'; end if;
 return r;
end $$;
create function public.runvara_meta_observation_anchor(r jsonb) returns jsonb language plpgsql set search_path='' as $$
declare s jsonb; e public.runvara_meta_receipt_events; w jsonb; a jsonb;
begin
 select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for share;
 perform public.runvara_meta_actor(s,r->'actor');
 select * into e from public.runvara_meta_receipt_events where workspace_id=r->>'workspaceId' and write_id=r->>'writeId'
  and projection#>'{write,dispatchClaim,phases}' ? 'instagram_publish' order by sequence limit 1;
 if not found then raise exception using errcode='P0O01',message='META_OBSERVATION_NO_KNOWN_PUBLISH_ADMISSION'; end if;
 w:=e.projection->'write';
 if (w->'requestedBy'=r#>'{actor,userId}' and w#>'{marketingPublication,actorSessionVersion}'=r#>'{actor,sessionVersion}') is not true then
  raise exception using errcode='P0O02',message='META_OBSERVATION_AUTHORITY_CHANGED'; end if;
 a:=jsonb_build_object('workspaceId',r->'workspaceId','writeId',r->'writeId','receiptSequence',e.sequence,'receiptDigest',e.event_digest,
  'publicationDigest',w#>'{marketingPublication,digest}','connectionId',w#>'{marketingPublication,target,connectionId}',
  'account',w#>'{marketingPublication,target,account}','pageId',w#>'{marketingPublication,target,pageId}',
  'instagramId',w#>'{marketingPublication,target,instagramId}','containerId',w#>'{providerState,containerId}');
 if (a->>'containerId' ~ '^\d{1,32}$' and a->'containerId'=w#>'{dispatchClaim,phases,instagram_container,resultId}') is not true then
  raise exception using errcode='P0O01',message='META_OBSERVATION_INVALID'; end if;
 return a;
end $$;
create function public.runvara_meta_observation_descriptor(e public.runvara_meta_observations) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('contract','runvara-synthetic-meta-observations/v1','observationText',e.observation_text,'digest',e.observation_digest);
$$;
create function public.runvara_read_meta_observations(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb:=public.runvara_meta_observation_request(p_request,false); rows jsonb;
begin
 perform public.runvara_meta_observation_anchor(r);
 select coalesce(jsonb_agg(public.runvara_meta_observation_descriptor(e) order by sequence),'[]') into rows
  from public.runvara_meta_observations e where workspace_id=r->>'workspaceId' and write_id=r->>'writeId';
 return jsonb_build_object('contract',r->'contract','workspaceId',r->'workspaceId','writeId',r->'writeId','observations',rows);
end $$;
create function public.runvara_append_meta_observation(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb:=public.runvara_meta_observation_request(p_request,true); a jsonb; d jsonb:=r->'descriptor'; o jsonb;
 old public.runvara_meta_observations; saved public.runvara_meta_observations; control_mode text; n integer; latest public.runvara_meta_receipt_events;
begin
 -- A global lock bounds total retention and serializes concurrent appends.
 -- No workspace state, receipt, approval or dispatch claim is updated here.
 select mode into control_mode from public.runvara_meta_observation_control where id for update;
 a:=public.runvara_meta_observation_anchor(r);
 if not public.runvara_meta_exact(d,array['contract','observationText','digest'])
  or (d->'contract'=r->'contract' and jsonb_typeof(d->'observationText')='string' and octet_length(d->>'observationText')<=4096
   and d->>'digest'=encode(sha256(convert_to(d->>'observationText','UTF8')),'hex')) is not true
  or not public.runvara_meta_unique((d->>'observationText')::json) then
  raise exception using errcode='P0O01',message='META_OBSERVATION_INVALID'; end if;
 o:=(d->>'observationText')::jsonb;
 if not public.runvara_meta_exact(o,array['anchor','requestId','actor','observedAt','statusCode','resultId','outcome','source','simulated','executedExternally','providerReadPerformed','replayPermitted'])
  or (d->>'observationText'=public.runvara_meta_canonical(o) and o->'anchor'=a and o->'actor'=r->'actor'
   and jsonb_typeof(o->'requestId')='string' and o->>'requestId' ~ '^[A-Za-z0-9_-]{16,80}$' and jsonb_typeof(o->'observedAt')='string'
   and o->>'observedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
   and o->>'statusCode' in ('IN_PROGRESS','FINISHED','PUBLISHED','ERROR','EXPIRED') and o->'resultId'='null'::jsonb
   and o->>'outcome'='unresolved_do_not_resend' and o->>'source'='fixed_simulated_meta_container_status/v1'
   and o->'simulated'='true'::jsonb and o->'executedExternally'='false'::jsonb and o->'providerReadPerformed'='false'::jsonb
   and o->'replayPermitted'='false'::jsonb) is not true then
  raise exception using errcode='P0O01',message='META_OBSERVATION_INVALID'; end if;
 select * into old from public.runvara_meta_observations where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and request_id=o->>'requestId';
 if found then
  if old.observation_text<>d->>'observationText' or old.observation_digest<>d->>'digest' then
   raise exception using errcode='P0O04',message='META_OBSERVATION_CONFLICT'; end if;
  return public.runvara_meta_observation_descriptor(old);
 end if;
 select * into latest from public.runvara_meta_receipt_events where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' order by sequence desc limit 1;
 if latest.projection#>>'{write,status}' not in ('uncertain','executing') then
  raise exception using errcode='P0O04',message='META_OBSERVATION_CONFLICT'; end if;
 begin
 if to_char((o->>'observedAt')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>o->>'observedAt'
  or (o->>'observedAt')::timestamptz not between now()-interval '5 minutes' and now()+interval '5 minutes' then
  raise exception using errcode='P0O01',message='META_OBSERVATION_INVALID'; end if;
 exception when invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode='P0O01',message='META_OBSERVATION_INVALID';
 end;
 select count(*) into n from public.runvara_meta_observations where workspace_id=r->>'workspaceId' and write_id=r->>'writeId';
 if control_mode is distinct from 'enforced' or n>=8
  or (select count(*) from public.runvara_meta_observations where workspace_id=r->>'workspaceId')>=64
  or (select count(*) from public.runvara_meta_observations)>=1024 then
  raise exception using errcode='P0O03',message='META_OBSERVATION_CAPACITY_OR_MODE'; end if;
 insert into public.runvara_meta_observations(workspace_id,write_id,sequence,receipt_sequence,request_id,observation_text,observation_digest)
  values(r->>'workspaceId',r->>'writeId',n+1,(a->>'receiptSequence')::integer,o->>'requestId',d->>'observationText',d->>'digest') returning * into saved;
 return public.runvara_meta_observation_descriptor(saved);
end $$;
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and
  (proname like 'runvara_meta_observation_%' or proname in ('runvara_read_meta_observations','runvara_append_meta_observation')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.runvara_read_meta_observations(text),public.runvara_append_meta_observation(text) to service_role;
commit;
