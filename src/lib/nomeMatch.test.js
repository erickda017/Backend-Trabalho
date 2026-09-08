// Ver parseListaClientes.test.js -- mesma iniciativa. nomeMatch.js é a outra
// função pura crítica desta sessão: resolve qual cliente cadastrado
// corresponde a um nome/contrato colado, e um bug aqui significa marcar o
// cliente ERRADO como pago ou anexar o boleto de uma pessoa na conta de
// outra -- vale mais teste de regressão do que qualquer outra função do
// sistema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { casarCliente, encontrarClientesPorNome, normalizarTexto } from './nomeMatch.js';

const clientesBase = [
  { id: 'a', nome: 'JOAO DA SILVA', numero_contrato: '111111' },
  { id: 'b', nome: 'JOAO DA SILVA', numero_contrato: '222222' },
  { id: 'c', nome: 'MARIA OLIVEIRA', numero_contrato: '333333' },
];

test('contrato certo resolve mesmo com nome duplicado (o caso central desta feature)', () => {
  const r = casarCliente({ nome: 'JOAO DA SILVA', numeroContrato: '222222', clientes: clientesBase });
  assert.equal(r.status, 'contrato');
  assert.equal(r.cliente.id, 'b');
});

test('nome duplicado sem contrato para desempatar vira ambíguo, não adivinha', () => {
  const r = casarCliente({ nome: 'JOAO DA SILVA', clientes: clientesBase });
  assert.equal(r.status, 'ambiguo');
  assert.equal(r.cliente, null);
  assert.equal(r.candidatos.length, 2);
});

test('contrato duplicado entre pessoas diferentes também vira ambíguo (bug real corrigido 2026-09)', () => {
  const clientes = [
    { id: 'a', nome: 'JOAO DA SILVA', numero_contrato: '999999' },
    { id: 'b', nome: 'PEDRO SOUZA', numero_contrato: '999999' },
  ];
  const r = casarCliente({ nome: 'JOAO DA SILVA', numeroContrato: '999999', clientes });
  assert.equal(r.status, 'ambiguo');
  assert.equal(r.candidatos.length, 2);
});

test('nome único resolve normalmente sem contrato', () => {
  const r = casarCliente({ nome: 'MARIA OLIVEIRA', clientes: clientesBase });
  assert.equal(r.status, 'nome');
  assert.equal(r.cliente.id, 'c');
});

test('contrato que não bate com ninguém cai pro fallback de nome', () => {
  const r = casarCliente({ nome: 'MARIA OLIVEIRA', numeroContrato: '000000', clientes: clientesBase });
  assert.equal(r.status, 'nome');
  assert.equal(r.cliente.id, 'c');
});

test('não encontrado', () => {
  const r = casarCliente({ nome: 'NINGUEM AQUI', clientes: clientesBase });
  assert.equal(r.status, 'nao_encontrado');
  assert.equal(r.cliente, null);
});

test('encontrarClientesPorNome: exato tem prioridade sobre parcial', () => {
  const clientes = [
    { id: 'a', nome: 'JOAO' },
    { id: 'b', nome: 'JOAO DA SILVA' },
  ];
  const r = encontrarClientesPorNome(normalizarTexto('joao'), clientes);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'a');
});

test('normalizarTexto remove acento e caixa', () => {
  assert.equal(normalizarTexto('José Ávila'), 'jose avila');
});
