import { supabase } from '../lib/supabase.js';

// Verifica o token JWT do Supabase Auth enviado no header Authorization: Bearer <token>
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada' });
  }

  req.user = data.user;

  // Mantém `perfis` sempre com uma linha pra quem já logou alguma vez -- é
  // o que permite promover a supervisor com um UPDATE simples (ver
  // migration-16). upsert leve, roda em toda request autenticada; se falhar
  // (rede, migration ainda não rodada) não derruba o login -- só trata como
  // 'operador' (comportamento de sempre) e loga o erro.
  try {
    const { data: perfil, error: perfilError } = await supabase
      .from('perfis')
      .upsert(
        { id: req.user.id, email: req.user.email || null },
        { onConflict: 'id', ignoreDuplicates: false },
      )
      .select('role')
      .single();
    if (perfilError) throw perfilError;
    req.user.role = perfil?.role || 'operador';
  } catch (err) {
    console.error('[auth] falha ao sincronizar perfil (seguindo como operador):', err.message);
    req.user.role = 'operador';
  }

  next();
}
