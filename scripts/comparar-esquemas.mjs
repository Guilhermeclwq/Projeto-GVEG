import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@libsql/client';

const backup = new DatabaseSync(
  'backups/gveg-pre-turso-2026-10-09T15-05-00.874Z.sqlite',
  { readOnly: true }
);

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

try {
  for (const table of ['users', 'role_permissions', 'system_settings', 'sessions']) {
    console.log(`\n--- ${table} ---`);

    const oldColumns = backup.prepare(
      `PRAGMA table_info("${table}")`
    ).all().map(column => column.name);

    const newResult = await turso.execute(
      `PRAGMA table_info("${table}")`
    );

    const newColumns = newResult.rows.map(column => column.name);

    console.log('Backup:', oldColumns.join(', '));
    console.log('Turso: ', newColumns.join(', '));
  }
} finally {
  backup.close();
  turso.close();
}
