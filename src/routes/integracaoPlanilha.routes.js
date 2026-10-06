import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { buscarTodos } from '../lib/buscarTodos.js';
import { limiteSensivel } from '../lib/rateLimit.js';
import { configuracaoPlanilha, executarAtualizacao, novaTarefa } from '../lib/planilhaIntegracao.js';

// [2026-10] Botão "Atualizar Pix na planilha" (operador e supervisor) --
// ver lib/planilhaIntegracao.js. Manda os Pix de TODOS os operadores (mesma
// fonte de GET /supervisor/extracoes-pix), por decisão do supervisor: a
// planilha oficial é uma só.
//
// Roda em segundo plano: POST /atualizar inicia (ou devolve a que já está
// rodando, em vez de erro) e o site acompanha por GET /status. Uma tarefa
// por vez no servidor inteiro. A última tarefa fica guardada em memória pra
// quem abrir a tela depois ver o resultado (some se o Render reiniciar).
const router = Router();

let tarefaAtual = null;

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
router.post('/atualizar', limiteSensivel, (req, res) => {
  if (tarefaAtual?.status === 'rodando') return res.json({ tarefa: tarefaAtual, jaEmAndamento: true });

  const tarefa = novaTarefa(req.user.id);
  tarefaAtual = tarefa;
  executarAtualizacao({ tarefa, config: configuracaoPlanilha(), buscarExtracoes: extracoesComCodigo })
    .then((t) => {
      if (t.status === 'erro') console.error(`[planilha] atualização falhou (usuário ${req.user.id}):`, t.erro);
      else console.log(`[planilha] ${t.status} (usuário ${req.user.id}): ${t.resumo?.verificadas ?? 0} Pix conferidos de ${t.extracoesEnviadas} enviados.`);
    })
    .catch((err) => {
      console.error('[planilha] erro inesperado:', err);
      Object.assign(tarefa, { status: 'erro', etapa: 'fim', erro: err.message, mensagem: err.message, terminadoEm: new Date().toISOString() });
    });
  res.status(202).json({ tarefa, jaEmAndamento: false });
});

// GET /api/integracao/planilha/status -- a tarefa atual (ou a última).
router.get('/status', (req, res) => {
  res.json({ tarefa: tarefaAtual });
});

export default router;
