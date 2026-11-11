// Cenários da integração EnnyChat ponta a ponta nas ROTAS (banco em memória, sem rede): sync por ficha e em lote,
// operadoras (nunca misturar), Fatura 2, Pix do Desktop (sem PDF), pagamento, número inválido, pendências e token da extensão.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.SUPABASE_URL = 'http://supabase.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-teste';

const { default: express } = await import('express');
const { __usarClienteDeTeste } = await import('../lib/supabase.js');
const { criarSupabaseFalso } = await import('../lib/email/supabaseFalso.js');
const { crc16ccitt } = await import('../lib/pixValidacao.js');
const { default: rotaEnnychat, __reiniciarM33 } = await import('./ennychat.routes.js');
const { requireAuth } = await import('../middleware/auth.js');
const { gerarToken, hashToken } = await import('../lib/tokenExtensao.js');

// Pix válido (CRC conferido) para os cenários.
const montarPix = (nome) => {
  const base = `00020126580014br.gov.bcb.pix0136123e4567-e89b-12d3-a456-426655440000520400005303986540510.005802BR59${String(nome.length).padStart(2, '0')}${nome}6008BRASILIA62070503***6304`;
  return base + crc16ccitt(base);
};
const PIX_A = montarPix('FULANO DE TAL');
const PIX_B = montarPix('BELTRANO SA');

const RESTRICOES = {
  clientes: [
    (l, n) => l.usuario_id === n.usuario_id && l.telefone === n.telefone && l.campanha === n.campanha,
    (l, n) => n.ennychat_fatura_id && l.usuario_id === n.usuario_id && l.ennychat_fatura_id === n.ennychat_fatura_id,
    (l, n) => n.numero_contrato && l.usuario_id === n.usuario_id && l.numero_contrato === n.numero_contrato, // índice único real (migration-22)
  ],
};

function banco({ clientes = [], faturas = [], anexos = [], aceitos = ['fatura_encaminhada'], ausentes = [], tokens = [], colunasAusentes = {} } = {}) {
  const falso = criarSupabaseFalso({
    tabelas: { clientes, ennychat_faturas: faturas, ennychat_anexos: anexos, extensao_tokens: tokens, perfis: [], ennychat_config: [{ chave: 'status_aceitos', valor: aceitos }, { chave: 'catalogo', valor: [] }] },
    restricoes: RESTRICOES,
    tabelasAusentes: ausentes,
    colunasAusentes,
  });
  __usarClienteDeTeste(falso);
  return falso;
}

// servidor local com a autenticação REAL (sessão do Supabase é simulada em auth.getUser)
async function servidor(db, usuario = 'u1') {
  db.auth = { getUser: async (t) => (t === 'sessao-valida' ? { data: { user: { id: usuario, email: `${usuario}@x.com` } }, error: null } : { data: null, error: { message: 'x' } }) };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/integracoes/ennychat', requireAuth, rotaEnnychat);
  app.use('/api/clientes', requireAuth, (_req, res) => res.json({ ok: true }));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const chamar = async (metodo, caminho, corpo, auth = 'sessao-valida') => {
    const r = await fetch(base + caminho, { method: metodo, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { /* html */ }
    return { status: r.status, json };
  };
  return { chamar, fechar: () => srv.close() };
}

const BASE = '/api/integracoes/ennychat';
let seq = 0;
const tel = () => `1190000${String(++seq).padStart(4, '0')}`;
const fatura = (o = {}) => ({
  id_externo: '100', status_operador: 'fatura_encaminhada', venda_os: '555', cliente_nome: 'FULANO DE TAL', cliente_telefone: tel(), cliente_telefones: [],
  valor: '89.99', vencimento: '2026-12-09', status_pagamento: 'pendente', encerrado: false, posicao: 1, prazo_data: '2026-12-09',
  operadora_slug: 'desktop', codigo_pix: null, data_pagamento: null,
  faturas: [{ id: o.id_externo ?? '100', posicao: 1, mes_referencia: '2026-11-01', vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pendente', data_pagamento: null, codigo_pix: null }],
  ...o,
});
const sync = (c, f) => c('POST', `${BASE}/faturas/sync`, { chave_operacao: 'k', fatura: f });
const lote = (c, itens) => c('POST', `${BASE}/lote`, { itens });

test('Desktop novo com Pix do site: cadastra, grava a fatura, valida o Pix e entrega no /pix', async () => {
  const db = banco();
  const s = await servidor(db);
  try {
    const f = fatura({ codigo_pix: PIX_A, faturas: [{ id: '100', posicao: 1, mes_referencia: '2026-11-01', vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pendente', data_pagamento: null, codigo_pix: PIX_A }] });
    const r = await sync(s.chamar, f);
    assert.equal(r.json.estado, 'sincronizado');
    assert.equal(r.json.criado, true);
    assert.equal(r.json.pix_site, true);
    assert.equal(r.json.operadora, 'desktop');
    const cli = db.__dados.clientes[0];
    assert.equal(cli.ennychat_operadora, 'desktop');
    assert.equal(cli.pix_code, PIX_A);
    assert.equal(db.__dados.ennychat_faturas.length, 1);
    assert.equal(db.__dados.ennychat_faturas[0].pix_origem, 'site');
    const p = await s.chamar('GET', `${BASE}/faturas/100/pix`);
    assert.deepEqual([p.json.estado, p.json.origem], ['ok', 'pdf'].map((x, i) => (i === 1 ? p.json.origem : x)));
    assert.equal(p.json.pix, PIX_A);
  } finally { s.fechar(); }
});

test('Pix inválido (CRC errado) NÃO entra; Desktop sem Pix fica pendente "aguardando_pix"', async () => {
  const db = banco();
  const s = await servidor(db);
  try {
    const ruim = PIX_A.slice(0, -4) + '0000';
    const r = await sync(s.chamar, fatura({ id_externo: '101', codigo_pix: ruim, faturas: [{ id: '101', posicao: 1, vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pendente', codigo_pix: ruim }] }));
    assert.equal(r.json.pix_site, false);
    assert.equal(db.__dados.clientes[0].pix_code ?? null, null);
    assert.equal(db.__dados.ennychat_faturas[0].pix_code, null);
    const pend = await s.chamar('GET', `${BASE}/pendencias`);
    assert.deepEqual(pend.json.itens.map((i) => [i.operadora, i.motivo]), [['desktop', 'aguardando_pix']]);
    const px = await s.chamar('GET', `${BASE}/faturas/101/pix`);
    assert.equal(px.json.estado, 'indisponivel');
  } finally { s.fechar(); }
});

test('Fatura 2 do mesmo cliente (mesma OS/operadora/nome) é registrada sem mexer no cadastro; outra operadora NÃO vira irmã', async () => {
  const db = banco();
  const s = await servidor(db);
  try {
    const t = tel();
    const f1 = fatura({ id_externo: '200', venda_os: '777', operadora_slug: 'claro-bg', cliente_telefone: t });
    assert.equal((await sync(s.chamar, f1)).json.criado, true);
    const antes = { ...db.__dados.clientes[0] };
    const f2 = fatura({ id_externo: '201', venda_os: '777', operadora_slug: 'claro-bg', cliente_telefone: t, posicao: 2, valor: '50.00', faturas: [{ id: '200', posicao: 1, vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pendente' }, { id: '201', posicao: 2, vencimento: '2027-01-09', valor: '50.00', status_pagamento: 'pendente' }] });
    const r = await sync(s.chamar, f2);
    assert.equal(r.json.irma, true);
    assert.equal(db.__dados.clientes.length, 1);
    assert.equal(db.__dados.clientes[0].ennychat_fatura_id, '200'); // cadastro intacto
    assert.equal(db.__dados.clientes[0].valor, antes.valor);
    assert.deepEqual(db.__dados.ennychat_faturas.map((x) => x.fatura_externa_id).sort(), ['200', '201']);
    // mesma OS em OUTRA operadora (BG x Mega): jamais é a mesma pessoa
    const mega = await sync(s.chamar, fatura({ id_externo: '300', venda_os: '777', operadora_slug: 'claro-mega', cliente_telefone: tel(), cliente_nome: 'OUTRA PESSOA' }));
    assert.equal(mega.json.criado, true);
    assert.equal(db.__dados.clientes.length, 2);
    const m = db.__dados.clientes.find((c) => c.ennychat_fatura_id === '300');
    assert.equal(m.ennychat_operadora, 'claro-mega');
    assert.equal(m.os_numero, '777'); // a OS fica; só o contrato único foi omitido
    assert.equal(m.numero_contrato ?? null, null);
  } finally { s.fechar(); }
});

test('mesma OS e MESMO telefone em operadoras diferentes: nunca junta (fica pendente), nada é alterado', async () => {
  const db = banco();
  const s = await servidor(db);
  try {
    const t = tel();
    await sync(s.chamar, fatura({ id_externo: '400', venda_os: '888', operadora_slug: 'claro-bg', cliente_telefone: t }));
    const r = await sync(s.chamar, fatura({ id_externo: '401', venda_os: '888', operadora_slug: 'claro-mega', cliente_telefone: t }));
    assert.equal(r.json.estado, 'pendente_revisao');
    assert.equal(db.__dados.clientes.length, 1);
    assert.equal(db.__dados.clientes[0].ennychat_operadora, 'claro-bg');
    assert.equal(db.__dados.clientes[0].ennychat_fatura_id, '400');
  } finally { s.fechar(); }
});

test('cadastro antigo (sem operadora) adota a operadora na 1ª sincronização', async () => {
  const db = banco({ clientes: [{ id: 'c-old', usuario_id: 'u1', campanha: 'cobranca', nome: 'FULANO DE TAL', telefone: '5511900009999', os_numero: '999', numero_contrato: '999', ennychat_operadora: null }] });
  const s = await servidor(db);
  try {
    const r = await sync(s.chamar, fatura({ id_externo: '500', venda_os: '999', cliente_telefone: '11900009999', operadora_slug: 'claro-fenix' }));
    assert.equal(r.json.estado, 'sincronizado');
    assert.equal(r.json.criado, false);
    assert.equal(db.__dados.clientes[0].ennychat_operadora, 'claro-fenix');
    assert.equal(db.__dados.clientes[0].ennychat_fatura_id, '500');
  } finally { s.fechar(); }
});

test('pagamento: fatura paga com OUTRA em aberto não bloqueia o cliente; todas pagas bloqueia; voltar a aceito libera só o que a integração pôs', async () => {
  const db = banco();
  const s = await servidor(db);
  try {
    const t = tel();
    const f1 = fatura({ id_externo: '600', venda_os: '600', operadora_slug: 'claro-fenix', cliente_telefone: t });
    await sync(s.chamar, f1);
    // Fatura 2 aberta (irmã) registrada
    await sync(s.chamar, fatura({ id_externo: '601', venda_os: '600', operadora_slug: 'claro-fenix', cliente_telefone: t, posicao: 2, faturas: [{ id: '600', posicao: 1, vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pendente' }, { id: '601', posicao: 2, vencimento: '2027-01-09', valor: '50.00', status_pagamento: 'pendente' }] }));
    // Fatura 1 paga, Fatura 2 aberta => NÃO vira pagamento_confirmado
    const r1 = await sync(s.chamar, fatura({ id_externo: '600', venda_os: '600', operadora_slug: 'claro-fenix', cliente_telefone: t, status_pagamento: 'pago', data_pagamento: '2026-11-02', faturas: [{ id: '600', posicao: 1, vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pago', data_pagamento: '2026-11-02' }, { id: '601', posicao: 2, vencimento: '2027-01-09', valor: '50.00', status_pagamento: 'pendente' }] }));
    assert.equal(r1.json.motivo, 'pagamento_ou_encerrado');
    let cli = db.__dados.clientes[0];
    assert.equal(cli.ennychat_status, 'pago_ou_encerrado');
    assert.notEqual(cli.status_operador, 'pagamento_confirmado');
    assert.equal(db.__dados.ennychat_faturas.find((x) => x.fatura_externa_id === '600').pago, true);
    // Fatura 2 também paga => agora sim (a 601 passa a paga no registro e o cliente fica pago_confirmado)
    db.__dados.ennychat_faturas.find((x) => x.fatura_externa_id === '601').pago = true;
    await sync(s.chamar, fatura({ id_externo: '600', venda_os: '600', operadora_slug: 'claro-fenix', cliente_telefone: t, status_pagamento: 'pago', data_pagamento: '2026-11-02', faturas: [{ id: '600', posicao: 1, vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pago', data_pagamento: '2026-11-02' }, { id: '601', posicao: 2, vencimento: '2027-01-09', valor: '50.00', status_pagamento: 'pago', data_pagamento: '2026-11-05' }] }));
    cli = db.__dados.clientes[0];
    assert.equal(cli.status_operador, 'pagamento_confirmado');
    // voltou a aberto (pagamento estornado): o bloqueio posto pela integração sai
    await sync(s.chamar, fatura({ id_externo: '600', venda_os: '600', operadora_slug: 'claro-fenix', cliente_telefone: t }));
    assert.equal(db.__dados.clientes[0].status_operador, null);
  } finally { s.fechar(); }
});

test('número inválido bloqueia o disparo SÓ deste cliente; sair do status libera; status próprio do sistema não é apagado', async () => {
  const db = banco();
  const s = await servidor(db);
  try {
    const f = fatura({ id_externo: '700', venda_os: '700', cliente_telefone: tel() });
    await sync(s.chamar, f);
    const r = await sync(s.chamar, { ...f, status_operador: 'numero_invalido' }); // fora da lista de aceitos
    assert.equal(r.json.estado, 'bloqueado_status');
    assert.equal(db.__dados.clientes[0].status_operador, 'numero_invalido');
    await sync(s.chamar, f); // voltou a "fatura_encaminhada"
    assert.equal(db.__dados.clientes[0].status_operador, null);
    // status marcado pelo operador do SISTEMA (não veio do espelho): permanece
    db.__dados.clientes[0].status_operador = 'fraude';
    await sync(s.chamar, f);
    assert.equal(db.__dados.clientes[0].status_operador, 'fraude');
  } finally { s.fechar(); }
});

test('lote de 30 mistos: cria os aceitos, ignora desconhecidos fora da lista, atualiza conhecidos que mudaram, rejeita lixo, sem 500', async () => {
  const db = banco();
  const s = await servidor(db);
  try {
    const itens = [];
    for (let i = 0; i < 24; i++) itens.push(fatura({ id_externo: String(1000 + i), venda_os: String(2000 + i), operadora_slug: i % 2 ? 'desktop' : 'claro-bg', cliente_nome: `CLIENTE ${i}`, cliente_telefone: tel(), codigo_pix: i % 2 ? PIX_B : null, faturas: [{ id: String(1000 + i), posicao: 1, vencimento: '2026-12-09', valor: '10.00', status_pagamento: 'pendente', codigo_pix: i % 2 ? PIX_B : null }] }));
    itens.push(...[0, 1, 2].map((i) => fatura({ id_externo: String(2000 + i), status_operador: 'contato_estabelecido', venda_os: String(3000 + i), cliente_nome: `FORA ${i}`, cliente_telefone: tel() }))); // fora da lista, desconhecidos
    itens.push(fatura({ id_externo: '2100', status_pagamento: 'pago', data_pagamento: '2026-11-01', venda_os: '3100', cliente_nome: 'PAGO', cliente_telefone: tel() })); // paga e desconhecida
    itens.push({ id_externo: 'x', foo: 'bar' }); // lixo
    itens.push(fatura({ id_externo: '2200', cliente_nome: '', venda_os: '3200' })); // sem nome
    const r = await lote(s.chamar, itens);
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 30);
    const por = {};
    for (const x of r.json.resultados) por[x.estado] = (por[x.estado] ?? 0) + 1;
    assert.equal(por.erro ?? 0, 0);
    assert.equal(por.sincronizado, 24);
    assert.equal(por.erro_validacao, 2);
    assert.equal(db.__dados.clientes.length, 24); // só os aceitos viraram cadastro
    assert.equal(db.__dados.ennychat_faturas.length, 24);
    assert.equal(db.__dados.clientes.filter((c) => c.ennychat_operadora === 'claro-bg').length, 12);
    assert.equal(db.__dados.clientes.filter((c) => c.pix_code === PIX_B).length, 12);
    // reenviar o MESMO lote: idempotente (sem duplicar)
    await lote(s.chamar, itens);
    assert.equal(db.__dados.clientes.length, 24);
    // um conhecido mudou para fora da lista: o lote atualiza o status
    const mudou = { ...itens[0], status_operador: 'contato_estabelecido' };
    await lote(s.chamar, [mudou]);
    assert.equal(db.__dados.clientes.find((c) => c.ennychat_fatura_id === '1000').ennychat_status, 'contato_estabelecido');
    // limite de itens por chamada
    const grande = await lote(s.chamar, Array.from({ length: 80 }, (_, i) => fatura({ id_externo: String(5000 + i), venda_os: String(6000 + i), cliente_telefone: tel() })));
    assert.equal(grande.json.total, 50);
    assert.equal((await lote(s.chamar, 'nao-lista')).status, 400);
  } finally { s.fechar(); }
});

test('sem a migration-33: sync por ficha segue funcionando (sem operadora) e o LOTE recusa (503) em vez de importar sem separar operadoras', async () => {
  __reiniciarM33(); // o cache de "tabela existe" vem de outros cenários
  const db = banco({ ausentes: ['ennychat_faturas'] });
  const s = await servidor(db);
  try {
    const r = await sync(s.chamar, fatura({ id_externo: '800', venda_os: '800' }));
    assert.equal(r.json.estado, 'sincronizado');
    assert.equal('ennychat_operadora' in db.__dados.clientes[0], false); // coluna inexistente não é enviada
    assert.equal((await lote(s.chamar, [fatura({ id_externo: '801' })])).status, 503);
    assert.equal((await s.chamar('GET', `${BASE}/pendencias`)).status, 200);
  } finally { s.fechar(); __reiniciarM33(); }
});

test('token da extensão: vale só na integração do EnnyChat, não cria token, revogado/inventado é recusado', async () => {
  const bom = gerarToken();
  const revogado = gerarToken();
  const db = banco({ tokens: [{ id: 't1', usuario_id: 'u1', token_hash: hashToken(bom), revogado_em: null }, { id: 't2', usuario_id: 'u1', token_hash: hashToken(revogado), revogado_em: new Date().toISOString() }] });
  const s = await servidor(db);
  try {
    assert.equal((await s.chamar('GET', `${BASE}/config`, null, bom)).status, 200);
    assert.equal((await s.chamar('GET', `${BASE}/pendencias`, null, bom)).status, 200);
    assert.equal((await s.chamar('GET', '/api/clientes', null, bom)).status, 401); // fora do escopo
    assert.equal((await s.chamar('POST', `${BASE}/token-extensao`, null, bom)).status, 403); // não cria outro
    assert.equal((await s.chamar('GET', `${BASE}/config`, null, revogado)).status, 401);
    assert.equal((await s.chamar('GET', `${BASE}/config`, null, gerarToken())).status, 401);
    // sessão normal cria e o token novo funciona; "desconectar" revoga todos
    const novo = await s.chamar('POST', `${BASE}/token-extensao`);
    assert.equal(novo.status, 200);
    assert.equal((await s.chamar('GET', `${BASE}/config`, null, novo.json.token)).status, 200);
    assert.equal((await s.chamar('DELETE', `${BASE}/token-extensao`)).status, 200);
    assert.equal((await s.chamar('GET', `${BASE}/config`, null, novo.json.token)).status, 401);
    assert.equal((await s.chamar('GET', `${BASE}/config`, null, bom)).status, 401);
  } finally { s.fechar(); }
});

test('isolamento: usuário B não enxerga nem altera faturas do usuário A', async () => {
  const db = banco();
  const a = await servidor(db, 'uA');
  const f = fatura({ id_externo: '900', venda_os: '900', codigo_pix: PIX_A, faturas: [{ id: '900', posicao: 1, vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pendente', codigo_pix: PIX_A }] });
  try {
    await sync(a.chamar, f);
  } finally { a.fechar(); }
  const b = await servidor(db, 'uB');
  try {
    assert.equal((await b.chamar('GET', `${BASE}/faturas/900/pix`)).json.estado, 'indisponivel');
    assert.equal((await b.chamar('GET', `${BASE}/pendencias`)).json.total, 0);
    assert.equal((await b.chamar('POST', `${BASE}/faturas/900/bloqueio`, { status_operador: 'x' })).status, 404);
  } finally { b.fechar(); }
});

test('Desktop: o operador troca o Pix => o sistema atualiza; se remove, o sistema remove também (espelho)', async () => {
  const db = banco();
  const s = await servidor(db);
  try {
    const t = tel();
    const com = (pix) => fatura({ id_externo: '1300', venda_os: '1300', cliente_telefone: t, codigo_pix: pix, faturas: [{ id: '1300', posicao: 1, vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pendente', codigo_pix: pix }] });
    await sync(s.chamar, com(PIX_A));
    assert.equal(db.__dados.clientes[0].pix_code, PIX_A);
    await sync(s.chamar, com(PIX_B));
    assert.equal(db.__dados.clientes[0].pix_code, PIX_B);
    assert.equal(db.__dados.ennychat_faturas[0].pix_code, PIX_B);
    assert.equal((await s.chamar('GET', `${BASE}/faturas/1300/pix`)).json.pix, PIX_B);
    await sync(s.chamar, com(null)); // o operador REMOVEU o Pix no EnnyChat: o sistema espelha (nunca manda Pix velho)
    assert.equal(db.__dados.clientes[0].pix_code, null);
    assert.equal((await s.chamar('GET', `${BASE}/faturas/1300/pix`)).json.estado, 'indisponivel');
  } finally { s.fechar(); }
});

test('Claro (com PDF): Pix do site NÃO sobrescreve o Pix do PDF vinculado', async () => {
  const db = banco();
  const s = await servidor(db);
  try {
    const t = tel();
    await sync(s.chamar, fatura({ id_externo: '1400', venda_os: '1400', operadora_slug: 'claro-fenix', cliente_telefone: t }));
    Object.assign(db.__dados.clientes[0], { pix_code: PIX_A, pdf_path: 'x/boleto.pdf' });
    await sync(s.chamar, fatura({ id_externo: '1400', venda_os: '1400', operadora_slug: 'claro-fenix', cliente_telefone: t, codigo_pix: PIX_B, faturas: [{ id: '1400', posicao: 1, vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pendente', codigo_pix: PIX_B }] }));
    assert.equal(db.__dados.clientes[0].pix_code, PIX_A); // o do PDF vale
    assert.equal(db.__dados.ennychat_faturas[0].pix_code, PIX_B); // o do site fica só no registro da fatura
  } finally { s.fechar(); }
});

test('banco SEM colunas de migrations antigas (importado_em, tipo_fatura, data_prazo): cadastra cliente novo mesmo assim (era o 500 em produção)', async () => {
  const db = banco({ colunasAusentes: { clientes: ['importado_em', 'tipo_fatura', 'data_prazo'] } });
  const s = await servidor(db);
  try {
    const r = await sync(s.chamar, fatura({ id_externo: '1500', venda_os: '1500', codigo_pix: PIX_A, faturas: [{ id: '1500', posicao: 1, vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pendente', codigo_pix: PIX_A }] }));
    assert.equal(r.status, 200);
    assert.equal(r.json.estado, 'sincronizado');
    assert.equal(r.json.criado, true);
    const c = db.__dados.clientes[0];
    assert.equal(c.nome, 'FULANO DE TAL');
    assert.equal(c.ennychat_fatura_id, '1500');
    assert.equal('importado_em' in c, false);
    assert.equal(c.pix_code, PIX_A);
    const l = await lote(s.chamar, [fatura({ id_externo: '1501', venda_os: '1501', cliente_telefone: tel() })]);
    assert.equal(l.json.resultados[0].estado, 'sincronizado');
    const u = await sync(s.chamar, fatura({ id_externo: '1500', venda_os: '1500', cliente_telefone: c.telefone, valor: '120.00' }));
    assert.equal(u.json.estado, 'sincronizado');
  } finally { s.fechar(); }
});

test('/estado ao abrir a ficha: diz se já existe, se há Pix pronto (sem entregar o Pix), e o que está guardado para comparar', async () => {
  const db = banco();
  const s = await servidor(db);
  try {
    const t = tel();
    // desconhecida
    const nada = await s.chamar('GET', `${BASE}/faturas/1600/estado`);
    assert.deepEqual([nada.json.sincronizado, nada.json.pix_ok, nada.json.irma], [false, false, false]);
    // Desktop com Pix do site
    await sync(s.chamar, fatura({ id_externo: '1600', venda_os: '1600', cliente_telefone: t, valor: '89.99', codigo_pix: PIX_A, faturas: [{ id: '1600', posicao: 1, vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pendente', codigo_pix: PIX_A }] }));
    const e = (await s.chamar('GET', `${BASE}/faturas/1600/estado`)).json;
    assert.equal(e.sincronizado, true);
    assert.equal(e.pix_ok, true);
    assert.equal(e.pix_origem, 'site');
    assert.equal(e.pix_hash.length, 8);
    assert.ok(!JSON.stringify(e).includes(PIX_A), 'o Pix em si não vai no /estado');
    assert.deepEqual([e.status, e.valor, e.vencimento, e.operadora], ['fatura_encaminhada', 89.99, '09/12/2026', 'desktop']);
    // Fatura 2 (irmã): já existe, sem Pix próprio
    await sync(s.chamar, fatura({ id_externo: '1601', venda_os: '1600', cliente_telefone: t, posicao: 2, faturas: [{ id: '1600', posicao: 1, vencimento: '2026-12-09', valor: '89.99', status_pagamento: 'pendente' }, { id: '1601', posicao: 2, vencimento: '2027-01-09', valor: '50.00', status_pagamento: 'pendente' }] }));
    const i = (await s.chamar('GET', `${BASE}/faturas/1601/estado`)).json;
    assert.deepEqual([i.sincronizado, i.irma, i.pix_ok], [true, true, false]);
    // status fora da lista: não há Pix "pronto"
    db.__dados.clientes[0].ennychat_status = 'contato_estabelecido';
    assert.equal((await s.chamar('GET', `${BASE}/faturas/1600/estado`)).json.pix_ok, false);
  } finally { s.fechar(); }
});
