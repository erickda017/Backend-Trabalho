import { Router } from 'express';
import { buscarTodos } from '../lib/buscarTodos.js';
import { supabase } from '../lib/supabase.js';
import { descreverErro } from '../lib/redigir.js';
import { logLimitado } from '../lib/log.js';
import { limiteSensivel } from '../lib/rateLimit.js';
import { comTrava } from '../lib/email/trava.js';
import { casaBusca, ordenar, selecionar, calcularCota, LIMITE_POR_LOTE } from '../lib/email/selecao.js';
import { MOTIVOS } from '../lib/email/elegibilidade.js';
import { configuracaoBrevo } from '../lib/email/brevo.js';
import { renderizarEmail, formatarValor } from '../lib/email/modelo.js';
import { LIMITE_DIARIO, carregarLinhas, lerConfigEmail, usoDiario } from '../lib/email/dados.js';
import { iniciarLote } from '../services/emailDispatch.js';

// Aba "Disparo / E-mail". Tudo escopado por req.user.id. O envio só existe com a Brevo configurada no ambiente.
const router = Router();
const erro500 = (res, err, ctx) => {
  logLimitado(`email-${ctx}`, 'error', `[email] ${ctx}:`, descreverErro(err));
  return res.status(500).json({ error: 'Não foi possível processar agora. Tente novamente.' });
};

const nomeEmpresaValido = (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 80 && !/[\u0000-\u001f\u007f<>]/.test(v);

async function painel() {
  const [conf, uso] = await Promise.all([lerConfigEmail(), usoDiario()]);
  const brevo = configuracaoBrevo();
  const cota = calcularCota({ limite: LIMITE_DIARIO, ...uso, solicitados: 0 });
  return {
    conf,
    resposta: {
      disponibilidade: { configurado: brevo.configurado, faltando: brevo.faltando, nome_empresa_definido: Boolean(conf.nomeEmpresa), webhook_configurado: Boolean(process.env.BREVO_WEBHOOK_TOKEN?.trim()) },
      nome_empresa: conf.nomeEmpresa,
      limite_por_lote: LIMITE_POR_LOTE,
      // saldo local da conta Brevo (compartilhada): pode estar defasado se outros canais também enviam
      saldo: { limite_diario: LIMITE_DIARIO, usados: uso.usados, reservados: uso.reservados, disponivel: cota.disponivel, compartilhado: true, aviso: 'Saldo conhecido por este sistema; outros canais da mesma conta Brevo podem consumir a cota.' },
      status_aceitos: conf.statusAceitos,
      catalogo: conf.catalogo,
    },
  };
}

router.get('/config', async (req, res) => {
  try {
    res.json((await painel()).resposta);
  } catch (err) {
    erro500(res, err, 'config');
  }
});

// "Nome da empresa" (cabeçalho do e-mail). Por ora global (não existe equipe neste sistema).
router.put('/config', async (req, res) => {
  try {
    if (!nomeEmpresaValido(req.body?.nome_empresa)) return res.status(400).json({ error: 'Nome da empresa inválido (1 a 80 caracteres, sem < >).' });
    const nome = req.body.nome_empresa.trim().replace(/\s+/g, ' ');
    const { error } = await supabase.from('ennychat_config').upsert({ chave: 'email_nome_empresa', valor: nome, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
    if (error) throw error;
    res.json({ nome_empresa: nome });
  } catch (err) {
    erro500(res, err, 'config-put');
  }
});

// Prévia do HTML com dados fictícios. O nome pode vir no corpo (prévia antes de salvar).
router.post('/preview', async (req, res) => {
  try {
    const conf = await lerConfigEmail();
    const empresa = nomeEmpresaValido(req.body?.nome_empresa) ? req.body.nome_empresa.trim() : conf.nomeEmpresa || 'Nome da empresa';
    const html = renderizarEmail({ empresa, primeiro_nome: 'Cliente', mes_referencia: 'Novembro de 2026', vencimento: '15/11/2026', valor: formatarValor(99.99) });
    res.json({ html });
  } catch (err) {
    erro500(res, err, 'preview');
  }
});

// Lista (uma linha por fatura) com busca, filtro e paginação em ordem determinística.
router.get('/faturas', async (req, res) => {
  try {
    const { conf } = await painel();
    const filtro = ['elegiveis', 'pendencias', 'todas'].includes(req.query.filtro) ? req.query.filtro : 'elegiveis';
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const todas = ordenar((await carregarLinhas(req.user.id, conf)).filter((l) => casaBusca(l, String(req.query.busca ?? ''))));
    const elegiveis = todas.filter((l) => l.elegivel);
    const posicaoElegivel = new Map(elegiveis.map((l, i) => [l.cliente_id, i + 1]));
    const lista = filtro === 'elegiveis' ? elegiveis : filtro === 'pendencias' ? todas.filter((l) => !l.elegivel) : todas;
    res.json({
      total: lista.length,
      total_elegiveis: elegiveis.length,
      itens: lista.slice(offset, offset + limit).map((l) => ({ ...l, ordem_elegivel: posicaoElegivel.get(l.cliente_id) ?? null, motivos_texto: l.motivos.map((m) => MOTIVOS[m] ?? m) })),
    });
  } catch (err) {
    erro500(res, err, 'faturas');
  }
});

// Cria o lote persistido e executa em segundo plano. Revalida TUDO no servidor e reserva a cota sob trava.
router.post('/lotes', limiteSensivel, async (req, res) => {
  try {
    const brevo = configuracaoBrevo();
    if (!brevo.configurado) return res.status(503).json({ error: 'O envio de e-mail ainda não está disponível (configuração da Brevo pendente).', faltando: brevo.faltando });
    const modo = req.body?.modo === 'ids' ? 'ids' : req.body?.modo === 'todos' ? 'todos' : null;
    if (!modo) return res.status(400).json({ error: 'Informe modo: "ids" ou "todos".' });
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((x) => typeof x === 'string').slice(0, 2000) : [];
    const reenvio = req.body.reenvio === true;
    if (reenvio && modo !== 'ids') return res.status(400).json({ error: 'Reenvio só com faturas escolhidas uma a uma.' });
    if (modo === 'ids' && !ids.length) return res.status(400).json({ error: 'Nenhuma fatura selecionada.' });
    const busca = typeof req.body.busca === 'string' ? req.body.busca.slice(0, 200) : '';

    const resultado = await comTrava(async () => {
      const [conf, uso] = await Promise.all([lerConfigEmail(), usoDiario()]);
      if (!conf.nomeEmpresa) return { status: 400, corpo: { error: 'Defina o Nome da empresa em Configurações do e-mail antes de disparar.' } };
      const linhas = await carregarLinhas(req.user.id, conf);
      const sel = selecionar(linhas, { modo, ids, busca, reenvio });
      if (!sel.selecionados.length) return { status: 409, corpo: { error: 'Nenhuma fatura elegível na seleção.' } };
      const cota = calcularCota({ limite: LIMITE_DIARIO, ...uso, solicitados: sel.selecionados.length });
      if (!cota.cabe) {
        return { status: 409, corpo: { error: 'O saldo diário da Brevo não comporta a seleção. Ajuste a seleção.', disponivel: cota.disponivel, selecionadas: sel.selecionados.length } };
      }
      const { data: lote, error: e1 } = await supabase.from('email_lotes')
        .insert({ usuario_id: req.user.id, total: sel.selecionados.length, nome_empresa: conf.nomeEmpresa, reenvio }).select('*').single();
      if (e1) throw e1;
      const linhasEnvio = sel.selecionados.map((l) => ({ lote_id: lote.id, usuario_id: req.user.id, cliente_id: l.cliente_id, email: l.email.trim(), status: 'na_fila' }));
      // fatura_externa_id vem do cadastro, nunca do corpo da requisição
      const { data: cli } = await supabase.from('clientes').select('id, ennychat_fatura_id').in('id', linhasEnvio.map((l) => l.cliente_id)).eq('usuario_id', req.user.id);
      const fat = new Map((cli || []).map((c) => [c.id, c.ennychat_fatura_id]));
      const { error: e2 } = await supabase.from('email_envios').insert(linhasEnvio.map((l) => ({ ...l, fatura_externa_id: fat.get(l.cliente_id) ?? null })));
      if (e2) {
        await supabase.from('email_lotes').delete().eq('id', lote.id); // desfaz: nada foi enfileirado
        if (e2.code === '23505') return { status: 409, corpo: { error: 'Alguma fatura já está em envio. Atualize a lista.' } };
        throw e2;
      }
      return { status: 201, corpo: { lote_id: lote.id, total: sel.selecionados.length, truncado: sel.truncado, total_filtrado: sel.totalFiltrado }, lote };
    });
    if (resultado.status === 201) iniciarLote(resultado.lote.id);
    res.status(resultado.status).json(resultado.corpo);
  } catch (err) {
    erro500(res, err, 'lote');
  }
});

// Painel de engajamento: quantos receberam, abriram, clicaram, devolveram -- dos envios do operador nos últimos N dias.
router.get('/resumo', async (req, res) => {
  try {
    const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
    const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
    const consulta = (colunas) => supabase.from('email_envios').select(colunas)
      .eq('usuario_id', req.user.id).not('aceito_em', 'is', null).gte('aceito_em', desde).order('aceito_em', { ascending: false }).limit(5000);
    let { data, error } = await consulta('cliente_id, email, status, aceito_em, aberturas, primeira_abertura_em, cliques, clique_em, atualizado_em');
    if (error?.code === '42703' || error?.code === 'PGRST204') {
      // migration-32 (aberturas/cliques) ainda não rodou: mostra o que existe, sem engajamento
      ({ data, error } = await consulta('cliente_id, email, status, aceito_em, atualizado_em'));
    }
    if (error) throw error;
    const l = data || [];
    const entregues = l.filter((e) => e.status === 'entregue' || e.aberturas > 0).length;
    const abertos = l.filter((e) => e.aberturas > 0).length;
    const nomes = new Map();
    const recentes = l.slice(0, 15);
    const ids = [...new Set(recentes.map((e) => e.cliente_id).filter(Boolean))];
    if (ids.length) {
      const { data: cs } = await supabase.from('clientes').select('id, nome').in('id', ids).eq('usuario_id', req.user.id);
      for (const c of cs || []) nomes.set(c.id, c.nome);
    }
    res.json({
      dias,
      enviados: l.length, // aceitos pela Brevo
      entregues,
      abertos,
      clicaram: l.filter((e) => e.cliques > 0).length,
      devolvidos: l.filter((e) => e.status === 'devolvido').length,
      falhas: l.filter((e) => e.status === 'falhou').length,
      taxa_abertura: entregues ? Math.round((abertos / entregues) * 100) : null,
      recentes: recentes.map((e) => ({ nome: nomes.get(e.cliente_id) ?? null, email: e.email, status: e.status, aceito_em: e.aceito_em, abriu: e.aberturas > 0, aberturas: e.aberturas, primeira_abertura_em: e.primeira_abertura_em, clicou: e.cliques > 0 })),
    });
  } catch (err) {
    erro500(res, err, 'resumo');
  }
});

const CONTAGENS = ['na_fila', 'processando', 'aceito', 'entregue', 'devolvido', 'falhou', 'cancelado'];

// `linhas` = envios do lote já carregados (lista de lotes faz UMA consulta para todos); sem ele, busca os deste lote.
async function resumoLote(lote, linhas) {
  const data = linhas ?? (await supabase.from('email_envios').select('status, aceito_em, tentativas').eq('lote_id', lote.id)).data;
  const contagens = Object.fromEntries(CONTAGENS.map((s) => [s, 0]));
  let aceitosParaEnvio = 0;
  let tentativasTecnicas = 0;
  for (const e of data || []) {
    contagens[e.status] += 1;
    if (e.aceito_em) aceitosParaEnvio += 1;
    tentativasTecnicas += e.tentativas || 0;
  }
  const processados = lote.total - contagens.na_fila - contagens.processando;
  return { id: lote.id, status: lote.status, total: lote.total, processados, contagens, aceitos_para_envio: aceitosParaEnvio, tentativas_tecnicas: tentativasTecnicas, reenvio: lote.reenvio, nome_empresa: lote.nome_empresa, criado_em: lote.criado_em, concluido_em: lote.concluido_em };
}

router.get('/lotes', async (req, res) => {
  try {
    const { data, error } = await supabase.from('email_lotes').select('*').eq('usuario_id', req.user.id).order('criado_em', { ascending: false }).limit(10);
    if (error) throw error;
    const ids = (data || []).map((l) => l.id);
    const envios = ids.length ? await buscarTodos(() => supabase.from('email_envios').select('lote_id, status, aceito_em, tentativas').in('lote_id', ids).order('id')) : { data: [] };
    if (envios.error) throw envios.error;
    const porLote = new Map(ids.map((id) => [id, []]));
    for (const e of envios.data || []) porLote.get(e.lote_id)?.push(e);
    res.json({ itens: await Promise.all((data || []).map((l) => resumoLote(l, porLote.get(l.id)))) });
  } catch (err) {
    erro500(res, err, 'lotes');
  }
});

router.get('/lotes/:id', async (req, res) => {
  try {
    const { data: lote } = await supabase.from('email_lotes').select('*').eq('id', req.params.id).eq('usuario_id', req.user.id).maybeSingle();
    if (!lote) return res.status(404).json({ error: 'Lote não encontrado.' });
    const { data: itens } = await supabase.from('email_envios').select('id, cliente_id, email, status, motivo, tentativas, aceito_em, atualizado_em').eq('lote_id', lote.id).order('criado_em').order('id').limit(500);
    const nomes = new Map();
    const ids = [...new Set((itens || []).map((i) => i.cliente_id).filter(Boolean))];
    if (ids.length) {
      const { data: cs } = await supabase.from('clientes').select('id, nome').in('id', ids).eq('usuario_id', req.user.id);
      for (const c of cs || []) nomes.set(c.id, c.nome);
    }
    res.json({ lote: await resumoLote(lote), itens: (itens || []).map((i) => ({ ...i, nome: nomes.get(i.cliente_id) ?? null })) });
  } catch (err) {
    erro500(res, err, 'lote-get');
  }
});

router.post('/lotes/:id/cancelar', async (req, res) => {
  try {
    const { data: lote } = await supabase.from('email_lotes').select('id, status').eq('id', req.params.id).eq('usuario_id', req.user.id).maybeSingle();
    if (!lote) return res.status(404).json({ error: 'Lote não encontrado.' });
    await supabase.from('email_lotes').update({ status: 'cancelado', concluido_em: new Date().toISOString() }).eq('id', lote.id).eq('status', 'em_andamento');
    await supabase.from('email_envios').update({ status: 'cancelado', motivo: 'cancelado_pelo_operador', atualizado_em: new Date().toISOString() }).eq('lote_id', lote.id).eq('status', 'na_fila');
    res.json({ ok: true });
  } catch (err) {
    erro500(res, err, 'cancelar');
  }
});

export default router;
