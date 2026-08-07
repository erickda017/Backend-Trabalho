// Dispara um webhook HTTP (se configurado) para eventos do sistema:
// disparo iniciado/concluído, mensagem enviada, erro, status de entrega/leitura, etc.
// Configurável via WEBHOOK_URL no .env. Se não estiver setado, não faz nada.
// Falhas no webhook nunca devem quebrar o fluxo principal -- por isso o try/catch interno.

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

export async function dispararWebhook(evento, dados) {
  if (!WEBHOOK_URL) return;

  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WEBHOOK_SECRET ? { 'X-Webhook-Secret': WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify({
        evento,
        dados,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error(`[webhook] falha ao notificar evento "${evento}":`, err.message);
  }
}
