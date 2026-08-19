import { Router } from 'express';
import { configEstrategiaCompleta, salvarEstrategia } from '../lib/estrategia.js';
import { configDisparo } from '../services/dispatchQueue.js';

const router = Router();

// Números do disparo (delay entre mensagens, limite diário, pausa automática
// a cada N mensagens) -- o frontend usa isso pra exibir, ex: "pausa automática
// de 10min a cada 20 mensagens" na aba Disparo, sem precisar hardcodar esses
// valores (eles vêm de env var no backend e podem mudar).
router.get('/disparo', (req, res) => {
  res.json(configDisparo());
});

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
