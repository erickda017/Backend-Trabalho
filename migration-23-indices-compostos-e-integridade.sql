-- Rode isso no SQL Editor do Supabase. Idempotente, pode rodar de novo com segurança.
--
-- Dois achados "nice-to-have" da mesma auditoria de banco de dados de
-- 2026-09 que gerou a migration-22 (índices/integridade críticos):
--
-- 1) Índices COMPOSTOS (usuario_id, coluna de ordenação) -- várias rotas já
--    filtram por usuario_id E ordenam por outra coluna na mesma query
--    (ex.: qualidade.routes.js: usuario_id + order data_prazo;
--    chat.routes.js: usuario_id + order ultima_mensagem_em; pix.routes.js/
--    faturasPendentes.routes.js: usuario_id + order criado_em), mas só
--    existiam índices single-column separados pra cada uma dessas colunas.
--    Postgres consegue combinar dois índices simples via bitmap scan, mas
--    um índice composto atende esse padrão de acesso direto, sem combinar.
--
-- 2) `clientes.cliente_principal_id` sem proteção contra auto-referência
--    (`id = cliente_principal_id`) -- causaria loop infinito em qualquer
--    código que resolva a cadeia de vínculo sem limite de profundidade.
--    `lib/faturaPropagacao.js` (`vincularNumero`) já evita isso na
--    aplicação (sempre resolve pro principal real da cadeia antes de
--    escrever, nunca deixa A apontar pra B que aponta pra C), mas uma
--    constraint no banco é defesa em profundidade barata contra qualquer
--    escrita que não passe por ali (bug futuro, acesso direto).

create index if not exists clientes_usuario_data_prazo_idx on clientes (usuario_id, data_prazo);
create index if not exists conversas_usuario_ultima_mensagem_idx on conversas (usuario_id, ultima_mensagem_em desc);
create index if not exists pix_extracoes_usuario_criado_em_idx on pix_extracoes (usuario_id, criado_em desc);
create index if not exists faturas_pendentes_usuario_criado_em_idx on faturas_pendentes (usuario_id, criado_em desc);

do $$
begin
  alter table clientes add constraint clientes_principal_nao_e_ele_mesmo check (cliente_principal_id is null or cliente_principal_id <> id);
exception when duplicate_object then null;
end $$;
