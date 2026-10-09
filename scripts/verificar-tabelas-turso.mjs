import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

try {
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );

  console.log('Tabelas encontradas:', result.rows.length);
  for (const row of result.rows) {
    console.log('-', row.name);
  }
} catch {
  console.log('Falha ao consultar as tabelas do Turso.');
  process.exitCode = 1;
} finally {
  client.close();
}
