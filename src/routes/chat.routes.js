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
    .select('*, clientes(nome, pdf_url, pix_code)')
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

// Apaga a conversa e o histórico de mensagens dela (ex: contatos de teste, ou
// conversas fantasma criadas por um "@lid" não resolvido -- ver fix em chatIngest.js).
// mensagens some junto por causa do "on delete cascade" no schema.
router.delete('/conversas/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('conversas').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
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

// Manda a fatura (PDF) do cliente vinculado a essa conversa, e junto o código Pix
// já extraído do QR do PDF (se tiver) como mensagem de texto separada -- assim o
// cliente recebe o boleto E o "copia e cola" pronto, sem precisar escanear nada.
router.post('/conversas/:id/enviar-fatura', async (req, res) => {
  const { id } = req.params;
  const modo = req.body?.modo === 'pdf' || req.body?.modo === 'pix' ? req.body.modo : 'ambos';

  const { data: conversa, error: conversaError } = await supabase
    .from('conversas')
    .select('telefone, cliente_id, clientes(nome, pdf_url, pix_code)')
    .eq('id', id)
    .maybeSingle();

  if (conversaError) return res.status(500).json({ error: conversaError.message });
  if (!conversa) return res.status(404).json({ error: 'conversa não encontrada' });

  const cliente = conversa.clientes;
  if (!conversa.cliente_id || !cliente) {
    return res.status(400).json({ error: 'Este contato não está vinculado a um cliente cadastrado' });
  }
  if (modo === 'pdf' && !cliente.pdf_url) {
    return res.status(400).json({ error: 'Este cliente não tem fatura (PDF) cadastrada' });
  }
  if (modo === 'pix' && !cliente.pix_code) {
    return res.status(400).json({ error: 'Não encontramos um código Pix nesta fatura' });
  }
  if (modo === 'ambos' && !cliente.pdf_url && !cliente.pix_code) {
    return res.status(400).json({ error: 'Este cliente não tem fatura nem código Pix cadastrados' });
  }

  try {
    const { existe, jid } = await validarNumero(conversa.telefone);
    if (!existe) return res.status(400).json({ error: 'Este número não foi encontrado no WhatsApp' });

    const nomeArquivo = `fatura-${cliente.nome || 'cliente'}.pdf`;

    let linhaFatura = null;
    if ((modo === 'pdf' || modo === 'ambos') && cliente.pdf_url) {
      const { messageId } = await enviarMensagemComAnexo({
        numero: conversa.telefone,
        jid,
        anexoUrl: cliente.pdf_url,
        anexoNome: nomeArquivo,
        anexoTipo: 'documento',
        anexoMimetype: 'application/pdf',
      });
      const { mensagem } = await registrarMensagemSaida({
        telefone: conversa.telefone,
        texto: null,
        tipo: 'documento',
        anexoUrl: cliente.pdf_url,
        anexoNome: nomeArquivo,
        messageId,
      });
      linhaFatura = mensagem;
    }

    let linhaPix = null;
    if ((modo === 'pix' || modo === 'ambos') && cliente.pix_code) {
      const textoPix = `Código Pix (copia e cola):\n${cliente.pix_code}`;
      const { messageId: pixMessageId } = await enviarMensagemTexto({
        numero: conversa.telefone,
        jid,
        mensagem: textoPix,
      });
      const { mensagem } = await registrarMensagemSaida({
        telefone: conversa.telefone,
        texto: textoPix,
        tipo: 'texto',
        messageId: pixMessageId,
      });
      linhaPix = mensagem;
    }

    res.status(201).json({ fatura: linhaFatura, pix: linhaPix });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
