// Limpeza automática de faturas/boletos antigos (40+ dias) -- roda 1x por dia.
//
// Dois alvos, cada um com seu próprio "relógio" de 40 dias:
// 1) PDF anexado a um cliente (aba Clientes/Faturas) -- bucket `faturas`,
//    contado a partir de `clientes.pdf_atualizado_em` (data do último upload).
//    Remove o arquivo do Storage e limpa pdf_url/pdf_path/pdf_atualizado_em
//    do cliente (o cliente em si NÃO é apagado, só o PDF -- o cliente pode
//    continuar recebendo faturas novas depois).
// 2) Boleto enviado pro Extrator de PIX -- bucket `pix-extracoes`, contado a
//    partir de `pix_extracoes.criado_em`. Remove o arquivo do Storage e a
//    linha inteira da tabela (o histórico dessa extração específica não tem
//    valor depois que o PDF original já não existe mais).
//
// Motivo de apagar: são PDFs de fatura com dados financeiros/pessoais de
// clientes -- não faz sentido acumular pra sempre no Storage depois que a
// fatura já não é mais relevante (40 dias cobre folgadamente qualquer prazo
// de vencimento + tempo de cobrança).
import { supabase, BUCKET } from '../lib/supabase.js';

const DIAS_RETENCAO = Number(process.env.RETENCAO_FATURAS_DIAS || 40);
const PIX_BUCKET = process.env.SUPABASE_PIX_BUCKET || 'pix-extracoes';
const INTERVALO_MS = 24 * 60 * 60 * 1000; // 1x por dia

function limiteDeData() {
  return new Date(Date.now() - DIAS_RETENCAO * 24 * 60 * 60 * 1000).toISOString();
}

// Remove arquivos do Storage em lotes de até 100 (limite prático da API do
// Supabase Storage por chamada de `.remove()`) -- best-effort: uma falha
// pontual no Storage não impede o resto da limpeza nem trava o processo.
async function removerDoStorageEmLotes(bucket, caminhos) {
  const TAMANHO_LOTE = 100;
  for (let i = 0; i < caminhos.length; i += TAMANHO_LOTE) {
    const lote = caminhos.slice(i, i + TAMANHO_LOTE);
    const { error } = await supabase.storage.from(bucket).remove(lote);
    if (error) console.error(`[limpeza] erro ao remover arquivos do bucket ${bucket}:`, error.message);
  }
}

async function limparFaturasDeClientes() {
  const { data: clientes, error } = await supabase
    .from('clientes')
    .select('id, pdf_path')
    .not('pdf_path', 'is', null)
    .lt('pdf_atualizado_em', limiteDeData());

  if (error) {
    console.error('[limpeza] erro ao buscar faturas antigas de clientes:', error.message);
    return 0;
  }
  if (!clientes?.length) return 0;

  const caminhos = clientes.map((c) => c.pdf_path).filter(Boolean);
  await removerDoStorageEmLotes(BUCKET, caminhos);

  const ids = clientes.map((c) => c.id);
  const { error: updateError } = await supabase
    .from('clientes')
    .update({ pdf_url: null, pdf_path: null, pdf_atualizado_em: null })
    .in('id', ids);

  if (updateError) {
    console.error('[limpeza] erro ao limpar pdf_url/pdf_path dos clientes:', updateError.message);
    return 0;
  }

  return clientes.length;
}

async function limparExtracoesPix() {
  const { data: extracoes, error } = await supabase
    .from('pix_extracoes')
    .select('id, storage_path')
    .lt('criado_em', limiteDeData());

  if (error) {
    console.error('[limpeza] erro ao buscar extrações de pix antigas:', error.message);
    return 0;
  }
  if (!extracoes?.length) return 0;

  const caminhos = extracoes.map((e) => e.storage_path).filter(Boolean);
  if (caminhos.length) await removerDoStorageEmLotes(PIX_BUCKET, caminhos);

  const ids = extracoes.map((e) => e.id);
  const { error: deleteError } = await supabase.from('pix_extracoes').delete().in('id', ids);

  if (deleteError) {
    console.error('[limpeza] erro ao apagar linhas de pix_extracoes antigas:', deleteError.message);
    return 0;
  }

  return extracoes.length;
}

export async function limparDadosAntigos() {
  try {
    const [faturas, pix] = await Promise.all([limparFaturasDeClientes(), limparExtracoesPix()]);
    if (faturas || pix) {
      console.log(
        `[limpeza] concluída: ${faturas} fatura(s) de cliente + ${pix} extração(ões) de pix removidas (mais de ${DIAS_RETENCAO} dias).`
      );
    }
  } catch (err) {
    // Nunca deixa a limpeza derrubar o processo -- pior caso, tenta de novo no
    // próximo ciclo (24h depois).
    console.error('[limpeza] erro inesperado:', err.message);
  }
}

export function iniciarLimpezaAutomatica() {
  // Roda uma vez já na subida (com um pequeno atraso pra não competir com o
  // resto do startup) e depois a cada 24h.
  setTimeout(() => limparDadosAntigos(), 30_000);
  setInterval(limparDadosAntigos, INTERVALO_MS);
  console.log(`[limpeza] agendada, retenção de ${DIAS_RETENCAO} dias, verificando a cada 24h`);
}
