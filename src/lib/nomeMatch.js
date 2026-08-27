// Espelho, no backend, de frontend/src/lib/clienteMatch.ts -- mesma lógica de
// normalização/casamento de nome, usada em fluxos que rodam no servidor (não
// têm a lista de clientes já em memória no navegador pra comparar), como:
//   - Importação de clientes PAGOS por lista de nomes colada (ver
//     routes/clientes.routes.js, POST /importar-pagos).
//   - Associação automática de faturas avulsas pendentes assim que o cliente
//     correspondente aparece (ver lib/faturasPendentes.js).
// Mantida como uma função pura (sem I/O) igual a original, pra ficar fácil
// comparar as duas se uma precisar de ajuste no futuro -- NÃO deixar as duas
// divergirem sem motivo.

export function normalizarTexto(str) {
  return String(str ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function normalizarNomeArquivo(nomeArquivo) {
  return normalizarTexto(nomeArquivo)
    .replace(/\.pdf$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Acha, numa lista de clientes `{ id, nome, ... }`, aquele cujo nome bate
// (exato ou parcial) com `alvoNormalizado` (já normalizado por
// normalizarTexto/normalizarNomeArquivo). Mesmo critério em todo lugar:
// 1) igualdade exata; 2) um "contém" o outro (mínimo 3 caracteres, evita
// casar qualquer coisa com nomes muito curtos tipo "Jo").
export function casarPorTextoNormalizado(alvoNormalizado, clientes) {
  if (!alvoNormalizado) return null;

  const exato = clientes.find((c) => normalizarTexto(c.nome) === alvoNormalizado);
  if (exato) return exato;

  const parcial = clientes.find((c) => {
    const nomeCliente = normalizarTexto(c.nome);
    return nomeCliente.length >= 3 && (alvoNormalizado.includes(nomeCliente) || nomeCliente.includes(alvoNormalizado));
  });
  return parcial ?? null;
}

export function casarClientePorNome(nome, clientes) {
  return casarPorTextoNormalizado(normalizarTexto(nome).replace(/\s+/g, ' ').trim(), clientes);
}

export function casarClientePorArquivo(nomeArquivo, clientes) {
  return casarPorTextoNormalizado(normalizarNomeArquivo(nomeArquivo), clientes);
}
