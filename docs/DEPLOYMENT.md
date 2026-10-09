# Operação, backup e implantação

## Estado atual

Esta versão é executável em uma máquina Windows ou Linux com Node.js 22.5 ou superior. Usa SQLite no servidor único e o módulo nativo `node:sqlite`. Ele ainda é marcado experimental pelo Node.js 24 usado no desenvolvimento. Não existe adaptador PostgreSQL nesta versão. A implantação multi-instância e a exposição à internet não estão prontas.

### Preparação para Render

O projeto pode iniciar como um Web Service Node no Render com `npm install` e `npm start` (Node.js 22.5 ou superior). O servidor usa `process.env.PORT`, com fallback local em `3000`, e escuta em `0.0.0.0`. O script `prestart` gera o bundle do cliente Supabase antes de iniciar. Não é necessário configurar `HOST` ou `PORT` no Render.

Defina `NODE_ENV=production`, `SESSION_DAYS` (opcional), `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` nas variáveis de ambiente do serviço. A chave publishable é enviada ao navegador para o cliente Supabase; nunca configure uma chave `sb_secret_` ou `service_role`. O `.env.example` lista as variáveis e valores de exemplo não secretos.

**Limite para uso real:** os módulos operacionais ainda gravam em SQLite. O disco de um Web Service gratuito do Render é efêmero, então o arquivo SQLite pode ser perdido ao reiniciar ou implantar; não use esse serviço com dados operacionais até migrar essa persistência para PostgreSQL ou adotar armazenamento persistente compatível. O cliente Supabase atualmente só atende a ferramenta de teste isolada. Esta preparação permite validar a inicialização e servir a interface; não torna o armazenamento comercial persistente no Render gratuito.

O cliente oficial `@supabase/supabase-js` está configurado para a etapa de validação em uma tabela dedicada. Antes de abrir **Teste Supabase**, aplique `supabase/migrations/202610090001_supabase_connection_test.sql` no SQL Editor do projeto e defina `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` no `.env`. Esta configuração não migra nem sincroniza os módulos de negócio: eles continuam no SQLite até que o teste de gravação, leitura após recarga e isolamento RLS seja concluído.

Para mais de um computador da fábrica, os navegadores podem acessar a mesma instância na rede local. Restrinja o acesso pela rede e use HTTPS em um proxy reverso; configure `HOST` e `PORT` no `.env`. Com `NODE_ENV=production`, o navegador só envia o cookie de sessão por HTTPS.

## Backup manual

1. Avise os usuários e encerre o processo Node normalmente para fechar o banco e confirmar o WAL.
2. Copie `data/gveg.sqlite` para uma pasta de backup com acesso restrito e criptografia em repouso.
3. Registre a data da cópia e guarde uma cópia em outra unidade protegida.
4. Reinicie o servidor e confirme o login e uma consulta de leitura.

Não faça a cópia enquanto o processo estiver gravando no SQLite. Esta aplicação ainda não agenda backups nem copia anexos de documentos.

## Restauração

1. Pare o processo Node normalmente.
2. Copie o banco atual para uma pasta de quarentena; não o sobrescreva sem guardar essa cópia.
3. Copie o arquivo de backup para `data/gveg.sqlite`.
4. Inicie o servidor e confirme o login, a contagem de registros e uma leitura de cada módulo operacional.
5. Preserve o banco em quarentena até confirmar que o estado restaurado está correto.

## Antes de uma implantação de produção

- Migrar a persistência para PostgreSQL e executar testes de migração e concorrência.
- Configurar HTTPS, firewall, proxy reverso, serviço gerenciado e logs com rotação.
- Automatizar backups criptografados e executar um teste de restauração.
- Definir política de retenção, acesso a dados pessoais e gestão segura de segredos.
- Executar a suíte de testes e uma revisão de segurança em um ambiente de homologação com dados fictícios.

Não exponha a porta HTTP do servidor diretamente à internet.
