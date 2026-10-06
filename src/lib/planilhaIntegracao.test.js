import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuracaoPlanilha, executarAtualizacao, novaTarefa } from './planilhaIntegracao.js';

const URL_OK = 'https://script.google.com/macros/s/ABC/exec';
const CHAVE = 'x'.repeat(24);
const config = configuracaoPlanilha({ PLANILHA_WEBAPP_URL: URL_OK, PLANILHA_CHAVE_INTEGRACAO: CHAVE });
const buscar = async () => [{ codigo: '010/1', vencimento: '10/10/2026', nome: 'A', arquivo: 'a.pdf', pix_code: '000201X', usuario_id: 'u1', operador: 'Op' }];
const resp = (status, corpo) => ({ status, text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) });
const semEspera = async () => {};

// Script falso: responde "abas" e "aba" conforme o mapa.
function scriptFalso(porAba, chamadas = []) {
  return async (url, opts) => {
    const corpo = JSON.parse(opts.body);
    chamadas.push(corpo);
    if (corpo.acao === 'abas') return resp(200, { ok: true, planilha: 'Oficial', abas: Object.keys(porAba).map((nome) => ({ nome, linhas: 10 })) });
    const r = porAba[corpo.nome];
    return typeof r === 'function' ? r() : resp(200, r);
  };
}

test('sem configuração: erro claro e não chama nada', async () => {
  let chamou = false;
  const t = await executarAtualizacao({ tarefa: novaTarefa('u'), config: configuracaoPlanilha({}), buscarExtracoes: async () => { chamou = true; return []; } });
  assert.equal(t.status, 'erro');
  assert.match(t.erro, /não configurada/);
  assert.equal(chamou, false);
});

test('URL que não é do Apps Script e chave curta são recusadas', () => {
  assert.equal(configuracaoPlanilha({ PLANILHA_WEBAPP_URL: 'https://evil.com/x', PLANILHA_CHAVE_INTEGRACAO: CHAVE }).ok, false);
  assert.equal(configuracaoPlanilha({ PLANILHA_WEBAPP_URL: URL_OK, PLANILHA_CHAVE_INTEGRACAO: 'curta' }).ok, false);
});

test('aba por aba: progresso, soma do resumo, verificadas e envio SEM usuario_id', async () => {
  const chamadas = [];
  const tarefa = novaTarefa('u1');
  const t = await executarAtualizacao({
    tarefa,
    config,
    buscarExtracoes: buscar,
    esperar: semEspera,
    fetchImpl: scriptFalso({
      Julho: { ok: true, resumo: { abas: ['Julho'], preenchidas: 2, escritas: 2, verificadas: 2, linhas: 10, detalhes: [{ status: 'preenchida' }], puladas: [], colunasRedirecionadas: [] } },
      PROC: { ok: true, resumo: { abas: [], preenchidas: 0, verificadas: 0, puladas: [{ aba: 'PROC', motivo: 'sem coluna OS' }], detalhes: [] } },
    }, chamadas),
  });
  assert.equal(t, tarefa);
  assert.equal(t.status, 'concluido');
  assert.equal(t.planilha, 'Oficial');
  assert.deepEqual(t.abas.map((a) => [a.nome, a.status, a.verificadas]), [['Julho', 'ok', 2], ['PROC', 'ok', 0]]);
  assert.equal(t.resumo.preenchidas, 2);
  assert.equal(t.resumo.verificadas, 2);
  assert.equal(t.resumo.puladas.length, 1);
  assert.match(t.mensagem, /2 Pix gravado/);
  assert.equal(chamadas[0].chave, CHAVE);
  assert.deepEqual(Object.keys(chamadas[1].extracoes[0]).sort(), ['arquivo', 'codigo', 'nome', 'pix_code', 'vencimento']);
});

test('erro numa aba não para as outras; 1 nova tentativa em erro passageiro', async () => {
  let tentativasAgosto = 0;
  const t = await executarAtualizacao({
    tarefa: novaTarefa('u'),
    config,
    buscarExtracoes: buscar,
    esperar: semEspera,
    fetchImpl: scriptFalso({
      Agosto: () => { tentativasAgosto++; return resp(200, { ok: false, erro: 'planilha ocupada com outra atualização' }); },
      Setembro: { ok: true, resumo: { preenchidas: 1, verificadas: 1 } },
    }),
  });
  assert.equal(tentativasAgosto, 2);
  assert.equal(t.status, 'concluido_com_erros');
  assert.equal(t.abas[0].status, 'erro');
  assert.equal(t.abas[1].verificadas, 1);
});

test('chave errada / HTML do Google -> erro com o motivo, sem processar abas', async () => {
  const t1 = await executarAtualizacao({ tarefa: novaTarefa('u'), config, buscarExtracoes: buscar, esperar: semEspera, fetchImpl: async () => resp(200, { ok: false, erro: 'chave inválida' }) });
  assert.equal(t1.status, 'erro');
  assert.match(t1.erro, /chave inválida/);
  const t2 = await executarAtualizacao({ tarefa: novaTarefa('u'), config, buscarExtracoes: buscar, esperar: semEspera, fetchImpl: async () => resp(200, '<html>Sign in</html>') });
  assert.match(t2.erro, /Qualquer pessoa/);
});

test('timeout na listagem -> tenta 2x e falha com mensagem de demora', async () => {
  let n = 0;
  const t = await executarAtualizacao({
    tarefa: novaTarefa('u'),
    config,
    buscarExtracoes: buscar,
    esperar: semEspera,
    timeoutMs: 5,
    fetchImpl: (_u, { signal }) => { n++; return new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))); },
  });
  assert.equal(n, 2);
  assert.match(t.erro, /demorou demais/);
});
