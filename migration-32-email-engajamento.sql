-- migration-32-email-engajamento.sql  [2026-11]
-- Painel da aba Disparo / E-mail: quem ABRIU e quem CLICOU (eventos opened/click do webhook da Brevo).
-- Idempotente. Depende da migration-31.
alter table email_envios add column if not exists aberturas integer not null default 0;
alter table email_envios add column if not exists primeira_abertura_em timestamptz;
alter table email_envios add column if not exists cliques integer not null default 0;
alter table email_envios add column if not exists clique_em timestamptz;
