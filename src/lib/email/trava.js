// Fila de exclusão mútua em memória (1 instância no Render): serializa "ler cota -> reservar" entre operadores
// simultâneos, para dois lotes criados ao mesmo tempo nunca reservarem mais que o saldo.
// ponytail: com 2+ instâncias isto precisa virar função SQL/advisory lock.
let cauda = Promise.resolve();
export function comTrava(tarefa) {
  const p = cauda.then(tarefa, tarefa);
  cauda = p.then(() => undefined, () => undefined);
  return p;
}
