-- Rode isso no SQL Editor do Supabase. Idempotente, pode rodar de novo com segurança.
--
-- CONTEXTO: aba nova "Qualidade" (ver CONTEXTO.md) -- traz pro projeto a
-- mesma IDEIA LÓGICA que a tela de qualidade do CRM da empresa já usa (fila
-- de acompanhamento + status por cliente com auditoria), mas não copia a
-- estrutura de dados de lá (lá é multi-fatura/multi-operadora; aqui continua
-- 1 fatura ativa por cliente, mesmo modelo de sempre).
--
-- O paralelo que já existia: tag `permite_disparo: false` (ex.: "Pago",
-- "Cancelado" -- migration-14) tira o cliente da fila/disparo na hora. Esta
-- migration generaliza a MESMA regra pra um campo de STATUS, pro operador
-- poder registrar "paguei", "número inválido" etc. como desfecho de uma
-- tratativa sem precisar aplicar uma tag manualmente toda vez -- ver
-- backend/src/lib/statusOperador.js pra lista completa de status e quais
-- bloqueiam disparo.

alter table clientes add column if not exists status_operador text; -- null = nenhuma tratativa registrada ainda
alter table clientes add column if not exists status_operador_atualizado_em timestamptz;

do $$
begin
  alter table clientes add constraint clientes_status_operador_check check (
    status_operador is null or status_operador in (
      'iniciado', 'tentativa_contato', 'contato_estabelecido', 'promessa_pagamento',
      'pagamento_confirmado', 'recusa_pagamento', 'numero_invalido', 'fraude',
      'contrato_cancelado', 'renegociacao'
    )
  );
exception when duplicate_object then null;
end $$;

comment on column clientes.status_operador is
  'Desfecho da última tratativa de cobrança registrada pelo operador (ver tabela tratativas). '
  'null = ainda não tratado. Lista completa e quais valores bloqueiam disparo/fila em '
  'backend/src/lib/statusOperador.js -- nunca hardcodar a lista em outro lugar.';

create index if not exists clientes_usuario_status_operador_idx on clientes (usuario_id, status_operador);

-- ==========================================================================
-- Histórico de tratativas -- 1 linha por vez que o operador registra um
-- status+observação pra um cliente (auditoria; `clientes.status_operador`
-- guarda só o desfecho ATUAL, esta tabela guarda a linha do tempo inteira).
-- ==========================================================================
create table if not exists tratativas (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references auth.users(id) on delete cascade, -- dono -- mesmo padrão multi-tenant do resto (ver migration-13)
  cliente_id uuid references clientes(id) on delete cascade,
  status text not null,
  observacao text,
  criado_em timestamptz not null default now()
);

do $$
begin
  alter table tratativas add constraint tratativas_status_check check (
    status in (
      'iniciado', 'tentativa_contato', 'contato_estabelecido', 'promessa_pagamento',
      'pagamento_confirmado', 'recusa_pagamento', 'numero_invalido', 'fraude',
      'contrato_cancelado', 'renegociacao'
    )
  );
exception when duplicate_object then null;
end $$;

create index if not exists tratativas_cliente_criado_idx on tratativas (cliente_id, criado_em desc);
create index if not exists tratativas_usuario_criado_idx on tratativas (usuario_id, criado_em desc);

alter table tratativas enable row level security;
-- Só o backend (service_role) lê/escreve -- mesmo padrão do resto do banco
-- (ver comentário em migration-16-supervisor.sql).
