// Pipeline de status de tratativa por cliente da campanha "Ativação Chip"
// (ver migration-25-ativacao-chip.sql). Espelha src/lib/statusOperador.js
// (mesmo mecanismo -- coluna clientes.status_operador + tabela tratativas --
// só um vocabulário diferente, já que a campanha de chip não tem conceito de
// pagamento/fatura). Fonte única da verdade: tanto a rota de Ativação Chip
// quanto a elegibilidade de disparo (envios.routes.js) leem daqui.
export const STATUS_CHIP = [
  { valor: 'pendente', rotulo: 'Pendente', bloqueia_disparo: false },
  { valor: 'tentativa_contato', rotulo: 'Tentativa de contato', bloqueia_disparo: false },
  { valor: 'contato_estabelecido', rotulo: 'Contato estabelecido', bloqueia_disparo: false },
  { valor: 'chip_ativado', rotulo: 'Chip ativado', bloqueia_disparo: true },
  { valor: 'recusado', rotulo: 'Recusado', bloqueia_disparo: true },
  { valor: 'numero_invalido', rotulo: 'Número inválido', bloqueia_disparo: true },
];

export const STATUS_CHIP_VALORES = STATUS_CHIP.map((s) => s.valor);

export const STATUS_CHIP_BLOQUEIA_DISPARO = new Set(
  STATUS_CHIP.filter((s) => s.bloqueia_disparo).map((s) => s.valor),
);

export const STATUS_CHIP_RESOLVIDO = new Set(STATUS_CHIP_BLOQUEIA_DISPARO);

export function statusChipValido(valor) {
  return typeof valor === 'string' && STATUS_CHIP_VALORES.includes(valor);
}
