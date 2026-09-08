import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import os from 'node:os';
import { supabase } from '../lib/supabase.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { responderExportacao } from '../lib/exportar.js';
import { escaparFiltroPostgrest } from '../lib/filtros.js';
import { persistirExtracaoPix } from '../lib/pixPersistencia.js';
import { extrairPixDeArquivoNoServidor } from '../services/extratorServidorPix.js';
import { limiteSensivel } from '../lib/rateLimit.js';

// [2026-08] Esta rota NÃO recebe mais PDF nenhum pro fluxo PADRÃO. O upload +
// extração de Pix (fatiar o PDF com pdf-lib, mandar cada página pro
// Cloudflare Worker de OCR) acontece 100% no navegador -- ver
// frontend/src/lib/pixExtractor.ts. O resultado já pronto é salvo via POST
// /api/boletos/salvar-pix (ver boletos.routes.js). Esta rota tem
// listagem/consulta das extrações já feitas, vínculo manual com cliente,
// exportação -- e, desde [2026-08], uma ÚNICA exceção que recebe PDF: POST
// /extrair-servidor, a "opção 2" de extração (ver bloco logo abaixo e
// services/extratorServidorPix.js pro porquê disso ser seguro em RAM).
const router = Router();

// ---------------------------------------------------------------------------
// POST /api/pix/extrair-servidor -- extração de Pix RODANDO NO BACKEND, 1 PDF
// POR REQUISIÇÃO. É a "opção 2" pedida pra quando a extração no navegador não
// é viável (aparelho fraco, muitos PDFs, navegador sem suporte a Worker) --
// ver CONTEXTO.md pro histórico de por que isso tinha sido removido antes e
// por que a forma de trazer de volta (1 arquivo por vez, diskStorage, fila em
// memória) é diferente e mais segura em RAM que a tentativa anterior.
//
// diskStorage (não memoryStorage) -- o arquivo vai direto pro disco temporário
// do SO, nunca inteiro num Buffer da aplicação. Apagado no `finally`, sempre.
const PIX_SERVIDOR_MAX_ARQUIVO_MB = Number(process.env.PIX_SERVIDOR_MAX_ARQUIVO_MB || 12);
const uploadServidor = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `pix-servidor-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`),
  }),
  limits: { fileSize: PIX_SERVIDOR_MAX_ARQUIVO_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Envie um arquivo PDF'));
    cb(null, true);
  },
});

function uploadServidorComTratamentoDeErro(req, res, next) {
  uploadServidor.single('pdf')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `PDF muito grande (limite: ${PIX_SERVIDOR_MAX_ARQUIVO_MB}MB por arquivo neste modo).` });
    }
    console.error('[pix] erro no upload de /extrair-servidor (multer):', err.message);
    return res.status(400).json({ error: err.message || 'Erro ao processar o upload' });
  });
}

router.post('/extrair-servidor', limiteSensivel, uploadServidorComTratamentoDeErro, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'arquivo pdf não enviado' });
  const usuarioId = req.user.id;
  const nomeOriginal = req.body?.arquivo || req.file.originalname || 'boleto.pdf';
  const clienteId = req.body?.clienteId || undefined;
  const caminhoTemp = req.file.path;

  try {
    const resultado = await extrairPixDeArquivoNoServidor(caminhoTemp);

    if (!resultado) {
      return res.status(200).json({ encontrado: false, arquivo: nomeOriginal });
    }

    const extracaoSalva = await persistirExtracaoPix({
      usuarioId,
      arquivo: nomeOriginal,
      pixCopiaCola: resultado.pixCopiaCola,
      clienteId,
      origem: 'servidor',
    });

    res.status(201).json({ encontrado: true, ...extracaoSalva, pagina: resultado.pagina });
  } catch (err) {
    console.error('[pix] erro em /extrair-servidor:', err);
    res.status(500).json({ error: err.message || 'Falha ao extrair o Pix no servidor' });
  } finally {
    // Apaga o temporário SEMPRE -- sucesso, falha ou "não encontrado". É o
    // que garante que este endpoint nunca acumula PDFs em disco.
    try { await fs.unlink(caminhoTemp); } catch (_) { /* já não existe / já foi limpo -- ok */ }
  }
});

function serializar(linha) {
  return {
    id: linha.id,
    arquivo: linha.arquivo,
    cliente_id: linha.cliente_id,
    cliente_nome: linha.clientes?.nome || null,
    status: linha.status,
    pix_code: linha.pix_code,
    valor: linha.valor,
    vencimento: linha.vencimento,
    linha_digitavel: linha.linha_digitavel,
    erro: linha.erro,
    criado_em: linha.criado_em,
  };
}

router.get('/', async (req, res) => {
  const { busca, status, cliente_id } = req.query;
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });

  let query = supabase
    .from('pix_extracoes')
    .select('*, clientes(nome)', { count: 'exact' })
    .eq('usuario_id', req.user.id)
    .order('criado_em', { ascending: false });

  if (busca) query = query.ilike('arquivo', `%${escaparFiltroPostgrest(busca)}%`);
  if (status && status !== 'todos') query = query.eq('status', status);
  if (cliente_id) query = query.eq('cliente_id', cliente_id);

  const { data, error } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  res.json((data || []).map(serializar));
});

// Grava o pix_code já extraído no cliente informado
router.post('/:id/aplicar', async (req, res) => {
  const { id } = req.params;
  const usuarioId = req.user.id;
  const { cliente_id } = req.body || {};
  if (!cliente_id) return res.status(400).json({ error: 'cliente_id é obrigatório' });

  const { data: linha, error } = await supabase
    .from('pix_extracoes')
    .select('pix_code, valor, vencimento, linha_digitavel')
    .eq('id', id)
    .eq('usuario_id', usuarioId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!linha) return res.status(404).json({ error: 'Extração não encontrada' });
  if (!linha.pix_code) return res.status(400).json({ error: 'Esta extração não tem um código Pix encontrado' });

  const { data: donoCliente } = await supabase.from('clientes').select('id').eq('id', cliente_id).eq('usuario_id', usuarioId).maybeSingle();
  if (!donoCliente) return res.status(404).json({ error: 'Cliente não encontrado' });

  const { error: updateError } = await supabase
    .from('clientes')
    .update({
      pix_code: linha.pix_code,
      ...(linha.valor ? { valor: linha.valor } : {}),
      ...(linha.vencimento ? { vencimento: linha.vencimento } : {}),
      ...(linha.linha_digitavel ? { linha_digitavel: linha.linha_digitavel } : {}),
    })
    .eq('id', cliente_id)
    .eq('usuario_id', usuarioId);
  if (updateError) return res.status(500).json({ error: updateError.message });

  const { data: atualizada, error: selectError } = await supabase
    .from('pix_extracoes')
    .update({ cliente_id })
    .eq('id', id)
    .eq('usuario_id', usuarioId)
    .select('*, clientes(nome)')
    .single();
  if (selectError) return res.status(500).json({ error: selectError.message });

  res.json(serializar(atualizada));
});

router.get('/exportar', async (req, res) => {
  const { formato = 'csv' } = req.query;
  const { data, error } = await supabase
    .from('pix_extracoes')
    .select('*, clientes(nome)')
    .eq('usuario_id', req.user.id)
    .order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  responderExportacao(res, formato, 'pix-extracoes', (data || []).map(serializar));
});

export default router;
