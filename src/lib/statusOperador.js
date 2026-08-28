// Pipeline de status de cobrança por cliente ("tratativa" -- ver
// migration-20-qualidade-tratativas.sql). Fonte única da verdade: tanto a
// rota de qualidade (routes/qualidade.routes.js) quanto a elegibilidade de
// disparo (routes/envios.routes.js, resolverClienteIds) leem daqui, pra nunca
// ficarem dessincronizadas sobre quais status existem e quais bloqueiam.
//
// Mesma lógica que já existia pra tags `permite_disparo: false` (ex.: Pago,
// Cancelado -- ver migration-14): aqui o BLOQUEIO é por STATUS em vez de tag,
// pro caso do operador registrar o desfecho de uma tratativa (não precisar
// criar/aplicar uma tag manualmente toda vez que confirma um pagamento).
export const STATUS_OPERADOR = [
  { valor: 'iniciado', rotulo: 'Iniciado', bloqueia_disparo: false },
  { valor: 'tentativa_contato', rotulo: 'Tentativa de contato', bloqueia_disparo: false },
  { valor: 'contato_estabelecido', rotulo: 'Contato estabelecido', bloqueia_disparo: false },
  { valor: 'promessa_pagamento', rotulo: 'Promessa de pagamento', bloqueia_disparo: false },
  { valor: 'pagamento_confirmado', rotulo: 'Pagamento confirmado', bloqueia_disparo: true },
  { valor: 'recusa_pagamento', rotulo: 'Recusa de pagamento', bloqueia_disparo: false },
  { valor: 'numero_invalido', rotulo: 'Número inválido', bloqueia_disparo: true },
  { valor: 'fraude', rotulo: 'Fraude', bloqueia_disparo: true },
  { valor: 'contrato_cancelado', rotulo: 'Contrato cancelado', bloqueia_disparo: true },
  { valor: 'renegociacao', rotulo: 'Renegociação', bloqueia_disparo: false },
];

export const STATUS_OPERADOR_VALORES = STATUS_OPERADOR.map((s) => s.valor);

export const STATUS_BLOQUEIA_DISPARO = new Set(
  STATUS_OPERADOR.filter((s) => s.bloqueia_disparo).map((s) => s.valor),
);

// Considerado "resolvido" pra fins de KPI (taxa de resolução) -- mesmo
// conjunto que bloqueia disparo hoje (pagou, cancelou, número inválido ou
// fraude são todos desfechos finais), mas mantido como lista própria porque
// as duas coisas podem divergir no futuro (ex.: um status que resolve o caso
// sem precisar tirar do disparo).
export const STATUS_RESOLVIDO = new Set(STATUS_BLOQUEIA_DISPARO);

export function statusOperadorValido(valor) {
  return typeof valor === 'string' && STATUS_OPERADOR_VALORES.includes(valor);
}
