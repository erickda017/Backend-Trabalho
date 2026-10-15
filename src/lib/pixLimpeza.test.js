import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'x';
const { contarExtracoesPix, apagarExtracoesPix, MODOS_PIX } = await import('./pixLimpeza.js');

test('modo desconhecido é recusado antes de qualquer consulta', async () => {
  await assert.rejects(() => contarExtracoesPix({ usuarioId: 'u', modo: 'tudo' }), /modo/);
  await assert.rejects(() => apagarExtracoesPix({ usuarioId: 'u', modo: undefined }), /modo/);
});

test('antes_de exige data AAAA-MM-DD', async () => {
  await assert.rejects(() => contarExtracoesPix({ usuarioId: 'u', modo: 'antes_de', antesDe: '15/10/2026' }), /antes_de/);
  await assert.rejects(() => apagarExtracoesPix({ usuarioId: 'u', modo: 'antes_de' }), /antes_de/);
});

test('modos expostos', () => {
  assert.deepEqual(MODOS_PIX, ['todas', 'sem_cliente', 'com_erro', 'antes_de']);
});
