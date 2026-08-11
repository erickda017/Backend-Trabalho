-- Rode isso no SQL Editor do Supabase (idempotente).
-- Migração pra alinhar o backend ao novo front (dois slots de WhatsApp,
-- estratégia de envio, extrator de PIX em lote, exportações).

-- ---------------------------------------------------------------------------
-- 1) Slot em tudo que hoje assume uma única sessão WhatsApp
-- ---------------------------------------------------------------------------
alter table envios add column if not exists slot smallint; -- 1 | 2 | null (deixa a estratégia escolher)
alter table envios add column if not exists lote text; -- rótulo opcional exibido na listagem
alter table envios add column if not exists intervalo_ms integer; -- intervalo fixo entre mensagens (null = aleatório MIN/MAX_DELAY_MS)
alter table envio_itens add column if not exists slot smallint; -- slot que efetivamente enviou o item
alter table conversas add column if not exists slot smallint; -- último slot usado nessa conversa
alter table mensagens add column if not exists slot smallint;

-- ---------------------------------------------------------------------------
-- 2) Estratégia de envio (linha única, id fixo)
-- ---------------------------------------------------------------------------
create table if not exists estrategia_config (
  id boolean primary key default true, -- trava em 1 linha só
  estrategia text not null default 'qualquer', -- slot_1 | slot_2 | round_robin | qualquer
  next_slot smallint not null default 1, -- próximo slot no round robin
  constraint estrategia_config_singleton check (id)
);
insert into estrategia_config (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3) Extrator de PIX (upload em lote de PDFs, processado assincronamente)
-- ---------------------------------------------------------------------------
create table if not exists pix_extracoes (
  id uuid primary key default gen_random_uuid(),
  arquivo text not null,
  cliente_id uuid references clientes(id) on delete set null,
  status text not null default 'aguardando', -- aguardando | processando | encontrado | nao_encontrado | erro
  pix_code text,
  erro text,
  storage_path text, -- caminho do PDF no bucket, usado pra reprocessar
  criado_em timestamptz default now()
);
create index if not exists pix_extracoes_status_idx on pix_extracoes (status);
create index if not exists pix_extracoes_cliente_id_idx on pix_extracoes (cliente_id);

alter table estrategia_config enable row level security;
alter table pix_extracoes enable row level security;

-- Bucket pros PDFs enviados ao extrator (mesmo storage, pasta separada da de faturas)
insert into storage.buckets (id, name, public)
values ('pix-extracoes', 'pix-extracoes', true)
on conflict (id) do nothing;
