-- Rodar isso no SQL Editor do Supabase (banco já existente, em produção).
-- Corrige: "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- Sem isso, o upsert(onConflict: 'message_id') em chatIngest.js sempre falha.
--
-- Se você já rodou uma versão anterior desta migration com índice PARCIAL
-- (where message_id is not null), rode o drop abaixo primeiro -- índice parcial
-- não serve de alvo pro ON CONFLICT (message_id) simples que o supabase-js gera.
drop index if exists mensagens_message_id_key;
create unique index mensagens_message_id_key on mensagens (message_id);
