import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { escaparFiltroPostgrest } from '../lib/filtros.js';
import { cancelarItensPendentesDosClientes } from '../lib/tagsEfeito.js';
import { propagarDadosFatura } from '../lib/faturaPropagacao.js';
import { achatarTags } from '../lib/achatarTags.js';
import {
  STATUS_OPERADOR,
  STATUS_BLOQUEIA_DISPARO,
  STATUS_RESOLVIDO,
  statusOperadorValido,
} from '../lib/statusOperador.js';

const router = Router();

// [2026-08] QUALIDADE: fila de trabalho + registro de tratativa por cliente
// (ver migration-20-qualidade-tratativas.sql). Mesma IDEIA LÓGICA do CRM da
// empresa (status de cobrança tira automaticamente da fila/disparo, igual
// hoje já acontece com tag `permite_disparo:false` -- migration-14), sem
// copiar a estrutura de lá (aqui continua 1 fatura ativa por cliente, sem
// multi-operadora/multi-fatura).

// Ids de clientes do usuário com alguma tag `permite_disparo:false` -- mesmo
// bloqueio que já vale pro disparo (ver envios.routes.js, resolverClienteIds),
// reaproveitado aqui pra tirar esses clientes da fila/resumo de qualidade
// também (não faz sentido "tratar" quem já saiu por tag manual).
async function idsBloqueadosPorTag(usuarioId) {
  const { data, error } = await supabase
    .from('cliente_tags')
    .select('cliente_id, clientes!inner(usuario_id), tags!inner(permite_disparo)')
    .eq('clientes.usuario_id', usuarioId)
    .eq('tags.permite_disparo', false);
  if (error) throw error;
  return [...new Set((data || []).map((r) => r.cliente_id))];
}

// GET /status -- lista fixa de status de tratativa (dropdown do front).
router.get('/status', (req, res) => {
  res.json(STATUS_OPERADOR);
});

// GET /fila -- clientes do operador ainda elegíveis (sem tag/status que
// bloqueia disparo). Sem filtro de status explícito, é a fila de trabalho de
// verdade (quem ainda não teve um desfecho bloqueante registrado). Uma linha
// por cliente (ignora números vinculados extras -- ver migration-15), mesmo
// agrupamento que a tela de Clientes já faz.
router.get('/fila', async (req, res) => {
  const usuarioId = req.user.id;
  const { busca, status } = req.query;
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 50, perPageMax: 200 });

  let query = supabase
    .from('clientes')
    .select('*, cliente_tags(tags(id, nome, cor))', { count: 'exact' })
    .eq('usuario_id', usuarioId)
    .is('cliente_principal_id', null)
    .order('data_prazo', { ascending: true, nullsFirst: false });

  if (busca) {
    const buscaEscapada = escaparFiltroPostgrest(busca);
    query = query.or(`nome.ilike.%${buscaEscapada}%,telefone.ilike.%${buscaEscapada}%`);
  }

  if (status) {
    if (!statusOperadorValido(status)) return res.status(400).json({ error: 'status inválido' });
    query = query.eq('status_operador', status);
  } else {
    // Precisa do "is.null" explícito no OR -- em SQL, `coluna NOT IN (...)`
    // avalia pra NULL (não TRUE) quando a coluna é NULL, então um
    // `.not('status_operador','in',...)` sozinho excluiria justamente quem
    // ainda não tem status nenhum, que é quem MAIS precisa estar na fila.
    const bloqueantes = [...STATUS_BLOQUEIA_DISPARO];
    query = query.or(`status_operador.is.null,status_operador.not.in.(${bloqueantes.join(',')})`);
  }

  let bloqueadosPorTag;
  try {
    bloqueadosPorTag = await idsBloqueadosPorTag(usuarioId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (bloqueadosPorTag.length) query = query.not('id', 'in', `(${bloqueadosPorTag.join(',')})`);

  const { data, error, count } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ itens: (data || []).map(achatarTags), total: count ?? 0 });
});

// GET /resumo -- KPI simples da carteira do operador: quantos já foram
// tocados (têm alguma tratativa registrada) e quantos disso foram resolvidos
// (status num desfecho final -- ver STATUS_RESOLVIDO).
router.get('/resumo', async (req, res) => {
  const usuarioId = req.user.id;

  const { data: clientes, error } = await supabase
    .from('clientes')
    .select('id, status_operador')
    .eq('usuario_id', usuarioId)
    .is('cliente_principal_id', null);
  if (error) return res.status(500).json({ error: error.message });

  let bloqueadosPorTag;
  try {
    bloqueadosPorTag = new Set(await idsBloqueadosPorTag(usuarioId));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const carteira = (clientes || []).filter((c) => !bloqueadosPorTag.has(c.id));
  const tocados = carteira.filter((c) => c.status_operador).length;
  const resolvidos = carteira.filter((c) => c.status_operador && STATUS_RESOLVIDO.has(c.status_operador)).length;
  const emFila = carteira.filter((c) => !c.status_operador || !STATUS_BLOQUEIA_DISPARO.has(c.status_operador)).length;

  res.json({
    total_carteira: carteira.length,
    em_fila: emFila,
    tocados,
    resolvidos,
    taxa_resolucao: tocados ? Math.round((resolvidos / tocados) * 100) : 0,
  });
});

// POST /:clienteId/tratativa -- registra o desfecho de uma tratativa
// (status + observação opcional). Grava a linha de auditoria em `tratativas`
// E atualiza `clientes.status_operador` (propagado pro grupo de números
// vinculados, ver lib/faturaPropagacao.js). Se o status cair num valor que
// bloqueia disparo (ex.: pagamento_confirmado), aplica o MESMO efeito que uma
// tag `permite_disparo:false` já teria: cancela os itens pendentes dele em
// qualquer lote em andamento.
router.post('/:clienteId/tratativa', async (req, res) => {
  const { clienteId } = req.params;
  const { status, observacao } = req.body || {};
  const usuarioId = req.user.id;

  if (!statusOperadorValido(status)) {
    return res.status(400).json({ error: `status inválido. Use um de: ${STATUS_OPERADOR.map((s) => s.valor).join(', ')}` });
  }

  const { data: cliente } = await supabase.from('clientes').select('id').eq('id', clienteId).eq('usuario_id', usuarioId).maybeSingle();
  if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

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

  const { error: propagacaoError } = await propagarDadosFatura(clienteId, usuarioId, {
    status_operador: status,
    status_operador_atualizado_em: new Date().toISOString(),
  });
  if (propagacaoError) return res.status(500).json({ error: propagacaoError.message });

  if (STATUS_BLOQUEIA_DISPARO.has(status)) {
    await cancelarItensPendentesDosClientes([clienteId], usuarioId);
  }

  res.status(201).json(tratativa);
});

// GET /:clienteId/historico -- linha do tempo de tratativas de um cliente
// (mais recente primeiro), pra exibir na ficha do cliente.
router.get('/:clienteId/historico', async (req, res) => {
  const { clienteId } = req.params;
  const usuarioId = req.user.id;

  const { data: cliente } = await supabase.from('clientes').select('id').eq('id', clienteId).eq('usuario_id', usuarioId).maybeSingle();
  if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

  const { data, error } = await supabase
    .from('tratativas')
    .select('*')
    .eq('cliente_id', clienteId)
    .order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  res.json(data || []);
});

export default router;
