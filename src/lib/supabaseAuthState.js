import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { supabase } from './supabase.js';
import { cifrar, decifrar, criptografiaAtiva } from './criptografia.js';

const TABLE = 'whatsapp_sessions';

// Lê uma "chave" da sessão (creds, ou uma key de criptografia tipo session/sender-key/etc).
// Os dados do Baileys têm Buffers dentro, por isso passamos pelo BufferJSON (replacer/reviver)
// pra não perder o tipo Buffer ao ir/voltar do JSONB do Postgres.
async function readData(sessionId, key) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('data')
    .eq('session_id', sessionId)
    .eq('key', key)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  // [2026-10] Linha cifrada = { __enc: "enc:v1:..." }; legado em texto puro segue legível.
  if (typeof data.data?.__enc === 'string') return JSON.parse(decifrar(data.data.__enc), BufferJSON.reviver);
  return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
}

// As chaves do Baileys (creds, sessões Signal) permitem se passar pelo número
// do cliente no WhatsApp. Com DATA_ENCRYPTION_KEY, vão cifradas pro banco.
function empacotar(value) {
  if (!criptografiaAtiva()) return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
  return { __enc: cifrar(JSON.stringify(value, BufferJSON.replacer)) };
}

// Cifra as linhas antigas (texto puro) que ainda existirem. Idempotente; roda
// uma vez no boot, em segundo plano.
export async function cifrarSessoesLegadas() {
  if (!criptografiaAtiva()) return 0;
  let total = 0;
  const TAM = 200;
  for (let de = 0; ; de += TAM) {
    const { data: linhas, error } = await supabase.from(TABLE).select('session_id, key, data').order('session_id').order('key').range(de, de + TAM - 1);
    if (error) throw error;
    if (!linhas?.length) break;
    for (const l of linhas) {
      if (typeof l.data?.__enc === 'string') continue;
      const { error: e } = await supabase
        .from(TABLE)
        .update({ data: { __enc: cifrar(JSON.stringify(l.data)) } })
        .eq('session_id', l.session_id)
        .eq('key', l.key);
      if (e) throw e;
      total++;
    }
    if (linhas.length < TAM) break;
  }
  return total;
}

async function writeData(sessionId, key, value) {
  const serialized = empacotar(value);
  const { error } = await supabase
    .from(TABLE)
    .upsert(
      { session_id: sessionId, key, data: serialized, updated_at: new Date().toISOString() },
      { onConflict: 'session_id,key' }
    );
  if (error) throw error;
}

async function removeData(sessionId, key) {
  const { error } = await supabase.from(TABLE).delete().eq('session_id', sessionId).eq('key', key);
  if (error) throw error;
}

// Equivalente ao useMultiFileAuthState do Baileys, mas guardando cada chave como uma
// linha na tabela whatsapp_sessions do Supabase em vez de um arquivo em /data/sessions.
// Isso deixa o backend sem estado em disco -> qualquer instância/deploy no Render
// consegue reconectar a mesma sessão do WhatsApp sem precisar de Persistent Disk.
export async function useSupabaseAuthState(sessionId = 'default') {
  const creds = (await readData(sessionId, 'creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(sessionId, `${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(sessionId, key, value) : removeData(sessionId, key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(sessionId, 'creds', creds),
    // Apaga toda a sessão salva no Supabase (usado no logout, no lugar do fs.rmSync).
    clearState: async () => {
      const { error } = await supabase.from(TABLE).delete().eq('session_id', sessionId);
      if (error) throw error;
    },
  };
}
