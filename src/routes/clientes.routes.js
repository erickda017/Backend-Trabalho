import { Router } from 'express';
import multer from 'multer';
import { supabase, BUCKET } from '../lib/supabase.js';
import { normalizarTelefone } from '../lib/telefone.js';
import { extrairPixDoPdf } from '../lib/pixFromPdf.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { escaparFiltroPostgrest } from '../lib/filtros.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB -- evita upload gigante travar a request
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Envie um arquivo PDF'));
    }
    cb(null, true);
  },
});

// Achata cliente_tags(tags(...)) pra um array simples `tags: [{id,nome,cor}]`
function achatarTags({ cliente_tags, ...c }) {
  return { ...c, tags: (cliente_tags || []).map((ct) => ct.tags).filter(Boolean) };
}

// Lista clientes (paginado, com filtros busca/tag/com_pix/sem_pix)
router.get('/', async (req, res) => {
  const { busca, tag, com_pix, sem_pix } = req.query;
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });

  let query = supabase
    .from('clientes')
    .select('*, cliente_tags(tags(id, nome, cor))', { count: 'exact' })
    .order('nome');

  if (busca) {
    const buscaEscapada = escaparFiltroPostgrest(busca);
    query = query.or(`nome.ilike.%${buscaEscapada}%,telefone.ilike.%${buscaEscapada}%`);
  }
  if (com_pix === 'true' || com_pix === '1') query = query.not('pix_code', 'is', null);
  if (sem_pix === 'true' || sem_pix === '1') query = query.is('pix_code', null);

  let clienteIdsPorTag = null;
  if (tag) {
    const { data: relacoes, error: tagError } = await supabase.from('cliente_tags').select('cliente_id').eq('tag_id', tag);
    if (tagError) return res.status(500).json({ error: tagError.message });
    clienteIdsPorTag = (relacoes || []).map((r) => r.cliente_id);
    if (!clienteIdsPorTag.length) return res.json([]);
    query = query.in('id', clienteIdsPorTag);
  }

  const { data, error } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  res.json((data || []).map(achatarTags));
});

// Busca um cliente específico
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('clientes')
    .select('*, cliente_tags(tags(id, nome, cor))')
    .eq('id', id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(achatarTags(data));
});

// Cria cliente (sem PDF ainda)
router.post('/', async (req, res) => {
  const { nome, telefone, valor, vencimento } = req.body;

  if (!nome || !telefone) {
    return res.status(400).json({ error: 'nome e telefone são obrigatórios' });
  }

  // aceita "150,00" (padrão BR) além de "150.00" -- coluna no banco é numérica e rejeita vírgula
  const valorNormalizado = valor ? String(valor).trim().replace(',', '.') : null;
  const telefoneNormalizado = normalizarTelefone(telefone);
  if (!telefoneNormalizado) {
    return res.status(400).json({ error: 'telefone inválido' });
  }

  const { data, error } = await supabase
    .from('clientes')
    .insert({ nome, telefone: telefoneNormalizado, valor: valorNormalizado, vencimento })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ...data, tags: [] });
});

// Upload/associação do PDF da fatura a um cliente
router.post('/:id/pdf', upload.single('pdf'), async (req, res) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: 'arquivo pdf não enviado' });

  const caminho = `${id}/${Date.now()}-${req.file.originalname}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(caminho, req.file.buffer, { contentType: 'application/pdf', upsert: true });

  if (uploadError) return res.status(500).json({ error: uploadError.message });

  const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(caminho);

  // Tenta achar um QR code Pix na fatura e já deixa salvo/atribuído ao cliente --
  // se não achar, pix_code fica null sem quebrar o upload em si.
  const pixCode = await extrairPixDoPdf(req.file.buffer);

  const { data, error } = await supabase
    .from('clientes')
    .update({ pdf_url: publicUrlData.publicUrl, pdf_path: caminho, pix_code: pixCode })
    .eq('id', id)
    .select('*, cliente_tags(tags(id, nome, cor))')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(achatarTags(data));
});

// Atualiza cliente
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, telefone, valor, vencimento } = req.body;

  const valorNormalizado = valor ? String(valor).trim().replace(',', '.') : null;
  const telefoneNormalizado = telefone ? normalizarTelefone(telefone) : undefined;
  if (telefone && !telefoneNormalizado) {
    return res.status(400).json({ error: 'telefone inválido' });
  }

  const { data, error } = await supabase
    .from('clientes')
    .update({
      nome,
      ...(telefoneNormalizado ? { telefone: telefoneNormalizado } : {}),
      valor: valorNormalizado,
      vencimento,
    })
    .eq('id', id)
    .select('*, cliente_tags(tags(id, nome, cor))')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(achatarTags(data));
});

// Histórico de envios de um cliente específico
router.get('/:id/historico', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('envio_itens')
    .select('id, status, status_entrega, erro, slot, enviado_em, created_at, envios(template_mensagem, created_at)')
    .eq('cliente_id', id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Remove cliente (e o PDF associado no Storage, se houver)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  const { data: cliente } = await supabase.from('clientes').select('pdf_path').eq('id', id).maybeSingle();

  const { error } = await supabase.from('clientes').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  if (cliente?.pdf_path) {
    const { error: storageError } = await supabase.storage.from(BUCKET).remove([cliente.pdf_path]);
    if (storageError) console.error('[clientes] erro ao remover pdf do storage:', storageError.message);
  }

  res.json({ ok: true });
});

export default router;
