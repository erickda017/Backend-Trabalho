-- Rode isso no SQL Editor do Supabase. Idempotente, pode rodar de novo com segurança.
--
-- CONTEXTO: nome e foto de perfil do operador viviam só no localStorage do
-- navegador (ver frontend/src/lib/app-state.tsx) -- trocar de máquina/
-- navegador perdia tudo, e "várias pessoas revezando no mesmo login"
-- (cenário citado no comentário original) via cada uma um perfil diferente
-- sem querer. A tabela `perfis` já existe desde migration-16-supervisor.sql
-- com uma coluna `nome` (nunca escrita de verdade); esta migration adiciona
-- a coluna que faltava (foto) e o bucket de Storage pra guardar o arquivo.

alter table perfis add column if not exists avatar_path text; -- path no bucket 'avatars', null = sem foto

comment on column perfis.avatar_path is
  'Path da foto de perfil no bucket privado "avatars" (1 arquivo fixo por usuário, ${id}/avatar -- upload novo sobrescreve). '
  'Resolvida pra URL via proxy de arquivos (ver backend/src/lib/supabase.js, urlProxyArquivo), nunca exposta como signed URL direta.';

-- Mesmo padrão de bucket privado dos outros três (faturas, chat-midia,
-- pix-extracoes) -- ver migration-12-seguranca-buckets-privados.sql.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do update set public = false;
