// Disparo / E-mail -- quem pode entrar no lote. PURO (sem banco/rede): a rota e o worker só montam as entradas.
// Regra padrão (todas precisam valer): e-mail válido, valor, vencimento FUTURO dentro da janela de envio, PDF vinculado
// pelo fluxo que valida OS+nome+vencimento, status do EnnyChat na lista de aceitos E verificado recentemente, e nenhum
// envio aceito antes (reenvio é intencional e fica fora da seleção padrão).

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
  vencida: 'Fatura vencida ou vencendo hoje',
  fora_da_janela: 'Fora do período de envio',
  sem_pdf_validado: 'PDF não vinculado (OS, nome e vencimento)',
  status_bloqueado: 'Status do EnnyChat não aceito',
  status_desatualizado: 'Status do EnnyChat precisa ser verificado (abra Tratar)',
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
 * @param {string} p.hoje  YYYY-MM-DD (fuso da operação)
 * @param {number} p.janelaDias  envia só se faltam entre 1 e janelaDias dias
 * @param {number} p.statusMaxIdadeH
 * @param {number} p.agoraMs
 * @returns {{ elegivel: boolean, motivos: string[] }}
 */
export function avaliarElegibilidade({ cliente, pdfValidado, aceitos = 0, incertos = 0, ativo = false, statusAceitos, hoje, janelaDias, statusMaxIdadeH, agoraMs }) {
  const motivos = [];
  if (!emailValido(cliente?.email)) motivos.push('email_invalido');
  if (!(Number(cliente?.valor) > 0)) motivos.push('sem_valor');

  const iso = vencimentoParaIso(cliente?.vencimento);
  if (!iso) motivos.push('sem_vencimento');
  else {
    const dias = diasEntre(hoje, iso);
    if (dias < 1) motivos.push('vencida');
    else if (dias > janelaDias) motivos.push('fora_da_janela');
  }

  if (!pdfValidado || !cliente?.pdf_path) motivos.push('sem_pdf_validado');

  // Política de status: lista de permissão vigente + status verificado há pouco (o worker não tem a sessão do EnnyChat).
  const st = cliente?.ennychat_status;
  if (!st || !Array.isArray(statusAceitos) || !statusAceitos.includes(st)) motivos.push('status_bloqueado');
  else {
    const em = cliente?.ennychat_status_em ? Date.parse(cliente.ennychat_status_em) : NaN;
    if (!Number.isFinite(em) || agoraMs - em > statusMaxIdadeH * 3_600_000) motivos.push('status_desatualizado');
  }

  if (aceitos > 0) motivos.push('ja_enviado');
  // Pode ter sido aceito pela Brevo sem registro (queda entre o 201 e o banco): NUNCA reaparece como elegível sozinho.
  else if (incertos > 0) motivos.push('envio_incerto');
  if (ativo) motivos.push('envio_em_andamento');
  return { elegivel: motivos.length === 0, motivos };
}
