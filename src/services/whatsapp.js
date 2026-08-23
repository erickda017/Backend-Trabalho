import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { supabase } from '../lib/supabase.js';
import { useSupabaseAuthState } from '../lib/supabaseAuthState.js';
import { dispararWebhook } from './webhook.js';
import { normalizarTelefone, formatJid } from '../lib/telefone.js';
import { registrarMensagensRecebidas, registrarHistoricoInicial } from './chatIngest.js';

const logger = pino({ level: 'silent' });

// Baileys manda status como número: 0=pendente 1=enviado(servidor) 2=entregue(dispositivo) 3=lido 4=reproduzido(audio)
const STATUS_MAP = { 2: 'entregue', 3: 'lido', 4: 'lido' };

// [2026-08] MULTI-TENANT: cada usuário (operador) tem exatamente 1 sessão de
// WhatsApp própria. Isto substitui o antigo esquema de "slots" (1|2, números
// fixos compartilhados por toda a operação) -- ver migration-13-multi-tenant.sql.
// O padrão de estado (Map indexado por chave, guarda contra "sock fantasma",
// reconexão automática) é o mesmo de antes; só a chave do Map mudou de
// `slot` (number) para `usuarioId` (string, o auth.users.id do operador).
//
// Nada aqui fica pareado sozinho no boot: cada operador precisa ter entrado
// no sistema e clicado "conectar" ao menos uma vez (igual antes, só que por
// usuário em vez de globalmente).
const sessoes = new Map();

function estadoInicial(usuarioId) {
  return {
    usuarioId,
    sock: null,
    lastQr: null,
    status: 'disconnected', // disconnected | connecting | qr | connected
    telefone: null,
    nome: null,
    ultimaConexao: null,
    mensagensEnviadas: 0,
    configurada: false, // true assim que já pareou alguma vez (tem creds salvas)
    clearAuthState: null,
    desconectandoManual: false, // true durante um logoutUsuario() em andamento -- evita a corrida abaixo
  };
}

function getEstado(usuarioId) {
  if (!usuarioId) throw new Error('usuarioId é obrigatório para operações de WhatsApp');
  if (!sessoes.has(usuarioId)) sessoes.set(usuarioId, estadoInicial(usuarioId));
  return sessoes.get(usuarioId);
}

// Sobe, no boot do servidor, as sessões que já têm credenciais salvas
// (usuários que já pareiam o WhatsApp anteriormente) -- assim ninguém
// precisa escanear o QR de novo só porque o servidor reiniciou (deploy,
// restart do Render etc). Usuários que nunca conectaram ficam parados até
// clicar em "conectar" na tela, e não geram QR sozinhos no boot.
export async function startWhatsApp() {
  const { data, error } = await supabase.from('whatsapp_sessions').select('session_id').eq('key', 'creds');

  if (error) {
    console.error('[whatsapp] erro ao listar sessões salvas no boot:', error.message);
    return;
  }

  const usuarioIds = [...new Set((data || []).map((r) => r.session_id))];
  for (const usuarioId of usuarioIds) {
    const estado = getEstado(usuarioId);
    estado.configurada = true;
    await conectarUsuario(usuarioId).catch((err) =>
      console.error(`[whatsapp] erro ao reconectar usuário ${usuarioId} no boot:`, err.message)
    );
  }
}

export async function conectarUsuario(usuarioId) {
  if (!usuarioId) throw new Error('usuarioId é obrigatório');

  const estado = getEstado(usuarioId);
  if (estado.status === 'connecting' || estado.status === 'connected') return getStatusUsuario(usuarioId);

  estado.status = 'connecting';

  // session_id da tabela whatsapp_sessions passa a SER o usuarioId -- cada
  // operador com sua própria linha de credenciais, totalmente isolada.
  const { state, saveCreds, clearState } = await useSupabaseAuthState(usuarioId);
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
      console.log(`[whatsapp] usuário ${usuarioId} conectado`);
    }

    if (connection === 'close') {
      estado.status = 'disconnected';
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      // Se foi um logoutUsuario() explícito (usuário clicou "Desconectar"), NUNCA
      // reconecta sozinho -- antes disso não existia essa checagem, e o
      // auto-reconnect abaixo podia vencer a corrida com o logout manual e
      // religar a sessão segundos depois, dando a impressão de botão travado.
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !estado.desconectandoManual;
      console.log(`[whatsapp] usuário ${usuarioId} conexão fechada. Reconectar?`, shouldReconnect);
      if (shouldReconnect) {
        conectarUsuario(usuarioId).catch((err) =>
          console.error(`[whatsapp] erro ao reconectar usuário ${usuarioId}:`, err.message)
        );
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

        // envio_itens não tem usuario_id próprio, mas message_id já é único
        // por definição do WhatsApp (por sessão) -- e cada sessão pertence a
        // um usuário só, então não há ambiguidade de dono aqui.
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
        `[whatsapp] usuário ${usuarioId} messages.upsert tipo=${type} fromMe=${m.key?.fromMe} remoteJid=${m.key?.remoteJid} id=${m.key?.id} temConteudo=${Boolean(m.message)} stubType=${m.messageStubType ?? '-'}`
      );
    }

    if (type !== 'notify') return; // 'notify' = mensagem nova chegando agora (ignora replays de sincronização, tratados abaixo)
    try {
      await registrarMensagensRecebidas(sock, messages, usuarioId);
    } catch (err) {
      console.error('[whatsapp] erro ao registrar mensagens recebidas:', err.message);
    }
  });

  // Só acontece uma vez, logo após escanear um QR novo: o WhatsApp manda um lote
  // (parcial, sem garantia de completude) do histórico recente de conversas.
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    try {
      await registrarHistoricoInicial(sock, messages, usuarioId);
    } catch (err) {
      console.error('[whatsapp] erro ao registrar histórico inicial:', err.message);
    }
  });

  return getStatusUsuario(usuarioId);
}

export function getStatusUsuario(usuarioId) {
  const e = getEstado(usuarioId);
  return {
    configurada: e.configurada,
    status: e.status,
    qr: e.lastQr,
    telefone: e.telefone,
    nome: e.nome,
    ultima_conexao: e.ultimaConexao,
    mensagens_enviadas: e.mensagensEnviadas,
  };
}

export function getSocket(usuarioId) {
  const e = getEstado(usuarioId);
  if (!e.sock || e.status !== 'connected') {
    throw new Error('WhatsApp não conectado. Conecte seu número na tela de Configurações.');
  }
  return e.sock;
}

export function isConnected(usuarioId) {
  return getEstado(usuarioId).status === 'connected';
}

export async function logoutUsuario(usuarioId) {
  const e = getEstado(usuarioId);
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
      console.error(`[whatsapp] erro ao encerrar sessão do usuário ${usuarioId}:`, err.message);
    }
  }
  if (e.clearAuthState) await e.clearAuthState();

  sessoes.set(usuarioId, estadoInicial(usuarioId));
  return getStatusUsuario(usuarioId);
}

// Libera da memória o estado de um usuário que ficou muito tempo desconectado
// (evita o Map crescer pra sempre num servidor de longa duração com muitos
// operadores passando por ali). Só remove do Map -- não mexe nas credenciais
// salvas no banco, então da próxima vez que o usuário abrir o sistema a gente
// reconecta normalmente sem pedir QR de novo.
export function liberarSessaoInativa(usuarioId) {
  const e = sessoes.get(usuarioId);
  if (e && e.status === 'disconnected' && !e.sock) {
    sessoes.delete(usuarioId);
  }
}

// [2026-08] Varredura periódica que efetivamente CHAMA liberarSessaoInativa --
// antes a função existia mas nada a invocava, então o Map "sessoes" só
// crescia (nunca encolhia), mesmo pra usuários que só entraram, nunca
// pareiam o WhatsApp de verdade e não voltam mais. Roda a cada 30 minutos,
// bem menos frequente que o polling de status (3-30s) pra não competir por
// CPU à toa -- isso é limpeza de memória, não caminho crítico de latência.
const INTERVALO_LIMPEZA_SESSOES_MS = 30 * 60 * 1000;
export function iniciarLimpezaSessoesInativas() {
  setInterval(() => {
    for (const usuarioId of [...sessoes.keys()]) {
      liberarSessaoInativa(usuarioId);
    }
  }, INTERVALO_LIMPEZA_SESSOES_MS);
}

// Verifica se o número existe no WhatsApp antes de tentar enviar.
export async function validarNumero(numero, usuarioId) {
  const socket = getSocket(usuarioId);
  const comCodigoPais = normalizarTelefone(numero);

  const [resultado] = await socket.onWhatsApp(comCodigoPais);
  return { existe: Boolean(resultado?.exists), jid: resultado?.jid || formatJid(numero) };
}

// IMPORTANTE: `jid` deve vir de validarNumero() sempre que possível -- é o JID
// REAL confirmado pelo WhatsApp via onWhatsApp(), que pode divergir do que
// formatJid(numero) monta na mão.
export async function enviarMensagemComPdf({ numero, jid, mensagem, pdfUrl, pdfNome, usuarioId }) {
  const socket = getSocket(usuarioId);
  const destino = jid || formatJid(numero);

  const enviada = await socket.sendMessage(destino, {
    document: { url: pdfUrl },
    mimetype: 'application/pdf',
    fileName: pdfNome || 'fatura.pdf',
    caption: mensagem,
  });

  getEstado(usuarioId).mensagensEnviadas += 1;
  return { messageId: enviada?.key?.id || null };
}

export async function enviarMensagemTexto({ numero, jid, mensagem, usuarioId }) {
  const socket = getSocket(usuarioId);
  const destino = jid || formatJid(numero);
  const enviada = await socket.sendMessage(destino, { text: mensagem });
  getEstado(usuarioId).mensagensEnviadas += 1;
  return { messageId: enviada?.key?.id || null };
}

// Envio genérico usado pelo Chat (resposta ao cliente).
export async function enviarMensagemComAnexo({ numero, jid, mensagem, anexoUrl, anexoNome, anexoTipo, anexoMimetype, usuarioId }) {
  const socket = getSocket(usuarioId);
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
  getEstado(usuarioId).mensagensEnviadas += 1;
  return { messageId: enviada?.key?.id || null };
}
