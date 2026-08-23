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

## Limitação conhecida, não corrigida nesta rodada: autorização por objeto

O sistema não tem colunas de "dono" (`user_id`, `empresa_id` etc.) em
`clientes`, `envios`, `conversas` — foi construído como **single-tenant**:
uma instância inteira (um número de WhatsApp, uma base de clientes) para uma
única equipe. `requireAuth` garante que só usuários logados no Supabase Auth
desse projeto acessam a API, mas **qualquer conta autenticada enxerga todos
os dados** (não existe "cada vendedor só vê os próprios clientes", por
exemplo).

Isso é aceitável **somente se** todo mundo que tem uma conta nesse projeto
Supabase for de fato uma pessoa de confiança da mesma equipe/empresa, com
permissão para ver a base de clientes inteira (CPF, endereço, fatura). Se
esse não for o caso — por exemplo, se a ideia é várias empresas/times
diferentes usando o mesmo backend, cada um só com seus próprios clientes —
isso precisa de uma mudança estrutural (coluna `empresa_id` em `clientes` e
nas tabelas relacionadas + filtro em toda query pelo `req.user`), que não foi
feita porque muda o modelo de dados e o fluxo de cadastro de usuários, e não
dava pra decidir isso sem confirmar o cenário de uso real com quem mantém o
sistema.

**Recomendação:** se houver qualquer chance de múltiplas equipes/clientes
finais compartilharem esta mesma instância, tratar isso antes de ir para
produção.

## Pendência intencional: OCR via Cloudflare Worker de terceiro

O fluxo de extração de dados do boleto (`pixWorkerClient.ts`) envia páginas do
PDF para `https://processo-de-pdf.erickramiro2010.workers.dev` — um domínio
pessoal, fora do controle da organização. Isso não foi alterado nesta rodada
a pedido explícito; veja a seção "Migrando o Worker de OCR" (mensagem
separada) para o passo a passo de mover isso para um domínio próprio.
