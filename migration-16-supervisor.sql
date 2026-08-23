-- Rodar no SQL Editor do Supabase. Idempotente.
--
-- CONTEXTO: até aqui o sistema era 100% isolado por usuario_id -- cada login
-- só via os próprios dados, sem noção de "papel" nem de outros usuários.
-- O SUPERVISOR quebra essa isolação de propósito: é um papel que enxerga
-- clientes/faturas/disparos de TODOS os operadores (é uma operação única,
-- não multi-empresa -- ver decisão no chat) e tem funções próprias
-- (planilha de PIX, extrator pessoal).
--
-- `perfis` espelha auth.users com um campo a mais (`role`). Toda request
-- autenticada faz upsert aqui (ver middleware/auth.js) só com id/email --
-- então a linha sempre existe pra qualquer um que já logou, e o dono do
-- sistema promove quem quiser rodando o UPDATE comentado no fim.

create table if not exists perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  nome text,
  role text not null default 'operador' check (role in ('operador', 'supervisor')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

comment on table perfis is
  'Espelho leve de auth.users + role (operador|supervisor). Populado automaticamente no login (ver middleware/auth.js) -- promover alguém a supervisor é só um UPDATE aqui.';

alter table perfis enable row level security;
-- Só o backend (service_role) lê/escreve -- mesmo padrão do resto do banco.

-- Pra promover alguém a supervisor, rode (troque o e-mail):
-- update perfis set role = 'supervisor' where email = 'dono@empresa.com';
