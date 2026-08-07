import { Router } from 'express';
import multer from 'multer';
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

export default router;
