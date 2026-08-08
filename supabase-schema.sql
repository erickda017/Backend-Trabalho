-- Rode isso no SQL Editor do Supabase (idempotente: pode rodar de novo com segurança)

create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text not null,
  valor numeric,
  vencimento text,
  pdf_url text,
  pdf_path text,
  created_at timestamptz default now()
);

create table if not exists envios (
  id uuid primary key default gen_random_uuid(),
  template_mensagem text not null,
  status text not null default 'pendente', -- pendente | agendado | em_andamento | pausado | concluido
  agendado_para timestamptz, -- se preenchido, o envio só começa automaticamente nesse horário
  retomar_em timestamptz, -- quando pausado por limite diário, quando deve retomar automaticamente
  created_at timestamptz default now(),
  finalizado_em timestamptz
);

create table if not exists envio_itens (
  id uuid primary key default gen_random_uuid(),
  envio_id uuid references envios(id) on delete cascade,
  cliente_id uuid references clientes(id) on delete cascade,
  status text not null default 'pendente', -- pendente | enviado | erro | numero_invalido
  mensagem_override text, -- se preenchido, sobrescreve o template do envio para este item
  erro text,
  message_id text, -- id da mensagem no WhatsApp (Baileys), usado pra casar com o webhook de status
  status_entrega text, -- enviado | entregue | lido (atualizado via evento do Baileys)
  entregue_em timestamptz,
  lido_em timestamptz,
  enviado_em timestamptz,
  created_at timestamptz default now()
);

-- Bucket de storage para os PDFs das faturas (criar manualmente em Storage também funciona)
insert into storage.buckets (id, name, public)
values ('faturas', 'faturas', true)
on conflict (id) do nothing;

-- telefone único: permite "upsert" ao reimportar planilha (atualiza em vez de duplicar)
create unique index if not exists clientes_telefone_key on clientes (telefone);

-- índices para acelerar consultas de histórico e limite diário
create index if not exists envio_itens_cliente_id_idx on envio_itens (cliente_id);
create index if not exists envio_itens_enviado_em_idx on envio_itens (enviado_em);
create index if not exists envios_agendado_para_idx on envios (agendado_para) where status = 'agendado';

-- índices adicionais: aceleram os filtros mais frequentes do dispatchQueue/scheduler
-- (buscar itens 'pendente'/'erro' de um envio, e envios 'pausado' aguardando retomar_em)
create index if not exists envio_itens_envio_id_status_idx on envio_itens (envio_id, status);
create index if not exists envios_pausado_retomar_em_idx on envios (retomar_em) where status = 'pausado';

-- Se você já tinha clientes cadastrados ANTES da normalização de telefone (commit que
-- adicionou backend/src/lib/telefone.js), rode isto uma vez pra alinhar os registros
-- antigos ao novo formato (dígitos + código do país, ex: 5511999999999). Sem isso, um
-- cliente antigo salvo como "(11) 99999-9999" não vai bater com o número validado no
-- WhatsApp nem com uma reimportação da planilha no formato novo.
-- ⚠️ Rode o SELECT abaixo antes pra checar se não gera telefone duplicado (dois clientes
-- diferentes cujo telefone normalizado colide) -- se gerar, resolva manualmente antes do UPDATE.
--
-- select telefone, count(*) from (
--   select case when length(regexp_replace(telefone, '\D', '', 'g')) <= 11
--          then '55' || regexp_replace(telefone, '\D', '', 'g')
--          else regexp_replace(telefone, '\D', '', 'g') end as telefone
--   from clientes
-- ) t group by telefone having count(*) > 1;
--
-- update clientes set telefone = (
--   case when length(regexp_replace(telefone, '\D', '', 'g')) <= 11
--        then '55' || regexp_replace(telefone, '\D', '', 'g')
--        else regexp_replace(telefone, '\D', '', 'g') end
-- );

-- Habilita RLS (recomendado já que agora existe login). Como o backend usa a
-- service_role key, ele ignora RLS -- essas políticas só protegem se alguém
-- tentar acessar o banco direto com a chave anônima/pública.
alter table clientes enable row level security;
alter table envios enable row level security;
alter table envio_itens enable row level security;

-- Sessão do WhatsApp (Baileys), no lugar do antigo diretório em disco
-- (WHATSAPP_SESSION_PATH). Cada linha guarda uma "chave" da sessão -- creds e
-- as chaves de criptografia (session, sender-key, app-state-sync-key, etc) --
-- serializadas com o BufferJSON do Baileys. Veja src/lib/supabaseAuthState.js.
create table if not exists whatsapp_sessions (
  session_id text not null,
  key text not null,
  data jsonb not null,
  updated_at timestamptz default now(),
  primary key (session_id, key)
);

-- Só o backend (service_role) acessa essa tabela, então RLS fica travado por padrão.
alter table whatsapp_sessions enable row level security;

-- ==========================================================================
-- Chat: histórico de conversas do WhatsApp (recebidas + enviadas pelo painel)
-- ==========================================================================

create table if not exists conversas (
  id uuid primary key default gen_random_uuid(),
  telefone text not null unique, -- normalizado (dígitos + código do país)
  cliente_id uuid references clientes(id) on delete set null, -- linkado por telefone quando existe
  nome_contato text, -- nome do WhatsApp (pushName) ou do cliente, o que tiver
  nao_lidas integer not null default 0,
  ultima_mensagem text,
  ultima_mensagem_em timestamptz,
  created_at timestamptz default now()
);

create table if not exists mensagens (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references conversas(id) on delete cascade,
  direcao text not null, -- entrada (cliente -> nós) | saida (nós -> cliente)
  tipo text not null default 'texto', -- texto | imagem | audio | documento
  texto text,
  anexo_url text,
  anexo_nome text,
  message_id text, -- id da mensagem no WhatsApp (Baileys) -- casa com o webhook de status de entrega
  status_entrega text, -- enviado | entregue | lido
  created_at timestamptz default now()
);

-- Necessário pro .upsert(..., { onConflict: 'message_id' }) em chatIngest.js funcionar --
-- sem um índice único de verdade nessa coluna, o Postgres recusa o ON CONFLICT com
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification".
-- NÃO usar índice parcial (where message_id is not null) aqui: Postgres não aceita
-- índice único parcial como alvo de um ON CONFLICT (message_id) simples -- precisaria
-- repetir a mesma cláusula WHERE no próprio ON CONFLICT, e o .upsert() do
-- supabase-js não manda isso. Índice único comum resolve igual: NULL já é tratado
-- como valor distinto entre si, então várias linhas com message_id nulo continuam OK.
create unique index if not exists mensagens_message_id_key on mensagens (message_id);

create index if not exists mensagens_conversa_id_idx on mensagens (conversa_id, created_at);
create index if not exists conversas_ultima_mensagem_em_idx on conversas (ultima_mensagem_em desc);

-- Evita duplicar a mesma mensagem do WhatsApp: a msg enviada pelo painel é gravada na
-- hora (com o message_id que o Baileys devolveu) e, quando o evento messages.upsert
-- ecoa essa mesma mensagem de volta (fromMe: true), o upsert por message_id ignora.
create unique index if not exists mensagens_message_id_key on mensagens (message_id) where message_id is not null;

-- Bucket de storage para mídia do chat (fotos/áudios/documentos)
insert into storage.buckets (id, name, public)
values ('chat-midia', 'chat-midia', true)
on conflict (id) do nothing;

-- Só o backend (service_role) escreve. Front lê/assina via Realtime autenticado.
alter table conversas enable row level security;
alter table mensagens enable row level security;

-- create policy não tem "if not exists" no Postgres, por isso o drop antes
-- (padrão idempotente, igual o resto deste arquivo)
drop policy if exists "usuarios autenticados leem conversas" on conversas;
create policy "usuarios autenticados leem conversas"
  on conversas for select
  to authenticated
  using (true);

drop policy if exists "usuarios autenticados leem mensagens" on mensagens;
create policy "usuarios autenticados leem mensagens"
  on mensagens for select
  to authenticated
  using (true);

-- Habilita Realtime (INSERT/UPDATE) nessas duas tabelas -- é isso que o front escuta
-- via supabase.channel(...).on('postgres_changes', ...) pra atualizar sem F5.
-- (envolvido em DO/exception pra poder rodar de novo com segurança, já que
-- "alter publication ... add table" dá erro se a tabela já foi adicionada)
do $$
begin
  alter publication supabase_realtime add table conversas;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table mensagens;
exception when duplicate_object then null;
end $$;
