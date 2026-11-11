import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { supabase, BUCKET } from '../lib/supabase.js';
import { armazenamento } from '../lib/armazenamento.js';
import { propagarDadosFatura } from '../lib/faturaPropagacao.js';
import { comTratamentoDeErroUpload } from '../lib/uploadComTratamentoDeErro.js';
import { limiteImportacaoArquivo } from '../lib/rateLimit.js';
import { descreverErro } from '../lib/redigir.js';
import { logLimitado } from '../lib/log.js';
import { avaliarStatus, idExternoValido, pagoOuEncerrado, validarCamposAnexo, validarFatura, validarItensCatalogo } from '../lib/ennychat/payload.js';
import { escolherCliente, planejarSync } from '../lib/ennychat/cliente.js';
import { avaliarVinculo, ehPdf } from '../lib/ennychat/vinculo.js';
import { lerBoletoPdf } from '../services/ennychatPdf.js';
import { persistirExtracaoPix } from '../lib/pixPersistencia.js';

// Integração EnnyChat (recebimento). Contrato: ENNYCHAT_CONTRATO.md (raiz do projeto).
// Tudo escopado por req.user.id; `responsavel` do EnnyChat nunca é usado.
const router = Router();

const ANEXO_MAX_MB = 20;
const REPROCESSAR_PROCESSANDO_APOS_MS = 5 * 60 * 1000;
const REPROCESSAR_PENDENTE_APOS_MS = 60 * 1000;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ANEXO_MAX_MB * 1024 * 1024, files: 1 } });
const uploadPdf = comTratamentoDeErroUpload(upload.single('arquivo'), { limiteMb: ANEXO_MAX_MB, logPrefixo: '[ennychat]' });

const erro500 = (res, err, ctx) => {
  logLimitado(`ennychat-${ctx}`, 'error', `[ennychat] ${ctx}:`, descreverErro(err));
  return res.status(500).json({ error: 'Não foi possível processar agora. Tente novamente.' });
};

// ---------- config global ----------
async function lerConfig() {
  const { data, error } = await supabase.from('ennychat_config').select('chave, valor');
  if (error) throw error;
  const mapa = Object.fromEntries((data || []).map((l) => [l.chave, l.valor]));
  return {
    status_aceitos: Array.isArray(mapa.status_aceitos) ? mapa.status_aceitos : [],
    catalogo: Array.isArray(mapa.catalogo) ? mapa.catalogo : [],
  };
}

const gravarConfig = (chave, valor) =>
  supabase.from('ennychat_config').upsert({ chave, valor, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });

router.get('/config', async (req, res) => {
  try {
    res.json({ versao: 1, ...(await lerConfig()) });
  } catch (err) {
    erro500(res, err, 'config');
  }
});

// Qualquer usuário autenticado edita (decisão do dono: uso pessoal, sem papel de gestão). Para restringir de novo: requireSupervisor aqui.
router.put('/config', async (req, res) => {
  try {
    const aceitos = req.body?.status_aceitos;
    if (!Array.isArray(aceitos) || aceitos.some((c) => typeof c !== 'string')) {
      return res.status(400).json({ error: 'status_aceitos deve ser uma lista de códigos.' });
    }
    const cfg = await lerConfig();
    const conhecidos = new Set(cfg.catalogo.map((i) => i.codigo));
    if (aceitos.some((c) => !conhecidos.has(c))) {
      return res.status(400).json({ error: 'Há código que não existe no catálogo de status.' });
    }
    const unicos = [...new Set(aceitos)];
    const { error } = await gravarConfig('status_aceitos', unicos);
    if (error) throw error;
    res.json({ versao: 1, ...cfg, status_aceitos: unicos });
  } catch (err) {
    erro500(res, err, 'config-put');
  }
});

router.post('/catalogo', async (req, res) => {
  try {
    const novos = validarItensCatalogo(req.body?.itens);
    if (!novos) return res.status(400).json({ error: 'Formato inválido.' });
    const cfg = await lerConfig();
    const mapa = new Map(cfg.catalogo.map((i) => [i.codigo, i]));
    for (const i of novos) if (!mapa.has(i.codigo)) mapa.set(i.codigo, i); // não reescreve rótulo existente
    const catalogo = [...mapa.values()].slice(0, 500);
    const { error } = await gravarConfig('catalogo', catalogo);
    if (error) throw error;
    res.json({ total: catalogo.length });
  } catch (err) {
    erro500(res, err, 'catalogo');
  }
});

// ---------- helpers ----------
const clientePorFatura = async (usuarioId, idExterno) => {
  const { data, error } = await supabase
    .from('clientes').select('*').eq('usuario_id', usuarioId).eq('ennychat_fatura_id', idExterno).limit(2);
  if (error) throw error;
  return data?.length === 1 ? data[0] : null;
};

// Busca injetada em escolherCliente: sempre dentro da carteira de cobrança do usuário.
const buscarClientes = (usuarioId) => async (criterio, valor) => {
  let q = supabase.from('clientes').select('*').eq('usuario_id', usuarioId).limit(3);
  if (criterio === 'ennychat_fatura_id') q = q.eq('ennychat_fatura_id', valor);
  else q = q.eq('campanha', 'cobranca').in(criterio, Array.isArray(valor) ? valor : [valor]);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
};

const ultimoAnexo = async (usuarioId, idExterno) => {
  const { data } = await supabase
    .from('ennychat_anexos').select('anexo_id, estado, motivo, verificacoes, atualizado_em')
    .eq('usuario_id', usuarioId).eq('fatura_externa_id', idExterno)
    .order('atualizado_em', { ascending: false }).limit(1);
  return data?.[0] ?? null;
};

const estadoPdf = (anexo) => anexo?.estado ?? 'aguardando';

// O Pix também precisa aparecer na aba "Extrator de PIX" (a planilha do supervisor é atualizada a partir de pix_extracoes).
// Idempotente: reprocessar o mesmo boleto não cria linha repetida. Nunca derruba o vínculo (só registra o erro).
async function registrarNaAbaPix({ usuarioId, cliente, lido }) {
  try {
    const { data: ja } = await supabase.from('pix_extracoes').select('id').eq('usuario_id', usuarioId).eq('pix_code', lido.pix).limit(1);
    if (ja?.length) {
      await supabase.from('pix_extracoes').update({ cliente_id: cliente.id, codigo: lido.codigo, nome: lido.nome }).eq('id', ja[0].id).eq('usuario_id', usuarioId);
      return;
    }
    await persistirExtracaoPix({
      usuarioId,
      arquivo: `${cliente.nome ?? 'boleto'}.pdf`.slice(0, 120),
      pixCopiaCola: lido.pix,
      valor: null, // o valor vem do EnnyChat, não do PDF
      vencimento: lido.vencimento ?? cliente.vencimento ?? null,
      linhaDigitavel: lido.linhaDigitavel ?? null,
      clienteId: cliente.id,
      codigo: lido.codigo,
      nome: lido.nome,
      origem: 'ennychat',
    });
  } catch (err) {
    logLimitado('ennychat-aba-pix', 'error', '[ennychat] registrar Pix na aba Extrator:', descreverErro(err));
  }
}

// ---------- POST /faturas/sync ----------
router.post('/faturas/sync', limiteImportacaoArquivo, async (req, res) => {
  try {
    const v = validarFatura(req.body);
    if (!v.ok) return res.json({ estado: 'erro_validacao', motivo: `campo_invalido:${v.campo}`, cliente_id: null, criado: false, conflitos: [], pdf: 'aguardando', pix: false });
    const { fatura } = v;
    const usuarioId = req.user.id;
    const base = { cliente_id: null, criado: false, conflitos: [], pdf: 'aguardando', pix: false };

    // Lista de permissão: nada é criado nem gravado fora dela.
    const { status_aceitos: aceitos } = await lerConfig();
    const st = avaliarStatus(fatura.status_operador, aceitos);
    if (!st.permitido) return res.json({ ...base, estado: 'bloqueado_status', motivo: st.motivo });
    if (pagoOuEncerrado(fatura)) return res.json({ ...base, estado: 'pendente_revisao', motivo: 'pagamento_ou_encerrado' });

    const escolha = await escolherCliente(fatura, buscarClientes(usuarioId));
    const plano = planejarSync({ usuarioId, fatura, escolha, agora: new Date().toISOString() });
    if (plano.acao === 'pendente') return res.json({ ...base, estado: 'pendente_revisao', motivo: plano.motivo });

    let cliente;
    let criado = false;
    if (plano.acao === 'criar') {
      const { data, error } = await supabase.from('clientes').insert(plano.linha).select('*').single();
      if (error?.code === '23505') {
        // Corrida/duplicata (mesma fatura ou mesmo telefone): relê; se for a mesma fatura, é idempotência.
        const existente = await clientePorFatura(usuarioId, fatura.id_externo);
        if (!existente) return res.json({ ...base, estado: 'pendente_revisao', motivo: 'alvo_ambiguo' });
        cliente = existente;
      } else if (error) throw error;
      else { cliente = data; criado = true; }
    } else {
      const { error } = await supabase.from('clientes').update(plano.campos).eq('id', plano.cliente.id).eq('usuario_id', usuarioId);
      if (error) throw error;
      if (Object.keys(plano.camposFatura).length) {
        const r = await propagarDadosFatura(plano.cliente.id, usuarioId, plano.camposFatura);
        if (r.error) throw r.error;
      }
      cliente = { ...plano.cliente, ...plano.campos, ...plano.camposFatura };
    }

    const anexo = await ultimoAnexo(usuarioId, fatura.id_externo);
    res.json({
      estado: 'sincronizado',
      motivo: null,
      cliente_id: cliente.id,
      criado,
      conflitos: plano.acao === 'atualizar' ? plano.conflitos : [],
      pdf: estadoPdf(anexo),
      ultimo_anexo_id: anexo?.anexo_id ?? null, // a extensão só baixa/envia o PDF se este anexo ainda não foi vinculado
      pdf_motivo: anexo?.motivo ?? null,
      pdf_atualizado_em: anexo?.atualizado_em ?? null,
      pix: Boolean(cliente.pix_code),
    });
  } catch (err) {
    erro500(res, err, 'sync');
  }
});

// ---------- POST /faturas/:idExterno/anexo ----------
const resposta = (cliente, estado, motivo, verificacoes, extra = {}) => ({
  estado, motivo, cliente_id: cliente?.id ?? null, pix: Boolean(verificacoes?.pix), verificacoes: verificacoes ?? null, repetido: false, ...extra,
});

router.post('/faturas/:idExterno/anexo', limiteImportacaoArquivo, uploadPdf, async (req, res) => {
  try {
    const usuarioId = req.user.id;
    const idExterno = req.params.idExterno;
    if (!idExternoValido(idExterno)) return res.status(400).json({ error: 'Fatura inválida.' });
    const campos = validarCamposAnexo(req.body);
    if (!campos.ok) return res.status(400).json({ error: `Campo inválido: ${campos.campo}.` });
    if (!req.file) return res.status(400).json({ error: 'Envie o arquivo PDF.' });

    const { status_aceitos: aceitos } = await lerConfig();
    if (!avaliarStatus(campos.statusOperador, aceitos).permitido) {
      return res.json(resposta(null, 'bloqueado_status', 'status_fora_da_lista', null)); // nada é gravado
    }
    const cliente0 = await clientePorFatura(usuarioId, idExterno);
    if (!cliente0) return res.status(409).json({ estado: 'sem_cadastro', error: 'Sincronize o cadastro da fatura antes.' });
    // O status gravado (sync/bloqueio) também precisa estar na lista: o do corpo sozinho não basta.
    if (!avaliarStatus(cliente0.ennychat_status, aceitos).permitido) {
      return res.json(resposta(cliente0, 'bloqueado_status', 'status_fora_da_lista', null));
    }

    const bytes = req.file.buffer;
    if (!ehPdf(bytes)) return res.json(resposta(cliente0, 'pendente_revisao', 'pdf_invalido', null));

    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const chave = { usuario_id: usuarioId, fatura_externa_id: idExterno, anexo_id: campos.anexoId };

    // Idempotência: o mesmo anexo (ou o mesmo conteúdo) devolve o resultado salvo,
    // exceto falha transitória de leitura / "processando" abandonado, que reprocessam.
    const { data: porAnexo } = await supabase.from('ennychat_anexos').select('*').eq('usuario_id', usuarioId)
      .eq('fatura_externa_id', idExterno).eq('anexo_id', campos.anexoId).limit(1).maybeSingle();
    const existente = porAnexo ?? (await supabase.from('ennychat_anexos').select('*').eq('usuario_id', usuarioId)
      .eq('fatura_externa_id', idExterno).eq('sha256', sha256).limit(1).maybeSingle()).data;
    let linhaId;
    if (existente) {
      const idade = Date.now() - new Date(existente.atualizado_em).getTime();
      // Vinculado e processando recente = resultado salvo. Pendência é reavaliada (o cadastro pode ter
      // sido corrigido), com intervalo mínimo para não repetir OCR a cada abertura da ficha.
      // O arquivo ORIGINAL que o operador subiu (campos.origem = 'upload') tem prioridade: sempre reavalia uma pendência.
      const reprocessar =
        existente.cliente_id !== cliente0.id ||
        (existente.estado === 'pendente_revisao' && (idade > REPROCESSAR_PENDENTE_APOS_MS || campos.origem === 'upload')) ||
        (existente.estado === 'processando' && idade > REPROCESSAR_PROCESSANDO_APOS_MS);
      if (!reprocessar) return res.json(resposta(cliente0, existente.estado, existente.motivo, existente.verificacoes, { repetido: true }));
      linhaId = existente.id;
      await supabase.from('ennychat_anexos').update({ estado: 'processando', motivo: null, cliente_id: cliente0.id, atualizado_em: new Date().toISOString() }).eq('id', linhaId);
    } else {
      const { data, error } = await supabase.from('ennychat_anexos')
        .insert({ ...chave, sha256, estado: 'processando', cliente_id: cliente0.id }).select('id').single();
      if (error?.code === '23505') return res.json(resposta(cliente0, 'processando', null, null, { repetido: true })); // simultâneo
      if (error) throw error;
      linhaId = data.id;
    }
    const gravar = (patch) =>
      supabase.from('ennychat_anexos').update({ ...patch, atualizado_em: new Date().toISOString() }).eq('id', linhaId);

    try {
    let lido;
    try {
      lido = await lerBoletoPdf(bytes);
    } catch (err) {
      logLimitado('ennychat-leitura', 'error', '[ennychat] leitura do PDF:', descreverErro(err));
      await gravar({ estado: 'pendente_revisao', motivo: 'extracao_falhou' });
      return res.json(resposta(cliente0, 'pendente_revisao', 'extracao_falhou', null));
    }

    // Valor/vencimento opcionais do corpo só preenchem o que está vazio (mesma regra do sync).
    const extras = {};
    if (campos.valor !== null && (cliente0.valor === null || cliente0.valor === undefined)) extras.valor = campos.valor;
    if (campos.vencimento && !cliente0.vencimento) extras.vencimento = campos.vencimento;
    if (Object.keys(extras).length) await propagarDadosFatura(cliente0.id, usuarioId, extras);

    // Revalida o alvo DEPOIS da leitura (o cadastro pode ter mudado enquanto o PDF processava).
    const alvo = await clientePorFatura(usuarioId, idExterno);
    if (!alvo) {
      await gravar({ estado: 'pendente_revisao', motivo: 'alvo_ambiguo' });
      return res.json(resposta(cliente0, 'pendente_revisao', 'alvo_ambiguo', null));
    }
    const aval = avaliarVinculo({ alvo, extraido: lido, pixValido: Boolean(lido.pix) });
    // Só a FORMA do código lido (dígitos mascarados) + 3 últimos dígitos: ajuda a descobrir como o Código do boleto
    // se relaciona com a OS do EnnyChat sem gravar o número inteiro.
    const formaCodigo = lido.codigo ? { forma: String(lido.codigo).replace(/\d/g, 'N'), fim3: String(lido.codigo).replace(/\D/g, '').slice(-3) } : null;
    aval.verificacoes = { ...aval.verificacoes, diag: { ...lido.diag, codigo: formaCodigo } };

    if (aval.estado !== 'vinculado') {
      await gravar({ estado: 'pendente_revisao', motivo: aval.motivo, verificacoes: aval.verificacoes });
      return res.json(resposta(alvo, 'pendente_revisao', aval.motivo, aval.verificacoes));
    }

    const pdfPath = `${alvo.id}/${Date.now()}-ennychat.pdf`;
    const { error: upErr } = await armazenamento.from(BUCKET).upload(pdfPath, bytes, { contentType: 'application/pdf', upsert: false });
    if (upErr) throw upErr;
    const r = await propagarDadosFatura(alvo.id, usuarioId, { pdf_path: pdfPath, pdf_atualizado_em: new Date().toISOString(), pix_code: lido.pix });
    if (r.error) throw r.error;
    await gravar({ estado: 'vinculado', motivo: null, verificacoes: aval.verificacoes, pdf_path: pdfPath, cliente_id: alvo.id });
    await registrarNaAbaPix({ usuarioId, cliente: alvo, lido });
    return res.json(resposta(alvo, 'vinculado', null, aval.verificacoes));
    } catch (err) {
      // Falha depois do insert (storage, banco): não deixa a linha presa em 'processando'.
      await gravar({ estado: 'pendente_revisao', motivo: 'extracao_falhou' }).catch(() => {});
      throw err;
    }
  } catch (err) {
    erro500(res, err, 'anexo');
  }
});

// ---------- POST /faturas/:idExterno/bloqueio ----------
router.post('/faturas/:idExterno/bloqueio', async (req, res) => {
  try {
    const { idExterno } = req.params;
    const status = typeof req.body?.status_operador === 'string' ? req.body.status_operador : '';
    if (!idExternoValido(idExterno) || !status.trim() || status.length > 100) return res.status(400).json({ error: 'Dados inválidos.' });
    const cliente = await clientePorFatura(req.user.id, idExterno);
    if (!cliente) return res.status(404).json({ error: 'Fatura não vinculada.' }); // nunca cria
    const { error } = await supabase.from('clientes')
      .update({ ennychat_status: status, ennychat_status_em: new Date().toISOString() })
      .eq('id', cliente.id).eq('usuario_id', req.user.id);
    if (error) throw error;
    res.json({ estado: 'bloqueado' });
  } catch (err) {
    erro500(res, err, 'bloqueio');
  }
});

// ---------- GET /faturas/:idExterno/estado ----------
router.get('/faturas/:idExterno/estado', async (req, res) => {
  try {
    const { idExterno } = req.params;
    if (!idExternoValido(idExterno)) return res.status(400).json({ error: 'Fatura inválida.' });
    const cliente = await clientePorFatura(req.user.id, idExterno);
    const anexo = cliente ? await ultimoAnexo(req.user.id, idExterno) : null;
    res.json({
      sincronizado: Boolean(cliente),
      cliente_id: cliente?.id ?? null,
      pdf: estadoPdf(anexo),
      pix: Boolean(cliente?.pix_code),
      ultimo_anexo_id: anexo?.anexo_id ?? null,
      motivo: anexo?.motivo ?? null,
      verificacoes: anexo?.verificacoes ?? null,
      atualizado_em: anexo?.atualizado_em ?? cliente?.ennychat_status_em ?? null,
    });
  } catch (err) {
    erro500(res, err, 'estado');
  }
});

export default router;
