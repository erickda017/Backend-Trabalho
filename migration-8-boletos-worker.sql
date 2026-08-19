-- Rode isso no SQL Editor do Supabase (idempotente).
-- Suporte ao novo fluxo de extração de Pix via Cloudflare Worker
-- (ver backend/src/routes/boletos.routes.js e frontend/src/lib/pixWorkerClient.ts).
--
-- Antes, pix_extracoes só guardava o código Pix (pix_code). O Worker agora
-- retorna também valor, vencimento e linha digitável do boleto -- passamos a
-- persistir os três, tanto na extração (auditoria/histórico) quanto no
-- cliente vinculado (pra usar nos disparos/relatórios).

alter table pix_extracoes add column if not exists valor text;
alter table pix_extracoes add column if not exists vencimento text;
alter table pix_extracoes add column if not exists linha_digitavel text;

alter table clientes add column if not exists linha_digitavel text;
-- clientes.valor e clientes.vencimento já existem desde a importação em lote
-- (ver supabase-schema.sql) -- não precisam de migração.
