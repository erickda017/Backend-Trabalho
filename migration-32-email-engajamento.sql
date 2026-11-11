-- migration-32-email-engajamento.sql  [2026-11]
-- Painel da aba Disparo / E-mail: quem ABRIU e quem CLICOU (eventos opened/click do webhook da Brevo).
-- Idempotente. Depende da migration-31.
alter table email_envios add column if not exists aberturas integer not null default 0;
alter table email_envios add column if not exists primeira_abertura_em timestamptz;
alter table email_envios add column if not exists cliques integer not null default 0;
alter table email_envios add column if not exists clique_em timestamptz;

-- Índices das consultas novas (idempotentes; tabelas pequenas, criação instantânea).
-- Busca da fatura do EnnyChat por OS no sync:
create index if not exists clientes_usuario_os_numero_idx on clientes (usuario_id, os_numero) where os_numero is not null;
-- Painel "Resumo dos envios" (por operador, últimos N dias):
create index if not exists email_envios_usuario_aceito_idx on email_envios (usuario_id, aceito_em desc) where aceito_em is not null;
-- Histórico da fatura (worker e lista) e reconciliação por destinatário:
create index if not exists email_envios_fatura_idx on email_envios (fatura_externa_id) where fatura_externa_id is not null;
create index if not exists email_envios_email_idx on email_envios (email) where message_id is not null;
