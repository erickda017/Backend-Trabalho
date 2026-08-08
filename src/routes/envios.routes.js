import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import {
  processarDisparo,
  reenviarErros,
  disparoEmAndamento,
  montarMensagem,
} from '../services/dispatchQueue.js';
import {
  enviarMensagemComPdf,
  enviarMensagemTexto,
  validarNumero,
  isConnected,
} from '../services/whatsapp.js';
import { normalizarTelefone } from '../lib/telefone.js';

const router = Router();

// ---------------------------------------------------------------------------
// DISPARO DE TESTE
// ---------------------------------------------------------------------------
// Manda UMA mensagem real para um único destino, para conferir se o disparo está
// funcionando de ponta a ponta (conexão, número válido, template, PDF) antes de
// soltar o lote inteiro. NÃO cria envio nem envio_itens, e não conta no lote —
// é totalmente isolado do fluxo de produção (mas conta como mensagem real no
// WhatsApp, então use com parcimônia).
//
// body: {
//   telefone?: string,            // destino livre (se ausente, usa o do cliente)
//   cliente_id?: string,          // usa nome/valor/vencimento/PDF desse cliente
//   template_mensagem?: string,   // suporta {{nome}}, {{valor}}, {{vencimento}}
//   com_pdf?: boolean             // default true quando o cliente tem PDF
// }
router.post('/teste', async (req, res) => {
  const { telefone, cliente_id, template_mensagem, com_pdf = true } = req.body || {};

  if (!isConnected()) {
    return res.status(409).json({ error: 'WhatsApp não está conectado. Faça a leitura do QR Code na aba Conexão.' });
  }

  let cliente = null;
  if (cliente_id) {
    const { data, error } = await supabase.from('clientes').select('*').eq('id', cliente_id).single();
    if (error) return res.status(404).json({ error: 'Cliente não encontrado' });
    cliente = data;
  }

  const destino = telefone || cliente?.telefone;
  if (!destino) {
    return res.status(400).json({ error: 'Informe um telefone ou selecione um cliente para o teste' });
  }

  const template =
    template_mensagem ||
    '🔔 Teste de disparo do sistema. Se você recebeu esta mensagem, está tudo funcionando.';

  const mensagem = montarMensagem(template, cliente || { nome: 'Teste', valor: null, vencimento: null });
  const numeroNormalizado = normalizarTelefone(destino);

  try {
    const { existe } = await validarNumero(destino);
    if (!existe) {
      return res.status(422).json({
        ok: false,
        telefone: numeroNormalizado,
        error: 'Este número não existe no WhatsApp',
      });
    }

    const usarPdf = Boolean(com_pdf && cliente?.pdf_url);
    const resultado = usarPdf
      ? await enviarMensagemComPdf({
          numero: destino,
          mensagem,
          pdfUrl: cliente.pdf_url,
          pdfNome: `${cliente.nome || 'fatura'}.pdf`,
        })
      : await enviarMensagemTexto({ numero: destino, mensagem });

    return res.json({
      ok: true,
      telefone: numeroNormalizado,
      com_pdf: usarPdf,
      mensagem,
      messageId: resultado.messageId,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Falha ao enviar mensagem de teste' });
  }
});


// Cria um novo envio (lote de disparo) com uma lista de cliente_ids + template de mensagem.
// Se agendado_para for enviado (ISO datetime), o envio fica com status 'agendado' e o
// scheduler dispara automaticamente nesse horário -- senão fica 'pendente' aguardando clique manual.
router.post('/', async (req, res) => {
  const { cliente_ids, template_mensagem, agendado_para } = req.body;

  if (!Array.isArray(cliente_ids) || cliente_ids.length === 0) {
    return res.status(400).json({ error: 'cliente_ids é obrigatório e não pode ser vazio' });
  }
  if (!template_mensagem) {
    return res.status(400).json({ error: 'template_mensagem é obrigatório' });
  }

  const { data: envio, error: envioError } = await supabase
    .from('envios')
    .insert({
      template_mensagem,
      status: agendado_para ? 'agendado' : 'pendente',
      agendado_para: agendado_para || null,
    })
    .select()
    .single();

  if (envioError) return res.status(500).json({ error: envioError.message });

  const itens = cliente_ids.map((cliente_id) => ({
    envio_id: envio.id,
    cliente_id,
    status: 'pendente',
  }));

  const { error: itensError } = await supabase.from('envio_itens').insert(itens);
  if (itensError) return res.status(500).json({ error: itensError.message });

  res.status(201).json(envio);
});

// Dispara o envio imediatamente (assíncrono, roda em background)
router.post('/:id/disparar', async (req, res) => {
  if (disparoEmAndamento()) {
    return res.status(409).json({ error: 'já existe um disparo em andamento' });
  }

  const { id } = req.params;

  processarDisparo(id).catch((err) => console.error('[envios] erro no disparo:', err));

  res.json({ ok: true, mensagem: 'Disparo iniciado em background' });
});

// Reenvia apenas os itens que falharam (status 'erro') nesse envio
router.post('/:id/reenviar-erros', async (req, res) => {
  if (disparoEmAndamento()) {
    return res.status(409).json({ error: 'já existe um disparo em andamento' });
  }

  const { id } = req.params;

  reenviarErros(id).catch((err) => console.error('[envios] erro ao reenviar:', err));

  res.json({ ok: true, mensagem: 'Reenvio dos itens com erro iniciado em background' });
});

// Agenda (ou reagenda) o horário de início de um envio ainda não iniciado
router.patch('/:id/agendar', async (req, res) => {
  const { id } = req.params;
  const { agendado_para } = req.body;

  if (!agendado_para) {
    return res.status(400).json({ error: 'agendado_para é obrigatório (ISO datetime)' });
  }

  const { data, error } = await supabase
    .from('envios')
    .update({ status: 'agendado', agendado_para })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Consulta status/progresso de um envio
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  const { data: envio, error: envioError } = await supabase
    .from('envios')
    .select('*')
    .eq('id', id)
    .single();

  if (envioError) return res.status(500).json({ error: envioError.message });

  const { data: itens, error: itensError } = await supabase
    .from('envio_itens')
    .select('*, clientes(nome, telefone)')
    .eq('envio_id', id);

  if (itensError) return res.status(500).json({ error: itensError.message });

  res.json({ ...envio, itens });
});

// Lista todos os envios
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('envios')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
