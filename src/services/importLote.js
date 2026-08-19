import XLSX from 'xlsx';
import { supabase } from '../lib/supabase.js';
import { normalizarTelefone } from '../lib/telefone.js';

// [2026-08] O fluxo server-side antigo (processarImportacao: recebia zip+PDFs
// binários e rodava OCR/QR no próprio backend com pdfjs-dist + jsQR) foi
// REMOVIDO. O backend não deve mais tocar em bytes de PDF -- nem receber, nem
// processar -- pra não estourar a RAM do plano (Render, 512MB). Todo PDF
// agora é fatiado e mandado pro Cloudflare Worker de OCR direto do navegador
// (ver frontend/src/lib/pixWorkerClient.ts e importacaoBrowser.ts) antes de
// qualquer coisa chegar aqui. O único fluxo de importação em lote suportado
// hoje é processarImportacaoLotePronto() (POST /api/importacao/lote), abaixo.

// Roda `tarefa` para cada item de `itens`, no máximo `limite` em paralelo por vez.
// Sem isso, uma importação de centenas de linhas (upsert + upload + extração de Pix
// por linha, cada uma com round-trip de rede pro Supabase) rodava 100% sequencial:
// ~1-2s por linha vira 5-10+ minutos pra 300 clientes, arriscando estourar o timeout
// de requisição da hospedagem (ex: Render) antes do backend terminar de responder.
// Com concorrência limitada, o tempo total cai proporcionalmente ao `limite`, sem
// abrir uma promise por linha de uma vez só (isso sobrecarregaria o Supabase e a
// memória à toa -- os buffers dos PDFs já ficam todos em memória de qualquer forma).
async function mapComConcorrencia(itens, limite, tarefa) {
  const resultados = new Array(itens.length);
  let proximo = 0;

  async function worker() {
    while (proximo < itens.length) {
      const indice = proximo++;
      resultados[indice] = await tarefa(itens[indice], indice);
    }
  }

  const workers = Array.from({ length: Math.min(limite, itens.length) }, () => worker());
  await Promise.all(workers);
  return resultados;
}

// Monta o resumo (sucesso/semPdf/semDadosObrigatorios) e cria o lote de envio a
// partir de uma lista de resultados por linha já processados. Compartilhado
// pelos dois fluxos de importação (server-side com PDF binário, e client-side
// já processado no navegador) -- a parte de "criar envio + itens" é idêntica
// nos dois, só muda como cada linha chega até aqui.
async function montarResumoECriarEnvio(totalLinhas, processadas, templateMensagemPadrao, lote = null) {
  const resultado = {
    total: totalLinhas,
    sucesso: [],
    semPdf: [],
    semDadosObrigatorios: [],
  };

  const clienteIdsParaEnvio = [];
  const mensagensPorCliente = new Map(); // cliente_id -> mensagem_override (se a planilha trouxer mensagem por linha)

  for (const r of processadas) {
    if (r.tipo === 'semDados') {
      resultado.semDadosObrigatorios.push(r.linha);
    } else if (r.tipo === 'semPdf') {
      resultado.semPdf.push(r.linha);
    } else {
      clienteIdsParaEnvio.push(r.cliente_id);
      if (r.linha.mensagem) mensagensPorCliente.set(r.cliente_id, r.linha.mensagem);
      resultado.sucesso.push({ ...r.linha, cliente_id: r.cliente_id });
    }
  }

  if (clienteIdsParaEnvio.length === 0) {
    return { ...resultado, envio: null };
  }

  // cria o lote de envio já com os itens prontos (status pendente, aguardando o clique de "Disparar")
  const { data: envio, error: envioError } = await supabase
    .from('envios')
    .insert({ template_mensagem: templateMensagemPadrao, status: 'pendente', lote: lote || null })
    .select()
    .single();

  if (envioError) throw envioError;

  const itens = clienteIdsParaEnvio.map((cliente_id) => ({
    envio_id: envio.id,
    cliente_id,
    status: 'pendente',
    mensagem_override: mensagensPorCliente.get(cliente_id) || null,
  }));

  const { error: itensError } = await supabase.from('envio_itens').insert(itens);
  if (itensError) throw itensError;

  return { ...resultado, envio };
}

// Concorrência do upsert client-side: aqui NÃO há mais PDF/canvas/QR envolvido
// (isso já foi feito no navegador antes de chegar aqui) -- cada item é só um
// upsert + update de metadados no Supabase, uma chamada de rede leve. Pode ser
// bem mais alto que CONCORRENCIA_IMPORTACAO sem risco de RAM.
const CONCORRENCIA_UPSERT_LOTE = Number(process.env.IMPORTACAO_LOTE_CONCORRENCIA || 8);

// Processa um lote já preparado no navegador: parsing da planilha, casamento
// com PDF, fatiamento + OCR via Cloudflare Worker e upload pro Storage já
// aconteceram no CLIENTE (ver frontend/src/lib/importacaoBrowser.ts e
// pixWorkerClient.ts) -- rodando com a RAM/CPU de quem está importando, não do
// servidor. O backend NUNCA recebe o PDF em si nesse fluxo. Aqui só falta:
// 1) upsert do cliente por telefone, 2) gravar os metadados
// (pdf_url/pdf_path/pix_code/valor/vencimento/linha_digitavel) que já vieram
// prontos, 3) montar o lote de envio -- tudo leve o bastante pra nunca
// aproximar de estourar a memória do servidor, mesmo com centenas de linhas.
//
// `itensProntos` é um array de:
//   { linha, numero, nome, valor, vencimento, linha_digitavel, mensagem,
//     telefoneNormalizado, pdf_url, pdf_path, pix_code }
// (pdf_url/pdf_path vêm nulos quando a linha não tinha PDF casado no zip --
// tratado como 'semPdf', igual ao fluxo antigo)
// `linhasSemDados` é o array de linhas que já vieram marcadas como inválidas
// do navegador (sem numero/nome, ou telefone que não normalizou).
export async function processarImportacaoLotePronto({ itensProntos, linhasSemDados, templateMensagemPadrao, lote }) {
  async function processarItem(item) {
    if (!item.pdf_url) {
      return { tipo: 'semPdf', linha: item };
    }

    // upsert do cliente por telefone (evita duplicar se reimportar a planilha) --
    // mesmo comportamento do fluxo server-side.
    const { data: cliente, error: clienteError } = await supabase
      .from('clientes')
      .upsert(
        {
          nome: item.nome,
          telefone: item.telefoneNormalizado,
          valor: item.valor,
          vencimento: item.vencimento,
        },
        { onConflict: 'telefone' },
      )
      .select()
      .single();

    if (clienteError) {
      return { tipo: 'semDados', linha: { ...item, erro: clienteError.message } };
    }

    const { error: updateError } = await supabase
      .from('clientes')
      .update({
        pdf_url: item.pdf_url,
        pdf_path: item.pdf_path,
        pix_code: item.pix_code ?? null,
        linha_digitavel: item.linha_digitavel ?? null,
        pdf_atualizado_em: new Date().toISOString(),
      })
      .eq('id', cliente.id);

    if (updateError) {
      return { tipo: 'semDados', linha: { ...item, erro: updateError.message } };
    }

    return { tipo: 'sucesso', linha: item, cliente_id: cliente.id };
  }

  const processadasItens = await mapComConcorrencia(itensProntos, CONCORRENCIA_UPSERT_LOTE, processarItem);
  const processadasSemDados = linhasSemDados.map((linha) => ({ tipo: 'semDados', linha }));
  const todasProcessadas = [...processadasSemDados, ...processadasItens];
  const totalLinhas = itensProntos.length + linhasSemDados.length;

  return montarResumoECriarEnvio(totalLinhas, todasProcessadas, templateMensagemPadrao, lote);
}
