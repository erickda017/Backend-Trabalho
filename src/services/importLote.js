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

// Processa planilha + zip: cria/atualiza clientes, faz upload dos PDFs e monta o lote de envio.
// Retorna um resumo com o que deu certo e o que ficou pendente (sem PDF ou sem numero/nome).
export async function processarImportacao({ planilhaBuffer, zipBuffer, templateMensagemPadrao }) {
  const linhas = parsePlanilha(planilhaBuffer);
  const pdfsPorNome = extrairPdfsDoZip(zipBuffer);

  const resultado = {
    total: linhas.length,
    sucesso: [],
    semPdf: [],
    semDadosObrigatorios: [],
  };

  const clienteIdsParaEnvio = [];
  const mensagensPorCliente = new Map(); // cliente_id -> mensagem_override (se a planilha trouxer mensagem por linha)

  for (const linha of linhas) {
    if (!linha.numero || !linha.nome) {
      resultado.semDadosObrigatorios.push(linha);
      continue;
    }

    // normaliza pra dígitos + código do país -- garante que o upsert por telefone (onConflict)
    // realmente reconhece o mesmo cliente entre importações, mesmo que a planilha varie a
    // formatação ("(11) 99999-9999" numa vez, "11999999999" na próxima)
    const telefoneNormalizado = normalizarTelefone(linha.numero);
    if (!telefoneNormalizado) {
      resultado.semDadosObrigatorios.push({ ...linha, erro: 'telefone inválido' });
      continue;
    }

    const pdfEncontrado = linha.arquivo
      ? pdfsPorNome.get(normalizarNomeArquivo(linha.arquivo))
      : null;

    if (!pdfEncontrado) {
      resultado.semPdf.push(linha);
      continue;
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
      resultado.semDadosObrigatorios.push({ ...linha, erro: clienteError.message });
      continue;
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
      resultado.semDadosObrigatorios.push({ ...linha, erro: uploadError.message });
      continue;
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
      resultado.semDadosObrigatorios.push({ ...linha, erro: updateError.message });
      continue;
    }

    clienteIdsParaEnvio.push(cliente.id);
    if (linha.mensagem) mensagensPorCliente.set(cliente.id, linha.mensagem);
    resultado.sucesso.push({ ...linha, cliente_id: cliente.id });
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
