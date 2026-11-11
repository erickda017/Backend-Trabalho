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
  assert.deepEqual(planejarSync({ usuarioId: 'u', fatura, escolha: { tipo: 'unico', por: 'telefone', cliente }, agora }), { acao: 'pendente', motivo: 'nome_divergente_cadastro' });
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
  const cliente = { id: 9, nome: 'Maria Fictícia da Silva', telefone: '5511912345678', ennychat_fatura_id: '123', os_numero: '0012345', numero_contrato: '0012345', tipo_fatura: 'FPD', valor: 150, vencimento: '10/08/2026', email: 'maria@exemplo.com' };
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

test('campos que o site recebia da lista crua: contrato (= OS), tipo da fatura pela posição e prazo', () => {
  const r = validarFatura(corpo({ posicao: 2, prazo_data: '2026-12-09' }));
  assert.equal(r.fatura.tipo_fatura, 'SPD');
  assert.equal(r.fatura.data_prazo, '2026-12-09');
  assert.equal(validarFatura(corpo({ posicao: 1 })).fatura.tipo_fatura, 'FPD');
  assert.equal(validarFatura(corpo({ posicao: 3 })).fatura.tipo_fatura, null);
  assert.equal(validarFatura(corpo({ prazo_data: '2026-02-31' })).fatura.data_prazo, null); // data inexistente não entra
  const plano = planejarSync({ usuarioId: 'u', fatura: r.fatura, escolha: { tipo: 'nenhum' }, agora: '2026-11-10T00:00:00.000Z' });
  assert.equal(plano.linha.numero_contrato, '0012345'); // a OS também é o contrato (casamento de Pix/pagos e safras)
  assert.equal(plano.linha.tipo_fatura, 'SPD');
  assert.equal(plano.linha.data_prazo, '2026-12-09');
  assert.equal(plano.linha.importado_em, '2026-11-10T00:00:00.000Z');
  // cliente que veio da lista crua (contrato preenchido, sem os_numero): preenche o que falta, sem sobrescrever
  const existente = { id: 9, nome: 'Maria Fictícia da Silva', telefone: '5511912345678', ennychat_fatura_id: '123', os_numero: null, numero_contrato: null, tipo_fatura: null, data_prazo: null, valor: 150, vencimento: '10/08/2026', email: 'maria@exemplo.com' };
  const p2 = planejarSync({ usuarioId: 'u', fatura: r.fatura, escolha: { tipo: 'unico', por: 'ennychat_fatura_id', cliente: existente }, agora });
  assert.equal(p2.camposFatura.numero_contrato, '0012345');
  assert.equal(p2.camposFatura.tipo_fatura, 'SPD');
  assert.equal(p2.camposFatura.data_prazo, '2026-12-09');
  assert.equal(validarCamposAnexo({ anexo_id: '1', status_operador: 'A', origem: 'upload' }).origem, 'upload');
  assert.equal(validarCamposAnexo({ anexo_id: '1', status_operador: 'A' }).origem, 'download');
});


test('sync: contrato é buscado também pela chave só-dígitos da OS (lista crua sem zeros)', async () => {
  const f = { ...fatura, os_numero: '0012345' };
  const vistos = [];
  await escolherCliente(f, async (c, v) => { vistos.push([c, v]); return []; });
  assert.deepEqual(vistos.find(([c]) => c === 'numero_contrato')[1], ['0012345', '12345']);
});

// ---- operadora, faturas da ficha e Pix do site ----
import { ehFaturaIrma } from './cliente.js';

test('validarFatura: operadora, todas as faturas da ficha e Pix bruto (lista branca)', () => {
  const pix = '00020126580014br.gov.bcb.pix0136123e4567-e89b-12d3-a456-426655440000520400005303986540510.005802BR5913FULANO DE TAL6008BRASILIA62070503***6304ABCD';
  const v = validarFatura(corpo({
    operadora_slug: 'Claro-Fenix', codigo_pix: pix, data_pagamento: null,
    faturas: [
      { id: 24120, posicao: 1, mes_referencia: '2026-09-01', vencimento: '2026-10-15', valor: '69.93', status_pagamento: 'pendente', data_pagamento: null, codigo_pix: '', cpf: '123' },
      { id: 28379, posicao: 2, mes_referencia: '2026-09-01', vencimento: '2026-11-15', valor: null, status_pagamento: 'pago', data_pagamento: '2026-11-02', codigo_pix: pix },
      { id: '<script>', posicao: 3 },
    ],
  }));
  assert.equal(v.ok, true);
  assert.equal(v.fatura.operadora, 'claro-fenix');
  assert.equal(v.fatura.codigo_pix, pix);
  assert.equal(v.fatura.faturas.length, 2); // id inválido descartado
  assert.deepEqual(Object.keys(v.fatura.faturas[0]).sort(), ['codigo_pix', 'data_pagamento', 'id', 'mes_referencia', 'posicao', 'status_pagamento', 'valor', 'vencimento']); // sem CPF
  assert.equal(v.fatura.faturas[0].codigo_pix, null);
  assert.equal(v.fatura.faturas[1].data_pagamento, '2026-11-02');
  assert.equal(validarFatura(corpo({ operadora_slug: 'DROP TABLE' })).fatura.operadora, null);
});

test('operadora: nunca mistura (BG x Mega) e cadastro antigo adota na 1ª sincronização', () => {
  const f = { ...fatura, operadora: 'claro-bg' };
  const igual = { id: 'c1', nome: f.nome, ennychat_fatura_id: f.id_externo, ennychat_operadora: 'claro-bg', telefone: f.telefone };
  const outra = { ...igual, ennychat_operadora: 'claro-mega' };
  const antigo = { ...igual, ennychat_operadora: null };
  const plan = (c) => planejarSync({ usuarioId: 'u', fatura: f, escolha: { tipo: 'unico', por: 'ennychat_fatura_id', cliente: c }, agora });
  assert.equal(plan(igual).acao, 'atualizar');
  assert.deepEqual(plan(outra), { acao: 'pendente', motivo: 'operadora_divergente' });
  assert.equal(plan(antigo).campos.ennychat_operadora, 'claro-bg');
  // criação grava a operadora
  const criado = planejarSync({ usuarioId: 'u', fatura: f, escolha: { tipo: 'nenhum' }, agora });
  assert.equal(criado.linha.ennychat_operadora, 'claro-bg');
});

test('escolherCliente: a busca por OS/contrato/telefone recebe a operadora (o banco exclui as outras)', async () => {
  const vistos = [];
  await escolherCliente({ ...fatura, operadora: 'desktop' }, async (c, v, op) => { vistos.push([c, op]); return []; });
  assert.ok(vistos.length >= 2 && vistos.every(([, op]) => op === 'desktop'));
});

test('fatura irmã (Fatura 2 do mesmo cliente): só com mesma OS, mesma operadora conhecida e mesmo nome', () => {
  const c = { id: 'c1', nome: fatura.nome, os_numero: '0012345', ennychat_fatura_id: '24120', ennychat_operadora: 'claro-fenix' };
  const f2 = { ...fatura, id_externo: '28379', os_numero: '12345', operadora: 'claro-fenix' };
  const escolha = { tipo: 'unico', por: 'os_numero', cliente: c };
  assert.equal(ehFaturaIrma({ escolha, fatura: f2 }), true);
  assert.equal(ehFaturaIrma({ escolha, fatura: { ...f2, operadora: 'claro-bg' } }), false); // outra operadora
  assert.equal(ehFaturaIrma({ escolha, fatura: { ...f2, operadora: null } }), false); // operadora desconhecida: não arrisca
  assert.equal(ehFaturaIrma({ escolha: { ...escolha, cliente: { ...c, ennychat_operadora: null } }, fatura: f2 }), false);
  assert.equal(ehFaturaIrma({ escolha, fatura: { ...f2, nome: 'OUTRA PESSOA' } }), false);
  assert.equal(ehFaturaIrma({ escolha, fatura: { ...f2, os_numero: '999' } }), false);
  assert.equal(ehFaturaIrma({ escolha, fatura: { ...f2, id_externo: '24120' } }), false); // é a própria fatura
  assert.equal(ehFaturaIrma({ escolha: { ...escolha, por: 'telefone' }, fatura: f2 }), false); // telefone compartilhado não vale
});

test('status espelho: volta a status aceito remove SÓ o bloqueio posto pela integração', () => {
  const plan = (c) => planejarSync({ usuarioId: 'u', fatura, escolha: { tipo: 'unico', por: 'ennychat_fatura_id', cliente: c }, agora });
  const base = { id: 'c1', nome: fatura.nome, ennychat_fatura_id: fatura.id_externo, telefone: fatura.telefone };
  // bloqueio posto pela integração (ennychat_status = espelho): sai
  const a = plan({ ...base, ennychat_status: 'numero_invalido', status_operador: 'numero_invalido' }).campos;
  assert.equal(a.status_operador, null);
  const b = plan({ ...base, ennychat_status: 'pago_ou_encerrado', status_operador: 'pagamento_confirmado' }).campos;
  assert.equal(b.status_operador, null);
  // o operador do SISTEMA marcou outro status por conta própria: não mexe
  const c = plan({ ...base, ennychat_status: 'fatura_encaminhada', status_operador: 'numero_invalido' }).campos;
  assert.equal('status_operador' in c, false);
});

// ---- token da extensão ----
import { ehTokenExtensao, gerarToken, hashToken } from '../tokenExtensao.js';

test('token da extensão: formato, hash estável e recusa de lixo', () => {
  const t = gerarToken();
  assert.ok(t.startsWith('vxe_') && ehTokenExtensao(t));
  assert.notEqual(gerarToken(), t);
  assert.equal(hashToken(t), hashToken(t));
  assert.equal(hashToken(t).length, 64);
  assert.ok(!hashToken(t).includes(t)); // o hash não contém o token
  for (const x of [null, '', 'vxe_', 'Bearer abc', 'eyJhbGciOi.jwt.assim', 'vxe_' + 'a'.repeat(100)]) assert.equal(ehTokenExtensao(x), false);
});
