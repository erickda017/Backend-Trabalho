-- Rode isso no SQL Editor do Supabase (idempotente: pode rodar de novo com segurança)
--
-- Habilita a importação CLIENT-SIDE (planilha + zip processados no navegador de
-- quem importa, não mais no servidor): o navegador, autenticado com a sessão do
-- usuário (chave anon + RLS, NÃO a service_role key do backend), passa a subir
-- os PDFs direto no bucket "faturas" do Storage -- é essa parte (renderizar PDF
-- em canvas, escanear QR pra achar o Pix) que pesava no servidor e estourava a
-- RAM em hospedagens com pouca memória (ex: Render free, 512MB) ao importar
-- muitos clientes de uma vez.
--
-- O upsert em "clientes" continua passando pelo backend (POST /api/importacao/lote,
-- que usa a service_role key e ignora RLS) -- só o PDF em si sai do servidor.
-- Por isso a única policy nova necessária aqui é a de Storage.
--
-- Sem ela, RLS (já habilitada por padrão no Storage do Supabase) bloqueia
-- qualquer escrita feita com a chave anon -- só a service_role key do backend
-- conseguia subir arquivo no bucket "faturas" até agora.

-- ==========================================================================
-- Storage: bucket "faturas" -- permite usuário autenticado subir/atualizar PDF
-- ==========================================================================
-- Leitura já era pública (bucket criado com public: true no schema principal),
-- então não precisa de policy de SELECT aqui -- só INSERT/UPDATE, que faltava.

drop policy if exists "usuarios autenticados sobem pdf de faturas" on storage.objects;
create policy "usuarios autenticados sobem pdf de faturas"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'faturas');

drop policy if exists "usuarios autenticados atualizam pdf de faturas" on storage.objects;
create policy "usuarios autenticados atualizam pdf de faturas"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'faturas')
  with check (bucket_id = 'faturas');
