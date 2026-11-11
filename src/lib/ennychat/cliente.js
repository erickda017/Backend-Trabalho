// Integração EnnyChat -- qual cliente do site recebe a fatura, e o que gravar nele.
// PURO (a busca no banco entra por injeção: `buscar`), por isso testável sem Supabase.
//
// Ordem de busca (contrato): ennychat_fatura_id -> os_numero -> telefone (com variantes do 9º dígito).
// Todas SEMPRE dentro da carteira do usuário autenticado (a função `buscar` filtra por usuario_id).
// Mais de um candidato => ambíguo (nada é criado nem alterado). Cliente existente só recebe campo
// que estava VAZIO; divergência volta em `conflitos` e NUNCA sobrescreve.
import { normalizarVariantes } from '../telefone.js';
import { nomeCanonico, osDoCodigo, vencimentoCanonico } from './vinculo.js';

// buscar(criterio, valor) -> Promise<cliente[]>
//   'ennychat_fatura_id' (texto) | 'os_numero' (texto, campanha cobranca) | 'telefone' (string[] de variantes, campanha cobranca)
export async function escolherCliente(fatura, buscar) {
  const consultas = [
    ['ennychat_fatura_id', fatura.id_externo],
    ['os_numero', fatura.os_numero],
    // clientes vindos da lista crua guardam a OS como contrato (às vezes sem zeros à esquerda / sem prefixo)
    ['numero_contrato', fatura.os_numero ? [...new Set([fatura.os_numero, osDoCodigo(fatura.os_numero)].filter(Boolean))] : null],
    ['telefone', fatura.telefone ? normalizarVariantes(fatura.telefone) : null],
  ];
  for (const [criterio, valor] of consultas) {
    if (!valor || (Array.isArray(valor) && !valor.length)) continue;
    const achados = await buscar(criterio, valor);
    if (achados.length === 1) return { tipo: 'unico', por: criterio, cliente: achados[0] };
    if (achados.length > 1) return { tipo: 'ambiguo', por: criterio };
  }
  return { tipo: 'nenhum' };
}

const vazio = (v) => v === null || v === undefined || v === '';
const temAlternativos = (a) => a.telefones.length > 0 || a.emails.length > 0;

// -> { acao: 'pendente', motivo }
//  | { acao: 'criar', linha }
//  | { acao: 'atualizar', cliente, campos, camposFatura, conflitos }
// `campos` = colunas comuns; `camposFatura` = valor/vencimento (gravados via propagarDadosFatura,
// que espelha no grupo de números vinculados).
export function planejarSync({ usuarioId, fatura, escolha, agora }) {
  if (escolha.tipo === 'ambiguo') return { acao: 'pendente', motivo: 'alvo_ambiguo' };

  const status = { ennychat_status: fatura.status_operador, ennychat_status_em: agora };

  if (escolha.tipo === 'nenhum') {
    if (!fatura.telefone) return { acao: 'pendente', motivo: 'telefone_invalido' };
    return {
      acao: 'criar',
      linha: {
        usuario_id: usuarioId, // sempre o autenticado -- `responsavel` do EnnyChat é ignorado
        campanha: 'cobranca',
        nome: fatura.nome,
        telefone: fatura.telefone,
        email: fatura.email,
        os_numero: fatura.os_numero,
        numero_contrato: fatura.os_numero,
        tipo_fatura: fatura.tipo_fatura,
        data_prazo: fatura.data_prazo,
        importado_em: agora,
        valor: fatura.valor,
        vencimento: fatura.vencimento,
        ennychat_fatura_id: fatura.id_externo,
        contatos_alternativos: temAlternativos(fatura.alternativos) ? fatura.alternativos : null,
        ...status,
      },
    };
  }

  const c = escolha.cliente;
  // Achado por OS/telefone mas já amarrado a OUTRA fatura do EnnyChat: não reaproveita.
  if (!vazio(c.ennychat_fatura_id) && c.ennychat_fatura_id !== fatura.id_externo) {
    return { acao: 'pendente', motivo: 'outra_fatura' };
  }

  // Achado por OS/telefone (não pelo ID da fatura) com OUTRO nome: pode ser telefone compartilhado
  // (família). Não cola a fatura nesse cadastro nem grava nada.
  if (escolha.por !== 'ennychat_fatura_id' && nomeCanonico(c.nome) !== nomeCanonico(fatura.nome)) {
    return { acao: 'pendente', motivo: 'nome_divergente_cadastro' }; // não é o PDF: é o cadastro (ex.: telefone compartilhado)
  }

  const conflitos = [];
  const campos = { ...status };
  const camposFatura = {};
  const preencher = (alvo, coluna, novo) => {
    if (vazio(novo)) return;
    if (vazio(c[coluna])) alvo[coluna] = novo;
  };

  // Identidade: nunca muda. Só reporta divergência.
  if (nomeCanonico(c.nome) !== nomeCanonico(fatura.nome)) conflitos.push('nome'); // só se achado pelo ID da fatura
  if (fatura.telefone && !normalizarVariantes(c.telefone).some((t) => normalizarVariantes(fatura.telefone).includes(t))) {
    conflitos.push('telefone');
  }

  if (!vazio(c.email) && fatura.email && String(c.email).toLowerCase() !== fatura.email) conflitos.push('email');
  if (!vazio(c.os_numero) && fatura.os_numero && c.os_numero !== fatura.os_numero) conflitos.push('os_numero');
  if (!vazio(c.valor) && fatura.valor !== null && Number(c.valor) !== fatura.valor) conflitos.push('valor');
  if (!vazio(c.vencimento) && fatura.vencimento && vencimentoCanonico(c.vencimento) !== fatura.vencimento) {
    conflitos.push('vencimento');
  }

  preencher(campos, 'email', fatura.email);
  preencher(campos, 'os_numero', fatura.os_numero);
  preencher(campos, 'ennychat_fatura_id', fatura.id_externo);
  if (temAlternativos(fatura.alternativos)) preencher(campos, 'contatos_alternativos', fatura.alternativos);
  preencher(camposFatura, 'valor', fatura.valor);
  preencher(camposFatura, 'numero_contrato', fatura.os_numero);
  preencher(camposFatura, 'tipo_fatura', fatura.tipo_fatura);
  preencher(camposFatura, 'data_prazo', fatura.data_prazo);
  preencher(camposFatura, 'vencimento', fatura.vencimento);

  return { acao: 'atualizar', cliente: c, campos, camposFatura, conflitos };
}
