// [2026-09] Primeiro teste automatizado do projeto -- ver auditoria técnica
// em Front-Trabalho/CONTEXTO.md. Cobre parseListaClientes.js por ser a
// função pura mais crítica e sutil do sistema (parser por tokens com
// lookahead) e por ter tido 2 bugs reais corrigidos nesta mesma sessão --
// exatamente o tipo de lógica que se beneficia de teste de regressão.
// `node --test`, sem dependência nova (já vem com o Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListaClientes, extrairNomesEContratosDeListaCrua, slugNome } from './parseListaClientes.js';

test('formato composto (1 linha, separado por |)', () => {
  const { itens, avisos } = parseListaClientes('JOAO DA SILVA | CPF 123.456.789-00 | 41999999999 | R$ 150,00');
  assert.equal(avisos.length, 0);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].nome, 'JOAO DA SILVA');
  assert.equal(itens[0].numero, '41999999999');
  assert.equal(itens[0].valor, 150);
});

test('linha em branco entre campos do mesmo cliente não perde o bloco (bug real corrigido 2026-09)', () => {
  const texto = [
    'ODINEIA SOUZA COSTA',
    '',
    '16440859',
    '',
    'CPF 277.803.332-72',
    '',
    '9186352938',
    '91986352938',
    'Fatura 1',
    'R$ 126,41',
  ].join('\n');

  const { itens, avisos } = parseListaClientes(texto);
  assert.equal(avisos.length, 0);
  assert.equal(itens.length, 2, 'um item por telefone');
  assert.equal(itens[0].nome, 'ODINEIA SOUZA COSTA');
  assert.equal(itens[0].numero_contrato, '16440859');
  assert.equal(itens[0].valor, 126.41);
  assert.equal(itens[0].tipo_fatura, 'FPD');
  assert.equal(itens[1].numero, '91986352938');
});

test('nome de plano/operadora entre telefones e "Fatura N" não é lido como próximo cliente (bug real corrigido 2026-09)', () => {
  const texto = ['JOAO DA SILVA', '12345', 'CPF 111.111.111-11', '41999999999', 'CLARO MEGA', 'Fatura 1', 'R$ 100,00'].join(
    '\n',
  );

  const { itens, avisos } = parseListaClientes(texto);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].nome, 'JOAO DA SILVA');
  assert.equal(itens[0].valor, 100);
  assert.equal(itens[0].tipo_fatura, 'FPD');
  assert.ok(avisos.some((a) => a.includes('CLARO MEGA')), 'vira aviso, não bloco fantasma');
});

test('bloco sem telefone vira aviso, não item', () => {
  const { itens, avisos } = parseListaClientes('FULANO SEM TELEFONE\nCPF 000.000.000-00');
  assert.equal(itens.length, 0);
  assert.ok(avisos.some((a) => a.includes('FULANO SEM TELEFONE')));
});

test('separador explícito ##### fecha o bloco', () => {
  const texto = ['JOAO', '41999999999', '#####', 'MARIA', '41988888888'].join('\n');
  const { itens } = parseListaClientes(texto);
  assert.equal(itens.length, 2);
  assert.equal(itens[0].nome, 'JOAO');
  assert.equal(itens[1].nome, 'MARIA');
});

test('extrairNomesEContratosDeListaCrua: pareia nome+contrato sem exigir telefone', () => {
  const texto = ['JOAO DA SILVA', '', '222222', '', 'CPF 111.111.111-11'].join('\n');
  const pares = extrairNomesEContratosDeListaCrua(texto);
  assert.deepEqual(pares, [{ nome: 'JOAO DA SILVA', numero_contrato: '222222' }]);
});

test('slugNome remove acento e caracteres especiais', () => {
  assert.equal(slugNome('José da Silva Jr.'), 'jose-da-silva-jr');
  assert.equal(slugNome(''), 'cliente');
});
