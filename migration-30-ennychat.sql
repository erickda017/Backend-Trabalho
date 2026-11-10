-- migration-30-ennychat.sql  [2026-11]
-- Integração EnnyChat (recebimento): rodar no SQL Editor do Supabase.
-- Idempotente -- pode rodar de novo com segurança.
--
-- O que cria:
--   1) clientes: email, ennychat_fatura_id, contatos_alternativos, ennychat_status(+_em)
--      e índice único PARCIAL (usuario_id, ennychat_fatura_id).
--   2) ennychat_anexos: um PDF recebido da extensão (idempotência por anexo e por sha256).
--   3) ennychat_config: configuração global (status aceitos + catálogo de status).
--
-- NÃO mexe em `safra` (coluna GERADA a partir de data_prazo -- nunca gravar) nem
-- cria coluna gerada nova. `clientes.status_operador` também fica de fora: tem
-- CHECK com a lista de status do site, e o código do EnnyChat é texto livre --
-- por isso a coluna própria `ennychat_status`.

-- ---------- 1) clientes ----------
alter table clientes add column if not exists email text;
-- ID externo da fatura no EnnyChat. Texto (nunca número: não perder zeros).
alter table clientes add column if not exists ennychat_fatura_id text;
-- Outros telefones/e-mails vindos do EnnyChat: {"telefones": [...], "emails": [...]}.
-- Só guarda. NUNCA é destinatário de disparo automaticamente.
alter table clientes add column if not exists contatos_alternativos jsonb;
-- Último status_operador do EnnyChat visto pela integração (código exato) e quando.
-- Elegibilidade de disparo = esse código estar em ennychat_config.status_aceitos.
alter table clientes add column if not exists ennychat_status text;
alter table clientes add column if not exists ennychat_status_em timestamptz;

create unique index if not exists clientes_usuario_ennychat_fatura_key
  on clientes (usuario_id, ennychat_fatura_id)
  where ennychat_fatura_id is not null;

comment on column clientes.ennychat_fatura_id is
  'ID da fatura no EnnyChat (texto). Único por usuario_id. Ver src/routes/ennychat.routes.js.';
comment on column clientes.ennychat_status is
  'Último data.status_operador do EnnyChat (código exato). Texto livre -- por isso não usa status_operador (tem CHECK).';

-- ---------- 2) ennychat_anexos ----------
create table if not exists ennychat_anexos (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  fatura_externa_id text not null,
  anexo_id text not null,
  sha256 text not null,
  estado text not null check (estado in ('processando', 'vinculado', 'pendente_revisao')),
  motivo text,
  verificacoes jsonb,          -- {os, nome, vencimento, pix} (booleans) da última avaliação
  pdf_path text,               -- só preenchido quando vinculado (PDF pendente NÃO é guardado)
  cliente_id uuid references clientes(id) on delete cascade,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Idempotência (contrato): mesmo anexo da mesma fatura, e mesmo conteúdo NA MESMA fatura
-- (o mesmo PDF em outra fatura é avaliado de novo contra o cadastro dela).
create unique index if not exists ennychat_anexos_usuario_fatura_anexo_key
  on ennychat_anexos (usuario_id, fatura_externa_id, anexo_id);
create unique index if not exists ennychat_anexos_usuario_fatura_sha256_key
  on ennychat_anexos (usuario_id, fatura_externa_id, sha256);
create index if not exists ennychat_anexos_usuario_fatura_atualizado_idx
  on ennychat_anexos (usuario_id, fatura_externa_id, atualizado_em desc);

alter table ennychat_anexos enable row level security;
drop policy if exists "dono ve seus ennychat_anexos" on ennychat_anexos;
create policy "dono ve seus ennychat_anexos" on ennychat_anexos for select to authenticated
  using (usuario_id = auth.uid());

-- ---------- 3) ennychat_config ----------
-- Global (uma linha por chave), igual ao contrato:
--   'status_aceitos' -> ["codigo", ...]             (lista de permissão; vazia = nada entra)
--   'catalogo'       -> [{"codigo": "...", "rotulo": "..."}]
create table if not exists ennychat_config (
  chave text primary key,
  valor jsonb not null,
  atualizado_em timestamptz not null default now()
);

alter table ennychat_config enable row level security;
drop policy if exists "autenticado le ennychat_config" on ennychat_config;
create policy "autenticado le ennychat_config" on ennychat_config for select to authenticated
  using (true);

-- Escrita só pelo backend (service_role ignora RLS e GRANT): mesma regra da migration-28.
do $$
declare t text;
begin
  foreach t in array array['ennychat_anexos', 'ennychat_config'] loop
    execute format('revoke all on table %I from anon', t);
    execute format('revoke insert, update, delete, truncate on table %I from authenticated', t);
  end loop;
end $$;
