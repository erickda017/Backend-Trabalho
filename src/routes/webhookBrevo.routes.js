import { Router } from 'express';
import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { descreverErro } from '../lib/redigir.js';
import { logLimitado } from '../lib/log.js';
import { aplicarEvento, instanteDoEvento, normalizarMessageId } from '../lib/email/eventos.js';

const ABERTURA = new Set(['opened', 'unique_opened', 'proxy_open', 'first_opening']);
const CLIQUE = new Set(['click', 'clicks']);

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
      const ids = [mid, `<${mid}>`];
      let { data: envio, error: erroLeitura } = await supabase.from('email_envios').select('id, status, evento_em, aberturas, primeira_abertura_em, cliques')
        .in('message_id', ids).limit(1).maybeSingle();
      // migration-32 ainda não rodou (colunas de engajamento inexistentes): segue só com entrega/devolução.
      if (erroLeitura && (erroLeitura.code === '42703' || erroLeitura.code === 'PGRST204' || /aberturas|cliques/.test(erroLeitura.message ?? ''))) {
        ({ data: envio } = await supabase.from('email_envios').select('id, status, evento_em').in('message_id', ids).limit(1).maybeSingle());
        if (envio) envio.semEngajamento = true;
      }
      if (!envio) continue; // evento de e-mail que este sistema não enviou
      // Engajamento (não muda o estado de entrega, só conta). Abrir implica que foi entregue.
      const tipo = String(ev.event ?? '').toLowerCase();
      if (ABERTURA.has(tipo) || CLIQUE.has(tipo)) {
        if (envio.semEngajamento) continue;
        const quando = new Date(instanteDoEvento(ev) ?? Date.now()).toISOString();
        const campos = ABERTURA.has(tipo)
          ? { aberturas: (envio.aberturas ?? 0) + 1, primeira_abertura_em: envio.primeira_abertura_em ?? quando }
          : { cliques: (envio.cliques ?? 0) + 1, clique_em: quando };
        if (envio.status === 'aceito') campos.status = 'entregue';
        await supabase.from('email_envios').update({ ...campos, atualizado_em: new Date().toISOString() }).eq('id', envio.id);
        continue;
      }
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
