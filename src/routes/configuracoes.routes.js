import { Router } from 'express';
import { configEstrategiaCompleta, salvarEstrategia } from '../lib/estrategia.js';

const router = Router();

router.get('/estrategia', async (req, res) => {
  try {
    res.json(await configEstrategiaCompleta());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/estrategia', async (req, res) => {
  const { estrategia } = req.body || {};
  if (!estrategia) return res.status(400).json({ error: 'estrategia é obrigatória' });

  try {
    await salvarEstrategia(estrategia);
    res.json(await configEstrategiaCompleta());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
