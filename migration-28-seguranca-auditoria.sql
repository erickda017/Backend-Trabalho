-- migration-28-seguranca-auditoria.sql  [2026-10]
-- Auditoria de segurança. Idempotente: pode rodar de novo sem problema.
-- Rodar no Supabase: SQL Editor -> colar tudo -> Run.
--
-- 1) Policies "FOR ALL to authenticated" viram SÓ LEITURA.
--    O site nunca grava direto no banco (toda escrita passa pelo backend,
--    que usa a service_role e ignora RLS). Mas com a policy FOR ALL, qualquer
--    operador logado podia pegar o próprio token e gravar direto pela API
--    pública do Supabase (anon key + JWT), pulando as regras do backend.
--    Exemplo: trocar o pdf_path de um cliente seu pelo path do PDF de outro
--    operador e baixar esse PDF pelo proxy de arquivos.
--    Com "for select", ele continua lendo só o que é dele, e não grava nada.
--
-- 2) Storage: remove as policies antigas da migration-5 que deixavam
--    qualquer usuário logado subir/sobrescrever arquivo em QUALQUER path do
--    bucket "faturas" (upload direto do navegador, fluxo que não existe mais).

-- ---------- 1) tabelas: só leitura do próprio dado ----------
drop policy if exists "dono ve seus clientes" on clientes;
create policy "dono ve seus clientes" on clientes for select to authenticated
  using (usuario_id = auth.uid());

drop policy if exists "dono ve seus envios" on envios;
create policy "dono ve seus envios" on envios for select to authenticated
  using (usuario_id = auth.uid());

drop policy if exists "dono ve seus envio_itens" on envio_itens;
create policy "dono ve seus envio_itens" on envio_itens for select to authenticated
  using (envio_id in (select id from envios where usuario_id = auth.uid()));

drop policy if exists "dono ve suas conversas" on conversas;
create policy "dono ve suas conversas" on conversas for select to authenticated
  using (usuario_id = auth.uid());

drop policy if exists "dono ve suas mensagens" on mensagens;
create policy "dono ve suas mensagens" on mensagens for select to authenticated
  using (conversa_id in (select id from conversas where usuario_id = auth.uid()));

drop policy if exists "dono ve suas tags" on tags;
create policy "dono ve suas tags" on tags for select to authenticated
  using (usuario_id = auth.uid());

drop policy if exists "dono ve suas cliente_tags" on cliente_tags;
create policy "dono ve suas cliente_tags" on cliente_tags for select to authenticated
  using (cliente_id in (select id from clientes where usuario_id = auth.uid()));

drop policy if exists "dono ve suas respostas_rapidas" on respostas_rapidas;
create policy "dono ve suas respostas_rapidas" on respostas_rapidas for select to authenticated
  using (usuario_id = auth.uid());

drop policy if exists "dono ve suas pix_extracoes" on pix_extracoes;
create policy "dono ve suas pix_extracoes" on pix_extracoes for select to authenticated
  using (usuario_id = auth.uid());

do $$ begin
  drop policy if exists "dono ve suas faturas pendentes" on faturas_pendentes;
  create policy "dono ve suas faturas pendentes" on faturas_pendentes for select to authenticated
    using (usuario_id = auth.uid());
exception when undefined_table then null; end $$;

do $$ begin
  drop policy if exists "dono ve seu historico de safras" on safras_historico;
  create policy "dono ve seu historico de safras" on safras_historico for select to authenticated
    using (usuario_id = auth.uid());
exception when undefined_table then null; end $$;

-- Tabelas só do backend (RLS ligada e sem policy): tira também os GRANTs
-- padrão do Supabase pra anon/authenticated (camada extra; a service_role
-- do backend não depende deles).
do $$
declare t text;
begin
  foreach t in array array['whatsapp_sessions', 'auditoria_exclusoes', 'perfis', 'tratativas'] loop
    begin
      execute format('revoke all on table %I from anon, authenticated', t);
    exception when undefined_table then null;
    end;
  end loop;
end $$;

-- anon (visitante sem login) não lê nem grava nenhuma tabela de dados.
do $$
declare t text;
begin
  foreach t in array array['clientes', 'envios', 'envio_itens', 'conversas', 'mensagens', 'tags', 'cliente_tags',
                           'respostas_rapidas', 'pix_extracoes', 'faturas_pendentes', 'safras_historico', 'estrategia_config'] loop
    begin
      execute format('revoke all on table %I from anon', t);
      execute format('revoke insert, update, delete, truncate on table %I from authenticated', t);
    exception when undefined_table then null;
    end;
  end loop;
end $$;

-- ---------- 2) storage: sem escrita direta do navegador ----------
drop policy if exists "usuarios autenticados sobem pdf de faturas" on storage.objects;
drop policy if exists "usuarios autenticados atualizam pdf de faturas" on storage.objects;

-- Buckets continuam privados (migration-12); garante de novo.
update storage.buckets set public = false where id in ('faturas', 'chat-midia', 'avatars');

-- Conferência (opcional, só leitura): deve listar só policies "for SELECT".
-- select tablename, policyname, cmd from pg_policies where schemaname = 'public' order by 1;
