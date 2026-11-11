// Disparo / E-mail -- worker do lote (em segundo plano, neste processo). Uma tarefa por fatura, sequencial.
// Antes de CADA envio: revalida a elegibilidade com a política vigente (status aceito + verificado, e-mail, valor,
// vencimento, PDF validado, sem envio anterior) e só então chama a Brevo. Nunca envia sem configuração.
// ponytail: fila em memória, 1 instância (mesma premissa do dispatchQueue.js). Com 2+ instâncias precisa de lock no banco.
import { supabase, BUCKET } from '../lib/supabase.js';
import { armazenamento } from '../lib/armazenamento.js';
import { logLimitado } from '../lib/log.js';
import { descreverErro } from '../lib/redigir.js';
import { avaliarElegibilidade, hojeBrt, vencimentoParaIso } from '../lib/email/elegibilidade.js';
import { renderizarEmail, formatarValor, formatarDataIso, mesReferencia, primeiroNome, assuntoFatura } from '../lib/email/modelo.js';
import { configuracaoBrevo, enviarTransacional, procurarEnvioRecente } from '../lib/email/brevo.js';
import { JANELA_DIAS, STATUS_MAX_IDADE_H, lerConfigEmail } from '../lib/email/dados.js';
import { MOTIVOS_INCERTOS } from '../lib/email/constantes.js';

const ATRASO_ENTRE_ENVIOS_MS = Number(process.env.EMAIL_ATRASO_MS) || 250;
const MAX_TENTATIVAS = 3;
const ESPERAS_MS = [2000, 6000];
const ANEXO_MAX_BYTES = 4 * 1024 * 1024; // limite de anexo da Brevo (~4MB)
const emExecucao = new Set();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export function iniciarLote(loteId, deps = {}) {
  if (emExecucao.has(loteId)) return;
  emExecucao.add(loteId);
  processarLote(loteId, deps)
    .catch((err) => logLimitado('email-lote', 'error', '[email] lote falhou:', descreverErro(err)))
    .finally(() => emExecucao.delete(loteId));
}

// Boot: itens que estavam "processando" quando o processo caiu NÃO são reenviados sozinhos (podem ter sido aceitos
// sem registro) -- viram falhou/interrompido, que conta como ENVIO INCERTO e bloqueia nova seleção até reenvio explícito;
// os que ainda estavam na fila retomam.
export async function recuperarEmailsTravados() {
  await supabase.from('email_envios').update({ status: 'falhou', motivo: 'interrompido', atualizado_em: new Date().toISOString() }).eq('status', 'processando');
  const { data } = await supabase.from('email_lotes').select('id').eq('status', 'em_andamento');
  for (const l of data || []) iniciarLote(l.id);
}

async function atualizar(id, campos) {
  const { error } = await supabase.from('email_envios').update({ ...campos, atualizado_em: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

async function proximaDaFila(loteId) {
  const { data } = await supabase.from('email_envios').select('id').eq('lote_id', loteId).eq('status', 'na_fila').order('criado_em').order('id').limit(1);
  return data?.[0]?.id ?? null;
}

export async function processarLote(loteId, deps = {}) {
  for (;;) {
    const { data: lote } = await supabase.from('email_lotes').select('*').eq('id', loteId).maybeSingle();
    if (!lote || lote.status === 'cancelado') return;
    const id = await proximaDaFila(loteId);
    if (!id) break;
    // "Pega" o item de forma atômica: dois processadores nunca enviam o mesmo.
    const { data: item } = await supabase.from('email_envios').update({ status: 'processando', atualizado_em: new Date().toISOString() })
      .eq('id', id).eq('status', 'na_fila').select('*').maybeSingle();
    if (!item) continue;
    try {
      await processarItem(item, lote, deps);
    } catch (err) {
      logLimitado('email-item', 'error', '[email] item falhou:', descreverErro(err));
      await atualizar(item.id, { status: 'falhou', motivo: item.__tocouProvedor ? 'erro_apos_envio' : 'erro_interno' }).catch(() => {});
    }
    await dormir(deps.atrasoMs ?? ATRASO_ENTRE_ENVIOS_MS);
  }
  const { count } = await supabase.from('email_envios').select('id', { count: 'exact', head: true }).eq('lote_id', loteId).in('status', ['na_fila', 'processando']);
  if (!count) await supabase.from('email_lotes').update({ status: 'concluido', concluido_em: new Date().toISOString() }).eq('id', loteId).eq('status', 'em_andamento');
}

async function processarItem(item, lote, deps) {
  const cfg = deps.cfgBrevo ?? configuracaoBrevo();
  if (!cfg.configurado) return atualizar(item.id, { status: 'cancelado', motivo: 'sem_configuracao' });
  const enviar = deps.enviar ?? enviarTransacional;
  const procurar = deps.procurar ?? procurarEnvioRecente;

  // ---- revalida com o estado MAIS RECENTE conhecido (política de status pode ter mudado com o lote na fila) ----
  const [conf, cli, anx, enviosFatura] = await Promise.all([
    lerConfigEmail(),
    supabase.from('clientes').select('id, nome, email, valor, vencimento, pdf_path, ennychat_fatura_id, ennychat_status, ennychat_status_em').eq('id', item.cliente_id).eq('usuario_id', item.usuario_id).eq('campanha', 'cobranca').maybeSingle(),
    supabase.from('ennychat_anexos').select('pdf_path').eq('usuario_id', item.usuario_id).eq('fatura_externa_id', item.fatura_externa_id ?? '').eq('estado', 'vinculado'),
    // histórico DESTA fatura (não só deste cliente): sobrevive a apagar/reimportar o cadastro
    supabase.from('email_envios').select('id, status, motivo, aceito_em').eq('fatura_externa_id', item.fatura_externa_id ?? '').neq('id', item.id),
  ]);
  const c = cli.data;
  if (!c || c.ennychat_fatura_id !== item.fatura_externa_id) return atualizar(item.id, { status: 'cancelado', motivo: 'cliente_removido' });
  const anteriores = enviosFatura.data || [];
  const ver = avaliarElegibilidade({
    cliente: c,
    pdfValidado: Boolean(c.pdf_path) && (anx.data || []).some((a) => a.pdf_path === c.pdf_path),
    aceitos: lote.reenvio ? 0 : anteriores.filter((e) => e.aceito_em).length, // reenvio intencional não bloqueia por "já enviado"
    incertos: lote.reenvio ? 0 : anteriores.filter((e) => e.status === 'falhou' && MOTIVOS_INCERTOS.includes(e.motivo)).length,
    ativo: false,
    statusAceitos: conf.statusAceitos,
    hoje: hojeBrt(),
    janelaDias: JANELA_DIAS,
    statusMaxIdadeH: STATUS_MAX_IDADE_H,
    agoraMs: Date.now(),
  });
  // status desatualizado = pendente de verificação (a fatura volta a ser elegível depois de abrir Tratar); os demais cancelam.
  if (!ver.elegivel) return atualizar(item.id, { status: 'cancelado', motivo: ver.motivos[0] });

  // ---- e-mail: um destinatário, o PDF dessa fatura, HTML do repo com os valores escapados ----
  const baixado = await armazenamento.from(BUCKET).download(c.pdf_path);
  if (baixado.error || !baixado.data) return atualizar(item.id, { status: 'falhou', motivo: 'pdf_indisponivel' });
  const bytes = Buffer.from(await baixado.data.arrayBuffer());
  if (!bytes.length || bytes.length > ANEXO_MAX_BYTES) return atualizar(item.id, { status: 'falhou', motivo: 'pdf_tamanho' });

  const iso = vencimentoParaIso(c.vencimento);
  const mes = mesReferencia(iso);
  const assunto = assuntoFatura(mes);
  const html = renderizarEmail({ empresa: lote.nome_empresa, primeiro_nome: primeiroNome(c.nome), mes_referencia: mes, vencimento: formatarDataIso(iso), valor: formatarValor(c.valor) });
  const pedido = { cfg, para: c.email.trim(), assunto, html, anexoNome: 'fatura.pdf', anexoBase64: bytes.toString('base64') };

  let tentativas = item.tentativas;
  const comecou = new Date(); // instante desta tentativa: a reconciliação só considera e-mails a partir daqui
  for (let n = 0; n < MAX_TENTATIVAS; n++) {
    tentativas += 1;
    await atualizar(item.id, { tentativas });
    item.__tocouProvedor = true; // a partir daqui um erro NÃO pode fazer a fatura reaparecer como elegível
    const r = await enviar(pedido);
    if (r.ok) return registrarAceito(item.id, r.messageId, null);
    if (r.tipo === 'definitivo') return atualizar(item.id, { status: 'falhou', motivo: r.erro });
    if (r.tipo === 'incerto') {
      // Pode ter sido aceito: reconcilia com a Brevo ANTES de repetir -- duas consultas (a listagem demora a indexar).
      // Sem resposta da consulta = NÃO repete (fica incerto e bloqueado até reenvio explícito).
      const consulta = () => procurar({ cfg, para: pedido.para, assunto, desdeIso: new Date(comecou.getTime() - 60_000).toISOString() });
      let q = await consulta();
      if (q?.encontrado === false) {
        await dormir(deps.esperaReconciliarMs ?? 8000);
        q = await consulta();
      }
      if (q?.encontrado) return registrarAceito(item.id, q.messageId, 'reconciliado');
      if (q === null) return atualizar(item.id, { status: 'falhou', motivo: 'resultado_incerto' });
    }
    if (n < MAX_TENTATIVAS - 1) await dormir(deps.esperasMs?.[n] ?? ESPERAS_MS[n]); // 429 ou incerto não encontrado: repete
  }
  return atualizar(item.id, { status: 'falhou', motivo: 'tentativas_esgotadas' });
}

// Depois do 201 da Brevo o registro é o que protege contra duplicata: tenta de novo antes de desistir.
async function registrarAceito(id, messageId, motivo) {
  let ultimo;
  for (let i = 0; i < 3; i++) {
    try {
      return await atualizar(id, { status: 'aceito', message_id: messageId, aceito_em: new Date().toISOString(), motivo });
    } catch (err) {
      ultimo = err;
      await dormir(300 * (i + 1));
    }
  }
  throw ultimo; // o catch do lote grava 'erro_apos_envio' (incerto: bloqueia novo envio)
}
