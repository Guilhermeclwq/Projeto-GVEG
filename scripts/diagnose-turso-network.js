import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const rawUrl = process.env.TURSO_DATABASE_URL;
const secretValues = [rawUrl, process.env.TURSO_AUTH_TOKEN].filter(Boolean).map(value => value.toUpperCase());
if (!rawUrl) {
  console.error('Diagnóstico cancelado: TURSO_DATABASE_URL não está configurada.');
  process.exit(2);
}

let target;
try {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'libsql:' && parsed.protocol !== 'https:') throw new Error();
  target = new URL(parsed.protocol === 'libsql:' ? parsed.href.replace(/^libsql:/i, 'https:') : parsed.href);
  target.username = '';
  target.password = '';
  target.pathname = '/';
  target.search = '';
  target.hash = '';
} catch {
  console.error('Diagnóstico cancelado: URL inválida ou protocolo não suportado; valor omitido.');
  process.exit(2);
}

const proxyKeys = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'];
const curlConfigPaths = [path.join(os.homedir(), '.curlrc'), path.join(os.homedir(), '_curlrc')];
if (process.env.APPDATA) curlConfigPaths.push(path.join(process.env.APPDATA, '_curlrc'));
const curlConfig = { filesFound: 0, proxyDirectivePresent: false, authDirectivePresent: false };
for (const configPath of new Set(curlConfigPaths)) {
  try {
    const text = await readFile(configPath, 'utf8');
    curlConfig.filesFound++;
    for (const line of text.split(/\r?\n/)) {
      const directive = line.replace(/^\s*--?/, '').match(/^([a-z0-9-]+)\s*(?:=|\s)/i)?.[1]?.toLowerCase();
      if (['proxy','preproxy','proxy-user','proxy-header'].includes(directive)) curlConfig.proxyDirectivePresent = true;
      if (['user','header','oauth2-bearer'].includes(directive)) curlConfig.authDirectivePresent = true;
    }
  } catch { /* Missing/unreadable curl config: report presence only. */ }
}
console.log(JSON.stringify({
  nodeVersion: process.version,
  undiciVersion: process.versions.undici || 'indisponível',
  probeProtocol: target.protocol,
  probeHasHost: Boolean(target.hostname),
  nodeEnvProxyEnabled: process.env.NODE_USE_ENV_PROXY === '1',
  proxyVariablesPresent: Object.fromEntries(proxyKeys.map(key => [key, Boolean(process.env[key])])),
  curlConfig
}));

function safeError(error) {
  const values = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length && values.length < 6) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const name = ['TypeError','TimeoutError','AbortError','Error','ConnectTimeoutError'].includes(item.name)
      ? item.name : 'Error';
    const rawCode = typeof item.code === 'string' ? item.code.toUpperCase() : '';
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) && !secretValues.some(secret => rawCode.includes(secret))
      ? rawCode : undefined;
    values.push(`${name}${code ? ` code=${code}` : ''}`);
    if (item.cause) pending.push(item.cause);
  }
  return values.join(' -> ') || 'erro sem detalhes seguros';
}

function safeCurlFailure(stderr) {
  const text = String(stderr || '').toLowerCase();
  if (/unsupported protocol|protocol .* not supported/.test(text)) return 'protocolo HTTPS indisponível no curl executado';
  if (/could not resolve proxy|cannot resolve proxy/.test(text)) return 'falha de DNS do proxy';
  if (/could not resolve host|couldn't resolve host/.test(text)) return 'falha de DNS do destino';
  if (/failed to connect|could not connect|connection refused/.test(text)) return 'conexão recusada';
  if (/timed out|timeout was reached/.test(text)) return 'timeout';
  if (/certificate|ssl connect error|tls/.test(text)) return 'falha TLS/certificado';
  if (/proxy connect aborted|tunnel connection/.test(text)) return 'falha no túnel do proxy';
  return 'falha de transporte';
}

const fetchStarted = Date.now();
try {
  const response = await fetch(target, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  await response.body?.cancel();
  console.log(`Node HTTPS HEAD: status=${response.status}; tempo_ms=${Date.now() - fetchStarted}`);
} catch (error) {
  console.log(`Node HTTPS HEAD: falhou; tempo_ms=${Date.now() - fetchStarted}; ${safeError(error)}`);
}

const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
const sink = process.platform === 'win32' ? 'NUL' : '/dev/null';
const curlStarted = Date.now();
const result = spawnSync(curl, [
  '-q', '-I', '-sS', '--connect-timeout', '10', '--max-time', '15', '-o', sink,
  '-w', '%{http_code}|%{time_connect}|%{time_appconnect}', target.href
], { encoding: 'utf8', timeout: 17_000, windowsHide: true });
if (result.error) {
  console.log(`curl HTTPS HEAD: falhou; tempo_ms=${Date.now() - curlStarted}; ${safeError(result.error)}`);
} else if (result.status !== 0) {
  const curlCode = result.stderr.match(/curl:\s*\((\d+)\)/i)?.[1];
  console.log(`curl HTTPS HEAD: falhou (${safeCurlFailure(result.stderr)}); tempo_ms=${Date.now() - curlStarted}${curlCode ? ` curl_code=${curlCode}` : ''}`);
} else {
  const [status, connectSeconds, tlsSeconds] = result.stdout.trim().split('|');
  console.log(`curl HTTPS HEAD: status=${status}; tcp_ms=${Math.round(Number(connectSeconds) * 1000)}; tls_ms=${Math.round(Number(tlsSeconds) * 1000)}`);
}

if (proxyKeys.some(key => process.env[key]) && process.env.NODE_USE_ENV_PROXY !== '1') {
  console.log('Observação: curl pode usar proxy do ambiente; o fetch do Node não está habilitado para isso nesta execução.');
}
