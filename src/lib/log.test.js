import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logLimitado, _resetarLogLimitado } from './log.js';

test('logLimitado: 1ª sai, repetidas na janela são contadas, não somem', (t) => {
  _resetarLogLimitado();
  const chamadas = [];
  t.mock.method(console, 'error', (...a) => chamadas.push(a));
  for (let i = 0; i < 50; i++) logLimitado('k', 'error', 'falhou');
  assert.equal(chamadas.length, 1);
  logLimitado('outra', 'error', 'x');
  assert.equal(chamadas.length, 2, 'chave diferente não é suprimida');
});

test('logLimitado: depois da janela, relata quantas foram suprimidas', (t) => {
  _resetarLogLimitado();
  const chamadas = [];
  t.mock.method(console, 'error', (...a) => chamadas.push(a));
  let agora = 1_000_000;
  t.mock.method(Date, 'now', () => agora);
  logLimitado('k', 'error', 'falhou');
  logLimitado('k', 'error', 'falhou');
  logLimitado('k', 'error', 'falhou');
  agora += 61_000;
  logLimitado('k', 'error', 'falhou');
  assert.equal(chamadas.length, 2);
  assert.match(chamadas[1].at(-1), /\+2 iguais suprimidas/);
});
