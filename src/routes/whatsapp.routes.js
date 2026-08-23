import { Router } from 'express';
import { getStatusUsuario, conectarUsuario, logoutUsuario } from '../services/whatsapp.js';

const router = Router();

// [2026-08] MULTI-TENANT: não existe mais parâmetro de slot na URL -- a
// conexão WhatsApp sempre se refere ao usuário autenticado (req.user.id,
// preenchido pelo middleware requireAuth em server.js). Cada operador só
// consegue ver/conectar/desconectar a PRÓPRIA sessão, nunca a de outro --
// não tem como um usuário passar o id de outro aqui, porque o id nunca vem
// do corpo da requisição, só do token JWT validado.

router.get('/status', (req, res) => {
  res.json(getStatusUsuario(req.user.id));
});

router.post('/conectar', async (req, res) => {
  try {
    const estado = await conectarUsuario(req.user.id);
    res.json(estado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const estado = await logoutUsuario(req.user.id);
    res.json(estado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
