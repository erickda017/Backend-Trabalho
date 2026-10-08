// [2026-10] SEGURANÇA: criptografia de dado sensível ANTES de ir pro Supabase.
// AES-256-GCM (autenticada: adulterar o texto cifrado faz a leitura falhar).
// Chave: DATA_ENCRYPTION_KEY = 32 bytes em base64 (gerar com
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))").
// Fica SÓ no Render -- quem vazar o banco/backup do Supabase sem essa chave
// não consegue ler. Formato: "enc:v1:<iv>:<tag>:<cifrado>" (base64url).
// Sem a chave, `cifrar` devolve o texto puro (deploy antigo continua
// funcionando) e `ler` aceita legado em texto puro -- migra sozinho na
// próxima gravação. Chave errada/dado adulterado => erro (nunca devolve lixo).
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const PREFIXO = 'enc:v1:';

function lerChave(env = process.env) {
  const b64 = env.DATA_ENCRYPTION_KEY;
  if (!b64) return null;
  const chave = Buffer.from(b64.trim(), 'base64');
  if (chave.length !== 32) throw new Error('DATA_ENCRYPTION_KEY inválida: precisa ter 32 bytes em base64');
  return chave;
}

export const criptografiaAtiva = (env = process.env) => Boolean(lerChave(env));

export function estaCifrado(valor) {
  return typeof valor === 'string' && valor.startsWith(PREFIXO);
}

export function cifrar(texto, env = process.env) {
  const chave = lerChave(env);
  if (!chave) return texto;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chave, iv);
  const cifrado = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return `${PREFIXO}${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${cifrado.toString('base64url')}`;
}

export function decifrar(valor, env = process.env) {
  if (!estaCifrado(valor)) return valor; // legado em texto puro
  const chave = lerChave(env);
  if (!chave) throw new Error('dado cifrado mas DATA_ENCRYPTION_KEY não está configurada');
  const [iv, tag, cifrado] = valor.slice(PREFIXO.length).split(':');
  if (!iv || !tag || !cifrado) throw new Error('dado cifrado malformado');
  const d = createDecipheriv('aes-256-gcm', chave, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(cifrado, 'base64url')), d.final()]).toString('utf8');
}

// HMAC-SHA256 determinístico (hash com chave) pra comparar/indexar sem guardar
// o valor (ex.: "esse telefone já existe?"). Não é reversível.
export function hashComChave(valor, env = process.env) {
  const chave = lerChave(env);
  if (!chave) throw new Error('hashComChave exige DATA_ENCRYPTION_KEY');
  return createHmac('sha256', chave).update(String(valor)).digest('hex');
}
