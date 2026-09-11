-- [2026-09] Disparo com FOTO anexada -- nível do LOTE (envios), não do
-- cliente. Essencial pra Ativação Chip: cliente dessa campanha nunca tem
-- fatura/PDF (o conceito nem existe ali), mas o operador quer poder mandar
-- uma imagem (print de instrução, propaganda, comprovante-modelo etc) junto
-- da mensagem de texto pra TODOS os itens do lote de uma vez. Diferente do
-- PDF (por cliente, em clientes.pdf_path), aqui é UMA foto só, escolhida na
-- hora de montar o lote (ver POST /envios/anexo-foto), gravada no envio, e
-- reusada em cada mensagem que o disparo manda (ver dispatchQueue.js).
alter table envios add column if not exists foto_path text;
alter table envios add column if not exists foto_mimetype text;
alter table envios add column if not exists foto_nome text;
