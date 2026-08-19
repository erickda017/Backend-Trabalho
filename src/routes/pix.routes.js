import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { responderExportacao } from '../lib/exportar.js';
import { escaparFiltroPostgrest } from '../lib/filtros.js';

// [2026-08] Esta rota NÃO recebe mais PDF nenhum. O upload + extração de Pix
// (fatiar o PDF com pdf-lib, mandar cada página pro Cloudflare Worker de OCR)
// acontece 100% no navegador -- ver frontend/src/lib/pixWorkerClient.ts. O
// resultado já pronto é salvo via POST /api/boletos/salvar-pix (ver
// boletos.routes.js). Esta rota ficou só com listagem/consulta das extrações
// já feitas, vínculo manual com cliente e exportação -- nada aqui grava ou lê
// bytes de PDF, então não há mais risco de RAM associado a ela.
const router = Router();

function serializar(linha) {
  return {
    id: linha.id,
    arquivo: linha.arquivo,
    cliente_id: linha.cliente_id,
    cliente_nome: linha.clientes?.nome || null,
    status: linha.status,
    pix_code: linha.pix_code,
    valor: linha.valor,
    vencimento: linha.vencimento,
    linha_digitavel: linha.linha_digitavel,
    erro: linha.erro,
    criado_em: linha.criado_em,
  };
}

router.get('/', async (req, res) => {
  const { busca, status, cliente_id } = req.query;
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });

  let query = supabase
    .from('pix_extracoes')
    .select('*, clientes(nome)', { count: 'exact' })
    .order('criado_em', { ascending: false });

  if (busca) query = query.ilike('arquivo', `%${escaparFiltroPostgrest(busca)}%`);
  if (status && status !== 'todos') query = query.eq('status', status);
  if (cliente_id) query = query.eq('cliente_id', cliente_id);

  const { data, error } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  res.json((data || []).map(serializar));
});

// Grava o pix_code já extraído no cliente informado
router.post('/:id/aplicar', async (req, res) => {
  const { id } = req.params;
  const { cliente_id } = req.body || {};
  if (!cliente_id) return res.status(400).json({ error: 'cliente_id é obrigatório' });

  const { data: linha, error } = await supabase
    .from('pix_extracoes')
    .select('pix_code, valor, vencimento, linha_digitavel')
    .eq('id', id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!linha) return res.status(404).json({ error: 'Extração não encontrada' });
  if (!linha.pix_code) return res.status(400).json({ error: 'Esta extração não tem um código Pix encontrado' });

  const { error: updateError } = await supabase
    .from('clientes')
    .update({
      pix_code: linha.pix_code,
      ...(linha.valor ? { valor: linha.valor } : {}),
      ...(linha.vencimento ? { vencimento: linha.vencimento } : {}),
      ...(linha.linha_digitavel ? { linha_digitavel: linha.linha_digitavel } : {}),
    })
    .eq('id', cliente_id);
  if (updateError) return res.status(500).json({ error: updateError.message });

  const { data: atualizada, error: selectError } = await supabase
    .from('pix_extracoes')
    .update({ cliente_id })
    .eq('id', id)
    .select('*, clientes(nome)')
    .single();
  if (selectError) return res.status(500).json({ error: selectError.message });

  res.json(serializar(atualizada));
});

router.get('/exportar', async (req, res) => {
  const { formato = 'csv' } = req.query;
  const { data, error } = await supabase
    .from('pix_extracoes')
    .select('*, clientes(nome)')
    .order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  responderExportacao(res, formato, 'pix-extracoes', (data || []).map(serializar));
});

export default router;
