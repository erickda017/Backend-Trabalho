// [2026-10] Helpers de log pra reduzir volume no Render SEM esconder erro.
//
// - `logDev(...)`: só fora de produção (diagnóstico detalhado, ex.: cada
//   evento do Baileys). Produção = RENDER definida ou NODE_ENV=production,
//   mesmo critério de server.js. `LOG_VERBOSE=true` reativa em produção
//   quando precisar investigar algo ao vivo.
// - `logLimitado(chave, nivel, ...args)`: pra logs que podem repetir em
//   rajada (erro de banco por evento/request, loop de reconexão). A 1ª
//   ocorrência de cada `chave` sai na hora; as seguintes dentro da janela
//   são só contadas, e a próxima que sair depois da janela leva
//   "(+N iguais suprimidas)". Nenhum erro some sem deixar rastro: no máximo
//   1 linha por chave por janela, com a contagem do que foi agrupado.
const emProducao = Boolean(process.env.RENDER) || process.env.NODE_ENV === 'production';
export const logVerboso = !emProducao || process.env.LOG_VERBOSE === 'true';

export function logDev(...args) {
  if (logVerboso) console.log(...args);
}

const JANELA_PADRAO_MS = 60 * 1000;
const MAX_CHAVES = 1000; // teto de memória -- chaves vêm de ids, não crescem sem limite na prática
const estado = new Map(); // chave -> { ultimoLog, suprimidas }

export function logLimitado(chave, nivel, ...args) {
  const agora = Date.now();
  const janelaMs = JANELA_PADRAO_MS;
  const e = estado.get(chave);
  if (e && agora - e.ultimoLog < janelaMs) {
    e.suprimidas++;
    return;
  }
  const suprimidas = e?.suprimidas || 0;
  if (!e && estado.size >= MAX_CHAVES) estado.delete(estado.keys().next().value);
  estado.set(chave, { ultimoLog: agora, suprimidas: 0 });
  const fn = console[nivel] || console.log;
  if (suprimidas) fn(...args, `(+${suprimidas} iguais suprimidas no último minuto)`);
  else fn(...args);
}

export function _resetarLogLimitado() {
  estado.clear();
}
