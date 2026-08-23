import { Router } from 'express';
import { supabase, BUCKET, gerarSignedUrl } from '../lib/supabase.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { responderExportacao } from '../lib/exportar.js';
import {
  processarDisparo,
  reenviarErros,
  disparoEmAndamento,
  montarMensagem,
  solicitarPausa,
  solicitarCancelamento,
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

// [2026-08] MULTI-TENANT: toda rota abaixo é escopada por req.user.id (o
// operador autenticado, preenchido pelo requireAuth em server.js). Não existe
// mais parâmetro "slot" em lugar nenhum -- cada usuário tem 1 WhatsApp só, e
// as funções de whatsapp.js/dispatchQueue.js já usam usuarioId como chave.

// Agrega os contadores (enviados/entregues/lidos/falhas/numeros_invalidos/pendentes)
// a partir das linhas de envio_itens -- usado tanto no resumo de um envio quanto
// na listagem (montado em lote pra não fazer N+1 query).
function agregarContadores(itens) {
  const c = { total: 0, enviados: 0, entregues: 0, lidos: 0, falhas: 0, numeros_invalidos: 0, pendentes: 0, cancelados: 0 };
  for (const item of itens) {
    c.total++;
    if (item.status === 'pendente') c.pendentes++;
    if (item.status === 'erro') c.falhas++;
    if (item.status === 'numero_invalido') c.numeros_invalidos++;
    if (item.status === 'enviado') c.enviados++;
    if (item.status === 'cancelado') c.cancelados++;
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
    janela_ms: envio.janela_ms ?? null,
    enviar_pix: envio.enviar_pix ?? false,
    ...contadores,
  };
}

// Resolve a lista final (deduplicada) de cliente_ids a partir de cliente_ids
// soltos + tag_ids (todo cliente que tenha qualquer uma das tags entra também).
// Escopado por usuarioId: nunca deixa um cliente_id de outro usuário entrar
// no lote, mesmo que ele venha (por engano ou má-fé) no corpo da requisição.
//
// Dois filtros de elegibilidade, aplicados sempre (independente de ter vindo
// por cliente_ids solto ou por tag_ids):
//   1) precisa ter PDF vinculado (`pdf_path`) -- cliente novo sem fatura
//      ainda não entra; assim que o PDF é linkado (manual, extrator de Pix
//      ou importação -- os três caminhos gravam pdf_path), ele passa a
//      entrar automaticamente no PRÓXIMO lote montado, sem nenhum passo manual.
//   2) não pode ter nenhuma tag com `permite_disparo = false` (ex.: Pago,
//      Cancelado) -- ver migration-14-tags-controlam-disparo.sql.
// Retorna também quantos ficaram de fora por cada motivo, pra UI poder
// avisar em vez de só devolver uma lista menor sem explicação.
// `exigirPix`: quando true (lote `enviar_pix`), a elegibilidade passa a
// exigir `pix_code` em vez de `pdf_path` -- faz sentido pro lote inteiro
// mandar só o código Pix mesmo pra cliente que não tem PDF nenhum cadastrado,
// desde que tenha Pix.
async function resolverClienteIds(clienteIds = [], tagIds = [], usuarioId, exigirPix = false) {
  const conjunto = new Set(clienteIds);

  if (Array.isArray(tagIds) && tagIds.length) {
    const { data, error } = await supabase
      .from('cliente_tags')
      .select('cliente_id')
      .in('tag_id', tagIds);
    if (error) throw error;
    for (const row of data || []) conjunto.add(row.cliente_id);
  }

  if (!conjunto.size) return { clienteIds: [], semPdf: 0, bloqueadosPorTag: 0 };

  // Dono real -- fecha a brecha de um cliente_id "emprestado" de outro
  // usuário ter sido colado no body da requisição.
  const { data: donos, error: donosError } = await supabase
    .from('clientes')
    .select('id, pdf_path, pix_code')
    .in('id', [...conjunto])
    .eq('usuario_id', usuarioId);
  if (donosError) throw donosError;

  const candidatos = donos || [];
  const elegivel = (c) => (exigirPix ? Boolean(c.pix_code) : Boolean(c.pdf_path));
  const semPdf = candidatos.filter((c) => !elegivel(c)).length;
  const comPdf = candidatos.filter(elegivel);
  if (!comPdf.length) return { clienteIds: [], semPdf, bloqueadosPorTag: 0 };

  // Tags `permite_disparo: false` que qualquer um desses clientes tenha.
  const { data: tagsBloqueando, error: tagsError } = await supabase
    .from('cliente_tags')
    .select('cliente_id, tags!inner(permite_disparo)')
    .in('cliente_id', comPdf.map((c) => c.id))
    .eq('tags.permite_disparo', false);
  if (tagsError) throw tagsError;

  const bloqueados = new Set((tagsBloqueando || []).map((r) => r.cliente_id));
  const liberados = comPdf.filter((c) => !bloqueados.has(c.id));

  return { clienteIds: liberados.map((c) => c.id), semPdf, bloqueadosPorTag: bloqueados.size };
}

// ---------------------------------------------------------------------------
// DISPARO DE TESTE -- manda UMA mensagem real, isolado do fluxo de lote.
// body: { telefone, mensagem, cliente_id }
// ---------------------------------------------------------------------------
router.post('/teste', async (req, res) => {
  const { telefone, mensagem, cliente_id, com_pdf } = req.body || {};
  const usuarioId = req.user.id;
  // Compat: front manda `com_pdf` (checkbox "Enviar PDF da fatura"). Ausente
  // = true (comportamento de sempre, anexa se o cliente tiver PDF).
  const comPdf = com_pdf !== false;

  if (!isConnected(usuarioId)) {
    return res.status(409).json({ error: 'WhatsApp não está conectado. Faça a leitura do QR Code na aba Conexão.' });
  }

  let cliente = null;
  if (cliente_id) {
    const { data, error } = await supabase.from('clientes').select('*').eq('id', cliente_id).eq('usuario_id', usuarioId).maybeSingle();
    if (error || !data) return res.status(404).json({ error: 'Cliente não encontrado' });
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
    const { existe } = await validarNumero(destino, usuarioId);
    if (!existe) {
      return res.status(422).json({ error: 'Este número não existe no WhatsApp' });
    }

    // [correção] o front já mandava `com_pdf` nesse endpoint desde antes,
    // mas a rota nunca lia -- o checkbox "Enviar PDF da fatura" no teste
    // não tinha efeito nenhum, sempre anexava se o cliente tivesse PDF.
    // Bucket privado: assina uma URL só pra este envio de teste (curta
    // duração) -- nunca reaproveita/persiste uma URL pública fixa.
    const pdfUrlAssinada = comPdf && cliente?.pdf_path ? await gerarSignedUrl(BUCKET, cliente.pdf_path) : null;
    const resultado = pdfUrlAssinada
      ? await enviarMensagemComPdf({ numero: destino, mensagem: mensagemFinal, pdfUrl: pdfUrlAssinada, pdfNome: `${cliente.nome || 'fatura'}.pdf`, usuarioId })
      : await enviarMensagemTexto({ numero: destino, mensagem: mensagemFinal, usuarioId });

    // [correção] resposta não devolvia `com_pdf` -- o front lia
    // `r.com_pdf` pra montar o texto de confirmação e sempre dava
    // undefined/falsy, então o toast dizia "sem PDF" mesmo quando o PDF
    // tinha sido anexado de verdade.
    return res.json({ ok: true, telefone: numeroNormalizado, mensagem: mensagemFinal, messageId: resultado.messageId, com_pdf: Boolean(pdfUrlAssinada) });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Falha ao enviar mensagem de teste' });
  }
});

// ---------------------------------------------------------------------------
// Cria um novo envio (lote de disparo)
// body: { mensagem, mensagens, cliente_ids[], tag_ids[], intervalo_ms, janela_ms, agendado_para? }
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const usuarioId = req.user.id;
  const { mensagem, mensagens, cliente_ids = [], tag_ids = [], intervalo_ms, janela_ms, agendado_para, enviar_pix } = req.body || {};
  const enviarPix = enviar_pix === true;

  // `mensagens`: array com até 5 variações do texto (ver migration-9). O
  // front manda sempre esse array quando o usuário preenche mais de uma
  // variação; `mensagem` continua existindo por compatibilidade (1ª
  // variação, usada como "o" template do lote em telas/exportações antigas).
  const variacoes = Array.isArray(mensagens)
    ? mensagens.map((m) => (typeof m === 'string' ? m.trim() : '')).filter(Boolean).slice(0, 5)
    : [];

  const mensagemPrincipal = mensagem || variacoes[0];

  if (!mensagemPrincipal) {
    return res.status(400).json({ error: 'mensagem é obrigatória' });
  }

  let resolucao;
  try {
    resolucao = await resolverClienteIds(cliente_ids, tag_ids, usuarioId, enviarPix);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const { clienteIds: clienteIdsFinal, semPdf, bloqueadosPorTag } = resolucao;

  if (!clienteIdsFinal.length) {
    const motivos = [];
    if (semPdf) motivos.push(enviarPix ? `${semPdf} sem PIX cadastrado` : `${semPdf} sem PDF vinculado`);
    if (bloqueadosPorTag) motivos.push(`${bloqueadosPorTag} com tag que bloqueia disparo (ex.: Pago/Cancelado)`);
    const detalhe = motivos.length ? ` (${motivos.join(', ')})` : '';
    return res.status(400).json({ error: `nenhum cliente elegível pra disparo${detalhe}` });
  }

  const { data: envio, error: envioError } = await supabase
    .from('envios')
    .insert({
      usuario_id: usuarioId,
      template_mensagem: mensagemPrincipal,
      variacoes_mensagem: variacoes.length ? variacoes : [mensagemPrincipal],
      status: agendado_para ? 'agendado' : 'pendente',
      agendado_para: agendado_para || null,
      intervalo_ms: intervalo_ms || null,
      janela_ms: janela_ms || null,
      enviar_pix: enviarPix,
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

  res.status(201).json({
    ...montarEnvioResumo(envio, { total: itens.length, enviados: 0, entregues: 0, lidos: 0, falhas: 0, numeros_invalidos: 0, pendentes: itens.length, cancelados: 0 }),
    // Info só pra UI avisar "N clientes ficaram de fora" -- não afeta o lote em si.
    ignorados_sem_pdf: semPdf,
    ignorados_por_tag: bloqueadosPorTag,
  });
});

// Dispara o envio imediatamente (assíncrono, roda em background)
router.post('/:id/disparar', async (req, res) => {
  const usuarioId = req.user.id;
  if (disparoEmAndamento(usuarioId)) {
    return res.status(409).json({ error: 'já existe um disparo seu em andamento' });
  }

  const { id } = req.params;
  // Confirma dono antes de disparar em background (processarDisparo também
  // confirma internamente, mas falhar cedo aqui dá um 404 melhor que um erro
  // genérico via log assíncrono).
  const { data: dono } = await supabase.from('envios').select('id').eq('id', id).eq('usuario_id', usuarioId).maybeSingle();
  if (!dono) return res.status(404).json({ error: 'Envio não encontrado' });

  processarDisparo(id, usuarioId).catch((err) => console.error('[envios] erro no disparo:', err));
  res.json({ ok: true, mensagem: 'Disparo iniciado em background' });
});

// Reenvia apenas os itens que falharam (status 'erro') nesse envio
router.post('/:id/reenviar-erros', async (req, res) => {
  const usuarioId = req.user.id;
  if (disparoEmAndamento(usuarioId)) {
    return res.status(409).json({ error: 'já existe um disparo seu em andamento' });
  }

  const { id } = req.params;
  const { data: dono } = await supabase.from('envios').select('id').eq('id', id).eq('usuario_id', usuarioId).maybeSingle();
  if (!dono) return res.status(404).json({ error: 'Envio não encontrado' });

  reenviarErros(id, usuarioId).catch((err) => console.error('[envios] erro ao reenviar:', err));
  res.json({ ok: true, mensagem: 'Reenvio dos itens com erro iniciado em background' });
});

// Pausa um envio em andamento (retomada só manual, pelo botão "Continuar
// disparo" -- não é o scheduler que retoma sozinho, diferente da pausa por
// limite diário/queda de conexão).
router.post('/:id/pausar', async (req, res) => {
  try {
    const resultado = await solicitarPausa(req.params.id, req.user.id);
    res.json({ ok: true, ...resultado });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Cancela (interrompe de vez) um envio. Itens já enviados continuam
// enviados; os pendentes deixam de ser processados e não é retomável.
router.post('/:id/cancelar', async (req, res) => {
  try {
    const resultado = await solicitarCancelamento(req.params.id, req.user.id);
    res.json({ ok: true, ...resultado });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
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
    .eq('usuario_id', req.user.id)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Envio não encontrado' });

  const { data: itens, error: itensError } = await supabase
    .from('envio_itens')
    .select('status, status_entrega')
    .eq('envio_id', id);
  if (itensError) return res.status(500).json({ error: itensError.message });

  res.json(montarEnvioResumo(data, agregarContadores(itens || [])));
});

// Envio "ativo" no momento -- em_andamento (rodando de verdade) ou pausado
// (por limite diário, queda de conexão, ou manual). Existe pra aba Disparo
// conseguir mostrar um lote em andamento mesmo se o navegador/aba foi aberto
// de novo (sessionStorage perdido) ou se o servidor caiu e voltou -- a fonte
// de verdade é o banco, não o estado local do front.
// Precisa vir ANTES de /:id pra não ser capturada como um id.
router.get('/ativo', async (req, res) => {
  const { data, error } = await supabase
    .from('envios')
    .select('id, status')
    .eq('usuario_id', req.user.id)
    .in('status', ['em_andamento', 'pausado'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data?.id ?? null, status: data?.status ?? null });
});

// Exportação (precisa vir ANTES de /:id pra não ser capturada como um id)
router.get('/exportar', async (req, res) => {
  const { formato = 'csv' } = req.query;
  const { data: envios, error } = await supabase
    .from('envios')
    .select('*')
    .eq('usuario_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const ids = (envios || []).map((e) => e.id);
  let itens = [];
  if (ids.length) {
    const { data, error: itensError } = await supabase.from('envio_itens').select('envio_id, status, status_entrega').in('envio_id', ids);
    if (itensError) return res.status(500).json({ error: itensError.message });
    itens = data || [];
  }

  const porEnvio = new Map();
  for (const item of itens) {
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
      ...c,
    };
  });

  responderExportacao(res, formato, 'historico', linhas);
});

// Consulta um envio específico (resumo, sem os itens -- ver GET /:id/itens)
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  const { data: envio, error: envioError } = await supabase
    .from('envios')
    .select('*')
    .eq('id', id)
    .eq('usuario_id', req.user.id)
    .maybeSingle();
  if (envioError) return res.status(500).json({ error: envioError.message });
  if (!envio) return res.status(404).json({ error: 'Envio não encontrado' });

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
  const usuarioId = req.user.id;
  const { filtro, busca } = req.query;
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });

  const { data: donoEnvio } = await supabase.from('envios').select('id').eq('id', id).eq('usuario_id', usuarioId).maybeSingle();
  if (!donoEnvio) return res.status(404).json({ error: 'Envio não encontrado' });

  let clienteIdsFiltrados = null;
  if (busca) {
    const buscaEscapada = escaparFiltroPostgrest(busca);
    const { data: clientesEncontrados, error: buscaError } = await supabase
      .from('clientes')
      .select('id')
      .eq('usuario_id', usuarioId)
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

  // [2026-08] Bug corrigido: 'entregue'/'lido' são valores de status_entrega,
  // não de status -- filtrar por status='entregue' nunca batia com nada (a
  // coluna status só tem pendente/enviado/erro/numero_invalido/cancelado), os
  // filtros "Entregues"/"Lidos" da aba Histórico sempre devolviam lista vazia.
  if (filtro === 'entregue') query = query.in('status_entrega', ['entregue', 'lido']);
  else if (filtro === 'lido') query = query.eq('status_entrega', 'lido');
  else if (filtro && filtro !== 'todos') query = query.eq('status', filtro);
  if (clienteIdsFiltrados) query = query.in('cliente_id', clienteIdsFiltrados);

  const { data, error } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  res.json(data || []);
});

// Contadores leves pra polling durante o disparo (mesmo shape do resumo, sem overhead)
router.get('/:id/progresso', async (req, res) => {
  const { id } = req.params;

  const { data: envio, error: envioError } = await supabase
    .from('envios')
    .select('id, status')
    .eq('id', id)
    .eq('usuario_id', req.user.id)
    .maybeSingle();
  if (envioError) return res.status(500).json({ error: envioError.message });
  if (!envio) return res.status(404).json({ error: 'Envio não encontrado' });

  const { data: itens, error: itensError } = await supabase
    .from('envio_itens')
    .select('status, status_entrega, enviado_em')
    .eq('envio_id', id);
  if (itensError) return res.status(500).json({ error: itensError.message });

  const enviados = (itens || [])
    .filter((i) => i.enviado_em)
    .sort((a, b) => (b.enviado_em || '').localeCompare(a.enviado_em || ''));
  const ultimo = enviados[0] || null;

  res.json({
    id: envio.id,
    status: envio.status,
    ...agregarContadores(itens || []),
    ultimo_envio_em: ultimo?.enviado_em ?? null,
  });
});

// Lista envios (paginado, com filtros)
router.get('/', async (req, res) => {
  const { busca, status, de, ate } = req.query;
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 500, perPageMax: 5000 });

  let query = supabase.from('envios').select('*', { count: 'exact' }).eq('usuario_id', req.user.id).order('created_at', { ascending: false });

  if (busca) query = query.or(`lote.ilike.%${escaparFiltroPostgrest(busca)}%,template_mensagem.ilike.%${escaparFiltroPostgrest(busca)}%`);
  if (status && status !== 'todos') query = query.eq('status', status);
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
