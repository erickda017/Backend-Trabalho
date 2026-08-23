-- Rodar no SQL Editor do Supabase. Idempotente.
--
-- CONTEXTO: hoje "entrar num lote de disparo" não tem nenhuma regra além de
-- escolher cliente_ids/tag_ids na hora de montar o lote -- um cliente sem
-- PDF ainda entra (some pra mensagem de texto puro), e não existe forma de
-- marcar "esse cliente já pagou/cancelou, não manda mais nada pra ele".
--
-- Esta migration resolve os dois casos pedidos:
--
--   1) TAG COM EFEITO NO DISPARO -- ao criar uma tag, dá pra marcar
--      `permite_disparo = false` (ex.: tags "Pago", "Cancelado"). Um cliente
--      com QUALQUER tag `permite_disparo = false`:
--        a) não entra em nenhum lote NOVO (filtrado na hora de montar);
--        b) sai IMEDIATAMENTE de qualquer lote em andamento/pendente onde já
--           estava (os itens `pendente` dele viram `cancelado` no momento em
--           que a tag é aplicada -- ver rota POST /tags/:id/clientes/:id).
--      Tags sem essa marcação (a maioria) continuam sem nenhum efeito no
--      disparo, como sempre foi.
--
--   2) CLIENTE SEM PDF NÃO ENTRA EM LOTE -- `resolverClienteIds` (montagem
--      do lote, em envios.routes.js) passa a exigir `pdf_path is not null`.
--      Não precisa de coluna nova pra isso: assim que o PDF é vinculado ao
--      cliente (manual, extrator de Pix ou importação -- os três caminhos já
--      gravam `pdf_path` no mesmo update), o cliente já fica automaticamente
--      elegível pro PRÓXIMO lote que for montado. Não existe "fila de
--      pendentes" separada pra alimentar -- a elegibilidade é sempre
--      recalculada na hora de montar o lote.

alter table tags add column if not exists permite_disparo boolean not null default true;

comment on column tags.permite_disparo is
  'false = clientes com esta tag não entram em novos lotes de disparo e são removidos (itens pendentes cancelados) de lotes onde já estavam, assim que a tag é aplicada. Ex.: tags "Pago"/"Cancelado".';
