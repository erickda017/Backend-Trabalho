import { Router } from 'express';
import { CRITERIOS, montarResumoExclusao } from '../lib/exclusaoCriterios.js';
import { registrarAuditoriaExclusao } from '../lib/auditoria.js';
import { limiteSensivel } from '../lib/rateLimit.js';
import { supabase, BUCKET } from '../lib/supabase.js';

const router = Router();

// [2026-09] PAINEL DE EXCLUSÃO -- ver
// docs/superpowers/specs/2026-09-10-painel-exclusao-design.md. Montada em
// server.js com requireAuth + requireSupervisor (mesmo padrão de
// /api/supervisor/*) -- exclusão em massa, supervisor-wide (não filtra por
// usuario_id), só pra quem tem esse papel. NUNCA reaproveitar
// lib/exclusaoCriterios.js fora desse contexto.

// "O que mais está ocupando espaço" -- lista por contagem (não bytes reais,
// ver spec), ordenada do maior pro menor.
router.get('/resumo', async (req, res) => {
  try {
    const itens = await montarResumoExclusao();
    res.json({ itens });
  } catch (err) {
    console.error('[exclusao] erro ao montar resumo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Preview: conta quanto seria apagado + uma amostra. NUNCA apaga nada.
router.post('/:criterio/preview', limiteSensivel, async (req, res) => {
  const criterio = CRITERIOS[req.params.criterio];
  if (!criterio) return res.status(404).json({ error: 'critério de exclusão desconhecido' });

  try {
    const resultado = await criterio.contar(req.body?.filtro || {});
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Executa a exclusão de verdade. Exige `confirmacao: "APAGAR"` no corpo --
// [SEGURANÇA] validado aqui no servidor também, nunca confia só no frontend
// desabilitar o botão (o mesmo texto "APAGAR" que a tela exige digitar).
router.post('/:criterio/executar', limiteSensivel, async (req, res) => {
  const criterioId = req.params.criterio;
  const criterio = CRITERIOS[criterioId];
  if (!criterio) return res.status(404).json({ error: 'critério de exclusão desconhecido' });

  const { filtro, confirmacao } = req.body || {};
  if (confirmacao !== 'APAGAR') {
    return res.status(400).json({ error: 'Digite "APAGAR" no campo de confirmação pra prosseguir.' });
  }

  try {
    const apagados = await criterio.executar(filtro || {});

    // [2026-09] Auditoria: UMA linha resumo por operação em lote (não uma
    // por item apagado -- evitaria inundar auditoria_exclusoes numa
    // exclusão de milhares de linhas). Nunca lança (ver auditoria.js) --
    // uma falha aqui não desfaz a exclusão que já aconteceu.
    await registrarAuditoriaExclusao({
      entidade: 'exclusao_em_lote',
      entidadeId: criterioId,
      usuario: req.user,
      detalhes: { criterio: criterioId, filtro: filtro || {}, total_apagado: apagados },
    });

    res.json({ apagados });
  } catch (err) {
    console.error(`[exclusao] erro ao executar critério ${criterioId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// [2026-09] DIAGNÓSTICO -- relatado: painel dizia "apagado" mas os arquivos
// continuavam no bucket. Sobe um arquivo de teste descartável, tenta apagar
// na hora e devolve o resultado CRU de cada etapa (sem esconder nada atrás
// de "best-effort") -- isola se o problema é permissão de escrita, de
// remoção, ou nome de bucket errado, sem mexer em nenhum dado real.
router.get('/diagnostico-storage', async (req, res) => {
  const caminho = `_diagnostico/teste-${Date.now()}.txt`;
  const resultado = { bucket: BUCKET, caminho };

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(caminho, Buffer.from('arquivo de teste do diagnóstico do painel de exclusão'), {
      contentType: 'text/plain',
    });
  resultado.upload = uploadError ? { ok: false, erro: uploadError.message } : { ok: true };

  if (uploadError) {
    return res.json(resultado); // sem upload bem-sucedido, não faz sentido tentar remover
  }

  const { data: removeData, error: removeError } = await supabase.storage.from(BUCKET).remove([caminho]);
  resultado.remocao = removeError
    ? { ok: false, erro: removeError.message }
    : { ok: (removeData || []).length === 1, confirmados: (removeData || []).map((d) => d.name) };

  // Confere de verdade se o arquivo ainda existe (list() na pasta) --
  // independe do que a chamada de remove() alegou, é a fonte da verdade.
  const { data: listagem, error: listError } = await supabase.storage.from(BUCKET).list('_diagnostico');
  resultado.confirmacao_via_list = listError
    ? { erro: listError.message }
    : { ainda_existe: (listagem || []).some((f) => `_diagnostico/${f.name}` === caminho) };

  res.json(resultado);
});

export default router;
