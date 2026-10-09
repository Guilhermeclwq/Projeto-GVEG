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

const normalize = value => value == null ? null : String(value);

try {
  const oldPermissions = backup.prepare(
    'SELECT role, module, allowed FROM role_permissions ORDER BY role, module'
  ).all();

  const newPermissions = (await turso.execute(
    'SELECT role, module, allowed FROM role_permissions ORDER BY role, module'
  )).rows;

  const permissionKey = row =>
    [row.role, row.module, row.allowed].map(normalize).join('|');

  const oldPermissionSet = oldPermissions.map(permissionKey).sort();
  const newPermissionSet = newPermissions.map(permissionKey).sort();

  console.log(
    'Permissões iguais ao backup:',
    JSON.stringify(oldPermissionSet) === JSON.stringify(newPermissionSet)
  );

  const oldSettings = backup.prepare(
    'SELECT key, value FROM system_settings ORDER BY key'
  ).all();

  const newSettings = (await turso.execute(
    'SELECT key, value FROM system_settings ORDER BY key'
  )).rows;

  const settingMap = rows => new Map(
    rows.map(row => [String(row.key), normalize(row.value)])
  );

  const a = settingMap(oldSettings);
  const b = settingMap(newSettings);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const differences = keys.filter(
    key => !a.has(key) || !b.has(key) || a.get(key) !== b.get(key)
  );

  console.log('Quantidade de configurações no backup:', a.size);
  console.log('Quantidade de configurações no Turso:', b.size);
  console.log('Chaves com valores diferentes:', differences.length);
  for (const key of differences) console.log('-', key);

  console.log(
    'Usuários no backup:',
    backup.prepare('SELECT COUNT(*) AS total FROM users').get().total
  );
  console.log(
    'Usuários no Turso:',
    (await turso.execute('SELECT COUNT(*) AS total FROM users')).rows[0].total
  );
} finally {
  backup.close();
  turso.close();
}
