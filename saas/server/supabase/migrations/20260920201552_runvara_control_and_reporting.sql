-- Reporting keys identify source variants. A merchant SKU is not unique.
-- Preserve all existing rows, primary keys, tenant FKs and RLS settings.
begin;
set local lock_timeout = '5s';
alter table public.variants drop constraint if exists variants_workspace_id_sku_key;
create index if not exists variants_workspace_sku_idx on public.variants (workspace_id, sku);
create index if not exists variants_workspace_source_idx on public.variants (workspace_id, product_id, external_id);

-- New workspace creation is one transaction: no orphan parent, duplicate email,
-- or login identity without authoritative business state after a partial outage.
create or replace function public.runvara_create_workspace(p_state jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  workspace_key text := p_state #>> '{workspace,id}';
  account jsonb;
begin
  if workspace_key is null or workspace_key = ''
    or jsonb_typeof(p_state->'users') is distinct from 'array'
    or jsonb_array_length(p_state->'users') = 0
    or p_state->>'_revision' is null then
    raise exception using errcode = '22023', message = 'Invalid workspace state';
  end if;
  insert into public.workspaces (id, name, slug, settings, created_at, updated_at)
  values (workspace_key, p_state #>> '{workspace,name}', p_state #>> '{workspace,slug}',
    '{}'::jsonb, (p_state #>> '{workspace,createdAt}')::timestamptz, now());
  for account in select value from jsonb_array_elements(p_state->'users') loop
    insert into public.users (id, workspace_id, email, role, password_hash,
      password_change_required, active, session_version, created_at, updated_at)
    values (account->>'id', workspace_key, lower(trim(account->>'email')), account->>'role',
      account->>'passwordHash', coalesce((account->>'passwordChangeRequired')::boolean, false),
      coalesce((account->>'active')::boolean, true), coalesce((account->>'sessionVersion')::integer, 1),
      (account->>'createdAt')::timestamptz, now());
  end loop;
  insert into public.saas_workspace_state (workspace_id, state, updated_at)
  values (workspace_key, p_state, now());
end;
$$;
revoke all on function public.runvara_create_workspace(jsonb) from public, anon, authenticated;
grant execute on function public.runvara_create_workspace(jsonb) to service_role;
comment on function public.runvara_create_workspace(jsonb) is 'Runvara server-only atomic workspace creation; caller privileges and existing RLS apply.';
commit;
