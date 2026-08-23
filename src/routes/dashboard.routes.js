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

// [2026-08] MULTI-TENANT: todo contador é escopado por usuario_id. Tabelas
// com a coluna direto (clientes) filtram normal; envio_itens não tem
// usuario_id próprio -- passa pelo join com envios (join!inner garante que só
// conta linhas cujo envio pai é do usuário).
async function contar(tabela, usuarioId, filtros = {}, { viaEnvios = false } = {}) {
  let query = viaEnvios
    ? supabase.from(tabela).select('*, envios!inner(usuario_id)', { count: 'exact', head: true }).eq('envios.usuario_id', usuarioId)
    : supabase.from(tabela).select('*', { count: 'exact', head: true }).eq('usuario_id', usuarioId);

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
    const usuarioId = req.user.id;
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
      contar('clientes', usuarioId),
      // [2026-08] pdf_url é coluna deprecated e não é mais gravada (bucket
      // privado, ver migration-12) -- o filtro certo pra "cliente tem PDF" é
      // pdf_path, que continua sendo a fonte da verdade.
      contar('clientes', usuarioId, { pdf_path: { op: 'not_null' } }),
      contar('envio_itens', usuarioId, { enviado_em: { op: 'gte', valor: inicioHoje } }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status: 'enviado' }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status_entrega: { op: 'in', valores: ['entregue', 'lido'] } }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status_entrega: 'lido' }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status: 'erro' }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status: 'numero_invalido' }, { viaEnvios: true }),
      contar('envio_itens', usuarioId, { status: 'pendente' }, { viaEnvios: true }),
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
