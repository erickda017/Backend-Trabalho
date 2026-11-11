// Disparo / E-mail -- quais faturas entram no lote e quantas cabem na cota. PURO.
export const LIMITE_POR_LOTE = 300;

const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function casaBusca(linha, busca) {
  const q = semAcento(busca).trim();
  if (!q) return true;
  return [linha.nome, linha.email, linha.os_numero].some((c) => semAcento(c).includes(q));
}

// Ordem DETERMINÍSTICA da lista (e da seleção): vencimento mais próximo, depois nome, depois id.
export function ordenar(linhas) {
  const iso = (v) => String(v ?? '').split('/').reverse().join('-');
  return [...linhas].sort(
    (a, b) => iso(a.vencimento).localeCompare(iso(b.vencimento)) || semAcento(a.nome).localeCompare(semAcento(b.nome)) || String(a.cliente_id).localeCompare(String(b.cliente_id)),
  );
}

/**
 * @param {object[]} linhas  todas as faturas do usuário já avaliadas (campo `elegivel`)
 * @param {{modo:'ids'|'todos', ids?:string[], busca?:string, reenvio?:boolean}} pedido
 * @returns {{ selecionados: object[], totalFiltrado: number, truncado: boolean }}
 * `todos` = todas as ELEGÍVEIS dos resultados filtrados (inclusive de outras páginas), no máximo 300, aplicado no servidor.
 * `reenvio` (intencional): só com ids explícitos; perdoa só `ja_enviado` e `envio_incerto`, nenhum outro motivo.
 */
export function selecionar(linhas, { modo, ids = [], busca = '', reenvio = false }, limite = LIMITE_POR_LOTE) {
  const podeEntrar = (l) => l.elegivel || (reenvio && l.motivos.length > 0 && l.motivos.every((m) => m === 'ja_enviado' || m === 'envio_incerto'));
  let base = ordenar(linhas.filter((l) => casaBusca(l, busca)));
  if (modo === 'ids') {
    const pedidos = new Set(ids);
    base = base.filter((l) => pedidos.has(l.cliente_id));
  }
  const candidatos = base.filter((l) => podeEntrar(l) && (modo === 'ids' || !reenvio));
  return { selecionados: candidatos.slice(0, limite), totalFiltrado: candidatos.length, truncado: candidatos.length > limite };
}

/** Cota diária da conta Brevo (compartilhada entre operadores): o lote só cabe se solicitados <= disponível. */
export function calcularCota({ limite, usados, reservados, solicitados }) {
  const disponivel = Math.max(0, limite - usados - reservados);
  return { disponivel, cabe: solicitados <= disponivel, podeEnviar: Math.min(solicitados, disponivel) };
}
