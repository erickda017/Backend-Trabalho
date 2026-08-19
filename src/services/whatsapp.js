import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { supabase } from '../lib/supabase.js';
import { useSupabaseAuthState } from '../lib/supabaseAuthState.js';
import { dispararWebhook } from './webhook.js';
import { normalizarTelefone, formatJid } from '../lib/telefone.js';
import { registrarMensagensRecebidas, registrarHistoricoInicial } from './chatIngest.js';

export const SLOTS = [1, 2];

const logger = pino({ level: 'silent' });

// Baileys manda status como número: 0=pendente 1=enviado(servidor) 2=entregue(dispositivo) 3=lido 4=reproduzido(audio)
const STATUS_MAP = { 2: 'entregue', 3: 'lido', 4: 'lido' };

// Estado de cada sessão (chave = slot: 1 | 2). Antes era um único conjunto de
// variáveis de módulo (sock/lastQr/connectionStatus); agora o front opera com
// duas sessões WhatsApp independentes (ver README_CLAUDE_BACKEND.md, seção 2),
// então tudo vira um Map indexado por slot.
const sessoes = new Map();

function sessionIdDoSlot(slot) {
  // Compatível com sessões antigas de antes do multi-slot: se WHATSAPP_SESSION_ID
  // estiver setado e for o slot 1, reaproveita a sessão já pareada em vez de pedir
  // um QR novo.
  if (slot === 1 && process.env.WHATSAPP_SESSION_ID) return process.env.WHATSAPP_SESSION_ID;
  return `slot-${slot}`;
}

function estadoInicial(slot) {
  return {
    slot,
    sock: null,
    lastQr: null,
    status: 'disconnected', // disconnected | connecting | qr | connected
    telefone: null,
    nome: null,
    ultimaConexao: null,
    mensagensEnviadas: 0,
    configurada: false, // true assim que já pareou alguma vez (tem creds salvas)
    clearAuthState: null,
    desconectandoManual: false, // true durante um logoutSlot() em andamento -- evita a corrida abaixo
  };
}

function getEstado(slot) {
  if (!sessoes.has(slot)) sessoes.set(slot, estadoInicial(slot));
  return sessoes.get(slot);
}

// Sobe as sessões que já têm credenciais salvas (pareadas anteriormente) --
// chamado uma vez na subida do servidor. Slots nunca pareados ficam parados até
// o usuário clicar em "conectar" na tela, e não geram QR sozinhos no boot.
export async function startWhatsApp() {
  for (const slot of SLOTS) {
    const sessionId = sessionIdDoSlot(slot);
    const { data } = await supabase
      .from('whatsapp_sessions')
      .select('session_id')
      .eq('session_id', sessionId)
      .eq('key', 'creds')
      .maybeSingle();

    const estado = getEstado(slot);
    estado.configurada = Boolean(data);
    if (data) await conectarSlot(slot);
  }
}

export async function conectarSlot(slot) {
  if (!SLOTS.includes(slot)) throw new Error('slot inválido (use 1 ou 2)');

  const estado = getEstado(slot);
  if (estado.status === 'connecting' || estado.status === 'connected') return getStatusSlot(slot);

  estado.status = 'connecting';
  const sessionId = sessionIdDoSlot(slot);

  const { state, saveCreds, clearState } = await useSupabaseAuthState(sessionId);
  estado.clearAuthState = clearState;

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    // Default (60s) é curto pra latência Render <-> WhatsApp -- foi o que estourou
    // o sendPassiveIq (query interna do próprio Baileys, disparada sozinha após
    // conectar, sem try/catch nosso pra pegar). Sobe a margem em vez de tentar
    // "consertar" uma promise que não é nossa.
    defaultQueryTimeoutMs: 120_000,
  });
  estado.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    // Guarda contra "sock fantasma": se enquanto essa sessão caía o usuário já
    // clicou desconectar/conectar de novo, `estado.sock` já aponta pro socket
    // NOVO (ou null) -- eventos chegando atrasados do socket ANTIGO não podem
    // mais mexer no estado, senão sobrescrevem o que aconteceu depois.
    if (estado.sock !== sock) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      estado.lastQr = await QRCode.toDataURL(qr);
      estado.status = 'qr';
    }

    if (connection === 'open') {
      estado.status = 'connected';
      estado.lastQr = null;
      estado.configurada = true;
      estado.telefone = normalizarTelefone(sock.user?.id?.split(':')[0] || sock.user?.id || '') || null;
      estado.nome = sock.user?.name || sock.user?.notify || null;
      estado.ultimaConexao = new Date().toISOString();
      console.log(`[whatsapp] slot ${slot} conectado`);
    }

    if (connection === 'close') {
      estado.status = 'disconnected';
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      // Se foi um logoutSlot() explícito (usuário clicou "Desconectar"), NUNCA
      // reconecta sozinho -- antes disso não existia essa checagem, e o
      // auto-reconnect abaixo podia vencer a corrida com o logout manual e
      // religar a sessão segundos depois, dando a impressão de botão travado.
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !estado.desconectandoManual;
      console.log(`[whatsapp] slot ${slot} conexão fechada. Reconectar?`, shouldReconnect);
      if (shouldReconnect) {
        conectarSlot(slot).catch((err) => console.error(`[whatsapp] erro ao reconectar slot ${slot}:`, err.message));
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
    // Log de diagnóstico: mostra TODO evento que chega, mesmo os que a gente
    // acaba ignorando depois. Isso existe pra responder uma pergunta específica:
    // "quando eu respondo pelo celular, o evento chega aqui e a gente descarta,
    // ou ele nem chega?" -- sem esse log era impossível saber (o catch abaixo só
    // pega erro de banco, não mostra o que o Baileys de fato recebeu).
    // Se aparecer "stubType" no log de uma mensagem fromMe=true, é sinal de que o
    // WhatsApp não conseguiu decifrar o eco (sessão de criptografia entre o
    // celular e esta conexão vinculada ficou dessincronizada) -- nesse caso a
    // solução é reconectar (Desconectar + escanear o QR de novo), não um bug de
    // código: sem a chave decifrada não tem texto nenhum pra salvar.
    for (const m of messages) {
      console.log(
        `[whatsapp] slot ${slot} messages.upsert tipo=${type} fromMe=${m.key?.fromMe} remoteJid=${m.key?.remoteJid} id=${m.key?.id} temConteudo=${Boolean(m.message)} stubType=${m.messageStubType ?? '-'}`
      );
    }

    if (type !== 'notify') return; // 'notify' = mensagem nova chegando agora (ignora replays de sincronização, tratados abaixo)
    try {
      await registrarMensagensRecebidas(sock, messages, slot);
    } catch (err) {
      console.error('[whatsapp] erro ao registrar mensagens recebidas:', err.message);
    }
  });

  // Só acontece uma vez, logo após escanear um QR novo: o WhatsApp manda um lote
  // (parcial, sem garantia de completude) do histórico recente de conversas.
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    try {
      await registrarHistoricoInicial(sock, messages, slot);
    } catch (err) {
      console.error('[whatsapp] erro ao registrar histórico inicial:', err.message);
    }
  });

  return getStatusSlot(slot);
}

export function getStatusSlot(slot) {
  const e = getEstado(slot);
  return {
    slot,
    configurada: e.configurada,
    status: e.status,
    qr: e.lastQr,
    telefone: e.telefone,
    nome: e.nome,
    ultima_conexao: e.ultimaConexao,
    mensagens_enviadas: e.mensagensEnviadas,
  };
}

export function listarConexoes() {
  return SLOTS.map((slot) => getStatusSlot(slot));
}

// Status agregado -- compatibilidade com a versão de conexão única (usado por
// GET /whatsapp/status). "Conectado" se pelo menos um slot estiver conectado.
export function getStatus() {
  const conexoes = listarConexoes();
  const conectada = conexoes.find((c) => c.status === 'connected');
  if (conectada) return { status: 'connected', qr: null };
  const emQr = conexoes.find((c) => c.status === 'qr');
  if (emQr) return { status: 'qr', qr: emQr.qr };
  const conectando = conexoes.find((c) => c.status === 'connecting');
  if (conectando) return { status: 'connecting', qr: null };
  return { status: 'disconnected', qr: null };
}

export function getSocket(slot) {
  const s = slotConectado(slot);
  const e = getEstado(s);
  if (!e.sock) throw new Error(`WhatsApp (slot ${s}) não inicializado ainda`);
  return e.sock;
}

export function isConnected(slot) {
  if (slot) return getEstado(slot).status === 'connected';
  return SLOTS.some((s) => getEstado(s).status === 'connected');
}

export function slotsConectados() {
  return SLOTS.filter((s) => getEstado(s).status === 'connected');
}

// Resolve qual slot usar de fato quando quem chamou não exigiu um slot específico
// -- usa o primeiro conectado. Lança erro claro se nenhum estiver disponível.
function slotConectado(slot) {
  if (slot && getEstado(slot).status === 'connected') return slot;
  const conectados = slotsConectados();
  if (conectados.length) return conectados[0];
  throw new Error('Nenhuma conexão WhatsApp disponível (nenhum slot conectado)');
}

export async function logoutSlot(slot) {
  const e = getEstado(slot);
  e.desconectandoManual = true;
  if (e.sock) {
    const sockAntigo = e.sock;
    // Zera a referência ANTES de chamar logout(): qualquer evento 'close' do
    // socket antigo que ainda esteja em voo vê `estado.sock !== sock` (guarda
    // acima) e não reconecta sozinho, mesmo se chegar atrasado.
    e.sock = null;
    try {
      await sockAntigo.logout();
    } catch (err) {
      console.error(`[whatsapp] erro ao encerrar sessão do slot ${slot}:`, err.message);
    }
  }
  if (e.clearAuthState) await e.clearAuthState();

  sessoes.set(slot, estadoInicial(slot));
  return getStatusSlot(slot);
}

// Compatibilidade legada (POST /whatsapp/logout): encerra todas as sessões.
export async function logoutWhatsApp() {
  for (const slot of SLOTS) {
    if (getEstado(slot).status !== 'disconnected') await logoutSlot(slot);
  }
}

// Verifica se o número existe no WhatsApp antes de tentar enviar.
export async function validarNumero(numero, slot) {
  const socket = getSocket(slot);
  const comCodigoPais = normalizarTelefone(numero);

  const [resultado] = await socket.onWhatsApp(comCodigoPais);
  return { existe: Boolean(resultado?.exists), jid: resultado?.jid || formatJid(numero) };
}

// IMPORTANTE: `jid` deve vir de validarNumero() sempre que possível -- é o JID
// REAL confirmado pelo WhatsApp via onWhatsApp(), que pode divergir do que
// formatJid(numero) monta na mão.
export async function enviarMensagemComPdf({ numero, jid, mensagem, pdfUrl, pdfNome, slot }) {
  const usado = slotConectado(slot);
  const socket = getSocket(usado);
  const destino = jid || formatJid(numero);

  const enviada = await socket.sendMessage(destino, {
    document: { url: pdfUrl },
    mimetype: 'application/pdf',
    fileName: pdfNome || 'fatura.pdf',
    caption: mensagem,
  });

  getEstado(usado).mensagensEnviadas += 1;
  return { messageId: enviada?.key?.id || null, slot: usado };
}

export async function enviarMensagemTexto({ numero, jid, mensagem, slot }) {
  const usado = slotConectado(slot);
  const socket = getSocket(usado);
  const destino = jid || formatJid(numero);
  const enviada = await socket.sendMessage(destino, { text: mensagem });
  getEstado(usado).mensagensEnviadas += 1;
  return { messageId: enviada?.key?.id || null, slot: usado };
}

// Envio genérico usado pelo Chat (resposta ao cliente).
export async function enviarMensagemComAnexo({ numero, jid, mensagem, anexoUrl, anexoNome, anexoTipo, anexoMimetype, slot }) {
  const usado = slotConectado(slot);
  const socket = getSocket(usado);
  const destino = jid || formatJid(numero);

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

  const enviada = await socket.sendMessage(destino, payload);
  getEstado(usado).mensagensEnviadas += 1;
  return { messageId: enviada?.key?.id || null, slot: usado };
}
