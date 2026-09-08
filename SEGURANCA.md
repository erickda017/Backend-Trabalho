# SEGURANÇA.md — mudanças de 2026-08 e limitações conhecidas

Este arquivo documenta a auditoria de segurança feita no sistema (que lida com
PDFs de fatura contendo dados pessoais de cliente — nome, endereço, CPF) e o
que foi corrigido. Leia isto antes de colocar em produção.

## O que foi corrigido nesta rodada

### 1. Buckets do Storage agora são privados (era o problema mais grave)
Os buckets `faturas` e `chat-midia` eram criados com `public: true`. Qualquer
PDF de fatura (com CPF/endereço impresso) ou mídia do chat ficava acessível
por link direto, permanentemente, sem login nenhum — bastava alguém obter a
URL (log, print de tela, referrer, link encaminhado sem querer).

**Correção:** ambos os buckets viram privados. Toda leitura passa a usar
*Signed URLs* (`supabase.storage.from(bucket).createSignedUrl(...)`), geradas
pelo backend autenticado, com expiração curta (10 minutos por padrão,
configurável via `SIGNED_URL_TTL_SEGUNDOS`). O front continua recebendo um
campo `pdf_url`/`anexo_url` normalmente — ele só passou a ser calculado na
hora de cada resposta, nunca mais gravado permanentemente no banco.

**Se você já tem um projeto Supabase rodando:** rode
`migration-12-seguranca-buckets-privados.sql` no SQL Editor. Ele torna os
buckets privados, limpa URLs públicas antigas gravadas no banco (que já não
servem pra nada com o bucket privado) e cria a tabela de auditoria (item 3).

### 2. Auditoria de exclusões (LGPD)
Excluir um cliente ou uma conversa apagava os dados sem deixar rastro de quem
fez isso e quando — importante para rastreabilidade de operações sobre dados
pessoais. Agora existe a tabela `auditoria_exclusoes` (só o backend acessa,
RLS fecha o resto), preenchida automaticamente nos `DELETE` de cliente e de
conversa, com usuário, timestamp e um snapshot dos dados removidos.

### 3. CORS travado por padrão em produção
Antes, se a variável `FRONTEND_ORIGIN` não fosse configurada no Render, o CORS
liberava geral (`origin: true`) — fácil de esquecer num deploy apressado, e
isso deixaria a API vulnerável a qualquer site chamando em nome de um usuário
logado. Agora, em produção (detectado via a env var `RENDER`, que a
plataforma sempre injeta, ou `NODE_ENV=production`) sem `FRONTEND_ORIGIN`
configurada, o servidor **bloqueia todo CORS** em vez de liberar geral, e loga
um erro explícito no início explicando o que fazer. Em desenvolvimento local
(sem essas variáveis), o comportamento permissivo de antes continua, pra não
travar quem está rodando na própria máquina.

## [2026-08, ATUALIZADO 2026-09] Autorização por objeto — já corrigida (multi-tenant)

**Esta seção descrevia uma limitação real da rodada de 2026-08 (single-tenant)
que já não existe.** Registro histórico abaixo, seguido do estado atual.

*Como era em 2026-08:* o sistema não tinha colunas de "dono" (`user_id` etc.)
em `clientes`/`envios`/`conversas` — uma instância inteira (um número de
WhatsApp, uma base de clientes) para uma única equipe. `requireAuth` garantia
login, mas qualquer conta autenticada enxergava todos os dados.

*Estado atual:* `migration-13-multi-tenant.sql` (2026-08, pouco depois desta
auditoria) adicionou `usuario_id` em todas as tabelas relevantes (`clientes`,
`envios`, `envio_itens`, `conversas`, `mensagens`, `tags`, `pix_extracoes`,
etc.) com policies de RLS reais, e toda rota do backend passou a filtrar por
`req.user.id` — cada operador só vê/mexe nos próprios dados, confirmado rota
a rota (ver auditoria técnica de 2026-09 em `Front-Trabalho/CONTEXTO.md`).

**Achado crítico dessa auditoria de 2026-09, já corrigido:** o proxy de
arquivos (`routes/arquivos.routes.js`) era a ÚNICA rota que não repetia esse
cuidado — servia qualquer path pedido sem confirmar o dono, então um operador
que soubesse (ou adivinhasse) o path de um arquivo de outro operador
conseguia baixá-lo. Corrigido: a rota agora resolve o dono do path (por
convenção de bucket, com fallback pra consulta no banco) antes de servir, com
exceção só pra `role=supervisor` (que já enxerga arquivo de todo operador em
outras rotas, ex.: `GET /supervisor/clientes`).

**Ressalva que continua válida independente de tudo isso:** o backend usa a
`service_role key`, que sempre ignora RLS — um vazamento dessa chave expõe o
banco inteiro de todos os operadores, RLS ou não. As policies de
`migration-13` protegem contra outro cenário (JWT de usuário comum vazado, ou
bug de rota que esqueça o filtro `usuario_id`), não contra isso.

## Pendência intencional: OCR via Cloudflare Worker de terceiro

O fluxo de extração de dados do boleto (`pixWorkerClient.ts`) envia páginas do
PDF para `https://processo-de-pdf.erickramiro2010.workers.dev` — um domínio
pessoal, fora do controle da organização. Isso não foi alterado nesta rodada
a pedido explícito; veja a seção "Migrando o Worker de OCR" (mensagem
separada) para o passo a passo de mover isso para um domínio próprio.
