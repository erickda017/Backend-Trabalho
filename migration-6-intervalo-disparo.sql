-- Rode isso no SQL Editor do Supabase (idempotente).
-- "Intervalo de disparo": permite definir uma duração total (ex: 5 horas) pra
-- espalhar as mensagens de um lote igualmente dentro dela, em vez do
-- delay aleatório/fixo padrão -- reduz o risco de o WhatsApp bloquear a
-- sessão por volume alto num período curto.

alter table envios add column if not exists janela_ms bigint; -- duração total do disparo em ms (null = sem restrição, comportamento padrão)
