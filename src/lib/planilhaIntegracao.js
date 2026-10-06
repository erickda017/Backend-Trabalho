// [2026-10] "Atualizar Pix na planilha" (botão no site, operador e
// supervisor): manda TODO Pix extraído (de qualquer operador, com OS lida no
// PDF) pro Apps Script publicado como App da Web dentro da planilha oficial
// do Google Sheets, que casa as linhas e preenche a coluna COD PIX (só
// células vazias). O script fica em Front-Trabalho/integracoes/google-sheets/
// (PixPlanilha.gs + LEIAME.md). Sem Google Cloud: o App da Web roda com a
// conta Google de quem implantou.
//
// [2026-10] Roda como TAREFA com progresso (relatado: "não sei quando
// terminou, se tá perto ou longe, se deu erro no caminho, se atualizou de
// verdade"): 1) busca os Pix no banco, 2) pede a lista de abas pro script,
// 3) processa ABA POR ABA (1 chamada cada), guardando o resultado de cada uma.
// O site consulta GET /status enquanto isso. Cada aba volta com
// `verificadas` = Pix que o script RELEU na planilha depois de escrever.
//
// Variáveis no Render:
//   PLANILHA_WEBAPP_URL        endereço ".../exec" da implantação do App da Web
//   PLANILHA_CHAVE_INTEGRACAO  senha (>= 20 caracteres), a MESMA salva no
//                              script (menu Pix automático > Configurar chave)
// Sem as duas, a integração fica desligada (erro claro no site).
//
// Dependências injetadas (buscarExtracoes, fetchImpl) pra ser testável sem
// Supabase/Google -- ver planilhaIntegracao.test.js.

export const TIMEOUT_CHAMADA_MS = 4 * 60 * 1000; // 1 aba grande no Apps Script leva < 1 min; folga pro Google
const CAMPOS_SOMADOS = ['linhas', 'preenchidas', 'jaTinhamPix', 'semExtracao', 'divergentes', 'ocupadas', 'escritas', 'verificadas', 'puladasNaHora'];

export function configuracaoPlanilha(env = process.env) {
  const url = (env.PLANILHA_WEBAPP_URL || '').trim();
  const chave = (env.PLANILHA_CHAVE_INTEGRACAO || '').trim();
  if (!url || !chave) return { ok: false, motivo: 'Integração com a planilha ainda não configurada (faltam PLANILHA_WEBAPP_URL / PLANILHA_CHAVE_INTEGRACAO no servidor).' };
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return { ok: false, motivo: 'PLANILHA_WEBAPP_URL inválida: precisa ser o endereço do App da Web do Apps Script (https://script.google.com/macros/s/.../exec).' };
  if (chave.length < 20) return { ok: false, motivo: 'PLANILHA_CHAVE_INTEGRACAO curta demais (mínimo 20 caracteres).' };
  return { ok: true, url, chave };
}

// Só o que o script precisa pra casar -- nada de usuario_id/operador.
function paraEnvio(e) {
  return { codigo: e.codigo, vencimento: e.vencimento, nome: e.nome, arquivo: e.arquivo, pix_code: e.pix_code };
}

// 1 chamada ao script. Devolve { json } ou { erro, transitorio }.
export async function chamarScript({ config, corpo, fetchImpl = fetch, timeoutMs = TIMEOUT_CHAMADA_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resposta;
  try {
    // O App da Web responde 302 pra script.googleusercontent.com; o fetch
    // segue o redirect (como GET) e pega o JSON de lá.
    resposta = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chave: config.chave, ...corpo }),
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    const tempo = err?.name === 'AbortError';
    return { erro: tempo ? 'a planilha demorou demais pra responder' : `não foi possível falar com a planilha (${err.message})`, transitorio: true };
  } finally {
    clearTimeout(timer);
  }
  const texto = await resposta.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(texto); } catch { /* HTML = página de erro/login do Google */ }
  if (!json) {
    return {
      erro: `a planilha respondeu algo inesperado (HTTP ${resposta.status}). Confira se o App da Web foi implantado com "Quem pode acessar: Qualquer pessoa" e se o endereço termina em /exec`,
      transitorio: resposta.status >= 500,
    };
  }
  if (!json.ok) return { erro: `planilha recusou: ${json.erro || 'erro desconhecido'}`, transitorio: /ocupada/.test(json.erro || '') };
  return { json };
}

export function novaTarefa(iniciadoPor) {
  return {
    id: `${Date.now()}`,
    status: 'rodando', // rodando | concluido | concluido_com_erros | erro
    etapa: 'buscando', // buscando | listando | abas | fim
    mensagem: 'Buscando os Pix extraídos no sistema…',
    iniciadoPor,
    iniciadoEm: new Date().toISOString(),
    terminadoEm: null,
    planilha: null,
    extracoesEnviadas: 0,
    abas: [], // { nome, status: pendente|rodando|ok|erro, preenchidas, verificadas, erro }
    resumo: null,
    erro: null,
  };
}

function somarResumo(total, parcial) {
  if (!total) return { ...parcial };
  for (const k of CAMPOS_SOMADOS) total[k] = (total[k] || 0) + (parcial[k] || 0);
  for (const k of ['abas', 'puladas', 'detalhes', 'colunasRedirecionadas']) total[k] = [...(total[k] || []), ...(parcial[k] || [])];
  return total;
}

// Executa a tarefa, atualizando `tarefa` no lugar (o GET /status lê o mesmo objeto).
export async function executarAtualizacao({ tarefa, config, buscarExtracoes, fetchImpl = fetch, timeoutMs = TIMEOUT_CHAMADA_MS, esperar = (ms) => new Promise((ok) => setTimeout(ok, ms)) }) {
  const falhar = (msg) => {
    tarefa.status = 'erro';
    tarefa.etapa = 'fim';
    tarefa.erro = msg;
    tarefa.mensagem = msg;
    tarefa.terminadoEm = new Date().toISOString();
    return tarefa;
  };
  if (!config.ok) return falhar(config.motivo);

  let extracoes;
  try {
    extracoes = (await buscarExtracoes()).map(paraEnvio);
  } catch (err) {
    return falhar(`Erro ao buscar os Pix no banco: ${err.message}`);
  }
  tarefa.extracoesEnviadas = extracoes.length;

  // Chama com 1 nova tentativa em erro passageiro (rede, demora, planilha ocupada).
  const chamar = async (corpo) => {
    let r = await chamarScript({ config, corpo, fetchImpl, timeoutMs });
    if (r.erro && r.transitorio) {
      await esperar(5000);
      r = await chamarScript({ config, corpo, fetchImpl, timeoutMs });
    }
    return r;
  };

  tarefa.etapa = 'listando';
  tarefa.mensagem = 'Conectando com a planilha…';
  const lista = await chamar({ acao: 'abas' });
  if (lista.erro) return falhar(`Não deu pra abrir a planilha: ${lista.erro}`);
  tarefa.planilha = lista.json.planilha || null;
  tarefa.abas = (lista.json.abas || []).map((a) => ({ nome: a.nome, linhas: a.linhas, status: 'pendente', preenchidas: 0, verificadas: 0, erro: null }));
  if (!tarefa.abas.length) return falhar('A planilha não tem abas pra processar.');

  tarefa.etapa = 'abas';
  for (const [i, aba] of tarefa.abas.entries()) {
    aba.status = 'rodando';
    tarefa.mensagem = `Aba ${i + 1} de ${tarefa.abas.length}: ${aba.nome}`;
    const r = await chamar({ acao: 'aba', nome: aba.nome, extracoes });
    if (r.erro) {
      aba.status = 'erro';
      aba.erro = r.erro;
      continue; // as outras abas seguem
    }
    const parcial = r.json.resumo || {};
    aba.status = 'ok';
    aba.preenchidas = parcial.preenchidas || 0;
    aba.verificadas = parcial.verificadas || 0;
    aba.ignorada = (parcial.puladas || []).length > 0;
    tarefa.resumo = somarResumo(tarefa.resumo, parcial);
  }

  const comErro = tarefa.abas.filter((a) => a.status === 'erro');
  tarefa.etapa = 'fim';
  tarefa.terminadoEm = new Date().toISOString();
  if (comErro.length === tarefa.abas.length) return falhar(`Nenhuma aba foi atualizada. 1º erro: ${comErro[0].erro}`);
  tarefa.status = comErro.length ? 'concluido_com_erros' : 'concluido';
  const v = tarefa.resumo?.verificadas || 0;
  tarefa.mensagem = comErro.length
    ? `Concluído com erro em ${comErro.length} aba(s). ${v} Pix gravado(s) e conferido(s) na planilha.`
    : `Concluído. ${v} Pix gravado(s) e conferido(s) na planilha.`;
  return tarefa;
}
