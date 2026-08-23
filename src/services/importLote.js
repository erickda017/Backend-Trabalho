import XLSX from 'xlsx';
import { supabase } from '../lib/supabase.js';
import { normalizarTelefone } from '../lib/telefone.js';
import { propagarDadosFatura } from '../lib/faturaPropagacao.js';

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
async function montarResumoECriarEnvio(totalLinhas, processadas, templateMensagemPadrao, lote, usuarioId) {
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
    .insert({ usuario_id: usuarioId, template_mensagem: templateMensagemPadrao, status: 'pendente', lote: lote || null })
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
//     telefoneNormalizado, pdf_path, pix_code }
// (pdf_path vem nulo quando a linha não tinha PDF casado no zip -- tratado
// como 'semPdf', igual ao fluxo antigo. pdf_url NÃO é mais usado nem gravado
// -- bucket privado, ver src/lib/supabase.js)
// `linhasSemDados` é o array de linhas que já vieram marcadas como inválidas
// do navegador (sem numero/nome, ou telefone que não normalizou).
export async function processarImportacaoLotePronto({ itensProntos, linhasSemDados, templateMensagemPadrao, lote, usuarioId }) {
  if (!usuarioId) throw new Error('usuarioId é obrigatório');

  // [2026-08] SEGURANÇA: pdf_path vem do corpo da requisição (JSON), controlado
  // pelo navegador -- nunca confiar cegamente que aponta pra um arquivo do
  // PRÓPRIO usuário. Path legítimo sempre começa com "${usuarioId}/" (é assim
  // que POST /importacao/upload-pdf prefixa no backend, ver importacao.routes.js).
  // Se vier algo fora desse prefixo (adivinhado, copiado de outra sessão, bug em
  // outro lugar), trata como se não tivesse PDF em vez de gravar uma referência
  // pra um arquivo que pode não ser dele.
  const prefixoEsperado = `${usuarioId}/`;
  function pdfPathPertenceAoUsuario(pdfPath) {
    return typeof pdfPath === 'string' && pdfPath.startsWith(prefixoEsperado);
  }

  async function processarItem(item) {
    // [2026-08] SEGURANÇA: usa pdf_path (identifica o objeto no bucket
    // privado) pra saber se a linha tem PDF, não mais pdf_url -- essa URL
    // deixou de ser gerada/gravada (bucket "faturas" não é mais público).
    if (!item.pdf_path || !pdfPathPertenceAoUsuario(item.pdf_path)) {
      return { tipo: 'semPdf', linha: item };
    }

    // upsert do cliente por (usuario_id, telefone) -- evita duplicar se
    // reimportar a planilha, sem colidir com o cliente de outro operador que
    // por acaso tenha o mesmo telefone salvo (ver migration-13-multi-tenant.sql).
    const { data: cliente, error: clienteError } = await supabase
      .from('clientes')
      .upsert(
        {
          usuario_id: usuarioId,
          nome: item.nome,
          telefone: item.telefoneNormalizado,
          valor: item.valor,
          vencimento: item.vencimento,
        },
        { onConflict: 'usuario_id,telefone' },
      )
      .select()
      .single();

    if (clienteError) {
      return { tipo: 'semDados', linha: { ...item, erro: clienteError.message } };
    }

    // Propaga o PDF/pix/linha digitável pro grupo inteiro, caso este cliente
    // já tenha outro número vinculado (ver lib/faturaPropagacao.js e
    // migration-15) -- a importação em si só sabe casar 1 linha = 1
    // telefone, o vínculo entre números é feito à parte, na tela Clientes.
    const { error: updateError } = await propagarDadosFatura(cliente.id, usuarioId, {
      pdf_path: item.pdf_path,
      pix_code: item.pix_code ?? null,
      linha_digitavel: item.linha_digitavel ?? null,
      pdf_atualizado_em: new Date().toISOString(),
    });

    if (updateError) {
      return { tipo: 'semDados', linha: { ...item, erro: updateError.message } };
    }

    return { tipo: 'sucesso', linha: item, cliente_id: cliente.id };
  }

  const processadasItens = await mapComConcorrencia(itensProntos, CONCORRENCIA_UPSERT_LOTE, processarItem);
  const processadasSemDados = linhasSemDados.map((linha) => ({ tipo: 'semDados', linha }));
  const todasProcessadas = [...processadasSemDados, ...processadasItens];
  const totalLinhas = itensProntos.length + linhasSemDados.length;

  return montarResumoECriarEnvio(totalLinhas, todasProcessadas, templateMensagemPadrao, lote, usuarioId);
}
