-- ============================================================================
-- MIGRATION MULTI-TENANT (2026-08) -- rodar no SQL Editor do Supabase, DEPOIS
-- da migration-12-seguranca-buckets-privados.sql. Idempotente.
--
-- Contexto: o sistema era single-tenant (uma operação, vários operadores
-- humanos vendo os mesmos clientes e usando o mesmo WhatsApp). Agora cada
-- usuário autenticado (auth.users) tem: seus próprios clientes, seu próprio
-- WhatsApp, suas próprias conversas/histórico, suas próprias tags/respostas
-- rápidas, seus próprios envios em massa. Nada é mais compartilhado entre
-- usuários -- inclusive porque um cliente com o MESMO telefone pode existir
-- pra dois usuários diferentes (dois operadores atendendo pessoas diferentes
-- que por acaso têm o mesmo número salvo errado, por ex.), e as sessões de
-- WhatsApp precisam ser totalmente isoladas.
--
-- IMPORTANTE: esta migration NÃO decide sozinha quem é o "dono" dos dados que
-- já existem no banco (registros antigos, de antes do multi-tenant). Ela cria
-- as colunas e deixa `usuario_id` nulo nos registros antigos -- é preciso
-- rodar manualmente um UPDATE atribuindo esses registros a um usuário real
-- antes de ativar as policies de RLS que exigem dono (ver passo 6 abaixo,
-- com um exemplo comentado). Enquanto usuario_id estiver nulo, esses
-- registros ficam invisíveis pra todo mundo (nem o "dono" original os vê) --
-- é o comportamento seguro por padrão (fail-closed), mas não é o ideal pra
-- produção: rode o UPDATE antes de considerar a migração concluída.
-- ============================================================================

-- 1) usuario_id nas tabelas que passam a ser isoladas por dono ------------
alter table clientes add column if not exists usuario_id uuid references auth.users(id) on delete cascade;
alter table envios add column if not exists usuario_id uuid references auth.users(id) on delete cascade;
alter table conversas add column if not exists usuario_id uuid references auth.users(id) on delete cascade;
alter table tags add column if not exists usuario_id uuid references auth.users(id) on delete cascade;
alter table respostas_rapidas add column if not exists usuario_id uuid references auth.users(id) on delete cascade;
alter table pix_extracoes add column if not exists usuario_id uuid references auth.users(id) on delete cascade;

-- envio_itens e mensagens não precisam de usuario_id próprio: dá pra saber o
-- dono seguindo a referência (envio_itens -> envios -> usuario_id; mensagens
-- -> conversas -> usuario_id). Evita duplicar a informação e ela dessincronizar.

create index if not exists clientes_usuario_id_idx on clientes (usuario_id);
create index if not exists envios_usuario_id_idx on envios (usuario_id);
create index if not exists conversas_usuario_id_idx on conversas (usuario_id);
create index if not exists tags_usuario_id_idx on tags (usuario_id);
create index if not exists respostas_rapidas_usuario_id_idx on respostas_rapidas (usuario_id);
create index if not exists pix_extracoes_usuario_id_idx on pix_extracoes (usuario_id);

-- 2) Índices únicos que eram globais viram únicos POR USUÁRIO ---------------
-- "telefone" só precisava ser único dentro da carteira de um mesmo usuário;
-- dois usuários diferentes podem ter, cada um, um cliente com aquele telefone.
drop index if exists clientes_telefone_key;
create unique index if not exists clientes_usuario_telefone_key on clientes (usuario_id, telefone);

drop index if exists conversas_telefone_key; -- nome do índice implícito do "unique" da coluna
alter table conversas drop constraint if exists conversas_telefone_key;
create unique index if not exists conversas_usuario_telefone_key on conversas (usuario_id, telefone);

drop index if exists tags_nome_key;
create unique index if not exists tags_usuario_nome_key on tags (usuario_id, lower(nome));

drop index if exists respostas_rapidas_atalho_key;
create unique index if not exists respostas_rapidas_usuario_atalho_key on respostas_rapidas (usuario_id, lower(atalho));

-- 3) whatsapp_sessions: session_id passa a SER o usuario_id ------------------
-- Antes: session_id era 'default' ou 'slot-1'/'slot-2' (global, compartilhado).
-- Agora: session_id = usuario_id::text (cada usuário com sua própria sessão
-- Baileys). A tabela já era genérica o bastante (session_id text) pra não
-- precisar de mudança de schema aqui -- só o VALOR que passa a ser um UUID de
-- usuário em vez de um rótulo fixo. Ver src/services/whatsapp.js.
--
-- Sessões antigas com session_id='default'/'slot-1'/'slot-2' ficam órfãs
-- (não pertencem a usuário nenhum) -- eram credenciais compartilhadas da
-- operação antiga, não fazem mais sentido manter. Apagamos explicitamente
-- pra não deixar um WhatsApp "fantasma" pareado sem dono navegando no banco:
delete from whatsapp_sessions where session_id in ('default', 'slot-1', 'slot-2');

-- 4) estrategia_config (round-robin entre slot 1/2) não faz mais sentido ----
-- Round-robin existia pra balancear carga entre 2 números de UMA operação.
-- Cada usuário agora tem 1 WhatsApp só -- não há entre o que "escolher".
-- Mantemos a tabela (não apagamos dado à toa) mas ela não é mais lida pelo
-- backend a partir desta versão.
comment on table estrategia_config is
  'Deprecated a partir do multi-tenant (2026-08): não é mais usada pelo backend. '
  'Cada usuário tem 1 sessão WhatsApp própria, não há mais slots pra balancear.';

-- 5) Buckets: pix-extracoes também precisa ser privado -----------------------
-- Mesmo caso de faturas/chat-midia -- ficou de fora da migration-12 por
-- descuido. Hoje na prática o backend não grava PDF real nesse bucket
-- (storage_path fica sempre null nas rotas atuais), mas o bucket existe no
-- schema e pode voltar a ser usado -- mais seguro corrigir agora.
update storage.buckets set public = false where id = 'pix-extracoes';

-- 6) RLS de verdade agora (antes: habilitado mas sem policy = só service_role
--    acessava, o que era aceitável quando só o backend existia como cliente).
--    Agora que múltiplos usuários dividem o mesmo banco, adicionamos policies
--    de isolamento por dono -- útil como camada extra de defesa mesmo o
--    backend já filtrando por req.user.id em cada rota (defesa em
--    profundidade: um bug numa rota que esqueça o filtro não vaza dado de
--    outro usuário, porque o Postgres barra de qualquer forma pra quem
--    acessar com JWT de usuário em vez de service_role).
drop policy if exists "dono ve seus clientes" on clientes;
create policy "dono ve seus clientes" on clientes for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

drop policy if exists "dono ve seus envios" on envios;
create policy "dono ve seus envios" on envios for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

drop policy if exists "dono ve seus envio_itens" on envio_itens;
create policy "dono ve seus envio_itens" on envio_itens for all to authenticated
  using (envio_id in (select id from envios where usuario_id = auth.uid()));

drop policy if exists "dono ve suas conversas" on conversas;
drop policy if exists "usuarios autenticados leem conversas" on conversas; -- policy antiga (single-tenant), substituída
create policy "dono ve suas conversas" on conversas for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

drop policy if exists "dono ve suas mensagens" on mensagens;
drop policy if exists "usuarios autenticados leem mensagens" on mensagens; -- policy antiga (single-tenant), substituída
create policy "dono ve suas mensagens" on mensagens for all to authenticated
  using (conversa_id in (select id from conversas where usuario_id = auth.uid()));

drop policy if exists "dono ve suas tags" on tags;
create policy "dono ve suas tags" on tags for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

drop policy if exists "dono ve suas cliente_tags" on cliente_tags;
create policy "dono ve suas cliente_tags" on cliente_tags for all to authenticated
  using (cliente_id in (select id from clientes where usuario_id = auth.uid()));

drop policy if exists "dono ve suas respostas_rapidas" on respostas_rapidas;
create policy "dono ve suas respostas_rapidas" on respostas_rapidas for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

drop policy if exists "dono ve suas pix_extracoes" on pix_extracoes;
create policy "dono ve suas pix_extracoes" on pix_extracoes for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

-- whatsapp_sessions e auditoria_exclusoes continuam SEM policy (só
-- service_role acessa) -- não faz sentido nenhum usuário ler credenciais
-- Baileys ou o log de auditoria diretamente via API do Supabase.

-- ============================================================================
-- PASSO MANUAL OBRIGATÓRIO: atribuir os registros antigos (usuario_id nulo)
-- a um usuário real antes de considerar a migração concluída. Exemplo (troque
-- o e-mail pelo do operador que deve "herdar" os dados pré-multi-tenant):
--
-- update clientes set usuario_id = (select id from auth.users where email = 'operador@empresa.com') where usuario_id is null;
-- update envios set usuario_id = (select id from auth.users where email = 'operador@empresa.com') where usuario_id is null;
-- update conversas set usuario_id = (select id from auth.users where email = 'operador@empresa.com') where usuario_id is null;
-- update tags set usuario_id = (select id from auth.users where email = 'operador@empresa.com') where usuario_id is null;
-- update respostas_rapidas set usuario_id = (select id from auth.users where email = 'operador@empresa.com') where usuario_id is null;
-- ============================================================================
