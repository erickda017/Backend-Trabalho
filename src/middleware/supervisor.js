// Exige req.user.role === 'supervisor' (setado pelo requireAuth a partir de
// `perfis`, ver middleware/auth.js). Usar sempre DEPOIS de requireAuth.
export function requireSupervisor(req, res, next) {
  if (req.user?.role !== 'supervisor') {
    return res.status(403).json({ error: 'Acesso restrito a supervisores' });
  }
  next();
}
