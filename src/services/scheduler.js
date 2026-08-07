import { supabase } from '../lib/supabase.js';
import { processarDisparo, disparoEmAndamento } from './dispatchQueue.js';

const INTERVALO_VERIFICACAO_MS = 60 * 1000; // checa a cada 1 minuto

async function verificarEnviosPendentes() {
  if (disparoEmAndamento()) return; // só processa um envio por vez

  const agora = new Date().toISOString();

  // envios agendados cuja hora já chegou
  const { data: agendados } = await supabase
    .from('envios')
    .select('id')
    .eq('status', 'agendado')
    .lte('agendado_para', agora)
    .limit(1);

  if (agendados?.length) {
    console.log(`[scheduler] iniciando envio agendado ${agendados[0].id}`);
    processarDisparo(agendados[0].id).catch((err) => console.error('[scheduler] erro:', err.message));
    return;
  }

  // envios pausados (por limite diário) cuja janela de retomada já chegou
  const { data: pausados } = await supabase
    .from('envios')
    .select('id')
    .eq('status', 'pausado')
    .lte('retomar_em', agora)
    .limit(1);

  if (pausados?.length) {
    console.log(`[scheduler] retomando envio pausado ${pausados[0].id}`);
    processarDisparo(pausados[0].id).catch((err) => console.error('[scheduler] erro:', err.message));
  }
}

export function iniciarScheduler() {
  setInterval(verificarEnviosPendentes, INTERVALO_VERIFICACAO_MS);
  console.log('[scheduler] iniciado, verificando a cada 1 minuto');
}
