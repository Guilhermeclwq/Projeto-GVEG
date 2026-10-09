# GVEG Gestão

Aplicação web para a gestão da fábrica VIP Couros. O sistema está sendo construído em etapas e não contém dados empresariais de demonstração.

## Requisitos

- Node.js 22.5 ou superior (o projeto utiliza o módulo SQLite integrado ao Node).
- Node/npm e acesso ao npm para instalar as dependências do projeto.

## Executar localmente

1. Copie `.env.example` para `.env`. Configure também `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY`; variáveis já definidas no sistema têm prioridade. O `.env` local está ignorado pelo Git.
2. Execute `npm install` e depois `npm start` na pasta do projeto.
3. Abra `http://127.0.0.1:3000`.
4. No primeiro acesso, crie a conta do proprietário com um e-mail válido e uma senha de pelo menos 12 caracteres. Não há senha inicial embutida no código.

O serviço escuta em `0.0.0.0` por padrão para aceitar conexões do Render; para restringir a execução local à própria máquina, defina `HOST=127.0.0.1` no `.env`. Em `NODE_ENV=production`, o cookie de sessão exige HTTPS.

## Testes

Execute `npm test`. O teste de integração usa um banco SQLite temporário e verifica configuração inicial, login, sessão, autorização, vendas históricas, recebimentos, compras, pagamentos parciais, produção, estoque, estimativa de custo e recibo.

## Supabase — primeira etapa de validação

O pacote oficial `@supabase/supabase-js` está instalado. A página **Teste Supabase**, acessível pela navegação após entrar na gestão, usa a URL e a chave publishable do `.env`. Essa chave é própria para cliente e não concede privilégios administrativos; a tabela da prova restringe operações com RLS.

Antes de usar a ferramenta, no Dashboard do projeto:

1. Abra **SQL Editor → New query**, cole todo o conteúdo de `supabase/migrations/202610090001_supabase_connection_test.sql` e execute.
2. Em **Authentication → Sign In / Providers**, deixe **Email** habilitado. Se confirmação por e-mail estiver ativa, adicione `http://127.0.0.1:3000` em **Authentication → URL Configuration → Redirect URLs**; a confirmação pode continuar ativa.
3. Inicie o app com `npm start`, entre na gestão e abra **Teste Supabase**. Crie um usuário Supabase, confirme o e-mail se solicitado e entre.
4. Clique em **Inserir e consultar**, confira o registro e atualize a página. A lista é consultada novamente no PostgreSQL.

Os dados da prova são isolados e cada usuário só acessa linhas cujo `user_id` corresponde à sessão autenticada.

O código não aplica migration remotamente. É necessário executar o SQL no painel antes de a tabela aparecer no Data API. Esta fase ainda não migra os módulos operacionais do SQLite; o avanço para eles depende de validar inserção, consulta após recarga e RLS nesta tabela. Não coloque uma chave `sb_secret_` ou `service_role` no navegador nem no `.env` usado pelo cliente.

## Banco de dados e cópia de segurança

Os dados de autenticação ficam em `data/gveg.sqlite`. O diretório é ignorado pelo Git. Pare o servidor antes de copiar esse arquivo para uma pasta de backup com acesso restrito. Para restaurar, pare o servidor, substitua `data/gveg.sqlite` pela cópia e inicie novamente. A cópia de segurança do banco não inclui documentos anexados, que ainda não fazem parte desta etapa.

Veja [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) para o procedimento de backup, restauração e o que falta para produção.

## Recibos

O arquivo original `Recibo_pdf/recibo_auto.html` é servido pela rota autenticada `/recibos/ferramenta` e aparece dentro do item **Recibos** na navegação da gestão. O HTML do gerador foi preservado byte a byte. A sessão de autenticação da gestão protege a rota de acesso ao arquivo.

## Estado da implementação

- **Fase 1 — base, navegação e autenticação:** implementada para uso local, incluindo criação da conta do proprietário, login, logout, sessão em cookie `HttpOnly` e navegação responsiva.
- **Fase 2 — cadastros básicos:** modelos, materiais, fornecedores e clientes persistem no SQLite; modelos podem ser atualizados e inativados.
- **Fase 3 — estoque e compras:** entradas por compra, saldos iniciais, devoluções, ajustes, perdas e consumo ficam registrados com usuário e motivo. Compras geram estoque e contas a pagar em transação; cancelamentos revertem o estoque quando ele ainda está disponível. A ficha técnica guarda o consumo previsto por bolsa.
- **Fase 4 — produção e custos:** ordens passam por planejada, em andamento, concluída e cancelada. A conclusão registra quantidades boas/defeituosas, baixa consumos, aumenta estoque de produtos acabados e preserva os custos calculados. O proprietário configura mão de obra por bolsa e parâmetro semanal.
- **Fase 5 — financeiro:** despesas, contas a pagar, vendas a receber e compras a pagar aceitam pagamentos parciais. Fluxo realizado considera as datas dos pagamentos.
- **Fase 6 — vendas e recibos:** vendas guardam clientes, itens, preços, desconto, recebimentos e histórico. Vendas anteriores à implantação não movimentam estoque nem registram recebimentos fictícios. A partir de uma venda, o recibo pode abrir pré-preenchido e continuar usando o gerador original e a impressão/exportação PDF.
- **Fase 7 — dashboard:** os indicadores, gráficos de caixa, vendas por modelo e despesas por categoria usam os dados salvos e aceitam intervalo de até um ano. Custos conhecidos aparecem como estimativa de lucro bruto; itens sem custo calculado são excluídos e identificados.
- **Fase 8 — restante:** relatórios financeiros, de produção e de estoque podem ser exportados em CSV; o proprietário configura os módulos liberados ao perfil Gerente. Testes iniciais cobrem autenticação, autorização, vendas históricas, pagamentos, compras, produção, estoque e recibo. Exportação PDF de relatórios, comparação entre períodos, ampliação dos testes e preparação de produção ainda faltam.
- **Arquitetura atual:** módulos operacionais ainda usam SQLite integrado. A conexão Supabase e uma ferramenta isolada de prova foram adicionadas; os dados comerciais ainda não foram migrados para PostgreSQL.
- **Estrutura de banco:** os arquivos numerados de `migrations/` são aplicados na inicialização e usam instruções idempotentes para as tabelas e parâmetros iniciais.

O servidor deve permanecer em rede privada até que a implantação com HTTPS, PostgreSQL, backups automáticos, controle de sessões e revisão de segurança seja preparada. Os valores de custo são estimativas gerenciais, não valores contábeis definitivos.
