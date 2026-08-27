import { supabase } from './supabase.js';

// ---------------------------------------------------------------------------
// Regra de negócio confirmada pelo dono do projeto: "se um cliente FPD tiver
// seu pagamento realizado, ele deve entrar na próxima safra como SPD" -- ver
// prompt.md. A promoção NUNCA é automática: a data real de vencimento do SPD
// é informação externa (vem do relatório de cobrança da empresa, que às
// vezes já importa clientes direto como SPD sem passar por FPD aqui) e não
// pode ser inventada com certeza -- por isso este módulo só CALCULA uma
// sugestão pro operador revisar/confirmar (ver POST /clientes/:id/promover-spd
// em routes/clientes.routes.js), nunca grava nada sozinho.
// ---------------------------------------------------------------------------

// "Prazo FPD 10/06 -> sugestão SPD 10/07": mesmo dia do mês seguinte,
// clampado pro último dia dele quando o dia não existir lá (ex.: 31/01 ->
// 28/02 ou 29/02).
export function proximaDataMesmoDia(dataIso) {
  const match = typeof dataIso === 'string' && dataIso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const ano = Number(match[1]);
  const mesIndice = Number(match[2]) - 1; // 0-based
  const dia = Number(match[3]);
  const ultimoDiaMesSeguinte = new Date(Date.UTC(ano, mesIndice + 2, 0)).getUTCDate();
  const diaClampado = Math.min(dia, ultimoDiaMesSeguinte);
  return new Date(Date.UTC(ano, mesIndice + 1, diaClampado)).toISOString().slice(0, 10);
}

// Sugestão de promoção pra 1 cliente, ou `null` se não se aplica (não é FPD,
// ou não tem data_prazo pra calcular a partir dela).
export async function sugerirPromocaoSpd(clienteId, usuarioId) {
  const { data: cliente, error } = await supabase
    .from('clientes')
    .select('id, nome, tipo_fatura, data_prazo')
    .eq('id', clienteId)
    .eq('usuario_id', usuarioId)
    .maybeSingle();
  if (error || !cliente || cliente.tipo_fatura !== 'FPD' || !cliente.data_prazo) return null;

  const dataSugerida = proximaDataMesmoDia(cliente.data_prazo);
  if (!dataSugerida) return null;

  return {
    cliente_id: cliente.id,
    cliente_nome: cliente.nome,
    tipo_fatura_atual: 'FPD',
    data_prazo_atual: cliente.data_prazo,
    sugestao: { tipo_fatura: 'SPD', data_prazo: dataSugerida },
  };
}

// Mesma sugestão, em lote (ver POST /clientes/importar-pagos) -- ignora quem
// não se aplica em vez de listar erro, já que "não é FPD" é o caso normal
// pra maioria dos clientes marcados como pagos.
export async function sugerirPromocoesSpd(clienteIds, usuarioId) {
  const resultados = await Promise.all(clienteIds.map((id) => sugerirPromocaoSpd(id, usuarioId)));
  return resultados.filter(Boolean);
}
