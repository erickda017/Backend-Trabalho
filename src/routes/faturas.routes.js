import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { responderExportacao } from '../lib/exportar.js';

const router = Router();

// "Fatura" = o cliente em si, do ponto de vista de quem tem (ou não) um PDF anexado.
// Não existe tabela própria -- é uma visão sobre `clientes` filtrada por com_pdf/sem_pdf.
router.get('/', async (req, res) => {
  const { busca, com_pdf, sem_pdf } = req.query;
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });

  let query = supabase
    .from('clientes')
    .select('id, nome, telefone, valor, vencimento, pdf_url, pdf_path, pix_code', { count: 'exact' })
    .order('nome');

  if (busca) query = query.or(`nome.ilike.%${busca}%,telefone.ilike.%${busca}%`);
  if (com_pdf === 'true' || com_pdf === '1') query = query.not('pdf_url', 'is', null);
  if (sem_pdf === 'true' || sem_pdf === '1') query = query.is('pdf_url', null);

  const { data, error } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  res.json(data || []);
});

router.get('/exportar', async (req, res) => {
  const { formato = 'csv' } = req.query;
  const { data, error } = await supabase
    .from('clientes')
    .select('nome, telefone, valor, vencimento, pdf_url, pix_code')
    .order('nome');
  if (error) return res.status(500).json({ error: error.message });

  responderExportacao(res, formato, 'faturas', data || []);
});

export default router;
