-- Explicit production approval is required before applying this new EXECUTE
-- grant. No new table privileges or RLS policies are introduced.
begin;

create function public.runvara_commit_reporting_status(
  p_workspace_id text,
  p_expected_revision text,
  p_next_revision text,
  p_report jsonb,
  p_updated_at timestamptz
)
returns table (workspace_id text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  failure jsonb;
  stamp text;
begin
  if p_workspace_id is null or length(p_workspace_id) not between 1 and 256
    or p_workspace_id <> btrim(p_workspace_id) or p_workspace_id ~ '[[:cntrl:]]'
    or p_expected_revision is null or p_expected_revision !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_next_revision is null or p_next_revision !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_expected_revision = p_next_revision or p_updated_at is null or not isfinite(p_updated_at)
    or jsonb_typeof(p_report) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'REPORTING_STATUS_INPUT_INVALID';
  end if;
  if octet_length(p_report::text) > 16384
    or not (p_report ?& array['status','detail','lastSyncAt','lastFailureAt','lastError','failures'])
    or (p_report - array['status','detail','lastSyncAt','lastFailureAt','lastError','failures']) <> '{}'::jsonb
    or jsonb_typeof(p_report->'status') is distinct from 'string'
    or p_report->>'status' not in ('connected','degraded')
    or jsonb_typeof(p_report->'detail') is distinct from 'string' or length(p_report->>'detail') > 320
    or jsonb_typeof(p_report->'failures') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'REPORTING_STATUS_INPUT_INVALID';
  end if;
  if jsonb_array_length(p_report->'failures') > 32
    or not (p_report->'lastError' = 'null'::jsonb or (jsonb_typeof(p_report->'lastError') = 'string' and p_report->>'lastError' ~ '^[A-Z0-9_]{1,80}$')) then
    raise exception using errcode = '22023', message = 'REPORTING_STATUS_INPUT_INVALID';
  end if;
  foreach stamp in array array['lastSyncAt','lastFailureAt'] loop
    if p_report->stamp <> 'null'::jsonb then
      if jsonb_typeof(p_report->stamp) is distinct from 'string'
        or p_report->>stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
        raise exception using errcode = '22023', message = 'REPORTING_STATUS_INPUT_INVALID';
      end if;
      begin
        if to_char((p_report->>stamp)::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p_report->>stamp then
          raise exception using errcode = '22023', message = 'REPORTING_STATUS_INPUT_INVALID';
        end if;
      exception when invalid_datetime_format or datetime_field_overflow then
        raise exception using errcode = '22023', message = 'REPORTING_STATUS_INPUT_INVALID';
      end;
    end if;
  end loop;
  for failure in select value from jsonb_array_elements(p_report->'failures') loop
    if jsonb_typeof(failure) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'REPORTING_STATUS_INPUT_INVALID';
    end if;
    if not (failure ?& array['table','code','httpStatus','databaseCode'])
      or (failure - array['table','code','httpStatus','databaseCode']) <> '{}'::jsonb
      or jsonb_typeof(failure->'table') is distinct from 'string' or failure->>'table' !~ '^[a-z_]{1,80}$'
      or jsonb_typeof(failure->'code') is distinct from 'string' or failure->>'code' !~ '^[A-Z0-9_]{1,80}$'
      or not (failure->'httpStatus' = 'null'::jsonb or (jsonb_typeof(failure->'httpStatus') = 'number' and failure->>'httpStatus' ~ '^[1-5][0-9]{2}$'))
      or not (failure->'databaseCode' = 'null'::jsonb or (jsonb_typeof(failure->'databaseCode') = 'string' and failure->>'databaseCode' ~ '^([0-9A-Z]{5}|PGRST[0-9]{1,5})$')) then
      raise exception using errcode = '22023', message = 'REPORTING_STATUS_INPUT_INVALID';
    end if;
  end loop;
  if (p_report->>'status' = 'connected' and (jsonb_array_length(p_report->'failures') <> 0 or p_report->'lastError' <> 'null'::jsonb))
    or (p_report->>'status' = 'degraded' and (jsonb_array_length(p_report->'failures') = 0
      or p_report->>'lastError' is distinct from coalesce(p_report#>>'{failures,0,databaseCode}',p_report#>>'{failures,0,code}'))) then
    raise exception using errcode = '22023', message = 'REPORTING_STATUS_INPUT_INVALID';
  end if;

  -- PostgreSQL rechecks the revision predicate after a competing row update.
  -- The caller cannot replace business state or alter a sibling integration.
  return query
    update public.saas_workspace_state as target
    set state = jsonb_set(jsonb_set(target.state, '{integrationStatus,reporting}', p_report, true),
                         '{_revision}', to_jsonb(p_next_revision), true),
        updated_at = p_updated_at
    where target.workspace_id = p_workspace_id
      and target.state#>>'{workspace,id}' = p_workspace_id
      and jsonb_typeof(target.state->'integrationStatus') = 'object'
      and target.state->>'_revision' = p_expected_revision
    returning target.workspace_id;
end;
$$;

revoke all on function public.runvara_commit_reporting_status(text,text,text,jsonb,timestamptz) from public, anon, authenticated;
grant execute on function public.runvara_commit_reporting_status(text,text,text,jsonb,timestamptz) to service_role;

comment on function public.runvara_commit_reporting_status(text,text,text,jsonb,timestamptz)
  is 'Server-only bounded reporting status CAS. Requires existing caller SELECT/UPDATE rights; never returns or replaces business state.';
commit;
