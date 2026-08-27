-- Rode isso no SQL Editor do Supabase. Idempotente.
--
-- CONTEXTO: novo fluxo "upload de faturas avulsas, sem planilha" (ver
-- backend/src/routes/faturasPendentes.routes.js e
-- backend/src/lib/faturasPendentes.js). O operador sobe 1+ PDFs soltos
-- (arrasta e solta), sem precisar de planilha nem zip. Pra cada PDF:
--
--   1) tenta casar pelo nome do arquivo com um cliente JÁ cadastrado (mesmo
--      critério usado no resto do sistema -- ver lib/nomeMatch.js) -- achou,
--      associa na hora (mesmo comportamento de sempre: sobe o PDF, grava
--      pdf_path/pix_code/valor/vencimento no cliente).
--   2) NÃO achou: o PDF fica "pendente" nesta tabela nova, guardado no
--      Storage sob um path próprio (fora da pasta de qualquer cliente).
--      Assim que um cliente com nome correspondente for criado depois
--      (cadastro manual, "importar lista", importação em lote/planilha), a
--      associação é refeita automaticamente (ver
--      lib/faturasPendentes.js:associarPendentesAoCliente, chamada logo
--      após qualquer criação de cliente) -- é o "quando surgir um cliente
--      correspondente, realiza a associação" pedido.
--
-- Sem tabela própria seria preciso adivinhar de novo toda vez que um cliente
-- for criado se existe algum PDF solto esperando por ele -- com a tabela,
-- essa checagem é um simples SELECT por nome normalizado.

create table if not exists faturas_pendentes (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references auth.users(id) on delete cascade, -- dono -- mesmo padrão multi-tenant do resto (ver migration-13)
  arquivo text not null, -- nome original do PDF, como veio do upload
  arquivo_normalizado text not null, -- mesma normalização de lib/nomeMatch.js, pra comparar rápido contra o nome de clientes novos
  pdf_path text not null, -- path no bucket "faturas", sob pendentes/<usuario_id>/...
  pix_code text,
  valor text,
  vencimento text,
  linha_digitavel text,
  criado_em timestamptz default now()
);

create index if not exists faturas_pendentes_usuario_id_idx on faturas_pendentes (usuario_id);
create index if not exists faturas_pendentes_arquivo_normalizado_idx on faturas_pendentes (usuario_id, arquivo_normalizado);

alter table faturas_pendentes enable row level security;

drop policy if exists "dono ve suas faturas pendentes" on faturas_pendentes;
create policy "dono ve suas faturas pendentes" on faturas_pendentes for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());
-- (RLS aqui é só postura padrão do projeto -- o backend usa a service_role
-- key e ignora RLS, ver decisão equivalente documentada em CONTEXTO.md.)
