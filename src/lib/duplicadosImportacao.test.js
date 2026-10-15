import test from 'node:test';
import assert from 'node:assert/strict';
import { criarIndiceDuplicados, digitosContrato } from './duplicadosImportacao.js';

test('telefone já cadastrado é duplicata', () => {
  const idx = criarIndiceDuplicados([{ telefone: '5541999990000', numero_contrato: null }]);
  assert.equal(idx.motivo('5541999990000', null), 'telefone já cadastrado');
  assert.equal(idx.motivo('5541888880000', null), null);
});

test('contrato já cadastrado é duplicata mesmo com telefone novo, ignorando pontuação', () => {
  const idx = criarIndiceDuplicados([{ telefone: '5541999990000', numero_contrato: '1512993' }]);
  assert.equal(idx.motivo('5541888880000', '1.512.993'), 'contrato já cadastrado');
  assert.equal(idx.motivo('5541888880000', '999'), null);
});

test('nome sozinho nunca é duplicata; sem contrato/telefone igual é novo', () => {
  const idx = criarIndiceDuplicados([{ telefone: '5541999990000', numero_contrato: '1' }]);
  assert.equal(idx.motivo('5541777770000', null), null);
});

test('item repetido no mesmo lote é pego depois de registrado', () => {
  const idx = criarIndiceDuplicados([]);
  assert.equal(idx.motivo('5541999990000', '77'), null);
  idx.registrar('5541999990000', '77');
  assert.equal(idx.motivo('5541999990000', '77'), 'telefone já cadastrado');
  assert.equal(idx.motivo('5541666660000', '77'), 'contrato já cadastrado');
});

test('digitosContrato', () => {
  assert.equal(digitosContrato(null), null);
  assert.equal(digitosContrato(' 12-3 '), '123');
});
