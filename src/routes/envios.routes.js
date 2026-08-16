import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { responderExportacao } from '../lib/exportar.js';
import {
  processarDisparo,
  reenviarErros,
  disparoEmAndamento,
  montarMensagem,
} from '../services/dispatchQueue.js';
import {
  enviarMensagemComPdf,
  enviarMensagemTexto,
  validarNumero,
  isConnected,
} from '../services/whatsapp.js';
import { normalizarTelefone } from '../lib/telefone.js';
import { escaparFiltroPostgrest } from '../lib/filtros.js';

const router = Router();

// Agrega os contadores (enviados/entregues/lidos/falhas/numeros_invalidos/pendentes)
// a partir das linhas de envio_itens -- usado tanto no resumo de um envio quanto
// na listagem (montado em lote pra não fazer N+1 query).
function agregarContadores(itens) {
  const c = { total: 0, enviados: 0, entregues: 0, lidos: 0, falhas: 0, numeros_invalidos: 0, pendentes: 0 };
  for (const item of itens) {
    c.total++;
    if (item.status === 'pendente') c.pendentes++;
    if (item.status === 'erro') c.falhas++;
    if (item.status === 'numero_invalido') c.numeros_invalidos++;
    if (item.status === 'enviado') c.enviados++;
    if (item.status_entrega === 'entregue' || item.status_entrega === 'lido') c.entregues++;
    if (item.status_entrega === 'lido') c.lidos++;
  }
  return c;
}

function montarEnvioResumo(envio, contadores) {
  return {
    id: envio.id,
    criado_em: envio.created_at,
    lote: envio.lote || null,
    status: envio.status,
    slot: envio.slot ?? null,
    janela_ms: envio.janela_ms ?? null,
    ...contadores,
  };
}

// Resolve a lista final (deduplicada) de cliente_ids a partir de cliente_ids
// soltos + tag_ids (todo cliente que tenha qualquer uma das tags entra também).
async function resolverClienteIds(clienteIds = [], tagIds = []) {
  const conjunto = new Set(clienteIds);

  if (Array.isArray(tagIds) && tagIds.length) {
    const { data, error } = await supabase
      .from('cliente_tags')
      .select('cliente_id')
      .in('tag_id', tagIds);
    if (error) throw error;
    for (const row of data || []) conjunto.add(row.cliente_id);
  }

  return [...conjunto];
}

// ---------------------------------------------------------------------------
// DISPARO DE TESTE -- manda UMA mensagem real, isolado do fluxo de lote.
// body: { telefone, mensagem }
// ---------------------------------------------------------------------------
router.post('/teste', async (req, res) => {
  const { telefone, mensagem, cliente_id, slot } = req.body || {};

  if (!isConnected(slot)) {
    return res.status(409).json({ error: 'WhatsApp não está conectado. Faça a leitura do QR Code na aba Conexão.' });
  }

  let cliente = null;
  if (cliente_id) {
    const { data, error } = await supabase.from('clientes').select('*').eq('id', cliente_id).single();
    if (error) return res.status(404).json({ error: 'Cliente não encontrado' });
    cliente = data;
  }

  const destino = telefone || cliente?.telefone;
  if (!destino) {
    return res.status(400).json({ error: 'Informe um telefone ou selecione um cliente para o teste' });
  }

  const template = mensagem || '🔔 Teste de disparo do sistema. Se você recebeu esta mensagem, está tudo funcionando.';
  const mensagemFinal = montarMensagem(template, cliente || { nome: 'Teste', valor: null, vencimento: null });
  const numeroNormalizado = normalizarTelefone(destino);

  try {
    const { existe } = await validarNumero(destino, slot);
    if (!existe) {
      return res.status(422).json({ error: 'Este número não existe no WhatsApp' });
    }

    const usarPdf = Boolean(cliente?.pdf_url);
    const resultado = usarPdf
      ? await enviarMensagemComPdf({ numero: destino, mensagem: mensagemFinal, pdfUrl: cliente.pdf_url, pdfNome: `${cliente.nome || 'fatura'}.pdf`, slot })
      : await enviarMensagemTexto({ numero: destino, mensagem: mensagemFinal, slot });

    return res.json({ ok: true, telefone: numeroNormalizado, mensagem: mensagemFinal, messageId: resultado.messageId, slot: resultado.slot });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Falha ao enviar mensagem de teste' });
  }
});

// ---------------------------------------------------------------------------
// Cria um novo envio (lote de disparo)
// body: { mensagem, cliente_ids[], tag_ids[], intervalo_ms, janela_ms, agendado_para?, slot? }
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { mensagem, cliente_ids = [], tag_ids = [], intervalo_ms, janela_ms, agendado_para, slot } = req.body || {};

  if (!mensagem) {
    return res.status(400).json({ error: 'mensagem é obrigatória' });
  }

  let clienteIdsFinal;
  try {
    clienteIdsFinal = await resolverClienteIds(cliente_ids, tag_ids);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!clienteIdsFinal.length) {
    return res.status(400).json({ error: 'nenhum cliente selecionado (cliente_ids/tag_ids vazios)' });
  }

  const { data: envio, error: envioError } = await supabase
    .from('envios')
    .insert({
      template_mensagem: mensagem,
      status: agendado_para ? 'agendado' : 'pendente',
      agendado_para: agendado_para || null,
      slot: slot || null,
      intervalo_ms: intervalo_ms || null,
      janela_ms: janela_ms || null,
    })
    .select()
    .single();

  if (envioError) return res.status(500).json({ error: envioError.message });

  const itens = clienteIdsFinal.map((cliente_id) => ({
    envio_id: envio.id,
    cliente_id,
    status: 'pendente',
  }));

  const { error: itensError } = await supabase.from('envio_itens').insert(itens);
  if (itensError) return res.status(500).json({ error: itensError.message });

  res.status(201).json(montarEnvioResumo(envio, { total: itens.length, enviados: 0, entregues: 0, lidos: 0, falhas: 0, numeros_invalidos: 0, pendentes: itens.length }));
});

// Dispara o envio imediatamente (assíncrono, roda em background)
router.post('/:id/disparar', async (req, res) => {
  if (disparoEmAndamento()) {
    return res.status(409).json({ error: 'já existe um disparo em andamento' });
  }

  const { id } = req.params;
  processarDisparo(id).catch((err) => console.error('[envios] erro no disparo:', err));
  res.json({ ok: true, mensagem: 'Disparo iniciado em background' });
});

// Reenvia apenas os itens que falharam (status 'erro') nesse envio
router.post('/:id/reenviar-erros', async (req, res) => {
  if (disparoEmAndamento()) {
    return res.status(409).json({ error: 'já existe um disparo em andamento' });
  }

  const { id } = req.params;
  reenviarErros(id).catch((err) => console.error('[envios] erro ao reenviar:', err));
  res.json({ ok: true, mensagem: 'Reenvio dos itens com erro iniciado em background' });
});

// Agenda (ou reagenda) o horário de início de um envio ainda não iniciado
router.patch('/:id/agendar', async (req, res) => {
  const { id } = req.params;
  const { agendado_para } = req.body;

  if (!agendado_para) {
    return res.status(400).json({ error: 'agendado_para é obrigatório (ISO datetime)' });
  }

  const { data, error } = await supabase
    .from('envios')
    .update({ status: 'agendado', agendado_para })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const { data: itens, error: itensError } = await supabase
    .from('envio_itens')
    .select('status, status_entrega')
    .eq('envio_id', id);
  if (itensError) return res.status(500).json({ error: itensError.message });

  res.json(montarEnvioResumo(data, agregarContadores(itens || [])));
});

// Exportação (precisa vir ANTES de /:id pra não ser capturada como um id)
router.get('/exportar', async (req, res) => {
  const { formato = 'csv' } = req.query;
  const { data: envios, error } = await supabase.from('envios').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const { data: itens, error: itensError } = await supabase.from('envio_itens').select('envio_id, status, status_entrega');
  if (itensError) return res.status(500).json({ error: itensError.message });

  const porEnvio = new Map();
  for (const item of itens || []) {
    if (!porEnvio.has(item.envio_id)) porEnvio.set(item.envio_id, []);
    porEnvio.get(item.envio_id).push(item);
  }

  const linhas = (envios || []).map((envio) => {
    const c = agregarContadores(porEnvio.get(envio.id) || []);
    return {
      id: envio.id,
      criado_em: envio.created_at,
      lote: envio.lote || '',
      status: envio.status,
      slot: envio.slot ?? '',
      ...c,
    };
  });

  responderExportacao(res, formato, 'historico', linhas);
});

// Consulta um envio específico (resumo, sem os itens -- ver GET /:id/itens)
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  const { data: envio, error: envioError } = await supabase.from('envios').select('*').eq('id', id).single();
  if (envioError) return res.status(500).json({ error: envioError.message });

  const { data: itens, error: itensError } = await supabase
    .from('envio_itens')
    .select('status, status_entrega')
    .eq('envio_id', id);
  if (itensError) return res.status(500).json({ error: itensError.message });

  res.json(montarEnvioResumo(envio, agregarContadores(itens || [])));
});

// Itens de um envio (paginado, com filtro por status/busca no nome/telefone do cliente)
router.get('/:id/itens', async (req, res) => {
  const { id } = req.params;
  const { filtro, busca } = req.query;
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });

  let clienteIdsFiltrados = null;
  if (busca) {
    const buscaEscapada = escaparFiltroPostgrest(busca);
    const { data: clientesEncontrados, error: buscaError } = await supabase
      .from('clientes')
      .select('id')
      .or(`nome.ilike.%${buscaEscapada}%,telefone.ilike.%${buscaEscapada}%`);
    if (buscaError) return res.status(500).json({ error: buscaError.message });
    clienteIdsFiltrados = (clientesEncontrados || []).map((c) => c.id);
    if (!clienteIdsFiltrados.length) return res.json([]);
  }

  let query = supabase
    .from('envio_itens')
    .select('*, clientes(nome, telefone, valor, vencimento)')
    .eq('envio_id', id)
    .order('created_at', { ascending: true });

  if (filtro && filtro !== 'todos') query = query.eq('status', filtro);
  if (clienteIdsFiltrados) query = query.in('cliente_id', clienteIdsFiltrados);

  const { data, error } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  res.json(data || []);
});

// Contadores leves pra polling durante o disparo (mesmo shape do resumo, sem overhead)
router.get('/:id/progresso', async (req, res) => {
  const { id } = req.params;

  const { data: envio, error: envioError } = await supabase.from('envios').select('id, status').eq('id', id).single();
  if (envioError) return res.status(500).json({ error: envioError.message });

  const { data: itens, error: itensError } = await supabase
    .from('envio_itens')
    .select('status, status_entrega, slot, enviado_em')
    .eq('envio_id', id);
  if (itensError) return res.status(500).json({ error: itensError.message });

  const enviados = (itens || [])
    .filter((i) => i.enviado_em)
    .sort((a, b) => (b.enviado_em || '').localeCompare(a.enviado_em || ''));
  const ultimo = enviados[0] || null;

  const { data: config } = await supabase.from('estrategia_config').select('next_slot').eq('id', true).maybeSingle();

  res.json({
    id: envio.id,
    status: envio.status,
    ...agregarContadores(itens || []),
    ultimo_envio_em: ultimo?.enviado_em ?? null,
    slot_atual: ultimo?.slot ?? null,
    proximo_slot: config?.next_slot ?? null,
  });
});

// Lista envios (paginado, com filtros)
router.get('/', async (req, res) => {
  const { busca, status, de, ate, slot } = req.query;
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 500, perPageMax: 5000 });

  let query = supabase.from('envios').select('*', { count: 'exact' }).order('created_at', { ascending: false });

  if (busca) query = query.or(`lote.ilike.%${escaparFiltroPostgrest(busca)}%,template_mensagem.ilike.%${escaparFiltroPostgrest(busca)}%`);
  if (status && status !== 'todos') query = query.eq('status', status);
  if (slot && slot !== 'todos') {
    const slotNum = Number(slot);
    if (Number.isInteger(slotNum)) query = query.eq('slot', slotNum);
  }
  if (de) query = query.gte('created_at', de);
  if (ate) query = query.lte('created_at', ate);

  const { data: envios, error } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  const ids = (envios || []).map((e) => e.id);
  let itensPorEnvio = new Map();
  if (ids.length) {
    const { data: itens, error: itensError } = await supabase
      .from('envio_itens')
      .select('envio_id, status, status_entrega')
      .in('envio_id', ids);
    if (itensError) return res.status(500).json({ error: itensError.message });
    for (const item of itens || []) {
      if (!itensPorEnvio.has(item.envio_id)) itensPorEnvio.set(item.envio_id, []);
      itensPorEnvio.get(item.envio_id).push(item);
    }
  }

  const items = (envios || []).map((envio) => montarEnvioResumo(envio, agregarContadores(itensPorEnvio.get(envio.id) || [])));

  res.json(items);
});

export default router;
