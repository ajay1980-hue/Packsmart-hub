-- Runvara / Packsmart Ops business-hub normalized persistence expansion.
-- The lossless workspace state remains authoritative during customer-zero;
-- these server-only mirrors make supplier, cost, order and ad data reportable.
begin;

create table if not exists public.suppliers (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);
create index if not exists suppliers_workspace_idx on public.suppliers (workspace_id, active);

create table if not exists public.product_cost_profiles (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  sku text not null,
  cost_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, sku)
);

create table if not exists public.cost_history (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  sku text not null,
  changed_by text not null,
  changed_fields jsonb not null default '[]'::jsonb,
  before_data jsonb not null default '{}'::jsonb,
  after_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists cost_history_workspace_sku_idx on public.cost_history (workspace_id, sku, created_at desc);

create table if not exists public.order_financials (
  workspace_id text not null,
  order_id text not null,
  provider text not null,
  financial_data jsonb not null default '{}'::jsonb,
  line_items jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, order_id),
  foreign key (workspace_id, order_id) references public.orders(workspace_id, id) on delete cascade
);

create table if not exists public.advertising_costs (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  channel text not null,
  spend numeric(14,2),
  attributable_revenue numeric(14,2),
  period_date timestamptz not null,
  source text not null default 'manual',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (spend is null or spend >= 0),
  check (attributable_revenue is null or attributable_revenue >= 0)
);
create index if not exists advertising_costs_workspace_date_idx on public.advertising_costs (workspace_id, period_date desc);

alter table public.suppliers enable row level security;
alter table public.product_cost_profiles enable row level security;
alter table public.cost_history enable row level security;
alter table public.order_financials enable row level security;
alter table public.advertising_costs enable row level security;

revoke all on public.suppliers, public.product_cost_profiles, public.cost_history,
  public.order_financials, public.advertising_costs from anon, authenticated;
grant select, insert, update, delete on public.suppliers, public.product_cost_profiles,
  public.cost_history, public.order_financials, public.advertising_costs to service_role;

commit;
