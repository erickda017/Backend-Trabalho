-- Suporte a até 5 variações de mensagem por envio (lote de disparo).
--
-- Por quê: mandar sempre o EXATO mesmo texto pra vários números é um padrão
-- fácil de detectar e aumenta o risco do WhatsApp bloquear o número usado no
-- disparo. Com variações, o sistema sorteia uma das opções cadastradas pra
-- cada mensagem enviada -- pequenas diferenças de texto (mesmo mantendo o
-- mesmo sentido) já ajudam a evitar esse padrão repetitivo.
--
-- template_mensagem (coluna já existente) continua sendo a variação #1 --
-- usada em telas/relatórios que só mostram "a mensagem do lote" (histórico,
-- exportação, teste) e como fallback caso variacoes_mensagem venha vazio.
-- variacoes_mensagem guarda a lista completa (1 a 5 textos) usada de fato na
-- hora de escolher o texto de cada envio individual.
alter table envios
  add column if not exists variacoes_mensagem jsonb not null default '[]'::jsonb;

-- Backfill: lotes já existentes passam a ter 1 variação (a mensagem que já tinham).
update envios
  set variacoes_mensagem = jsonb_build_array(template_mensagem)
  where variacoes_mensagem = '[]'::jsonb or variacoes_mensagem is null;
