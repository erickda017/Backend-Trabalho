import { normalizarTelefone } from './telefone.js';

// [2026-10] "Disparo só pra números" (tela Disparos -> "Colar números"):
// lista de telefones soltos, SEM cliente cadastrado. Cada número vira um
// envio_item com cliente_id = null e o número em `telefone_usado` (coluna
// já existente desde a migration-25 -- sem migration nova). O dispatchQueue
// trata item sem cliente como contato avulso (ver enviarItem).
//
// Aceita o que vier colado: um número por linha, ou separados por vírgula,
// ponto e vírgula ou tab, com ou sem formatação ("(11) 99999-9999",
// "+55 11 99999-9999", "5511999999999"). Devolve os válidos já
// normalizados (55 + DDD + número), sem repetidos, e os inválidos como
// vieram (pra tela mostrar).
export const MAX_TELEFONES_AVULSOS = 5000;

export function normalizarListaTelefones(entrada) {
  const brutos = Array.isArray(entrada)
    ? entrada.map((t) => String(t ?? ''))
    : String(entrada ?? '').split(/[\n\r,;\t]+/);
  const validos = [];
  const invalidos = [];
  const vistos = new Set();
  let repetidos = 0;
  for (const bruto of brutos) {
    const texto = bruto.trim();
    if (!texto) continue;
    const tel = normalizarTelefone(texto);
    // BR: 55 + DDD (2) + 8 ou 9 dígitos = 12 ou 13. Outros países: até 15 (E.164).
    const ok = /^\d{12,15}$/.test(tel) && (!tel.startsWith('55') || tel.length <= 13) && !/^55(0|1[^1-9])/.test(tel);
    if (!ok) {
      invalidos.push(texto);
      continue;
    }
    if (vistos.has(tel)) {
      repetidos++;
      continue;
    }
    vistos.add(tel);
    validos.push(tel);
  }
  return { validos, invalidos, repetidos };
}
