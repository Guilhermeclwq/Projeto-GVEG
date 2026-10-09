import { createClient } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();

class Mutex {
  tail = Promise.resolve();
  async acquire() {
    let release;
    const next = new Promise(resolve => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }
}

export function openTursoDatabase({ url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN } = {}) {
  if (!url) throw new Error('TURSO_DATABASE_URL_REQUIRED');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('TURSO_DATABASE_URL_INVALID'); }
  const localTest = process.env.NODE_ENV === 'test' && parsed.protocol === 'file:';
  if (!localTest && !['libsql:', 'https:'].includes(parsed.protocol)) throw new Error('TURSO_DATABASE_URL_INVALID');
  if (!localTest && !authToken) throw new Error('TURSO_AUTH_TOKEN_REQUIRED');
  const client = createClient({ url, authToken, intMode: 'number', concurrency: 1,
    fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }) });
  const mutex = new Mutex();
  let closed = false;
  const execute = async (sql, args = []) => {
    if (closed) throw new Error('DATABASE_CLOSED');
    const tx = context.getStore()?.tx;
    if (tx) return tx.execute({ sql, args });
    const release = await mutex.acquire();
    try { return await client.execute({ sql, args }); } finally { release(); }
  };
  const db = {
    client,
    get isTransaction() { return Boolean(context.getStore()?.tx); },
    prepare(sql) {
      return {
        async get(...args) { return (await execute(sql, args)).rows[0]; },
        async all(...args) { return (await execute(sql, args)).rows; },
        async run(...args) { return execute(sql, args); }
      };
    },
    async exec(sql) {
      const command = sql.trim().toUpperCase();
      const store = context.getStore();
      if (command === 'BEGIN IMMEDIATE' || command === 'BEGIN') {
        if (!store || store.tx) throw new Error('DATABASE_TRANSACTION_STATE');
        store.release = await mutex.acquire();
        try { store.tx = await client.transaction('write'); }
        catch (error) { store.release(); store.release = null; throw error; }
        return;
      }
      if (command === 'COMMIT') {
        if (!store?.tx) throw new Error('DATABASE_TRANSACTION_STATE');
        const tx = store.tx; store.tx = null;
        try { await tx.commit(); } finally { await tx.close(); store.release(); store.release = null; }
        return;
      }
      if (command === 'ROLLBACK') {
        if (!store?.tx) return;
        const tx = store.tx; store.tx = null;
        try { await tx.rollback(); } finally { await tx.close(); store.release(); store.release = null; }
        return;
      }
      return execute(sql);
    },
    async withRequest(fn) { return context.run({}, fn); },
    async close() { closed = true; client.close(); }
  };
  return db;
}

export async function verifyTursoSchema(db) {
  const names = await db.prepare('SELECT name FROM gveg_schema_migrations ORDER BY name').all();
  const expected = ['001-base.sql','002-sales-finance.sql','003-production-purchases.sql','004-permissions.sql'];
  if (names.length !== expected.length || expected.some(name => !names.some(row => row.name === name))) throw new Error('TURSO_SCHEMA_NOT_MIGRATED');
}
