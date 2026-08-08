-- Rodar no SQL Editor do Supabase (banco já existente, em produção).
-- Idempotente: pode rodar de novo com segurança.

-- ==========================================================================
-- Tags por cliente
-- ==========================================================================
create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  cor text not null default '#6366f1',
  created_at timestamptz default now()
);
create unique index if not exists tags_nome_key on tags (lower(nome));

create table if not exists cliente_tags (
  cliente_id uuid not null references clientes(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (cliente_id, tag_id)
);
create index if not exists cliente_tags_tag_id_idx on cliente_tags (tag_id);

-- ==========================================================================
-- Mensagens rápidas (atalho "/algo" no Chat)
-- ==========================================================================
create table if not exists respostas_rapidas (
  id uuid primary key default gen_random_uuid(),
  atalho text not null, -- sem a barra, ex: "boasvindas" -- digitar "/boasvindas" no chat
  texto text not null,
  created_at timestamptz default now()
);
create unique index if not exists respostas_rapidas_atalho_key on respostas_rapidas (lower(atalho));

-- ==========================================================================
-- Código Pix extraído do QR code do PDF da fatura (ver backend/src/lib/pixFromPdf.js)
-- ==========================================================================
alter table clientes add column if not exists pix_code text;

alter table tags enable row level security;
alter table cliente_tags enable row level security;
alter table respostas_rapidas enable row level security;

-- Opcional: corrige conversas já existentes que ficaram com o pushName do WhatsApp
-- em vez do nome cadastrado (planilha/boleto) -- daqui pra frente isso não acontece
-- mais sozinho (fix em chatIngest.js), mas o que já foi salvo errado fica como estava
-- até você rodar isto manualmente.
-- update conversas c
-- set nome_contato = cl.nome
-- from clientes cl
-- where c.cliente_id = cl.id and c.nome_contato is distinct from cl.nome;

