import { Router } from 'express';
import { supabase, urlsProxyArquivo } from '../lib/supabase.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { escaparFiltroPostgrest } from '../lib/filtros.js';

// [2026-08] SUPERVISOR: único papel que enxerga dados de TODOS os operadores
// (é uma operação única -- ver decisão no chat, não multi-empresa). Todo
// router aqui é montado com requireAuth + requireSupervisor em server.js --
// nenhuma rota individual re-checa o papel.
const router = Router();

function agregarContadores(itens) {
  const c = { total: 0, enviados: 0, entregues: 0, lidos: 0, falhas: 0, pendentes: 0, cancelados: 0 };
  for (const item of itens) {
    c.total++;
    if (item.status === 'pendente') c.pendentes++;
    // [correção] 'numero_invalido' não caía em NENHUM contador antes --
    // sumia dos totais do dashboard/disparos do Supervisor sem aparecer
    // como falha nem como pendente. Conta como falha aqui (a tela do
    // Supervisor não tem uma coluna própria pra isso, diferente da tela de
    // Disparos do operador).
    if (item.status === 'erro' || item.status === 'numero_invalido') c.falhas++;
    if (item.status === 'enviado') c.enviados++;
    if (item.status === 'cancelado') c.cancelados++;
    if (item.status_entrega === 'entregue' || item.status_entrega === 'lido') c.entregues++;
    if (item.status_entrega === 'lido') c.lidos++;
  }
  return c;
}

// Mapa usuario_id -> {email, nome} pra anexar "operador" nas respostas sem
// repetir join manual em cada rota.
async function mapaOperadores() {
  const { data, error } = await supabase.from('perfis').select('id, email, nome');
  if (error) throw error;
  return new Map((data || []).map((p) => [p.id, { id: p.id, email: p.email, nome: p.nome || p.email }]));
}

// [correção] "cliente" tem que contar PESSOAS, não números. Um mesmo cliente
// com 2+ números vinculados (migration-15) vira 1 linha principal
// (cliente_principal_id nulo) + N linhas espelho -- e PDF/Pix/valor são
// propagados pra todas elas (faturaPropagacao.js). Contar toda linha sem
// filtrar as espelho infla "Clientes"/"Com PIX"/"Com PDF" no Dashboard do
// Supervisor (a mesma pessoa contada 2x+), mesmo já sendo tratado direito em
// GET /operadores logo acima -- o Dashboard tinha ficado pra trás dessa regra
// (que já vale pro dashboard do operador, ver dashboard.routes.js). Aplique
// este filtro em toda contagem de "clientes" feita aqui.
function somenteLinhasPrincipais(clientes) {
  return (clientes || []).filter((c) => !c.cliente_principal_id);
}

// Brasil não observa horário de verão desde 2019 -- offset fixo -03:00.
// Mesmo cálculo usado em dashboard.routes.js (dashboard do operador) e em
// dispatchQueue.js, replicado aqui pra não criar uma dependência cruzada só
// por causa de uma função de poucas linhas.
function inicioDoDiaBR(diasAtras = 0) {
  const dataSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const d = new Date(`${dataSP}T00:00:00-03:00`);
  d.setDate(d.getDate() - diasAtras);
  return d;
}

// [2026-08] Mesma "Faturas em valor" (média/total) e mesmo gráfico "Disparos
// por dia" que já existem no dashboard do operador (ver dashboard.routes.js)
// -- só que agregados de TODOS os operadores, já que essa é a proposta da
// tela do Supervisor. Faltavam aqui: o Dashboard do Supervisor tinha ficado
// só com as contagens "por operador", sem os dois blocos que o dashboard do
// operador já tem há mais tempo.
async function resumoValoresGlobal() {
  const { data, error } = await supabase.from('clientes').select('valor, cliente_principal_id').not('valor', 'is', null).limit(20000);
  if (error) throw error;
  const valores = somenteLinhasPrincipais(data).map((c) => Number(c.valor)).filter((v) => Number.isFinite(v));
  const total = valores.reduce((soma, v) => soma + v, 0);
  const media = valores.length ? total / valores.length : 0;
  return { valor_medio: Number(media.toFixed(2)), valor_total: Number(total.toFixed(2)), faturas_com_valor: valores.length };
}

async function serieDisparosGlobalPorDia(dias = 7) {
  const inicioJanela = inicioDoDiaBR(dias - 1);
  const { data: itens, error } = await supabase
    .from('envio_itens')
    .select('enviado_em')
    .eq('status', 'enviado')
    .gte('enviado_em', inicioJanela.toISOString())
    .limit(50000);
  if (error) throw error;

  const porDia = {};
  for (const item of itens || []) {
    if (!item.enviado_em) continue;
    const diaSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(item.enviado_em));
    porDia[diaSP] = (porDia[diaSP] || 0) + 1;
  }

  const serie = [];
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(inicioJanela);
    d.setDate(inicioJanela.getDate() + (dias - 1 - i));
    const chave = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
    serie.push({ data: chave, total: porDia[chave] || 0 });
  }
  return serie;
}

// GET /api/supervisor/operadores -- lista todo mundo que já logou (perfis),
// com um resumo rápido de carteira. Base do dashboard e dos filtros
// "por operador" nas outras telas do Supervisor.
router.get('/operadores', async (req, res) => {
  try {
    const { data: perfis, error } = await supabase.from('perfis').select('id, email, nome, role, created_at').order('email');
    if (error) throw error;

    const ids = (perfis || []).map((p) => p.id);
    // [correção] sem .limit() aqui, o PostgREST aplica o teto default dele
    // (bem abaixo do que a operação real deve ter) e trunca em silêncio --
    // o card de cada operador ficaria sub-contado sem nenhum aviso. 20 mil é
    // uma folga generosa; ajuste se a operação crescer muito além disso.
    const [{ data: clientes }, { data: envios }] = await Promise.all([
      supabase.from('clientes').select('id, usuario_id, pix_code, cliente_principal_id').in('usuario_id', ids.length ? ids : ['—']).limit(20000),
      supabase.from('envios').select('id, usuario_id, status').in('usuario_id', ids.length ? ids : ['—']).limit(20000),
    ]);

    const operadores = (perfis || []).map((p) => {
      // [2026-08] Mesma regra do dashboard do operador (ver dashboard.routes.js):
      // só a linha principal de cada grupo de números vinculados (migration-15)
      // conta como "cliente", senão a mesma pessoa com 2 números aparece 2x
      // na carteira do supervisor.
      const meusClientes = (clientes || []).filter((c) => c.usuario_id === p.id && !c.cliente_principal_id);
      const meusEnvios = (envios || []).filter((e) => e.usuario_id === p.id);
      return {
        ...p,
        total_clientes: meusClientes.length,
        total_com_pix: meusClientes.filter((c) => c.pix_code).length,
        disparos_em_andamento: meusEnvios.filter((e) => ['em_andamento', 'pendente', 'pausado', 'agendado'].includes(e.status)).length,
        disparos_concluidos: meusEnvios.filter((e) => e.status === 'concluido').length,
      };
    });

    res.json(operadores);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/supervisor/clientes -- todos os clientes de todos os operadores.
// Filtros: busca, operador_id, com_pix/sem_pix (mesmos nomes de /api/clientes).
router.get('/clientes', async (req, res) => {
  try {
    // [correção] com_pdf/sem_pdf existem em GET /api/clientes (tela do
    // operador) mas nunca tinham sido replicados aqui -- o Supervisor não
    // tinha como filtrar quem está sem PDF entre todos os operadores.
    const { busca, operador_id, com_pix, sem_pix, com_pdf, sem_pdf } = req.query;
    const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });

    let query = supabase.from('clientes').select('*, cliente_tags(tags(id, nome, cor))', { count: 'exact' }).order('nome');
    if (operador_id) query = query.eq('usuario_id', operador_id);
    if (busca) {
      const b = escaparFiltroPostgrest(busca);
      query = query.or(`nome.ilike.%${b}%,telefone.ilike.%${b}%`);
    }
    if (com_pix === 'true' || com_pix === '1') query = query.not('pix_code', 'is', null);
    if (sem_pix === 'true' || sem_pix === '1') query = query.is('pix_code', null);
    if (com_pdf === 'true' || com_pdf === '1') query = query.not('pdf_path', 'is', null);
    if (sem_pdf === 'true' || sem_pdf === '1') query = query.is('pdf_path', null);

    const { data, error } = await query.range(from, to);
    if (error) throw error;

    const operadores = await mapaOperadores();
    const clientes = (data || []).map(({ cliente_tags, ...c }) => ({
      ...c,
      tags: (cliente_tags || []).map((ct) => ct.tags).filter(Boolean),
      operador: operadores.get(c.usuario_id) || null,
    }));
    res.json(clientes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/supervisor/faturas -- mesma visão de faturas.routes.js, mas sem
// escopo de usuario_id + filtro por operador_id.
router.get('/faturas', async (req, res) => {
  try {
    const { busca, operador_id, com_pdf, sem_pdf } = req.query;
    const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });

    let query = supabase
      .from('clientes')
      .select('cliente_id:id, cliente_nome:nome, telefone, valor, vencimento, pdf_path, pix_code, usuario_id', { count: 'exact' })
      .order('nome');
    if (operador_id) query = query.eq('usuario_id', operador_id);
    if (busca) query = query.or(`nome.ilike.%${escaparFiltroPostgrest(busca)}%,telefone.ilike.%${escaparFiltroPostgrest(busca)}%`);
    if (com_pdf === 'true' || com_pdf === '1') query = query.not('pdf_path', 'is', null);
    if (sem_pdf === 'true' || sem_pdf === '1') query = query.is('pdf_path', null);

    const { data, error } = await query.range(from, to);
    if (error) throw error;

    const linhas = data || [];
    // pdf_url devolvido ao front é um path relativo ao proxy de arquivos
    // deste backend, não uma signed URL do Supabase -- ver
    // routes/arquivos.routes.js e o mesmo padrão em clientes/faturas.routes.js.
    const urls = urlsProxyArquivo('faturas', linhas.map((l) => l.pdf_path));
    const operadores = await mapaOperadores();
    res.json(linhas.map((l, i) => ({ ...l, pdf_url: urls[i], operador: operadores.get(l.usuario_id) || null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/supervisor/disparos -- todos os lotes de envio, de todos os
// operadores. Filtros: status, operador_id.
router.get('/disparos', async (req, res) => {
  try {
    const { status, operador_id } = req.query;
    const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });

    let query = supabase.from('envios').select('*', { count: 'exact' }).order('created_at', { ascending: false });
    if (operador_id) query = query.eq('usuario_id', operador_id);
    if (status && status !== 'todos') query = query.eq('status', status);

    const { data: envios, error } = await query.range(from, to);
    if (error) throw error;

    const ids = (envios || []).map((e) => e.id);
    let itensPorEnvio = new Map();
    if (ids.length) {
      const { data: itens, error: itensError } = await supabase
        .from('envio_itens')
        .select('envio_id, status, status_entrega')
        .in('envio_id', ids)
        .limit(50000);
      if (itensError) throw itensError;
      for (const item of itens || []) {
        if (!itensPorEnvio.has(item.envio_id)) itensPorEnvio.set(item.envio_id, []);
        itensPorEnvio.get(item.envio_id).push(item);
      }
    }

    const operadores = await mapaOperadores();
    const lista = (envios || []).map((envio) => ({
      id: envio.id,
      criado_em: envio.created_at,
      lote: envio.lote || null,
      status: envio.status,
      template_mensagem: envio.template_mensagem,
      operador: operadores.get(envio.usuario_id) || null,
      ...agregarContadores(itensPorEnvio.get(envio.id) || []),
    }));
    res.json(lista);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/supervisor/dashboard -- números agregados por operador +
// totais gerais, pra tela de Dashboard do Supervisor.
router.get('/dashboard', async (req, res) => {
  try {
    const [
      { data: perfis, error: perfisError },
      { data: clientesRaw, error: clientesError },
      { data: envios, error: enviosError },
      valores,
      serieDisparos,
    ] = await Promise.all([
      supabase.from('perfis').select('id, email, nome'),
      // [correção] precisa de cliente_principal_id pra descontar linhas
      // espelho de números vinculados (ver somenteLinhasPrincipais acima) --
      // sem isso um cliente com 2 números era contado 2x em "Clientes",
      // "Com PDF" e "Com PIX", tanto por operador quanto no total geral.
      supabase.from('clientes').select('id, usuario_id, pix_code, pdf_path, cliente_principal_id').limit(20000),
      supabase.from('envios').select('id, usuario_id, status, created_at').limit(20000),
      resumoValoresGlobal(),
      serieDisparosGlobalPorDia(7),
    ]);
    if (perfisError) throw perfisError;
    if (clientesError) throw clientesError;
    if (enviosError) throw enviosError;

    const clientes = somenteLinhasPrincipais(clientesRaw);

    const envioIds = (envios || []).map((e) => e.id);
    let itensPorEnvio = new Map();
    if (envioIds.length) {
      const { data: itens, error: itensError } = await supabase
        .from('envio_itens')
        .select('envio_id, status, status_entrega')
        .in('envio_id', envioIds)
        .limit(50000);
      if (itensError) throw itensError;
      for (const item of itens || []) {
        if (!itensPorEnvio.has(item.envio_id)) itensPorEnvio.set(item.envio_id, []);
        itensPorEnvio.get(item.envio_id).push(item);
      }
    }

    const porOperador = (perfis || []).map((p) => {
      const meusClientes = clientes.filter((c) => c.usuario_id === p.id);
      const meusEnvios = (envios || []).filter((e) => e.usuario_id === p.id);
      const contadoresTotais = meusEnvios.reduce(
        (acc, e) => {
          const c = agregarContadores(itensPorEnvio.get(e.id) || []);
          acc.enviados += c.enviados;
          acc.entregues += c.entregues;
          acc.lidos += c.lidos;
          acc.falhas += c.falhas;
          return acc;
        },
        { enviados: 0, entregues: 0, lidos: 0, falhas: 0 },
      );
      return {
        operador: { id: p.id, email: p.email, nome: p.nome || p.email },
        total_clientes: meusClientes.length,
        com_pdf: meusClientes.filter((c) => c.pdf_path).length,
        com_pix: meusClientes.filter((c) => c.pix_code).length,
        disparos_em_andamento: meusEnvios.filter((e) => ['em_andamento', 'pendente', 'pausado', 'agendado'].includes(e.status)).length,
        disparos_concluidos: meusEnvios.filter((e) => e.status === 'concluido').length,
        ...contadoresTotais,
      };
    });

    // [2026-08] Totais de enviados/falhas/pendentes agregados de TODOS os
    // operadores -- mesma info que o dashboard do operador já mostra
    // (enviados/falhas/pendentes, ver dashboard.routes.js), só que somada em
    // vez de por usuário. Reaproveita `itensPorEnvio` já buscado acima, sem
    // bater no banco de novo.
    const contadoresGlobais = porOperador.reduce(
      (acc, op) => {
        acc.enviados += op.enviados;
        acc.falhas += op.falhas;
        return acc;
      },
      { enviados: 0, falhas: 0 },
    );
    let pendentesGlobal = 0;
    for (const itens of itensPorEnvio.values()) {
      for (const item of itens) {
        if (item.status === 'pendente') pendentesGlobal++;
      }
    }

    res.json({
      totais: {
        operadores: (perfis || []).length,
        clientes: clientes.length,
        com_pix: clientes.filter((c) => c.pix_code).length,
        disparos_em_andamento: (envios || []).filter((e) => ['em_andamento', 'pendente', 'pausado', 'agendado'].includes(e.status)).length,
        disparos_concluidos: (envios || []).filter((e) => e.status === 'concluido').length,
        enviados: contadoresGlobais.enviados,
        falhas: contadoresGlobais.falhas,
        pendentes: pendentesGlobal,
        ...valores,
      },
      serie_disparos_7dias: serieDisparos,
      por_operador: porOperador,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/supervisor/indice-pix -- lista enxuta (nome, telefone, pix_code,
// operador) de TODOS os clientes com Pix já cadastrado, de todos os
// operadores. Usado pelas duas funções de planilha (ver
// routes/supervisor.tsx no front): casamento é feito no navegador por nome
// (mesma lógica de src/lib/clienteMatch.ts), aqui só entregamos a matéria-
// prima já filtrada (sem PDF/tags/valor -- não é preciso pra casar por nome).
router.get('/indice-pix', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clientes')
      .select('id, nome, telefone, pix_code, usuario_id')
      .not('pix_code', 'is', null)
      .limit(20000);
    if (error) throw error;
    const operadores = await mapaOperadores();
    res.json((data || []).map((c) => ({ ...c, operador: operadores.get(c.usuario_id) || null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
