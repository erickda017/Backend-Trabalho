import { Router } from 'express';
import multer from 'multer';
import { supabase, BUCKET } from '../lib/supabase.js';
import { normalizarTelefone } from '../lib/telefone.js';

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

// Lista clientes
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('clientes')
    .select('*')
    .order('nome');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Cria cliente (sem PDF ainda)
router.post('/', async (req, res) => {
  const { nome, telefone, valor, vencimento } = req.body;

  if (!nome || !telefone) {
    return res.status(400).json({ error: 'nome e telefone são obrigatórios' });
  }

  // aceita "150,00" (padrão BR) além de "150.00" -- coluna no banco é numérica e rejeita vírgula
  const valorNormalizado = valor ? String(valor).trim().replace(',', '.') : null;
  // normaliza pra dígitos + código do país -- garante que o unique index em `telefone`
  // realmente evita duplicar o mesmo cliente cadastrado com formatações diferentes
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
  res.status(201).json(data);
});

// Upload/associação do PDF da fatura a um cliente
router.post('/:id/pdf', upload.single('pdf'), async (req, res) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: 'arquivo pdf não enviado' });

  const caminho = `${id}/${Date.now()}-${req.file.originalname}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(caminho, req.file.buffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) return res.status(500).json({ error: uploadError.message });

  const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(caminho);

  const { data, error } = await supabase
    .from('clientes')
    .update({ pdf_url: publicUrlData.publicUrl, pdf_path: caminho })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Histórico de envios de um cliente específico (todas as faturas/mensagens já enviadas a ele)
router.get('/:id/historico', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('envio_itens')
    .select('*, envios(template_mensagem, created_at)')
    .eq('cliente_id', id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Remove cliente (e o PDF associado no Storage, se houver, pra não deixar lixo no bucket)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  const { data: cliente } = await supabase
    .from('clientes')
    .select('pdf_path')
    .eq('id', id)
    .maybeSingle();

  const { error } = await supabase.from('clientes').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  if (cliente?.pdf_path) {
    const { error: storageError } = await supabase.storage.from(BUCKET).remove([cliente.pdf_path]);
    // não falha a requisição por isso -- o cliente já foi removido do banco, que é o que importa
    // pro usuário; loga só pra investigação manual se sobrar arquivo órfão no bucket
    if (storageError) console.error('[clientes] erro ao remover pdf do storage:', storageError.message);
  }

  res.json({ ok: true });
});

export default router;
