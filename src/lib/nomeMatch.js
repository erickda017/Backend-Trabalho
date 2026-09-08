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

// Acha, numa lista de clientes `{ id, nome, ... }`, TODOS cujo nome bate
// (exato ou parcial) com `alvoNormalizado` (já normalizado por
// normalizarTexto/normalizarNomeArquivo). Mesmo critério em todo lugar:
// 1) igualdade exata tem prioridade -- se há qualquer exato, só eles contam
// (nunca mistura exato com parcial); 2) senão, um "contém" o outro (mínimo 3
// caracteres, evita casar qualquer coisa com nomes muito curtos tipo "Jo").
// [2026-09] Devolve a lista INTEIRA de candidatos (pode ter mais de 1 --
// duas pessoas diferentes com o mesmo nome é uma situação real, não um bug)
// em vez de já decidir qual usar; quem decide isso é `casarCliente` abaixo.
export function encontrarClientesPorNome(alvoNormalizado, clientes) {
  if (!alvoNormalizado) return [];

  const exatos = clientes.filter((c) => normalizarTexto(c.nome) === alvoNormalizado);
  if (exatos.length) return exatos;

  return clientes.filter((c) => {
    const nomeCliente = normalizarTexto(c.nome);
    return nomeCliente.length >= 3 && (alvoNormalizado.includes(nomeCliente) || nomeCliente.includes(alvoNormalizado));
  });
}

// [2026-09] Resolve UM cliente entre `clientes`, com o CONTRATO como
// critério PRINCIPAL de identificação quando disponível -- é isso que
// resolve duas pessoas de mesmo nome (mas contratos diferentes) sem
// conflito: se `numeroContrato` vier preenchido e bater com o
// `numero_contrato` de exatamente um cliente, é ele, nem olha pro nome.
//
// Nome só entra como fallback (quando não há contrato pra desempatar, ou
// nenhum cliente tem esse contrato ainda cadastrado), e só resolve sozinho
// se for INEQUÍVOCO: se mais de um cliente tiver esse nome, não adivinha
// (não faz sentido arriscar marcar o cliente errado como pago, ou anexar o
// boleto/Pix de uma pessoa na conta de outra) -- devolve `status: 'ambiguo'`
// em vez de chutar o primeiro da lista, que é o que a versão antiga deste
// arquivo fazia (`Array.find` sempre pegava só o primeiro, mesmo com 2+
// clientes de mesmo nome).
//
// Passe `nome` (texto solto, ex.: nome colado numa lista) OU `arquivo` (nome
// de arquivo de PDF, ex.: "joao_silva.pdf") -- nunca os dois; `arquivo` usa
// a normalização própria de nome de arquivo (remove ".pdf", trata -/_ como
// espaço).
export function casarCliente({ nome, arquivo, numeroContrato, clientes }) {
  const lista = clientes || [];

  if (numeroContrato != null) {
    const alvoContrato = String(numeroContrato).replace(/\D/g, '');
    if (alvoContrato) {
      // [2026-09] Antes usava `.find()` -- pegava o primeiro cliente com
      // esse contrato sem checar se havia mais de um (ex.: duplicata por
      // erro de digitação numa lista colada). O banco agora tem uma
      // constraint de unicidade em (usuario_id, numero_contrato) pra dado
      // NOVO (ver migration-22), mas dado antigo já cadastrado antes dela
      // ainda pode ter duplicata -- aqui trata do mesmo jeito que nome
      // duplicado: 2+ candidatos vira ambíguo, não adivinha.
      const candidatosPorContrato = lista.filter(
        (c) => c.numero_contrato && String(c.numero_contrato).replace(/\D/g, '') === alvoContrato,
      );
      if (candidatosPorContrato.length === 1) return { cliente: candidatosPorContrato[0], status: 'contrato' };
      if (candidatosPorContrato.length > 1) return { cliente: null, status: 'ambiguo', candidatos: candidatosPorContrato };
    }
  }

  const alvoNome = arquivo != null ? normalizarNomeArquivo(arquivo) : normalizarTexto(nome).replace(/\s+/g, ' ').trim();
  const candidatos = encontrarClientesPorNome(alvoNome, lista);
  if (candidatos.length === 1) return { cliente: candidatos[0], status: 'nome' };
  if (candidatos.length > 1) return { cliente: null, status: 'ambiguo', candidatos };
  return { cliente: null, status: 'nao_encontrado' };
}

// Wrappers simples (compat com quem só quer 1 cliente-ou-null, sem se
// importar com o motivo de não ter achado) -- usam `casarCliente` acima, que
// agora trata ambiguidade (2+ clientes de mesmo nome) como "não achou" em
// vez de chutar o primeiro.
export function casarClientePorNome(nome, clientes) {
  return casarCliente({ nome, clientes }).cliente;
}

export function casarClientePorArquivo(nomeArquivo, clientes) {
  return casarCliente({ arquivo: nomeArquivo, clientes }).cliente;
}
