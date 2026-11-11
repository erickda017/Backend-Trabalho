// Token da extensão (Voxcel Assistente). Não é sessão do Supabase: vale só para /api/integracoes/ennychat/*, fica guardado
// como hash e é revogável. Formato: "vxe_" + 32 bytes aleatórios em base64url.
import crypto from 'node:crypto';
import { supabase } from './supabase.js';

export const PREFIXO_TOKEN = 'vxe_';
export const MAX_TOKENS_ATIVOS = 5;
const ATUALIZAR_USO_APOS_MS = 10 * 60 * 1000;

export const ehTokenExtensao = (t) => typeof t === 'string' && t.startsWith(PREFIXO_TOKEN) && t.length >= 40 && t.length <= 80;
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
export const gerarToken = () => PREFIXO_TOKEN + crypto.randomBytes(32).toString('base64url');

/** usuario_id do token válido (não revogado), ou null. Atualiza "último uso" no máximo a cada 10 min. */
export async function usuarioDoToken(token) {
  if (!ehTokenExtensao(token)) return null;
  const { data, error } = await supabase
    .from('extensao_tokens').select('id, usuario_id, ultimo_uso_em').eq('token_hash', hashToken(token)).is('revogado_em', null).maybeSingle();
  if (error || !data) return null;
  if (!data.ultimo_uso_em || Date.now() - Date.parse(data.ultimo_uso_em) > ATUALIZAR_USO_APOS_MS) {
    void supabase.from('extensao_tokens').update({ ultimo_uso_em: new Date().toISOString() }).eq('id', data.id).then(() => {}, () => {});
  }
  return data.usuario_id;
}

/** Cria um token novo para o usuário (devolvido UMA vez) e revoga os mais antigos além do limite. */
export async function criarToken(usuarioId) {
  const token = gerarToken();
  const { error } = await supabase.from('extensao_tokens').insert({ usuario_id: usuarioId, token_hash: hashToken(token) });
  if (error) throw error;
  const { data } = await supabase.from('extensao_tokens').select('id').eq('usuario_id', usuarioId).is('revogado_em', null).order('criado_em', { ascending: false });
  const excedentes = (data || []).slice(MAX_TOKENS_ATIVOS).map((t) => t.id);
  if (excedentes.length) await supabase.from('extensao_tokens').update({ revogado_em: new Date().toISOString() }).in('id', excedentes);
  return token;
}

export async function revogarTokens(usuarioId) {
  const { error } = await supabase.from('extensao_tokens').update({ revogado_em: new Date().toISOString() }).eq('usuario_id', usuarioId).is('revogado_em', null);
  if (error) throw error;
}
