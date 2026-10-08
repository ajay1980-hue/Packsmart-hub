-- PREPARED ONLY. Applying this migration or activating capture requires separate
-- approval. The latch starts inactive; no startup task applies or activates it.
-- Prospective Shopify product_content only. No backfill, expiry, deletion,
-- capacity reclamation, provider calls, or provider-signed attestation.
begin;

create table public.runvara_content_receipt_control (
  id boolean primary key default true check (id),
  mode text not null check (mode in ('prepared','enforced','paused'))
);
insert into public.runvara_content_receipt_control(id,mode) values(true,'prepared');

create table public.runvara_content_receipt_quotas (
  scope_key text primary key,
  workspace_id text unique references public.saas_workspace_state(workspace_id) on delete restrict,
  quota jsonb not null,
  check ((workspace_id is null and scope_key='global') or
    (workspace_id is not null and scope_key='tenant:'||workspace_id)),
  check ((jsonb_typeof(quota)='object' and octet_length(quota::text)<=1024
    and quota->>'schema'='runvara-content-receipt-quota/v1'
    and jsonb_typeof(quota->'attempts')='number' and (quota->>'attempts') ~ '^[0-9]+$'
    and (quota->>'attempts')::integer between 0 and case when workspace_id is null then 1024 else 256 end
    and jsonb_typeof(quota->'reservedBytes')='number'
    and (quota->>'reservedBytes')::bigint=(quota->>'attempts')::integer*40960) is true)
);
insert into public.runvara_content_receipt_quotas(scope_key,workspace_id,quota)
  values('global',null,'{"schema":"runvara-content-receipt-quota/v1","attempts":0,"reservedBytes":0}'::jsonb);

create table public.runvara_content_admissions (
  workspace_id text not null references public.saas_workspace_state(workspace_id) on delete restrict,
  attempt_id text not null check (attempt_id ~ '^content_attempt_[0-9a-f]{64}$'),
  write_id text not null,
  admission jsonb not null check (jsonb_typeof(admission)='object' and octet_length(admission::text)<=4096),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  expected_revision text not null,
  commit_revision text not null,
  -- Digest of a fixed SQL projection; no duplicated source or state snapshot.
  write_identity_digest text not null check (write_identity_digest ~ '^[0-9a-f]{64}$'),
  primary key(workspace_id,attempt_id),
  unique(workspace_id,write_id),
  unique(workspace_id,commit_revision)
);
create unique index runvara_content_admission_claim_unique on public.runvara_content_admissions
  (workspace_id,(admission->>'claimId'),(admission->>'phase'));

create table public.runvara_content_receipts (
  workspace_id text not null,
  attempt_id text not null,
  receipt jsonb not null check (jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=36864),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  expected_revision text not null,
  commit_revision text not null,
  final_projection_digest text not null check (final_projection_digest ~ '^[0-9a-f]{64}$'),
  primary key(workspace_id,attempt_id),
  unique(workspace_id,commit_revision),
  foreign key(workspace_id,attempt_id) references public.runvara_content_admissions(workspace_id,attempt_id) on delete restrict
);

alter table public.runvara_content_receipt_control enable row level security;
alter table public.runvara_content_receipt_quotas enable row level security;
alter table public.runvara_content_admissions enable row level security;
alter table public.runvara_content_receipts enable row level security;
revoke all on public.runvara_content_receipt_control,public.runvara_content_receipt_quotas,
  public.runvara_content_admissions,public.runvara_content_receipts from public,anon,authenticated,service_role;

-- The wrapper can exceed the existing source canonicalizer's 32 KiB root
-- envelope. Canonicalize its individually bounded members, without widening
-- the existing source/publication contract or hashing arbitrary workspace JSON.
create function public.runvara_content_receipt_hash(p_value jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare encoded text;
begin
  if jsonb_typeof(p_value) is distinct from 'object' or octet_length(p_value::text)>36864 then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_INPUT_INVALID';
  end if;
  select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.runvara_outcome_canonical(value),',' order by key collate "C"),'')||'}'
    into encoded from jsonb_each(p_value);
  return encode(sha256(convert_to(encoded,'UTF8')),'hex');
end $$;

create function public.runvara_content_write_identity(p_write jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('id',p_write->'id','requestId',p_write->'requestId','provider',p_write->'provider',
    'input',p_write->'input','digest',p_write->'digest','connectionId',p_write->'connectionId','account',p_write->'account',
    'requestedBy',p_write->'requestedBy','requiresApproval',p_write->'requiresApproval','approvalId',p_write->'approvalId',
    -- Validated claims contain string identities/timestamps and the fixed phase
    -- object. Its SQL-normalized text also preserves unknown-field changes while
    -- keeping legacy shopify_mutation keys out of the camelCase canonicalizer.
    'objectivePolicyProposal',p_write->'objectivePolicyProposal','dispatchClaim',(p_write->'dispatchClaim')::text);
$$;
create function public.runvara_content_final_projection(p_write jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('identity',public.runvara_content_write_identity(p_write),'status',p_write->'status',
    'result',p_write->'result','completedAt',p_write->'completedAt','errorCode',p_write->'errorCode',
    'observationErrorCode',p_write->'observationErrorCode','dispatchBlocked',p_write->'dispatchBlocked');
$$;

create function public.runvara_content_request(p_request_json text,p_kind text)
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
    or (r->>'contract'='runvara-content-execution-receipts/v1' and r->>'kind'=p_kind
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

create function public.runvara_content_validate_admission(p_admission jsonb,p_workspace_id text)
returns void language plpgsql immutable security invoker set search_path='' as $$
declare k text;
begin
  if not public.runvara_outcome_exact(p_admission,array['schema','workspaceId','attemptId','writeId','requestId','claimId','claimIdentity',
      'authorityDigest','actorId','actorSessionVersion','phase','dispatchRequestDigest','intentDigest','admittedAt','reservedBytes','digest'])
    or octet_length(p_admission::text)>4096 then raise exception using errcode='P0R01',message='CONTENT_RECEIPT_ADMISSION_INVALID'; end if;
  if (p_admission->>'schema'='runvara-content-execution-admission/v1' and p_admission->'workspaceId'=to_jsonb(p_workspace_id)
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

create function public.runvara_content_source_intent(p_source jsonb)
returns text language sql immutable security invoker set search_path='' as $$
  select public.runvara_outcome_hash(jsonb_set(p_source-'digest','{context,completedAt}','null'::jsonb));
$$;

-- Returns a source only after comparing it with the actual workspace action.
-- During reserve only, a detached validation copy models the bounded future
-- completion; no synthetic completion or source template is ever persisted.
create function public.runvara_content_validate_source(p_state jsonb,p_admission jsonb,p_source jsonb,p_template boolean)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare w jsonb; a jsonb; connection jsonb; c jsonb:=p_source->'context'; field text;
  write_index integer; approval_index integer; probe jsonb; resolved jsonb;
begin
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

-- One bounded index per state, storing only counts and numeric offsets. Group
-- by ->>id exactly as the original scans did: numeric/string aliases must count
-- as duplicates. Null IDs cannot match a protected identity. No action bodies
-- are copied into this index.
create function public.runvara_content_write_index(p_writes jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare indexed jsonb;
begin
  if jsonb_typeof(p_writes) is distinct from 'array' or jsonb_array_length(p_writes)>10000 then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_WORKSPACE_TOO_LARGE'; end if;
  select coalesce(jsonb_object_agg(write_id,jsonb_build_array(n,position)),'{}'::jsonb) into indexed
    from (select value->>'id' write_id,count(*) n,min(ordinality)-1 position
      from jsonb_array_elements(p_writes) with ordinality where value->>'id' is not null group by value->>'id') x;
  return indexed;
end $$;

create function public.runvara_content_make_receipt(p_admission jsonb,p_source jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare receipt jsonb;
begin
  receipt:=jsonb_build_object('schema','runvara-content-execution-receipt/v1','workspaceId',p_admission->'workspaceId',
    'attemptId',p_admission->'attemptId','admissionDigest',p_admission->'digest','intentDigest',p_admission->'intentDigest',
    'observation','provider_confirmed','source',p_source);
  receipt:=receipt||jsonb_build_object('digest',public.runvara_content_receipt_hash(receipt));
  if octet_length(receipt::text)>36864 then raise exception using errcode='P0R01',message='CONTENT_RECEIPT_TOO_LARGE'; end if;
  return receipt;
end $$;

create function public.runvara_content_commit_ack(p_kind text,p_admission public.runvara_content_admissions,
  p_fingerprint text,p_expected text,p_next text,p_receipt_digest text,p_replayed boolean)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('schema','runvara-content-execution-commit-ack/v1','kind',p_kind,'workspaceId',p_admission.workspace_id,
    'attemptId',p_admission.attempt_id,'admissionDigest',p_admission.admission->'digest','intentDigest',p_admission.admission->'intentDigest',
    'requestFingerprint',p_fingerprint,'expectedRevision',p_expected,'nextRevision',p_next,'receiptDigest',p_receipt_digest,
    'reservedBytes',40960,'replayed',p_replayed);
$$;

-- Defense in depth if an old schema's blanket grant is reapplied. This trigger
-- deliberately runs as INVOKER: only the table owner reached through reviewed
-- definer RPCs can insert evidence or increment counters. App roles cannot SET
-- ROLE to the migration owner. No caller-set GUC grants a bypass.
create function public.runvara_content_guard_ledger()
returns trigger language plpgsql security invoker set search_path='' as $$
declare owner_oid oid;
begin
  if tg_op='TRUNCATE' or tg_op='DELETE' or (tg_table_name in ('runvara_content_admissions','runvara_content_receipts') and tg_op='UPDATE') then
    raise exception using errcode='P0R06',message='CONTENT_RECEIPT_IMMUTABLE';
  end if;
  select relowner into owner_oid from pg_catalog.pg_class where oid=tg_relid;
  if current_user::regrole::oid<>owner_oid then raise exception using errcode='P0R06',message='CONTENT_RECEIPT_RPC_REQUIRED'; end if;
  if tg_op='UPDATE' then
    if tg_table_name='runvara_content_receipt_control' then
      if old.mode<>'prepared' and new.mode='prepared' then
        raise exception using errcode='P0R06',message='CONTENT_RECEIPT_GUARD_CANNOT_ROLL_BACK'; end if;
    elsif tg_table_name='runvara_content_receipt_quotas' then
      if new.scope_key is distinct from old.scope_key or new.workspace_id is distinct from old.workspace_id
        or (new.quota->>'attempts')::integer<>(old.quota->>'attempts')::integer+1 then
        raise exception using errcode='P0R06',message='CONTENT_RECEIPT_QUOTA_IMMUTABLE'; end if;
    end if;
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['runvara_content_receipt_control','runvara_content_receipt_quotas','runvara_content_admissions','runvara_content_receipts'] loop
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.runvara_content_guard_ledger()',t||'_guard',t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.runvara_content_guard_ledger()',t||'_no_truncate',t);
  end loop;
end $$;

create function public.runvara_content_guard_workspace()
returns trigger language plpgsql security definer set search_path='' as $$
declare mode_value text; a public.runvara_content_admissions; r public.runvara_content_receipts;
  previous_writes jsonb; next_writes jsonb; previous_index jsonb; next_index jsonb;
  w jsonb; previous_write jsonb; matches integer; has_admissions boolean;
begin
  -- Always lock the singleton, including prepared mode. A statement which
  -- waited through activation must observe the new latch or fail serialization.
  select mode into mode_value from public.runvara_content_receipt_control where id for share;
  if not found then raise exception using errcode='P0R07',message='CONTENT_RECEIPT_CONTROL_UNAVAILABLE'; end if;
  if tg_op='TRUNCATE' then
    if mode_value<>'prepared' or exists(select 1 from public.runvara_content_admissions) then
      raise exception using errcode='P0R06',message='CONTENT_RECEIPT_WORKSPACE_RETAINED'; end if;
    return null;
  end if;
  if tg_op='DELETE' then
    if exists(select 1 from public.runvara_content_admissions where workspace_id=old.workspace_id)
      or (mode_value<>'prepared' and jsonb_typeof(old.state->'connectionWrites')='array' and exists(
        select 1 from jsonb_array_elements(old.state->'connectionWrites') x where x->>'provider'='shopify'
          and x#>>'{input,operation}'='product_content' and x#>'{dispatchClaim,phases,shopify_mutation}' is not null)) then
      raise exception using errcode='P0R06',message='CONTENT_RECEIPT_WORKSPACE_RETAINED'; end if;
    return old;
  end if;
  if tg_op='UPDATE' and new.workspace_id is distinct from old.workspace_id then
    raise exception using errcode='P0R06',message='CONTENT_RECEIPT_WORKSPACE_IDENTITY'; end if;
  has_admissions:=exists(select 1 from public.runvara_content_admissions where workspace_id=new.workspace_id);
  if mode_value='prepared' and not has_admissions then return new; end if;
  previous_writes:=case when tg_op='UPDATE' and jsonb_typeof(old.state->'connectionWrites')='array' then old.state->'connectionWrites' else '[]'::jsonb end;
  next_writes:=case when jsonb_typeof(new.state->'connectionWrites')='array' then new.state->'connectionWrites' else '[]'::jsonb end;
  if not has_admissions and not exists(select 1 from jsonb_array_elements(previous_writes) x where x->>'provider'='shopify'
      and x#>>'{input,operation}'='product_content' and x#>'{dispatchClaim,phases,shopify_mutation}' is not null)
    and not exists(select 1 from jsonb_array_elements(next_writes) x where x->>'provider'='shopify'
      and x#>>'{input,operation}'='product_content' and (x#>'{dispatchClaim,phases,shopify_mutation}' is not null or x->>'status'='completed')) then
    return new;
  end if;
  next_index:=public.runvara_content_write_index(next_writes);
  -- Existing protected records stay guarded even if an administrator pauses
  -- dispatch. Only unrelated state and explicitly mutable diagnostics may vary.
  for a in select * from public.runvara_content_admissions where workspace_id=new.workspace_id loop
    matches:=coalesce((next_index->a.write_id->>0)::integer,0);
    if matches<>1 then raise exception using errcode='P0R06',message='CONTENT_RECEIPT_CLAIM_RETAINED'; end if;
    w:=next_writes->((next_index->a.write_id->>1)::integer);
    if public.runvara_outcome_hash(public.runvara_content_write_identity(w)) is distinct from a.write_identity_digest then
      raise exception using errcode='P0R06',message='CONTENT_RECEIPT_CLAIM_RETAINED'; end if;
    select * into r from public.runvara_content_receipts where workspace_id=a.workspace_id and attempt_id=a.attempt_id;
    if found then
      if public.runvara_outcome_hash(public.runvara_content_final_projection(w)) is distinct from r.final_projection_digest then
        raise exception using errcode='P0R06',message='CONTENT_RECEIPT_RESULT_RETAINED'; end if;
    elsif w->>'status'='completed' then
      raise exception using errcode='P0R06',message='CONTENT_RECEIPT_FINALIZE_REQUIRED';
    end if;
  end loop;
  if mode_value='prepared' then return new; end if;
  previous_index:=public.runvara_content_write_index(previous_writes);
  -- Preserve legacy phases without treating them as protected receipts. Removing
  -- a phase then adding it again must never reset an older executor's replay gate.
  for previous_write in select x from jsonb_array_elements(previous_writes) x where x->>'provider'='shopify'
      and x#>>'{input,operation}'='product_content' and x#>'{dispatchClaim,phases,shopify_mutation}' is not null loop
    matches:=coalesce((next_index->(previous_write->>'id')->>0)::integer,0);
    if matches<>1 then raise exception using errcode='P0R06',message='CONTENT_RECEIPT_CLAIM_RETAINED'; end if;
    w:=next_writes->((next_index->(previous_write->>'id')->>1)::integer);
    if public.runvara_content_write_identity(w) is distinct from public.runvara_content_write_identity(previous_write) then
      raise exception using errcode='P0R06',message='CONTENT_RECEIPT_CLAIM_RETAINED'; end if;
  end loop;
  for w in select x from jsonb_array_elements(next_writes) x where x->>'provider'='shopify' and x#>>'{input,operation}'='product_content'
      and (x#>'{dispatchClaim,phases,shopify_mutation}' is not null or x->>'status'='completed') loop
    if exists(select 1 from public.runvara_content_admissions x where x.workspace_id=new.workspace_id and x.write_id=w->>'id') then continue; end if;
    matches:=coalesce((previous_index->(w->>'id')->>0)::integer,0);
    if matches<>1 then raise exception using errcode='P0R06',message='CONTENT_RECEIPT_RESERVATION_REQUIRED'; end if;
    previous_write:=previous_writes->((previous_index->(w->>'id')->>1)::integer);
    if public.runvara_content_write_identity(previous_write) is distinct from public.runvara_content_write_identity(w)
      or (previous_write#>'{dispatchClaim,phases,shopify_mutation}' is null and previous_write->>'status' is distinct from 'completed') then
      raise exception using errcode='P0R06',message='CONTENT_RECEIPT_RESERVATION_REQUIRED'; end if;
  end loop;
  return new;
end $$;
create trigger runvara_content_workspace_guard before insert or update or delete on public.saas_workspace_state
  for each row execute function public.runvara_content_guard_workspace();
create trigger runvara_content_workspace_no_truncate before truncate on public.saas_workspace_state
  for each statement execute function public.runvara_content_guard_workspace();

create function public.runvara_reserve_content_receipt(p_request_json text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare request jsonb; workspace text; admission_value jsonb; candidate jsonb; prior jsonb; w jsonb; old_write jsonb; old_index integer; actor jsonb;
  record public.runvara_content_admissions; fingerprint text; mode_value text; global_count integer; tenant_count integer;
begin
  request:=public.runvara_content_request(p_request_json,'reserve'); workspace:=request->>'workspaceId'; admission_value:=request->'admission'; candidate:=request->'state';
  perform public.runvara_content_validate_admission(admission_value,workspace);
  fingerprint:=encode(sha256(convert_to(p_request_json,'UTF8')),'hex');
  select state into prior from public.saas_workspace_state where workspace_id=workspace for update;
  if not found then raise exception using errcode='P0R03',message='CONTENT_RECEIPT_WORKSPACE_NOT_FOUND'; end if;
  select * into record from public.runvara_content_admissions where workspace_id=workspace and attempt_id=admission_value->>'attemptId';
  if found then
    if record.request_fingerprint<>fingerprint or record.admission<>admission_value or record.expected_revision<>request->>'expectedRevision'
      or record.commit_revision<>request->>'nextRevision' then raise exception using errcode='P0R04',message='CONTENT_RECEIPT_IDENTITY_CONFLICT'; end if;
    return public.runvara_content_commit_ack('reserve',record,fingerprint,record.expected_revision,record.commit_revision,null,true);
  end if;
  select mode into mode_value from public.runvara_content_receipt_control where id for share;
  if mode_value is distinct from 'enforced' then raise exception using errcode='P0R07',message='CONTENT_RECEIPT_NOT_ACTIVE'; end if;
  if prior->>'_revision' is distinct from request->>'expectedRevision' then raise exception using errcode='P0R02',message='CONTENT_RECEIPT_WORKSPACE_CONFLICT'; end if;
  if prior#>>'{workspace,id}' is distinct from workspace or jsonb_typeof(prior->'users') is distinct from 'array'
    or (select count(*) from jsonb_array_elements(prior->'users') x where x->>'id'=admission_value->>'actorId')<>1 then
    raise exception using errcode='P0R03',message='CONTENT_RECEIPT_ACTOR_REQUIRED'; end if;
  perform public.runvara_outcome_scope(prior,workspace);
  perform public.runvara_outcome_scope(prior->'workspace',workspace);
  select x into actor from jsonb_array_elements(prior->'users') x where x->>'id'=admission_value->>'actorId';
  perform public.runvara_outcome_action_scope(actor,workspace);
  if (actor->>'role'='owner' and (not(actor ? 'active') or actor->'active'='true'::jsonb)
    and (not(actor ? 'passwordChangeRequired') or actor->'passwordChangeRequired'='false'::jsonb)
    and coalesce(actor->'sessionVersion','1'::jsonb)=admission_value->'actorSessionVersion') is not true then
    raise exception using errcode='P0R03',message='CONTENT_RECEIPT_ACTOR_REQUIRED'; end if;
  if jsonb_typeof(prior->'connectionWrites') is distinct from 'array'
    or (select count(*) from jsonb_array_elements(prior->'connectionWrites') x where x->>'id'=admission_value->>'writeId')<>1 then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_CLAIM_INVALID'; end if;
  select value,(ordinality-1)::integer into old_write,old_index from jsonb_array_elements(prior->'connectionWrites') with ordinality
    where value->>'id'=admission_value->>'writeId';
  if old_write#>'{dispatchClaim,phases,shopify_mutation}' is not null then raise exception using errcode='P0R04',message='CONTENT_RECEIPT_ALREADY_ATTEMPTED'; end if;
  perform public.runvara_content_validate_source(candidate,admission_value,request->'sourceTemplate',true);
  -- Same complete receipt shape is bounded before provider submission. Only its
  -- fixed-length ISO millisecond timestamp and 64-byte digest can change later.
  perform public.runvara_content_make_receipt(admission_value,request->'sourceTemplate');
  select x into w from jsonb_array_elements(candidate->'connectionWrites') x where x->>'id'=admission_value->>'writeId';
  -- Also preflight the private final-projection digest's canonical envelope.
  -- The real completion has the same fixed result identity and timestamp width;
  -- false is the larger permitted dispatchBlocked representation (versus null).
  perform public.runvara_outcome_hash(public.runvara_content_final_projection(w||jsonb_build_object(
    'status','completed','completedAt',admission_value->'admittedAt','result',jsonb_build_object('externalId',w#>'{input,productId}'),
    'errorCode',null,'observationErrorCode',null,'dispatchBlocked',false)));
  if public.runvara_content_write_identity(old_write) is distinct from public.runvara_content_write_identity(
      jsonb_set(w,'{dispatchClaim,phases}',coalesce(old_write#>'{dispatchClaim,phases}','{}'::jsonb))) then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_CLAIM_INVALID'; end if;
  -- The candidate cannot manufacture an approval/connection transition while
  -- reserving. Validate the same source against the locked original authority
  -- state, projecting only the already-compared write's new phase for validation.
  perform public.runvara_content_validate_source(jsonb_set(prior,array['connectionWrites',old_index::text],w),
    admission_value,request->'sourceTemplate',true);
  if exists(select 1 from public.runvara_content_admissions where workspace_id=workspace and write_id=admission_value->>'writeId') then
    raise exception using errcode='P0R04',message='CONTENT_RECEIPT_ALREADY_ATTEMPTED'; end if;
  select (quota->>'attempts')::integer into global_count from public.runvara_content_receipt_quotas where scope_key='global' for update;
  if not found then raise exception using errcode='P0R07',message='CONTENT_RECEIPT_QUOTA_UNAVAILABLE'; end if;
  select (quota->>'attempts')::integer into tenant_count from public.runvara_content_receipt_quotas where scope_key='tenant:'||workspace for update;
  tenant_count:=coalesce(tenant_count,0);
  if global_count>=1024 or tenant_count>=256 then raise exception using errcode='P0R05',message='CONTENT_RECEIPT_CAPACITY_EXHAUSTED'; end if;
  insert into public.runvara_content_admissions(workspace_id,attempt_id,write_id,admission,request_fingerprint,expected_revision,commit_revision,write_identity_digest)
    values(workspace,admission_value->>'attemptId',admission_value->>'writeId',admission_value,fingerprint,request->>'expectedRevision',request->>'nextRevision',public.runvara_outcome_hash(public.runvara_content_write_identity(w))) returning * into record;
  update public.runvara_content_receipt_quotas set quota=jsonb_build_object('schema','runvara-content-receipt-quota/v1',
    'attempts',global_count+1,'reservedBytes',(global_count+1)*40960) where scope_key='global';
  if tenant_count=0 then
    insert into public.runvara_content_receipt_quotas(scope_key,workspace_id,quota) values('tenant:'||workspace,workspace,
      jsonb_build_object('schema','runvara-content-receipt-quota/v1','attempts',1,'reservedBytes',40960));
  else
    update public.runvara_content_receipt_quotas set quota=jsonb_build_object('schema','runvara-content-receipt-quota/v1',
      'attempts',tenant_count+1,'reservedBytes',(tenant_count+1)*40960) where scope_key='tenant:'||workspace;
  end if;
  update public.saas_workspace_state set state=candidate,updated_at=clock_timestamp()
    where workspace_id=workspace and state->>'_revision'=request->>'expectedRevision';
  if not found then raise exception using errcode='P0R02',message='CONTENT_RECEIPT_WORKSPACE_CONFLICT'; end if;
  return public.runvara_content_commit_ack('reserve',record,fingerprint,record.expected_revision,record.commit_revision,null,false);
end $$;

create function public.runvara_finalize_content_receipt(p_request_json text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare request jsonb; workspace text; admission_value jsonb; candidate jsonb; prior jsonb; w jsonb; receipt jsonb;
  a public.runvara_content_admissions; r public.runvara_content_receipts; fingerprint text;
begin
  request:=public.runvara_content_request(p_request_json,'finalize'); workspace:=request->>'workspaceId'; admission_value:=request->'admission'; candidate:=request->'state'; receipt:=request->'receipt';
  perform public.runvara_content_validate_admission(admission_value,workspace);
  fingerprint:=encode(sha256(convert_to(p_request_json,'UTF8')),'hex');
  select state into prior from public.saas_workspace_state where workspace_id=workspace for update;
  if not found then raise exception using errcode='P0R03',message='CONTENT_RECEIPT_WORKSPACE_NOT_FOUND'; end if;
  select * into a from public.runvara_content_admissions where workspace_id=workspace and attempt_id=admission_value->>'attemptId';
  if not found or a.admission is distinct from admission_value then raise exception using errcode='P0R04',message='CONTENT_RECEIPT_ADMISSION_CONFLICT'; end if;
  select * into r from public.runvara_content_receipts where workspace_id=workspace and attempt_id=a.attempt_id;
  if found then
    if r.request_fingerprint<>fingerprint or r.receipt is distinct from receipt or r.expected_revision<>request->>'expectedRevision'
      or r.commit_revision<>request->>'nextRevision' then raise exception using errcode='P0R04',message='CONTENT_RECEIPT_IDENTITY_CONFLICT'; end if;
    return public.runvara_content_commit_ack('finalize',a,fingerprint,r.expected_revision,r.commit_revision,r.receipt->>'digest',true);
  end if;
  if prior->>'_revision' is distinct from request->>'expectedRevision' then raise exception using errcode='P0R02',message='CONTENT_RECEIPT_WORKSPACE_CONFLICT'; end if;
  perform public.runvara_content_validate_source(candidate,admission_value,receipt->'source',false);
  if receipt is distinct from public.runvara_content_make_receipt(admission_value,receipt->'source') then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_INVALID'; end if;
  select x into w from jsonb_array_elements(candidate->'connectionWrites') x where x->>'id'=a.write_id;
  if public.runvara_outcome_hash(public.runvara_content_write_identity(w)) is distinct from a.write_identity_digest then raise exception using errcode='P0R04',message='CONTENT_RECEIPT_ADMISSION_CONFLICT'; end if;
  insert into public.runvara_content_receipts(workspace_id,attempt_id,receipt,request_fingerprint,expected_revision,commit_revision,final_projection_digest)
    values(workspace,a.attempt_id,receipt,fingerprint,request->>'expectedRevision',request->>'nextRevision',public.runvara_outcome_hash(public.runvara_content_final_projection(w)));
  update public.saas_workspace_state set state=candidate,updated_at=clock_timestamp()
    where workspace_id=workspace and state->>'_revision'=request->>'expectedRevision';
  if not found then raise exception using errcode='P0R02',message='CONTENT_RECEIPT_WORKSPACE_CONFLICT'; end if;
  return public.runvara_content_commit_ack('finalize',a,fingerprint,request->>'expectedRevision',request->>'nextRevision',receipt->>'digest',false);
end $$;

create function public.runvara_read_content_receipt(p_workspace_id text,p_attempt_id text,p_kind text,
  p_request_fingerprint text,p_actor_id text,p_actor_session_version bigint)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare a public.runvara_content_admissions; r public.runvara_content_receipts;
begin
  if (char_length(p_workspace_id) between 1 and 256 and p_workspace_id=btrim(p_workspace_id) and p_workspace_id !~ '[[:cntrl:]]'
      and p_attempt_id ~ '^content_attempt_[0-9a-f]{64}$' and p_kind in ('reserve','finalize')
      and p_request_fingerprint ~ '^[0-9a-f]{64}$' and p_actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and p_actor_session_version between 1 and 9007199254740991) is not true then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_INPUT_INVALID'; end if;
  select * into a from public.runvara_content_admissions where workspace_id=p_workspace_id and attempt_id=p_attempt_id;
  if not found then return null; end if;
  if a.admission->>'actorId'<>p_actor_id or (a.admission->>'actorSessionVersion')::bigint<>p_actor_session_version then
    raise exception using errcode='P0R03',message='CONTENT_RECEIPT_ACTOR_REQUIRED'; end if;
  if p_kind='reserve' then
    if a.request_fingerprint<>p_request_fingerprint then raise exception using errcode='P0R04',message='CONTENT_RECEIPT_IDENTITY_CONFLICT'; end if;
    return public.runvara_content_commit_ack(p_kind,a,a.request_fingerprint,a.expected_revision,a.commit_revision,null,true);
  end if;
  select * into r from public.runvara_content_receipts where workspace_id=p_workspace_id and attempt_id=p_attempt_id;
  if not found then return null; end if;
  if r.request_fingerprint<>p_request_fingerprint then raise exception using errcode='P0R04',message='CONTENT_RECEIPT_IDENTITY_CONFLICT'; end if;
  return public.runvara_content_commit_ack(p_kind,a,r.request_fingerprint,r.expected_revision,r.commit_revision,r.receipt->>'digest',true);
end $$;

revoke all on function public.runvara_content_receipt_hash(jsonb),public.runvara_content_write_identity(jsonb),
  public.runvara_content_final_projection(jsonb),public.runvara_content_request(text,text),public.runvara_content_validate_admission(jsonb,text),
  public.runvara_content_source_intent(jsonb),public.runvara_content_validate_source(jsonb,jsonb,jsonb,boolean),public.runvara_content_make_receipt(jsonb,jsonb),
  public.runvara_content_write_index(jsonb),
  public.runvara_content_commit_ack(text,public.runvara_content_admissions,text,text,text,text,boolean),
  public.runvara_content_guard_ledger(),public.runvara_content_guard_workspace(),public.runvara_reserve_content_receipt(text),
  public.runvara_finalize_content_receipt(text),public.runvara_read_content_receipt(text,text,text,text,text,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.runvara_reserve_content_receipt(text),public.runvara_finalize_content_receipt(text),
  public.runvara_read_content_receipt(text,text,text,text,text,bigint) to service_role;

comment on table public.runvara_content_receipt_control is 'Prepared inactive. Administrator-only prospective enforcement latch; activate under a workspace-table lock after separately approved rollout. Never disable protection to roll back an executor.';
comment on table public.runvara_content_admissions is 'Immutable charged Shopify content attempt; 40 KiB logical document reservation, no expiry or slot reuse. Source template and credentials are never retained here.';
comment on table public.runvara_content_receipts is 'Immutable application-observed Shopify content success, atomically committed with workspace CAS. Not provider-signed, causal or financial evidence.';
comment on function public.runvara_read_content_receipt(text,text,text,text,text,bigint) is 'Private exact transaction acknowledgement only; original admitted actor/session binds in-flight reconciliation. Missing data never authorizes replay.';
commit;
