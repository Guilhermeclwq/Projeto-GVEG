import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error('Conexão não testada: configure TURSO_DATABASE_URL e TURSO_AUTH_TOKEN.');
  process.exit(2);
}
let protocol;
try { protocol = new URL(url).protocol; }
catch {
  console.error('Conexão não testada: URL inválida (valor omitido).');
  process.exit(2);
}
if (!['libsql:', 'https:'].includes(protocol)) {
  console.error('Conexão não testada: a URL não usa um protocolo Turso remoto válido.');
  process.exit(2);
}

let client;

function collectErrorChain(error) {
  const entries = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length && entries.length < 8) {
    const current = pending.shift();
    if (!current || (typeof current !== 'object' && typeof current !== 'function') || seen.has(current)) continue;
    seen.add(current);
    const name = ['LibsqlError','LibsqlBatchError','TypeError','TimeoutError','AbortError','Error','AggregateError',
      'ConnectTimeoutError','SocketError',
      'ClientError','ClosedError','ResponseError','HttpServerError','WebSocketError','ProtocolVersionError']
      .includes(current.name) ? current.name : 'Error';
    const rawCode = typeof current.code === 'string' ? current.code.toUpperCase() : '';
    const containsSecret = [authToken, url].some(secret => rawCode.includes(secret.toUpperCase()));
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) && !containsSecret ? rawCode : undefined;
    const status = Number.isInteger(current.status) && current.status >= 100 && current.status <= 599
      ? current.status : undefined;
    entries.push({ name, ...(code ? { code } : {}), ...(status ? { status } : {}) });
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  return entries;
}

function classifyError(entries) {
  const codes = entries.map(entry => entry.code || '');
  const statuses = entries.map(entry => entry.status).filter(Boolean);
  const names = entries.map(entry => entry.name);
  if (codes.some(code => /TLS|SSL|CERT/.test(code))) return 'TLS/certificado';
  if (codes.some(code => /ENOTFOUND|EAI_AGAIN|DNS/.test(code))) return 'DNS';
  if (codes.some(code => /TIMEOUT|ETIMEDOUT|ABORT/.test(code)) || names.some(name => ['TimeoutError','AbortError'].includes(name))) return 'timeout';
  if (statuses.includes(401) || statuses.includes(403) || codes.some(code => /AUTH|UNAUTHORIZED|FORBIDDEN/.test(code))) return 'autenticação/permissão';
  if (codes.some(code => /ECONNREFUSED/.test(code))) return 'conexão recusada';
  return 'causa ainda não identificada';
}

try {
  client = createClient({ url, authToken, intMode: 'number', concurrency: 1,
    fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }) });
  const result = await client.execute('SELECT 1 AS ok');
  if (result.rows[0]?.ok !== 1) throw new Error('UNEXPECTED_RESULT');
  console.log('Conexão Turso validada com SELECT 1.');
} catch (error) {
  const chain = collectErrorChain(error);
  const detail = chain.map(({ name, code, status }) =>
    `${name}${code ? ` code=${code}` : ''}${status ? ` status=${status}` : ''}`).join(' -> ');
  console.error(`Conexão Turso falhou (${classifyError(chain)}). Diagnóstico seguro: ${detail || 'tipo de erro indisponível'}.`);
  process.exitCode = 1;
} finally { client?.close(); }
