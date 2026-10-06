// [2026-10] "Atualizar Pix na planilha" (botão no site, operador e
// supervisor): manda TODO Pix extraído (de qualquer operador, com OS lida no
// PDF) pro Apps Script publicado como App da Web dentro da planilha oficial
// do Google Sheets, que casa as linhas e preenche a coluna COD PIX (só
// células vazias). O script fica em Front-Trabalho/integracoes/google-sheets/
// (PixPlanilha.gs + LEIAME.md). Sem Google Cloud: o App da Web roda com a
// conta Google de quem implantou.
//
// Variáveis no Render:
//   PLANILHA_WEBAPP_URL        endereço ".../exec" da implantação do App da Web
//   PLANILHA_CHAVE_INTEGRACAO  senha (>= 20 caracteres), a MESMA salva no
//                              script (menu Pix automático > Configurar chave)
// Sem as duas, a integração fica desligada (503 com mensagem clara).
//
// Separado da rota pra ser testável sem Supabase/Google (dependências
// injetadas) -- ver planilhaIntegracao.test.js.

export const TIMEOUT_PLANILHA_MS = 5 * 60 * 1000; // Apps Script pode levar ~1-2 min numa planilha grande

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

// Devolve { status, body } pra rota repassar.
export async function atualizarPlanilha({ config, buscarExtracoes, fetchImpl = fetch, timeoutMs = TIMEOUT_PLANILHA_MS }) {
  if (!config.ok) return { status: 503, body: { error: config.motivo, codigo: 'nao_configurada' } };

  const extracoes = (await buscarExtracoes()).map(paraEnvio);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resposta;
  try {
    // O App da Web responde 302 pra script.googleusercontent.com; o fetch
    // segue o redirect (como GET) e pega o JSON de lá.
    resposta = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chave: config.chave, extracoes }),
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    const tempo = err?.name === 'AbortError';
    return { status: 504, body: { error: tempo ? 'A planilha demorou demais pra responder. Tente de novo em 1 minuto.' : `Não foi possível falar com a planilha: ${err.message}` } };
  } finally {
    clearTimeout(timer);
  }

  const texto = await resposta.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(texto); } catch { /* HTML = página de erro/login do Google */ }
  if (!json) {
    return {
      status: 502,
      body: { error: `A planilha respondeu algo inesperado (HTTP ${resposta.status}). Confira se o App da Web foi implantado com "Quem pode acessar: Qualquer pessoa" e se o endereço termina em /exec.` },
    };
  }
  if (!json.ok) return { status: 502, body: { error: `Planilha recusou: ${json.erro || 'erro desconhecido'}` } };
  return { status: 200, body: { ...json.resumo, extracoesEnviadas: extracoes.length } };
}
