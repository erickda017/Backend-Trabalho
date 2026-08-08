import { Router } from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import { processarImportacao } from '../services/importLote.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
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

// multipart/form-data com dois arquivos: "planilha" (.xlsx/.csv) e "zip" (pdfs) + "mensagem" (opcional)
router.post(
  '/',
  upload.fields([
    { name: 'planilha', maxCount: 1 },
    { name: 'zip', maxCount: 1 },
  ]),
  async (req, res) => {
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
  }
);

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
