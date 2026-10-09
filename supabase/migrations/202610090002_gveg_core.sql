-- Esquema PostgreSQL da aplicação GVEG. Aditivo e idempotente; aplicar manualmente.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.gveg_migration_imports') IS NULL AND EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(ARRAY[
      'users','sessions','suppliers','products','materials','inventory_movements','audit_logs','customers',
      'sales','sale_items','sale_payments','expenses','expense_payments','product_materials','product_stock',
      'product_price_history','production_orders','production_consumptions','purchases','purchase_items',
      'purchase_payments','material_cost_history','system_settings','role_permissions'
    ]) AND c.relkind IN ('r','p')
  ) THEN
    RAISE EXCEPTION 'A migration GVEG foi interrompida: já existem tabelas com nomes reservados em public. Revise o esquema antes de aplicar.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.users (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  password_hash text NOT NULL, password_salt text NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','manager')),
  active integer NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.sessions (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON public.sessions(expires_at);

CREATE TABLE IF NOT EXISTS public.suppliers (
  id text PRIMARY KEY, name text NOT NULL, document text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', active integer NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.products (
  id text PRIMARY KEY, name text NOT NULL, sku text NOT NULL UNIQUE, description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '', color text NOT NULL DEFAULT '', size text NOT NULL DEFAULT '',
  price_cents integer NOT NULL DEFAULT 0 CHECK(price_cents>=0), active integer NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.materials (
  id text PRIMARY KEY, name text NOT NULL, code text NOT NULL DEFAULT '', unit text NOT NULL,
  quantity double precision NOT NULL DEFAULT 0 CHECK(quantity>=0), minimum_quantity double precision NOT NULL DEFAULT 0 CHECK(minimum_quantity>=0),
  unit_cost_cents integer NOT NULL DEFAULT 0 CHECK(unit_cost_cents>=0), supplier_id text REFERENCES public.suppliers(id),
  last_purchase_date text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', active integer NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS materials_code_unique ON public.materials(code) WHERE code<>'';
CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id text PRIMARY KEY, material_id text NOT NULL REFERENCES public.materials(id), user_id text NOT NULL REFERENCES public.users(id),
  kind text NOT NULL CHECK(kind IN ('opening','purchase','production','adjustment','loss','return')),
  quantity_delta double precision NOT NULL CHECK(quantity_delta<>0), reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movements_material_idx ON public.inventory_movements(material_id,created_at);
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES public.users(id), action text NOT NULL,
  entity text NOT NULL, entity_id text NOT NULL, details text NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON public.audit_logs(entity,entity_id,created_at);

CREATE TABLE IF NOT EXISTS public.customers (
  id text PRIMARY KEY, name text NOT NULL, document text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
  active integer NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_document_unique ON public.customers(document) WHERE document<>'';

CREATE TABLE IF NOT EXISTS public.sales (
  id text PRIMARY KEY, number text NOT NULL UNIQUE, request_key text NOT NULL UNIQUE,
  customer_id text REFERENCES public.customers(id), sale_date text NOT NULL, due_date text NOT NULL DEFAULT '',
  subtotal_cents integer NOT NULL, discount_cents integer NOT NULL DEFAULT 0, total_cents integer NOT NULL,
  historical integer NOT NULL DEFAULT 0 CHECK(historical IN (0,1)), historical_received_cents integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','cancelled')),
  notes text NOT NULL DEFAULT '', created_by text NOT NULL REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.sale_items (
  id text PRIMARY KEY, sale_id text NOT NULL REFERENCES public.sales(id), product_id text REFERENCES public.products(id),
  product_name text NOT NULL, sku text NOT NULL DEFAULT '', color text NOT NULL DEFAULT '',
  quantity double precision NOT NULL CHECK(quantity>0), unit_price_cents integer NOT NULL CHECK(unit_price_cents>=0),
  unit_cost_cents integer CHECK(unit_cost_cents>=0), line_total_cents integer NOT NULL CHECK(line_total_cents>=0)
);
CREATE TABLE IF NOT EXISTS public.sale_payments (
  id text PRIMARY KEY, request_key text NOT NULL UNIQUE, sale_id text NOT NULL REFERENCES public.sales(id),
  amount_cents integer NOT NULL CHECK(amount_cents>0), paid_at text NOT NULL, method text NOT NULL,
  note text NOT NULL DEFAULT '', user_id text NOT NULL REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.expenses (
  id text PRIMARY KEY, description text NOT NULL, category text NOT NULL, amount_cents integer NOT NULL CHECK(amount_cents>0),
  expense_date text NOT NULL, due_date text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','cancelled')),
  created_by text NOT NULL REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.expense_payments (
  id text PRIMARY KEY, request_key text NOT NULL UNIQUE, expense_id text NOT NULL REFERENCES public.expenses(id),
  amount_cents integer NOT NULL CHECK(amount_cents>0), paid_at text NOT NULL, method text NOT NULL,
  note text NOT NULL DEFAULT '', user_id text NOT NULL REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_date_idx ON public.sales(sale_date,status);
CREATE INDEX IF NOT EXISTS sale_payments_date_idx ON public.sale_payments(paid_at);
CREATE INDEX IF NOT EXISTS expense_date_idx ON public.expenses(expense_date,status);
CREATE INDEX IF NOT EXISTS expense_payments_date_idx ON public.expense_payments(paid_at);

CREATE TABLE IF NOT EXISTS public.product_materials (
  product_id text NOT NULL REFERENCES public.products(id), material_id text NOT NULL REFERENCES public.materials(id),
  quantity_per_unit double precision NOT NULL CHECK(quantity_per_unit>0), PRIMARY KEY(product_id,material_id)
);
CREATE TABLE IF NOT EXISTS public.product_stock (
  product_id text PRIMARY KEY REFERENCES public.products(id), quantity double precision NOT NULL DEFAULT 0 CHECK(quantity>=0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.product_price_history (
  id text PRIMARY KEY, product_id text NOT NULL REFERENCES public.products(id), user_id text NOT NULL REFERENCES public.users(id),
  previous_price_cents integer, new_price_cents integer NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.production_orders (
  id text PRIMARY KEY, number text NOT NULL UNIQUE, request_key text NOT NULL UNIQUE, product_id text NOT NULL REFERENCES public.products(id),
  planned_quantity double precision NOT NULL CHECK(planned_quantity>0), produced_quantity double precision NOT NULL DEFAULT 0,
  approved_quantity double precision NOT NULL DEFAULT 0, defective_quantity double precision NOT NULL DEFAULT 0,
  status text NOT NULL CHECK(status IN ('planned','in_progress','completed','cancelled')),
  start_date text NOT NULL, due_date text NOT NULL DEFAULT '', completed_at text NOT NULL DEFAULT '',
  labor_cost_cents integer NOT NULL DEFAULT 0, additional_cost_cents integer NOT NULL DEFAULT 0,
  material_cost_cents integer NOT NULL DEFAULT 0, unit_cost_cents integer,
  responsible text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', user_id text NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.production_consumptions (
  id text PRIMARY KEY, order_id text NOT NULL REFERENCES public.production_orders(id), material_id text NOT NULL REFERENCES public.materials(id),
  quantity double precision NOT NULL CHECK(quantity>0), unit_cost_cents integer NOT NULL CHECK(unit_cost_cents>=0), total_cost_cents integer NOT NULL
);
CREATE TABLE IF NOT EXISTS public.purchases (
  id text PRIMARY KEY, number text NOT NULL UNIQUE, request_key text NOT NULL UNIQUE, supplier_id text NOT NULL REFERENCES public.suppliers(id),
  purchase_date text NOT NULL, due_date text NOT NULL DEFAULT '', freight_cents integer NOT NULL DEFAULT 0,
  discount_cents integer NOT NULL DEFAULT 0, total_cents integer NOT NULL CHECK(total_cents>0),
  status text NOT NULL CHECK(status IN ('open','paid','cancelled')), notes text NOT NULL DEFAULT '',
  user_id text NOT NULL REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.purchase_items (
  id text PRIMARY KEY, purchase_id text NOT NULL REFERENCES public.purchases(id), material_id text NOT NULL REFERENCES public.materials(id),
  quantity double precision NOT NULL CHECK(quantity>0), unit_cost_cents integer NOT NULL CHECK(unit_cost_cents>=0), total_cost_cents integer NOT NULL,
  previous_unit_cost_cents integer NOT NULL, previous_supplier_id text, previous_purchase_date text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.purchase_payments (
  id text PRIMARY KEY, request_key text NOT NULL UNIQUE, purchase_id text NOT NULL REFERENCES public.purchases(id),
  amount_cents integer NOT NULL CHECK(amount_cents>0), paid_at text NOT NULL, method text NOT NULL, user_id text NOT NULL REFERENCES public.users(id)
);
CREATE TABLE IF NOT EXISTS public.material_cost_history (
  id text PRIMARY KEY, material_id text NOT NULL REFERENCES public.materials(id), supplier_id text NOT NULL REFERENCES public.suppliers(id),
  purchase_id text NOT NULL REFERENCES public.purchases(id), unit_cost_cents integer NOT NULL, purchase_date text NOT NULL
);
CREATE INDEX IF NOT EXISTS production_status_idx ON public.production_orders(status,start_date);
CREATE INDEX IF NOT EXISTS purchases_date_idx ON public.purchases(purchase_date,status);
CREATE TABLE IF NOT EXISTS public.system_settings (key text PRIMARY KEY, value text NOT NULL);
INSERT INTO public.system_settings(key,value) VALUES('labor_cost_per_bag_cents','1900'),('weekly_seamstress_cost_cents','55000') ON CONFLICT(key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role text NOT NULL CHECK(role='manager'), module text NOT NULL, allowed integer NOT NULL DEFAULT 1 CHECK(allowed IN (0,1)),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(role,module)
);
INSERT INTO public.role_permissions(role,module,allowed) VALUES
 ('manager','products',1),('manager','materials',1),('manager','production',1),('manager','purchases',1),
 ('manager','suppliers',1),('manager','sales',1),('manager','customers',1),('manager','finance',1),
 ('manager','reports',1),('manager','receipts',1) ON CONFLICT(role,module) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.gveg_migration_imports (
  migration_id text PRIMARY KEY,
  source_sha256 text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  table_counts jsonb NOT NULL
);

-- Business tables are accessed by the trusted Node server through DATABASE_URL only.
REVOKE ALL ON public.users, public.sessions, public.suppliers, public.products, public.materials,
  public.inventory_movements, public.audit_logs, public.customers, public.sales, public.sale_items,
  public.sale_payments, public.expenses, public.expense_payments, public.product_materials,
  public.product_stock, public.product_price_history, public.production_orders,
  public.production_consumptions, public.purchases, public.purchase_items, public.purchase_payments,
  public.material_cost_history, public.system_settings, public.role_permissions,
  public.gveg_migration_imports FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

COMMIT;
