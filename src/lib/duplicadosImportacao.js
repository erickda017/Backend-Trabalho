// [2026-10] Importação de lista só ADICIONA o que é novo: cliente que já está
// cadastrado (mesmo telefone OU mesmo contrato, os dois identificadores
// fortes) é pulado, nunca regravado nem duplicado -- reimportar a mesma lista
// duas vezes não muda nada. Nome sozinho NÃO conta como duplicata: uma pessoa
// com 2 números vem como 2 linhas de mesmo nome, e dois clientes diferentes
// podem ter o mesmo nome (por isso o contrato é o critério, ver nomeMatch.js).
export function digitosContrato(contrato) {
  const d = String(contrato ?? '').replace(/\D/g, '');
  return d || null;
}

export function criarIndiceDuplicados(existentes = []) {
  const telefones = new Set();
  const contratos = new Set();

  function registrar(telefone, contrato) {
    if (telefone) telefones.add(telefone);
    const c = digitosContrato(contrato);
    if (c) contratos.add(c);
  }
  for (const e of existentes) registrar(e.telefone, e.numero_contrato);

  return {
    // Devolve o motivo (texto) se for duplicata, ou null se é novo.
    motivo(telefone, contrato) {
      if (telefone && telefones.has(telefone)) return 'telefone já cadastrado';
      const c = digitosContrato(contrato);
      if (c && contratos.has(c)) return 'contrato já cadastrado';
      return null;
    },
    // Chamar depois de inserir: o mesmo item repetido no mesmo lote vira duplicata.
    registrar,
  };
}
