import { Router } from 'express';
import { supabase, urlsProxyArquivo } from '../lib/supabase.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { responderExportacao } from '../lib/exportar.js';
import { escaparFiltroPostgrest } from '../lib/filtros.js';

const router = Router();

// "Fatura" = o cliente em si, do ponto de vista de quem tem (ou não) um PDF anexado.
// Não existe tabela própria -- é uma visão sobre `clientes` filtrada por com_pdf/sem_pdf.
//
// [2026-08] SEGURANÇA: filtros com_pdf/sem_pdf e a coluna `pdf_url` da resposta
// agora usam `pdf_path` como fonte da verdade (bucket privado, pdf_url não é
// mais persistida -- ver clientes.routes.js). O `pdf_url` devolvido ao front
// não é mais uma signed URL do Supabase, é um path relativo ao proxy de
// arquivos deste backend (ver `urlProxyArquivo` em lib/supabase.js e
// routes/arquivos.routes.js) -- evita expor o domínio do Supabase na barra
// de endereço do navegador quando o PDF é aberto.
router.get('/', async (req, res) => {
  const { busca, com_pdf, sem_pdf } = req.query;
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });

  // Aliases explícitos: o frontend (/faturas) espera cliente_id/cliente_nome,
  // não id/nome -- sem isso o nome do cliente vinha undefined em cada linha.
  let query = supabase
    .from('clientes')
    .select('id, cliente_id:id, cliente_nome:nome, telefone, valor, vencimento, pdf_path, pix_code', { count: 'exact' })
    .eq('usuario_id', req.user.id)
    .order('nome');

  if (busca) query = query.or(`nome.ilike.%${escaparFiltroPostgrest(busca)}%,telefone.ilike.%${escaparFiltroPostgrest(busca)}%`);
  if (com_pdf === 'true' || com_pdf === '1') query = query.not('pdf_path', 'is', null);
  if (sem_pdf === 'true' || sem_pdf === '1') query = query.is('pdf_path', null);

  const { data, error } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  const linhas = data || [];
  const urls = urlsProxyArquivo('faturas', linhas.map((l) => l.pdf_path));
  res.json(linhas.map((l, i) => ({ ...l, pdf_url: urls[i] })));
});

// Exportação (CSV/etc): aqui NÃO geramos signed URL -- um export baixado fica
// salvo no computador do usuário, fora do controle de expiração/acesso do
// sistema, e uma signed URL embutida nele funcionaria por até o TTL mesmo pra
// quem só tiver o arquivo exportado. Exporta o `pdf_path` (referência interna,
// não abre em navegador) em vez da URL -- quem precisar abrir o PDF usa a
// tela /faturas ou /clientes, que sempre pedem login.
router.get('/exportar', async (req, res) => {
  const { formato = 'csv' } = req.query;
  const { data, error } = await supabase
    .from('clientes')
    .select('nome, telefone, valor, vencimento, pdf_path, pix_code')
    .eq('usuario_id', req.user.id)
    .order('nome');
  if (error) return res.status(500).json({ error: error.message });

  responderExportacao(res, formato, 'faturas', data || []);
});

export default router;
