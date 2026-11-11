// Aceite da aba Disparo / E-mail com PROVEDOR SIMULADO e banco em memória: nenhum e-mail real é enviado.
// Cobre: lote 1 e-mail por fatura, revalidação antes do envio, status excluído com lote pendente, tentativas x aceitos,
// resultado incerto com reconciliação, saldo diário insuficiente, dois operadores simultâneos, duplo clique,
// nome da empresa fixado no lote, cancelamento e webhook (entrega, devolução, evento antigo).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.SUPABASE_URL = 'http://supabase.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-teste';
process.env.BREVO_LIMITE_DIARIO = '5';
process.env.EMAIL_ATRASO_MS = '1';
process.env.BREVO_WEBHOOK_TOKEN = 'segredo-do-webhook';

const { default: express } = await import('express');
const { __usarClienteDeTeste } = await import('../lib/supabase.js');
const { armazenamento } = await import('../lib/armazenamento.js');
const { criarSupabaseFalso } = await import('../lib/email/supabaseFalso.js');
const { hojeBrt } = await import('../lib/email/elegibilidade.js');
const { processarLote } = await import('./emailDispatch.js');
const { default: rotaEmail } = await import('../routes/disparoEmail.routes.js');
const { default: rotaWebhook } = await import('../routes/webhookBrevo.routes.js');

const fetchLocal = globalThis.fetch; // as chamadas HTTP locais dos testes usam o fetch real; o da Brevo é trocado por um falso
const BREVO = { EMAIL_ENVIO_ATIVO: 'true', BREVO_API_KEY: 'k', BREVO_FROM_EMAIL: 'envio@umbra.sbs', BREVO_FROM_NAME: 'Faturas' };
const setBrevo = (on) => { for (const [k, v] of Object.entries(BREVO)) on ? (process.env[k] = v) : delete process.env[k]; };

// ---------- cenário ----------
function vencimentoEmDias(n) {
  const d = new Date(`${hojeBrt()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).split('-').reverse().join('/');
}
const ativo = (l) => l.status === 'na_fila' || l.status === 'processando';
const RESTRICOES = {
  email_envios: [
    (l, n) => l.lote_id === n.lote_id && l.cliente_id === n.cliente_id,
    (l, n) => l.cliente_id === n.cliente_id && ativo(l) && ativo(n),
    (l, n) => n.fatura_externa_id && l.fatura_externa_id === n.fatura_externa_id && ativo(l) && ativo(n),
  ],
};

function cenario({ usuarios = ['u1'], porUsuario = 4, statusAceitos = ['fatura_encaminhada'], extras = {} } = {}) {
  const agora = new Date().toISOString();
  const clientes = [];
  const anexos = [];
  for (const u of usuarios) {
    for (let i = 1; i <= porUsuario; i++) {
      const id = `${u}-c${i}`;
      clientes.push({ id, usuario_id: u, campanha: 'cobranca', nome: `Cliente ${u} ${i}`, email: `${id}@exemplo.com`, valor: 99.99, vencimento: vencimentoEmDias(5), pdf_path: `${id}/boleto.pdf`, os_numero: String(1000 + i), ennychat_fatura_id: `f-${id}`, ennychat_status: 'fatura_encaminhada', ennychat_status_em: agora });
      anexos.push({ id: `a-${id}`, usuario_id: u, fatura_externa_id: `f-${id}`, pdf_path: `${id}/boleto.pdf`, estado: 'vinculado' });
    }
  }
  const falso = criarSupabaseFalso({
    tabelas: { clientes, ennychat_anexos: anexos, email_lotes: [], email_envios: [], ennychat_config: [{ chave: 'status_aceitos', valor: statusAceitos }, { chave: 'email_nome_empresa', valor: 'Empresa Teste' }], ...extras },
    restricoes: RESTRICOES,
  });
  __usarClienteDeTeste(falso);
  armazenamento.from = (_b) => ({ download: async (p) => ({ data: new Blob([Buffer.from(`%PDF-1.4 ${p}`)]), error: null }) });
  return falso;
}

// Provedor simulado: registra cada chamada; `respostas` define o resultado por chamada (padrão: aceito).
function provedor(respostas = []) {
  const chamadas = [];
  const enviar = async (pedido) => {
    chamadas.push(pedido);
    return respostas.shift?.() ?? { ok: true, messageId: `<msg-${chamadas.length}@smtp>` };
  };
  return { chamadas, enviar };
}

async function novoLote(db, usuario, clienteIds, over = {}) {
  const { data: lote } = await db.from('email_lotes').insert({ usuario_id: usuario, total: clienteIds.length, nome_empresa: 'Empresa Teste', ...over }).select('*').single();
  await db.from('email_envios').insert(clienteIds.map((id) => ({ lote_id: lote.id, usuario_id: usuario, cliente_id: id, email: `${id}@exemplo.com`, fatura_externa_id: `f-${id}` })));
  return lote;
}
const linhas = (db, t) => db.__dados[t];

// ---------- worker ----------
test('worker: um e-mail por fatura, só o PDF e o destinatário daquela fatura; messageId guardado; lote conclui', async () => {
  setBrevo(true);
  const db = cenario({ porUsuario: 3 });
  const lote = await novoLote(db, 'u1', ['u1-c1', 'u1-c2', 'u1-c3']);
  const p = provedor();
  await processarLote(lote.id, { enviar: p.enviar, atrasoMs: 0 });
  assert.equal(p.chamadas.length, 3);
  for (const c of p.chamadas) {
    const id = c.para.split('@')[0];
    assert.equal(c.anexoNome, 'fatura.pdf'); // nome neutro
    assert.equal(Buffer.from(c.anexoBase64, 'base64').toString().includes(`${id}/boleto.pdf`), true); // o PDF desse cliente
    assert.ok(c.html.includes('Empresa Teste') && !c.html.includes('Claro'));
  }
  const envios = linhas(db, 'email_envios');
  assert.ok(envios.every((e) => e.status === 'aceito' && e.message_id && e.aceito_em && e.tentativas === 1));
  assert.equal(linhas(db, 'email_lotes')[0].status, 'concluido');
});

test('worker: sem configuração da Brevo nada é enviado', async () => {
  setBrevo(false);
  const db = cenario({ porUsuario: 1 });
  const lote = await novoLote(db, 'u1', ['u1-c1']);
  const p = provedor();
  await processarLote(lote.id, { enviar: p.enviar, atrasoMs: 0 });
  assert.equal(p.chamadas.length, 0);
  assert.equal(linhas(db, 'email_envios')[0].motivo, 'sem_configuracao');
});

test('worker: status excluído com disparo pendente => cancelado, provedor não é chamado; lista vazia idem', async () => {
  setBrevo(true);
  const db = cenario({ porUsuario: 2 });
  const lote = await novoLote(db, 'u1', ['u1-c1', 'u1-c2']);
  linhas(db, 'ennychat_config').find((c) => c.chave === 'status_aceitos').valor = []; // supervisor esvaziou a lista depois
  const p = provedor();
  await processarLote(lote.id, { enviar: p.enviar, atrasoMs: 0 });
  assert.equal(p.chamadas.length, 0);
  assert.deepEqual(linhas(db, 'email_envios').map((e) => [e.status, e.motivo]), [['cancelado', 'status_bloqueado'], ['cancelado', 'status_bloqueado']]);
});

test('worker: fatura vencida/atrasada e status antigo SAEM; PDF trocado depois do vínculo não sai', async () => {
  setBrevo(true);
  const db = cenario({ porUsuario: 3 });
  const c = linhas(db, 'clientes');
  c[0].ennychat_status_em = '2020-01-01T00:00:00Z'; // status visto há muito tempo: não bloqueia
  c[1].vencimento = '01/01/2020'; // atrasada: também recebe
  c[2].pdf_path = 'outro/arquivo.pdf'; // PDF trocado depois do vínculo validado: não sai
  const lote = await novoLote(db, 'u1', c.map((x) => x.id));
  const p = provedor();
  await processarLote(lote.id, { enviar: p.enviar, atrasoMs: 0 });
  assert.equal(p.chamadas.length, 2);
  assert.deepEqual(linhas(db, 'email_envios').map((e) => [e.status, e.motivo ?? null]), [['aceito', null], ['aceito', null], ['cancelado', 'sem_pdf_validado']]);
});

test('worker: falha transitória repete (tentativas técnicas > aceitos); definitiva não repete', async () => {
  setBrevo(true);
  const db = cenario({ porUsuario: 2 });
  const lote = await novoLote(db, 'u1', ['u1-c1', 'u1-c2']);
  const p = provedor([{ ok: false, tipo: 'transitorio', erro: 'http_503' }, { ok: true, messageId: '<ok1>' }, { ok: false, tipo: 'definitivo', erro: 'http_400' }]);
  await processarLote(lote.id, { enviar: p.enviar, atrasoMs: 0, esperasMs: [0, 0] });
  const [a, b] = linhas(db, 'email_envios');
  assert.deepEqual([a.status, a.tentativas, !!a.aceito_em], ['aceito', 2, true]);
  assert.deepEqual([b.status, b.tentativas, b.motivo], ['falhou', 1, 'http_400']);
});

test('worker: resultado incerto reconcilia com a Brevo antes de repetir (sem duplicar)', async () => {
  setBrevo(true);
  const db = cenario({ porUsuario: 2 });
  const lote = await novoLote(db, 'u1', ['u1-c1', 'u1-c2']);
  const p = provedor([{ ok: false, tipo: 'incerto', erro: 'sem_resposta' }, { ok: false, tipo: 'incerto', erro: 'sem_resposta' }]);
  const consultas = [{ encontrado: true, messageId: '<ja-aceito>' }, null];
  await processarLote(lote.id, { enviar: p.enviar, procurar: async () => consultas.shift(), atrasoMs: 0, esperasMs: [0, 0], esperaReconciliarMs: 0 });
  const [a, b] = linhas(db, 'email_envios');
  assert.deepEqual([a.status, a.message_id, a.motivo], ['aceito', '<ja-aceito>', 'reconciliado']);
  assert.deepEqual([b.status, b.motivo], ['falhou', 'resultado_incerto']); // não conseguiu consultar: NÃO repete
  assert.equal(p.chamadas.length, 2); // uma chamada por fatura, nenhuma repetição
});

test('worker: 5xx pode ter sido aceito: reconcilia (inclusive 2ª consulta) e não duplica', async () => {
  setBrevo(true);
  const db = cenario({ porUsuario: 2 });
  const lote = await novoLote(db, 'u1', ['u1-c1', 'u1-c2']);
  const p = provedor([{ ok: false, tipo: 'incerto', status: 502, erro: 'http_502' }, { ok: false, tipo: 'incerto', status: 504, erro: 'http_504' }, { ok: true, messageId: '<novo>' }]);
  // 1º e-mail: 1ª consulta não acha (indexação), 2ª acha => aceito sem repetir. 2º e-mail: nada achado nas 2 consultas => repete e aceita.
  const consultas = [{ encontrado: false }, { encontrado: true, messageId: '<achado>' }, { encontrado: false }, { encontrado: false }];
  await processarLote(lote.id, { enviar: p.enviar, procurar: async () => consultas.shift(), atrasoMs: 0, esperasMs: [0, 0], esperaReconciliarMs: 0 });
  const [a, b] = linhas(db, 'email_envios');
  assert.deepEqual([a.status, a.message_id, a.motivo], ['aceito', '<achado>', 'reconciliado']);
  assert.deepEqual([b.status, b.message_id], ['aceito', '<novo>']);
  assert.equal(p.chamadas.length, 3);
});

test('rota: envio interrompido e fatura já enviada com cliente reimportado NÃO voltam a ser elegíveis', async () => {
  setBrevo(true);
  brevoFalsa([]);
  const db = cenario({ porUsuario: 3 });
  const agora = new Date().toISOString();
  linhas(db, 'email_envios').push(
    // processo caiu entre a Brevo aceitar e o banco: ficou 'falhou/interrompido'
    { id: 'i1', lote_id: 'L', usuario_id: 'u1', cliente_id: 'u1-c1', fatura_externa_id: 'f-u1-c1', status: 'falhou', motivo: 'interrompido', tentativas: 1, atualizado_em: agora },
    // aceito antes de o cliente ser apagado e reimportado (cliente_id ficou nulo): a identidade é a FATURA
    { id: 'a2', lote_id: 'L', usuario_id: 'u1', cliente_id: null, fatura_externa_id: 'f-u1-c2', status: 'aceito', aceito_em: agora, tentativas: 1, atualizado_em: agora },
  );
  const s = await servir();
  const pend = await s.chamar('GET', '/api/disparo-email/faturas?filtro=pendencias');
  const por = Object.fromEntries(pend.json.itens.map((i) => [i.cliente_id, i.motivos]));
  assert.deepEqual(por['u1-c1'], ['envio_incerto']);
  assert.deepEqual(por['u1-c2'], ['ja_enviado']);
  const r = await s.chamar('POST', '/api/disparo-email/lotes', { modo: 'todos' });
  assert.equal(r.json.total, 1); // só a c3
  await aguardarLotes(db);
  const re = await s.chamar('POST', '/api/disparo-email/lotes', { modo: 'ids', ids: ['u1-c1'], reenvio: true }); // reenvio explícito do incerto é permitido
  assert.equal(re.status, 201);
  await s.fechar();
});

test('worker: reexecutar o mesmo lote não gera outro envio', async () => {
  setBrevo(true);
  const db = cenario({ porUsuario: 2 });
  const lote = await novoLote(db, 'u1', ['u1-c1', 'u1-c2']);
  const p = provedor();
  await Promise.all([processarLote(lote.id, { enviar: p.enviar, atrasoMs: 0 }), processarLote(lote.id, { enviar: p.enviar, atrasoMs: 0 })]);
  await processarLote(lote.id, { enviar: p.enviar, atrasoMs: 0 });
  assert.equal(p.chamadas.length, 2);
});

// ---------- rotas ----------
async function servir(usuarios) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: req.headers['x-user'] ?? 'u1' }; next(); });
  app.use('/api/disparo-email', rotaEmail);
  app.use('/api/webhooks/brevo', rotaWebhook);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const chamar = async (metodo, caminho, corpo, usuario = 'u1', cab = {}) => {
    const r = await fetchLocal(base + caminho, { method: metodo, headers: { 'content-type': 'application/json', 'x-user': usuario, ...cab }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => srv.close(r)) };
}
async function aguardarLotes(db, max = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < max) {
    if (linhas(db, 'email_envios').every((e) => !ativo(e))) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('lote não terminou');
}
function brevoFalsa(corpos) {
  globalThis.fetch = async (url, init) => {
    corpos.push(JSON.parse(init.body));
    return { status: 201, ok: true, json: async () => ({ messageId: `<m${corpos.length}@smtp>` }) };
  };
}

test('rota: sem Brevo configurada a aba mostra indisponível e não cria lote', async () => {
  setBrevo(false);
  const db = cenario({ porUsuario: 2 });
  const s = await servir();
  const cfg = await s.chamar('GET', '/api/disparo-email/config');
  assert.equal(cfg.json.disponibilidade.configurado, false);
  assert.deepEqual(cfg.json.disponibilidade.faltando, ['BREVO_API_KEY', 'BREVO_FROM_EMAIL', 'BREVO_FROM_NAME']);
  const r = await s.chamar('POST', '/api/disparo-email/lotes', { modo: 'todos' });
  assert.equal(r.status, 503);
  assert.equal(linhas(db, 'email_lotes').length, 0);
  await s.fechar();
});

test('rota: lista com busca, pendências separadas, e disparo em lote (1 e-mail por fatura); duplo clique não duplica', async () => {
  setBrevo(true);
  const corpos = [];
  brevoFalsa(corpos);
  const db = cenario({ porUsuario: 3 });
  linhas(db, 'clientes')[2].email = null; // pendência: sem e-mail
  const s = await servir();
  const lista = await s.chamar('GET', '/api/disparo-email/faturas?filtro=elegiveis');
  assert.equal(lista.json.total, 2);
  assert.equal((await s.chamar('GET', '/api/disparo-email/faturas?filtro=pendencias')).json.itens[0].motivos[0], 'email_invalido');
  assert.equal((await s.chamar('GET', '/api/disparo-email/faturas?busca=u1-c1@')).json.total, 1);

  const [a, b] = await Promise.all([s.chamar('POST', '/api/disparo-email/lotes', { modo: 'todos' }), s.chamar('POST', '/api/disparo-email/lotes', { modo: 'todos' })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]); // duplo clique: só um lote nasce
  await aguardarLotes(db);
  assert.equal(corpos.length, 2);
  assert.deepEqual(corpos.map((c) => c.to.length), [1, 1]);
  assert.equal((await s.chamar('POST', '/api/disparo-email/lotes', { modo: 'todos' })).status, 409); // reabrir a tela: já enviados ficam de fora
  assert.equal(corpos.length, 2);
  const prog = await s.chamar('GET', `/api/disparo-email/lotes/${linhas(db, 'email_lotes')[0].id}`);
  assert.deepEqual([prog.json.lote.total, prog.json.lote.processados, prog.json.lote.contagens.aceito, prog.json.lote.aceitos_para_envio], [2, 2, 2, 2]);
  await s.fechar();
});

test('rota: nome da empresa é fixado no lote; editar depois não muda e-mails em andamento', async () => {
  setBrevo(true);
  const corpos = [];
  brevoFalsa(corpos);
  const db = cenario({ porUsuario: 1 });
  const s = await servir();
  const r = await s.chamar('POST', '/api/disparo-email/lotes', { modo: 'todos' });
  assert.equal(r.status, 201);
  assert.equal((await s.chamar('PUT', '/api/disparo-email/config', { nome_empresa: 'Outra <b>Empresa</b>' })).status, 400); // valor inválido
  assert.equal((await s.chamar('PUT', '/api/disparo-email/config', { nome_empresa: 'Outra Empresa' })).status, 200);
  await aguardarLotes(db);
  assert.ok(corpos[0].htmlContent.includes('Empresa Teste') && !corpos[0].htmlContent.includes('Outra Empresa'));
  assert.equal(linhas(db, 'email_lotes')[0].nome_empresa, 'Empresa Teste');
  const prev = await s.chamar('POST', '/api/disparo-email/preview', { nome_empresa: 'Minha Marca' });
  assert.ok(prev.json.html.includes('Minha Marca'));
  await s.fechar();
});

test('rota: saldo diário insuficiente mostra quantos cabem e não agenda o excedente', async () => {
  setBrevo(true);
  brevoFalsa([]);
  const db = cenario({ porUsuario: 8 });
  const s = await servir();
  // cota global de 5 (BREVO_LIMITE_DIARIO): 3 já usados hoje por outro canal/operador
  linhas(db, 'email_envios').push(...Array.from({ length: 3 }, (_, i) => ({ id: `x${i}`, lote_id: 'L0', usuario_id: 'u9', cliente_id: `z${i}`, status: 'aceito', aceito_em: new Date().toISOString(), tentativas: 1 })));
  const r = await s.chamar('POST', '/api/disparo-email/lotes', { modo: 'todos' });
  assert.equal(r.status, 409);
  assert.equal(r.json.disponivel, 2);
  assert.equal(r.json.selecionadas, 8);
  assert.equal((await s.chamar('GET', '/api/disparo-email/config')).json.saldo.disponivel, 2);
  assert.equal(linhas(db, 'email_lotes').length, 0); // nada foi reservado nem agendado para amanhã
  await s.fechar();
});

test('rota: dois operadores iniciando lotes ao mesmo tempo nunca reservam mais que o saldo', async () => {
  setBrevo(true);
  brevoFalsa([]);
  const db = cenario({ usuarios: ['u1', 'u2'], porUsuario: 3 }); // cota 5, cada um pede 3
  const s = await servir();
  const [a, b] = await Promise.all([s.chamar('POST', '/api/disparo-email/lotes', { modo: 'todos' }, 'u1'), s.chamar('POST', '/api/disparo-email/lotes', { modo: 'todos' }, 'u2')]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  await aguardarLotes(db);
  assert.equal(linhas(db, 'email_envios').filter((e) => e.aceito_em).length, 3);
  await s.fechar();
});

test('rota: isolamento por usuário e cancelamento de lote', async () => {
  setBrevo(true);
  brevoFalsa([]);
  const db = cenario({ usuarios: ['u1', 'u2'], porUsuario: 2 });
  const s = await servir();
  const lote = await novoLote(db, 'u1', ['u1-c1', 'u1-c2']);
  assert.equal((await s.chamar('GET', `/api/disparo-email/lotes/${lote.id}`, null, 'u2')).status, 404); // outro operador não vê
  assert.equal((await s.chamar('POST', `/api/disparo-email/lotes/${lote.id}/cancelar`, null, 'u2')).status, 404);
  assert.equal((await s.chamar('POST', `/api/disparo-email/lotes/${lote.id}/cancelar`, null, 'u1')).status, 200);
  assert.ok(linhas(db, 'email_envios').filter((e) => e.lote_id === lote.id).every((e) => e.status === 'cancelado'));
  const lista = await s.chamar('GET', '/api/disparo-email/faturas?filtro=todas', null, 'u2');
  assert.ok(lista.json.itens.every((i) => i.nome.includes('u2'))); // só as faturas do próprio operador
  await s.fechar();
});

test('webhook: exige segredo; entrega e devolução; duplicata e evento antigo não rebaixam; id desconhecido é ignorado', async () => {
  const db = cenario({ porUsuario: 2 });
  const agora = Math.floor(Date.now() / 1000);
  linhas(db, 'email_envios').push(
    { id: 'e1', lote_id: 'L', usuario_id: 'u1', cliente_id: 'u1-c1', status: 'aceito', message_id: '<m-1@smtp>', evento_em: null, tentativas: 1 },
    { id: 'e2', lote_id: 'L', usuario_id: 'u1', cliente_id: 'u1-c2', email: 'u1-c2@exemplo.com', status: 'aceito', message_id: '<m-2@smtp>', evento_em: null, tentativas: 1 },
  );
  const s = await servir();
  const auth = { authorization: 'Bearer segredo-do-webhook' };
  assert.equal((await s.chamar('POST', '/api/webhooks/brevo', { event: 'delivered' })).status, 401);
  assert.equal((await s.chamar('POST', '/api/webhooks/brevo', { event: 'delivered' }, 'u1', { authorization: 'Bearer errado' })).status, 401);
  assert.equal((await s.chamar('POST', '/api/webhooks/brevo', [{ event: 'delivered', 'message-id': 'm-1@smtp', ts: agora }, { event: 'hard_bounce', 'message-id': '<m-2@smtp>', ts: agora }, { event: 'delivered', 'message-id': '<nao-existe>', ts: agora }], 'u1', auth)).status, 200);
  const por = () => Object.fromEntries(linhas(db, 'email_envios').map((e) => [e.id, e.status]));
  assert.deepEqual(por(), { e1: 'entregue', e2: 'devolvido' });
  await s.chamar('POST', '/api/webhooks/brevo', [{ event: 'delivered', 'message-id': '<m-1@smtp>', ts: agora }, { event: 'deferred', 'message-id': '<m-1@smtp>', ts: agora - 3600 }, { event: 'request', 'message-id': '<m-1@smtp>', ts: agora + 60 }], 'u1', auth);
  assert.equal(por().e1, 'entregue'); // duplicata / antigo / rebaixamento ignorados
  assert.equal((await s.chamar('POST', '/api/webhooks/brevo?token=segredo-do-webhook', { event: 'opened', 'message-id': '<m-1@smtp>' })).status, 200); // token também aceito na URL
  await s.fechar();
});

test('webhook + painel: abriu/clicou contam sem mexer na entrega; resumo agrega envios do operador', async () => {
  const db = cenario({ porUsuario: 3 });
  const agoraIso = new Date().toISOString();
  const ts = Math.floor(Date.now() / 1000);
  linhas(db, 'email_envios').push(
    { id: 'e1', lote_id: 'L', usuario_id: 'u1', cliente_id: 'u1-c1', email: 'u1-c1@exemplo.com', status: 'entregue', message_id: '<m-1@smtp>', aceito_em: agoraIso, aberturas: 0, cliques: 0, tentativas: 1 },
    { id: 'e2', lote_id: 'L', usuario_id: 'u1', cliente_id: 'u1-c2', status: 'aceito', message_id: '<m-2@smtp>', aceito_em: agoraIso, aberturas: 0, cliques: 0, tentativas: 1 },
    { id: 'e3', lote_id: 'L', usuario_id: 'u1', cliente_id: 'u1-c3', email: 'u1-c3@exemplo.com', status: 'devolvido', message_id: '<m-3@smtp>', aceito_em: agoraIso, aberturas: 0, cliques: 0, tentativas: 1 },
    { id: 'x9', lote_id: 'L', usuario_id: 'u2', cliente_id: 'u2-c1', status: 'entregue', message_id: '<m-9@smtp>', aceito_em: agoraIso, aberturas: 5, cliques: 0, tentativas: 1 }, // outro operador
  );
  const s = await servir();
  const auth = { authorization: 'Bearer segredo-do-webhook' };
  await s.chamar('POST', '/api/webhooks/brevo', [
    { event: 'opened', 'message-id': '<m-1@smtp>', ts }, { event: 'opened', 'message-id': '<m-1@smtp>', ts: ts + 5 }, { event: 'click', 'message-id': '<m-1@smtp>', ts: ts + 6 },
    { event: 'opened', 'message-id': '<m-2@smtp>', ts }, // abrir implica que foi entregue
  ], 'u1', auth);
  const por = Object.fromEntries(linhas(db, 'email_envios').map((e) => [e.id, e]));
  assert.deepEqual([por.e1.status, por.e1.aberturas, por.e1.cliques], ['entregue', 2, 1]);
  assert.deepEqual([por.e2.status, por.e2.aberturas], ['entregue', 1]);
  const r = await s.chamar('GET', '/api/disparo-email/resumo');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.enviados, r.json.entregues, r.json.abertos, r.json.clicaram, r.json.devolvidos], [3, 2, 2, 1, 1]); // só do operador u1
  assert.equal(r.json.taxa_abertura, 100);
  assert.equal(r.json.recentes.find((x) => x.email === 'u1-c1@exemplo.com').abriu, true);
  assert.equal(r.json.recentes.length, 3);
  await s.fechar();
});

