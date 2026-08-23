import { supabase } from '../lib/supabase.js';
import { processarDisparo, disparoEmAndamento } from './dispatchQueue.js';

const INTERVALO_VERIFICACAO_MS = 60 * 1000; // checa a cada 1 minuto

// [2026-08] MULTI-TENANT: antes só existia 1 disparo por vez pro sistema
// INTEIRO -- agora cada usuário pode ter o seu rodando ao mesmo tempo que o
// de outro. O scheduler varre os envios elegíveis (agendados que já
// chegaram na hora, pausados que já podem retomar) de TODOS os usuários, mas
// só dispara um POR USUÁRIO a cada ciclo (pula quem já está com disparo em
// andamento neste processo).
async function verificarEnviosPendentes() {
  const agora = new Date().toISOString();

  // envios agendados cuja hora já chegou -- um por usuário, pra não estourar
  // vários disparos do mesmo operador ao mesmo tempo (dispatchQueue já
  // rejeitaria o segundo, mas é mais limpo nem tentar)
  const { data: agendados } = await supabase
    .from('envios')
    .select('id, usuario_id')
    .eq('status', 'agendado')
    .lte('agendado_para', agora)
    .not('usuario_id', 'is', null)
    .order('agendado_para', { ascending: true })
    .limit(50);

  const { data: pausados } = await supabase
    .from('envios')
    .select('id, usuario_id')
    .eq('status', 'pausado')
    .lte('retomar_em', agora)
    .not('usuario_id', 'is', null)
    .order('retomar_em', { ascending: true })
    .limit(50);

  const candidatos = [...(agendados || []), ...(pausados || [])];
  const usuariosJaDisparadosNesteCiclo = new Set();

  for (const envio of candidatos) {
    if (usuariosJaDisparadosNesteCiclo.has(envio.usuario_id)) continue; // já disparou 1 desse usuário neste ciclo
    if (disparoEmAndamento(envio.usuario_id)) continue; // esse usuário já tem disparo rodando

    usuariosJaDisparadosNesteCiclo.add(envio.usuario_id);
    console.log(`[scheduler] iniciando/retomando envio ${envio.id} (usuário ${envio.usuario_id})`);
    processarDisparo(envio.id, envio.usuario_id).catch((err) => console.error('[scheduler] erro:', err.message));
  }
}

export function iniciarScheduler() {
  setInterval(verificarEnviosPendentes, INTERVALO_VERIFICACAO_MS);
  console.log('[scheduler] iniciado, verificando a cada 1 minuto');
}
