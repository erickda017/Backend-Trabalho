import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarListaTelefones } from './telefonesAvulsos.js';

test('aceita formatos variados, normaliza e remove repetidos', () => {
  const r = normalizarListaTelefones('(11) 99999-9999\n+55 11 99999-9999\n21988887777, 5531977776666;\t11 3333-4444\n\n');
  assert.deepEqual(r.validos, ['5511999999999', '5521988887777', '5531977776666', '551133334444']);
  assert.equal(r.repetidos, 1);
  assert.deepEqual(r.invalidos, []);
});

test('separa inválidos (curto, texto, longo demais) sem derrubar os válidos', () => {
  const r = normalizarListaTelefones(['123', 'fulano', '5511999999999999', '11999999999']);
  assert.deepEqual(r.validos, ['5511999999999']);
  assert.deepEqual(r.invalidos, ['123', 'fulano', '5511999999999999']);
});
