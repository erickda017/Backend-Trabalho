import { Router } from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import { processarImportacaoLotePronto } from '../services/importLote.js';
import { normalizarTelefone } from '../lib/telefone.js';
import { supabase, BUCKET } from '../lib/supabase.js';

const router = Router();

const MENSAGEM_PADRAO =
  'Olá {{nome}}, tudo bem? Segue em anexo sua fatura no valor de {{valor}}, com vencimento em {{vencimento}}. Qualquer dúvida estou à disposição!';

// Multer só pra 1 PDF por vez (repasse pro Storage) -- é o único ponto do
// backend que ainda encosta em bytes de PDF, e mesmo assim só pra guardar
// (nunca processa/lê o conteúdo). 15MB cobre boleto tranquilo; se algum PDF
// passar disso o problema é o PDF, não o limite.
const uploadPdfUnico = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// Repasse de 1 PDF pro Storage usando a service_role key (ignora RLS).
// Existe porque o upload direto do navegador (anon/authenticated key, sujeito a
// RLS) está bloqueado nesse projeto Supabase por uma causa que não é do código
// (bucket/policy/grant conferem, Postgres nega mesmo assim -- ver conversa/
// investigação). Isso NÃO reintroduz o problema de RAM que a migration-5 tentava
// evitar: o navegador continua fazendo o trabalho pesado (fatiar o PDF com
// pdf-lib + chamar o Worker de OCR pra achar o Pix, em pixWorkerClient.ts) --
// aqui só passa os bytes já prontos, sem processar nada.
// Wrapper pro upload de 1 PDF avulso -- erro do multer (arquivo grande) não cai no
// try/catch do handler, precisa ser pego aqui pra devolver 413 com mensagem
// clara em vez do 500 genérico padrão do Express.
function uploadPdfComTratamentoDeErro(req, res, next) {
  uploadPdfUnico.single('pdf')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'PDF muito grande (limite: 15MB por arquivo).' });
    }
    console.error('[importacao] erro no upload-pdf (multer):', err.message);
    return res.status(400).json({ error: err.message || 'Erro ao processar o upload' });
  });
}

// Valida o "caminho" informado pelo cliente antes de usá-lo como object key no
// Storage. Sem isso, qualquer usuário autenticado podia mandar um `caminho`
// arbitrário (ex: "../outra-pasta/arquivo.pdf" ou o caminho exato de OUTRO
// cliente) e, como o upload usa upsert:true, sobrescrever/acessar arquivos que
// não são dela -- uma falha de controle de acesso (IDOR), não só um path
// traversal. Aceita apenas letras/números/`-`/`_`/`.`/`/` e bloqueia qualquer
// segmento "..".
const CAMINHO_VALIDO = /^[a-zA-Z0-9_\-./]+$/;
function caminhoSeguro(caminho) {
  if (!caminho || typeof caminho !== 'string') return null;
  const normalizado = caminho.trim().replace(/^\/+/, '');
  if (!normalizado) return null;
  if (!CAMINHO_VALIDO.test(normalizado)) return null;
  if (normalizado.split('/').some((segmento) => segmento === '..' || segmento === '.')) return null;
  return normalizado;
}

router.post('/upload-pdf', uploadPdfComTratamentoDeErro, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'arquivo pdf não enviado' });
    const caminho = caminhoSeguro(req.body?.caminho);
    if (!caminho) {
      return res.status(400).json({ error: 'campo "caminho" é obrigatório e não pode conter ".." ou caracteres inválidos' });
    }

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(caminho, req.file.buffer, { contentType: 'application/pdf', upsert: true });

    if (uploadError) return res.status(500).json({ error: uploadError.message });

    const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(caminho);

    res.status(201).json({ path: caminho, publicUrl: publicUrlData.publicUrl });
  } catch (err) {
    console.error('[importacao] erro no upload-pdf:', err);
    res.status(500).json({ error: err.message });
  }
});

// [2026-08] Rota antiga removida: recebia "planilha" + "zip" (PDFs binários)
// via multipart/form-data e processava tudo no servidor (render em canvas +
// QR). Isso NUNCA MAIS deve acontecer -- nenhum PDF pode chegar ao backend
// sem já ter passado pelo fatiamento + Cloudflare Worker no navegador (ver
// POST /lote abaixo). Mantemos a rota respondendo 410 pra front antigo em
// cache não falhar silenciosamente / com erro genérico.
router.post('/', (req, res) => {
  res.status(410).json({
    error:
      'Este fluxo de importação (upload direto de zip com PDFs) foi descontinuado. ' +
      'Use a importação pelo navegador (POST /api/importacao/lote), que fatia e processa ' +
      'os PDFs no cliente antes de enviar qualquer dado ao servidor.',
  });
});

// Limites de sanidade pro payload do lote pronto -- aqui não tem PDF (só texto:
// nome, telefone, URLs do Storage, código Pix), então o payload é leve mesmo com
// centenas de linhas, mas ainda vale um teto pra não aceitar um JSON absurdo por
// engano ou abuso (ex: 5000 linhas de uma vez).
const MAX_ITENS_LOTE = 1000;

// Um item de itensProntos é válido se tiver os campos mínimos esperados. Não
// confiamos cegamente no navegador: revalida telefone/nome aqui, igual o fluxo
// antigo fazia -- o cliente só faz o trabalho PESADO (parse de zip, extração de
// PIX) antes de mandar; a validação de dados continua sendo responsabilidade do
// servidor.
function validarItemLote(item) {
  if (!item || typeof item !== 'object') return 'item inválido';
  if (!item.nome || typeof item.nome !== 'string' || !item.nome.trim()) return 'nome ausente';
  if (!item.numero || typeof item.numero !== 'string') return 'numero ausente';
  const telefoneNormalizado = normalizarTelefone(item.numero);
  if (!telefoneNormalizado) return 'telefone inválido';
  if (item.pdf_url && typeof item.pdf_url !== 'string') return 'pdf_url inválido';
  if (item.pdf_path && typeof item.pdf_path !== 'string') return 'pdf_path inválido';
  if (item.linha_digitavel && typeof item.linha_digitavel !== 'string') return 'linha_digitavel inválida';
  return null;
}

// Importação client-side: o navegador de quem importa já fez todo o trabalho
// pesado (parse do zip com JSZip, parse da planilha com SheetJS, fatiamento do
// PDF com pdf-lib + extração via Cloudflare Worker de OCR, e upload de cada
// PDF direto pro Supabase Storage usando a sessão autenticada do usuário --
// ver frontend/src/lib/importacaoBrowser.ts e pixWorkerClient.ts). O servidor
// só recebe texto: nome/telefone/valor/vencimento/linha digitável/URL do PDF
// já hospedado/código Pix já extraído -- nunca vê um PDF, nunca faz OCR. Por
// isso pode processar uma importação de 100+ clientes sem chegar perto de
// estourar RAM, mesmo num plano de hospedagem pequeno (Render free, 512MB).
router.post('/lote', async (req, res) => {
  try {
    const { itens, mensagem, lote } = req.body || {};

    if (!Array.isArray(itens)) {
      return res.status(400).json({ error: 'Campo "itens" (array) é obrigatório' });
    }
    if (itens.length === 0) {
      return res.status(400).json({ error: 'A planilha não tem nenhuma linha para importar' });
    }
    if (itens.length > MAX_ITENS_LOTE) {
      return res.status(413).json({
        error: `Lote grande demais (${itens.length} linhas, limite ${MAX_ITENS_LOTE}). Divida em partes menores.`,
      });
    }

    const itensProntos = [];
    const linhasSemDados = [];

    for (const item of itens) {
      const erroValidacao = validarItemLote(item);
      if (erroValidacao) {
        linhasSemDados.push({ ...item, erro: erroValidacao });
        continue;
      }
      itensProntos.push({
        ...item,
        telefoneNormalizado: normalizarTelefone(item.numero),
      });
    }

    const templateMensagemPadrao = typeof mensagem === 'string' && mensagem.trim() ? mensagem.trim() : MENSAGEM_PADRAO;

    const resultado = await processarImportacaoLotePronto({
      itensProntos,
      linhasSemDados,
      templateMensagemPadrao,
      lote: typeof lote === 'string' ? lote.trim().slice(0, 120) || null : null,
    });

    res.status(201).json(resultado);
  } catch (err) {
    console.error('[importacao] erro no lote client-side:', err);
    res.status(500).json({ error: err.message });
  }
});

// Planilha modelo pra baixar e preencher -- mesmas colunas (com variações aceitas)
// que parsePlanilha() em frontend/src/lib/importacaoBrowser.ts reconhece. "arquivo"
// é o nome do PDF dentro do zip que vai ser importado junto; se não usar zip (só
// disparo por planilha avulsa via seleção manual), pode deixar em branco.
router.get('/modelo', (req, res) => {
  const linhas = [
    {
      nome: 'Maria da Silva',
      numero: '11987654321',
      mensagem: 'Olá {{nome}}, tudo bem? Segue sua fatura no valor de {{valor}}, vencimento {{vencimento}}.',
      valor: '150.00',
      vencimento: '10/09/2026',
      arquivo: 'maria-da-silva.pdf',
    },
    {
      nome: 'João Pereira',
      numero: '21998765432',
      mensagem: '',
      valor: '89.90',
      vencimento: '15/09/2026',
      arquivo: 'joao-pereira.pdf',
    },
  ];

  const planilha = XLSX.utils.json_to_sheet(linhas, {
    header: ['nome', 'numero', 'mensagem', 'valor', 'vencimento', 'arquivo'],
  });
  planilha['!cols'] = [{ wch: 22 }, { wch: 15 }, { wch: 45 }, { wch: 10 }, { wch: 14 }, { wch: 22 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, planilha, 'clientes');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-importacao.xlsx"');
  res.send(buffer);
});

export default router;
