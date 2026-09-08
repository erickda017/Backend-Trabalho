import { createHmac } from 'node:crypto';

// Dispara um webhook HTTP (se configurado) para eventos do sistema:
// disparo iniciado/concluído, mensagem enviada, erro, status de entrega/leitura, etc.
// Configurável via WEBHOOK_URL no .env. Se não estiver setado, não faz nada.
// Falhas no webhook nunca devem quebrar o fluxo principal -- por isso o try/catch interno.
//
// [2026-08] LIMITAÇÃO CONHECIDA (multi-tenant): WEBHOOK_URL/WEBHOOK_SECRET são
// globais da instância (uma env var só), não por usuário/operador. Isso
// significa que, se essa instância for compartilhada por operadores de
// carteiras/organizações diferentes, esse único webhook recebe eventos (com
// dados de cliente: nome, telefone) de TODOS os operadores misturados -- quem
// estiver do outro lado desse endpoint vê dados que não são "seus". Antes do
// multi-tenant isso não era um problema (só existia uma operação usando o
// sistema). Se isolamento de webhook por operador for necessário, é preciso
// uma tabela de configuração por usuario_id + rota de gerenciamento -- fora
// do escopo desta revisão, sinalizando aqui pra não passar despercebido.
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

export async function dispararWebhook(evento, dados) {
  if (!WEBHOOK_URL) return;

  try {
    // Timeout de segurança -- sem isso, um endpoint de webhook do usuário que
    // trava/não responde deixava essa chamada pendurada indefinidamente. Como
    // dispararWebhook é chamado a cada mensagem enviada/status de entrega (pode
    // ser bem frequente durante um disparo em massa), isso podia acumular
    // conexões HTTP penduradas ao longo do tempo.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    const corpo = JSON.stringify({
      evento,
      dados,
      timestamp: new Date().toISOString(),
    });

    // [2026-09] Antes só mandava o segredo cru no header (X-Webhook-Secret) --
    // quem recebe não tinha como confirmar que o corpo não foi adulterado no
    // caminho, só que quem chamou "sabia" o segredo. Assinatura HMAC-SHA256
    // do corpo (padrão usado por Stripe/GitHub/etc.) deixa isso verificável:
    // quem recebe recalcula o HMAC com o mesmo segredo e compara com o header
    // -- X-Webhook-Secret continua indo também, por compatibilidade com quem
    // já integrou só checando ele.
    const assinatura = WEBHOOK_SECRET ? createHmac('sha256', WEBHOOK_SECRET).update(corpo).digest('hex') : null;

    try {
      await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(WEBHOOK_SECRET ? { 'X-Webhook-Secret': WEBHOOK_SECRET } : {}),
          ...(assinatura ? { 'X-Webhook-Signature': `sha256=${assinatura}` } : {}),
        },
        body: corpo,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    console.error(`[webhook] falha ao notificar evento "${evento}":`, err.message);
  }
}
