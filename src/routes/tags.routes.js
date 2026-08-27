import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { cancelarItensPendentesDosClientes } from '../lib/tagsEfeito.js';
import { sugerirPromocaoSpd } from '../lib/promocaoSpd.js';

const router = Router();

// [2026-08] cancelarItensPendentesDosClientes foi extraída pra
// lib/tagsEfeito.js -- reaproveitada também pela importação de clientes
// PAGOS (ver routes/clientes.routes.js, POST /importar-pagos), que aplica
// uma tag `permite_disparo: false` em massa a partir de uma lista de nomes.

// [2026-08] MULTI-TENANT: tags são por usuário -- cada operador tem seu
// próprio conjunto (nome único por usuário, não globalmente -- ver
// migration-13-multi-tenant.sql).

// Lista todas as tags do usuário logado
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('tags').select('*').eq('usuario_id', req.user.id).order('nome');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Cria uma tag nova. `permite_disparo: false` marca a tag como "tira do
// disparo" (ex.: Pago, Cancelado) -- ver migration-14 pro efeito completo.
router.post('/', async (req, res) => {
  const { nome, cor, permite_disparo } = req.body || {};
  if (!nome || !nome.trim()) return res.status(400).json({ error: 'nome é obrigatório' });

  const { data, error } = await supabase
    .from('tags')
    .insert({
      usuario_id: req.user.id,
      nome: nome.trim(),
      cor: cor || '#6366f1',
      permite_disparo: permite_disparo === false ? false : true,
    })
    .select()
    .single();

  if (error) {
    // unique index em (usuario_id, lower(nome)) -- evita "Cliente VIP" e "cliente vip"
    // como tags diferentes na carteira do MESMO usuário (dois usuários diferentes
    // podem, cada um, ter uma tag "VIP" -- isso é esperado, não colide).
    if (error.code === '23505') return res.status(409).json({ error: 'Já existe uma tag com esse nome' });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

// Atualiza nome/cor/permite_disparo de uma tag. Se a tag passar a
// `permite_disparo: false` (ex.: usuário edita "Em atraso" pra virar
// "Cancelado" e liga o toggle depois), aplica o mesmo efeito de saída dos
// lotes pra todo mundo que já tem essa tag -- não é só quem for marcado
// dali pra frente.
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, cor, permite_disparo } = req.body || {};
  const usuarioId = req.user.id;

  const { data, error } = await supabase
    .from('tags')
    .update({
      ...(nome ? { nome: nome.trim() } : {}),
      ...(cor ? { cor } : {}),
      ...(typeof permite_disparo === 'boolean' ? { permite_disparo } : {}),
    })
    .eq('id', id)
    .eq('usuario_id', usuarioId)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Tag não encontrada' });

  if (permite_disparo === false) {
    const { data: relacoes } = await supabase.from('cliente_tags').select('cliente_id').eq('tag_id', id);
    await cancelarItensPendentesDosClientes((relacoes || []).map((r) => r.cliente_id), usuarioId);
  }

  res.json(data);
});

// Remove uma tag (cliente_tags cai em cascata -- ver schema)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('tags').delete().eq('id', id).eq('usuario_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Atribui uma tag a um cliente -- confirma que TANTO a tag QUANTO o cliente
// são do usuário logado antes de criar a relação (senão daria pra "vazar" uma
// tag/cliente de outro usuário criando uma linha em cliente_tags cruzando os dois).
router.post('/:id/clientes/:clienteId', async (req, res) => {
  const { id, clienteId } = req.params;
  const usuarioId = req.user.id;

  const [{ data: tag }, { data: cliente }] = await Promise.all([
    supabase.from('tags').select('id, nome, permite_disparo').eq('id', id).eq('usuario_id', usuarioId).maybeSingle(),
    supabase.from('clientes').select('id').eq('id', clienteId).eq('usuario_id', usuarioId).maybeSingle(),
  ]);
  if (!tag || !cliente) return res.status(404).json({ error: 'Tag ou cliente não encontrado' });

  const { error } = await supabase
    .from('cliente_tags')
    .upsert({ tag_id: id, cliente_id: clienteId }, { onConflict: 'cliente_id,tag_id' });

  if (error) return res.status(500).json({ error: error.message });

  // Tag "tira do disparo" (ex.: Pago, Cancelado) -- some imediatamente de
  // qualquer lote em andamento/pendente, não só dos próximos que forem
  // montados.
  if (tag.permite_disparo === false) {
    await cancelarItensPendentesDosClientes([clienteId], usuarioId);
  }

  // [regra de negócio] Marcar "Pago" (mesma tag de POST /importar-pagos) num
  // cliente FPD dispara a mesma sugestão de promoção pra SPD -- ver
  // lib/promocaoSpd.js. Só sinaliza, não aplica sozinho.
  let sugestaoSpd = null;
  if (/^pago$/i.test(tag.nome || '')) {
    sugestaoSpd = await sugerirPromocaoSpd(clienteId, usuarioId);
  }

  res.status(201).json({ ok: true, sugestao_spd: sugestaoSpd });
});

// Remove uma tag de um cliente
router.delete('/:id/clientes/:clienteId', async (req, res) => {
  const { id, clienteId } = req.params;
  const usuarioId = req.user.id;

  const { data: cliente } = await supabase.from('clientes').select('id').eq('id', clienteId).eq('usuario_id', usuarioId).maybeSingle();
  if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

  const { error } = await supabase
    .from('cliente_tags')
    .delete()
    .eq('tag_id', id)
    .eq('cliente_id', clienteId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
