-- Packsmart Ops Phase 2 cloud persistence
-- Run in a dedicated Supabase project before setting SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.

create table if not exists public.saas_workspace_state (
  workspace_id text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.saas_workspace_state enable row level security;

-- The current Node server uses the Supabase service-role key only on the server.
-- No browser/client policy is intentionally created here. Future end-user Supabase auth
-- should use normalized tenant tables and explicit workspace membership RLS policies.

comment on table public.saas_workspace_state is
  'Server-only Packsmart Ops workspace state. Service role access only during customer-zero Phase 2.';
