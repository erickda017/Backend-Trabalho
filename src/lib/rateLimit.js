import rateLimit from 'express-rate-limit';

// [2026-09] Rate limiting básico -- antes nenhuma rota tinha proteção contra
// abuso além do próprio ritmo de envio do WhatsApp (delay entre mensagens).
// Um token vazado/comprometido conseguia martelar disparo/importação/upload
// sem limite nenhum. Dois níveis:
//   - `limiteGeral`: aplicado em toda a API (server.js), baseline generoso
//     pra não incomodar uso normal (a tela de Clientes, por exemplo, dispara
//     várias chamadas seguidas ao carregar).
//   - `limiteSensivel`: mais apertado, só nas rotas de maior impacto se
//     abusadas (criar/disparar lote, importação em massa, upload de
//     arquivo) -- cada uma dessas gera trabalho pesado (disparo real de
//     mensagem, escrita em massa no banco/Storage) por requisição.
//
// Chave por usuario_id quando já autenticado nesse ponto da cadeia de
// middlewares (mais preciso que só IP -- vários operadores podem sair do
// mesmo IP de escritório), com fallback pro IP quando ainda não tem user
// (ex.: `limiteGeral` roda ANTES do requireAuth de cada rota).
//
// [LIMITAÇÃO CONHECIDA] Guarda contagem em memória do processo (padrão do
// express-rate-limit sem `store` customizado) -- mesma limitação já
// documentada em dispatchQueue.js/whatsapp.js: não é compartilhado entre
// instâncias se o backend algum dia escalar horizontalmente. Suficiente
// hoje (Render free tier roda 1 instância só); se isso mudar, precisa de um
// store compartilhado (ex.: Redis) pros limites valerem pro sistema
// inteiro, não por instância.
function chave(req) {
  return req.user?.id || req.ip;
}

export const limiteGeral = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: chave,
  message: { error: 'Muitas requisições em pouco tempo. Aguarde um pouco e tente de novo.' },
});

export const limiteSensivel = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: chave,
  message: { error: 'Muitas requisições em pouco tempo nesta operação. Aguarde um pouco e tente de novo.' },
});

// [2026-09] Relatado: "tô tentando importar um bocado de clientes mas dá
// esse erro antes de funcionar 'Muitas requisições em pouco tempo...'".
// Causa: Importar (planilha+zip) e o Extrator de Pix "opção 2" mandam 1
// requisição HTTP POR ARQUIVO (ver importacaoBrowser.ts/pix.tsx no front --
// upload em lotes de 10, até 3 em paralelo), não 1 ação isolada como
// disparar um lote ou mandar mensagem de teste. Uma importação legítima de
// algumas centenas de clientes passa das 30 requisições/5min de
// `limiteSensivel` bem antes de terminar -- o operador via o erro de rate
// limit no MEIO de uma importação normal, sem ter feito nada de errado.
// Rotas "1 arquivo por chamada dentro de um lote maior" usam este limitador
// à parte, bem mais alto (ainda finito -- não remove a proteção, só ajusta
// o teto pro volume real desse tipo de operação).
export const limiteImportacaoArquivo = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: chave,
  message: { error: 'Muitas requisições em pouco tempo nesta importação. Aguarde um pouco e tente de novo.' },
});
