import { Router } from 'express';
import multer from 'multer';
import { supabase } from '../lib/supabase.js';
import { extrairPixDoPdf } from '../lib/pixFromPdf.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { responderExportacao } from '../lib/exportar.js';

const router = Router();
const PIX_BUCKET = process.env.SUPABASE_PIX_BUCKET || 'pix-extracoes';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Envie apenas arquivos PDF'));
    cb(null, true);
  },
});

// Tenta casar o código Pix extraído (ou o nome do arquivo) com um cliente já
// cadastrado, pelo nome -- best-effort, não é obrigatório pra ficar "encontrado".
async function tentarAcharCliente(nomeArquivo) {
  const nomeBase = nomeArquivo.replace(/\.pdf$/i, '').trim();
  if (!nomeBase) return null;
  const { data } = await supabase.from('clientes').select('id').ilike('nome', `%${nomeBase}%`).limit(1).maybeSingle();
  return data?.id || null;
}

async function processarExtracao(linha) {
  await supabase.from('pix_extracoes').update({ status: 'processando' }).eq('id', linha.id);

  try {
    const { data: arquivoBaixado, error: downloadError } = await supabase.storage
      .from(PIX_BUCKET)
      .download(linha.storage_path);
    if (downloadError) throw downloadError;

    const buffer = Buffer.from(await arquivoBaixado.arrayBuffer());
    const pixCode = await extrairPixDoPdf(buffer);
    const clienteId = await tentarAcharCliente(linha.arquivo);

    const { data, error } = await supabase
      .from('pix_extracoes')
      .update({
        status: pixCode ? 'encontrado' : 'nao_encontrado',
        pix_code: pixCode,
        cliente_id: clienteId,
        erro: pixCode ? null : 'Nenhum código Pix encontrado no PDF',
      })
      .eq('id', linha.id)
      .select('*, clientes(nome)')
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    const { data } = await supabase
      .from('pix_extracoes')
      .update({ status: 'erro', erro: err.message })
      .eq('id', linha.id)
      .select('*, clientes(nome)')
      .single();
    return data;
  }
}

function serializar(linha) {
  return {
    id: linha.id,
    arquivo: linha.arquivo,
    cliente_id: linha.cliente_id,
    cliente_nome: linha.clientes?.nome || null,
    status: linha.status,
    pix_code: linha.pix_code,
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
    .order('criado_em', { ascending: false });

  if (busca) query = query.ilike('arquivo', `%${busca}%`);
  if (status && status !== 'todos') query = query.eq('status', status);
  if (cliente_id) query = query.eq('cliente_id', cliente_id);

  const { data, error } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  res.json((data || []).map(serializar));
});

// Sobe N PDFs (campo repetido `arquivos`) e processa a extração de cada um.
router.post('/', upload.array('arquivos'), async (req, res) => {
  const arquivos = req.files || [];
  if (!arquivos.length) return res.status(400).json({ error: 'envie ao menos um arquivo PDF (campo "arquivos")' });

  try {
    const resultados = [];
    for (const arquivo of arquivos) {
      const caminho = `${Date.now()}-${arquivo.originalname}`;
      const { error: uploadError } = await supabase.storage
        .from(PIX_BUCKET)
        .upload(caminho, arquivo.buffer, { contentType: 'application/pdf', upsert: true });
      if (uploadError) throw uploadError;

      const { data: linha, error: insertError } = await supabase
        .from('pix_extracoes')
        .insert({ arquivo: arquivo.originalname, storage_path: caminho, status: 'aguardando' })
        .select()
        .single();
      if (insertError) throw insertError;

      const processada = await processarExtracao(linha);
      resultados.push(serializar(processada));
    }

    res.status(201).json(resultados);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/reprocessar', async (req, res) => {
  const { id } = req.params;
  const { data: linha, error } = await supabase.from('pix_extracoes').select('*').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!linha) return res.status(404).json({ error: 'Extração não encontrada' });
  if (!linha.storage_path) return res.status(400).json({ error: 'Arquivo original não está mais disponível' });

  const processada = await processarExtracao(linha);
  res.json(serializar(processada));
});

// Grava o pix_code já extraído no cliente informado
router.post('/:id/aplicar', async (req, res) => {
  const { id } = req.params;
  const { cliente_id } = req.body || {};
  if (!cliente_id) return res.status(400).json({ error: 'cliente_id é obrigatório' });

  const { data: linha, error } = await supabase.from('pix_extracoes').select('pix_code').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!linha) return res.status(404).json({ error: 'Extração não encontrada' });
  if (!linha.pix_code) return res.status(400).json({ error: 'Esta extração não tem um código Pix encontrado' });

  const { error: updateError } = await supabase.from('clientes').update({ pix_code: linha.pix_code }).eq('id', cliente_id);
  if (updateError) return res.status(500).json({ error: updateError.message });

  const { data: atualizada, error: selectError } = await supabase
    .from('pix_extracoes')
    .update({ cliente_id })
    .eq('id', id)
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
    .order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  responderExportacao(res, formato, 'pix-extracoes', (data || []).map(serializar));
});

export default router;
