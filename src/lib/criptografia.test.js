import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cifrar, decifrar, estaCifrado, hashComChave, criptografiaAtiva } from './criptografia.js';

const env = { DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') };

test('cifra e decifra ida e volta; texto cifrado não contém o original', () => {
  const c = cifrar('{"telefone":"5511999999999"}', env);
  assert.ok(estaCifrado(c));
  assert.ok(!c.includes('5511999999999'));
  assert.equal(decifrar(c, env), '{"telefone":"5511999999999"}');
});

test('IV aleatório: mesmo texto gera cifrados diferentes', () => {
  assert.notEqual(cifrar('x', env), cifrar('x', env));
});

test('adulteração e chave errada falham (nunca devolvem lixo)', () => {
  const c = cifrar('segredo', env);
  const partes = c.split(':');
  partes[4] = Buffer.from('outra coisa').toString('base64url');
  assert.throws(() => decifrar(partes.join(':'), env));
  assert.throws(() => decifrar(c, { DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') }));
});

test('sem chave: passa texto puro; legado puro é lido; cifrado sem chave erra', () => {
  assert.equal(criptografiaAtiva({}), false);
  assert.equal(cifrar('abc', {}), 'abc');
  assert.equal(decifrar('abc', {}), 'abc');
  assert.throws(() => decifrar(cifrar('abc', env), {}));
});

test('chave com tamanho errado é recusada', () => {
  assert.throws(() => cifrar('x', { DATA_ENCRYPTION_KEY: Buffer.from('curta').toString('base64') }));
});

test('hash com chave é estável e diferente por chave', () => {
  assert.equal(hashComChave('a', env), hashComChave('a', env));
  assert.notEqual(hashComChave('a', env), hashComChave('a', { DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') }));
});
