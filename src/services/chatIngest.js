import { downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { supabase, CHAT_BUCKET } from '../lib/supabase.js';
import { normalizarTelefone, normalizarVariantes } from '../lib/telefone.js';

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

// Tenta achar o TELEFONE REAL por trás de um "@lid" (identificador opaco que o
// WhatsApp usa pra esconder o número em alguns contatos, cada vez mais comum).
// Ordem de tentativas, da mais confiável pra mais arriscada:
//  1) key.remoteJidAlt -- o Baileys manda esse campo (o par PN do lid) tanto em
//     mensagem RECEBIDA quanto ENVIADA. É o campo certo pra chat 1:1 (em grupo
//     seria participantAlt, mas grupo já é ignorado lá em cima).
//  2) key.senderPn -- só vem preenchido em mensagem que a gente RECEBE
//     (fromMe: false). Pra mensagem que A GENTE manda (fromMe: true) pro mesmo
//     contato blindado, o Baileys geralmente manda undefined aqui -- é uma
//     issue conhecida do Baileys (WhiskeySockets/Baileys#2042). Por isso
//     remoteJidAlt vem primeiro: se só checássemos senderPn (como o código
//     antigo fazia), toda vez que VOCÊ respondesse um contato de lid blindado
//     o telefone não seria resolvido -- e é exatamente esse o caminho que gera
//     o bug relatado (ver nota em processarMensagem).
//  3) cache interno do próprio Baileys (signalRepository.lidMapping) -- pode já
//     ter a resposta mesmo sem vir na mensagem. Função opcional dependendo da
//     versão instalada, por isso tudo com optional chaining.
// Se nada resolver, devolve null -- quem chamou decide o que fazer (a gente NUNCA
// inventa um telefone a partir do próprio lid, ver processarMensagem).
async function resolverTelefonePorLid(sock, key) {
  if (key.remoteJidAlt) return key.remoteJidAlt.split('@')[0];
  if (key.senderPn) return key.senderPn.split('@')[0];
  try {
    const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(key.remoteJid);
    if (pn) return String(pn).split('@')[0];
  } catch {
    // mapeamento indisponível nessa versão/momento -- segue sem resolver
  }
  return null;
}

// Quando a gente FINALMENTE resolve o telefone real de um contato que antes só
// tínhamos como "@lid" (ver resolverTelefonePorLid), pode já existir uma conversa
// fantasma salva sob o id opaco do lid. Funde ela na conversa certa (ou, se a
// conversa certa ainda não existe, só "renomeia" a fantasma) -- sem isso, o
// histórico anterior ficaria pra sempre num contato separado.
async function fundirFantasmaLidSeExistir(telefonePseudo, telefoneReal) {
  if (telefonePseudo === telefoneReal) return;
  const { data: fantasma } = await supabase.from('conversas').select('id').eq('telefone', telefonePseudo).maybeSingle();
  if (!fantasma) return;

  const { data: real } = await supabase.from('conversas').select('id').eq('telefone', telefoneReal).maybeSingle();
  if (real) {
    await supabase.from('mensagens').update({ conversa_id: real.id }).eq('conversa_id', fantasma.id);
    await supabase.from('conversas').delete().eq('id', fantasma.id);
  } else {
    await supabase
      .from('conversas')
      .update({ telefone: telefoneReal, numero_nao_confirmado: false })
      .eq('id', fantasma.id);
  }
}

// Acha a conversa pelo telefone (cria se não existir) e atualiza os campos de resumo
// (nome, última mensagem, contador de não lidas). Retorna a linha da conversa.
async function upsertConversa({ telefone, nomeContato, texto, tipo, fromMe, quandoIso, slot, numeroNaoConfirmado }) {
  // Busca por QUALQUER variação do telefone (com/sem o 9º dígito, ver
  // normalizarVariantes) -- não só pelo valor exato. Sem isso, a fatura enviada
  // com o telefone salvo num formato e a resposta do cliente chegando no outro
  // formato (o WhatsApp sempre manda o formato atual, com 9) nunca se encontram:
  // vira conversa nova, sem o cliente vinculado, com o nome do perfil dele.
  const variantesTelefone = normalizarVariantes(telefone);
  const { data: existente } = await supabase
    .from('conversas')
    .select('*')
    .in('telefone', variantesTelefone)
    .maybeSingle();

  const resumo = texto || (tipo === 'imagem' ? '📷 Imagem' : tipo === 'audio' ? '🎤 Áudio' : tipo === 'documento' ? '📄 Documento' : '');

  if (!existente) {
    let clienteId = null;
    let nomeCliente = null;
    const { data: cliente } = await supabase.from('clientes').select('id, nome').in('telefone', variantesTelefone).maybeSingle();
    if (cliente) {
      clienteId = cliente.id;
      nomeCliente = cliente.nome;
    }

    // Prioriza o nome já cadastrado (planilha/boleto) sobre o pushName do WhatsApp --
    // pushName é o que a PESSOA escolheu chamar a si mesma no perfil dela, nem
    // sempre bate com o nome oficial que tá na fatura.
    const { data, error } = await supabase
      .from('conversas')
      .insert({
        telefone,
        cliente_id: clienteId,
        nome_contato: nomeCliente || nomeContato || (numeroNaoConfirmado ? 'Contato não identificado (WhatsApp não revelou o número)' : null),
        nao_lidas: fromMe ? 0 : 1,
        ultima_mensagem: resumo,
        ultima_mensagem_em: quandoIso,
        slot: slot || null,
        numero_nao_confirmado: Boolean(numeroNaoConfirmado),
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Só avança "última mensagem" se essa mensagem for mais nova que a que já tinha
  // registrada (o histórico inicial pode chegar fora de ordem).
  const ehMaisNova = !existente.ultima_mensagem_em || new Date(quandoIso) >= new Date(existente.ultima_mensagem_em);

  // Mesma prioridade aqui: se o cliente já tem nome cadastrado, esse nome nunca é
  // sobrescrito pelo pushName -- só usa pushName quando NÃO existe cliente vinculado.
  let nomeParaSalvar = existente.nome_contato;
  let clienteIdParaSalvar = existente.cliente_id;
  if (!existente.cliente_id) {
    const { data: cliente } = await supabase.from('clientes').select('id, nome').in('telefone', variantesTelefone).maybeSingle();
    if (cliente) {
      // Vincula agora o cliente_id que ainda não tinha sido linkado -- cobre o
      // caso em que a conversa nasceu ANTES do cliente ser cadastrado (ou
      // nasceu com o telefone na variante sem/com o 9, ver normalizarVariantes).
      clienteIdParaSalvar = cliente.id;
      nomeParaSalvar = cliente.nome;
    } else {
      nomeParaSalvar = nomeContato || existente.nome_contato;
    }
  }

  const { data, error } = await supabase
    .from('conversas')
    .update({
      cliente_id: clienteIdParaSalvar,
      nome_contato: nomeParaSalvar,
      nao_lidas: fromMe ? 0 : existente.nao_lidas + 1,
      ...(slot ? { slot } : {}),
      ...(ehMaisNova ? { ultima_mensagem: resumo, ultima_mensagem_em: quandoIso } : {}),
    })
    .eq('id', existente.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function processarMensagem(sock, waMessage, slot) {
  const key = waMessage.key;
  const remoteJid = key?.remoteJid;
  const messageId = key?.id;
  if (!remoteJid || !messageId) return;
  if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return; // ignora grupo e status

  const interpretado = interpretarConteudo(waMessage.message);
  if (!interpretado) return;

  const fromMe = Boolean(key.fromMe);

  // WhatsApp recente pode identificar o contato por um "@lid" (Linked ID, um
  // identificador de privacidade opaco) em vez do número de telefone real --
  // isso é cada vez mais comum, não só em casos raros, e acontece tanto quando
  // O CLIENTE nos manda mensagem quanto quando NÓS respondemos ele (fromMe:
  // true) -- ver resolverTelefonePorLid() acima pra detalhe de por que a
  // resolução muda dependendo da direção.
  //
  // BUG QUE ISSO AQUI CORRIGE: se a gente tratasse o "@lid" como se fosse o
  // telefone, cada resposta SUA a um cliente de lid blindado criava uma
  // conversa NOVA (telefone = id opaco do lid, não bate com o telefone já
  // cadastrado do cliente) -- e como essa conversa nascia de uma mensagem
  // fromMe:true, o nome usado era o pushName da mensagem, que numa mensagem
  // ENVIADA é o nome do PRÓPRIO REMETENTE (você!), não do destinatário. Daí o
  // "contato fantasma com o nome da minha conta". A regra de ouro que
  // resolve os dois problemas juntos:
  //   1. NUNCA usar o "@lid" cru como telefone -- resolve o número real, e só
  //      se não der pra resolver, guarda sob um id estável e MARCADO como não
  //      confirmado (numero_nao_confirmado), nunca como se fosse um telefone
  //      válido de verdade.
  //   2. NUNCA usar pushName como nome do contato quando fromMe é true --
  //      pushName é sempre "quem mandou a mensagem", e numa mensagem nossa
  //      quem mandou somos nós.
  let telefone;
  let numeroNaoConfirmado = false;
  if (remoteJid.endsWith('@lid')) {
    const resolvido = await resolverTelefonePorLid(sock, key);
    if (resolvido) {
      telefone = normalizarTelefone(resolvido);
      // Pode já existir uma conversa fantasma de uma vez anterior em que não
      // dava pra resolver -- funde nela agora que finalmente sabemos o número.
      await fundirFantasmaLidSeExistir(`lid-${remoteJid.split('@')[0]}`, telefone).catch((err) =>
        console.error('[chatIngest] erro ao fundir conversa fantasma de lid:', err.message)
      );
    } else {
      // Sem jeito de saber o telefone real ainda -- guarda sob um id ESTÁVEL
      // (o mesmo lid sempre gera o mesmo "telefone" aqui), então mensagens
      // seguintes do mesmo contato continuam caindo na mesma conversa em vez
      // de criar uma fantasma nova a cada mensagem.
      telefone = `lid-${remoteJid.split('@')[0]}`;
      numeroNaoConfirmado = true;
    }
  } else {
    telefone = normalizarTelefone(remoteJid.split('@')[0]);
  }
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
    // fromMe:true -> pushName é o SEU nome, não o do contato -- nunca usar aqui
    // (é a causa direta do bug "contato com o nome da minha conta", ver acima).
    nomeContato: fromMe ? null : waMessage.pushName,
    texto: interpretado.texto,
    tipo: interpretado.tipo,
    fromMe,
    quandoIso,
    slot,
    numeroNaoConfirmado,
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
        slot: slot || null,
      },
      { onConflict: 'message_id', ignoreDuplicates: true }
    );
  if (error) throw error;
}

// Usado pela rota de envio do Chat: grava a mensagem que ACABAMOS de mandar (texto
// e/ou anexo), sem precisar rebaixar mídia -- já temos o anexo em mãos.
// Quando o eco dessa mesma mensagem chegar pelo messages.upsert (fromMe: true), o
// upsert por message_id (ignoreDuplicates) evita duplicar.
export async function registrarMensagemSaida({ telefone, texto, tipo, anexoUrl, anexoNome, messageId, slot }) {
  const quandoIso = new Date().toISOString();
  const conversa = await upsertConversa({ telefone, nomeContato: null, texto, tipo, fromMe: true, quandoIso, slot });

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
        slot: slot || null,
      },
      { onConflict: 'message_id', ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();
  if (error) throw error;
  return { conversa, mensagem: data };
}

export async function registrarMensagensRecebidas(sock, messages, slot) {
  for (const m of messages) {
    await processarMensagem(sock, m, slot);
  }
}

export async function registrarHistoricoInicial(sock, messages, slot) {
  // Processa em ordem cronológica pra "última mensagem" da conversa ficar coerente.
  const ordenadas = [...messages].sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
  for (const m of ordenadas) {
    await processarMensagem(sock, m, slot);
  }
}
