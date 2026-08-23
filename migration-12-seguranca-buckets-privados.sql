-- ============================================================================
-- MIGRATION DE SEGURANÇA (2026-08) -- rodar no SQL Editor do Supabase.
-- Idempotente: pode rodar de novo com segurança.
--
-- Contexto: os buckets "faturas" e "chat-midia" guardam documentos com dados
-- pessoais de cliente (nome, telefone, endereço/CPF impresso no PDF da
-- fatura, fotos/áudios do chat) e foram criados com `public: true`. Isso
-- deixava qualquer PDF/mídia acessível por link direto, pra sempre, sem
-- nenhuma autenticação -- bastava alguém obter a URL (log, print, referrer,
-- link encaminhado). Esta migration torna os dois buckets PRIVADOS. A partir
-- de agora, toda leitura passa por Signed URL de curta duração gerada pelo
-- backend autenticado (ver src/lib/supabase.js: gerarSignedUrl).
-- ============================================================================

-- 1) Buckets privados -------------------------------------------------------
update storage.buckets set public = false where id in ('faturas', 'chat-midia');

-- 2) Remove qualquer policy antiga de leitura pública nesses buckets, se
--    existir (bucket public=true normalmente não depende de policy pra
--    leitura, mas alguns setups adicionam uma explícita "anyone can read").
--    service_role sempre ignora RLS/policies de Storage, então o backend
--    continua funcionando normalmente depois disso.
drop policy if exists "faturas leitura publica" on storage.objects;
drop policy if exists "chat-midia leitura publica" on storage.objects;
drop policy if exists "Public read faturas" on storage.objects;
drop policy if exists "Public read chat-midia" on storage.objects;

-- 3) Tabela de auditoria -----------------------------------------------------
-- Registra quem apagou o quê (cliente, PDF, conversa) -- exigido pra
-- rastreabilidade de operações sobre dados pessoais (LGPD). Só o backend
-- (service_role) escreve aqui; RLS fecha tudo pra anon/authenticated.
create table if not exists auditoria_exclusoes (
  id uuid primary key default gen_random_uuid(),
  entidade text not null,            -- 'cliente' | 'pdf_fatura' | 'conversa' | 'boleto_pix'
  entidade_id text not null,         -- id (uuid) ou path do recurso removido
  usuario_id uuid,                   -- auth.users.id de quem executou a ação (req.user.id)
  usuario_email text,                -- snapshot do email no momento (útil se o usuário for removido depois)
  detalhes jsonb,                    -- payload livre: nome do cliente, telefone, path do storage etc.
  criado_em timestamptz not null default now()
);
create index if not exists auditoria_exclusoes_entidade_idx on auditoria_exclusoes (entidade, criado_em desc);
create index if not exists auditoria_exclusoes_usuario_idx on auditoria_exclusoes (usuario_id, criado_em desc);

alter table auditoria_exclusoes enable row level security;
-- Nenhuma policy criada de propósito: com RLS habilitado e zero policies,
-- ninguém além do service_role (que ignora RLS) consegue ler/escrever aqui,
-- nem com a anon key nem com um JWT de usuário autenticado.

-- 4) pdf_url / anexo_url deixam de ser persistidos como URL permanente -----
-- Essas colunas continuam existindo (o front ainda lê o campo "pdf_url" na
-- resposta da API), mas agora são preenchidas SOB DEMANDA pelo backend a
-- cada resposta (signed URL, expira sozinha) -- nunca mais gravadas no
-- banco. Os valores antigos gravados como URL pública permanente (formato
-- ".../object/public/...") não servem mais pra nada (o bucket virou
-- privado, essas URLs já não abrem) -- limpamos pra não confundir quem for
-- inspecionar o banco direto.
update clientes
set pdf_url = null
where pdf_url like '%/storage/v1/object/public/%';

update mensagens
set anexo_url = null
where anexo_url like '%/storage/v1/object/public/%';

comment on column clientes.pdf_url is
  'NÃO gravar mais URL aqui -- deprecated, mantido só por compatibilidade de schema. '
  'A API sempre responde com uma signed URL calculada na hora (ver gerarSignedUrl em src/lib/supabase.js), '
  'usando clientes.pdf_path como fonte da verdade.';

comment on column mensagens.anexo_url is
  'NÃO gravar mais URL aqui -- deprecated, mantido só por compatibilidade de schema. '
  'A API sempre responde com uma signed URL calculada na hora, usando mensagens.anexo_path.';

-- 5) anexo_path na tabela mensagens -----------------------------------------
-- Só existia anexo_url (a URL pública já pronta). Precisamos do path puro
-- pra poder assinar sob demanda -- mesma lógica que clientes.pdf_path já
-- resolvia pro fluxo de faturas.
alter table mensagens add column if not exists anexo_path text;
