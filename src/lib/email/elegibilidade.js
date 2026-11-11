// Disparo / E-mail -- quem pode entrar no lote. PURO (sem banco/rede): a rota e o worker só montam as entradas.
// Regra (todas precisam valer): e-mail válido, valor, vencimento válido (qualquer data: cliente atrasado também recebe),
// PDF vinculado pelo fluxo que valida OS+nome+vencimento, status do EnnyChat na lista de aceitos, e nenhum envio
// aceito antes (reenvio é intencional e fica fora da seleção padrão).

const EMAIL_RE = /^[^\s@,;<>"']{1,64}@[^\s@,;<>"']+\.[^\s@,;<>"']{2,}$/; // sem aspas/vírgula/<>: a Brevo recusaria
export const emailValido = (v) => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim());

// Data civil de hoje no fuso da operação (YYYY-MM-DD). "Fuso da operação" = Brasília.
export function hojeBrt(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

// "10/08/2026" (formato do site) -> "2026-08-10"; inválida -> null.
export function vencimentoParaIso(v) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const [d, mes, a] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(a, mes - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== mes - 1 || dt.getUTCDate() !== d) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function diasEntre(isoDe, isoAte) {
  return Math.round((Date.parse(`${isoAte}T00:00:00Z`) - Date.parse(`${isoDe}T00:00:00Z`)) / 86_400_000);
}

// Motivos (códigos curtos, sem dado pessoal). Os "pendentes" aparecem na gestão, separados da seleção padrão.
export const MOTIVOS = {
  email_invalido: 'E-mail ausente ou inválido',
  sem_valor: 'Sem valor',
  sem_vencimento: 'Sem vencimento válido',
  sem_pdf_validado: 'PDF não vinculado (OS, nome e vencimento)',
  status_bloqueado: 'Status do EnnyChat não aceito',
  ja_enviado: 'Já enviado',
  envio_incerto: 'Envio anterior sem confirmação (confira na Brevo antes de reenviar)',
  envio_em_andamento: 'Envio em andamento',
};

/**
 * @param {object} p
 * @param {object} p.cliente  linha de `clientes` (nome, email, valor, vencimento, pdf_path, ennychat_status, ennychat_status_em)
 * @param {boolean} p.pdfValidado  existe ennychat_anexos 'vinculado' cujo pdf_path == clientes.pdf_path
 * @param {number} p.aceitos  quantas vezes esta fatura já foi ACEITA para envio
 * @param {number} p.incertos  envios cujo resultado ficou incerto (interrompido / erro após o envio / sem confirmação)
 * @param {boolean} p.ativo  há envio na fila/processando
 * @param {string[]} p.statusAceitos
 * @returns {{ elegivel: boolean, motivos: string[] }}
 */
export function avaliarElegibilidade({ cliente, pdfValidado, aceitos = 0, incertos = 0, ativo = false, statusAceitos }) {
  const motivos = [];
  if (!emailValido(cliente?.email)) motivos.push('email_invalido');
  if (!(Number(cliente?.valor) > 0)) motivos.push('sem_valor');

  if (!vencimentoParaIso(cliente?.vencimento)) motivos.push('sem_vencimento');

  if (!pdfValidado || !cliente?.pdf_path) motivos.push('sem_pdf_validado');

  // Política de status: lista de permissão vigente (lista vazia ou status fora dela = não entra).
  const st = cliente?.ennychat_status;
  if (!st || !Array.isArray(statusAceitos) || !statusAceitos.includes(st)) motivos.push('status_bloqueado');

  if (aceitos > 0) motivos.push('ja_enviado');
  // Pode ter sido aceito pela Brevo sem registro (queda entre o 201 e o banco): NUNCA reaparece como elegível sozinho.
  else if (incertos > 0) motivos.push('envio_incerto');
  if (ativo) motivos.push('envio_em_andamento');
  return { elegivel: motivos.length === 0, motivos };
}
