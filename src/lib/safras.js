// Lógica de "safra" (acompanhamento mensal por FPD/SPD) -- ver CONTEXTO.md,
// seção "[2026-08] Safras (FPD/SPD) e histórico consolidado", e
// migration-19-safras-faturas.sql pro schema.
//
// Regra de negócio (não inventada aqui, vem do prompt original de quem pediu
// a feature): a safra de um cliente é o mês/ano da sua data de PRAZO
// (`clientes.data_prazo`), calculada automaticamente pela coluna gerada
// `clientes.safra` ('YYYY-MM'). Ex.: cliente com prazo em 24/09/2026 pertence
// à safra "2026-09", independente de quando foi importado.
//
// "Pagou" reaproveita a tag "Pago" que já existe no sistema (ver POST
// /clientes/importar-pagos) -- não é um status novo por baixo, é o mesmo
// conceito que o operador já usa hoje. "Recebeu disparo" reaproveita a mesma
// contagem de envio_itens(status='enviado') já usada em GET /clientes e no
// dashboard.
import { supabase } from './supabase.js';
import { normalizarTexto } from './nomeMatch.js';

// Formato usado em toda a feature: 'YYYY-MM'. Mantido num só lugar pra não
// divergir da coluna gerada do banco (to_char(data_prazo, 'YYYY-MM')).
export function formatoSafraValido(safra) {
  return typeof safra === 'string' && /^\d{4}-\d{2}$/.test(safra);
}

/** Rótulo amigável: "2026-09" -> "Setembro/2026". */
const MESES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
export function rotuloSafra(safra) {
  if (!formatoSafraValido(safra)) return safra;
  const [ano, mes] = safra.split('-').map(Number);
  return `${MESES_PT[mes - 1] || mes}/${ano}`;
}

// IDs dos clientes (linhas principais, sem duplicar grupo de números
// vinculados -- mesmo critério de dashboard.routes.js/supervisor.routes.js)
// de uma safra específica de um usuário.
async function clientesDaSafra(usuarioId, safra) {
  const { data, error } = await supabase
    .from('clientes')
    .select('id, nome, telefone, tipo_fatura, valor, cliente_principal_id')
    .eq('usuario_id', usuarioId)
    .eq('safra', safra);
  if (error) throw error;
  return data || [];
}

// IDs dos clientes com a tag "Pago" (mesma tag usada em POST
// /clientes/importar-pagos) dentre um conjunto de IDs já filtrado.
async function idsComTagPago(usuarioId, clienteIds) {
  if (!clienteIds.length) return new Set();
  const { data: tag } = await supabase
    .from('tags')
    .select('id')
    .eq('usuario_id', usuarioId)
    .ilike('nome', 'Pago')
    .maybeSingle();
  if (!tag) return new Set();
  const { data, error } = await supabase
    .from('cliente_tags')
    .select('cliente_id')
    .eq('tag_id', tag.id)
    .in('cliente_id', clienteIds);
  if (error) throw error;
  return new Set((data || []).map((r) => r.cliente_id));
}

// IDs dos clientes que já receberam ao menos 1 disparo (status='enviado'),
// dentre um conjunto de IDs já filtrado -- mesmo critério de
// clientes.routes.js (GET /, filtro recebeu_disparo).
async function idsComDisparo(usuarioId, clienteIds) {
  if (!clienteIds.length) return new Set();
  const { data: envios } = await supabase.from('envios').select('id').eq('usuario_id', usuarioId);
  const envioIds = (envios || []).map((e) => e.id);
  if (!envioIds.length) return new Set();
  const { data, error } = await supabase
    .from('envio_itens')
    .select('cliente_id')
    .in('envio_id', envioIds)
    .in('cliente_id', clienteIds)
    .eq('status', 'enviado');
  if (error) throw error;
  return new Set((data || []).map((r) => r.cliente_id).filter(Boolean));
}

// Duplicidade "leve": dois clientes da MESMA safra cujo nome normalizado é
// idêntico, mas com IDs diferentes -- indício de que a mesma pessoa entrou
// duas vezes na lista crua (ex.: telefone antigo + novo cadastrados
// separadamente em vez de vinculados, ver migration-15). Não corrige nada
// sozinho, só conta pra alertar o operador (ver "liberdade para melhorias"
// do pedido original: alertas/inconsistências e detecção de duplicidade).
function contarDuplicidades(clientesPrincipais) {
  const porNome = new Map();
  for (const c of clientesPrincipais) {
    const chave = normalizarTexto(c.nome);
    porNome.set(chave, (porNome.get(chave) || 0) + 1);
  }
  let duplicados = 0;
  for (const contagem of porNome.values()) {
    if (contagem > 1) duplicados += contagem;
  }
  return duplicados;
}

/** Métricas "ao vivo" de uma safra, calculadas direto sobre `clientes`. */
export async function calcularMetricasSafra(usuarioId, safra) {
  const clientes = await clientesDaSafra(usuarioId, safra);
  // Só a linha principal de cada grupo (ver migration-15) conta como
  // "1 cliente" -- mesmo critério do resto do sistema (dashboard, supervisor).
  const principais = clientes.filter((c) => !c.cliente_principal_id);
  const idsPrincipais = principais.map((c) => c.id);

  const [pagosSet, disparoSet] = await Promise.all([
    idsComTagPago(usuarioId, idsPrincipais),
    idsComDisparo(usuarioId, idsPrincipais),
  ]);

  const totalFpd = principais.filter((c) => c.tipo_fatura === 'FPD').length;
  const totalSpd = principais.filter((c) => c.tipo_fatura === 'SPD').length;
  const pagos = principais.filter((c) => pagosSet.has(c.id)).length;
  const receberamDisparo = principais.filter((c) => disparoSet.has(c.id)).length;

  const valores = principais.map((c) => Number(c.valor)).filter((v) => Number.isFinite(v));
  const valorTotal = valores.reduce((soma, v) => soma + v, 0);
  const valorMedio = valores.length ? valorTotal / valores.length : 0;

  return {
    safra,
    rotulo: rotuloSafra(safra),
    total_clientes: principais.length,
    total_fpd: totalFpd,
    total_spd: totalSpd,
    // "sem tipo reconhecido" -- não conta nem como FPD nem SPD (ex.: cliente
    // cadastrado manualmente, ou lista crua num formato sem "Fatura N").
    sem_tipo_fatura: principais.length - totalFpd - totalSpd,
    pagos,
    nao_pagos: principais.length - pagos,
    receberam_disparo: receberamDisparo,
    nao_receberam_disparo: principais.length - receberamDisparo,
    valor_total: Number(valorTotal.toFixed(2)),
    valor_medio: Number(valorMedio.toFixed(2)),
    duplicidades_detectadas: contarDuplicidades(principais),
  };
}

/** Todas as safras com clientes ativos hoje, para um usuário (ordem: mais recente primeiro). */
export async function listarSafrasAtivas(usuarioId) {
  const { data, error } = await supabase
    .from('clientes')
    .select('safra')
    .eq('usuario_id', usuarioId)
    .not('safra', 'is', null);
  if (error) throw error;
  const distintas = [...new Set((data || []).map((c) => c.safra))];
  return distintas.sort().reverse();
}

/** Histórico consolidado (safras já fechadas/arquivadas) de um usuário. */
export async function listarHistoricoSafras(usuarioId) {
  const { data, error } = await supabase
    .from('safras_historico')
    .select('*')
    .eq('usuario_id', usuarioId)
    .order('safra', { ascending: false });
  if (error) throw error;
  return data || [];
}

/** Grava (upsert) o snapshot consolidado de uma safra em safras_historico. */
export async function consolidarSafra(usuarioId, safra) {
  const metricas = await calcularMetricasSafra(usuarioId, safra);
  const { data, error } = await supabase
    .from('safras_historico')
    .upsert(
      {
        usuario_id: usuarioId,
        safra,
        total_clientes: metricas.total_clientes,
        total_fpd: metricas.total_fpd,
        total_spd: metricas.total_spd,
        pagos: metricas.pagos,
        nao_pagos: metricas.nao_pagos,
        receberam_disparo: metricas.receberam_disparo,
        nao_receberam_disparo: metricas.nao_receberam_disparo,
        valor_total: metricas.valor_total,
        valor_medio: metricas.valor_medio,
        duplicidades_detectadas: metricas.duplicidades_detectadas,
        consolidado_em: new Date().toISOString(),
      },
      { onConflict: 'usuario_id,safra' },
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Uma safra "fecha" (pode ser consolidada em definitivo) quando o mês de
// prazo dela já ficou pra trás o suficiente pra cobrir o ciclo de FPD+SPD
// inteiro (~60 dias, ver CONTEXTO.md) mais uma folga de segurança -- assim a
// consolidação automática só bate numa safra que já terminou de ser
// trabalhada de verdade, nunca uma que ainda está em andamento.
const DIAS_FOLGA_FECHAMENTO = Number(process.env.SAFRA_DIAS_FOLGA_FECHAMENTO || 75);

function safraEstaFechada(safra) {
  if (!formatoSafraValido(safra)) return false;
  const [ano, mes] = safra.split('-').map(Number);
  // Fim do mês de prazo (ex.: safra "2026-09" fecha em 30/09/2026)
  const fimDoMes = new Date(Date.UTC(ano, mes, 0));
  const limite = new Date(fimDoMes.getTime() + DIAS_FOLGA_FECHAMENTO * 24 * 60 * 60 * 1000);
  return Date.now() >= limite.getTime();
}

// Consolida (upsert em safras_historico) toda safra ativa de todo usuário que
// já tenha passado do prazo de fechamento -- roda 1x por dia, mesmo espírito
// de iniciarLimpezaAutomatica() (nunca apaga cliente nenhum: só GRAVA um
// snapshot permanente das métricas, pra sobreviver a qualquer limpeza futura
// dos dados operacionais). Idempotente: rodar de novo só atualiza o mesmo
// registro (upsert por usuario_id+safra).
export async function consolidarSafrasFechadas() {
  const { data: usuarios, error } = await supabase.from('clientes').select('usuario_id').not('safra', 'is', null);
  if (error) {
    console.error('[safras] erro ao buscar usuários com safra ativa:', error.message);
    return 0;
  }
  const usuarioIds = [...new Set((usuarios || []).map((u) => u.usuario_id).filter(Boolean))];

  let consolidadas = 0;
  for (const usuarioId of usuarioIds) {
    try {
      const safras = await listarSafrasAtivas(usuarioId);
      for (const safra of safras) {
        if (!safraEstaFechada(safra)) continue;
        await consolidarSafra(usuarioId, safra);
        consolidadas += 1;
      }
    } catch (err) {
      console.error(`[safras] erro ao consolidar safras do usuário ${usuarioId}:`, err.message);
    }
  }
  return consolidadas;
}

const INTERVALO_MS = 24 * 60 * 60 * 1000; // 1x por dia -- mesmo ritmo da limpeza automática

export function iniciarConsolidacaoSafras() {
  async function rodar() {
    try {
      const total = await consolidarSafrasFechadas();
      if (total) console.log(`[safras] ${total} safra(s) consolidada(s) no histórico.`);
    } catch (err) {
      console.error('[safras] erro inesperado na consolidação automática:', err.message);
    }
  }
  // Roda uma vez já na subida (com atraso, mesmo padrão de
  // iniciarLimpezaAutomatica) e depois 1x por dia.
  setTimeout(rodar, 45_000);
  setInterval(rodar, INTERVALO_MS);
  console.log(`[safras] consolidação automática agendada (folga de ${DIAS_FOLGA_FECHAMENTO} dias após o fim do mês de prazo).`);
}
