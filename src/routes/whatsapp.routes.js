import { Router } from 'express';
import { getStatusUsuario, getStatusAmbosSlots, conectarUsuario, logoutUsuario } from '../services/whatsapp.js';

const router = Router();

// [2026-08] MULTI-TENANT: a conexão WhatsApp sempre se refere ao usuário
// autenticado (req.user.id, preenchido pelo middleware requireAuth em
// server.js). Cada operador só consegue ver/conectar/desconectar a PRÓPRIA
// sessão, nunca a de outro -- não tem como um usuário passar o id de outro
// aqui, porque o id nunca vem do corpo da requisição, só do token JWT
// validado.
//
// [2026-08] DOIS ZAPS: `slot` (1 ou 2) volta a existir na URL/corpo, mas
// agora sempre combinado com o usuário autenticado (nunca sozinho como
// antes do multi-tenant) -- ver services/whatsapp.js. Ausente, sempre vale
// slot 1, então nenhum cliente antigo do frontend quebra por não mandar
// slot nenhum.
function lerSlot(req) {
  const bruto = req.query.slot ?? req.body?.slot;
  return bruto === '2' || bruto === 2 ? 2 : 1;
}

router.get('/status', (req, res) => {
  res.json(getStatusUsuario(req.user.id, lerSlot(req)));
});

// Os dois slots de uma vez -- usado pela tela de Conexão pra renderizar os 2
// cards sem 2 requisições separadas.
router.get('/status-slots', (req, res) => {
  res.json(getStatusAmbosSlots(req.user.id));
});

router.post('/conectar', async (req, res) => {
  try {
    const estado = await conectarUsuario(req.user.id, lerSlot(req));
    res.json(estado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const estado = await logoutUsuario(req.user.id, lerSlot(req));
    res.json(estado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
