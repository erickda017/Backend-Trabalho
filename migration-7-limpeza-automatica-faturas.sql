-- Suporte à limpeza automática de faturas/boletos antigos (a cada 40 dias),
-- ver backend/src/services/limpezaAutomatica.js. Idempotente, pode rodar de novo.

-- Data em que o PDF do cliente foi anexado/atualizado pela última vez (upload
-- manual na aba Clientes, ou importação em massa). Sem essa coluna não dá pra
-- saber quais PDFs já passaram dos 40 dias -- os updates que gravam
-- pdf_url/pdf_path (clientes.routes.js e importLote.js) também gravam essa
-- coluna agora.
alter table clientes add column if not exists pdf_atualizado_em timestamptz;

-- Clientes que já tinham PDF antes dessa migration não têm essa data -- assume
-- "agora" pra eles (não deleta retroativamente nada por uma migração; o
-- relógio dos 40 dias só começa a contar a partir daqui pra esses casos).
update clientes set pdf_atualizado_em = now() where pdf_path is not null and pdf_atualizado_em is null;

create index if not exists clientes_pdf_atualizado_em_idx on clientes (pdf_atualizado_em) where pdf_path is not null;
create index if not exists pix_extracoes_criado_em_idx on pix_extracoes (criado_em);
