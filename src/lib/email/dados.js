// Disparo / E-mail -- leituras do banco compartilhadas pela rota e pelo worker (a regra em si é pura: ver elegibilidade.js).
import { supabase, urlProxyArquivo } from '../supabase.js';
import { buscarTodos } from '../buscarTodos.js';
import { avaliarElegibilidade, hojeBrt } from './elegibilidade.js';
import { MOTIVOS_INCERTOS } from './constantes.js';

export const LIMITE_DIARIO = Number(process.env.BREVO_LIMITE_DIARIO) || 300;

export async function lerConfigEmail() {
  const { data, error } = await supabase.from('ennychat_config').select('chave, valor');
  if (error) throw error;
  const m = Object.fromEntries((data || []).map((l) => [l.chave, l.valor]));
  return {
    statusAceitos: Array.isArray(m.status_aceitos) ? m.status_aceitos : [],
    catalogo: Array.isArray(m.catalogo) ? m.catalogo : [],
    nomeEmpresa: typeof m.email_nome_empresa === 'string' ? m.email_nome_empresa : '',
  };
}

const COLUNAS_CLIENTE = 'id, nome, email, os_numero, valor, vencimento, pdf_path, ennychat_fatura_id, ennychat_status, ennychat_status_em';

// Faturas do EnnyChat do usuário já avaliadas (uma linha por fatura). Escopo SEMPRE por usuario_id.
export async function carregarLinhas(usuarioId, cfg, agora = new Date()) {
  const [cli, anx, env] = await Promise.all([
    buscarTodos(() => supabase.from('clientes').select(COLUNAS_CLIENTE).eq('usuario_id', usuarioId).eq('campanha', 'cobranca').not('ennychat_fatura_id', 'is', null).order('id')),
    buscarTodos(() => supabase.from('ennychat_anexos').select('fatura_externa_id, pdf_path').eq('usuario_id', usuarioId).eq('estado', 'vinculado').order('id')),
    buscarTodos(() => supabase.from('email_envios').select('id, cliente_id, fatura_externa_id, status, motivo, aceito_em, tentativas, atualizado_em').eq('usuario_id', usuarioId).order('id')),
  ]);
  for (const r of [cli, anx, env]) if (r.error) throw r.error;

  // Uma fatura pode ter vários anexos vinculados ao longo do tempo: vale qualquer par fatura|pdf igual ao PDF atual do cliente.
  const pdfsValidados = new Set((anx.data || []).map((a) => `${a.fatura_externa_id}|${a.pdf_path}`));
  // Identidade do envio = a FATURA do EnnyChat (sobrevive a apagar/reimportar o cliente); sem ela, o cliente.
  const porChave = new Map();
  const chaveEnvio = (fatura, cliente) => (fatura ? `f:${fatura}` : `c:${cliente}`);
  for (const e of env.data || []) {
    const k = chaveEnvio(e.fatura_externa_id, e.cliente_id);
    const a = porChave.get(k) ?? { aceitos: 0, incertos: 0, tentativas: 0, ativo: false, ultimo: null };
    if (e.aceito_em) a.aceitos += 1;
    if (e.status === 'falhou' && MOTIVOS_INCERTOS.includes(e.motivo)) a.incertos += 1;
    a.tentativas += e.tentativas || 0;
    if (e.status === 'na_fila' || e.status === 'processando') a.ativo = true;
    if (!a.ultimo || e.atualizado_em > a.ultimo.atualizado_em) a.ultimo = e;
    porChave.set(k, a);
  }

  return (cli.data || []).map((c) => {
    const a = porChave.get(chaveEnvio(c.ennychat_fatura_id, c.id)) ?? { aceitos: 0, incertos: 0, tentativas: 0, ativo: false, ultimo: null };
    const { elegivel, motivos } = avaliarElegibilidade({
      cliente: c,
      pdfValidado: Boolean(c.pdf_path) && pdfsValidados.has(`${c.ennychat_fatura_id}|${c.pdf_path}`),
      aceitos: a.aceitos,
      incertos: a.incertos,
      ativo: a.ativo,
      statusAceitos: cfg.statusAceitos,
    });
    return {
      cliente_id: c.id,
      nome: c.nome,
      email: c.email,
      os_numero: c.os_numero,
      valor: c.valor,
      vencimento: c.vencimento,
      pdf_url: c.pdf_path ? urlProxyArquivo('faturas', c.pdf_path) : null,
      aceitos: a.aceitos,
      tentativas: a.tentativas,
      ultimo_status: a.ultimo?.status ?? null,
      elegivel,
      motivos,
    };
  });
}

// Uso da cota diária da conta Brevo: COMPARTILHADA (todos os operadores). `aceito_em` do dia de Brasília + o que está reservado.
export async function usoDiario(agora = new Date()) {
  const inicio = `${hojeBrt(agora)}T00:00:00-03:00`;
  const [u, r] = await Promise.all([
    supabase.from('email_envios').select('id', { count: 'exact', head: true }).gte('aceito_em', inicio),
    supabase.from('email_envios').select('id', { count: 'exact', head: true }).in('status', ['na_fila', 'processando']).is('aceito_em', null),
  ]);
  if (u.error) throw u.error;
  if (r.error) throw r.error;
  return { usados: u.count ?? 0, reservados: r.count ?? 0 };
}
