import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(
  'backups/gveg-pre-turso-2026-10-09T15-05-00.874Z.sqlite',
  { readOnly: true }
);

try {
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();

  console.log('Tabelas no backup:', tables.length);

  for (const { name } of tables) {
    const count = db.prepare(
      `SELECT COUNT(*) AS total FROM "${name.replaceAll('"', '""')}"`
    ).get();

    console.log(`${name}: ${count.total} registros`);
  }
} finally {
  db.close();
}
