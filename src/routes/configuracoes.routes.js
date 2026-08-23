import { Router } from 'express';
import { configDisparo } from '../services/dispatchQueue.js';

const router = Router();

// Números do disparo (delay entre mensagens, limite diário, pausa automática
// a cada N mensagens) -- o frontend usa isso pra exibir, ex: "pausa automática
// de 10min a cada 20 mensagens" na aba Disparo, sem precisar hardcodar esses
// valores (eles vêm de env var no backend e podem mudar).
router.get('/disparo', (req, res) => {
  res.json(configDisparo());
});

// [2026-08] MULTI-TENANT: rotas GET/PUT /estrategia removidas. Existiam pra
// escolher entre 2 slots de WhatsApp de UMA operação compartilhada
// (round-robin, slot fixo etc) -- agora cada usuário tem 1 WhatsApp só, não
// há mais "estratégia" nenhuma pra configurar (ver migration-13-multi-tenant.sql,
// tabela estrategia_config marcada como deprecated).

export default router;
