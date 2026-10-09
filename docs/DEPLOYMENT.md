# Implantação GVEG com Turso

## Estado

A aplicação usa `@libsql/client` e exige `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`. Não há fallback para `data/gveg.sqlite`, PostgreSQL ou Supabase. O startup faz uma consulta de conectividade e verifica `gveg_schema_migrations`; ele não executa DDL. A Render e seus valores de ambiente não foram modificados e não houve deploy.

## Preparar um banco descartável

1. Crie manualmente um banco Turso separado para desenvolvimento (`turso db create gveg-dev`); obtenha URL (`turso db show --url gveg-dev`) e token (`turso db tokens create gveg-dev`). Consulte a [quickstart oficial TypeScript](https://docs.turso.tech/sdk/ts/quickstart).
2. Guarde-os somente no `.env` local (ignorado pelo Git), ou no ambiente do host apropriado. `npm run test:turso-connection` executa somente `SELECT 1`, sem DDL. Não os cole no terminal se o histórico do shell for compartilhado.
3. Revise `turso/migrations/*.sql` e rode `npm run migrate:turso` apenas apontando para o banco descartável vazio. O comando grava um ledger com checksums; se o destino tiver tabelas sem ledger ou uma versão inesperada, ele para.
4. Rode `npm test` para validar fluxo funcional com banco libSQL temporário local. Para comprovar rede, TLS e credenciais, execute `npm start` com as variáveis do banco de desenvolvimento e confira a disponibilidade HTTP sem imprimir a configuração.

## Render

Após a validação e aprovação manual do proprietário, configure `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` e `NODE_ENV=production` em Render → Environment e faça deploy manual. O servidor usa `PORT` e `0.0.0.0`; nenhum disco persistente é necessário. Não remova variáveis antigas do serviço até verificar que a versão anterior não depende mais delas.

## Dados existentes e recuperação

`data/gveg.sqlite` permanece no projeto e não foi importado. A auditoria anterior encontrou registros; não trate o novo banco como cópia desses dados. Este projeto ainda não tem um importador seguro SQLite→Turso, por isso nenhum procedimento de carga deve ser iniciado com dados reais até existir script explícito com validação de contagens, chaves estrangeiras, checksum e repetibilidade.

Antes de qualquer mudança futura, faça backup consistente do SQLite (incluindo WAL através de ferramenta SQLite de backup) e backup/exportação do destino Turso. Preserve cópias independentes e ensaie a restauração num banco descartável. As migrations PostgreSQL antigas em `supabase/migrations/` foram preservadas e não são compatíveis para aplicação automática no Turso.

## Testes executados localmente

`npm test` usa uma base temporária isolada, aplica o conjunto de migrations Turso e testa setup/login/sessão, permissões, operações de negócio cobertas pela integração, transações, integridade relacional e persistência após reinício. Isso não testa autenticação/rede de um Turso remoto. Essa validação depende de uma instância Turso de desenvolvimento e credenciais locais.