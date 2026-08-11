import XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import { supabase, BUCKET } from '../lib/supabase.js';
import { normalizarTelefone } from '../lib/telefone.js';
import { extrairPixDoPdf } from '../lib/pixFromPdf.js';

// Normaliza texto pra comparar nomes de arquivo com tolerância a maiúsculas/acentos/espaços
function normalizar(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .trim();
}

function normalizarNomeArquivo(str) {
  return normalizar(str).replace(/\.pdf$/i, '');
}

// Aceita variações de nome de coluna (numero, número, telefone, whatsapp...)
function acharColuna(linha, candidatos) {
  const chaves = Object.keys(linha);
  for (const candidato of candidatos) {
    const encontrada = chaves.find((k) => normalizar(k) === normalizar(candidato));
    if (encontrada) return linha[encontrada];
  }
  return null;
}

export function parsePlanilha(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const primeiraAba = workbook.SheetNames[0];
  const linhas = XLSX.utils.sheet_to_json(workbook.Sheets[primeiraAba], { defval: '' });

  return linhas.map((linha, index) => {
    const numero = acharColuna(linha, ['numero', 'número', 'telefone', 'whatsapp', 'celular']);
    const nome = acharColuna(linha, ['nome', 'cliente']);
    const arquivo = acharColuna(linha, ['arquivo', 'pdf', 'nome do arquivo', 'arquivo pdf']);
    const mensagem = acharColuna(linha, ['mensagem', 'msg', 'texto']);
    const valor = acharColuna(linha, ['valor']);
    const vencimento = acharColuna(linha, ['vencimento', 'data de vencimento']);

    return {
      linha: index + 2, // +2 pq linha 1 é o cabeçalho na planilha original
      numero: String(numero || '').trim(),
      nome: String(nome || '').trim(),
      arquivo: String(arquivo || '').trim(),
      mensagem: mensagem ? String(mensagem).trim() : null,
      // aceita "150,00" (padrão BR) além de "150.00" -- coluna no banco é numérica e rejeita vírgula
      valor: valor ? String(valor).trim().replace(',', '.') : null,
      vencimento: vencimento ? String(vencimento).trim() : null,
    };
  });
}

export function extrairPdfsDoZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && /\.pdf$/i.test(e.entryName));

  // mapa: nome normalizado -> { nomeOriginal, conteudo (Buffer) }
  const mapa = new Map();
  for (const entry of entries) {
    const nomeArquivo = entry.entryName.split('/').pop(); // ignora subpastas dentro do zip
    mapa.set(normalizarNomeArquivo(nomeArquivo), {
      nomeOriginal: nomeArquivo,
      conteudo: entry.getData(),
    });
  }
  return mapa;
}

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

const CONCORRENCIA_IMPORTACAO = Number(process.env.IMPORTACAO_CONCORRENCIA || 6);

// Processa planilha + zip: cria/atualiza clientes, faz upload dos PDFs e monta o lote de envio.
// Retorna um resumo com o que deu certo e o que ficou pendente (sem PDF ou sem numero/nome).
export async function processarImportacao({ planilhaBuffer, zipBuffer, templateMensagemPadrao }) {
  const linhas = parsePlanilha(planilhaBuffer);
  const pdfsPorNome = extrairPdfsDoZip(zipBuffer);

  // Cada linha vira um resultado tipado: { tipo: 'sucesso'|'semPdf'|'semDados', linha, cliente_id? }
  async function processarLinha(linha) {
    if (!linha.numero || !linha.nome) {
      return { tipo: 'semDados', linha };
    }

    // normaliza pra dígitos + código do país -- garante que o upsert por telefone (onConflict)
    // realmente reconhece o mesmo cliente entre importações, mesmo que a planilha varie a
    // formatação ("(11) 99999-9999" numa vez, "11999999999" na próxima)
    const telefoneNormalizado = normalizarTelefone(linha.numero);
    if (!telefoneNormalizado) {
      return { tipo: 'semDados', linha: { ...linha, erro: 'telefone inválido' } };
    }

    // Casa o PDF do zip com este cliente: 1) pelo nome exato da coluna "arquivo"
    // (quando o usuário preencheu), 2) senão, por fallback, pelo NOME do cliente
    // -- é o caso mais comum na prática: o usuário nomeia cada PDF igual ao nome
    // do cliente na planilha (ex: "ALCIDES JOSE PEGORARO.pdf") e deixa a coluna
    // "arquivo" em branco, esperando que o sistema case sozinho.
    const chavePorArquivo = linha.arquivo ? normalizarNomeArquivo(linha.arquivo) : null;
    const chavePorNome = linha.nome ? normalizarNomeArquivo(linha.nome) : null;
    const pdfEncontrado =
      (chavePorArquivo && pdfsPorNome.get(chavePorArquivo)) ||
      (chavePorNome && pdfsPorNome.get(chavePorNome)) ||
      null;

    if (!pdfEncontrado) {
      return { tipo: 'semPdf', linha };
    }

    // upsert do cliente por telefone (evita duplicar se reimportar a planilha)
    const { data: cliente, error: clienteError } = await supabase
      .from('clientes')
      .upsert(
        {
          nome: linha.nome,
          telefone: telefoneNormalizado,
          valor: linha.valor,
          vencimento: linha.vencimento,
        },
        { onConflict: 'telefone' }
      )
      .select()
      .single();

    if (clienteError) {
      return { tipo: 'semDados', linha: { ...linha, erro: clienteError.message } };
    }

    // upload do PDF pro storage
    const caminho = `${cliente.id}/${Date.now()}-${pdfEncontrado.nomeOriginal}`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(caminho, pdfEncontrado.conteudo, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      return { tipo: 'semDados', linha: { ...linha, erro: uploadError.message } };
    }

    const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(caminho);

    // Mesma extração de Pix do upload manual (clientes.routes.js) -- não falha a
    // importação se não achar QR, só deixa pix_code null pra esse cliente.
    const pixCode = await extrairPixDoPdf(pdfEncontrado.conteudo);

    const { error: updateError } = await supabase
      .from('clientes')
      .update({ pdf_url: publicUrlData.publicUrl, pdf_path: caminho, pix_code: pixCode })
      .eq('id', cliente.id);

    if (updateError) {
      return { tipo: 'semDados', linha: { ...linha, erro: updateError.message } };
    }

    return { tipo: 'sucesso', linha, cliente_id: cliente.id };
  }

  const processadas = await mapComConcorrencia(linhas, CONCORRENCIA_IMPORTACAO, processarLinha);

  const resultado = {
    total: linhas.length,
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
    .insert({ template_mensagem: templateMensagemPadrao, status: 'pendente' })
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
