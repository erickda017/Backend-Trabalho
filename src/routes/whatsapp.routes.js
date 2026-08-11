import { Router } from 'express';
import {
  getStatus,
  logoutWhatsApp,
  listarConexoes,
  getStatusSlot,
  conectarSlot,
  logoutSlot,
  SLOTS,
} from '../services/whatsapp.js';

const router = Router();

function validarSlot(req, res) {
  const slot = Number(req.params.slot);
  if (!SLOTS.includes(slot)) {
    res.status(400).json({ error: 'slot inválido (use 1 ou 2)' });
    return null;
  }
  return slot;
}

// --- duas conexões independentes ------------------------------------------
router.get('/conexoes', (req, res) => {
  res.json(listarConexoes());
});

router.get('/conexoes/:slot/status', (req, res) => {
  const slot = validarSlot(req, res);
  if (slot === null) return;
  res.json(getStatusSlot(slot));
});

router.post('/conexoes/:slot/conectar', async (req, res) => {
  const slot = validarSlot(req, res);
  if (slot === null) return;
  try {
    const estado = await conectarSlot(slot);
    res.json(estado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conexoes/:slot/logout', async (req, res) => {
  const slot = validarSlot(req, res);
  if (slot === null) return;
  try {
    const estado = await logoutSlot(slot);
    res.json(estado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- compatibilidade legada (versão de conexão única) ----------------------
router.get('/status', (req, res) => {
  res.json(getStatus());
});

router.post('/logout', async (req, res) => {
  try {
    await logoutWhatsApp();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
