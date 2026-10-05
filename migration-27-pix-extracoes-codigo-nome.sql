-- [2026-10] Planilha do supervisor casa Pix por OS + nome + vencimento.
-- `codigo` = "Código" do cabeçalho da fatura (ex "010/022067040", mesma OS
-- da planilha) e `nome` = titular lido no cabeçalho. Gravados em
-- pix_extracoes mesmo sem cliente cadastrado (cliente_id null).
alter table pix_extracoes add column if not exists codigo text;
alter table pix_extracoes add column if not exists nome text;
create index if not exists pix_extracoes_codigo_idx on pix_extracoes (codigo) where codigo is not null;
