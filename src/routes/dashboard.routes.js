import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

// Brasil não observa horário de verão desde 2019 -- offset fixo -03:00.
// Mesmo cálculo usado em dispatchQueue.js pra "início do dia" no fuso de SP.
function inicioDoDiaBR() {
  const dataSP = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${dataSP}T00:00:00-03:00`).toISOString();
}

async function contar(tabela, filtros = {}) {
  let query = supabase.from(tabela).select('*', { count: 'exact', head: true });
  for (const [coluna, valor] of Object.entries(filtros)) {
    if (valor && typeof valor === 'object' && valor.op === 'not_null') {
      query = query.not(coluna, 'is', null);
    } else if (valor && typeof valor === 'object' && valor.op === 'gte') {
      query = query.gte(coluna, valor.valor);
    } else if (valor && typeof valor === 'object' && valor.op === 'in') {
      query = query.in(coluna, valor.valores);
    } else {
      query = query.eq(coluna, valor);
    }
  }
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

router.get('/resumo', async (req, res) => {
  try {
    const inicioHoje = inicioDoDiaBR();

    const [
      clientes,
      faturas,
      disparosHoje,
      enviados,
      entregues,
      lidos,
      falhas,
      numerosInvalidos,
      pendentes,
    ] = await Promise.all([
      contar('clientes'),
      contar('clientes', { pdf_url: { op: 'not_null' } }),
      contar('envio_itens', { enviado_em: { op: 'gte', valor: inicioHoje } }),
      contar('envio_itens', { status: 'enviado' }),
      contar('envio_itens', { status_entrega: { op: 'in', valores: ['entregue', 'lido'] } }),
      contar('envio_itens', { status_entrega: 'lido' }),
      contar('envio_itens', { status: 'erro' }),
      contar('envio_itens', { status: 'numero_invalido' }),
      contar('envio_itens', { status: 'pendente' }),
    ]);

    res.json({
      clientes,
      faturas,
      disparos_hoje: disparosHoje,
      enviados,
      entregues,
      lidos,
      falhas,
      numeros_invalidos: numerosInvalidos,
      pendentes,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
