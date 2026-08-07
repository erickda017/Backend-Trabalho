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
  next();
}
