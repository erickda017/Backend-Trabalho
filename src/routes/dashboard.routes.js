import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

// Brasil não observa horário de verão desde 2019 -- offset fixo -03:00.
// Mesmo cálculo usado em dispatchQueue.js pra "início do dia" no fuso de SP.
function inicioDoDiaBR() {
  const dataSP = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${dataSP}T00:00:00-03:00`).toISOString();
}

// [2026-08] MULTI-TENANT: todo contador é escopado por usuario_id. Tabelas
// com a coluna direto (clientes) filtram normal; envio_itens não tem
// usuario_id próprio -- passa pelo join com envios (join!inner garante que só
// conta linhas cujo envio pai é do usuário).
async function contar(tabela, usuarioId, filtros = {}, { viaEnvios = false } = {}) {
  let query = viaEnvios
    ? supabase.from(tabela).select('*, envios!inner(usuario_id)', { count: 'exact', head: true }).eq('envios.usuario_id', usuarioId)
    : supabase.from(tabela).select('*', { count: 'exact', head: true }).eq('usuario_id', usuarioId);

  for (const [coluna, valor] of Object.entries(filtros)) {
    if (valor && typeof valor === 'object' && valor.op === 'not_null') {
      query = query.not(coluna, 'is', null);
    } else if (valor && typeof valor === 'object' && valor.op === 'is_null') {
      query = query.is(coluna, null);
    } else if (valor && typeof valor === 'object' && valor.op === 'gte') {
      query = query.gte(coluna, valor.valor);
    } else if (valor && typeof valor === 'object' && valor.op === 'in') {
      query = query.in(coluna, valor.valores);
    } else {
      query = query.eq(coluna, valor);
    }
  }
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

// Série diária de disparos enviados nos últimos N dias, no fuso de SP --
// usada pro gráfico do dashboard ("dados mais dinâmicos"). Cálculo em JS
// (não em SQL) de propósito: mesma filosofia de simplicidade do resto do
// arquivo (`contar` acima) -- carteira de uso pessoal, não precisa de
// materialized view pra isso ainda (ver CONTEXTO.md).
async function serieDisparosPorDia(usuarioId, dias = 7) {
  const hojeSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const inicioJanela = new Date(`${hojeSP}T00:00:00-03:00`);
  inicioJanela.setDate(inicioJanela.getDate() - (dias - 1));

  const { data: itens, error } = await supabase
    .from('envio_itens')
    .select('enviado_em, envios!inner(usuario_id)')
    .eq('envios.usuario_id', usuarioId)
    .eq('status', 'enviado')
    .gte('enviado_em', inicioJanela.toISOString());
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

// Média e total dos valores de fatura cadastrados nos clientes (só quem tem
// `valor` preenchido -- ver "Dashboard: média dos valores das faturas").
// [2026-08] Números vinculados (ver migration-15) espelham o mesmo `valor` do
// grupo -- por isso só a linha principal (cliente_principal_id nulo) de cada
// grupo entra na conta, senão um cliente com 2 números contaria a fatura em
// dobro.
async function resumoValores(usuarioId) {
  const { data, error } = await supabase
    .from('clientes')
    .select('valor')
    .eq('usuario_id', usuarioId)
    .is('cliente_principal_id', null)
    .not('valor', 'is', null);
  if (error) throw error;
  const valores = (data || []).map((c) => Number(c.valor)).filter((v) => Number.isFinite(v));
  const total = valores.reduce((soma, v) => soma + v, 0);
  const media = valores.length ? total / valores.length : 0;
  return { valor_medio: Number(media.toFixed(2)), valor_total: Number(total.toFixed(2)), faturas_com_valor: valores.length };
}

router.get('/resumo', async (req, res) => {
  try {
    const usuarioId = req.user.id;
    const inicioHoje = inicioDoDiaBR();

    const [
      clientes,
      faturas,
      disparosHoje,
      enviados,
      entregues,
      lidos,
      falhas,
      numerosInvalidos,
      pendentes,
      valores,
      serieDisparos,
    ] = await Promise.all([
      // [2026-08] "Clientes" conta pessoas, não números -- um cliente com 2+
      // números vinculados (ver migration-15) é 1 linha principal
      // (cliente_principal_id nulo) + N linhas espelho, então só a principal
      // entra na conta pra não contar a mesma pessoa 2x.
      contar('clientes', usuarioId, { cliente_principal_id: { op: 'is_null' } }),
      // [2026-08] pdf_url é coluna deprecated e não é mais gravada (bucket
      // privado, ver migration-12) -- o filtro certo pra "cliente tem PDF" é
      // pdf_path, que continua sendo a fonte da verdade. Mesma lógica de
      // "só a principal" acima -- o PDF é espelhado pro grupo inteiro
      // (faturaPropagacao.js), então contar toda linha duplicaria a fatura.
      contar('clientes', usuarioId, { pdf_path: { op: 'not_null' }, cliente_principal_id: { op: 'is_null' } }),
      contar('envio_itens', usuarioId, { enviado_em: { op: 'gte', valor: inicioHoje } }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status: 'enviado' }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status_entrega: { op: 'in', valores: ['entregue', 'lido'] } }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status_entrega: 'lido' }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status: 'erro' }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status: 'numero_invalido' }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status: 'pendente' }, { viaEnvios: true }),
      resumoValores(usuarioId),
      serieDisparosPorDia(usuarioId, 7),
    ]);

    res.json({
      clientes,
      faturas,
      disparos_hoje: disparosHoje,
      enviados,
      entregues,
      lidos,
      falhas,
      numeros_invalidos: numerosInvalidos,
      pendentes,
      ...valores,
      serie_disparos_7dias: serieDisparos,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
