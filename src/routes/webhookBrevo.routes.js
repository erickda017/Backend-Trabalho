import { Router } from 'express';
import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { descreverErro } from '../lib/redigir.js';
import { logLimitado } from '../lib/log.js';
import { aplicarEvento, normalizarMessageId } from '../lib/email/eventos.js';

// Webhook transacional da Brevo (rota PÚBLICA, sem login): autenticada por segredo compartilhado
// (BREVO_WEBHOOK_TOKEN) no header `Authorization: Bearer <token>` ou em `?token=` na URL cadastrada na Brevo.
// Sempre responde 200 depois de autenticar: duplicata/evento fora de ordem é tratado pelo estado, não por retry.
const router = Router();

const igual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

router.post('/', async (req, res) => {
  const segredo = process.env.BREVO_WEBHOOK_TOKEN?.trim();
  if (!segredo) return res.status(503).json({ error: 'Webhook não configurado.' });
  const enviado = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || String(req.query.token ?? '');
  if (!enviado || !igual(enviado, segredo)) return res.status(401).json({ error: 'Não autorizado.' });

  try {
    const eventos = (Array.isArray(req.body) ? req.body : [req.body]).filter((e) => e && typeof e === 'object').slice(0, 200);
    for (const ev of eventos) {
      const mid = normalizarMessageId(ev['message-id'] ?? ev.messageId);
      if (!mid) continue;
      const { data: envio } = await supabase.from('email_envios').select('id, status, evento_em')
        .in('message_id', [mid, `<${mid}>`]).limit(1).maybeSingle();
      if (!envio) continue; // evento de e-mail que este sistema não enviou
      const novo = aplicarEvento(envio, ev);
      if (!novo) continue;
      await supabase.from('email_envios')
        .update({ status: novo.status, motivo: novo.motivo, evento_em: novo.evento_em, atualizado_em: new Date().toISOString() })
        .eq('id', envio.id);
    }
    res.json({ ok: true });
  } catch (err) {
    logLimitado('email-webhook', 'error', '[email] webhook:', descreverErro(err));
    res.status(500).json({ error: 'Falha ao processar.' }); // a Brevo repete: seguro, o estado é idempotente
  }
});

export default router;
