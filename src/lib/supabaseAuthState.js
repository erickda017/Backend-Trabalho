import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { supabase } from './supabase.js';

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
  return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
}

async function writeData(sessionId, key, value) {
  const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
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
