-- migration-33-operadora-faturas.sql  [2026-11]
-- Integração EnnyChat: operadora do cliente (Desktop, Claro BG/Mega/Fênix...) e TODAS as faturas de cada ficha.
-- Idempotente. Rodar no SQL Editor do Supabase.

-- 1) Operadora do cliente (slug do EnnyChat: 'desktop', 'claro-fenix', ...). Usada para NUNCA misturar clientes de
--    operadoras diferentes que tenham a mesma OS/telefone. Nulo = cadastro antigo (a 1ª sincronização preenche).
alter table clientes add column if not exists ennychat_operadora text;
create index if not exists clientes_usuario_operadora_idx
  on clientes (usuario_id, ennychat_operadora) where ennychat_operadora is not null;

-- 2) Todas as faturas de uma ficha (Fatura 1, Fatura 2...). Uma linha por fatura do EnnyChat.
--    `clientes` continua representando a fatura "corrente"; aqui ficam todas, com pagamento e Pix.
create table if not exists ennychat_faturas (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  fatura_externa_id text not null,
  cliente_id uuid references clientes(id) on delete set null,
  operadora text,
  os_numero text,
  posicao integer,
  mes_referencia date,
  vencimento date,
  valor numeric(12, 2),
  status_pagamento text,
  data_pagamento date,
  pago boolean not null default false,
  pix_code text,               -- Pix copia-e-cola VÁLIDO (CRC conferido) vindo do site da operadora (campo codigo_pix)
  pix_origem text,             -- 'site' (digitado pelo operador no EnnyChat) | 'pdf'
  pix_atualizado_em timestamptz,
  atualizado_em timestamptz not null default now()
);

create unique index if not exists ennychat_faturas_usuario_fatura_key
  on ennychat_faturas (usuario_id, fatura_externa_id);
create index if not exists ennychat_faturas_cliente_idx on ennychat_faturas (cliente_id);
create index if not exists ennychat_faturas_usuario_pago_idx on ennychat_faturas (usuario_id, pago);

alter table ennychat_faturas enable row level security;
drop policy if exists "dono ve seus ennychat_faturas" on ennychat_faturas;
create policy "dono ve seus ennychat_faturas" on ennychat_faturas for select to authenticated
  using (usuario_id = auth.uid());
