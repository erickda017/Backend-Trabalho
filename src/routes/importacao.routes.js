import { Router } from 'express';
import XLSX from 'xlsx';

const router = Router();

// [2026-09] O fluxo de "planilha + zip" (parse no navegador, fatiamento do
// PDF + extração de Pix via Cloudflare Worker, upload em massa -- POST
// /upload-pdf e POST /lote, que existiam aqui) foi REMOVIDO -- ver
// CONTEXTO.md ("PDF sem planilha obrigatória") pro pedido original. Motivo:
// o Worker tinha um limite de 1MB por página de OCR que travava o casamento
// de PDF com cliente pra boletos maiores -- o PDF nem precisa passar pelo
// Worker pra ser associado (isso já é feito só pelo NOME do arquivo, ver
// lib/faturasPendentes.js), e o operador já cadastra os clientes colando a
// lista crua (`POST /clientes/converter-lista` + `/importar-lista`, sem PDF
// nenhum) -- os PDFs sobem depois, soltos, via `POST /faturas/avulsas`
// (routes/faturasPendentes.routes.js), que nunca dependeu do Worker.
// `services/importLote.js` (só usado por essas duas rotas) foi apagado
// junto. Mantida só a resposta 410 pro fluxo AINDA MAIS antigo (zip+PDF
// binário direto pro servidor, já removido antes desta rodada) e o modelo de
// planilha (referência de colunas, ainda usado como download avulso).
router.post('/', (req, res) => {
  res.status(410).json({
    error:
      'A importação por planilha + zip de PDFs foi descontinuada. Cole a lista de clientes ' +
      '(tela Importar, "1. Cole a lista de clientes") e suba os PDFs das faturas soltos, ' +
      'em "2. Suba os PDFs das faturas" -- cada PDF é casado pelo nome do arquivo, sem ' +
      'precisar de planilha nenhuma.',
  });
});
router.post('/lote', (req, res) => {
  res.status(410).json({
    error:
      'Este fluxo de importação em lote foi descontinuado. Cole a lista de clientes e suba os ' +
      'PDFs das faturas soltos na tela Importar -- não precisa mais de planilha+zip juntos.',
  });
});
router.post('/upload-pdf', (req, res) => {
  res.status(410).json({
    error: 'Este endpoint foi descontinuado. Suba o PDF avulso em "2. Suba os PDFs das faturas", na tela Importar.',
  });
});

// Planilha modelo pra baixar e preencher -- referência de colunas pra quem
// prefere montar a lista em planilha antes de colar no "Converter lista".
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
