-- Rode isso no SQL Editor do Supabase. Idempotente, pode rodar de novo com segurança.
--
-- CONTEXTO: dois achados críticos de uma auditoria de banco de dados
-- (2026-09), os dois sem relação de causa entre si, agrupados aqui só por
-- serem os dois migrations de índice/integridade pendentes no momento.
--
-- 1) clientes.numero_contrato sem unicidade -- desde que virou o critério
--    PRINCIPAL de identificação de cliente nos "casamentos" por nome
--    (Importar Pagos etc., ver lib/nomeMatch.js, `casarCliente`), nada no
--    banco impedia dois clientes do MESMO operador acabarem com o mesmo
--    contrato por engano (erro de digitação numa lista colada, por
--    exemplo) -- e o código de casamento usava `.find()` nesse caminho,
--    sem checar ambiguidade (diferente do cuidado que a mesma função já
--    tinha pro caminho de nome duplicado). O código já foi corrigido pra
--    tratar 2+ candidatos por contrato como ambíguo; esta migration fecha
--    o outro lado: o banco passa a recusar a duplicata na origem.
--
-- 2) envio_itens.message_id sem índice -- é o hot path do produto inteiro:
--    TODO evento de status do WhatsApp (enviado/entregue/lido, ver
--    services/whatsapp.js) faz um UPDATE filtrando por essa coluna, sem
--    nenhum índice, e o comentário do próprio código já assumia unicidade
--    que o banco nunca garantiu.
--
-- Os dois índices são criados dentro de um `do $$ ... exception` porque,
-- diferente de um `if not exists` comum, uma constraint UNIQUE pode falhar
-- por causa dos DADOS já existentes (duplicata real na base), não só por o
-- índice já existir -- se isso acontecer, a migration avisa em vez de
-- travar o script inteiro, e a query sugerida no aviso acha as duplicatas
-- pra corrigir manualmente antes de rodar de novo.

do $$
begin
  create unique index if not exists clientes_usuario_numero_contrato_key
    on clientes (usuario_id, numero_contrato)
    where numero_contrato is not null;
exception
  when unique_violation then
    raise notice 'clientes.numero_contrato duplicado pro mesmo usuario_id -- ache com: '
      'select usuario_id, numero_contrato, count(*) from clientes '
      'where numero_contrato is not null group by 1, 2 having count(*) > 1;';
end $$;

do $$
begin
  create unique index if not exists envio_itens_message_id_key
    on envio_itens (message_id)
    where message_id is not null;
exception
  when unique_violation then
    raise notice 'envio_itens.message_id duplicado -- ache com: '
      'select message_id, count(*) from envio_itens '
      'where message_id is not null group by 1 having count(*) > 1;';
end $$;
