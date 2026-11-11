import test from 'node:test';
import assert from 'node:assert/strict';
import { avaliarStatus, converterValor, converterVencimento, pagoOuEncerrado, validarFatura, validarCamposAnexo } from './payload.js';
import { escolherCliente, planejarSync } from './cliente.js';
import { avaliarVinculo, ehPdf, osDoCodigo } from './vinculo.js';
import { extrairCamposDoTexto } from './textoCabecalhoPdf.js';

// Fixtures fictícias.
const corpo = (over = {}) => ({
  chave_operacao: 'op-1',
  fatura: {
    id_externo: 123, status_operador: 'EM_TRATATIVA', venda_os: '0012345', cliente_nome: 'Maria  Fictícia da Silva',
    cliente_email: 'Maria@Exemplo.com', cliente_emails: ['maria@exemplo.com', 'outra@exemplo.com'],
    cliente_telefone: '(11) 91234-5678', cliente_telefones: ['11912345678', '11 3333-4444'],
    valor: '150.00', vencimento: '2026-08-10', status_pagamento: 'PENDENTE', encerrado: false, posicao: 1,
    cpf: '000.000.000-00', responsavel: 'fulano', ...over,
  },
});

test('status: lista vazia, ausente e fora da lista bloqueiam; exato permite', () => {
  assert.equal(avaliarStatus('A', []).permitido, false);
  assert.equal(avaliarStatus(undefined, ['A']).permitido, false);
  assert.equal(avaliarStatus('B', ['A']).permitido, false);
  assert.equal(avaliarStatus('a', ['A']).permitido, false); // sem caixa/trim: código exato
  assert.equal(avaliarStatus('A', ['A']).permitido, true);
});

test('validarFatura: whitelist, OS como texto com zeros, vencimento BR, descarta CPF/responsável', () => {
  const r = validarFatura(corpo());
  assert.equal(r.ok, true);
  assert.equal(r.fatura.os_numero, '0012345');
  assert.equal(r.fatura.id_externo, '123');
  assert.equal(r.fatura.vencimento, '10/08/2026');
  assert.equal(r.fatura.valor, 150);
  assert.equal(r.fatura.telefone, '5511912345678');
  assert.equal(r.fatura.email, 'maria@exemplo.com');
  assert.equal(JSON.stringify(r).includes('000.000.000'), false);
  assert.equal(JSON.stringify(r).includes('fulano'), false);
  // alternativos sem repetir o principal (nem com/sem 9º dígito)
  assert.deepEqual(r.fatura.alternativos.emails, ['outra@exemplo.com']);
  assert.equal(r.fatura.alternativos.telefones.length, 1);
});

test('validarFatura: campos inválidos são recusados (só o nome do campo volta)', () => {
  assert.deepEqual(validarFatura(corpo({ vencimento: '10/08/2026' })), { ok: false, campo: 'vencimento' });
  assert.deepEqual(validarFatura(corpo({ vencimento: '2026-02-30' })), { ok: false, campo: 'vencimento' });
  assert.deepEqual(validarFatura(corpo({ valor: '1.234,56' })), { ok: false, campo: 'valor' });
  assert.deepEqual(validarFatura(corpo({ id_externo: '../x' })), { ok: false, campo: 'id_externo' });
  assert.deepEqual(validarFatura(corpo({ cliente_nome: '' })), { ok: false, campo: 'cliente_nome' });
  assert.equal(converterVencimento(null).valor, null);
  assert.equal(converterValor('150,5').valor, 150.5);
});

test('pagoOuEncerrado', () => {
  assert.equal(pagoOuEncerrado({ encerrado: true }), true);
  assert.equal(pagoOuEncerrado({ status_pagamento: 'Pago' }), true);
  assert.equal(pagoOuEncerrado({ status_pagamento: 'Não pago' }), false);
  assert.equal(pagoOuEncerrado({ status_pagamento: 'pendente' }), false);
});

const fatura = validarFatura(corpo()).fatura;
const agora = '2026-11-10T00:00:00.000Z';

test('sync: sem cliente => cria, atribuído ao usuário autenticado', async () => {
  const escolha = await escolherCliente(fatura, async () => []);
  const plano = planejarSync({ usuarioId: 'user-1', fatura, escolha, agora });
  assert.equal(plano.acao, 'criar');
  assert.equal(plano.linha.usuario_id, 'user-1');
  assert.equal(plano.linha.campanha, 'cobranca');
  assert.equal(plano.linha.os_numero, '0012345');
  assert.equal(plano.linha.ennychat_fatura_id, '123');
});

test('sync: busca em ordem (fatura -> OS -> telefone) e ambíguo não cria nem altera', async () => {
  const chamadas = [];
  const escolha = await escolherCliente(fatura, async (c) => { chamadas.push(c); return c === 'os_numero' ? [{ id: 1 }, { id: 2 }] : []; });
  assert.deepEqual(chamadas, ['ennychat_fatura_id', 'os_numero']);
  assert.equal(escolha.tipo, 'ambiguo');
  assert.deepEqual(planejarSync({ usuarioId: 'u', fatura, escolha, agora }), { acao: 'pendente', motivo: 'alvo_ambiguo' });
});

test('sync: achado por OS/telefone com nome diferente => revisão, nada gravado', () => {
  const cliente = { id: 9, nome: 'Outro Nome', telefone: '5511912345678', email: null };
  assert.deepEqual(planejarSync({ usuarioId: 'u', fatura, escolha: { tipo: 'unico', por: 'telefone', cliente }, agora }), { acao: 'pendente', motivo: 'nome_divergente' });
});

test('sync: existente só recebe campo vazio; divergência vira conflito sem sobrescrever', () => {
  const cliente = { id: 9, nome: 'Outro Nome', telefone: '5511912345678', email: 'antigo@x.com', os_numero: null, valor: 99, vencimento: null, ennychat_fatura_id: null };
  const plano = planejarSync({ usuarioId: 'u', fatura, escolha: { tipo: 'unico', por: 'ennychat_fatura_id', cliente: { ...cliente, ennychat_fatura_id: '123' } }, agora });
  assert.equal(plano.acao, 'atualizar');
  assert.deepEqual(plano.conflitos.sort(), ['email', 'nome', 'valor']);
  assert.equal('email' in plano.campos, false);
  assert.equal(plano.campos.os_numero, '0012345');
  assert.equal(plano.camposFatura.vencimento, '10/08/2026');
  assert.equal('valor' in plano.camposFatura, false);
  assert.equal('ennychat_fatura_id' in plano.campos, false); // já estava amarrado
});

test('sync: cliente já amarrado a outra fatura do EnnyChat não é reaproveitado', () => {
  const cliente = { id: 9, nome: 'Maria Ficticia da Silva', telefone: '5511912345678', ennychat_fatura_id: '999' };
  assert.deepEqual(planejarSync({ usuarioId: 'u', fatura, escolha: { tipo: 'unico', cliente }, agora }), { acao: 'pendente', motivo: 'outra_fatura' });
});

test('sync: repetir a mesma fatura (já vinculada) não duplica: ação é atualizar', () => {
  const cliente = { id: 9, nome: 'Maria Fictícia da Silva', telefone: '5511912345678', ennychat_fatura_id: '123', os_numero: '0012345', valor: 150, vencimento: '10/08/2026', email: 'maria@exemplo.com' };
  const plano = planejarSync({ usuarioId: 'u', fatura, escolha: { tipo: 'unico', cliente }, agora });
  assert.equal(plano.acao, 'atualizar');
  assert.deepEqual(plano.conflitos, []);
  assert.deepEqual(Object.keys(plano.camposFatura), []);
});

const alvo = { os_numero: '0012345', nome: 'Maria Fictícia da Silva', vencimento: '10/08/2026' };
const lido = { codigo: '010/0012345', nome: 'MARIA FICTICIA DA SILVA', vencimento: '10/08/2026' };

test('vínculo: OS + nome + vencimento iguais e Pix válido => vinculado (chave de OS do site)', () => {
  const r = avaliarVinculo({ alvo, extraido: lido, pixValido: true });
  assert.equal(r.estado, 'vinculado');
  assert.deepEqual(r.verificacoes, { os: true, nome: true, vencimento: true, pix: true });
  assert.equal(osDoCodigo('010/0012345'), '12345'); // mesma regra do site (chaveOs): depois da barra, sem zeros à esquerda
  assert.equal(osDoCodigo('0012345'), '12345');
  assert.equal(osDoCodigo('013/003498697'), osDoCodigo('3498697')); // prefixo antes da barra não conta
});

test('vínculo: cada divergência/ausência individual => pendente com motivo', () => {
  const caso = (a, e, pix = true) => avaliarVinculo({ alvo: { ...alvo, ...a }, extraido: { ...lido, ...e }, pixValido: pix });
  assert.equal(caso({}, { codigo: '010/0099999' }).motivo, 'os_divergente');
  assert.equal(caso({}, { nome: 'MARIA FICTICIA SILVA' }).motivo, 'nome_divergente'); // sem aproximação
  assert.equal(caso({}, { vencimento: '11/08/2026' }).motivo, 'vencimento_divergente');
  assert.equal(caso({}, {}, false).motivo, 'sem_pix');
  assert.equal(caso({}, { codigo: null }).motivo, 'extracao_falhou');
  assert.equal(caso({ os_numero: null }, {}).motivo, 'campo_ausente');
  assert.equal(caso({ nome: '' }, {}).motivo, 'campo_ausente');
  assert.equal(caso({ vencimento: null }, {}).estado, 'pendente_revisao');
});

test('PDF: só aceita arquivo que começa com %PDF-', () => {
  assert.equal(ehPdf(Buffer.from('%PDF-1.4\n1 0 obj')), true);
  assert.equal(ehPdf(Buffer.from('<html>não sou pdf</html>')), false);
  assert.equal(ehPdf(Buffer.alloc(0)), false);
  assert.equal(ehPdf(Buffer.from('lixo antes %PDF-1.4 depois')), false);
});

test('anexo: campos do multipart', () => {
  assert.equal(validarCamposAnexo({ anexo_id: '55', status_operador: 'A' }).ok, true);
  assert.equal(validarCamposAnexo({ status_operador: 'A' }).ok, false);
  assert.equal(validarCamposAnexo({ anexo_id: '55', status_operador: '' }).ok, false);
});

test('texto do cabeçalho: lê Código, Vencimento e nome por rótulo', () => {
  const c = extrairCamposDoTexto(['Cliente: MARIA FICTICIA DA SILVA', 'Código: 010/0012345', 'Vencimento: 10/08/2026']);
  assert.equal(c.codigo, '010/0012345');
  assert.equal(c.vencimento, '10/08/2026');
  assert.equal(c.nome, 'MARIA FICTICIA DA SILVA');
});
