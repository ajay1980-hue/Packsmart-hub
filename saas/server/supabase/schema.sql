-- Packsmart Ops production schema
-- Apply in a dedicated Supabase project. Browser roles receive no table access;
-- the Node service uses the service-role credential only on the server.

begin;

create table if not exists public.workspaces (
  id text primary key,
  name text not null,
  slug text not null unique,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.users (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  password_hash text,
  password_change_required boolean not null default false,
  active boolean not null default true,
  session_version integer not null default 1 check (session_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists users_email_lower_unique on public.users (lower(email));
create index if not exists users_workspace_idx on public.users (workspace_id);

create table if not exists public.connections (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  provider text not null,
  label text not null,
  status text not null,
  encrypted_credentials text,
  capabilities jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider)
);
create index if not exists connections_workspace_idx on public.connections (workspace_id);

create table if not exists public.products (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  id text not null,
  provider text not null,
  external_id text not null,
  title text not null,
  handle text not null default '',
  status text not null default 'unknown',
  product_type text not null default '',
  description text not null default '',
  image_url text,
  inventory_total integer,
  raw jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, provider, external_id)
);
create index if not exists products_workspace_status_idx on public.products (workspace_id, status);

create table if not exists public.variants (
  workspace_id text not null,
  id text not null,
  product_id text not null,
  external_id text not null,
  sku text not null default '',
  title text not null,
  price numeric(14,4) not null default 0,
  inventory_quantity integer,
  available boolean not null default true,
  image_url text,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, product_id) references public.products(workspace_id, id) on delete cascade,
  unique (workspace_id, sku)
);
create index if not exists variants_workspace_inventory_idx on public.variants (workspace_id, inventory_quantity);

create table if not exists public.economics (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  sku text not null,
  variant_id text,
  landed_cost numeric(14,4),
  packing_cost numeric(14,4),
  delivery_cost numeric(14,4),
  channel_fee numeric(14,4),
  margin_floor numeric(7,3),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, sku),
  check (landed_cost is null or landed_cost >= 0),
  check (packing_cost is null or packing_cost >= 0),
  check (delivery_cost is null or delivery_cost >= 0),
  check (channel_fee is null or channel_fee >= 0)
);

create table if not exists public.automation_rules (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  rule_id text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, rule_id)
);

create table if not exists public.approval_requests (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  type text not null,
  proposed_action text not null,
  reason text not null,
  financial_impact numeric(14,2),
  expected_benefit text not null,
  risk text not null,
  requested_by text not null,
  source text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  decision_note text,
  executed_externally boolean not null default false,
  execution_status text not null default 'not_connected'
);
create index if not exists approval_workspace_status_idx on public.approval_requests (workspace_id, status, created_at desc);

create table if not exists public.audit_events (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  type text not null,
  actor text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_workspace_created_idx on public.audit_events (workspace_id, created_at desc);

create table if not exists public.subscriptions (
  workspace_id text primary key references public.workspaces(id) on delete cascade,
  plan text not null,
  status text not null,
  stripe_customer_id text,
  stripe_subscription_id text,
  usage jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  id text not null,
  provider text not null,
  external_id text not null,
  order_name text not null,
  financial_status text not null,
  fulfillment_status text not null,
  total numeric(14,2) not null default 0,
  currency text not null default 'GBP',
  ordered_at timestamptz not null,
  source_updated_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, provider, external_id)
);
create index if not exists orders_workspace_ordered_idx on public.orders (workspace_id, ordered_at desc);

create table if not exists public.operations_briefs (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  summary text not null,
  metrics jsonb not null default '{}'::jsonb,
  logic text not null default 'deterministic-v1',
  created_at timestamptz not null default now()
);
create index if not exists briefs_workspace_created_idx on public.operations_briefs (workspace_id, created_at desc);

-- Transitional atomic state document. It supports lossless customer-zero migration
-- while the normalized tables above are the beta reporting/onboarding foundation.
create table if not exists public.saas_workspace_state (
  workspace_id text primary key references public.workspaces(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.workspaces enable row level security;
alter table public.users enable row level security;
alter table public.connections enable row level security;
alter table public.products enable row level security;
alter table public.variants enable row level security;
alter table public.economics enable row level security;
alter table public.automation_rules enable row level security;
alter table public.approval_requests enable row level security;
alter table public.audit_events enable row level security;
alter table public.subscriptions enable row level security;
alter table public.orders enable row level security;
alter table public.operations_briefs enable row level security;
alter table public.saas_workspace_state enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;

-- Supabase's optional automatic-RLS project setting creates this helper in the
-- public schema. Keep the event trigger, but prevent browser roles from calling
-- its SECURITY DEFINER function directly.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end
$$;

comment on table public.saas_workspace_state is
  'Server-only lossless workspace state used during Packsmart customer-zero and normalized-table migration.';
comment on table public.audit_events is
  'Server-only workspace audit trail. Application routes never expose cross-workspace rows.';

commit;
