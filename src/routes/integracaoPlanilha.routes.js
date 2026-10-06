import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { buscarTodos } from '../lib/buscarTodos.js';
import { limiteSensivel } from '../lib/rateLimit.js';
import { atualizarPlanilha, configuracaoPlanilha } from '../lib/planilhaIntegracao.js';

// [2026-10] Botão "Atualizar Pix na planilha" (operador e supervisor) --
// ver lib/planilhaIntegracao.js. Manda os Pix de TODOS os operadores (mesma
// fonte de GET /supervisor/extracoes-pix), por decisão do supervisor: a
// planilha oficial é uma só.
const router = Router();

// Um clique por vez no servidor inteiro: dois cliques simultâneos (operador
// + supervisor) só disputariam a trava do Apps Script.
let emAndamento = false;

async function extracoesComCodigo() {
  const { data, error } = await buscarTodos(() =>
    supabase
      .from('pix_extracoes')
      .select('arquivo, nome, codigo, vencimento, pix_code, criado_em')
      .not('codigo', 'is', null)
      .not('pix_code', 'is', null)
      .order('criado_em', { ascending: false })
      .order('id', { ascending: true })
  );
  if (error) throw error;
  return data || [];
}

// POST /api/integracao/planilha/atualizar
router.post('/atualizar', limiteSensivel, async (req, res) => {
  if (emAndamento) return res.status(409).json({ error: 'Já tem uma atualização da planilha rodando. Aguarde terminar.' });
  emAndamento = true;
  try {
    const { status, body } = await atualizarPlanilha({ config: configuracaoPlanilha(), buscarExtracoes: extracoesComCodigo });
    if (status !== 200) console.error(`[planilha] atualização falhou (${status}, usuário ${req.user.id}):`, body.error);
    else console.log(`[planilha] atualizada por ${req.user.id}: ${body.preenchidas} Pix preenchido(s) de ${body.extracoesEnviadas} enviado(s).`);
    res.status(status).json(body);
  } catch (err) {
    console.error('[planilha] erro ao atualizar:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    emAndamento = false;
  }
});

export default router;
