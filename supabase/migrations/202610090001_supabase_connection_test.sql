-- Etapa 1: tabela isolada para validar autenticação, persistência e RLS.
-- Aplicar no Supabase SQL Editor antes de usar a ferramenta de teste.
begin;

create table public.supabase_connection_tests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note text not null check (char_length(note) between 1 and 200),
  created_at timestamptz not null default now()
);

create index supabase_connection_tests_user_created_idx
  on public.supabase_connection_tests (user_id, created_at desc);

alter table public.supabase_connection_tests enable row level security;

create policy "Users read their own connection tests"
  on public.supabase_connection_tests for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users insert their own connection tests"
  on public.supabase_connection_tests for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users update their own connection tests"
  on public.supabase_connection_tests for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users delete their own connection tests"
  on public.supabase_connection_tests for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.supabase_connection_tests from anon;
grant select, insert, update, delete on table public.supabase_connection_tests to authenticated;

commit;
