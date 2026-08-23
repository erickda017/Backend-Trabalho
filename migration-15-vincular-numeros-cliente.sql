-- Rodar no SQL Editor do Supabase. Idempotente.
--
-- CONTEXTO: cada linha de `clientes` é 1 telefone (é o destino do WhatsApp),
-- mas uma mesma pessoa pode ter 2 números onde ela recebe/lê o WhatsApp. Hoje
-- isso vira 2 linhas independentes -- PDF/pix/valor/vencimento upado numa
-- fica só naquela, a outra fica "sem fatura" pra sempre.
--
-- Esta migration deixa marcar que duas (ou mais) linhas de `clientes` são,
-- na prática, A MESMA fatura/cliente, com números diferentes: uma linha vira
-- a "principal" e as outras apontam pra ela via `cliente_principal_id`. A
-- partir daí, toda vez que PDF/pix/valor/vencimento é gravado em QUALQUER uma
-- do grupo (upload manual, extrator de Pix ou importação), o backend
-- propaga o mesmo dado pra todo mundo do grupo (ver
-- src/lib/faturaPropagacao.js) -- nome e telefone continuam por linha,
-- nunca propagam.

alter table clientes
  add column if not exists cliente_principal_id uuid references clientes(id) on delete set null;

create index if not exists clientes_principal_id_idx on clientes (cliente_principal_id);

comment on column clientes.cliente_principal_id is
  'Se preenchido, esta linha é um número extra do cliente apontado aqui -- PDF/pix/valor/vencimento são sempre espelhados a partir do grupo (linha principal + todas que apontam pra ela). Nulo = linha é "principal" (ou não tem número extra vinculado).';
