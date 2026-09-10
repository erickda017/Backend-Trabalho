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

async function baixarEGuardarMidia(sock, waMessage, { mediaMsg, mimetype, fileName }, telefone, messageId, usuarioId) {
  const buffer = await downloadMediaMessage(
    { message: mediaMsg, key: waMessage.key },
    'buffer',
    {},
    { logger, reuploadRequest: sock.updateMediaMessage }
  );

  // [2026-08] MULTI-TENANT: prefixado com usuarioId por consistência com o
  // resto do sistema (mesmo padrão de chat.routes.js) -- messageId do
  // WhatsApp já é único por sessão na prática, mas não vale depender só
  // disso pra isolamento entre operadores.
  const caminho = `${usuarioId}/${telefone}/${messageId}-${fileName}`;
  const { error: uploadError } = await supabase.storage
    .from(CHAT_BUCKET)
    .upload(caminho, buffer, { contentType: mimetype || 'application/octet-stream', upsert: true });

  if (uploadError) throw uploadError;

  // [2026-08] SEGURANÇA: bucket privado -- não gera/grava URL pública aqui.
  // Só o path é persistido; a URL (signed, curta duração) é calculada sob
  // demanda quando o front pede o histórico da conversa (ver chat.routes.js).
  return { anexoPath: caminho, anexoNome: fileName };
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
//  4) nossa própria coluna `conversas.lid` (ver migration-24) -- se ESSE MESMO
//     lid já foi resolvido com sucesso antes (por qualquer uma das 3 formas
//     acima, em mensagem anterior), a conversa já guarda o telefone real.
//     Cobre o caso relatado: responder pelo WhatsApp OFICIAL no celular (fora
//     da plataforma) chega como sincronização multi-device sem
//     remoteJidAlt/senderPn e sem cache do Baileys -- sem esse fallback, cada
//     resposta assim criava um contato-fantasma novo "não identificado".
// Se nada resolver, devolve null -- quem chamou decide o que fazer (a gente NUNCA
// inventa um telefone a partir do próprio lid, ver processarMensagem).
async function resolverTelefonePorLid(sock, key, usuarioId) {
  if (key.remoteJidAlt) return key.remoteJidAlt.split('@')[0];
  if (key.senderPn) return key.senderPn.split('@')[0];
  try {
    const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(key.remoteJid);
    if (pn) return String(pn).split('@')[0];
  } catch {
    // mapeamento indisponível nessa versão/momento -- segue sem resolver
  }
  if (usuarioId) {
    const { data } = await supabase
      .from('conversas')
      .select('telefone')
      .eq('lid', key.remoteJid)
      .eq('usuario_id', usuarioId)
      .maybeSingle();
    if (data?.telefone) return data.telefone;
  }
  return null;
}

// Quando a gente FINALMENTE resolve o telefone real de um contato que antes só
// tínhamos como "@lid" (ver resolverTelefonePorLid), pode já existir uma conversa
// fantasma salva sob o id opaco do lid. Funde ela na conversa certa (ou, se a
// conversa certa ainda não existe, só "renomeia" a fantasma) -- sem isso, o
// histórico anterior ficaria pra sempre num contato separado.
// usuarioId sempre escopa a busca: cada operador tem sua própria carteira de
// conversas, um telefone pseudo-lid de um usuário nunca deve se fundir com a
// conversa de outro usuário.
async function fundirFantasmaLidSeExistir(telefonePseudo, telefoneReal, usuarioId) {
  if (telefonePseudo === telefoneReal) return;
  const { data: fantasma } = await supabase
    .from('conversas')
    .select('id, campanha')
    .eq('telefone', telefonePseudo)
    .eq('usuario_id', usuarioId)
    .maybeSingle();
  if (!fantasma) return;

  // [2026-09] ATIVAÇÃO CHIP: a fusão precisa acontecer DENTRO da mesma
  // campanha da conversa fantasma -- sem isso, um telefone que existe nas
  // duas campanhas poderia fundir a fantasma de uma campanha na conversa
  // real da OUTRA (ver migration-25-ativacao-chip.sql).
  const { data: real } = await supabase
    .from('conversas')
    .select('id')
    .eq('telefone', telefoneReal)
    .eq('usuario_id', usuarioId)
    .eq('campanha', fantasma.campanha)
    .maybeSingle();
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

// Busca TODAS as conversas de um telefone (por QUALQUER variação com/sem o 9º
// dígito, ver normalizarVariantes) -- não faz nenhuma escrita. usuarioId
// escopa a busca (carteira de um operador nunca vaza/mistura com a de outro).
// [2026-09] ATIVAÇÃO CHIP: pode devolver MAIS DE UMA linha agora -- o mesmo
// telefone pode ter uma conversa de cobrança e outra de chip (ver
// migration-25-ativacao-chip.sql, índice único agora inclui `campanha`).
async function buscarConversasPorTelefone(telefone, usuarioId) {
  const variantesTelefone = normalizarVariantes(telefone);
  const { data } = await supabase
    .from('conversas')
    .select('*')
    .in('telefone', variantesTelefone)
    .eq('usuario_id', usuarioId);
  return data || [];
}

// Entre as conversas encontradas pro mesmo telefone (0, 1 ou 2 -- uma por
// campanha), escolhe a de atividade mais recente. Usado só pra mensagem de
// ENTRADA (ver processarMensagem) -- não tem como saber por qual campanha o
// cliente está respondendo, então assume que é a conversa mais "viva".
// Mensagem de SAÍDA nunca usa isso -- já sabe a campanha de contexto (ver
// buscarConversaPorCampanha/upsertConversa).
function escolherConversaMaisRecente(conversas) {
  if (!conversas.length) return null;
  return [...conversas].sort((a, b) => {
    const dataA = a.ultima_mensagem_em ? new Date(a.ultima_mensagem_em).getTime() : 0;
    const dataB = b.ultima_mensagem_em ? new Date(b.ultima_mensagem_em).getTime() : 0;
    return dataB - dataA;
  })[0];
}

// Busca a conversa de um telefone numa campanha ESPECÍFICA -- usado quando a
// campanha já é conhecida de antemão (mensagem de saída: disparo em massa ou
// resposta manual pelo chat, ambos sempre operam dentro de uma campanha
// certa, nunca ambígua).
async function buscarConversaPorCampanha(telefone, usuarioId, campanha) {
  const conversas = await buscarConversasPorTelefone(telefone, usuarioId);
  return conversas.find((c) => c.campanha === campanha) || null;
}

// Quando chega uma mensagem de um telefone que NUNCA teve conversa (nem de
// cobrança nem de chip), decide em qual campanha a conversa nova nasce: se
// esse telefone só está cadastrado numa campanha em `clientes`, usa essa; se
// está nas duas (ou em nenhuma), usa 'cobranca' (default seguro, mesmo
// comportamento de antes da Ativação Chip existir).
async function decidirCampanhaParaNovaConversa(telefone, usuarioId) {
  const variantesTelefone = normalizarVariantes(telefone);
  const { data } = await supabase
    .from('clientes')
    .select('campanha')
    .in('telefone', variantesTelefone)
    .eq('usuario_id', usuarioId);
  const campanhas = new Set((data || []).map((c) => c.campanha));
  return campanhas.size === 1 ? [...campanhas][0] : 'cobranca';
}

function resumoDaMensagem(texto, tipo) {
  return texto || (tipo === 'imagem' ? '📷 Imagem' : tipo === 'audio' ? '🎤 Áudio' : tipo === 'documento' ? '📄 Documento' : '');
}

// Cria a conversa (garantido que ainda não existe nessa campanha -- ver
// buscarConversaPorCampanha/buscarConversasPorTelefone).
async function criarConversa({ telefone, nomeContato, texto, tipo, fromMe, quandoIso, usuarioId, numeroNaoConfirmado, lid, campanha }) {
  const variantesTelefone = normalizarVariantes(telefone);
  let clienteId = null;
  let nomeCliente = null;
  // [2026-09] ATIVAÇÃO CHIP: casa o cliente TAMBÉM pela campanha da conversa
  // -- sem isso, se o telefone existir nas duas campanhas, uma conversa de
  // chip podia linkar por engano no cliente de cobrança (ou vice-versa).
  const { data: cliente } = await supabase
    .from('clientes')
    .select('id, nome')
    .in('telefone', variantesTelefone)
    .eq('usuario_id', usuarioId)
    .eq('campanha', campanha || 'cobranca')
    .maybeSingle();
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
      usuario_id: usuarioId,
      telefone,
      cliente_id: clienteId,
      nome_contato: nomeCliente || nomeContato || (numeroNaoConfirmado ? 'Contato não identificado (WhatsApp não revelou o número)' : null),
      nao_lidas: fromMe ? 0 : 1,
      ultima_mensagem: resumoDaMensagem(texto, tipo),
      ultima_mensagem_em: quandoIso,
      numero_nao_confirmado: Boolean(numeroNaoConfirmado),
      lid: lid || null,
      campanha: campanha || 'cobranca',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Atualiza os campos de resumo (nome, última mensagem, contador de não lidas)
// de uma conversa JÁ EXISTENTE. Só deve ser chamada quando a mensagem em
// questão é confirmadamente NOVA (ver processarMensagem) -- se fosse chamada
// pra toda mensagem processada, sem checar se ela já tinha sido gravada antes,
// um reenvio do mesmo evento pelo WhatsApp (comum em reconexão/histórico)
// inflaria "não lidas" e poderia trocar "última mensagem" por engano.
async function atualizarResumoConversa(existente, { nomeContato, texto, tipo, fromMe, quandoIso, usuarioId, lid }) {
  const variantesTelefone = normalizarVariantes(existente.telefone);

  // Só avança "última mensagem" se essa mensagem for mais nova que a que já tinha
  // registrada (o histórico inicial pode chegar fora de ordem).
  const ehMaisNova = !existente.ultima_mensagem_em || new Date(quandoIso) >= new Date(existente.ultima_mensagem_em);

  // Mesma prioridade aqui: se o cliente já tem nome cadastrado, esse nome nunca é
  // sobrescrito pelo pushName -- só usa pushName quando NÃO existe cliente vinculado.
  let nomeParaSalvar = existente.nome_contato;
  let clienteIdParaSalvar = existente.cliente_id;
  if (!existente.cliente_id) {
    // Casa pela MESMA campanha da conversa (ver criarConversa) -- nunca a
    // campanha do parâmetro de entrada, que pra mensagem de entrada pode nem
    // existir ainda (existente.campanha é sempre a fonte da verdade aqui).
    const { data: cliente } = await supabase
      .from('clientes')
      .select('id, nome')
      .in('telefone', variantesTelefone)
      .eq('usuario_id', usuarioId)
      .eq('campanha', existente.campanha || 'cobranca')
      .maybeSingle();
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
      // Nunca sobrescreve um `lid` já guardado, e nunca zera pra null -- só
      // preenche se a conversa ainda não tinha nenhum registrado (ver
      // resolverTelefonePorLid, é esse valor que evita recriar fantasma
      // quando o Baileys não manda os metadados de resolução de novo).
      ...(lid && !existente.lid ? { lid } : {}),
      ...(ehMaisNova ? { ultima_mensagem: resumoDaMensagem(texto, tipo), ultima_mensagem_em: quandoIso } : {}),
    })
    .eq('id', existente.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Acha a conversa pelo telefone (cria se não existir) e SEMPRE atualiza os
// campos de resumo -- usado por registrarMensagemSaida, onde cada chamada
// corresponde a exatamente um envio de verdade (nunca um replay de evento do
// WhatsApp), então não há risco de contar/atualizar 2x a mesma mensagem.
// usuarioId é sempre obrigatório: escopa TUDO (busca de conversa existente,
// busca de cliente vinculado, criação de conversa nova).
async function upsertConversa(params) {
  if (!params.usuarioId) throw new Error('usuarioId é obrigatório para upsertConversa');
  // Mensagem de SAÍDA sempre sabe a campanha de contexto (disparo ou chat de
  // uma aba específica) -- busca/cria DENTRO dela, nunca ambíguo (diferente
  // de mensagem de entrada, ver processarMensagem/escolherConversaMaisRecente).
  const campanha = params.campanha || 'cobranca';
  const existente = await buscarConversaPorCampanha(params.telefone, params.usuarioId, campanha);
  if (!existente) return criarConversa({ ...params, campanha });
  return atualizarResumoConversa(existente, params);
}

async function processarMensagem(sock, waMessage, usuarioId) {
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
  let lidParaSalvar = null;
  if (remoteJid.endsWith('@lid')) {
    const resolvido = await resolverTelefonePorLid(sock, key, usuarioId);
    if (resolvido) {
      telefone = normalizarTelefone(resolvido);
      // Guarda o "@lid" na conversa resolvida -- é o que permite a PRÓXIMA
      // mensagem com esse mesmo lid (em qualquer direção) achar essa mesma
      // conversa mesmo se o Baileys não mandar remoteJidAlt/senderPn de novo
      // (ver resolverTelefonePorLid e migration-24).
      lidParaSalvar = remoteJid;
      // Pode já existir uma conversa fantasma de uma vez anterior em que não
      // dava pra resolver -- funde nela agora que finalmente sabemos o número.
      await fundirFantasmaLidSeExistir(`lid-${remoteJid.split('@')[0]}`, telefone, usuarioId).catch((err) =>
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

  let anexoPath = null;
  let anexoNome = null;
  if (interpretado.mediaMsg) {
    try {
      const resultado = await baixarEGuardarMidia(sock, waMessage, interpretado, telefone, messageId, usuarioId);
      anexoPath = resultado.anexoPath;
      anexoNome = resultado.anexoNome;
    } catch (err) {
      console.error('[chatIngest] erro ao baixar mídia:', err.message);
      // segue sem anexo -- melhor perder o arquivo do que perder o registro da mensagem
    }
  }

  // [2026-09] Acha/cria a conversa SEM atualizar resumo/contador ainda --
  // isso só acontece depois de confirmar que a mensagem é mesmo nova (ver
  // abaixo). Uma conversa recém-criada já nasce com o resumo desta mensagem
  // certo (criarConversa), então não precisa de update extra nesse caso.
  //
  // [2026-09] ATIVAÇÃO CHIP: mensagem de ENTRADA não sabe por qual campanha o
  // cliente está respondendo -- se ele tem conversa nas duas, cai na mais
  // recente (escolherConversaMaisRecente); sem nenhuma conversa ainda, a
  // campanha nasce a partir do cadastro em `clientes` (decidirCampanhaParaNovaConversa).
  const candidatos = await buscarConversasPorTelefone(telefone, usuarioId);
  const existenteAntes = escolherConversaMaisRecente(candidatos);
  const campanhaParaConversa = existenteAntes ? existenteAntes.campanha : await decidirCampanhaParaNovaConversa(telefone, usuarioId);
  const paramsConversa = {
    telefone,
    // fromMe:true -> pushName é o SEU nome, não o do contato -- nunca usar aqui
    // (é a causa direta do bug "contato com o nome da minha conta", ver acima).
    nomeContato: fromMe ? null : waMessage.pushName,
    texto: interpretado.texto,
    tipo: interpretado.tipo,
    fromMe,
    quandoIso,
    usuarioId,
    numeroNaoConfirmado,
    lid: lidParaSalvar,
    campanha: campanhaParaConversa,
  };
  const conversa = existenteAntes ? existenteAntes : await criarConversa(paramsConversa);

  const { data: mensagemInserida, error } = await supabase
    .from('mensagens')
    .upsert(
      {
        conversa_id: conversa.id,
        direcao: fromMe ? 'saida' : 'entrada',
        tipo: interpretado.tipo,
        texto: interpretado.texto,
        anexo_path: anexoPath,
        anexo_nome: anexoNome,
        message_id: messageId,
        created_at: quandoIso,
      },
      { onConflict: 'message_id', ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();
  if (error) throw error;

  // [2026-09] "não lidas"/última mensagem só avança se a mensagem for MESMO
  // nova (upsert acima devolveu uma linha) -- sem essa checagem, o WhatsApp
  // reentregando o mesmo evento (reconexão, replay de histórico) inflava o
  // contador de não lidas de mensagens que já tinham sido lidas.
  if (existenteAntes && mensagemInserida) {
    await atualizarResumoConversa(existenteAntes, paramsConversa);
  }
}

// Usado pela rota de envio do Chat: grava a mensagem que ACABAMOS de mandar (texto
// e/ou anexo), sem precisar rebaixar mídia -- já temos o anexo em mãos.
// Quando o eco dessa mesma mensagem chegar pelo messages.upsert (fromMe: true), o
// upsert por message_id (ignoreDuplicates) evita duplicar.
export async function registrarMensagemSaida({ telefone, texto, tipo, anexoPath, anexoNome, messageId, usuarioId, campanha }) {
  const quandoIso = new Date().toISOString();
  const conversa = await upsertConversa({ telefone, nomeContato: null, texto, tipo, fromMe: true, quandoIso, usuarioId, campanha });

  const { data, error } = await supabase
    .from('mensagens')
    .upsert(
      {
        conversa_id: conversa.id,
        direcao: 'saida',
        tipo,
        texto: texto || null,
        anexo_path: anexoPath || null,
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

export async function registrarMensagensRecebidas(sock, messages, usuarioId) {
  for (const m of messages) {
    await processarMensagem(sock, m, usuarioId);
  }
}

export async function registrarHistoricoInicial(sock, messages, usuarioId) {
  // Processa em ordem cronológica pra "última mensagem" da conversa ficar coerente.
  const ordenadas = [...messages].sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
  for (const m of ordenadas) {
    await processarMensagem(sock, m, usuarioId);
  }
}
