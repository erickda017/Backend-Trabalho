-- Rode isso no SQL Editor do Supabase (idempotente: pode rodar de novo com segurança)

create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references auth.users(id) on delete cascade, -- dono (operador) deste cliente -- ver migration-13
  nome text not null,
  telefone text not null,
  valor numeric,
  vencimento text,
  pdf_url text,
  pdf_path text,
  pdf_atualizado_em timestamptz, -- data do último upload do PDF -- usado pela limpeza automática (40 dias, ver migration-7)
  pix_code text, -- extraído automaticamente do QR code do PDF (ver src/lib/pixFromPdf.js)
  created_at timestamptz default now()
);

create table if not exists envios (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references auth.users(id) on delete cascade, -- dono (operador) deste envio -- ver migration-13
  template_mensagem text not null,
  status text not null default 'pendente', -- pendente | agendado | em_andamento | pausado | concluido | cancelado
  agendado_para timestamptz, -- se preenchido, o envio só começa automaticamente nesse horário
  retomar_em timestamptz, -- quando pausado por limite diário, quando deve retomar automaticamente
  created_at timestamptz default now(),
  finalizado_em timestamptz
);

create table if not exists envio_itens (
  id uuid primary key default gen_random_uuid(),
  envio_id uuid references envios(id) on delete cascade,
  cliente_id uuid references clientes(id) on delete cascade,
  status text not null default 'pendente', -- pendente | enviado | erro | numero_invalido | cancelado
  mensagem_override text, -- se preenchido, sobrescreve o template do envio para este item
  erro text,
  message_id text, -- id da mensagem no WhatsApp (Baileys), usado pra casar com o webhook de status
  status_entrega text, -- enviado | entregue | lido (atualizado via evento do Baileys)
  entregue_em timestamptz,
  lido_em timestamptz,
  enviado_em timestamptz,
  created_at timestamptz default now()
);

-- Bucket de storage para os PDFs das faturas (criar manualmente em Storage também funciona).
-- PRIVADO de propósito: os PDFs têm dados pessoais do cliente (nome, endereço,
-- CPF impresso no boleto). Leitura só via Signed URL de curta duração gerada
-- pelo backend autenticado (ver src/lib/supabase.js: gerarSignedUrl) -- nunca
-- getPublicUrl(). Se o bucket já existir como público de uma versão anterior
-- deste arquivo, rode migration-12-seguranca-buckets-privados.sql.
insert into storage.buckets (id, name, public)
values ('faturas', 'faturas', false)
on conflict (id) do update set public = false;

-- telefone único POR USUÁRIO: permite "upsert" ao reimportar planilha (atualiza
-- em vez de duplicar), mas dois usuários diferentes podem ter, cada um, um
-- cliente com o mesmo telefone (carteiras isoladas -- ver migration-13)
create unique index if not exists clientes_usuario_telefone_key on clientes (usuario_id, telefone);

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

-- Habilita RLS. Cada usuário só vê/edita seus próprios dados (policies logo
-- abaixo) -- o backend usa a service_role key e ignora RLS de qualquer forma,
-- mas as policies protegem como defesa em profundidade (um bug numa rota que
-- esqueça de filtrar por usuario_id não vaza dado de outro usuário, porque o
-- Postgres barra mesmo assim pra quem acessa com JWT de usuário comum).
alter table clientes enable row level security;
alter table envios enable row level security;
alter table envio_itens enable row level security;

drop policy if exists "dono ve seus clientes" on clientes;
create policy "dono ve seus clientes" on clientes for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

drop policy if exists "dono ve seus envios" on envios;
create policy "dono ve seus envios" on envios for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

drop policy if exists "dono ve seus envio_itens" on envio_itens;
create policy "dono ve seus envio_itens" on envio_itens for all to authenticated
  using (envio_id in (select id from envios where usuario_id = auth.uid()));

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

-- ==========================================================================
-- Tags por cliente
-- ==========================================================================
create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references auth.users(id) on delete cascade, -- dono -- ver migration-13
  nome text not null,
  cor text not null default '#6366f1',
  created_at timestamptz default now()
);
create unique index if not exists tags_usuario_nome_key on tags (usuario_id, lower(nome));

create table if not exists cliente_tags (
  cliente_id uuid not null references clientes(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (cliente_id, tag_id)
);
create index if not exists cliente_tags_tag_id_idx on cliente_tags (tag_id);

-- ==========================================================================
-- Mensagens rápidas (atalho "/algo" no Chat)
-- ==========================================================================
create table if not exists respostas_rapidas (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references auth.users(id) on delete cascade, -- dono -- ver migration-13
  atalho text not null,
  texto text not null,
  created_at timestamptz default now()
);
create unique index if not exists respostas_rapidas_usuario_atalho_key on respostas_rapidas (usuario_id, lower(atalho));

alter table tags enable row level security;
alter table cliente_tags enable row level security;
alter table respostas_rapidas enable row level security;

drop policy if exists "dono ve suas tags" on tags;
create policy "dono ve suas tags" on tags for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

drop policy if exists "dono ve suas cliente_tags" on cliente_tags;
create policy "dono ve suas cliente_tags" on cliente_tags for all to authenticated
  using (cliente_id in (select id from clientes where usuario_id = auth.uid()));

drop policy if exists "dono ve suas respostas_rapidas" on respostas_rapidas;
create policy "dono ve suas respostas_rapidas" on respostas_rapidas for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

-- Só o backend (service_role) acessa essa tabela, então RLS fica travado por padrão.
alter table whatsapp_sessions enable row level security;

-- ==========================================================================
-- Chat: histórico de conversas do WhatsApp (recebidas + enviadas pelo painel)
-- ==========================================================================

create table if not exists conversas (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references auth.users(id) on delete cascade, -- dono (operador) desta conversa -- ver migration-13
  telefone text not null, -- normalizado (dígitos + código do país)
  cliente_id uuid references clientes(id) on delete set null, -- linkado por telefone quando existe
  nome_contato text, -- nome do WhatsApp (pushName) ou do cliente, o que tiver
  nao_lidas integer not null default 0,
  ultima_mensagem text,
  ultima_mensagem_em timestamptz,
  -- true = `telefone` não é um número real, é um id opaco de "@lid" que o
  -- WhatsApp ainda não resolveu pra gente (ver migration-10 e chatIngest.js).
  -- Nunca usar nesse estado pra disparo em massa nem pra formar JID.
  numero_nao_confirmado boolean not null default false,
  created_at timestamptz default now()
);
-- telefone único POR USUÁRIO (cada operador tem seu próprio WhatsApp/carteira
-- de contatos -- ver migration-13)
create unique index if not exists conversas_usuario_telefone_key on conversas (usuario_id, telefone);

create table if not exists mensagens (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references conversas(id) on delete cascade,
  direcao text not null, -- entrada (cliente -> nós) | saida (nós -> cliente)
  tipo text not null default 'texto', -- texto | imagem | audio | documento
  texto text,
  anexo_url text, -- deprecated: não gravar URL aqui, ver comment on column abaixo
  anexo_path text, -- path no bucket chat-midia (privado) -- fonte da verdade, assinado sob demanda
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

-- Bucket de storage para mídia do chat (fotos/áudios/documentos).
-- PRIVADO de propósito -- mesma razão do bucket "faturas" acima.
insert into storage.buckets (id, name, public)
values ('chat-midia', 'chat-midia', false)
on conflict (id) do update set public = false;

-- Só o backend (service_role) escreve. Front lê/assina via Realtime autenticado.
alter table conversas enable row level security;
alter table mensagens enable row level security;

-- create policy não tem "if not exists" no Postgres, por isso o drop antes
-- (padrão idempotente, igual o resto deste arquivo)
drop policy if exists "dono ve suas conversas" on conversas;
create policy "dono ve suas conversas" on conversas for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

drop policy if exists "dono ve suas mensagens" on mensagens;
create policy "dono ve suas mensagens" on mensagens for all to authenticated
  using (conversa_id in (select id from conversas where usuario_id = auth.uid()));

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

-- ==========================================================================
-- Auditoria de exclusões (LGPD: rastreabilidade de operações sobre dados
-- pessoais). Só o backend (service_role) escreve/lê -- RLS habilitado e
-- SEM policies, então nem a anon key nem um JWT de usuário autenticado
-- conseguem acessar essa tabela.
-- ==========================================================================
create table if not exists auditoria_exclusoes (
  id uuid primary key default gen_random_uuid(),
  entidade text not null,            -- 'cliente' | 'pdf_fatura' | 'conversa' | 'boleto_pix'
  entidade_id text not null,         -- id (uuid) ou path do recurso removido
  usuario_id uuid,                   -- auth.users.id de quem executou a ação
  usuario_email text,                -- snapshot do email (sobrevive à remoção do usuário)
  detalhes jsonb,                    -- payload livre: nome do cliente, telefone, path do storage etc.
  criado_em timestamptz not null default now()
);
create index if not exists auditoria_exclusoes_entidade_idx on auditoria_exclusoes (entidade, criado_em desc);
create index if not exists auditoria_exclusoes_usuario_idx on auditoria_exclusoes (usuario_id, criado_em desc);
alter table auditoria_exclusoes enable row level security;

comment on column clientes.pdf_url is
  'Deprecated: não gravar URL aqui. A API sempre responde com uma signed URL calculada '
  'na hora (ver gerarSignedUrl em src/lib/supabase.js), usando clientes.pdf_path como fonte da verdade.';
comment on column mensagens.anexo_url is
  'Deprecated: não gravar URL aqui. A API sempre responde com uma signed URL calculada '
  'na hora, usando mensagens.anexo_path como fonte da verdade.';
