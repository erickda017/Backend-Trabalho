-- migration-34-extensao-tokens.sql  [2026-11]
-- Token PRÓPRIO da extensão do Chrome (Voxcel Assistente). Motivo: o projeto Supabase aceita uma sessão por usuário; se a
-- extensão fizesse login com e-mail/senha, derrubaria o login do site (e o contrário). O token abaixo NÃO é uma sessão do
-- Supabase: só vale para /api/integracoes/ennychat/*, é guardado como hash (SHA-256) e pode ser revogado.
-- Idempotente. Rodar no SQL Editor do Supabase.

create table if not exists extensao_tokens (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null,            -- SHA-256 hex do token (o token em si nunca é guardado)
  criado_em timestamptz not null default now(),
  ultimo_uso_em timestamptz,
  revogado_em timestamptz
);

create unique index if not exists extensao_tokens_hash_key on extensao_tokens (token_hash);
create index if not exists extensao_tokens_usuario_idx on extensao_tokens (usuario_id) where revogado_em is null;

alter table extensao_tokens enable row level security;
-- Sem policy: só o backend (service_role) lê/escreve. O dono não precisa enxergar o hash.
