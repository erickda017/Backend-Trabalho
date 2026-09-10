-- Rode isso no SQL Editor do Supabase. Idempotente, pode rodar de novo com segurança.
--
-- CONTEXTO: aba nova "Ativação Chip" (ver Front-Trabalho/CONTEXTO.md) -- uma
-- segunda campanha rodando EM PARALELO à campanha de cobrança original, com
-- clientes/planilha/chat próprios. Decisão de arquitetura (ver
-- docs/superpowers/specs/2026-09-10-ativacao-chip-design.md): reaproveitar as
-- tabelas existentes com uma coluna `campanha`, em vez de tabelas paralelas
-- dedicadas -- menor mudança possível agora, sem duplicar o motor de
-- disparo/chat que já existe. Uma migração mais robusta (provável separação
-- de verdade) fica pra depois, quando o volume/uso justificar.

alter table clientes add column if not exists campanha text not null default 'cobranca';
alter table clientes add column if not exists operadora text;
alter table clientes add column if not exists os_numero text;
alter table clientes add column if not exists cpf text;
alter table clientes add column if not exists cidade text;
alter table clientes add column if not exists bko_responsavel text;
alter table clientes add column if not exists vendedor text;
-- Planilha de ativação de chip traz até 3 telefones por cliente (TEL 1/2/3).
-- `telefone` (coluna já existente) guarda o principal; estes dois são
-- fallback -- ver dispatchQueue.js, tenta em ordem até um existir no
-- WhatsApp. Só usados quando campanha = 'chip_ativacao'.
alter table clientes add column if not exists telefone_2 text;
alter table clientes add column if not exists telefone_3 text;

do $$
begin
  alter table clientes add constraint clientes_campanha_check check (campanha in ('cobranca', 'chip_ativacao'));
exception when duplicate_object then null;
end $$;

comment on column clientes.campanha is
  'Qual campanha este cliente pertence: cobranca (fatura, campanha original) ou '
  'chip_ativacao (nova, ver CONTEXTO.md). Mesmo telefone pode existir nas duas '
  'campanhas como linhas SEPARADAS -- não são a mesma linha/cliente.';

create index if not exists clientes_usuario_campanha_idx on clientes (usuario_id, campanha);

-- [CRÍTICO] O índice único de telefone precisa incluir `campanha` -- sem
-- isso, o MESMO telefone em duas campanhas diferentes colidiria como se
-- fosse a mesma linha (upsert por usuario_id+telefone da campanha nova
-- sobrescreveria/roubaria o cliente já cadastrado na campanha antiga com o
-- mesmo número, corrompendo o cadastro). Todo upsert de clientes no código
-- (importLote.js, importLoteChip.js, clientes.routes.js POST /importar-lista)
-- usa `onConflict: 'usuario_id,telefone,campanha'` a partir desta migration.
drop index if exists clientes_usuario_telefone_key;
create unique index if not exists clientes_usuario_telefone_campanha_key on clientes (usuario_id, telefone, campanha);

-- ==========================================================================
-- Conversas/mensagens: precisam saber de qual campanha são, senão o mesmo
-- telefone (quando existe nas duas campanhas) misturaria as duas conversas
-- numa só. O índice único muda de (usuario_id, telefone) pra
-- (usuario_id, telefone, campanha) -- agora é permitido ter 2 conversas pro
-- mesmo telefone, uma por campanha.
-- ==========================================================================
alter table conversas add column if not exists campanha text not null default 'cobranca';

do $$
begin
  alter table conversas add constraint conversas_campanha_check check (campanha in ('cobranca', 'chip_ativacao'));
exception when duplicate_object then null;
end $$;

drop index if exists conversas_usuario_telefone_key;
create unique index if not exists conversas_usuario_telefone_campanha_key on conversas (usuario_id, telefone, campanha);

-- ==========================================================================
-- Envios: cada lote de disparo pertence a uma campanha -- decide a regra de
-- elegibilidade (chip não exige PDF/Pix, ver envios.routes.js) e evita
-- misturar clientes das duas campanhas no mesmo lote.
-- ==========================================================================
alter table envios add column if not exists campanha text not null default 'cobranca';

do $$
begin
  alter table envios add constraint envios_campanha_check check (campanha in ('cobranca', 'chip_ativacao'));
exception when duplicate_object then null;
end $$;

-- Qual dos até 3 telefones (telefone/telefone_2/telefone_3) respondeu no
-- WhatsApp de verdade -- só preenchido pra clientes de chip (rastreabilidade,
-- ver dispatchQueue.js).
alter table envio_itens add column if not exists telefone_usado text;

-- ==========================================================================
-- Status/tratativa de chip: reaproveita a MESMA coluna/tabela que já existe
-- pra cobrança (clientes.status_operador / tabela tratativas, ver
-- migration-20-qualidade-tratativas.sql) -- só amplia a lista de valores
-- aceitos. Vocabulário de chip vive em src/lib/statusChip.js (validação em
-- código, não só no banco) -- nunca hardcodar a lista em outro lugar.
-- ==========================================================================
do $$
begin
  alter table clientes drop constraint if exists clientes_status_operador_check;
  alter table clientes add constraint clientes_status_operador_check check (
    status_operador is null or status_operador in (
      'iniciado', 'tentativa_contato', 'contato_estabelecido', 'promessa_pagamento',
      'pagamento_confirmado', 'recusa_pagamento', 'numero_invalido', 'fraude',
      'contrato_cancelado', 'renegociacao',
      -- valores de ativação de chip (ver src/lib/statusChip.js) --
      -- 'tentativa_contato'/'contato_estabelecido'/'numero_invalido' já
      -- cobertos acima, reaproveitados como estão.
      'pendente', 'chip_ativado', 'recusado'
    )
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table tratativas drop constraint if exists tratativas_status_check;
  alter table tratativas add constraint tratativas_status_check check (
    status in (
      'iniciado', 'tentativa_contato', 'contato_estabelecido', 'promessa_pagamento',
      'pagamento_confirmado', 'recusa_pagamento', 'numero_invalido', 'fraude',
      'contrato_cancelado', 'renegociacao',
      'pendente', 'chip_ativado', 'recusado'
    )
  );
exception when duplicate_object then null;
end $$;
