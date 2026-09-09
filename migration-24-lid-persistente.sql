-- Corrige o bug: responder um contato de "@lid" blindado pelo WhatsApp OFICIAL
-- no celular (em vez de pela plataforma) cria um contato NOVO "Contato não
-- identificado" -- duplicando a conversa de verdade.
--
-- Causa raiz (ver comentário em src/services/chatIngest.js, resolverTelefonePorLid):
-- o Baileys só manda os campos que permitem resolver o telefone real por trás
-- de um "@lid" (remoteJidAlt / senderPn) em CERTAS mensagens -- normalmente
-- resolve na primeira mensagem que o cliente manda pra gente, mas o eco de uma
-- mensagem enviada pelo WhatsApp oficial no celular (fora da plataforma) chega
-- como evento de sincronização multi-device sem esses campos, e o Baileys não
-- tinha o telefone em cache -- então o código antigo desistia e criava uma
-- conversa-fantasma nova a cada vez.
--
-- Fix: guarda o "@lid" na PRÓPRIA conversa já resolvida (coluna nova) na
-- primeira vez que resolver com sucesso -- da próxima vez que uma mensagem
-- (de qualquer direção) chegar com esse mesmo "@lid" sem dar pra resolver
-- pelos campos do Baileys, o código consulta essa coluna antes de desistir e
-- reaproveita a conversa já existente, sem criar fantasma nova.
alter table conversas add column if not exists lid text;

comment on column conversas.lid is
  'Identificador opaco "@lid" do WhatsApp associado a esta conversa, guardado na primeira vez que conseguimos resolver o telefone real por trás dele (ver resolverTelefonePorLid em chatIngest.js). Usado como cache pra não recriar contato-fantasma quando o Baileys não manda os metadados de resolução de novo (ex.: resposta enviada pelo WhatsApp oficial no celular).';

do $$
begin
  create unique index conversas_usuario_lid_key on conversas (usuario_id, lid) where lid is not null;
exception
  when duplicate_table then null;
end $$;
