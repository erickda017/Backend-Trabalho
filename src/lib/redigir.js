// [2026-10] SEGURANÇA: nenhum dado de cliente pode ir parar no log do Render
// (telefone, e-mail, CPF/CNPJ, Pix copia-e-cola, token, jid do WhatsApp).
// `redigir()` mascara esses padrões em qualquer texto/objeto; `instalarLogSeguro()`
// aplica isso a TODO console.* do processo, então um `console.error('...', err)`
// esquecido numa rota nova também sai mascarado. `descreverErro()` é o jeito
// certo de logar um erro (sem payload/linha do banco que o SDK anexa).
import { inspect } from 'node:util';

const PADROES = [
  // JWT (3 blocos base64url) e Bearer
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, '[jwt]'],
  [/\bBearer\s+[\w.~+/=-]{8,}/gi, 'Bearer [token]'],
  // Pix copia-e-cola (payload EMV começa com 000201) e chave aleatória
  [/000201[\w .\-*/@:+=]{40,}/g, '[pix]'],
  // jid do WhatsApp: 5511999999999@s.whatsapp.net / ...@lid
  [/\b\d{8,20}(?::\d+)?@(?:s\.whatsapp\.net|lid|g\.us|c\.us)\b/g, '[jid]'],
  // e-mail
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[email]'],
  // CNPJ / CPF (com ou sem pontuação)
  [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[cnpj]'],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[cpf]'],
  // telefone BR com DDI (55 + DDD + 8/9 dígitos) ou formatado
  [/(?<!\d)\+?55\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}(?!\d)/g, '[tel]'],
  [/(?<!\d)\(?\d{2}\)\s?9?\d{4}[-\s]?\d{4}(?!\d)/g, '[tel]'],
];

export function redigirTexto(texto) {
  let s = String(texto);
  for (const [re, sub] of PADROES) s = s.replace(re, sub);
  return s;
}

// Mascara string; objeto/erro vira texto (inspect, profundidade curta) e é mascarado.
export function redigir(valor) {
  if (typeof valor === 'string') return redigirTexto(valor);
  if (valor == null || typeof valor === 'number' || typeof valor === 'boolean') return valor;
  if (valor instanceof Error) return redigirTexto(descreverErro(valor));
  return redigirTexto(inspect(valor, { depth: 2, breakLength: 160, maxStringLength: 300, maxArrayLength: 10 }));
}

// Erro -> "Nome [código]: mensagem" sem `details`/`hint`/`row` (o PostgREST e o
// Postgres colocam o valor da linha em "Key (telefone)=(...)").
export function descreverErro(err) {
  if (!err) return 'erro desconhecido';
  const partes = [err.name && err.name !== 'Error' ? err.name : null, err.code ? `[${err.code}]` : null].filter(Boolean);
  const msg = redigirTexto(String(err.message ?? err).slice(0, 300));
  return `${partes.length ? `${partes.join(' ')}: ` : ''}${msg}`;
}

let instalado = false;
export function instalarLogSeguro(alvo = console) {
  if (instalado) return;
  instalado = true;
  for (const nivel of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = alvo[nivel]?.bind(alvo);
    if (!original) continue;
    alvo[nivel] = (...args) => original(...args.map(redigir));
  }
}

export function _resetarParaTeste() {
  instalado = false;
}
