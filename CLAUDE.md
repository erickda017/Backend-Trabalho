# CLAUDE.md — guia rápido para IA trabalhando neste repo

> Leia isto primeiro. Para contexto completo de produto, regras de negócio e
> histórico de bugs, o arquivo fonte da verdade é `Front-Trabalho/CONTEXTO.md`
> — leia-o inteiro antes de qualquer tarefa não-trivial. Este arquivo aqui é
> só o "como mexer no repo" (comandos, estrutura, armadilhas de ambiente).
>
> Se você corrigir um bug, mudar uma regra de negócio ou alterar formato de
> dados (banco/API/.env), atualize também o `Front-Trabalho/CONTEXTO.md`
> (seção "Bugs corrigidos" ou "Funcionalidades implementadas"), não só este
> arquivo.

## O que é

Sistema de disparo de faturas em PDF via WhatsApp (conta normal via QR Code,
Baileys — não é API oficial da Meta), com dashboard, controle de safras/FPD/SPD,
extração de PIX de boletos e chat.

## Estrutura (monorepo, duas pastas na raiz)

```
Backend-Trabalho/   Node + Express + Baileys + Supabase (Postgres/Storage)
Front-Trabalho/     React 19 + Vite + TanStack Router/Start, SPA estática
```

⚠️ Os nomes reais das pastas são `Backend-Trabalho` e `Front-Trabalho`
(maiúsculas, com hífen) — não `backend`/`frontend`. Qualquer script, CI ou
`render.yaml` que assumir os nomes genéricos vai falhar. Já aconteceu.

## Rodando localmente

**Backend** (`Backend-Trabalho/`):
```bash
npm install
cp .env.example .env   # preencher SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY de verdade
npm run dev            # node --watch src/server.js, porta 3333
```

**Frontend** (`Front-Trabalho/`):
```bash
npm install
cp .env.example .env   # preencher VITE_API_URL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm run dev            # vite dev
```

Sem os dois `.env` reais preenchidos, o backend sobe mas toda query falha
silenciosamente (não crasha o processo), e o frontend dá `Failed to fetch`
achando que é bug de código quando na verdade é falta de configuração.

## Deploy em produção (já configurado, não é hipotético)

- **Backend → Render**, Web Service configurado manualmente pelo painel
  (não usa Blueprint/`render.yaml` — se existir um `render.yaml` no repo,
  ele é só referência/histórico, **não é a fonte de verdade do deploy real**).
  A sessão do WhatsApp (Baileys) é persistida na tabela `whatsapp_sessions`
  do Supabase (`src/lib/supabaseAuthState.js`), não em disco — **não precisa
  de Persistent Disk** pra sobreviver a redeploys (isso já foi verdade no
  passado, mudou; se algum guia mais antigo ou o painel do Render ainda
  tiver um disco configurado por causa disso, pode remover). O que se perde
  quando o processo dorme/reinicia é só a conexão WebSocket em aberto —
  reconecta sozinho na próxima requisição, sem precisar de QR novo.
  Free tier "dorme" após inatividade — primeira requisição depois de dormir
  pode demorar ou parecer `Failed to fetch` no frontend.
- **Frontend → Vercel.** Variável de ambiente obrigatória:
  `VITE_API_URL=https://SEU-BACKEND.onrender.com/api` (não esquecer o `/api`
  no final). Se o painel da Vercel reclamar de "output directory"/"public
  framework", checar em Settings → Build & Development Settings se não há um
  override manual de Output Directory para `public` — o build do Vite gera
  em `dist`, não em `public`; o padrão do framework (sem override) já resolve.
- Depois de trocar a URL do frontend (novo domínio Vercel), atualizar
  `FRONTEND_ORIGIN` nas env vars do backend no Render, senão CORS bloqueia
  tudo.

## Banco (Supabase)

- Schema base: `Backend-Trabalho/supabase-schema.sql` (idempotente).
- Migrations incrementais como `Backend-Trabalho/migration-19-safras-faturas.sql`
  também são idempotentes (`if not exists` / `do $$ ... exception`) — podem
  rodar de novo com segurança se uma tentativa anterior falhou no meio.
- **Cuidado com colunas geradas (`generated always as`) usando `to_char()`
  em cima de `date`/`timestamp`**: o Postgres recusa com
  `ERROR 42P17: generation expression is not immutable`, mesmo quando a
  coluna é `date` puro — o planner não isola o overload IMMUTABLE do
  overload STABLE de `to_char`. Alternativa que funciona: montar o texto
  com `extract(year/month from coluna)` + `lpad(...)` em vez de `to_char`.
- RLS: a `migration-13-multi-tenant.sql` já adicionou policies reais de
  isolamento por `usuario_id` nas tabelas principais (`clientes`, `envios`,
  `envio_itens`, `conversas`, `mensagens`, `tags`, `cliente_tags`,
  `respostas_rapidas`, `pix_extracoes`, e depois `faturas_pendentes`/
  `safras_historico`). Só `whatsapp_sessions`, `auditoria_exclusoes`,
  `perfis` e `tratativas` continuam com RLS habilitado **sem** policy —
  isso sim é intencional (o backend usa a `service_role key`, que ignora
  RLS de qualquer forma). Vale lembrar: mesmo com as policies nas tabelas
  principais, um vazamento da `service_role key` ainda expõe tudo, já que
  ela sempre ignora RLS — as policies protegem contra outro cenário (JWT de
  usuário comum vazado, ou bug de rota que esqueça o filtro `usuario_id`).

## Rotas principais do backend (`Backend-Trabalho/src/routes/`)

`clientes`, `dashboard`, `envios`, `faturas`, `faturasPendentes`, `safras`,
`supervisor`, `pix`, `boletos`, `whatsapp`, `chat`, `tags`, `importacao`,
`configuracoes`, `perfil`, `respostasRapidas`, `arquivos`.

Toda rota `/api/*` (exceto `/api/health`) exige `Authorization: Bearer <token>`
do Supabase Auth.

## Erros já resolvidos neste projeto (não repetir o diagnóstico do zero)

1. **"Failed to fetch" no frontend em produção** — quase nunca é bug de
   código. Ordem de investigação: (1) `VITE_API_URL` está certa e aponta
   pro backend certo? (2) backend no Render está de pé (`GET /api/health`)?
   (3) é free tier "dormindo"? (4) `FRONTEND_ORIGIN` no backend bate com o
   domínio real da Vercel (CORS)?
2. **`ERROR 42P17` ao rodar migration com coluna gerada** — ver seção Banco
   acima. Trocar `to_char` por `extract` + `lpad`.
3. **Vercel reclamando de output directory / "public framework"** — checar
   override manual nas Project Settings, não no `vercel.json` do repo.

## Convenções de código já em uso (seguir o padrão existente)

- Telefone sempre normalizado (dígitos + DDI, ex: `5511999999999`) via
  `Backend-Trabalho/src/lib/telefone.js` — assume Brasil (`55`) fixo, decisão
  consciente, não bug.
- Import/export de planilha tolera variações de nome de coluna
  (acento/maiúscula-insensitive) — ver `Backend-Trabalho/src/services/importLote.js`.
- Toda alteração relevante de negócio deve ser registrada no
  `Front-Trabalho/CONTEXTO.md`, não só neste arquivo.
