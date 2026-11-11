// Disparo / E-mail -- API transacional da Brevo. A chave NUNCA sai do backend (env). `fetchImpl` injetável: os testes
// usam um provedor simulado e não falam com a rede.
const BASE = 'https://api.brevo.com/v3';

export function configuracaoBrevo(env = process.env) {
  const faltando = ['BREVO_API_KEY', 'BREVO_FROM_EMAIL', 'BREVO_FROM_NAME'].filter((k) => !env[k]?.trim());
  return {
    configurado: faltando.length === 0,
    faltando,
    apiKey: env.BREVO_API_KEY?.trim() || '',
    fromEmail: env.BREVO_FROM_EMAIL?.trim() || '',
    fromName: env.BREVO_FROM_NAME?.trim() || '',
    replyTo: env.BREVO_REPLY_TO?.trim() || '',
  };
}

// Resultado tipado: o worker decide repetir (transitório), desistir (definitivo) ou reconciliar (incerto).
//  { ok: true, messageId }                          aceito pela Brevo
//  { ok: false, tipo: 'definitivo', status, erro }  400/401/403/404...: repetir não adianta
//  { ok: false, tipo: 'transitorio', status, erro } 429: a Brevo respondeu explicitamente que NÃO aceitou
//  { ok: false, tipo: 'incerto', erro }             timeout/queda/5xx (502/504 de gateway podem ter sido aceitos): reconciliar antes de repetir
export async function enviarTransacional({ cfg, para, assunto, html, anexoNome, anexoBase64 }, fetchImpl = fetch) {
  const corpo = {
    sender: { name: cfg.fromName, email: cfg.fromEmail },
    to: [{ email: para }],
    subject: assunto,
    htmlContent: html,
    attachment: [{ name: anexoNome, content: anexoBase64 }],
    ...(cfg.replyTo ? { replyTo: { email: cfg.replyTo } } : {}),
  };
  let r;
  try {
    r = await fetchImpl(`${BASE}/smtp/email`, {
      method: 'POST',
      headers: { 'api-key': cfg.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, tipo: 'incerto', erro: 'sem_resposta' };
  }
  const json = await r.json().catch(() => null);
  if (r.status === 201 || r.status === 200) {
    const messageId = json?.messageId ?? json?.messageIds?.[0];
    return messageId ? { ok: true, messageId: String(messageId) } : { ok: false, tipo: 'incerto', erro: 'sem_message_id' };
  }
  if (r.status === 429) return { ok: false, tipo: 'transitorio', status: r.status, erro: 'http_429' };
  if (r.status >= 500) return { ok: false, tipo: 'incerto', status: r.status, erro: `http_${r.status}` };
  return { ok: false, tipo: 'definitivo', status: r.status, erro: `http_${r.status}` };
}

// Reconciliação depois de resultado incerto: procura e-mails transacionais para o destinatário com o mesmo assunto
// ENVIADOS A PARTIR de `desdeIso` (o instante da tentativa; um e-mail de antes não conta como este envio).
// A API de listagem filtra por DATA (YYYY-MM-DD): consulta ontem..hoje e filtra pelo instante aqui.
// Achou => já foi aceito (devolve o messageId). Não achou => ainda pode não ter sido indexado: quem chama espera e tenta
// de novo antes de repetir. null = não consegui consultar (continua incerto: NÃO repete).
export async function procurarEnvioRecente({ cfg, para, assunto, desdeIso, ignorarMessageIds = [] }, fetchImpl = fetch) {
  const desde = Date.parse(desdeIso);
  const ignorar = new Set(ignorarMessageIds.map(String)); // já pertencem a outro envio nosso (mesma pessoa, 2 faturas no mês)
  const dia = (ms) => new Date(ms).toISOString().slice(0, 10);
  const url = `${BASE}/smtp/emails?email=${encodeURIComponent(para)}&startDate=${dia(desde - 86_400_000)}&endDate=${dia(Date.now() + 86_400_000)}&limit=20&sort=desc`;
  try {
    const r = await fetchImpl(url, { headers: { 'api-key': cfg.apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const json = await r.json();
    const achado = (json?.transactionalEmails ?? []).find((e) => e?.subject === assunto && e?.messageId && !ignorar.has(String(e.messageId)) && !(Date.parse(e.date) < desde));
    return { encontrado: Boolean(achado), messageId: achado?.messageId ? String(achado.messageId) : null };
  } catch {
    return null;
  }
}
