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

let tx;

try {
  const users = backup.prepare(
    'SELECT id, name, email, password_hash, password_salt, role, active, created_at FROM users'
  ).all();

  if (users.length !== 1) {
    throw new Error('O backup não contém exatamente um usuário.');
  }

  const user = users[0];

  tx = await turso.transaction('write');

  const count = await tx.execute('SELECT COUNT(*) AS total FROM users');

  if (Number(count.rows[0].total) !== 0) {
    throw new Error('O Turso já contém usuários. Importação cancelada.');
  }

  await tx.execute({
    sql: `INSERT INTO users
      (id, name, email, password_hash, password_salt, role, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      user.id,
      user.name,
      user.email,
      user.password_hash,
      user.password_salt,
      user.role,
      user.active,
      user.created_at
    ]
  });

  await tx.commit();
  tx = null;

  console.log('Conta antiga importada com sucesso.');
  console.log('Permissões e configurações existentes foram preservadas.');
  console.log('Sessões antigas não foram importadas.');
} catch (error) {
  if (tx) {
    try { await tx.rollback(); } catch {}
  }
  console.error('Importação não concluída:', error.message);
  process.exitCode = 1;
} finally {
  if (tx) await tx.close();
  backup.close();
  turso.close();
}
