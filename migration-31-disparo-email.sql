-- migration-31-disparo-email.sql  [2026-11]
-- Aba "Disparo / E-mail" (envio da fatura em PDF por e-mail via Brevo). Rodar no SQL Editor do Supabase.
-- Idempotente -- pode rodar de novo com segurança. Depende da migration-30 (clientes.email, ennychat_*).
--
-- Cria:
--   email_lotes   um clique em "Disparar" = um lote (nome da empresa fixado no momento da criação).
--   email_envios  uma linha por fatura/destinatário do lote (estado, messageId da Brevo, tentativas técnicas).
-- A configuração "Nome da empresa" fica em ennychat_config (chave 'email_nome_empresa'), sem tabela nova.

create table if not exists email_lotes (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'em_andamento' check (status in ('em_andamento', 'concluido', 'cancelado')),
  total integer not null check (total >= 0),
  nome_empresa text not null,           -- fixado na criação: edição posterior não muda e-mails em andamento
  reenvio boolean not null default false, -- reenvio intencional (contado à parte)
  criado_em timestamptz not null default now(),
  concluido_em timestamptz
);

create table if not exists email_envios (
  id uuid primary key default gen_random_uuid(),
  lote_id uuid not null references email_lotes(id) on delete cascade,
  usuario_id uuid not null references auth.users(id) on delete cascade,
  cliente_id uuid references clientes(id) on delete set null,
  fatura_externa_id text,
  email text not null,
  status text not null default 'na_fila'
    check (status in ('na_fila', 'processando', 'aceito', 'entregue', 'devolvido', 'falhou', 'cancelado')),
  motivo text,                          -- por que falhou/foi cancelado (código curto, sem dado pessoal)
  tentativas integer not null default 0, -- tentativas TÉCNICAS (diferente de "vezes aceita para envio")
  message_id text,                      -- messageId devolvido pela Brevo (liga os eventos do webhook)
  aceito_em timestamptz,
  evento_em timestamptz,                -- instante do último evento do provedor aplicado (ordena eventos fora de ordem)
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Uma fatura nunca entra duas vezes no mesmo lote.
create unique index if not exists email_envios_lote_cliente_key on email_envios (lote_id, cliente_id);
-- Duplo clique / dois operadores: no máximo UM envio ativo por cliente em qualquer lote.
create unique index if not exists email_envios_cliente_ativo_key on email_envios (cliente_id)
  where status in ('na_fila', 'processando');
-- ... e por FATURA do EnnyChat (sobrevive a apagar/reimportar o cliente).
create unique index if not exists email_envios_fatura_ativa_key on email_envios (fatura_externa_id)
  where fatura_externa_id is not null and status in ('na_fila', 'processando');
create index if not exists email_envios_message_id_idx on email_envios (message_id) where message_id is not null;
create index if not exists email_envios_aceito_em_idx on email_envios (aceito_em) where aceito_em is not null;
create index if not exists email_envios_lote_idx on email_envios (lote_id, status);
create index if not exists email_lotes_usuario_idx on email_lotes (usuario_id, criado_em desc);

-- RLS: dono lê o que é seu; escrita só pelo backend (service_role), mesma regra da migration-28/30.
alter table email_lotes enable row level security;
alter table email_envios enable row level security;
drop policy if exists "dono ve seus email_lotes" on email_lotes;
create policy "dono ve seus email_lotes" on email_lotes for select to authenticated using (usuario_id = auth.uid());
drop policy if exists "dono ve seus email_envios" on email_envios;
create policy "dono ve seus email_envios" on email_envios for select to authenticated using (usuario_id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array['email_lotes', 'email_envios'] loop
    execute format('revoke all on table %I from anon', t);
    execute format('revoke insert, update, delete, truncate on table %I from authenticated', t);
  end loop;
end $$;
