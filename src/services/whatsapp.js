import makeWASocket, { DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { supabase, BUCKET } from '../lib/supabase.js';
import { useSupabaseAuthState } from '../lib/supabaseAuthState.js';
import { dispararWebhook } from './webhook.js';
import { normalizarTelefone, formatJid } from '../lib/telefone.js';
import { registrarMensagensRecebidas, registrarHistoricoInicial } from './chatIngest.js';

// Identificador da sessão dentro da tabela whatsapp_sessions (permite, no futuro,
// rodar mais de um número/instância trocando essa env var).
const SESSION_ID = process.env.WHATSAPP_SESSION_ID || 'default';

let sock = null;
let lastQr = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | qr | connected
let clearAuthState = null; // função pra apagar a sessão salva no Supabase (setada no startWhatsApp)

const logger = pino({ level: 'silent' });

// Baileys manda status como número: 0=pendente 1=enviado(servidor) 2=entregue(dispositivo) 3=lido 4=reproduzido(audio)
const STATUS_MAP = { 2: 'entregue', 3: 'lido', 4: 'lido' };

export async function startWhatsApp() {
  const { state, saveCreds, clearState } = await useSupabaseAuthState(SESSION_ID);
  clearAuthState = clearState;

  sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQr = await QRCode.toDataURL(qr);
      connectionStatus = 'qr';
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      lastQr = null;
      console.log('[whatsapp] conectado');
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('[whatsapp] conexão fechada. Reconectar?', shouldReconnect);
      if (shouldReconnect) {
        startWhatsApp();
      }
    }
  });

  // Recebe atualizações de status de entrega/leitura das mensagens enviadas
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      const status = update.update?.status;
      const messageId = update.key?.id;
      const novoStatus = STATUS_MAP[status];
      if (!novoStatus || !messageId) continue;

      try {
        const campoData = novoStatus === 'lido' ? { lido_em: new Date().toISOString() } : { entregue_em: new Date().toISOString() };

        const { data: item } = await supabase
          .from('envio_itens')
          .update({ status_entrega: novoStatus, ...campoData })
          .eq('message_id', messageId)
          .select('*, clientes(nome, telefone)')
          .maybeSingle();

        if (item) {
          dispararWebhook('entrega_atualizada', {
            envio_id: item.envio_id,
            envio_item_id: item.id,
            cliente: item.clientes,
            status_entrega: novoStatus,
          });
        }
      } catch (err) {
        console.error('[whatsapp] erro ao atualizar status de entrega:', err.message);
      }
    }
  });

  // Mensagens novas (recebidas do cliente OU enviadas por outro app/celular ligado à
  // mesma conta). Grava no chat -- é o que faz a aba Chat ter dado de verdade.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // 'notify' = mensagem nova chegando agora (ignora replays de sincronização, tratados abaixo)
    try {
      await registrarMensagensRecebidas(sock, messages);
    } catch (err) {
      console.error('[whatsapp] erro ao registrar mensagens recebidas:', err.message);
    }
  });

  // Só acontece uma vez, logo após escanear um QR novo: o WhatsApp manda um lote
  // (parcial, sem garantia de completude) do histórico recente de conversas.
  // Tentamos aproveitar esse lote pra popular o chat com mensagens anteriores à
  // conexão -- bônus, não é uma fonte confiável de histórico completo.
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    try {
      await registrarHistoricoInicial(sock, messages);
    } catch (err) {
      console.error('[whatsapp] erro ao registrar histórico inicial:', err.message);
    }
  });

  return sock;
}

export function getStatus() {
  return { status: connectionStatus, qr: lastQr };
}

export function getSocket() {
  if (!sock) throw new Error('WhatsApp não inicializado ainda');
  return sock;
}

export function isConnected() {
  return connectionStatus === 'connected';
}

export async function logoutWhatsApp() {
  if (sock) {
    await sock.logout();
    sock = null;
    connectionStatus = 'disconnected';
  }
  // Apaga a sessão salva no Supabase (linhas da whatsapp_sessions), no lugar do
  // antigo fs.rmSync no diretório em disco.
  if (clearAuthState) await clearAuthState();

  // Depois de um logout explícito, o Baileys NÃO reconecta sozinho (é o comportamento
  // esperado dele: statusCode 'loggedOut' desativa o auto-reconnect em connection.update).
  // Sem essa chamada, o sistema ficaria sem gerar um QR Code novo até reiniciar o servidor.
  await startWhatsApp();
}

// Verifica se o número existe no WhatsApp antes de tentar enviar.
// Retorna { existe: boolean, jid: string } -- jid pode vir com formatação diferente (o real da conta).
export async function validarNumero(numero) {
  const socket = getSocket();
  const comCodigoPais = normalizarTelefone(numero);

  const [resultado] = await socket.onWhatsApp(comCodigoPais);
  return { existe: Boolean(resultado?.exists), jid: resultado?.jid || formatJid(numero) };
}

// IMPORTANTE: `jid` deve vir de validarNumero() sempre que possível -- é o JID
// REAL confirmado pelo WhatsApp via onWhatsApp(), que pode divergir do que
// formatJid(numero) monta na mão (ex: número antigo registrado sem o 9º dígito).
// Mandar pro JID "adivinhado" em vez do JID validado é o motivo clássico de a
// mensagem sair como "enviada" no Baileys (sem erro) e nunca chegar de verdade
// no aparelho: o socket aceita o envio, mas o destino não existe como tal.
export async function enviarMensagemComPdf({ numero, jid, mensagem, pdfUrl, pdfNome }) {
  const socket = getSocket();
  const destino = jid || formatJid(numero);

  const enviada = await socket.sendMessage(destino, {
    document: { url: pdfUrl },
    mimetype: 'application/pdf',
    fileName: pdfNome || 'fatura.pdf',
    caption: mensagem,
  });

  return { messageId: enviada?.key?.id || null };
}

export async function enviarMensagemTexto({ numero, jid, mensagem }) {
  const socket = getSocket();
  const destino = jid || formatJid(numero);
  const enviada = await socket.sendMessage(destino, { text: mensagem });
  return { messageId: enviada?.key?.id || null };
}

// Envio genérico usado pelo Chat (resposta ao cliente) -- diferente do
// enviarMensagemComPdf, aqui o anexo pode ser imagem, áudio ou documento qualquer,
// e o texto é opcional (pode mandar só o anexo, ou só texto).
export async function enviarMensagemComAnexo({ numero, mensagem, anexoUrl, anexoNome, anexoTipo, anexoMimetype }) {
  const socket = getSocket();
  const jid = formatJid(numero);

  let payload;
  if (anexoUrl && anexoTipo === 'imagem') {
    payload = { image: { url: anexoUrl }, caption: mensagem || undefined };
  } else if (anexoUrl && anexoTipo === 'audio') {
    payload = { audio: { url: anexoUrl }, mimetype: anexoMimetype || 'audio/mpeg', ptt: false };
  } else if (anexoUrl) {
    payload = {
      document: { url: anexoUrl },
      mimetype: anexoMimetype || 'application/octet-stream',
      fileName: anexoNome || 'arquivo',
      caption: mensagem || undefined,
    };
  } else {
    payload = { text: mensagem || '' };
  }

  const enviada = await socket.sendMessage(jid, payload);
  return { messageId: enviada?.key?.id || null };
}
