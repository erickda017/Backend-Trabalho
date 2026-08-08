import { downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { supabase, CHAT_BUCKET } from '../lib/supabase.js';
import { normalizarTelefone } from '../lib/telefone.js';

const logger = pino({ level: 'silent' });

// Desembrulha camadas que o WhatsApp usa pra mensagem "efêmera" (some depois de um tempo)
// ou "ver uma vez" -- o conteúdo real fica um nível mais fundo.
function desembrulhar(content) {
  return (
    content?.ephemeralMessage?.message ||
    content?.viewOnceMessage?.message ||
    content?.viewOnceMessageV2?.message ||
    content
  );
}

// Extrai { tipo, texto, mediaMsg, fileName, mimetype } de um WebMessageInfo.message.
// Retorna null se for um tipo que não tratamos (reação, enquete, mensagem de protocolo etc).
function interpretarConteudo(content) {
  const msg = desembrulhar(content);
  if (!msg) return null;

  if (msg.conversation) {
    return { tipo: 'texto', texto: msg.conversation };
  }
  if (msg.extendedTextMessage?.text) {
    return { tipo: 'texto', texto: msg.extendedTextMessage.text };
  }
  if (msg.imageMessage) {
    return { tipo: 'imagem', texto: msg.imageMessage.caption || null, mediaMsg: { imageMessage: msg.imageMessage }, mimetype: msg.imageMessage.mimetype, fileName: 'imagem.jpg' };
  }
  if (msg.stickerMessage) {
    return { tipo: 'imagem', texto: null, mediaMsg: { stickerMessage: msg.stickerMessage }, mimetype: msg.stickerMessage.mimetype, fileName: 'figurinha.webp' };
  }
  if (msg.audioMessage) {
    return { tipo: 'audio', texto: null, mediaMsg: { audioMessage: msg.audioMessage }, mimetype: msg.audioMessage.mimetype, fileName: 'audio.ogg' };
  }
  if (msg.documentMessage) {
    return {
      tipo: 'documento',
      texto: msg.documentMessage.caption || null,
      mediaMsg: { documentMessage: msg.documentMessage },
      mimetype: msg.documentMessage.mimetype,
      fileName: msg.documentMessage.fileName || 'arquivo',
    };
  }
  if (msg.videoMessage) {
    return {
      tipo: 'documento',
      texto: msg.videoMessage.caption || null,
      mediaMsg: { videoMessage: msg.videoMessage },
      mimetype: msg.videoMessage.mimetype,
      fileName: 'video.mp4',
    };
  }
  return null; // reação, enquete, mensagem apagada, protocolo etc -- ignora
}

async function baixarEGuardarMidia(sock, waMessage, { mediaMsg, mimetype, fileName }, telefone, messageId) {
  const buffer = await downloadMediaMessage(
    { message: mediaMsg, key: waMessage.key },
    'buffer',
    {},
    { logger, reuploadRequest: sock.updateMediaMessage }
  );

  const caminho = `${telefone}/${messageId}-${fileName}`;
  const { error: uploadError } = await supabase.storage
    .from(CHAT_BUCKET)
    .upload(caminho, buffer, { contentType: mimetype || 'application/octet-stream', upsert: true });

  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(CHAT_BUCKET).getPublicUrl(caminho);
  return { anexoUrl: data.publicUrl, anexoNome: fileName };
}

// Acha a conversa pelo telefone (cria se não existir) e atualiza os campos de resumo
// (nome, última mensagem, contador de não lidas). Retorna a linha da conversa.
async function upsertConversa({ telefone, nomeContato, texto, tipo, fromMe, quandoIso }) {
  const { data: existente } = await supabase
    .from('conversas')
    .select('*')
    .eq('telefone', telefone)
    .maybeSingle();

  const resumo = texto || (tipo === 'imagem' ? '📷 Imagem' : tipo === 'audio' ? '🎤 Áudio' : tipo === 'documento' ? '📄 Documento' : '');

  if (!existente) {
    let clienteId = null;
    const { data: cliente } = await supabase.from('clientes').select('id').eq('telefone', telefone).maybeSingle();
    if (cliente) clienteId = cliente.id;

    const { data, error } = await supabase
      .from('conversas')
      .insert({
        telefone,
        cliente_id: clienteId,
        nome_contato: nomeContato || null,
        nao_lidas: fromMe ? 0 : 1,
        ultima_mensagem: resumo,
        ultima_mensagem_em: quandoIso,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Só avança "última mensagem" se essa mensagem for mais nova que a que já tinha
  // registrada (o histórico inicial pode chegar fora de ordem).
  const ehMaisNova = !existente.ultima_mensagem_em || new Date(quandoIso) >= new Date(existente.ultima_mensagem_em);

  const { data, error } = await supabase
    .from('conversas')
    .update({
      nome_contato: nomeContato || existente.nome_contato,
      nao_lidas: fromMe ? existente.nao_lidas : existente.nao_lidas + 1,
      ...(ehMaisNova ? { ultima_mensagem: resumo, ultima_mensagem_em: quandoIso } : {}),
    })
    .eq('id', existente.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function processarMensagem(sock, waMessage) {
  const key = waMessage.key;
  const remoteJid = key?.remoteJid;
  const messageId = key?.id;
  if (!remoteJid || !messageId) return;
  if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return; // ignora grupo e status

  const interpretado = interpretarConteudo(waMessage.message);
  if (!interpretado) return;

  const fromMe = Boolean(key.fromMe);
  const telefone = normalizarTelefone(remoteJid.split('@')[0]);
  if (!telefone) return;

  const quandoIso = waMessage.messageTimestamp
    ? new Date(Number(waMessage.messageTimestamp) * 1000).toISOString()
    : new Date().toISOString();

  let anexoUrl = null;
  let anexoNome = null;
  if (interpretado.mediaMsg) {
    try {
      const resultado = await baixarEGuardarMidia(sock, waMessage, interpretado, telefone, messageId);
      anexoUrl = resultado.anexoUrl;
      anexoNome = resultado.anexoNome;
    } catch (err) {
      console.error('[chatIngest] erro ao baixar mídia:', err.message);
      // segue sem anexo -- melhor perder o arquivo do que perder o registro da mensagem
    }
  }

  const conversa = await upsertConversa({
    telefone,
    nomeContato: waMessage.pushName,
    texto: interpretado.texto,
    tipo: interpretado.tipo,
    fromMe,
    quandoIso,
  });

  const { error } = await supabase
    .from('mensagens')
    .upsert(
      {
        conversa_id: conversa.id,
        direcao: fromMe ? 'saida' : 'entrada',
        tipo: interpretado.tipo,
        texto: interpretado.texto,
        anexo_url: anexoUrl,
        anexo_nome: anexoNome,
        message_id: messageId,
        created_at: quandoIso,
      },
      { onConflict: 'message_id', ignoreDuplicates: true }
    );
  if (error) throw error;
}

// Usado pela rota de envio do Chat: grava a mensagem que ACABAMOS de mandar (texto
// e/ou anexo), sem precisar rebaixar mídia -- já temos o anexo em mãos.
// Quando o eco dessa mesma mensagem chegar pelo messages.upsert (fromMe: true), o
// upsert por message_id (ignoreDuplicates) evita duplicar.
export async function registrarMensagemSaida({ telefone, texto, tipo, anexoUrl, anexoNome, messageId }) {
  const quandoIso = new Date().toISOString();
  const conversa = await upsertConversa({ telefone, nomeContato: null, texto, tipo, fromMe: true, quandoIso });

  const { data, error } = await supabase
    .from('mensagens')
    .upsert(
      {
        conversa_id: conversa.id,
        direcao: 'saida',
        tipo,
        texto: texto || null,
        anexo_url: anexoUrl || null,
        anexo_nome: anexoNome || null,
        message_id: messageId,
        status_entrega: 'enviado',
        created_at: quandoIso,
      },
      { onConflict: 'message_id', ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();
  if (error) throw error;
  return { conversa, mensagem: data };
}

export async function registrarMensagensRecebidas(sock, messages) {
  for (const m of messages) {
    await processarMensagem(sock, m);
  }
}

export async function registrarHistoricoInicial(sock, messages) {
  // Processa em ordem cronológica pra "última mensagem" da conversa ficar coerente.
  const ordenadas = [...messages].sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
  for (const m of ordenadas) {
    await processarMensagem(sock, m);
  }
}
