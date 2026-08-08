-- Rodar isso no SQL Editor do Supabase (banco já existente, em produção).
-- Corrige: "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- Sem isso, o upsert(onConflict: 'message_id') em chatIngest.js sempre falha.
create unique index if not exists mensagens_message_id_key on mensagens (message_id) where message_id is not null;
