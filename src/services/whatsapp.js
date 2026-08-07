import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { supabase } from '../lib/supabase.js';
import { dispararWebhook } from './webhook.js';
import { normalizarTelefone, formatJid } from '../lib/telefone.js';

const AUTH_DIR = process.env.WHATSAPP_SESSION_PATH
  ? path.resolve(process.env.WHATSAPP_SESSION_PATH, 'default')
  : path.resolve('sessions', 'default');
fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let lastQr = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | qr | connected

const logger = pino({ level: 'silent' });

// Baileys manda status como número: 0=pendente 1=enviado(servidor) 2=entregue(dispositivo) 3=lido 4=reproduzido(audio)
const STATUS_MAP = { 2: 'entregue', 3: 'lido', 4: 'lido' };

export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

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
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });

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

export async function enviarMensagemComPdf({ numero, mensagem, pdfUrl, pdfNome }) {
  const socket = getSocket();
  const jid = formatJid(numero);

  const enviada = await socket.sendMessage(jid, {
    document: { url: pdfUrl },
    mimetype: 'application/pdf',
    fileName: pdfNome || 'fatura.pdf',
    caption: mensagem,
  });

  return { messageId: enviada?.key?.id || null };
}

export async function enviarMensagemTexto({ numero, mensagem }) {
  const socket = getSocket();
  const jid = formatJid(numero);
  const enviada = await socket.sendMessage(jid, { text: mensagem });
  return { messageId: enviada?.key?.id || null };
}
