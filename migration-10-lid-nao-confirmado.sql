-- Corrige o bug: "responder um cliente cria um contato novo com o nome da minha
-- conta no zap".
--
-- Causa raiz (ver comentário em src/services/chatIngest.js):
-- 1) Quando o WhatsApp esconde o número do contato atrás de um "@lid" e a gente
--    não conseguia resolver o número real, o código antigo usava o próprio lid
--    (um id opaco, tipo "219743428550712") como se fosse o telefone -- isso cria
--    uma linha NOVA em `conversas` (não bate com o telefone já cadastrado do
--    cliente), ou seja, uma "conversa fantasma" separada da conversa de verdade.
-- 2) Essa conversa fantasma, ao ser criada, usava `pushName` como nome do
--    contato -- mas pushName de uma mensagem fromMe:true é o nome do PRÓPRIO
--    dono da conta (você), não do cliente. Daí o sintoma relatado: um "contato"
--    a mais, nomeado com o nome da sua conta.
--
-- Essa migração adiciona uma coluna pra marcar esse cenário explicitamente (em
-- vez de fabricar um telefone falso e deixar como se fosse um número real), e um
-- índice pra identificar rapidamente as fantasmas herdadas de antes do fix.
alter table conversas add column if not exists numero_nao_confirmado boolean not null default false;

comment on column conversas.numero_nao_confirmado is
  'true = telefone não é um número real; guardamos um id opaco de @lid porque o WhatsApp não revelou o número do contato ainda. Nunca usar esse "telefone" pra disparo em massa.';

create index if not exists conversas_numero_nao_confirmado_idx on conversas (numero_nao_confirmado) where numero_nao_confirmado = true;

-- Limpeza de dados legados: conversas fantasmas criadas pelo bug antigo (telefone
-- gigante/opaco vindo de um @lid, sem 12 ou 13 dígitos numéricos de telefone BR
-- válido) e cujo nome bate com um nome de conta do WhatsApp são bons candidatos
-- pra revisão manual -- NÃO apagamos automaticamente pra não perder histórico,
-- só deixamos localizável:
-- select * from conversas where telefone !~ '^[0-9]{12,13}$';
