# Ativação Chip — design

Data: 2026-09-10
Repos afetados: `Backend-Trabalho` e `Front-Trabalho` (monorepo, dois repositórios git separados)

## Contexto e problema

O sistema (Voxcel Faturas) foi construído pra uma campanha de cobrança de
telecom (disparo de fatura em PDF via WhatsApp). A empresa agora quer rodar,
**em paralelo**, uma campanha diferente — **ativação de chip** — cujos
clientes precisam ficar separados dos clientes da campanha de cobrança que
ainda está ativa.

Requisitos explícitos do usuário:
- Nova aba dedicada "Ativação Chip".
- Upload de clientes via planilha (colunas diferentes da planilha de
  fatura).
- Gerenciamento desses clientes.
- Chat separado pra esses clientes.
- Uma migração de dados mais robusta (provável tabela/arquitetura própria)
  será feita no futuro — por enquanto, uma adição ao sistema atual resolve.

## Restrição chave descoberta durante o brainstorm

O mesmo telefone **pode** aparecer nas duas campanhas (a mesma pessoa é
cliente de cobrança e também alvo de ativação de chip). Isso significa que
não dá pra tratar `telefone` como identificador suficiente pra separar
conversas — a campanha precisa fazer parte da chave de conversa, não só um
filtro de exibição.

## Planilha real de Ativação Chip

Colunas (tolerante a variação de nome/acentuação, como o import atual):
`OPERADORA`, `OS`, `CLIENTE`, `CPF`, `NM_CIDADE` / `NOME DA CIDADE`, `BKO
(RESPONSÁVEL)`, `VENDEDOR`, `TEL 1`, `TEL 2`, `TEL 3`.

Bem diferente da planilha de fatura (nome/telefone/valor/vencimento/pdf/pix)
— não reaproveita o parser existente.

## Abordagem escolhida (das 3 propostas)

**Coluna `campanha` nas tabelas existentes**, em vez de tabelas paralelas
dedicadas (rejeitado por duplicar fila de disparo/chat/import pra algo que
já vai ser substituído por uma migração futura) ou de uma tabela de extensão
1:1 (rejeitado por adicionar joins em todo lugar sem ganho que justifique
agora). `clientes` ganha colunas nullable exclusivas de chip — ficam `null`
nas linhas de cobrança, mesmo padrão que `pix_code` já usa hoje.

## Modelo de dados (`migration-25-ativacao-chip.sql`)

```sql
alter table clientes add column if not exists campanha text not null default 'cobranca';
alter table clientes add column if not exists operadora text;
alter table clientes add column if not exists os_numero text;
alter table clientes add column if not exists cpf text;
alter table clientes add column if not exists cidade text;
alter table clientes add column if not exists bko_responsavel text;
alter table clientes add column if not exists vendedor text;
alter table clientes add column if not exists telefone_2 text;
alter table clientes add column if not exists telefone_3 text;
-- check constraint campanha in ('cobranca', 'chip_ativacao')
-- index (usuario_id, campanha)

alter table conversas add column if not exists campanha text not null default 'cobranca';
-- check constraint campanha in ('cobranca', 'chip_ativacao')
-- drop index conversas_usuario_telefone_key
-- create unique index conversas_usuario_telefone_campanha_key on conversas (usuario_id, telefone, campanha)

alter table envios add column if not exists campanha text not null default 'cobranca';
-- check constraint

alter table envio_itens add column if not exists telefone_usado text; -- qual dos 3 telefones respondeu no WhatsApp (rastreabilidade)
```

Status/tratativa: reaproveita a tabela `tratativas` e a coluna
`clientes.status_operador` que já existem pra cobrança (ver
`migration-20-qualidade-tratativas.sql` e `src/lib/statusOperador.js`).
Amplia a lista de valores aceitos no `check` pra incluir os status de chip.
Vocabulário de chip vive num arquivo novo `src/lib/statusChip.js`, espelhando
`statusOperador.js`:

```js
export const STATUS_CHIP = [
  { valor: 'pendente', rotulo: 'Pendente', bloqueia_disparo: false },
  { valor: 'tentativa_contato', rotulo: 'Tentativa de contato', bloqueia_disparo: false },
  { valor: 'contato_estabelecido', rotulo: 'Contato estabelecido', bloqueia_disparo: false },
  { valor: 'chip_ativado', rotulo: 'Chip ativado', bloqueia_disparo: true },
  { valor: 'recusado', rotulo: 'Recusado', bloqueia_disparo: true },
  { valor: 'numero_invalido', rotulo: 'Número inválido', bloqueia_disparo: true },
];
```

A rota/serviço que grava tratativa passa a validar contra
`statusOperadorValido` OU `statusChipValido`, dependendo de
`cliente.campanha`.

## Disparo — fallback entre 3 telefones

Em `dispatchQueue.js`, quando `cliente.campanha === 'chip_ativacao'`, o envio
tenta `telefone`, depois `telefone_2`, depois `telefone_3` via
`validarNumero` até achar um que exista no WhatsApp; grava qual funcionou em
`envio_itens.telefone_usado`. Clientes de cobrança continuam com o
comportamento atual (um único `telefone`), sem mudança.

## Resolução de conversa quando o telefone existe nas duas campanhas

Quando chega uma mensagem de entrada (`chatIngest.js`) de um telefone que tem
conversa registrada nas duas campanhas, a mensagem é anexada à conversa com
`ultima_mensagem_em` mais recente (a "thread ativa"). Se não existe nenhuma
conversa ainda pra esse telefone+usuário, o sistema decide a campanha da
nova conversa assim: se existe cadastro em `clientes` só em uma campanha,
usa essa; se existe nas duas ou em nenhuma, usa `cobranca` (comportamento
atual, default seguro).

Mensagens de **saída** (disparo em massa ou resposta manual pelo chat) já
sabem a campanha de contexto (vêm de um envio com `campanha` definida, ou o
operador está na aba de chat de uma campanha específica) — não há
ambiguidade nesse sentido.

## Importação da planilha

Parser novo dedicado `src/services/importLoteChip.js`, mesmo padrão de
tolerância a variação de nome de coluna que `importLote.js` já usa. Endpoint
novo `POST /api/importacao/ativacao-chip` (multipart, reaproveita o parsing
de planilha existente — só troca o mapeamento de colunas e o insert final,
que grava `campanha: 'chip_ativacao'`).

## Frontend

- Item novo no menu (`AppShell.tsx`): **"Ativação Chip"**.
- Página nova com sub-abas:
  - **Clientes**: listagem + importar planilha + editar status/tratativa —
    reaproveita os componentes de tabela/formulário de `clientes.tsx`,
    parametrizados por `campanha='chip_ativacao'`.
  - **Chat**: reaproveita o componente de chat existente
    (`chat.tsx`/`conversasPaginadas.ts`), filtrado por `campanha`.
- A tela de **Disparo** (`disparos.tsx`) existente ganha um seletor de
  campanha ao montar um novo envio, em vez de duplicar a tela inteira.

## Fora de escopo (YAGNI, fica pra migração futura)

Dashboard, Safras/FPD-SPD e métricas de funil de cobrança não fazem sentido
pro fluxo de ativação de chip e não são estendidos agora. O sistema de
`tags` continua como está, sem mudança de schema (uma tag "Chip" pode ser
criada manualmente se quiserem marcar clientes, sem precisar de mudança de
código).

## Testes / validação

Sem sessão real do Baileys disponível neste ambiente — validação limitada a:
sintaxe (`node --check`), suíte de testes existente (unitários só cobrem
funções puras, ex.: novo parser de planilha de chip seguindo o padrão de
`parseListaClientes.test.js`), `tsc --noEmit`, `vite build`. Teste real do
disparo/chat com WhatsApp fica por conta do usuário em produção, como já
aconteceu com o fix anterior de chat.
