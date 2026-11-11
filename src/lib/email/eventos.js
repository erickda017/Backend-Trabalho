// Disparo / E-mail -- eventos do webhook transacional da Brevo -> estado do envio. PURO.
// Regras: duplicata é inofensiva; evento fora de ordem nunca rebaixa um estado já confirmado.

// Ordem dos estados: só avança. 'entregue' (30) não volta para 'aceito' (20) por causa de um "deferred" atrasado.
const RANK = { na_fila: 0, processando: 10, aceito: 20, entregue: 30, devolvido: 40, falhou: 40 };

// Evento da Brevo -> { status, motivo } (ou null = ignorar: abertura/clique/descadastro não mudam a entrega).
const MAPA = {
  request: { status: 'aceito', motivo: null },
  deferred: { status: 'aceito', motivo: 'adiado' },
  delivered: { status: 'entregue', motivo: null },
  soft_bounce: { status: 'devolvido', motivo: 'soft_bounce' },
  hard_bounce: { status: 'devolvido', motivo: 'hard_bounce' },
  blocked: { status: 'falhou', motivo: 'bloqueado' },
  invalid_email: { status: 'falhou', motivo: 'email_invalido' },
  error: { status: 'falhou', motivo: 'erro_provedor' },
  spam: { status: 'falhou', motivo: 'spam' },
  complaint: { status: 'falhou', motivo: 'spam' },
};

export const estadoDoEvento = (evento) => MAPA[String(evento ?? '').toLowerCase()] ?? null;

// messageId aparece com e sem <...> conforme a origem: compara sem os sinais.
export const normalizarMessageId = (v) => String(v ?? '').trim().replace(/^<|>$/g, '');

// Instante do evento em ms (ts em segundos, ts_event/ts_epoch, ou date ISO); null se não houver.
export function instanteDoEvento(ev) {
  const n = Number(ev?.ts_epoch ?? ev?.ts_event ?? ev?.ts);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n; // segundos ou milissegundos
  const d = Date.parse(ev?.date ?? '');
  return Number.isFinite(d) ? d : null;
}

/**
 * @param {{status:string, evento_em:string|null}} atual  linha do envio
 * @param {object} ev evento bruto da Brevo
 * @returns {null | {status:string, motivo:string|null, evento_em:string}}  null = nada a gravar
 */
export function aplicarEvento(atual, ev) {
  const novo = estadoDoEvento(ev?.event);
  if (!novo || !(atual?.status in RANK)) return null;
  if (!['aceito', 'entregue', 'devolvido', 'falhou', 'processando'].includes(atual.status)) return null; // na fila/cancelado: não recebeu nada do provedor
  const quando = instanteDoEvento(ev);
  if (quando !== null && atual.evento_em && quando < Date.parse(atual.evento_em)) return null; // evento antigo
  if (RANK[novo.status] < RANK[atual.status]) return null; // nunca rebaixa
  if (novo.status === atual.status && !novo.motivo) return null; // repetição do mesmo estado
  return { status: novo.status, motivo: novo.motivo, evento_em: new Date(quando ?? Date.now()).toISOString() };
}
