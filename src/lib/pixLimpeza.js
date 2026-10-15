// [2026-10] Limpeza em lote das extrações de Pix (tabela `pix_extracoes`).
// Relatado: a lista acumulava mais de mil linhas e não havia como separar o
// que importa do que não importa nem como apagar em massa. Usado por duas
// portas: a tela Extrator de PIX (escopo do operador, `usuarioId` obrigatório)
// e o Painel de Exclusão do supervisor (`usuarioId` null = carteira toda, ver
// exclusaoCriterios.js).
//
// Nunca toca em extração "aguardando"/"processando" -- apagar a linha no meio
// do processamento faria o salvamento do resultado falhar. Apagar a extração
// NÃO remove o pix_code que já foi aplicado num cliente (isso fica no cliente).
import { supabase } from './supabase.js';
import { armazenamento } from './armazenamento.js';
import { buscarTodos } from './buscarTodos.js';

const PIX_BUCKET = process.env.SUPABASE_PIX_BUCKET || 'pix-extracoes';
const REGEX_DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const LOTE = 100;

export const MODOS_PIX = ['todas', 'sem_cliente', 'com_erro', 'antes_de'];

function validar({ modo, antesDe }) {
  if (!MODOS_PIX.includes(modo)) throw new Error(`parâmetro "modo" deve ser um de: ${MODOS_PIX.join(', ')}`);
  if (modo === 'antes_de' && !REGEX_DATA_ISO.test(String(antesDe || ''))) {
    throw new Error('parâmetro "antes_de" deve estar no formato AAAA-MM-DD');
  }
}

function aplicarFiltro(query, { usuarioId, modo, antesDe }) {
  let q = query.not('status', 'in', '(aguardando,processando)');
  if (usuarioId) q = q.eq('usuario_id', usuarioId);
  if (modo === 'sem_cliente') q = q.is('cliente_id', null);
  if (modo === 'com_erro') q = q.in('status', ['erro', 'nao_encontrado']);
  // Brasil sem horário de verão: início do dia em -03:00 (mesma premissa de clientes.routes.js).
  if (modo === 'antes_de') q = q.lt('criado_em', `${antesDe}T00:00:00-03:00`);
  return q;
}

async function selecionar(opcoes) {
  validar(opcoes);
  const { data, error } = await buscarTodos(() =>
    aplicarFiltro(supabase.from('pix_extracoes').select('id, arquivo, nome, storage_path'), opcoes).order('id'),
  );
  if (error) throw error;
  return data || [];
}

export async function contarExtracoesPix(opcoes) {
  const linhas = await selecionar(opcoes);
  return { quantidade: linhas.length, amostra: linhas.slice(0, 5).map((l) => l.nome || l.arquivo) };
}

export async function apagarExtracoesPix(opcoes) {
  const linhas = await selecionar(opcoes);
  let apagadas = 0;
  for (let i = 0; i < linhas.length; i += LOTE) {
    const lote = linhas.slice(i, i + LOTE);
    const caminhos = lote.map((l) => l.storage_path).filter(Boolean);
    // Best-effort, como a limpeza automática: arquivo órfão no bucket não
    // impede a linha de sair da lista.
    if (caminhos.length) {
      const { error: storageError } = await armazenamento.from(PIX_BUCKET).remove(caminhos);
      if (storageError) console.error('[pix] erro ao remover arquivos do bucket de extrações:', storageError.message);
    }
    const { error } = await supabase
      .from('pix_extracoes')
      .delete()
      .in(
        'id',
        lote.map((l) => l.id),
      );
    if (error) throw error;
    apagadas += lote.length;
  }
  return apagadas;
}
