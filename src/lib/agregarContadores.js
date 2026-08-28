// Agrega uma lista de envio_itens em contadores por status -- usada tanto por
// envios.routes.js (resumo de 1 lote pro operador dono dele) quanto por
// supervisor.routes.js (resumo de lotes de QUALQUER operador). As duas rotas
// tinham cada uma sua própria cópia quase idêntica desta função; a única
// diferença real é `numeroInvalidoSeparado`:
//   - envios.routes.js (operador): número inválido tem contador próprio
//     (`numeros_invalidos`), porque a tela de Disparos do operador tem uma
//     coluna dedicada pra isso.
//   - supervisor.routes.js: não tem essa coluna -- número inválido conta
//     como falha ali, sempre contou assim.
export function agregarContadores(itens, { numeroInvalidoSeparado = true } = {}) {
  const c = {
    total: 0,
    enviados: 0,
    entregues: 0,
    lidos: 0,
    falhas: 0,
    pendentes: 0,
    cancelados: 0,
    ...(numeroInvalidoSeparado ? { numeros_invalidos: 0 } : {}),
  };
  for (const item of itens) {
    c.total++;
    if (item.status === 'pendente') c.pendentes++;
    if (item.status === 'erro') c.falhas++;
    if (item.status === 'numero_invalido') {
      if (numeroInvalidoSeparado) c.numeros_invalidos++;
      else c.falhas++;
    }
    if (item.status === 'enviado') c.enviados++;
    if (item.status === 'cancelado') c.cancelados++;
    if (item.status_entrega === 'entregue' || item.status_entrega === 'lido') c.entregues++;
    if (item.status_entrega === 'lido') c.lidos++;
  }
  return c;
}
