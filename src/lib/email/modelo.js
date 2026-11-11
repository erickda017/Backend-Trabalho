// Disparo / E-mail -- corpo HTML da fatura. O HTML vive no repo (src/templates/modelo_email_fatura_brevo.html) e é
// renderizado AQUI, no servidor, com os valores escapados (nunca passa HTML de dado pessoal sem escape).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARQUIVO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../templates/modelo_email_fatura_brevo.html');
let cache = null;
const modelo = () => (cache ??= fs.readFileSync(ARQUIVO, 'utf8'));

export const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Valor em reais ("R$ 99,99"). Aceita number ou numeric-string.
export function formatarValor(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '';
}

// "2026-10-15" -> "15/10/2026"
export const formatarDataIso = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '') ? iso.split('-').reverse().join('/') : '');

// Referência = mês do vencimento ("Outubro de 2026"). [VALIDAR] o EnnyChat tem `mes_referencia` próprio; hoje não é sincronizado.
export function mesReferencia(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso ?? '');
  if (!m) return '';
  const nome = MESES[Number(m[2]) - 1] ?? '';
  return nome ? `${nome[0].toUpperCase()}${nome.slice(1)} de ${m[1]}` : '';
}

export function primeiroNome(nome) {
  const p = String(nome ?? '').trim().split(/\s+/)[0] ?? '';
  return p ? p[0].toLocaleUpperCase('pt-BR') + p.slice(1).toLocaleLowerCase('pt-BR') : 'cliente';
}

const MENSAGEM_ANTES = 'Enviamos sua fatura com antecedência para você consultá-la antes do vencimento.';
const MENSAGEM_ATRASO = 'Sua fatura está disponível para consulta. Confira o vencimento e as opções de pagamento no PDF anexado.';

/** Frase do e-mail conforme a situação: vencimento já passou (atraso) ou ainda não. Datas "AAAA-MM-DD". */
export const mensagemFatura = (vencimentoIso, hojeIso) => (vencimentoIso && hojeIso && vencimentoIso < hojeIso ? MENSAGEM_ATRASO : MENSAGEM_ANTES);

/** Renderiza o e-mail. `dados`: { empresa, primeiro_nome, mes_referencia, vencimento, valor, mensagem } (texto puro; é escapado aqui). */
export function renderizarEmail(dados) {
  const d = { mensagem: MENSAGEM_ANTES, ...dados };
  return modelo().replace(/\{\{\s*params\.(\w+)\s*\}\}/g, (_, chave) => escapeHtml(d[chave] ?? ''));
}

export const assuntoFatura = (mes) => `Sua fatura Claro${mes ? ` de ${mes}` : ''}`;
