import { supabase } from './supabase.js';

// ---------------------------------------------------------------------------
// Cliente com 2+ números de WhatsApp -- ver migration-15. Cada número ainda é
// uma linha própria em `clientes` (é o destino do envio), mas quando o PDF,
// o Pix, o valor ou o vencimento mudam numa linha, o mesmo dado precisa valer
// pras outras linhas do mesmo grupo (as vinculadas via `cliente_principal_id`).
// Nome e telefone NUNCA propagam -- são a identidade de cada linha.
// ---------------------------------------------------------------------------

// [2026-08] SAFRAS: tipo_fatura/data_prazo/numero_contrato também são dado
// da FATURA (mesma linha de raciocínio de valor/vencimento) -- editar
// qualquer um deles precisa valer pro grupo inteiro. `data_contrato` também
// entra por simetria, mesmo hoje sempre null na prática (ver CONTEXTO.md).
// NUNCA incluir `safra` aqui: é coluna GERADA no Postgres, um UPDATE nela
// falha (e nem faria sentido -- ela se recalcula sozinha a partir de
// data_prazo).
// [2026-08] QUALIDADE: status_operador/status_operador_atualizado_em (ver
// migration-20-qualidade-tratativas.sql) também são dado da FATURA -- uma
// tratativa registrada num número precisa valer pro grupo inteiro, senão o
// mesmo cliente apareceria "iniciado" numa linha e sem status na outra.
const CAMPOS_FATURA = [
  'pdf_path',
  'pdf_atualizado_em',
  'pix_code',
  'valor',
  'vencimento',
  'linha_digitavel',
  'tipo_fatura',
  'data_prazo',
  'numero_contrato',
  'data_contrato',
  'status_operador',
  'status_operador_atualizado_em',
];

// Resolve o id "raiz" do grupo (a linha principal) a partir de qualquer
// membro: se a própria linha já é principal (cliente_principal_id nulo),
// ela mesma é a raiz; senão, a raiz é quem ela aponta.
async function resolverPrincipalId(clienteId, usuarioId) {
  const { data, error } = await supabase
    .from('clientes')
    .select('id, cliente_principal_id')
    .eq('id', clienteId)
    .eq('usuario_id', usuarioId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return data.cliente_principal_id || data.id;
}

// Todos os ids do grupo (a principal + quem aponta pra ela), incluindo a
// própria principal.
async function idsDoGrupo(principalId, usuarioId) {
  const { data, error } = await supabase
    .from('clientes')
    .select('id')
    .eq('usuario_id', usuarioId)
    .or(`id.eq.${principalId},cliente_principal_id.eq.${principalId}`);
  if (error) throw error;
  return (data || []).map((c) => c.id);
}

// Aplica `dados` (só os campos de CAMPOS_FATURA presentes no objeto) em
// TODAS as linhas do grupo de `clienteId` -- incluindo ela mesma. Chame isso
// em vez de um `.update().eq('id', clienteId)` direto sempre que a rota
// gravar pdf_path/pix_code/valor/vencimento/linha_digitavel/tipo_fatura/
// data_prazo/numero_contrato/data_contrato, pra manter os números vinculados
// sempre com a mesma fatura.
export async function propagarDadosFatura(clienteId, usuarioId, dados) {
  const camposParaGravar = Object.fromEntries(
    Object.entries(dados || {}).filter(([chave, valor]) => CAMPOS_FATURA.includes(chave) && valor !== undefined),
  );
  if (!Object.keys(camposParaGravar).length) return { data: null, error: null };

  const principalId = await resolverPrincipalId(clienteId, usuarioId);
  if (!principalId) return { data: null, error: new Error('cliente não encontrado') };

  const ids = await idsDoGrupo(principalId, usuarioId);
  if (!ids.length) return { data: null, error: new Error('cliente não encontrado') };

  const { data, error } = await supabase
    .from('clientes')
    .update(camposParaGravar)
    .in('id', ids)
    .eq('usuario_id', usuarioId)
    .select('*, cliente_tags(tags(id, nome, cor))');

  return { data, error };
}

// Vincula `outroId` ao mesmo grupo de `clienteId` (outro número do mesmo
// cliente). Se `outroId` já tiver seu próprio grupo (outras linhas apontando
// pra ele), o grupo inteiro é re-raizado pro grupo de `clienteId` -- une os
// dois grupos em um só, sem perder ninguém.
export async function vincularNumero(clienteId, outroId, usuarioId) {
  if (clienteId === outroId) throw new Error('não é possível vincular um cliente a ele mesmo');

  const principalId = await resolverPrincipalId(clienteId, usuarioId);
  if (!principalId) throw new Error('cliente não encontrado');

  const { data: outro, error: outroError } = await supabase
    .from('clientes')
    .select('id, cliente_principal_id')
    .eq('id', outroId)
    .eq('usuario_id', usuarioId)
    .maybeSingle();
  if (outroError) throw outroError;
  if (!outro) throw new Error('cliente a vincular não encontrado');
  if (outro.id === principalId) throw new Error('esses clientes já estão no mesmo grupo');

  // Se `outroId` já era ele mesmo uma "principal" com outros apontando pra
  // ele, esses filhos vêm junto -- reaponta todo mundo (outroId + filhos
  // dele) pra principalId de uma vez.
  const { error } = await supabase
    .from('clientes')
    .update({ cliente_principal_id: principalId })
    .eq('usuario_id', usuarioId)
    .or(`id.eq.${outro.id},cliente_principal_id.eq.${outro.id}`);
  if (error) throw error;

  // Copia a fatura já existente na principal (se houver) pro grupo inteiro
  // (agora maior), pra quem acabou de entrar já sair com os dados certos.
  const { data: principal } = await supabase
    .from('clientes')
    .select(CAMPOS_FATURA.join(', '))
    .eq('id', principalId)
    .maybeSingle();
  // Checa TODOS os campos de fatura, não só pdf_path/pix_code -- um cliente
  // recém-importado da lista crua pode já ter tipo_fatura/data_prazo/valor
  // sem ainda ter PDF/Pix, e esse caso também precisa propagar pro novo
  // membro do grupo (bug: antes só olhava pdf_path/pix_code e perdia essa
  // situação, deixando o número recém-vinculado sem safra/tipo_fatura).
  const temFaturaExistente = principal && CAMPOS_FATURA.some((campo) => principal[campo] !== null && principal[campo] !== undefined);
  if (temFaturaExistente) {
    await propagarDadosFatura(principalId, usuarioId, principal);
  }
}

// Desvincula `clienteId` do grupo -- volta a ser uma linha "principal"
// sozinha (não apaga nada, só para de espelhar a fatura dali pra frente).
export async function desvincularNumero(clienteId, usuarioId) {
  const { error } = await supabase
    .from('clientes')
    .update({ cliente_principal_id: null })
    .eq('id', clienteId)
    .eq('usuario_id', usuarioId);
  if (error) throw error;
}

// Ids + nome/telefone dos outros membros do grupo de `clienteId` (sem ele
// mesmo) -- usado pra mostrar "vinculado a" na tela de Clientes.
export async function membrosDoGrupo(clienteId, usuarioId) {
  const principalId = await resolverPrincipalId(clienteId, usuarioId);
  if (!principalId) return [];
  const ids = await idsDoGrupo(principalId, usuarioId);
  const outros = ids.filter((id) => id !== clienteId);
  if (!outros.length) return [];
  const { data, error } = await supabase.from('clientes').select('id, nome, telefone').in('id', outros);
  if (error) throw error;
  return data || [];
}
