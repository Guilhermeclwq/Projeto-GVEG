CREATE TABLE IF NOT EXISTS customers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, document TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
 phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_document_unique ON customers(document) WHERE document<>'';
CREATE TABLE IF NOT EXISTS sales (
 id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, request_key TEXT NOT NULL UNIQUE,
 customer_id TEXT REFERENCES customers(id), sale_date TEXT NOT NULL, due_date TEXT NOT NULL DEFAULT '',
 subtotal_cents INTEGER NOT NULL, discount_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL,
 historical INTEGER NOT NULL DEFAULT 0, historical_received_cents INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','cancelled')),
 notes TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sale_items (
 id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), product_id TEXT REFERENCES products(id),
 product_name TEXT NOT NULL, sku TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '',
 quantity REAL NOT NULL CHECK(quantity>0), unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),
 unit_cost_cents INTEGER CHECK(unit_cost_cents>=0),
 line_total_cents INTEGER NOT NULL CHECK(line_total_cents>=0)
);
CREATE TABLE IF NOT EXISTS sale_payments (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, sale_id TEXT NOT NULL REFERENCES sales(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 paid_at TEXT NOT NULL, method TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS expenses (
 id TEXT PRIMARY KEY, description TEXT NOT NULL, category TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 expense_date TEXT NOT NULL, due_date TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','cancelled')),
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS expense_payments (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, expense_id TEXT NOT NULL REFERENCES expenses(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 paid_at TEXT NOT NULL, method TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS sales_date_idx ON sales(sale_date,status);
CREATE INDEX IF NOT EXISTS sale_payments_date_idx ON sale_payments(paid_at);
CREATE INDEX IF NOT EXISTS expense_date_idx ON expenses(expense_date,status);
CREATE INDEX IF NOT EXISTS expense_payments_date_idx ON expense_payments(paid_at);
