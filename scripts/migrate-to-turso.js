import { createClient } from '@libsql/client';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) throw new Error('Configure TURSO_DATABASE_URL antes de migrar.');
let parsedUrl;
try { parsedUrl = new URL(url); } catch { throw new Error('TURSO_DATABASE_URL inválida; valor omitido.'); }
const localTest = process.env.NODE_ENV === 'test' && parsedUrl.protocol === 'file:';
if (!localTest && !authToken) throw new Error('Configure TURSO_AUTH_TOKEN antes de migrar.');
if (!localTest && !['libsql:', 'https:'].includes(parsedUrl.protocol)) throw new Error('A URL deve apontar para um banco Turso remoto.');
if (localTest && authToken) throw new Error('O teste local não aceita token remoto.');
const client = createClient({ url, authToken, intMode: 'number', concurrency: 1,
  fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }) });
const files = (await readdir(path.join(root, 'turso', 'migrations'))).filter(name => /^\d+.*\.sql$/.test(name)).sort();
const checksum = text => createHash('sha256').update(text).digest('hex');
try {
  await client.execute('SELECT 1');
  const ledger = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='gveg_schema_migrations'");
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  if (!ledger.rows.length && tables.rows.length) throw new Error('Banco não vazio sem histórico de migrations; interrompido para evitar alterar esquema ou dados existentes.');
  if (!ledger.rows.length) await client.execute('CREATE TABLE gveg_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const applied = new Map((await client.execute('SELECT name,checksum FROM gveg_schema_migrations')).rows.map(r => [r.name,r.checksum]));
  if ([...applied.keys()].some(name => !files.includes(name))) throw new Error('O ledger contém migrations desconhecidas; interrompido para revisão.');
  for (const name of files) {
    const sql = await readFile(path.join(root, 'turso', 'migrations', name), 'utf8');
    const digest = checksum(sql);
    if (applied.has(name)) {
      if (applied.get(name) !== digest) throw new Error(`Checksum divergente na migration ${name}; interrompido.`);
      continue;
    }
    const tx = await client.transaction('write');
    try {
      await tx.executeMultiple(sql);
      await tx.execute({ sql: 'INSERT INTO gveg_schema_migrations(name,checksum) VALUES(?,?)', args: [name,digest] });
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
  }
  console.log(`Migrações verificadas/aplicadas: ${files.length}. Nenhum dado foi importado.`);
} catch (error) {
  const message = String(error?.message || '');
  const safeMessages = [
    'Banco não vazio sem histórico de migrations; interrompido para evitar alterar esquema ou dados existentes.',
    'O ledger contém migrations desconhecidas; interrompido para revisão.'
  ];
  const safe = safeMessages.find(item => message.startsWith(item));
  console.error(safe || 'Falha ao validar ou aplicar migrations Turso; detalhes de conexão foram omitidos.');
  process.exitCode = 1;
} finally { client.close(); }
