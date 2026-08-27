import { supabase, BUCKET } from './supabase.js';
import { normalizarNomeArquivo, normalizarTexto } from './nomeMatch.js';
import { propagarDadosFatura } from './faturaPropagacao.js';

// ---------------------------------------------------------------------------
// "Upload de faturas avulsas, sem planilha" -- ver migration-18 pro desenho
// da tabela e routes/faturasPendentes.routes.js pro endpoint de upload.
//
// Um PDF avulso que NÃO casou com nenhum cliente já cadastrado no momento do
// upload fica registrado aqui, com o arquivo já salvo no Storage (só não
// associado a ninguém ainda). Esta lib cobre a outra metade do fluxo: assim
// que um cliente NOVO é criado (cadastro manual, "importar lista",
// importação em lote), `associarPendentesAoCliente` roda e verifica se o
// nome dele bate com algum PDF pendente -- se sim, move o arquivo pra dentro
// da pasta do cliente e grava pix/valor/vencimento nele, igual a um upload
// normal via POST /clientes/:id/pdf.
// ---------------------------------------------------------------------------

// Registra 1 PDF avulso que não achou cliente correspondente no upload.
export async function criarPendencia({ usuarioId, arquivo, pdfPath, pixCode, valor, vencimento, linhaDigitavel }) {
  const { data, error } = await supabase
    .from('faturas_pendentes')
    .insert({
      usuario_id: usuarioId,
      arquivo,
      arquivo_normalizado: normalizarNomeArquivo(arquivo),
      pdf_path: pdfPath,
      pix_code: pixCode ?? null,
      valor: valor ?? null,
      vencimento: vencimento ?? null,
      linha_digitavel: linhaDigitavel ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Acha, entre as pendências do usuário, alguma cujo nome de arquivo bate com
// `nomeCliente` -- mesmo critério de sempre (exato ou "contém", ver
// lib/nomeMatch.js). Só a PRIMEIRA que bater (raro ter duas pendências pro
// mesmo cliente; se acontecer, as demais continuam pendentes pra revisão
// manual em vez de tentar adivinhar qual delas é a certa).
async function acharPendenciaParaCliente(nomeCliente, usuarioId) {
  const alvo = normalizarTexto(nomeCliente).replace(/\s+/g, ' ').trim();
  if (!alvo || alvo.length < 3) return null;

  const { data, error } = await supabase
    .from('faturas_pendentes')
    .select('*')
    .eq('usuario_id', usuarioId);
  if (error) throw error;

  const pendencias = data || [];
  const exata = pendencias.find((p) => p.arquivo_normalizado === alvo);
  if (exata) return exata;

  return (
    pendencias.find(
      (p) => p.arquivo_normalizado.length >= 3 && (alvo.includes(p.arquivo_normalizado) || p.arquivo_normalizado.includes(alvo)),
    ) ?? null
  );
}

// Chamada logo após CRIAR (ou identificar) um cliente -- em
// routes/clientes.routes.js (POST /, POST /importar-lista) e em
// services/importLote.js (upsert de cada linha). Se houver uma fatura
// avulsa pendente com nome de arquivo compatível, move o PDF pra dentro da
// pasta do cliente e grava os dados nele (propaga pro grupo, se houver
// números vinculados). Silenciosa quando não há match -- é o caminho comum
// (a maioria dos clientes não tem PDF avulso esperando).
export async function associarPendentesAoCliente(clienteId, nomeCliente, usuarioId) {
  try {
    const pendencia = await acharPendenciaParaCliente(nomeCliente, usuarioId);
    if (!pendencia) return null;

    const novoCaminho = `${clienteId}/${Date.now()}-${pendencia.arquivo.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error: moveError } = await supabase.storage.from(BUCKET).move(pendencia.pdf_path, novoCaminho);
    if (moveError) {
      console.error('[faturasPendentes] falha ao mover PDF pendente pro cliente:', moveError.message);
      return null;
    }

    const { error: updateError } = await propagarDadosFatura(clienteId, usuarioId, {
      pdf_path: novoCaminho,
      pix_code: pendencia.pix_code,
      ...(pendencia.valor ? { valor: pendencia.valor } : {}),
      ...(pendencia.vencimento ? { vencimento: pendencia.vencimento } : {}),
      ...(pendencia.linha_digitavel ? { linha_digitavel: pendencia.linha_digitavel } : {}),
      pdf_atualizado_em: new Date().toISOString(),
    });
    if (updateError) {
      console.error('[faturasPendentes] falha ao gravar dados da fatura associada:', updateError.message);
      return null;
    }

    await supabase.from('faturas_pendentes').delete().eq('id', pendencia.id);
    return { arquivo: pendencia.arquivo, pdf_path: novoCaminho };
  } catch (err) {
    // Nunca derruba o fluxo principal (criação do cliente) por causa disso.
    console.error('[faturasPendentes] erro ao tentar associar pendências:', err.message);
    return null;
  }
}
