CREATE TABLE IF NOT EXISTS product_materials (
 product_id TEXT NOT NULL REFERENCES products(id), material_id TEXT NOT NULL REFERENCES materials(id),
 quantity_per_unit REAL NOT NULL CHECK(quantity_per_unit>0), PRIMARY KEY(product_id,material_id)
);
CREATE TABLE IF NOT EXISTS product_stock (
 product_id TEXT PRIMARY KEY REFERENCES products(id), quantity REAL NOT NULL DEFAULT 0 CHECK(quantity>=0),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS product_price_history (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), user_id TEXT NOT NULL REFERENCES users(id),
 previous_price_cents INTEGER, new_price_cents INTEGER NOT NULL, reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS production_orders (
 id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, request_key TEXT NOT NULL UNIQUE, product_id TEXT NOT NULL REFERENCES products(id),
 planned_quantity REAL NOT NULL CHECK(planned_quantity>0), produced_quantity REAL NOT NULL DEFAULT 0,
 approved_quantity REAL NOT NULL DEFAULT 0, defective_quantity REAL NOT NULL DEFAULT 0,
 status TEXT NOT NULL CHECK(status IN ('planned','in_progress','completed','cancelled')),
 start_date TEXT NOT NULL, due_date TEXT NOT NULL DEFAULT '', completed_at TEXT NOT NULL DEFAULT '',
 labor_cost_cents INTEGER NOT NULL DEFAULT 0, additional_cost_cents INTEGER NOT NULL DEFAULT 0,
 material_cost_cents INTEGER NOT NULL DEFAULT 0, unit_cost_cents INTEGER,
 responsible TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS production_consumptions (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES production_orders(id), material_id TEXT NOT NULL REFERENCES materials(id),
 quantity REAL NOT NULL CHECK(quantity>0), unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents>=0), total_cost_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
 id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, request_key TEXT NOT NULL UNIQUE, supplier_id TEXT NOT NULL REFERENCES suppliers(id),
 purchase_date TEXT NOT NULL, due_date TEXT NOT NULL DEFAULT '', freight_cents INTEGER NOT NULL DEFAULT 0,
 discount_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL CHECK(total_cents>0),
 status TEXT NOT NULL CHECK(status IN ('open','paid','cancelled')), notes TEXT NOT NULL DEFAULT '',
 user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS purchase_items (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchases(id), material_id TEXT NOT NULL REFERENCES materials(id),
 quantity REAL NOT NULL CHECK(quantity>0), unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents>=0), total_cost_cents INTEGER NOT NULL,
 previous_unit_cost_cents INTEGER NOT NULL, previous_supplier_id TEXT, previous_purchase_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchase_payments (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, purchase_id TEXT NOT NULL REFERENCES purchases(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 paid_at TEXT NOT NULL, method TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS material_cost_history (
 id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES materials(id), supplier_id TEXT NOT NULL REFERENCES suppliers(id),
 purchase_id TEXT NOT NULL REFERENCES purchases(id), unit_cost_cents INTEGER NOT NULL, purchase_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS production_status_idx ON production_orders(status,start_date);
CREATE INDEX IF NOT EXISTS purchases_date_idx ON purchases(purchase_date,status);
CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO system_settings(key,value) VALUES('labor_cost_per_bag_cents','1900'),('weekly_seamstress_cost_cents','55000');
