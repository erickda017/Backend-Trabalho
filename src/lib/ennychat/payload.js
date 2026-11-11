// Integração EnnyChat -- validação e conversão do que a extensão manda (fronteira
// de confiança). Tudo PURO (sem banco, sem rede), por isso testável direto.
// Regra de ouro: lista branca de campos. O que não está aqui é DESCARTADO --
// nunca chega ao banco (CPF, endereço, responsável, resposta bruta etc.).
import { normalizarTelefone, normalizarVariantes } from '../telefone.js';
import { normalizarTexto } from '../nomeMatch.js';

const ID_EXTERNO_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ALTERNATIVOS = 10;

// OS vira valor de filtro no banco: só caracteres de OS (outro formato => sem OS, nunca chuta).
const osValida = (v) => (v && /^[0-9A-Za-z/._-]+$/.test(v) ? v : null);

// "AAAA-MM-DD" de calendário real (coluna `date` do banco); senão null.
const dataIsoValida = (v) => {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim()) : null;
  return m && formatarDataCivil(Number(m[1]), Number(m[2]), Number(m[3])) ? v.trim() : null;
};

export const idExternoValido = (v) => typeof v === 'string' && ID_EXTERNO_RE.test(v);

const textoOuNull = (v, max) => {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
};

// Data de calendário REAL (ano 2000-2100) -> "DD/MM/AAAA" (formato do site), senão null.
export function formatarDataCivil(a, mes, d) {
  const data = new Date(Date.UTC(a, mes - 1, d));
  const real = data.getUTCFullYear() === a && data.getUTCMonth() === mes - 1 && data.getUTCDate() === d;
  if (!real || a < 2000 || a > 2100) return null;
  return `${String(d).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${a}`;
}

// "2026-08-10" -> "10/08/2026" (clientes.vencimento). Só exatamente YYYY-MM-DD
// (nada de adivinhar DD/MM vs MM/DD).
export function converterVencimento(v) {
  if (v === null || v === undefined || v === '') return { ok: true, valor: null };
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim()) : null;
  const valor = m ? formatarDataCivil(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  return valor ? { ok: true, valor } : { ok: false };
}

// "150.00" (ponto decimal, contrato) ou 150 -> Number. "150,00" simples também passa;
// "1.234,56" (milhar BR) NÃO: ambíguo, recusa em vez de chutar.
export function converterValor(v) {
  if (v === null || v === undefined || v === '') return { ok: true, valor: null };
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'string' ? v.trim() : '';
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return { ok: false };
  return { ok: true, valor: Number(s) };
}

// Lista de permissão: lista vazia, status ausente ou fora da lista => nada entra.
// Compara o código EXATO (sem trim/caixa): "não invente códigos a partir do texto".
export function avaliarStatus(statusOperador, aceitos) {
  if (typeof statusOperador !== 'string' || !statusOperador.trim()) return { permitido: false, motivo: 'status_ausente' };
  if (!Array.isArray(aceitos) || aceitos.length === 0) return { permitido: false, motivo: 'lista_vazia' };
  return aceitos.includes(statusOperador)
    ? { permitido: true, motivo: null }
    : { permitido: false, motivo: 'status_fora_da_lista' };
}

// [VALIDAR] significado de `encerrado`/`status_pagamento` no EnnyChat. Hoje: encerrado === true,
// ou status_pagamento que diga "pago/quitado/liquidado/baixado" SEM negação ("não pago",
// "pendente", "a pagar", "aguardando"...) => não importa, vai pra revisão.
export function pagoOuEncerrado({ encerrado, status_pagamento: statusPagamento }) {
  if (encerrado === true) return true;
  const t = normalizarTexto(statusPagamento);
  if (!t) return false;
  if (/\b(nao|pendente|aguardando|a pagar|em aberto|vencid[oa])\b/.test(t)) return false;
  return /\b(pago|paga|quitad[oa]|liquidad[oa]|baixad[oa]|pagamento confirmado)\b/.test(t);
}

function telefoneValido(v) {
  const t = normalizarTelefone(typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  return /^55\d{10,11}$/.test(t) ? t : null;
}

// Alternativos: sem repetir o principal (nem a variante com/sem 9º dígito), sem repetir entre si.
function listaAlternativos(brutos, principal, normalizar, mesmo) {
  const saida = [];
  for (const b of Array.isArray(brutos) ? brutos.slice(0, MAX_ALTERNATIVOS * 2) : []) {
    const n = normalizar(b);
    if (!n || (principal && mesmo(n, principal)) || saida.some((s) => mesmo(s, n))) continue;
    saida.push(n);
    if (saida.length >= MAX_ALTERNATIVOS) break;
  }
  return saida;
}

const emailValido = (v) => {
  const t = textoOuNull(v, 254)?.toLowerCase();
  return t && EMAIL_RE.test(t) ? t : null;
};

// Slug de operadora do EnnyChat ("desktop", "claro-fenix", "claro-bg", "claro-mega"...): só minúsculas, dígitos e hífen.
const operadoraValida = (v) => {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9-]{1,39}$/.test(t) ? t : null;
};

// Pix copia-e-cola bruto (a VALIDADE — CRC — é conferida no servidor com isValidPixPayload).
const pixBruto = (v) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t.length >= 20 && t.length <= 800 && /^[ -~]+$/.test(t) ? t : null;
};

// Todas as faturas da ficha (Fatura 1, Fatura 2...). Lista branca: só o necessário. Item inválido é descartado.
const MAX_FATURAS = 12;
function listaFaturas(brutas) {
  const saida = [];
  for (const b of Array.isArray(brutas) ? brutas.slice(0, MAX_FATURAS) : []) {
    if (!b || typeof b !== 'object') continue;
    const id = typeof b.id === 'number' ? String(b.id) : b.id;
    if (!idExternoValido(id)) continue;
    const valor = converterValor(b.valor);
    saida.push({
      id,
      posicao: Number.isInteger(b.posicao) && b.posicao >= 0 && b.posicao <= 1000 ? b.posicao : null,
      mes_referencia: dataIsoValida(b.mes_referencia),
      vencimento: dataIsoValida(b.vencimento),
      valor: valor.ok ? valor.valor : null,
      status_pagamento: textoOuNull(b.status_pagamento, 60),
      data_pagamento: dataIsoValida(b.data_pagamento),
      codigo_pix: pixBruto(b.codigo_pix),
    });
  }
  return saida;
}

const mesmoTelefone = (a, b) => normalizarVariantes(a).some((v) => normalizarVariantes(b).includes(v));

// Corpo de POST /faturas/sync -> { ok:true, chaveOperacao, fatura } | { ok:false, campo }.
// `campo` é só o NOME do campo (nunca o valor: pode ser dado pessoal).
export function validarFatura(body) {
  const f = body?.fatura;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return { ok: false, campo: 'fatura' };

  const chaveOperacao = textoOuNull(body.chave_operacao, 100);
  if (!chaveOperacao) return { ok: false, campo: 'chave_operacao' };

  const idExterno = typeof f.id_externo === 'number' ? String(f.id_externo) : f.id_externo;
  if (!idExternoValido(idExterno)) return { ok: false, campo: 'id_externo' };

  const status = typeof f.status_operador === 'string' ? f.status_operador : null;
  if (!status || !status.trim() || status.length > 100) return { ok: false, campo: 'status_operador' };

  const nome = textoOuNull(typeof f.cliente_nome === 'string' ? f.cliente_nome.replace(/\s+/g, ' ') : null, 200);
  if (!nome) return { ok: false, campo: 'cliente_nome' };

  const venc = converterVencimento(f.vencimento);
  if (!venc.ok) return { ok: false, campo: 'vencimento' };
  const valor = converterValor(f.valor);
  if (!valor.ok) return { ok: false, campo: 'valor' };

  const telefone = telefoneValido(f.cliente_telefone);
  const email = emailValido(f.cliente_email);

  return {
    ok: true,
    chaveOperacao,
    fatura: {
      id_externo: idExterno,
      status_operador: status,
      os_numero: osValida(textoOuNull(f.venda_os, 50)), // texto: zeros à esquerda preservados
      // Campos que o site recebia da lista crua: contrato (= OS), tipo da fatura (1ª = FPD, 2ª = SPD) e prazo (safra).
      tipo_fatura: f.posicao === 1 ? 'FPD' : f.posicao === 2 ? 'SPD' : null,
      data_prazo: dataIsoValida(f.prazo_data),
      nome,
      email,
      telefone,
      vencimento: venc.valor,
      valor: valor.valor,
      status_pagamento: textoOuNull(f.status_pagamento, 60),
      encerrado: f.encerrado === true,
      posicao: Number.isInteger(f.posicao) && f.posicao >= 0 && f.posicao <= 1000 ? f.posicao : null,
      alternativos: {
        telefones: listaAlternativos(f.cliente_telefones, telefone, telefoneValido, mesmoTelefone),
        emails: listaAlternativos(f.cliente_emails, email, emailValido, (a, b) => a === b),
      },
      // Operadora do cliente (nunca misturar BG com Mega, Desktop com Claro...) e todas as faturas da ficha.
      operadora: operadoraValida(f.operadora_slug),
      codigo_pix: pixBruto(f.codigo_pix), // Pix da fatura corrente (operadoras sem PDF, ex.: Desktop)
      data_pagamento: dataIsoValida(f.data_pagamento),
      faturas: listaFaturas(f.faturas),
    },
  };
}

// Campos de texto do multipart do anexo -> { ok:true, anexoId, statusOperador, valor, vencimento } | { ok:false, campo }.
export function validarCamposAnexo(campos) {
  const anexoId = textoOuNull(campos?.anexo_id, 100);
  if (!anexoId) return { ok: false, campo: 'anexo_id' };
  const status = typeof campos.status_operador === 'string' ? campos.status_operador : null;
  if (!status || !status.trim() || status.length > 100) return { ok: false, campo: 'status_operador' };
  const valor = converterValor(campos.valor);
  if (!valor.ok) return { ok: false, campo: 'valor' };
  const venc = converterVencimento(campos.vencimento);
  if (!venc.ok) return { ok: false, campo: 'vencimento' };
  const origem = campos.origem === 'upload' ? 'upload' : 'download'; // 'upload' = original enviado pelo operador (maior qualidade)
  return { ok: true, anexoId, statusOperador: status, valor: valor.valor, vencimento: venc.valor, origem };
}

// Itens de POST /catalogo -> lista saneada (descarta item inválido), ou null se o formato for inválido.
export function validarItensCatalogo(itens) {
  if (!Array.isArray(itens) || itens.length > 200) return null;
  const saida = new Map();
  for (const i of itens) {
    if (!i || typeof i.codigo !== 'string' || !i.codigo.trim() || i.codigo.length > 100 || /[\u0000-\u001f\u007f]/.test(i.codigo)) continue;
    const rotulo = textoOuNull(i.rotulo, 100) || i.codigo.trim();
    saida.set(i.codigo, { codigo: i.codigo, rotulo: rotulo.replace(/[\u0000-\u001f\u007f]/g, '') });
  }
  return [...saida.values()];
}
