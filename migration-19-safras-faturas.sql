-- Rode isso no SQL Editor do Supabase. Idempotente, pode rodar de novo com segurança.
--
-- CONTEXTO: acompanhamento por SAFRA (ver CONTEXTO.md, seção "[2026-08] Safras
-- (FPD/SPD) e histórico consolidado"). Cada cliente importado a partir da
-- lista crua (backend/src/lib/parseListaClientes.js, POST /clientes/importar-
-- lista) passa a carregar em qual fatura do ciclo de cobrança ele está
-- (FPD = primeira fatura, SPD = segunda fatura) e a data de PRAZO daquela
-- fatura -- é a partir dessa data que a "safra" (mês/ano) é derivada.
--
-- Por que uma coluna GERADA para `safra` (em vez de gravar o texto direto):
-- a regra de negócio é simples e fixa ("mês/ano da data de prazo") -- deixar
-- o Postgres calcular garante que safra e data_prazo NUNCA ficam
-- inconsistentes entre si (ex.: um UPDATE que muda data_prazo mas esquece de
-- também mudar safra), sem precisar de trigger.

alter table clientes add column if not exists tipo_fatura text; -- 'FPD' (primeira fatura) | 'SPD' (segunda fatura) | null (não veio de uma lista crua com essa info)
alter table clientes add column if not exists data_prazo date; -- data de vencimento/PRAZO da fatura atual, como DATE de verdade (a coluna `vencimento` já existente continua text e livre, usada pra exibição/mensagem -- ver comment on column mais abaixo)
alter table clientes add column if not exists numero_contrato text; -- número do contrato, quando a lista crua trouxer (posição logo após o nome -- ver parseListaClientes.js). Não é a "data de contrato": nos exemplos reais essa linha é sempre um número identificador, nunca uma data.
alter table clientes add column if not exists data_contrato date; -- data de contrato, quando a origem trouxer uma data distinta da data de prazo. Fica null na imensa maioria dos casos hoje (o formato de lista crua atual não traz essa data separadamente) -- reservada para quando/​se aparecer numa variação futura do relatório de cobrança, sem precisar de outra migration.

do $$
begin
  alter table clientes add constraint clientes_tipo_fatura_check check (tipo_fatura is null or tipo_fatura in ('FPD', 'SPD'));
exception when duplicate_object then null;
end $$;

-- Coluna gerada: "2026-09" a partir de data_prazo (formato YYYY-MM, ordenável
-- e fácil de agrupar/filtrar). Null enquanto data_prazo não estiver
-- preenchida (clientes cadastrados manualmente ou por planilha sem essa
-- informação continuam funcionando normalmente, só ficam fora de qualquer
-- safra).
-- to_char(date, ...) não é aceito pelo Postgres como IMMUTABLE em coluna
-- gerada (ERROR 42P17), mesmo com "date" puro -- o planner não diferencia
-- o overload IMMUTABLE (date) do overload STABLE (timestamptz) nesse
-- contexto. Solução: montar "YYYY-MM" só com funções realmente IMMUTABLE
-- (extract + lpad), sem trocar o resultado final.
alter table clientes add column if not exists safra text generated always as (
  extract(year from data_prazo)::text || '-' || lpad(extract(month from data_prazo)::text, 2, '0')
) stored;

create index if not exists clientes_usuario_safra_idx on clientes (usuario_id, safra) where safra is not null;
create index if not exists clientes_usuario_tipo_fatura_idx on clientes (usuario_id, tipo_fatura) where tipo_fatura is not null;

comment on column clientes.vencimento is
  'Texto livre de exibição (usado na variável {{vencimento}} da mensagem e em telas legadas) -- '
  'pode vir em qualquer formato, de qualquer origem (planilha, upload avulso, PIX). '
  'Para cálculo de safra/agrupamento por mês, usar sempre data_prazo (DATE de verdade), não este campo.';
comment on column clientes.safra is
  'Gerada automaticamente a partir de data_prazo (extract(year/month) formatado ''YYYY-MM'') -- nunca gravar direto, '
  'nunca fica dessincronizada de data_prazo. Representa o mês/ano de vencimento da fatura em '
  'acompanhamento, não o mês em que o cliente foi importado (ver CONTEXTO.md para a regra de negócio completa).';

-- ==========================================================================
-- Histórico consolidado de safras -- sobrevive mesmo depois que os dados
-- operacionais de uma safra específica não existirem mais (hoje o único dado
-- realmente apagado automaticamente são PDFs/boletos, ver
-- limpezaAutomatica.js; esta tabela é o registro permanente das MÉTRICAS,
-- desacoplado de qualquer exclusão futura de linhas de `clientes`).
-- ==========================================================================
create table if not exists safras_historico (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references auth.users(id) on delete cascade, -- dono -- mesmo padrão multi-tenant do resto (ver migration-13)
  safra text not null, -- 'YYYY-MM', mesmo formato/valor da coluna gerada clientes.safra
  total_clientes integer not null default 0,
  total_fpd integer not null default 0,
  total_spd integer not null default 0,
  pagos integer not null default 0, -- clientes com a tag "Pago" (ver POST /clientes/importar-pagos)
  nao_pagos integer not null default 0,
  receberam_disparo integer not null default 0, -- >=1 envio_itens com status='enviado'
  nao_receberam_disparo integer not null default 0,
  valor_total numeric,
  valor_medio numeric,
  duplicidades_detectadas integer not null default 0, -- clientes com nome muito parecido dentro da mesma safra (ver lib/safras.js)
  consolidado_em timestamptz not null default now(),
  criado_em timestamptz not null default now()
);

-- upsert por (usuario_id, safra): reconsolidar a mesma safra (ex.: rodou de
-- novo antes do fechamento definitivo) atualiza o registro em vez de duplicar.
create unique index if not exists safras_historico_usuario_safra_key on safras_historico (usuario_id, safra);

alter table safras_historico enable row level security;

drop policy if exists "dono ve seu historico de safras" on safras_historico;
create policy "dono ve seu historico de safras" on safras_historico for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());
