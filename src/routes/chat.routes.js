import { Router } from 'express';
import multer from 'multer';
import { supabase, CHAT_BUCKET } from '../lib/supabase.js';
import { enviarMensagemTexto, enviarMensagemComAnexo, validarNumero } from '../services/whatsapp.js';
import { registrarMensagemSaida } from '../services/chatIngest.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB -- mesma ordem de grandeza do WhatsApp
});

function tipoPorMimetype(mimetype) {
  if (!mimetype) return 'documento';
  if (mimetype.startsWith('image/')) return 'imagem';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'documento';
}

// Lista conversas, mais recente primeiro
router.get('/conversas', async (req, res) => {
  const { data, error } = await supabase
    .from('conversas')
    .select('*, clientes(nome)')
    .order('ultima_mensagem_em', { ascending: false, nullsFirst: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Histórico de mensagens de uma conversa
router.get('/conversas/:id/mensagens', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('mensagens')
    .select('*')
    .eq('conversa_id', id)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Marca conversa como lida (zera o contador de não lidas)
router.post('/conversas/:id/marcar-lida', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('conversas')
    .update({ nao_lidas: 0 })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Envia uma resposta pro cliente (texto e/ou anexo) e grava no histórico do chat
router.post('/conversas/:id/mensagens', upload.single('anexo'), async (req, res) => {
  const { id } = req.params;
  const mensagem = (req.body?.mensagem || '').trim();

  if (!mensagem && !req.file) {
    return res.status(400).json({ error: 'envie uma mensagem ou um anexo' });
  }

  const { data: conversa, error: conversaError } = await supabase
    .from('conversas')
    .select('telefone')
    .eq('id', id)
    .maybeSingle();

  if (conversaError) return res.status(500).json({ error: conversaError.message });
  if (!conversa) return res.status(404).json({ error: 'conversa não encontrada' });

  try {
    let anexoUrl = null;
    let anexoNome = null;
    let tipo = 'texto';

    if (req.file) {
      tipo = tipoPorMimetype(req.file.mimetype);
      const caminho = `${conversa.telefone}/${Date.now()}-${req.file.originalname}`;

      const { error: uploadError } = await supabase.storage
        .from(CHAT_BUCKET)
        .upload(caminho, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage.from(CHAT_BUCKET).getPublicUrl(caminho);
      anexoUrl = publicUrlData.publicUrl;
      anexoNome = req.file.originalname;
    }

    // Confirma o JID real antes de mandar -- mesma regra do disparo em massa
    // (dispatchQueue.js). Sem isso o Baileys aceita o envio sem erro mas manda
    // pra um número "adivinhado" que pode não bater com o dispositivo real.
    const { existe, jid } = await validarNumero(conversa.telefone);
    if (!existe) {
      return res.status(400).json({ error: 'Este número não foi encontrado no WhatsApp' });
    }

    const { messageId } = anexoUrl
      ? await enviarMensagemComAnexo({
          numero: conversa.telefone,
          jid,
          mensagem,
          anexoUrl,
          anexoNome,
          anexoTipo: tipo,
          anexoMimetype: req.file.mimetype,
        })
      : await enviarMensagemTexto({ numero: conversa.telefone, jid, mensagem });

    const { mensagem: linhaSalva } = await registrarMensagemSaida({
      telefone: conversa.telefone,
      texto: mensagem || null,
      tipo,
      anexoUrl,
      anexoNome,
      messageId,
    });

    res.status(201).json(linhaSalva);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
