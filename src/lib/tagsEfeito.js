import { supabase } from './supabase.js';

// Extraída de routes/tags.routes.js pra ser reaproveitada por qualquer lugar
// que aplique uma tag `permite_disparo: false` em massa -- além da atribuição
// manual de tag (1 cliente por vez, ver POST /tags/:id/clientes/:clienteId),
// agora também a importação de clientes PAGOS (ver routes/clientes.routes.js,
// POST /importar-pagos), que aplica a tag "Pago" em vários clientes de uma
// vez a partir de uma lista de nomes colada.
//
// Cancela (status -> 'cancelado') os itens ainda `pendente` dos clientes
// informados, em qualquer envio do usuário que não esteja concluído ou já
// cancelado -- é o "sai dos lotes atual e futuros" quando uma tag
// `permite_disparo: false` (ex.: Pago/Cancelado) é aplicada a um cliente.
export async function cancelarItensPendentesDosClientes(clienteIds, usuarioId) {
  if (!clienteIds || !clienteIds.length) return;

  const { data: envios } = await supabase
    .from('envios')
    .select('id')
    .eq('usuario_id', usuarioId)
    .not('status', 'in', '(concluido,cancelado)');

  const envioIds = (envios || []).map((e) => e.id);
  if (!envioIds.length) return;

  await supabase
    .from('envio_itens')
    .update({ status: 'cancelado' })
    .in('envio_id', envioIds)
    .in('cliente_id', clienteIds)
    .eq('status', 'pendente');
}
