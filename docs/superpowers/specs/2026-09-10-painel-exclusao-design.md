# Painel de Exclusão — design

Data: 2026-09-10
Repos afetados: `Backend-Trabalho` e `Front-Trabalho`

## Contexto e problema

Pedido do usuário: "faça um painel de exclusão, onde o operador/supervisor
pode simplesmente apagar um grupo de PDFs, deve aparecer em Lista oque mais
está ocupando espaço no banco, e escolher o índice de tabela que deve ser
apagado, ex, apagar esse grupo de PDFs de tal safra ou FPD ou SPD ou pagos ou
deletar histórico de mensagens e etc".

O sistema já tem uma exclusão automática de retenção (`limpezaAutomatica.js`,
PDF com mais de 40 dias) e exclusão manual de 1 registro por vez (cliente,
conversa). Não existe hoje nenhuma forma de apagar **em massa, por
critério, sob demanda**.

## Decisões tomadas no brainstorm

- **Acesso**: só `supervisor` (mesmo middleware `requireSupervisor` já usado
  em `/api/supervisor/*`). Ação destrutiva em massa não fica disponível pro
  operador comum.
- **Medição de espaço**: contagem de linhas/arquivos por critério (não bytes
  reais) — não existe hoje nenhum mecanismo de tamanho em bytes no sistema, e
  somar via Storage API sob demanda seria lento/caro. Contagem já é
  suficiente pra priorizar o que apagar.
- **Escopo de cada critério decidido caso a caso** (não um "modo" único):
  PDFs por safra/FPD-SPD apagam só o arquivo; clientes por tag apagam o
  cadastro inteiro (cascade); histórico de mensagens apaga conversas +
  mensagens.

## Critérios de exclusão (v1)

| id | Parâmetros | O que apaga | Tabelas/Storage afetados |
|---|---|---|---|
| `pdfs_por_safra` | `safra` (`YYYY-MM`) | Só o arquivo PDF — `clientes.pdf_path/pdf_url/pdf_atualizado_em` viram null. Cliente continua cadastrado. | bucket `faturas`, `clientes` |
| `pdfs_por_tipo_fatura` | `tipo_fatura` (`FPD`\|`SPD`) | Igual acima, filtrado por tipo em vez de safra. | bucket `faturas`, `clientes` |
| `clientes_por_tag` | `tag_id` | Cliente inteiro. Cascade já existente cuida de `envio_itens`, `tratativas`, `cliente_tags`; `conversas.cliente_id`/`pix_extracoes.cliente_id` viram null (não apaga a conversa). PDF do Storage é removido explicitamente antes (cascade de banco não mexe em arquivo). | `clientes` (+ cascades), bucket `faturas` |
| `historico_mensagens` | `campanha` (`cobranca`\|`chip_ativacao`\|`todas`), `dias_mais_antigo_que` (inteiro, mínimo 30) | Conversas com `ultima_mensagem_em` mais antiga que o corte (mensagens cascadeiam). Anexos do Storage removidos explicitamente antes. | `conversas` (+ cascade `mensagens`), bucket `chat-midia` |

Catálogo vive em `src/lib/exclusaoCriterios.js` — cada critério exporta
`{ label, contar(filtro), executar(filtro) }`. Adicionar um 5º critério no
futuro é só mais uma entrada no catálogo, sem tocar nas rotas.

## API (`Backend-Trabalho/src/routes/exclusao.routes.js`)

Montada em `app.use('/api/supervisor/exclusao', requireAuth,
requireSupervisor, exclusaoRoutes)` (arquivo próprio, não cresce
`supervisor.routes.js`).

- **`GET /resumo`** — varre os 4 critérios com um filtro "natural" cada
  (uma linha por safra existente, uma por FPD/SPD, uma por tag com
  clientes, uma por campanha de chat) e devolve tudo numa lista só,
  ordenada por quantidade decrescente:
  ```json
  { "itens": [
    { "criterio": "historico_mensagens", "filtro": { "campanha": "cobranca", "dias_mais_antigo_que": 0 }, "rotulo": "Mensagens — cobrança", "quantidade": 15234, "detalhe": "15.234 mensagens em 640 conversas" },
    { "criterio": "pdfs_por_safra", "filtro": { "safra": "2026-05" }, "rotulo": "PDFs — Safra Maio/2026", "quantidade": 812, "detalhe": "812 PDFs" }
  ]}
  ```
- **`POST /:criterio/preview`** — body `{ filtro }`. Devolve
  `{ quantidade, amostra: string[] }` (até 5 rótulos legíveis, o formato
  depende do critério: `"Maria da Silva (11987654321)"` pra PDFs/clientes,
  `"11987654321 — 42 mensagens"` pra histórico de mensagens). Nunca apaga
  nada, só conta e mostra amostra.
- **`POST /:criterio/executar`** — body `{ filtro, confirmacao }`. Servidor
  **também** valida `confirmacao === 'APAGAR'` (defesa em profundidade —
  não confia só no frontend desabilitar o botão). Executa o critério,
  grava **uma linha resumo** de auditoria (não uma por item apagado — ver
  abaixo), devolve `{ apagados }`.

## Auditoria

Reaproveita `registrarAuditoriaExclusao` (já existe, `src/lib/auditoria.js`),
mas com uma chamada só por operação em lote, não uma por item — evita
inundar `auditoria_exclusoes` numa exclusão de milhares de linhas:

```js
registrarAuditoriaExclusao({
  entidade: 'exclusao_em_lote',
  entidadeId: criterio,
  usuario: req.user,
  detalhes: { criterio, filtro, total_apagado, amostra_ids: [...primeiros 20] },
});
```

## Frontend

Aba nova "Exclusão" dentro de `/supervisor` (mesmo padrão de aba única por
arquivo que as outras — `AbaDashboard`, `AbaClientes` etc. já usam, ver
`Front-Trabalho/src/routes/supervisor.tsx`). Fluxo:

1. Lista "O que mais está ocupando espaço" (`GET /resumo`), ordenada do
   maior pro menor — clicar numa linha pré-preenche o critério/filtro do
   passo 2.
2. Formulário manual (caso o supervisor queira um filtro que não apareceu no
   resumo, ex.: safra diferente) — campos mudam conforme o critério
   escolhido (safra / tipo_fatura / tag / campanha+dias).
3. Preview obrigatório: mostra contagem exata + amostra antes de qualquer
   botão de apagar ficar clicável.
4. Confirmação por texto: precisa digitar literalmente "APAGAR" pra habilitar
   o botão final (mesmo texto que o backend valida).
5. Sucesso: toast com quantidade apagada, recarrega o resumo.

## Fora de escopo (v1)

- Tamanho real em bytes (Storage API `list()` com soma de `metadata.size`) —
  contagem já resolve o pedido, byte-exato fica pra depois se pedirem.
- Operador comum apagar da própria carteira — só supervisor por enquanto.
- Desfazer/lixeira — exclusão é definitiva, como já é hoje pro delete de 1
  registro (mesmo risco, escala maior).

## Testes / validação

`node --check` em todos os arquivos novos/alterados, suíte de testes
existente (a lógica de contagem/filtro dos critérios é candidata a teste
unitário se puder ser isolada de chamadas ao Supabase — a validar durante a
implementação), `tsc --noEmit` + `vite build` no frontend. Sem ambiente de
staging disponível — a exclusão real só é verificável em produção; por isso
o preview + confirmação por texto são obrigatórios, não opcionais.
