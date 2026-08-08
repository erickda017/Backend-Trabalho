import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

// Tira a barra "/" que o usuário pode digitar por hábito -- guardamos só "boasvindas",
// não "/boasvindas", pra não depender de como o front formata na hora de mostrar.
function limparAtalho(atalho) {
  return String(atalho || '').trim().replace(/^\/+/, '');
}

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('respostas_rapidas').select('*').order('atalho');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', async (req, res) => {
  const atalho = limparAtalho(req.body?.atalho);
  const texto = (req.body?.texto || '').trim();

  if (!atalho || !texto) return res.status(400).json({ error: 'atalho e texto são obrigatórios' });

  const { data, error } = await supabase
    .from('respostas_rapidas')
    .insert({ atalho, texto })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Já existe uma resposta rápida com esse atalho' });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const atalho = req.body?.atalho !== undefined ? limparAtalho(req.body.atalho) : undefined;
  const texto = req.body?.texto !== undefined ? req.body.texto.trim() : undefined;

  const { data, error } = await supabase
    .from('respostas_rapidas')
    .update({ ...(atalho ? { atalho } : {}), ...(texto ? { texto } : {}) })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('respostas_rapidas').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
