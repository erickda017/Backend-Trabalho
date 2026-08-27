import { Router } from 'express';
import {
  calcularMetricasSafra,
  consolidarSafra,
  formatoSafraValido,
  listarHistoricoSafras,
  listarSafrasAtivas,
  rotuloSafra,
} from '../lib/safras.js';

const router = Router();

// "Safra" não tem tabela própria pra dado OPERACIONAL -- é uma visão sobre
// `clientes` agrupada pela coluna gerada `safra` (ver
// migration-19-safras-faturas.sql), no mesmo espírito de `faturas.routes.js`
// ("Fatura" também é uma visão sobre `clientes`). `safras_historico` só
// guarda o SNAPSHOT consolidado, pra sobreviver depois que os dados
// operacionais de uma safra específica pararem de existir.

// GET /safras -- lista todas as safras conhecidas do usuário: as que ainda
// têm clientes ativos (métricas ao vivo) + as que já foram consolidadas no
// histórico e não têm mais cliente ativo nenhum (métricas do snapshot).
// Uma safra que está nos dois (ainda ativa, mas já consolidada antes por
// algum motivo) aparece uma vez só, com o dado AO VIVO prevalecendo (mais
// atual que o snapshot).
router.get('/', async (req, res) => {
  try {
    const usuarioId = req.user.id;
    const [safrasAtivas, historico] = await Promise.all([
      listarSafrasAtivas(usuarioId),
      listarHistoricoSafras(usuarioId),
    ]);

    const metricasAtivas = await Promise.all(safrasAtivas.map((safra) => calcularMetricasSafra(usuarioId, safra)));

    const safrasAtivasSet = new Set(safrasAtivas);
    const historicoSemDadosAtivos = historico
      .filter((h) => !safrasAtivasSet.has(h.safra))
      .map((h) => ({
        safra: h.safra,
        rotulo: rotuloSafra(h.safra),
        total_clientes: h.total_clientes,
        total_fpd: h.total_fpd,
        total_spd: h.total_spd,
        sem_tipo_fatura: h.total_clientes - h.total_fpd - h.total_spd,
        pagos: h.pagos,
        nao_pagos: h.nao_pagos,
        receberam_disparo: h.receberam_disparo,
        nao_receberam_disparo: h.nao_receberam_disparo,
        valor_total: h.valor_total,
        valor_medio: h.valor_medio,
        duplicidades_detectadas: h.duplicidades_detectadas,
        consolidado_em: h.consolidado_em,
        arquivada: true, // sem dado operacional ativo -- só existe no histórico
      }));

    const consolidadoEmPorSafra = new Map(historico.map((h) => [h.safra, h.consolidado_em]));
    const ativasComFlag = metricasAtivas.map((m) => ({
      ...m,
      consolidado_em: consolidadoEmPorSafra.get(m.safra) || null,
      arquivada: false,
    }));

    const todas = [...ativasComFlag, ...historicoSemDadosAtivos].sort((a, b) => (a.safra < b.safra ? 1 : -1));
    res.json(todas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /safras/:safra -- detalhe de uma safra específica (ao vivo se ainda
// tiver cliente ativo; senão cai pro snapshot do histórico).
router.get('/:safra', async (req, res) => {
  const { safra } = req.params;
  if (!formatoSafraValido(safra)) {
    return res.status(400).json({ error: 'Formato de safra inválido (esperado YYYY-MM, ex: 2026-09)' });
  }
  try {
    const usuarioId = req.user.id;
    const metricas = await calcularMetricasSafra(usuarioId, safra);
    if (metricas.total_clientes > 0) {
      return res.json({ ...metricas, arquivada: false });
    }
    // Sem cliente ativo nessa safra -- procura no histórico consolidado.
    const historico = await listarHistoricoSafras(usuarioId);
    const registro = historico.find((h) => h.safra === safra);
    if (!registro) return res.status(404).json({ error: 'Safra não encontrada (sem dado ativo nem histórico consolidado)' });
    res.json({
      safra: registro.safra,
      rotulo: rotuloSafra(registro.safra),
      total_clientes: registro.total_clientes,
      total_fpd: registro.total_fpd,
      total_spd: registro.total_spd,
      sem_tipo_fatura: registro.total_clientes - registro.total_fpd - registro.total_spd,
      pagos: registro.pagos,
      nao_pagos: registro.nao_pagos,
      receberam_disparo: registro.receberam_disparo,
      nao_receberam_disparo: registro.nao_receberam_disparo,
      valor_total: registro.valor_total,
      valor_medio: registro.valor_medio,
      duplicidades_detectadas: registro.duplicidades_detectadas,
      consolidado_em: registro.consolidado_em,
      arquivada: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /safras/:safra/consolidar -- força a consolidação (upsert em
// safras_historico) na hora, sem esperar o job automático diário. Útil pra
// conferir o snapshot antes de uma limpeza manual, ou pra reprocessar depois
// de corrigir dados de uma safra já consolidada.
router.post('/:safra/consolidar', async (req, res) => {
  const { safra } = req.params;
  if (!formatoSafraValido(safra)) {
    return res.status(400).json({ error: 'Formato de safra inválido (esperado YYYY-MM, ex: 2026-09)' });
  }
  try {
    const registro = await consolidarSafra(req.user.id, safra);
    res.json(registro);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
