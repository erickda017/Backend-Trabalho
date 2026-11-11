import test from 'node:test';
import assert from 'node:assert/strict';
import { avaliarElegibilidade, hojeBrt, vencimentoParaIso, diasEntre } from './elegibilidade.js';
import { renderizarEmail, escapeHtml, formatarValor, mesReferencia, mensagemFatura, primeiroNome, assuntoFatura } from './modelo.js';
import { configuracaoBrevo, enviarTransacional, procurarEnvioRecente } from './brevo.js';
import { aplicarEvento, normalizarMessageId } from './eventos.js';
import { selecionar, calcularCota, LIMITE_POR_LOTE } from './selecao.js';
import { comTrava } from './trava.js';

// ---- fixtures fictícias ----
const AGORA = Date.parse('2026-11-10T15:00:00Z');
const HOJE = '2026-11-10';
const base = (o = {}) => ({
  cliente: { nome: 'Maria Fictícia', email: 'maria@exemplo.com', valor: 99.99, vencimento: '15/11/2026', pdf_path: 'x/a.pdf', ennychat_status: 'fatura_encaminhada', ennychat_status_em: '2026-11-10T10:00:00Z', ...o.cliente },
  pdfValidado: true, aceitos: 0, ativo: false, statusAceitos: ['fatura_encaminhada'], hoje: HOJE, janelaDias: 10, statusMaxIdadeH: 24, agoraMs: AGORA, ...o.resto,
});
const motivos = (o) => avaliarElegibilidade(base(o)).motivos;

test('elegibilidade: caso feliz e cada pendência individual', () => {
  assert.deepEqual(avaliarElegibilidade(base()), { elegivel: true, motivos: [] });
  assert.deepEqual(motivos({ cliente: { email: 'sem-arroba' } }), ['email_invalido']);
  assert.deepEqual(motivos({ cliente: { email: null } }), ['email_invalido']);
  assert.deepEqual(motivos({ cliente: { valor: null } }), ['sem_valor']);
  assert.deepEqual(motivos({ cliente: { vencimento: null } }), ['sem_vencimento']);
  // cliente atrasado (ou vencendo hoje, ou longe) TAMBÉM recebe: não há janela de vencimento
  for (const v of ['10/11/2026', '01/11/2026', '01/01/2020', '30/11/2026', '31/12/2030']) assert.deepEqual(motivos({ cliente: { vencimento: v } }), [], v);
  assert.deepEqual(motivos({ resto: { pdfValidado: false } }), ['sem_pdf_validado']);
  assert.deepEqual(motivos({ cliente: { pdf_path: null } }), ['sem_pdf_validado']);
  assert.deepEqual(motivos({ resto: { aceitos: 1 } }), ['ja_enviado']);
  assert.deepEqual(motivos({ resto: { incertos: 1 } }), ['envio_incerto']); // aceito sem registro: nunca volta sozinho
  assert.deepEqual(motivos({ cliente: { email: 'a"b@x.com' } }), ['email_invalido']);
  assert.deepEqual(motivos({ resto: { ativo: true } }), ['envio_em_andamento']);
});

test('elegibilidade: status aceito, desconhecido, lista vazia e excluído depois', () => {
  assert.deepEqual(motivos({ cliente: { ennychat_status: 'outro' } }), ['status_bloqueado']);
  assert.deepEqual(motivos({ cliente: { ennychat_status: null } }), ['status_bloqueado']);
  assert.deepEqual(motivos({ resto: { statusAceitos: [] } }), ['status_bloqueado']); // lista vazia
  assert.deepEqual(motivos({ cliente: { ennychat_status_em: '2020-01-01T00:00:00Z' } }), []); // sem exigência de status "verificado recentemente"
  assert.deepEqual(motivos({ cliente: { ennychat_status_em: null } }), []);
  // "Aguardando boleto" -> permitido: passa a elegível quando entra na lista
  assert.equal(avaliarElegibilidade(base({ cliente: { ennychat_status: 'aguardando_boleto' }, resto: { statusAceitos: ['aguardando_boleto'] } })).elegivel, true);
  // status excluído com disparo pendente: o worker reavalia e bloqueia
  assert.equal(avaliarElegibilidade(base({ resto: { statusAceitos: ['outro'] } })).elegivel, false);
});

test('datas: fuso de Brasília, vencimento e dias', () => {
  assert.equal(hojeBrt(new Date('2026-11-11T02:30:00Z')), '2026-11-10'); // 23:30 em Brasília ainda é dia 10
  assert.equal(vencimentoParaIso('15/11/2026'), '2026-11-15');
  assert.equal(vencimentoParaIso('31/02/2026'), null);
  assert.equal(diasEntre('2026-11-10', '2026-11-15'), 5);
});

test('modelo: personalização, escape e links oficiais no e-mail', () => {
  const html = renderizarEmail({ empresa: 'Minha <b>Empresa</b> & Cia', primeiro_nome: 'João', mes_referencia: 'Novembro de 2026', vencimento: '15/11/2026', valor: formatarValor(99.99) });
  assert.ok(html.includes('Minha &lt;b&gt;Empresa&lt;/b&gt; &amp; Cia'));
  assert.equal(html.includes('<b>Empresa</b>'), false);
  assert.ok(html.includes('Olá, João.') && html.includes('15/11/2026') && html.includes('Novembro de 2026'));
  assert.ok(/R\$\s?99,99/.test(html));
  assert.ok(html.includes('Empresa autorizada pela Claro'));
  assert.ok(html.includes('https://play.google.com/store/apps/details?hl=pt_BR&amp;id=com.nvt.cs'));
  assert.ok(html.includes('https://apps.apple.com/br/app/minha-claro/id526829675'));
  assert.equal(/\{\{/.test(html), false); // nenhum placeholder sobrando
  assert.equal(escapeHtml('"a"'), '&quot;a&quot;');
  assert.equal(mesReferencia('2026-10-15'), 'Outubro de 2026');
  assert.equal(primeiroNome('MARIA JOSE SANTOS'), 'Maria');
  assert.equal(assuntoFatura('Outubro de 2026'), 'Sua fatura Claro de Outubro de 2026');
});

// ---- provedor simulado ----
const cfg = { apiKey: 'k', fromEmail: 'a@umbra.sbs', fromName: 'Fatura', replyTo: 'r@umbra.sbs' };
const resp = (status, json) => async () => ({ status, ok: status < 300, json: async () => json });
const dados = { cfg, para: 'x@exemplo.com', assunto: 'S', html: '<p>oi</p>', anexoNome: 'fatura.pdf', anexoBase64: 'QUJD' };

test('brevo: aceito devolve messageId; 429 transitório; 5xx e queda = incerto; 400 definitivo', async () => {
  let enviado;
  const ok = await enviarTransacional(dados, async (url, init) => { enviado = { url, init }; return { status: 201, ok: true, json: async () => ({ messageId: '<abc@smtp>' }) }; });
  assert.deepEqual(ok, { ok: true, messageId: '<abc@smtp>' });
  const corpo = JSON.parse(enviado.init.body);
  assert.equal(enviado.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(enviado.init.headers['api-key'], 'k');
  assert.deepEqual(corpo.to, [{ email: 'x@exemplo.com' }]); // um destinatário por e-mail
  assert.equal(corpo.attachment.length, 1);
  assert.deepEqual(corpo.replyTo, { email: 'r@umbra.sbs' });
  assert.equal((await enviarTransacional(dados, resp(429, {}))).tipo, 'transitorio');
  assert.equal((await enviarTransacional(dados, resp(503, {}))).tipo, 'incerto'); // 5xx pode ter sido aceito (gateway)
  assert.equal((await enviarTransacional(dados, resp(502, {}))).tipo, 'incerto');
  assert.equal((await enviarTransacional(dados, resp(400, {}))).tipo, 'definitivo');
  assert.equal((await enviarTransacional(dados, async () => { throw new Error('timeout'); })).tipo, 'incerto');
  assert.equal((await enviarTransacional(dados, resp(201, {}))).tipo, 'incerto'); // 201 sem messageId
});

test('brevo: reconciliação depois de resultado incerto e configuração', async () => {
  const q = { cfg, para: 'x@exemplo.com', assunto: 'S', desdeIso: '2026-11-10T12:00:00Z' };
  assert.deepEqual(await procurarEnvioRecente(q, resp(200, { transactionalEmails: [{ subject: 'S', messageId: '<m1>', date: '2026-11-10T12:00:30Z' }] })), { encontrado: true, messageId: '<m1>' });
  // e-mail ANTERIOR à tentativa (mesmo assunto/destinatário) não conta como este envio
  assert.deepEqual(await procurarEnvioRecente(q, resp(200, { transactionalEmails: [{ subject: 'S', messageId: '<velho>', date: '2026-11-10T08:00:00Z' }] })), { encontrado: false, messageId: null });
  // a listagem filtra por DATA (YYYY-MM-DD), não por instante
  let url;
  await procurarEnvioRecente(q, async (u) => { url = u; return { ok: true, json: async () => ({ transactionalEmails: [] }) }; });
  assert.match(url, /startDate=2026-11-09&endDate=\d{4}-\d{2}-\d{2}&/);
  assert.deepEqual(await procurarEnvioRecente(q, resp(200, { transactionalEmails: [] })), { encontrado: false, messageId: null });
  assert.equal(await procurarEnvioRecente(q, resp(500, {})), null); // não deu para consultar: segue incerto
  assert.equal(configuracaoBrevo({}).configurado, false);
  assert.deepEqual(configuracaoBrevo({ BREVO_API_KEY: 'k' }).faltando, ['BREVO_FROM_EMAIL', 'BREVO_FROM_NAME']);
  assert.equal(configuracaoBrevo({ BREVO_API_KEY: 'k', BREVO_FROM_EMAIL: 'a@b.c', BREVO_FROM_NAME: 'N' }).configurado, true);
});

test('eventos: entrega, devolução, duplicata e evento antigo não rebaixam', () => {
  const t = (s) => Math.floor(Date.parse(s) / 1000);
  const aceito = { status: 'aceito', evento_em: null };
  const entregue = aplicarEvento(aceito, { event: 'delivered', ts: t('2026-11-10T12:00:00Z') });
  assert.equal(entregue.status, 'entregue');
  const atual = { status: 'entregue', evento_em: entregue.evento_em };
  assert.equal(aplicarEvento(atual, { event: 'delivered', ts: t('2026-11-10T12:00:00Z') }), null); // duplicata
  assert.equal(aplicarEvento(atual, { event: 'deferred', ts: t('2026-11-10T11:00:00Z') }), null); // antigo
  assert.equal(aplicarEvento(atual, { event: 'request', ts: t('2026-11-10T13:00:00Z') }), null); // não rebaixa
  assert.equal(aplicarEvento(atual, { event: 'opened', ts: t('2026-11-10T13:00:00Z') }), null); // ignorado
  assert.equal(aplicarEvento(aceito, { event: 'hard_bounce', ts: t('2026-11-10T12:00:00Z') }).status, 'devolvido');
  assert.equal(aplicarEvento(aceito, { event: 'blocked', ts: t('2026-11-10T12:00:00Z') }).status, 'falhou');
  assert.equal(aplicarEvento({ status: 'na_fila', evento_em: null }, { event: 'delivered', ts: 1 }), null); // nunca foi aceito
  assert.equal(normalizarMessageId('<abc@x>'), 'abc@x');
});

test('seleção: mais de 300 elegíveis nos resultados filtrados -> 300 determinísticos; busca; ids; reenvio', () => {
  const linhas = Array.from({ length: 450 }, (_, i) => ({
    cliente_id: `c${String(i).padStart(3, '0')}`, nome: `Cliente ${i % 2 ? 'Par' : 'Impar'} ${i}`, email: `c${i}@exemplo.com`, os_numero: String(1000 + i),
    vencimento: `${String(10 + (i % 9)).padStart(2, '0')}/11/2026`, elegivel: i % 10 !== 0, motivos: i % 10 !== 0 ? [] : ['sem_pdf_validado'],
  }));
  const a = selecionar(linhas, { modo: 'todos' });
  assert.equal(a.selecionados.length, LIMITE_POR_LOTE);
  assert.equal(a.truncado, true);
  assert.equal(a.totalFiltrado, 405);
  assert.deepEqual(a.selecionados.map((l) => l.cliente_id), selecionar([...linhas].reverse(), { modo: 'todos' }).selecionados.map((l) => l.cliente_id)); // ordem estável
  assert.ok(a.selecionados.every((l) => l.elegivel));
  assert.equal(selecionar(linhas, { modo: 'todos', busca: 'Impar' }).selecionados.every((l) => l.nome.includes('Impar')), true);
  assert.equal(selecionar(linhas, { modo: 'ids', ids: ['c001', 'c000', 'zzz'] }).selecionados.length, 1); // c000 inelegível, zzz inexistente
  const incerto = [{ cliente_id: 'i1', nome: 'I', email: 'i@x.com', vencimento: '12/11/2026', elegivel: false, motivos: ['envio_incerto'] }];
  assert.equal(selecionar(incerto, { modo: 'ids', ids: ['i1'] }).selecionados.length, 0);
  assert.equal(selecionar(incerto, { modo: 'ids', ids: ['i1'], reenvio: true }).selecionados.length, 1); // só com reenvio explícito
  const reenvio = [{ cliente_id: 'r1', nome: 'R', email: 'r@x.com', vencimento: '12/11/2026', elegivel: false, motivos: ['ja_enviado'] }];
  assert.equal(selecionar(reenvio, { modo: 'ids', ids: ['r1'] }).selecionados.length, 0); // fora da seleção padrão
  assert.equal(selecionar(reenvio, { modo: 'ids', ids: ['r1'], reenvio: true }).selecionados.length, 1);
  assert.equal(selecionar([{ ...reenvio[0], motivos: ['ja_enviado', 'vencida'] }], { modo: 'ids', ids: ['r1'], reenvio: true }).selecionados.length, 0); // só ja_enviado é perdoado
});

test('cota diária: não deixa reservar mais que o saldo, inclusive com operadores simultâneos', async () => {
  assert.deepEqual(calcularCota({ limite: 300, usados: 250, reservados: 20, solicitados: 50 }), { disponivel: 30, cabe: false, podeEnviar: 30 });
  assert.equal(calcularCota({ limite: 300, usados: 0, reservados: 0, solicitados: 300 }).cabe, true);
  // dois operadores pedem 200 ao mesmo tempo com saldo de 300: só um pode passar
  let reservados = 0;
  const pedir = (n) => comTrava(async () => {
    await new Promise((r) => setTimeout(r, 5)); // leitura lenta do banco
    const c = calcularCota({ limite: 300, usados: 0, reservados, solicitados: n });
    if (!c.cabe) return false;
    reservados += n;
    return true;
  });
  const r = await Promise.all([pedir(200), pedir(200)]);
  assert.deepEqual(r.sort(), [false, true]);
  assert.equal(reservados, 200);
});

test('modelo: texto muda para cliente em atraso (sem "antecedência" nem "antes do vencimento")', () => {
  const antes = renderizarEmail({ empresa: 'E', primeiro_nome: 'A', mes_referencia: 'M', vencimento: '15/11/2026', valor: 'R$ 1', mensagem: mensagemFatura('2026-11-15', '2026-11-10') });
  assert.ok(antes.includes('com antecedência'));
  const hoje = mensagemFatura('2026-11-10', '2026-11-10'); // vence hoje: ainda não é atraso
  assert.ok(hoje.includes('antecedência'));
  const atraso = renderizarEmail({ empresa: 'E', primeiro_nome: 'A', mes_referencia: 'M', vencimento: '01/10/2026', valor: 'R$ 1', mensagem: mensagemFatura('2026-10-01', '2026-11-10') });
  assert.equal(atraso.includes('antecedência'), false);
  assert.ok(atraso.includes('disponível para consulta'));
  assert.equal(/\{\{/.test(atraso), false);
});


test('reconciliação: ignora e-mail da Brevo já registrado para outro envio (mesmo destinatário e assunto)', async () => {
  const q = { cfg: { apiKey: 'k' }, para: 'a@b.c', assunto: 'S', desdeIso: '2026-11-10T12:00:00Z', ignorarMessageIds: ['<outra-fatura>'] };
  const resp = (json) => async () => ({ ok: true, json: async () => json });
  const lista = { transactionalEmails: [{ subject: 'S', messageId: '<outra-fatura>', date: '2026-11-10T12:00:30Z' }] };
  assert.deepEqual(await procurarEnvioRecente(q, resp(lista)), { encontrado: false, messageId: null });
});
