CREATE TABLE IF NOT EXISTS role_permissions (
 role TEXT NOT NULL CHECK(role='manager'), module TEXT NOT NULL, allowed INTEGER NOT NULL DEFAULT 1 CHECK(allowed IN (0,1)),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(role,module)
);
INSERT OR IGNORE INTO role_permissions(role,module,allowed) VALUES
 ('manager','products',1),('manager','materials',1),('manager','production',1),
 ('manager','purchases',1),('manager','suppliers',1),('manager','sales',1),('manager','customers',1),
 ('manager','finance',1),('manager','reports',1),('manager','receipts',1);
