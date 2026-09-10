// Cobre o parser da planilha de Ativação Chip (colunas bem diferentes da
// planilha de fatura, com nomes que variam: "TEL 1 (TELEFONE" às vezes vem
// sem o parêntese de fechamento na planilha real, por exemplo) -- mesmo
// espírito de parseListaClientes.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { parsePlanilhaChip } from './importLoteChip.js';

function bufferDaPlanilha(linhas) {
  const planilha = XLSX.utils.json_to_sheet(linhas);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, planilha, 'clientes');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('reconhece os cabeçalhos reais da planilha (com variação de acento/maiúscula)', () => {
  const buffer = bufferDaPlanilha([
    {
      OPERADORA: 'Vivo',
      OS: '12345',
      CLIENTE: 'Maria da Silva',
      CPF: '123.456.789-00',
      'NM_CIDADE': 'São Paulo',
      'BKO (RESPONSÁVEL)': 'Fulano',
      VENDEDOR: 'Ciclano',
      'TEL 1 (TELEFONE': '11987654321',
      'TEL 2 (TELEFONE': '',
      'TEL 3 (TELEFONE': '',
    },
  ]);

  const { itens, semDados } = parsePlanilhaChip(buffer);
  assert.equal(semDados.length, 0);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].nome, 'Maria da Silva');
  assert.equal(itens[0].telefone, '5511987654321');
  assert.equal(itens[0].operadora, 'Vivo');
  assert.equal(itens[0].os_numero, '12345');
  assert.equal(itens[0].cpf, '123.456.789-00');
  assert.equal(itens[0].cidade, 'São Paulo');
  assert.equal(itens[0].bko_responsavel, 'Fulano');
  assert.equal(itens[0].vendedor, 'Ciclano');
  assert.equal(itens[0].telefone_2, null);
});

test('traz os 3 telefones quando preenchidos', () => {
  const buffer = bufferDaPlanilha([
    {
      CLIENTE: 'João Pereira',
      'TEL 1': '11999999999',
      'TEL 2': '11888888888',
      'TEL 3': '11777777777',
    },
  ]);

  const { itens } = parsePlanilhaChip(buffer);
  assert.equal(itens[0].telefone, '5511999999999');
  assert.equal(itens[0].telefone_2, '5511888888888');
  assert.equal(itens[0].telefone_3, '5511777777777');
});

test('linha sem nome ou sem telefone válido vai pra semDados, não trava o resto', () => {
  const buffer = bufferDaPlanilha([
    { CLIENTE: '', 'TEL 1': '11999999999' },
    { CLIENTE: 'Sem Telefone', 'TEL 1': '' },
    { CLIENTE: 'Válido', 'TEL 1': '11999999999' },
  ]);

  const { itens, semDados } = parsePlanilhaChip(buffer);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].nome, 'Válido');
  assert.equal(semDados.length, 2);
});
