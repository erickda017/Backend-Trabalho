-- Rodar no SQL Editor do Supabase. Idempotente.
--
-- Hoje o disparo SEMPRE tenta anexar o PDF (se o cliente tiver um) -- não
-- tinha opção de mandar só o código Pix como texto. Essa coluna liga esse
-- modo por lote inteiro: `enviar_pix = true` faz o disparo ignorar o PDF de
-- todo mundo e mandar mensagem de texto com o Pix (ver dispatchQueue.js).

alter table envios add column if not exists enviar_pix boolean not null default false;

comment on column envios.enviar_pix is
  'true = este lote manda o código Pix como texto (nunca anexa o PDF), mesmo pra clientes que têm PDF. Elegibilidade também muda: exige pix_code em vez de pdf_path (ver resolverClienteIds em envios.routes.js).';
