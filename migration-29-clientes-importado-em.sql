-- [2026-10] Data de IMPORTAÇÃO do cliente (quando entrou/foi reimportado numa
-- lista), separada de `created_at` (quando a linha nasceu). A importação é um
-- upsert por telefone: reimportar um cliente que já existia NÃO muda
-- `created_at`, então o filtro por data da tela Clientes nunca achava quem foi
-- reimportado hoje. `importado_em` é atualizado a cada importação.
-- Idempotente -- pode rodar de novo com segurança.
alter table clientes add column if not exists importado_em timestamptz;
update clientes set importado_em = created_at where importado_em is null;
alter table clientes alter column importado_em set default now();
create index if not exists clientes_usuario_importado_em_idx on clientes (usuario_id, importado_em desc);
