-- Disposable, empty PostgreSQL database ONLY. This fixture is not a migration.
-- The test runner refuses non-local hosts, any database with another name, and
-- nonempty public schemas before running this file. No Supabase resource is used.
-- These roles reproduce Supabase API grants, including service_role's BYPASSRLS.
create role anon nologin nosuperuser nobypassrls;
create role authenticated nologin nosuperuser nobypassrls;
create role service_role nologin nosuperuser bypassrls;
create role atomic_usage_untrusted nologin nosuperuser nobypassrls;
grant usage on schema public to anon, authenticated, service_role, atomic_usage_untrusted;

-- Compatible minimal foundation copied from schema.sql; the actual existing
-- agent-jobs and usage-ledger migrations are applied unchanged by the harness.
create table public.workspaces (
  id text primary key,
  name text not null,
  slug text not null unique,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.saas_workspace_state (
  workspace_id text primary key references public.workspaces(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.workspaces enable row level security;
alter table public.saas_workspace_state enable row level security;
revoke all on public.workspaces, public.saas_workspace_state from public, anon, authenticated;
grant select, insert, update, delete on public.workspaces, public.saas_workspace_state to service_role;
