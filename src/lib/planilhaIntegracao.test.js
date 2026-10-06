import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atualizarPlanilha, configuracaoPlanilha } from './planilhaIntegracao.js';

const URL_OK = 'https://script.google.com/macros/s/ABC/exec';
const CHAVE = 'x'.repeat(24);
const config = configuracaoPlanilha({ PLANILHA_WEBAPP_URL: URL_OK, PLANILHA_CHAVE_INTEGRACAO: CHAVE });
const buscar = async () => [{ codigo: '010/1', vencimento: '10/10/2026', nome: 'A', arquivo: 'a.pdf', pix_code: '000201X', usuario_id: 'u1', operador: 'Op' }];
const resp = (status, corpo) => ({ status, text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) });

test('sem configuração: 503 e não chama nada', async () => {
  let chamou = false;
  const r = await atualizarPlanilha({ config: configuracaoPlanilha({}), buscarExtracoes: async () => { chamou = true; return []; } });
  assert.equal(r.status, 503);
  assert.equal(r.body.codigo, 'nao_configurada');
  assert.equal(chamou, false);
});

test('URL que não é do Apps Script e chave curta são recusadas', () => {
  assert.equal(configuracaoPlanilha({ PLANILHA_WEBAPP_URL: 'https://evil.com/x', PLANILHA_CHAVE_INTEGRACAO: CHAVE }).ok, false);
  assert.equal(configuracaoPlanilha({ PLANILHA_WEBAPP_URL: URL_OK, PLANILHA_CHAVE_INTEGRACAO: 'curta' }).ok, false);
});

test('manda chave + extrações SEM usuario_id/operador e devolve o resumo', async () => {
  let enviado;
  const r = await atualizarPlanilha({
    config,
    buscarExtracoes: buscar,
    fetchImpl: async (url, opts) => { enviado = { url, ...JSON.parse(opts.body) }; return resp(200, { ok: true, resumo: { preenchidas: 1, detalhes: [] } }); },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.preenchidas, 1);
  assert.equal(r.body.extracoesEnviadas, 1);
  assert.equal(enviado.url, URL_OK);
  assert.equal(enviado.chave, CHAVE);
  assert.deepEqual(Object.keys(enviado.extracoes[0]).sort(), ['arquivo', 'codigo', 'nome', 'pix_code', 'vencimento']);
});

test('planilha recusa (chave inválida) -> 502 com o motivo', async () => {
  const r = await atualizarPlanilha({ config, buscarExtracoes: buscar, fetchImpl: async () => resp(200, { ok: false, erro: 'chave inválida' }) });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /chave inválida/);
});

test('HTML do Google (implantação errada) -> 502 explicando o que conferir', async () => {
  const r = await atualizarPlanilha({ config, buscarExtracoes: buscar, fetchImpl: async () => resp(200, '<html>Sign in</html>') });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Qualquer pessoa/);
});

test('timeout -> 504', async () => {
  const r = await atualizarPlanilha({
    config,
    buscarExtracoes: buscar,
    timeoutMs: 10,
    fetchImpl: (_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))),
  });
  assert.equal(r.status, 504);
});
