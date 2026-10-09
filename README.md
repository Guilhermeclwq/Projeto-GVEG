# GVEG Gestão

Aplicação web Node.js para a gestão da fábrica VIP Couros. O servidor usa Turso/libSQL remoto por `@libsql/client`; ele não usa o arquivo SQLite local como fallback de produção.

## Executar localmente

1. Instale Node.js 22.5+ e execute `npm install`.
2. Copie `.env.example` para `.env`; configure `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` obtidos no painel do Turso. Não compartilhe esses valores.
3. Crie um banco isolado com `turso db create gveg-dev`, consulte a URL com `turso db show --url gveg-dev` e gere o token com `turso db tokens create gveg-dev`. Para um banco Turso de desenvolvimento novo e vazio, execute `npm run migrate:turso`. O comando aplica as migrations em `turso/migrations`, registra checksums e aborta se encontrar tabelas existentes sem ledger. Para testar somente conectividade sem modificar esquema, use `npm run test:turso-connection`. Não importa registros do SQLite.
4. Execute `npm start` e abra `http://127.0.0.1:3000`. No primeiro acesso, crie a conta proprietária.

O servidor verifica `SELECT 1` e a existência do ledger antes de abrir a porta. Não executa DDL no startup. Se a URL ou o token estiverem ausentes/incorretos ou o esquema não tiver sido preparado, o processo não inicia. Cookies de sessão exigem HTTPS quando `NODE_ENV=production`.

## Render

Defina `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` em **Environment** no serviço web, além de `NODE_ENV=production`. O Render fornece `PORT`; o servidor escuta em `0.0.0.0`. O app não requer disco persistente. Nesta etapa não foram alteradas variáveis da Render nem feito deploy.

Prepare e valide o esquema em um banco Turso descartável antes de apontar qualquer serviço ativo. Nunca execute `npm run migrate:turso` em produção sem revisar o destino e fazer backup. O comando só inicializa destino vazio; bancos GVEG preexistentes sem ledger são recusados.

## Testes

Execute `npm test`. A suíte cria uma base libSQL em diretório temporário isolado, aplica as migrations nela, cobre autenticação, permissões, CRUD, vendas, estoque, pagamentos, transações e persistência após reiniciar o servidor, e remove somente esse diretório de teste. Esses testes não conectam ao Turso remoto; a conexão real depende de credenciais de um banco de desenvolvimento separado.

## Dados e migrations antigas

O arquivo `data/gveg.sqlite` foi preservado e a auditoria anterior encontrou dados nele. Nenhuma migração de registros foi feita. A implementação atual não possui importador SQLite→Turso: não aponte para uma instância Turso que contenha dados operacionais sem um procedimento de importação validado. Faça backup do SQLite e compare contagens/relacionamentos antes de planejar a carga.

As migrations SQL de `supabase/migrations/` foram mantidas como histórico e não são aplicadas pelo app. Variáveis antigas `DATABASE_URL` e `SUPABASE_*` foram mantidas no exemplo durante o corte, mas o servidor GVEG não as lê.

## Backups

Faça snapshots/exportações pelo Turso antes de qualquer alteração de esquema. Preserve também uma cópia offline consistente do arquivo SQLite legado e seus dados associados; não copie apenas o arquivo principal enquanto o WAL estiver ativo. O código não cria, substitui ou apaga bancos automaticamente.