import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

// Lista todas as tags
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('tags').select('*').order('nome');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Cria uma tag nova
router.post('/', async (req, res) => {
  const { nome, cor } = req.body || {};
  if (!nome || !nome.trim()) return res.status(400).json({ error: 'nome é obrigatório' });

  const { data, error } = await supabase
    .from('tags')
    .insert({ nome: nome.trim(), cor: cor || '#6366f1' })
    .select()
    .single();

  if (error) {
    // unique index em lower(nome) -- evita "Cliente VIP" e "cliente vip" como tags diferentes
    if (error.code === '23505') return res.status(409).json({ error: 'Já existe uma tag com esse nome' });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

// Atualiza nome/cor de uma tag
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, cor } = req.body || {};

  const { data, error } = await supabase
    .from('tags')
    .update({ ...(nome ? { nome: nome.trim() } : {}), ...(cor ? { cor } : {}) })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Remove uma tag (cliente_tags cai em cascata -- ver schema)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('tags').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Atribui uma tag a um cliente
router.post('/:id/clientes/:clienteId', async (req, res) => {
  const { id, clienteId } = req.params;
  const { error } = await supabase
    .from('cliente_tags')
    .upsert({ tag_id: id, cliente_id: clienteId }, { onConflict: 'cliente_id,tag_id' });

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ok: true });
});

// Remove uma tag de um cliente
router.delete('/:id/clientes/:clienteId', async (req, res) => {
  const { id, clienteId } = req.params;
  const { error } = await supabase
    .from('cliente_tags')
    .delete()
    .eq('tag_id', id)
    .eq('cliente_id', clienteId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
