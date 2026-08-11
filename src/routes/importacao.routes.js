import { Router } from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import { processarImportacao, processarImportacaoLotePronto } from '../services/importLote.js';
import { normalizarTelefone } from '../lib/telefone.js';

const router = Router();
// Multer com memoryStorage guarda o arquivo INTEIRO na RAM do processo (o mesmo
// processo que mantém a sessão do WhatsApp aberta). 200MB por arquivo permitia,
// na prática, zip + planilha somando bem mais que a RAM de planos como o Render
// free (512MB) só pra receber o upload -- antes mesmo de processar PDF nenhum.
// 80MB é mais coerente com esse tipo de hospedagem; ainda cobre bastante volume
// (na faixa de 30-40 boletos de ~2MB cada por importação). Pra lotes maiores,
// a orientação é usar a importação client-side (ver POST /lote abaixo), que não
// passa PDF nenhum pelo servidor -- ou importar em partes até migrar de plano.
const LIMITE_ARQUIVO_BYTES = 80 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITE_ARQUIVO_BYTES },
  fileFilter: (req, file, cb) => {
    const tiposPlanilha = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel', // .xls
      'text/csv',
      'application/csv',
      'application/octet-stream', // alguns navegadores mandam isso pra csv/xlsx
    ];
    if (file.fieldname === 'planilha' && !tiposPlanilha.includes(file.mimetype)) {
      return cb(new Error('Planilha deve ser .xlsx, .xls ou .csv'));
    }
    if (file.fieldname === 'zip' && !['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(file.mimetype)) {
      return cb(new Error('O arquivo de PDFs deve ser um .zip'));
    }
    cb(null, true);
  },
});

const MENSAGEM_PADRAO =
  'Olá {{nome}}, tudo bem? Segue em anexo sua fatura no valor de {{valor}}, com vencimento em {{vencimento}}. Qualquer dúvida estou à disposição!';

// Wrapper em volta do middleware do multer -- erros de upload (arquivo grande
// demais, tipo errado no fileFilter) acontecem DENTRO do parsing do
// multipart/form-data, ou seja, antes do handler da rota rodar. O multer não
// joga esses erros pro try/catch do handler: ele chama next(err), que só é
// pego pelo error handler GLOBAL do server.js (que responde com uma mensagem
// genérica em inglês, tipo "File too large"). Interceptamos aqui pra devolver
// a mensagem certa, em português, com orientação do que fazer.
function uploadComTratamentoDeErro(req, res, next) {
  const middleware = upload.fields([
    { name: 'planilha', maxCount: 1 },
    { name: 'zip', maxCount: 1 },
  ]);

  middleware(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `Arquivo muito grande (limite: ${Math.round(LIMITE_ARQUIVO_BYTES / 1024 / 1024)}MB por arquivo). ` +
          'Divida a importação em levas menores (ex: 30-40 clientes por vez), ou use a importação ' +
          'pelo navegador (que não tem esse limite, pois não envia PDF pro servidor).',
      });
    }

    // erros lançados no fileFilter (tipo de arquivo errado) e outros erros do multer
    console.error('[importacao] erro no upload:', err.message);
    return res.status(400).json({ error: err.message || 'Erro ao processar o upload' });
  });
}

// multipart/form-data com dois arquivos: "planilha" (.xlsx/.csv) e "zip" (pdfs) + "mensagem" (opcional)
// FLUXO ANTIGO (server-side): o backend recebe o zip inteiro, renderiza cada PDF
// em canvas e escaneia QR pra achar o Pix. Mantido como fallback, mas o fluxo
// recomendado pra lotes grandes é POST /lote (ver abaixo), que faz esse trabalho
// pesado no navegador de quem importa, não no servidor.
router.post('/', uploadComTratamentoDeErro, async (req, res) => {
  try {
    const planilhaFile = req.files?.planilha?.[0];
    const zipFile = req.files?.zip?.[0];

    if (!planilhaFile) return res.status(400).json({ error: 'Envie a planilha (campo "planilha")' });
    if (!zipFile) return res.status(400).json({ error: 'Envie o zip com os PDFs (campo "zip")' });

    const templateMensagemPadrao = req.body?.mensagem?.trim() || MENSAGEM_PADRAO;

    const resultado = await processarImportacao({
      planilhaBuffer: planilhaFile.buffer,
      zipBuffer: zipFile.buffer,
      templateMensagemPadrao,
    });

    res.status(201).json(resultado);
  } catch (err) {
    console.error('[importacao] erro:', err);
    res.status(500).json({ error: err.message });
  }
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
  return null;
}

// Importação client-side: o navegador de quem importa já fez todo o trabalho
// pesado (parse do zip com JSZip, parse da planilha com SheetJS, extração de Pix
// via pdfjs-dist + jsQR, e upload de cada PDF direto pro Supabase Storage usando
// a sessão autenticada do usuário -- ver frontend/src/lib/importacaoBrowser.ts e
// pixFromPdfBrowser.ts). O servidor só recebe texto: nome/telefone/valor/URL do
// PDF já hospedado/código Pix já extraído -- nunca vê um PDF, nunca renderiza
// canvas, nunca escaneia QR. Por isso pode processar uma importação de 100+
// clientes sem chegar perto de estourar RAM, mesmo num plano de hospedagem
// pequeno (Render free, 512MB).
router.post('/lote', async (req, res) => {
  try {
    const { itens, mensagem } = req.body || {};

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
    });

    res.status(201).json(resultado);
  } catch (err) {
    console.error('[importacao] erro no lote client-side:', err);
    res.status(500).json({ error: err.message });
  }
});

// Planilha modelo pra baixar e preencher -- mesmas colunas (com variações aceitas)
// que parsePlanilha() em importLote.js reconhece. "arquivo" é o nome do PDF dentro
// do zip que vai ser importado junto; se não usar zip (só disparo por planilha
// avulsa via seleção manual), pode deixar em branco.
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
