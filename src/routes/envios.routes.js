import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { processarDisparo, reenviarErros, disparoEmAndamento } from '../services/dispatchQueue.js';

const router = Router();

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
