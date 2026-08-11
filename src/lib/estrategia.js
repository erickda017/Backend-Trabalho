import { supabase } from './supabase.js';
import { slotsConectados } from '../services/whatsapp.js';

// Estratégia de escolha de slot pra cada mensagem de um envio. Guardada numa
// linha única (id=true) na tabela estrategia_config -- ver migration-4.
export async function buscarEstrategia() {
  const { data, error } = await supabase.from('estrategia_config').select('*').eq('id', true).maybeSingle();
  if (error) throw error;
  return data || { estrategia: 'qualquer', next_slot: 1 };
}

export async function salvarEstrategia(estrategia) {
  const validas = ['slot_1', 'slot_2', 'round_robin', 'qualquer'];
  if (!validas.includes(estrategia)) {
    throw new Error(`estrategia inválida (use: ${validas.join(', ')})`);
  }
  const { data, error } = await supabase
    .from('estrategia_config')
    .update({ estrategia })
    .eq('id', true)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function configEstrategiaCompleta() {
  const config = await buscarEstrategia();
  return { ...config, slots_ativos: slotsConectados() };
}

// Escolhe o slot pra usar em UMA mensagem, dado o slot fixado no envio (se o
// usuário escolheu manualmente ao criar o envio) e a estratégia configurada.
// round_robin alterna a cada chamada e persiste o próximo slot no banco.
export async function escolherSlot(slotDoEnvio) {
  if (slotDoEnvio) return slotDoEnvio; // slot explícito no envio sempre vence

  const conectados = slotsConectados();
  if (!conectados.length) throw new Error('Nenhum slot WhatsApp conectado');

  const config = await buscarEstrategia();

  if (config.estrategia === 'slot_1' || config.estrategia === 'slot_2') {
    const alvo = config.estrategia === 'slot_1' ? 1 : 2;
    return conectados.includes(alvo) ? alvo : conectados[0];
  }

  if (config.estrategia === 'round_robin') {
    const atual = conectados.includes(config.next_slot) ? config.next_slot : conectados[0];
    const proximo = conectados.find((s) => s !== atual) || atual;
    await supabase.from('estrategia_config').update({ next_slot: proximo }).eq('id', true);
    return atual;
  }

  // 'qualquer' -- primeiro slot conectado
  return conectados[0];
}
