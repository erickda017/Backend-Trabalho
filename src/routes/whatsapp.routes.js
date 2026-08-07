import { Router } from 'express';
import { getStatus, logoutWhatsApp } from '../services/whatsapp.js';

const router = Router();

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
