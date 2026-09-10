import { Router } from 'express';
import multer from 'multer';
import { supabase } from '../lib/supabase.js';
import { parsePlanilhaChip, processarImportacaoChip } from '../services/importLoteChip.js';
import { STATUS_CHIP, statusChipValido } from '../lib/statusChip.js';
import { limiteSensivel } from '../lib/rateLimit.js';

const router = Router();

// [2026-09] Aba "Ativação Chip" -- campanha separada da de cobrança (ver
// CONTEXTO.md e migration-25-ativacao-chip.sql). Reaproveita a tabela
// `clientes` (com campanha='chip_ativacao') via as rotas normais de
// GET/PUT/DELETE /api/clientes (que já aceitam ?campanha=chip_ativacao e os
// campos extras dessa campanha, ver clientes.routes.js) -- esta rota cobre
// só o que é exclusivo de chip: importação da planilha própria e o
// status/tratativa dessa campanha.

const uploadPlanilha = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB -- planilha de texto puro, sem PDF/mídia
});

function uploadPlanilhaComTratamentoDeErro(req, res, next) {
  uploadPlanilha.single('planilha')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Planilha muito grande (limite: 10MB).' });
    }
    console.error('[ativacao-chip] erro no upload da planilha (multer):', err.message);
    return res.status(400).json({ error: err.message || 'Erro ao processar o upload' });
  });
}

// Importa a planilha de Ativação Chip (.xlsx/.xls/.csv) -- diferente do fluxo
// de fatura, o parse inteiro roda aqui (sem PDF/OCR envolvido, não precisa do
// trabalho client-side, ver services/importLoteChip.js).
router.post('/importar', limiteSensivel, uploadPlanilhaComTratamentoDeErro, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'arquivo da planilha não enviado (campo "planilha")' });

  try {
    const { itens, semDados } = parsePlanilhaChip(req.file.buffer);
    if (!itens.length && !semDados.length) {
      return res.status(400).json({ error: 'A planilha não tem nenhuma linha reconhecível (confira as colunas CLIENTE e TEL 1)' });
    }

    const resultado = await processarImportacaoChip({ itens, semDados, usuarioId: req.user.id });
    res.status(201).json(resultado);
  } catch (err) {
    console.error('[ativacao-chip] erro ao importar planilha:', err);
    res.status(500).json({ error: err.message });
  }
});

// Catálogo de status da campanha de chip (dropdown do front).
router.get('/status', (req, res) => {
  res.json(STATUS_CHIP);
});

// Registra o desfecho de uma tratativa de ativação de chip -- mesmo
// mecanismo (tabela tratativas + clientes.status_operador) que a campanha de
// cobrança já usa (ver qualidade.routes.js), só com o vocabulário de chip.
router.post('/clientes/:clienteId/status', async (req, res) => {
  const { clienteId } = req.params;
  const { status, observacao } = req.body || {};
  const usuarioId = req.user.id;

  if (!statusChipValido(status)) {
    return res.status(400).json({ error: `status inválido. Use um de: ${STATUS_CHIP.map((s) => s.valor).join(', ')}` });
  }

  const { data: cliente } = await supabase
    .from('clientes')
    .select('id')
    .eq('id', clienteId)
    .eq('usuario_id', usuarioId)
    .eq('campanha', 'chip_ativacao')
    .maybeSingle();
  if (!cliente) return res.status(404).json({ error: 'Cliente de Ativação Chip não encontrado' });

  const { data: tratativa, error: tratativaError } = await supabase
    .from('tratativas')
    .insert({
      usuario_id: usuarioId,
      cliente_id: clienteId,
      status,
      observacao: typeof observacao === 'string' && observacao.trim() ? observacao.trim() : null,
    })
    .select()
    .single();
  if (tratativaError) return res.status(500).json({ error: tratativaError.message });

  const { error: updateError } = await supabase
    .from('clientes')
    .update({ status_operador: status, status_operador_atualizado_em: new Date().toISOString() })
    .eq('id', clienteId)
    .eq('usuario_id', usuarioId);
  if (updateError) return res.status(500).json({ error: updateError.message });

  res.status(201).json(tratativa);
});

// Histórico de tratativas de um cliente de chip.
router.get('/clientes/:clienteId/historico', async (req, res) => {
  const { clienteId } = req.params;
  const usuarioId = req.user.id;

  const { data: cliente } = await supabase
    .from('clientes')
    .select('id')
    .eq('id', clienteId)
    .eq('usuario_id', usuarioId)
    .eq('campanha', 'chip_ativacao')
    .maybeSingle();
  if (!cliente) return res.status(404).json({ error: 'Cliente de Ativação Chip não encontrado' });

  const { data, error } = await supabase
    .from('tratativas')
    .select('*')
    .eq('cliente_id', clienteId)
    .order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  res.json(data || []);
});

export default router;
