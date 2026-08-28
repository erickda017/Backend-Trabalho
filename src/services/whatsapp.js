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

// [2026-08] DOIS ZAPS POR TENANT: cada usuário (operador) pode ter até 2
// sessões de WhatsApp (slot 1 e slot 2), distribuindo os disparos entre
// ambas pra não concentrar volume num número só -- restaura a funcionalidade
// que existia antes do multi-tenant (ver migration-4-slots-estrategia-pix.sql
// e migration-13-multi-tenant.sql, que a desativou só pra simplificar a
// virada multi-tenant, sem apagar dado). O padrão de estado (Map indexado
// por chave, guarda contra "sock fantasma", reconexão automática) é o mesmo
// de sempre; a chave do Map agora é `usuarioId` (slot 1, igual já era antes
// -- NENHUMA sessão existente precisa de migração) ou `usuarioId:2` (slot 2,
// novo). Slot 1 é sempre o "padrão" pra quem nunca configurou um segundo Zap
// -- toda chamada que não passa slot explicitamente continua se comportando
// exatamente como antes de dois Zaps existir.
//
// Nada aqui fica pareado sozinho no boot: cada operador precisa ter entrado
// no sistema e clicado "conectar" ao menos uma vez por slot (igual antes, só
// que agora até 2x por usuário).
const sessoes = new Map();

const SLOT_PADRAO = 1;

function slotValido(slot) {
  return slot === 2 ? 2 : SLOT_PADRAO;
}

// slot 1 usa a MESMA chave de sempre (bare usuarioId) -- sessão existente de
// quem já usava o sistema antes de dois Zaps continua funcionando sem
// nenhuma migração de dado. slot 2 é uma chave nova, só existe pra quem
// configurar o segundo número.
function chaveSessao(usuarioId, slot) {
  return slotValido(slot) === 2 ? `${usuarioId}:2` : usuarioId;
}

// Desfaz chaveSessao() -- usado no boot (startWhatsApp) pra descobrir de
// volta usuarioId+slot a partir do session_id salvo no banco. UUID de
// usuário nunca contém ":", então esse split é seguro.
function decomporChaveSessao(chave) {
  if (chave.endsWith(':2')) return { usuarioId: chave.slice(0, -2), slot: 2 };
  return { usuarioId: chave, slot: SLOT_PADRAO };
}

function estadoInicial(usuarioId, slot) {
  return {
    usuarioId,
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
    desconectandoManual: false, // true durante um logoutUsuario() em andamento -- evita a corrida abaixo
  };
}

function getEstado(usuarioId, slot = SLOT_PADRAO) {
  if (!usuarioId) throw new Error('usuarioId é obrigatório para operações de WhatsApp');
  const chave = chaveSessao(usuarioId, slot);
  if (!sessoes.has(chave)) sessoes.set(chave, estadoInicial(usuarioId, slotValido(slot)));
  return sessoes.get(chave);
}

// Quais slots (1, ou 1 e 2) já têm sessão conhecida (conectada ou não) na
// memória pra um usuário -- usado pra decidir se vale a pena tentar o slot 2
// em getSocketParaEnvio/isConnected.
function slotsConhecidos(usuarioId) {
  const slots = [];
  if (sessoes.has(chaveSessao(usuarioId, 1))) slots.push(1);
  if (sessoes.has(chaveSessao(usuarioId, 2))) slots.push(2);
  return slots;
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

  const chaves = [...new Set((data || []).map((r) => r.session_id))];
  for (const chave of chaves) {
    const { usuarioId, slot } = decomporChaveSessao(chave);
    const estado = getEstado(usuarioId, slot);
    estado.configurada = true;
    await conectarUsuario(usuarioId, slot).catch((err) =>
      console.error(`[whatsapp] erro ao reconectar usuário ${usuarioId} (slot ${slot}) no boot:`, err.message)
    );
  }
}

export async function conectarUsuario(usuarioId, slot = SLOT_PADRAO) {
  if (!usuarioId) throw new Error('usuarioId é obrigatório');
  slot = slotValido(slot);

  const estado = getEstado(usuarioId, slot);
  if (estado.status === 'connecting' || estado.status === 'connected') return getStatusUsuario(usuarioId, slot);

  estado.status = 'connecting';

  // session_id da tabela whatsapp_sessions é `usuarioId` (slot 1) ou
  // `usuarioId:2` (slot 2) -- ver chaveSessao(). Cada slot de cada operador
  // com sua própria linha de credenciais, totalmente isolada.
  const { state, saveCreds, clearState } = await useSupabaseAuthState(chaveSessao(usuarioId, slot));
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
      console.log(`[whatsapp] usuário ${usuarioId} (slot ${slot}) conectado`);
    }

    if (connection === 'close') {
      estado.status = 'disconnected';
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      // Se foi um logoutUsuario() explícito (usuário clicou "Desconectar"), NUNCA
      // reconecta sozinho -- antes disso não existia essa checagem, e o
      // auto-reconnect abaixo podia vencer a corrida com o logout manual e
      // religar a sessão segundos depois, dando a impressão de botão travado.
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !estado.desconectandoManual;
      console.log(`[whatsapp] usuário ${usuarioId} (slot ${slot}) conexão fechada. Reconectar?`, shouldReconnect);
      if (shouldReconnect) {
        conectarUsuario(usuarioId, slot).catch((err) =>
          console.error(`[whatsapp] erro ao reconectar usuário ${usuarioId} (slot ${slot}):`, err.message)
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

  return getStatusUsuario(usuarioId, slot);
}

export function getStatusUsuario(usuarioId, slot = SLOT_PADRAO) {
  const e = getEstado(usuarioId, slot);
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

// Status dos 2 slots de uma vez -- usado pela tela de Conexão, que agora
// mostra 2 cards (ver frontend). Slot 2 só é "relevante" (aparece como algo
// além de disconnected/nunca configurado) se o operador algum dia clicou
// conectar nele -- não polui a tela de quem usa só 1 número.
export function getStatusAmbosSlots(usuarioId) {
  return { 1: getStatusUsuario(usuarioId, 1), 2: getStatusUsuario(usuarioId, 2) };
}

export function getSocket(usuarioId, slot = SLOT_PADRAO) {
  const e = getEstado(usuarioId, slot);
  if (!e.sock || e.status !== 'connected') {
    throw new Error(`WhatsApp (slot ${slotValido(slot)}) não conectado. Conecte seu número na tela de Configurações.`);
  }
  return e.sock;
}

export function isConnected(usuarioId, slot = SLOT_PADRAO) {
  return getEstado(usuarioId, slot).status === 'connected';
}

// Verdadeiro se PELO MENOS UM dos 2 slots está conectado -- usado pra decidir
// se um disparo deve pausar por falta de conexão (só pausa se os DOIS
// estiverem fora, já que com 1 disponível o disparo continua nele).
export function isConnectedQualquerSlot(usuarioId) {
  return isConnected(usuarioId, 1) || isConnected(usuarioId, 2);
}

// Cursor de rodízio (round-robin) do slot 1/2, por usuário -- só em memória
// de propósito: perder esse cursor num redeploy só faz a alternância
// reiniciar do slot 1, sem nenhum risco de duplicar/perder disparo (quem
// decide o que já foi enviado é o status em `envio_itens`, não isto aqui).
const proximoSlotPorUsuario = new Map();

// Escolhe qual slot usar pro PRÓXIMO envio de um usuário: se só 1 dos 2
// estiver conectado, usa esse (nem tenta o outro); se os 2 estiverem
// conectados, alterna 50/50 entre eles; se nenhum estiver, devolve null (quem
// chama decide pausar o disparo). Restaura o comportamento antigo de
// distribuir carga entre 2 números (ver migration-4/lib/estrategia.js,
// versão pré-multi-tenant), agora por tenant em vez de global.
export function escolherSlotParaEnvio(usuarioId) {
  const slot1 = isConnected(usuarioId, 1);
  const slot2 = isConnected(usuarioId, 2);
  if (slot1 && !slot2) return 1;
  if (slot2 && !slot1) return 2;
  if (!slot1 && !slot2) return null;

  const proximo = proximoSlotPorUsuario.get(usuarioId) === 2 ? 2 : 1;
  proximoSlotPorUsuario.set(usuarioId, proximo === 1 ? 2 : 1);
  return proximo;
}

export async function logoutUsuario(usuarioId, slot = SLOT_PADRAO) {
  slot = slotValido(slot);
  const e = getEstado(usuarioId, slot);
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
      console.error(`[whatsapp] erro ao encerrar sessão do usuário ${usuarioId} (slot ${slot}):`, err.message);
    }
  }
  if (e.clearAuthState) await e.clearAuthState();

  sessoes.set(chaveSessao(usuarioId, slot), estadoInicial(usuarioId, slot));
  return getStatusUsuario(usuarioId, slot);
}

// Libera da memória o estado de uma sessão (usuarioId+slot) que ficou muito
// tempo desconectada (evita o Map crescer pra sempre num servidor de longa
// duração com muitos operadores passando por ali). Só remove do Map -- não
// mexe nas credenciais salvas no banco, então da próxima vez que o usuário
// abrir o sistema a gente reconecta normalmente sem pedir QR de novo.
export function liberarSessaoInativa(usuarioId, slot = SLOT_PADRAO) {
  const chave = chaveSessao(usuarioId, slot);
  const e = sessoes.get(chave);
  if (e && e.status === 'disconnected' && !e.sock) {
    sessoes.delete(chave);
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
    for (const chave of [...sessoes.keys()]) {
      const { usuarioId, slot } = decomporChaveSessao(chave);
      liberarSessaoInativa(usuarioId, slot);
    }
  }, INTERVALO_LIMPEZA_SESSOES_MS);
}

// Verifica se o número existe no WhatsApp antes de tentar enviar.
export async function validarNumero(numero, usuarioId, slot = SLOT_PADRAO) {
  const socket = getSocket(usuarioId, slot);
  const comCodigoPais = normalizarTelefone(numero);

  const [resultado] = await socket.onWhatsApp(comCodigoPais);
  return { existe: Boolean(resultado?.exists), jid: resultado?.jid || formatJid(numero) };
}

// IMPORTANTE: `jid` deve vir de validarNumero() sempre que possível -- é o JID
// REAL confirmado pelo WhatsApp via onWhatsApp(), que pode divergir do que
// formatJid(numero) monta na mão.
export async function enviarMensagemComPdf({ numero, jid, mensagem, pdfUrl, pdfNome, usuarioId, slot = SLOT_PADRAO }) {
  const socket = getSocket(usuarioId, slot);
  const destino = jid || formatJid(numero);

  const enviada = await socket.sendMessage(destino, {
    document: { url: pdfUrl },
    mimetype: 'application/pdf',
    fileName: pdfNome || 'fatura.pdf',
    caption: mensagem,
  });

  getEstado(usuarioId, slot).mensagensEnviadas += 1;
  return { messageId: enviada?.key?.id || null };
}

export async function enviarMensagemTexto({ numero, jid, mensagem, usuarioId, slot = SLOT_PADRAO }) {
  const socket = getSocket(usuarioId, slot);
  const destino = jid || formatJid(numero);
  const enviada = await socket.sendMessage(destino, { text: mensagem });
  getEstado(usuarioId, slot).mensagensEnviadas += 1;
  return { messageId: enviada?.key?.id || null };
}

// Envio genérico usado pelo Chat (resposta ao cliente). Sem slot explícito
// (Chat ainda não escolhe -- ver limitação no comentário de dispatchQueue.js)
// sempre responde pelo slot 1, igual ao comportamento de antes de dois Zaps.
export async function enviarMensagemComAnexo({ numero, jid, mensagem, anexoUrl, anexoNome, anexoTipo, anexoMimetype, usuarioId, slot = SLOT_PADRAO }) {
  const socket = getSocket(usuarioId, slot);
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
  getEstado(usuarioId, slot).mensagensEnviadas += 1;
  return { messageId: enviada?.key?.id || null };
}
