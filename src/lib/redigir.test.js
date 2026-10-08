import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redigir, descreverErro } from './redigir.js';

test('mascara telefone, jid, e-mail, CPF, CNPJ, JWT e Bearer', () => {
  const t = redigir('tel 5511999998888 jid 5511999998888@s.whatsapp.net (11) 99999-8888 a@b.com 123.456.789-09 12.345.678/0001-95 Bearer abcdefgh12345678 eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4');
  for (const vazou of ['99999-8888', '5511999998888', 'a@b.com', '123.456.789-09', '12.345.678/0001-95', 'abcdefgh12345678', 'eyJhbGci']) {
    assert.ok(!t.includes(vazou), `vazou ${vazou}: ${t}`);
  }
});

test('mascara Pix copia-e-cola', () => {
  const pix = '00020126580014br.gov.bcb.pix0136abcd1234-5678-90ab-cdef-1234567890ab5204000053039865406100.005802BR5909FULANO6009SAO PAULO62070503***6304ABCD';
  assert.equal(redigir(`pix=${pix}`), 'pix=[pix]');
});

test('não destrói ids, números curtos e texto comum', () => {
  const s = 'envio 3f2b1c9e-1111-2222-3333-444455556666 item 42 falhou após 3/5 tentativas';
  assert.equal(redigir(s), s);
});

test('objeto e Error também saem mascarados; descreverErro ignora details', () => {
  assert.ok(!redigir({ telefone: '5511999998888' }).includes('5511999998888'));
  const e = Object.assign(new Error('duplicate key (telefone)=(5511999998888)'), { code: '23505', details: 'Key (telefone)=(5511999998888)' });
  const d = descreverErro(e);
  assert.ok(d.includes('23505') && !d.includes('5511999998888') && !d.includes('details'));
});
