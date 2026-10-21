-- PREPARED ONLY. Exact-container readiness before publication, sharing the
-- existing ledger's lock, lifetime read budget, account cadence and held slots.
-- Existing post-publication observation contract/provenance is unchanged.
begin;
create table public.runvara_meta_readiness_v1 (
 workspace_id text not null, write_id text not null, request_id text not null,
 kind text not null check(kind in ('admit','settle')), attempt integer not null check(attempt between 1 and 5),
 admission_digest text, event jsonb not null, event_text text not null check(octet_length(event_text)<=4096),
 digest text not null unique, fingerprint text not null, at timestamptz not null, account_key text not null,
 primary key(workspace_id,request_id),
 foreign key(workspace_id,write_id) references public.runvara_meta_ledger_proposals_v1(workspace_id,write_id) on delete restrict
);
create unique index runvara_meta_readiness_settled_once on public.runvara_meta_readiness_v1(admission_digest) where kind='settle';
alter table public.runvara_meta_readiness_v1 enable row level security;
revoke all on public.runvara_meta_readiness_v1 from public,anon,authenticated,service_role;
create trigger runvara_meta_readiness_immutable before update or delete on public.runvara_meta_readiness_v1 for each row execute function public.runvara_meta_immutable();
create trigger runvara_meta_readiness_truncate before truncate on public.runvara_meta_readiness_v1 for each statement execute function public.runvara_meta_immutable();
create function public.runvara_meta_readiness_ack_v1(e public.runvara_meta_readiness_v1,replayed boolean) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('eventText',e.event_text,'digest',e.digest,'replayed',replayed);
$$;
create function public.runvara_commit_meta_readiness_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; b jsonb; s jsonb; p public.runvara_meta_ledger_proposals_v1; c public.runvara_meta_ledger_control_v1;
 a public.runvara_meta_readiness_v1; old public.runvara_meta_readiness_v1; saved public.runvara_meta_readiness_v1;
 now_at timestamptz; first_at timestamptz; last_at timestamptz; n integer; v_account text; container text; fingerprint text; ev jsonb; decision jsonb;
begin
 if p_request is null or octet_length(p_request)>2200000 or not public.runvara_meta_unique(p_request::json) then raise exception using errcode='P0R01',message='META_READINESS_INVALID'; end if;
 r:=p_request::jsonb; b:=r->'binding'; fingerprint:=public.runvara_meta_hash(r-'expectedState');
 if (public.runvara_meta_exact(r,array['contract','workspaceId','writeId','requestId','kind','actor','binding','expectedState','admissionDigest','statusCode'])
  and r->>'contract'='runvara-meta-container-readiness/v1' and r->>'kind' in ('admit','settle')
  and r->'workspaceId'=b->'workspaceId' and r->'writeId'=b->'writeId'
  and (r->'admissionDigest'='null' or jsonb_typeof(r->'admissionDigest')='string' and r->>'admissionDigest' ~ '^[a-f0-9]{64}$')) is not true
  or exists(select 1 from unnest(array['workspaceId','writeId','requestId']) k where jsonb_typeof(r->k) is distinct from 'string' or r->>k !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$') then raise exception using errcode='P0R01',message='META_READINESS_INVALID'; end if;
 select * into c from public.runvara_meta_ledger_control_v1 where id for update;
 if not found then raise exception using errcode='P0R03',message='META_READINESS_CLOSED'; end if;
 select * into p from public.runvara_meta_ledger_proposals_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId';
 if not found or p.binding is distinct from b then raise exception using errcode='P0R04',message='META_READINESS_BINDING'; end if;
 if r->>'kind'='admit' then
  select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for share nowait;
  perform public.runvara_meta_ledger_actor_v1(s,r->'actor',r->>'workspaceId');
 else
  select * into a from public.runvara_meta_readiness_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and digest=r->>'admissionDigest' and kind='admit';
  if not found or a.event->'actor' is distinct from r->'actor' or r->'expectedState'<>'null' then raise exception using errcode='P0R04',message='META_READINESS_ADMISSION_REQUIRED'; end if;
 end if;
 now_at:=clock_timestamp(); if c.last_clock>now_at then raise exception using errcode='P0R03',message='META_READINESS_CLOCK'; end if;
 select * into old from public.runvara_meta_readiness_v1 where workspace_id=r->>'workspaceId' and request_id=r->>'requestId';
 if found then if old.fingerprint<>fingerprint then raise exception using errcode='P0R04',message='META_READINESS_REPLAY_CONFLICT'; end if;
  return public.runvara_meta_readiness_ack_v1(old,true); end if;
 v_account:='meta:'||(b#>>'{target,account}')||':'||(b#>>'{target,instagramId}');
 select event#>>'{data,resultId}' into container from public.runvara_meta_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='settle' and phase='container' and event->'containerConflict'='false';
 if container is null or container !~ '^[0-9]{1,32}$' then raise exception using errcode='P0R04',message='META_READINESS_CONTAINER_REQUIRED'; end if;
 if r->>'kind'='admit' then
  if c.mode<>'fixture' or r->'admissionDigest'<>'null' or r->'statusCode'<>'null' or s is distinct from r->'expectedState'
   or exists(select 1 from public.runvara_meta_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit' and phase='publish') then raise exception using errcode='P0R03',message='META_READINESS_CLOSED_OR_CHANGED'; end if;
  perform public.runvara_meta_ledger_binding_v1(s,b,r->'actor');
  select value-array['executedExternally','executionStatus','workStatus'] into decision from jsonb_array_elements(s->'approvals') where value->'id'=b->'approvalId';
  if decision is distinct from p.approval_decision then raise exception using errcode='P0R04',message='META_READINESS_APPROVAL_CHANGED'; end if;
  select count(*),min(at) into n,first_at from (
   select at from public.runvara_meta_readiness_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit'
   union all select at from public.runvara_meta_ledger_events_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit' and phase='read') attempts;
  select max(at) into last_at from (
   select at from public.runvara_meta_readiness_v1 where account_key=v_account and kind='admit'
   union all select at from public.runvara_meta_ledger_events_v1 where account_key=v_account and kind='admit' and phase='read') attempts;
  if n>=5 or first_at is not null and now_at>first_at+interval '5 minutes' or last_at is not null and now_at<last_at+interval '60 seconds' then raise exception using errcode='P0R03',message='META_READINESS_BUDGET'; end if;
  if (select count(*) from (
   select e.account_key from public.runvara_meta_readiness_v1 e where kind='admit' and not exists(select 1 from public.runvara_meta_readiness_v1 x where x.kind='settle' and x.admission_digest=e.digest)
   union all select e.account_key from public.runvara_meta_ledger_events_v1 e where kind='admit' and not exists(select 1 from public.runvara_meta_ledger_events_v1 x where x.kind='settle' and x.admission_digest=e.event_digest and x.event->'containerConflict'='false')) held)>=2
   or exists(select 1 from (
    select e.account_key from public.runvara_meta_readiness_v1 e where kind='admit' and not exists(select 1 from public.runvara_meta_readiness_v1 x where x.kind='settle' and x.admission_digest=e.digest)
    union all select e.account_key from public.runvara_meta_ledger_events_v1 e where kind='admit' and not exists(select 1 from public.runvara_meta_ledger_events_v1 x where x.kind='settle' and x.admission_digest=e.event_digest and x.event->'containerConflict'='false')) held where account_key=v_account) then raise exception using errcode='P0R03',message='META_READINESS_ACTIVE_LIMIT'; end if;
  n:=n+1;
 else
  n:=a.attempt;
  if r->>'statusCode' not in ('IN_PROGRESS','FINISHED','PUBLISHED','ERROR','EXPIRED') or jsonb_typeof(r->'statusCode') is distinct from 'string'
   or exists(select 1 from public.runvara_meta_readiness_v1 where kind='settle' and admission_digest=a.digest) then raise exception using errcode='P0R04',message='META_READINESS_SETTLEMENT'; end if;
 end if;
 ev:=jsonb_build_object('contract','runvara-meta-container-readiness/v1','provenance','native_fixture_no_provider_action/v1',
  'workspaceId',r->'workspaceId','writeId',r->'writeId','requestId',r->'requestId','kind',r->'kind','actor',r->'actor',
  'bindingDigest',p.binding_digest,'containerId',container,'attempt',n,'admissionDigest',r->'admissionDigest','statusCode',r->'statusCode',
  'approvalDigest',public.runvara_meta_hash(p.approval_decision),'at',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'requestFingerprint',fingerprint,'providerReadPerformed',false);
 insert into public.runvara_meta_readiness_v1 values(r->>'workspaceId',r->>'writeId',r->>'requestId',r->>'kind',n,r->>'admissionDigest',ev,public.runvara_meta_canonical(ev),public.runvara_meta_hash(ev),fingerprint,now_at,v_account) returning * into saved;
 update public.runvara_meta_ledger_control_v1 set barrier=barrier+1,last_clock=now_at where id;
 return public.runvara_meta_readiness_ack_v1(saved,false);
end $$;
create function public.runvara_read_meta_readiness_v1(p_request text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; s jsonb; a public.runvara_meta_readiness_v1; done public.runvara_meta_readiness_v1;
begin
 if p_request is null or octet_length(p_request)>4096 or not public.runvara_meta_unique(p_request::json) then raise exception using errcode='P0R01',message='META_READINESS_INVALID'; end if;
 r:=p_request::jsonb;
 if (public.runvara_meta_exact(r,array['contract','workspaceId','writeId','bindingDigest','actor']) and r->>'contract'='runvara-meta-container-readiness/v1'
  and r->>'bindingDigest' ~ '^[a-f0-9]{64}$') is not true then raise exception using errcode='P0R01',message='META_READINESS_INVALID'; end if;
 select state into s from public.saas_workspace_state where workspace_id=r->>'workspaceId' for share;
 perform public.runvara_meta_ledger_actor_v1(s,r->'actor',r->>'workspaceId');
 select * into a from public.runvara_meta_readiness_v1 where workspace_id=r->>'workspaceId' and write_id=r->>'writeId' and kind='admit' and event->'bindingDigest'=r->'bindingDigest' order by attempt desc limit 1;
 if not found then return null; end if;
 select * into done from public.runvara_meta_readiness_v1 where kind='settle' and admission_digest=a.digest;
 return jsonb_build_object('admission',public.runvara_meta_readiness_ack_v1(a,true),'settlement',case when done.digest is null then null else public.runvara_meta_readiness_ack_v1(done,true) end);
end $$;
-- Sharing the lock is insufficient unless admissions in both contracts count
-- both kinds of held work and read debt. This guard enforces the reverse order.
create function public.runvara_meta_readiness_ledger_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.runvara_meta_readiness_v1; done public.runvara_meta_readiness_v1; ready_count integer; held_count integer; first_at timestamptz; last_at timestamptz;
begin
 if new.kind<>'admit' then return new; end if;
 select count(*) into held_count from public.runvara_meta_readiness_v1 r where kind='admit' and not exists(select 1 from public.runvara_meta_readiness_v1 x where x.kind='settle' and x.admission_digest=r.digest);
 if held_count+(select count(*) from public.runvara_meta_ledger_events_v1 e where kind='admit' and not exists(select 1 from public.runvara_meta_ledger_events_v1 x where x.kind='settle' and x.admission_digest=e.event_digest and x.event->'containerConflict'='false'))>=2
  or exists(select 1 from public.runvara_meta_readiness_v1 r where kind='admit' and account_key=new.account_key and not exists(select 1 from public.runvara_meta_readiness_v1 x where x.kind='settle' and x.admission_digest=r.digest)) then raise exception using errcode='P0R03',message='META_READINESS_SHARED_ACTIVE'; end if;
 if new.phase='read' then
  select count(*),min(at) into ready_count,first_at from public.runvara_meta_readiness_v1 where workspace_id=new.workspace_id and write_id=new.write_id and kind='admit';
  select max(at) into last_at from public.runvara_meta_readiness_v1 where account_key=new.account_key and kind='admit';
  if ready_count+(select count(*) from public.runvara_meta_ledger_events_v1 where workspace_id=new.workspace_id and write_id=new.write_id and kind='admit' and phase='read')>=5
   or first_at is not null and new.at>first_at+interval '5 minutes' or last_at is not null and new.at<last_at+interval '60 seconds' then raise exception using errcode='P0R03',message='META_READINESS_SHARED_BUDGET'; end if;
 end if;
 if new.phase='publish' and exists(select 1 from public.runvara_meta_ledger_proposals_v1 p where p.workspace_id=new.workspace_id and p.write_id=new.write_id and p.binding#>>'{asset,mediaType}'='image/jpeg') then
  select * into a from public.runvara_meta_readiness_v1 where workspace_id=new.workspace_id and write_id=new.write_id and kind='admit' order by attempt desc limit 1;
  select * into done from public.runvara_meta_readiness_v1 where kind='settle' and admission_digest=a.digest;
  if a.digest is null or done.event->>'statusCode' is distinct from 'FINISHED' or a.at<=new.at-interval '60 seconds' or done.at<a.at or done.at>new.at or a.event->'containerId' is distinct from new.event->'containerId'
   or a.event->'actor' is distinct from new.event->'actor' or a.event->'approvalDigest' is distinct from new.event->'approvalDigest' then raise exception using errcode='P0R04',message='META_READINESS_REQUIRED'; end if;
 end if;
 return new;
end $$;
create trigger runvara_meta_readiness_admission_guard before insert on public.runvara_meta_ledger_events_v1 for each row execute function public.runvara_meta_readiness_ledger_guard_v1();
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and
  (proname like 'runvara_meta_readiness_%' or proname in ('runvara_commit_meta_readiness_v1','runvara_read_meta_readiness_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.runvara_commit_meta_readiness_v1(text),public.runvara_read_meta_readiness_v1(text) to service_role;
commit;
