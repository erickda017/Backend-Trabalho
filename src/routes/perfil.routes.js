import { Router } from 'express';

const router = Router();

// Qualquer autenticado pode ver o PRÓPRIO papel -- é só o que o front
// precisa pra decidir se mostra o menu "Supervisor" (ver requireAuth, que já
// preenche req.user.role a partir de `perfis`).
router.get('/me', (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, role: req.user.role });
});

export default router;
