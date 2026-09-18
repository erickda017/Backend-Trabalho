import { supabase } from './supabase.js';
import { escaparFiltroPostgrest } from './filtros.js';
import { propagarDadosFatura } from './faturaPropagacao.js';
import { normalizarNomeArquivo, normalizarTexto } from './nomeMatch.js';

// Compartilhado entre boletos.routes.js (POST /salvar-pix, resultado vindo do
// Cloudflare Worker no navegador) e pix.routes.js (POST /extrair-servidor,
// resultado vindo da extração no PRÓPRIO backend -- ver CONTEXTO.md) -- as
// duas rotas terminam fazendo exatamente a mesma coisa depois de achar o Pix:
// casar com um cliente (se ainda não souber qual), gravar o histórico em
// pix_extracoes, e propagar pix/valor/vencimento/linha digitável pro cliente
// (e pro grupo dele, se houver números vinculados).

// Tenta casar o boleto com um cliente já cadastrado: 1) clienteId explícito
// (usuário já vinculou na tela), 2) por fallback, pelo nome do arquivo.
// [MULTI-TENANT] sempre escopado por usuarioId.
export async function resolverClientePix({ clienteId, arquivo, usuarioId }) {
  if (clienteId) {
    const { data } = await supabase.from('clientes').select('id').eq('id', clienteId).eq('usuario_id', usuarioId).maybeSingle();
    if (data?.id) return data.id;
  }
  if (arquivo) {
    const nomeBase = String(arquivo).replace(/\.pdf$/i, '').trim();
    if (nomeBase) {
      // [2026-09] Antes usava .limit(1).maybeSingle() -- se 2 clientes de
      // nome parecido batessem o ILIKE, pegava QUALQUER um dos dois (ordem
      // arbitrária do Postgres), risco real de vincular o Pix/PDF do
      // cliente errado (2 pessoas de mesmo nome/nome parecido, contratos
      // diferentes). Agora busca TODOS os candidatos e só casa se houver
      // exatamente 1 -- ambíguo fica sem casar automaticamente (cai no
      // fluxo normal de "não achou cliente", ver persistirExtracaoPix).
      const { data } = await supabase
        .from('clientes')
        .select('id')
        .eq('usuario_id', usuarioId)
        .ilike('nome', `%${escaparFiltroPostgrest(nomeBase)}%`);
      if (data?.length === 1) return data[0].id;
    }
  }
  return null;
}

export function serializarExtracaoPix(linha) {
  return {
    id: linha.id,
    arquivo: linha.arquivo,
    cliente_id: linha.cliente_id,
    cliente_nome: linha.clientes?.nome || null,
    status: linha.status,
    pix_code: linha.pix_code,
    valor: linha.valor,
    vencimento: linha.vencimento,
    linha_digitavel: linha.linha_digitavel,
    erro: linha.erro,
    criado_em: linha.criado_em,
    origem: linha.origem || null,
  };
}

// Grava a extração (auditoria/listagem em /pix) e, se um cliente foi
// resolvido, propaga o Pix/valor/vencimento/linha digitável pra ele (e pro
// grupo, se houver números vinculados -- ver faturaPropagacao.js).
export async function persistirExtracaoPix({ usuarioId, arquivo, pixCopiaCola, valor, vencimento, linhaDigitavel, clienteId, origem }) {
  const nomeArquivo = typeof arquivo === 'string' && arquivo.trim() ? arquivo.trim() : 'boleto.pdf';
  const clienteResolvido = await resolverClientePix({ clienteId, arquivo: nomeArquivo, usuarioId });

  const { data: extracao, error: insertError } = await supabase
    .from('pix_extracoes')
    .insert({
      usuario_id: usuarioId,
      arquivo: nomeArquivo,
      cliente_id: clienteResolvido,
      status: 'encontrado',
      pix_code: pixCopiaCola,
      valor: valor ?? null,
      vencimento: vencimento ?? null,
      linha_digitavel: linhaDigitavel ?? null,
    })
    .select('*, clientes(nome)')
    .single();

  if (insertError) throw insertError;

  if (clienteResolvido) {
    const { error: updateError } = await propagarDadosFatura(clienteResolvido, usuarioId, {
      pix_code: pixCopiaCola,
      ...(valor ? { valor } : {}),
      ...(vencimento ? { vencimento } : {}),
      ...(linhaDigitavel ? { linha_digitavel: linhaDigitavel } : {}),
    });
    if (updateError) console.error('[pix] falha ao atualizar cliente com o Pix:', updateError.message);
  }

  return serializarExtracaoPix({ ...extracao, origem });
}

// [2026-09] Espelha associarPendentesAoCliente (lib/faturasPendentes.js),
// mesma ideia pra Pix: quando um Pix é extraído (/pix/extrair-servidor ou
// /boletos/salvar-pix) ANTES do cliente correspondente existir,
// resolverClientePix não acha ninguém e a extração fica salva com
// cliente_id nulo. Sem isso, importar o Pix primeiro e os clientes depois
// deixava a extração pendente pra sempre, exigindo vínculo manual na tela de
// Pix -- mesmo quando o nome bate certinho com o cliente recém-criado.
//
// Chamada logo após CRIAR (ou upsertar) um cliente -- routes/clientes.routes.js
// (POST /, POST /importar-lista) -- igual à chamada de
// associarPendentesAoCliente que já roda nos mesmos lugares. Mesmo critério
// de sempre pra casar nome (exato, senão "contém", mínimo 3 caracteres) e
// mesma limitação assumida: só a PRIMEIRA extração pendente que bater: se
// houver mais de uma pra pessoas de nome parecido, as demais continuam sem
// cliente pra revisão manual em vez de arriscar adivinhar qual é a certa.
export async function associarPixPendenteAoCliente(clienteId, nomeCliente, usuarioId) {
  try {
    const alvo = normalizarTexto(nomeCliente).replace(/\s+/g, ' ').trim();
    if (!alvo || alvo.length < 3) return null;

    const { data: pendentes, error } = await supabase
      .from('pix_extracoes')
      .select('id, arquivo, pix_code, valor, vencimento, linha_digitavel')
      .eq('usuario_id', usuarioId)
      .is('cliente_id', null);
    if (error) throw error;

    const candidatos = (pendentes || []).map((p) => ({ ...p, nomeNormalizado: normalizarNomeArquivo(p.arquivo) }));
    const pendencia =
      candidatos.find((p) => p.nomeNormalizado === alvo) ??
      candidatos.find((p) => p.nomeNormalizado.length >= 3 && (alvo.includes(p.nomeNormalizado) || p.nomeNormalizado.includes(alvo))) ??
      null;
    if (!pendencia) return null;

    const { error: updateClienteError } = await propagarDadosFatura(clienteId, usuarioId, {
      pix_code: pendencia.pix_code,
      ...(pendencia.valor ? { valor: pendencia.valor } : {}),
      ...(pendencia.vencimento ? { vencimento: pendencia.vencimento } : {}),
      ...(pendencia.linha_digitavel ? { linha_digitavel: pendencia.linha_digitavel } : {}),
    });
    if (updateClienteError) {
      console.error('[pix] falha ao propagar Pix pendente pro cliente recém-criado:', updateClienteError.message);
      return null;
    }

    await supabase.from('pix_extracoes').update({ cliente_id: clienteId }).eq('id', pendencia.id);
    return { arquivo: pendencia.arquivo };
  } catch (err) {
    // Nunca derruba o fluxo principal (criação do cliente) por causa disso.
    console.error('[pix] erro ao tentar associar Pix pendente:', err.message);
    return null;
  }
}
