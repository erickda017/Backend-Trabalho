import { supabase, BUCKET, CHAT_BUCKET, gerarSignedUrl } from '../lib/supabase.js';
import { enviarMensagemComPdf, enviarMensagemComAnexo, enviarMensagemTexto, validarNumero, isConnectedQualquerSlot, escolherSlotParaEnvio } from './whatsapp.js';
import { dispararWebhook } from './webhook.js';
import { registrarMensagemSaida } from './chatIngest.js';

const MIN_DELAY = Number(process.env.MIN_DELAY_MS || 5000);
const MAX_DELAY = Number(process.env.MAX_DELAY_MS || 15000);

// Limite diário de mensagens (todas os envios somados). 0 = sem limite.
// [2026-08] Subido de 100 -> 300/dia a pedido do usuário (volume maior de faturas).
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 300);

// A cada N mensagens enviadas, faz uma pausa mais longa (simula comportamento humano)
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 20);
const BATCH_PAUSE_MS = Number(process.env.BATCH_PAUSE_MS || 10 * 60 * 1000); // 10 min

// Se a conexão WhatsApp cair no meio de um disparo, pausa e tenta de novo depois
// desse intervalo (o scheduler.js verifica envios 'pausado' a cada 1 min) -- em vez
// de continuar o loop e marcar CADA item restante como 'erro' um por um.
const RECONEXAO_RETRY_MS = Number(process.env.RECONEXAO_RETRY_MS || 2 * 60 * 1000); // 2 min

// [2026-08] MULTI-TENANT: antes era 1 disparo por vez pro sistema INTEIRO
// (variáveis de módulo simples). Agora cada usuário pode ter seu próprio
// disparo rodando ao mesmo tempo -- todo o estado de execução vira um Map
// indexado por usuarioId, do mesmo jeito que sessoes em whatsapp.js.
const execucoes = new Map(); // usuarioId -> { isRunning, envioAtualId }
const pauseRequests = new Set(); // guarda `${usuarioId}:${envioId}`
const cancelRequests = new Set();

function getExecucao(usuarioId) {
  if (!execucoes.has(usuarioId)) execucoes.set(usuarioId, { isRunning: false, envioAtualId: null });
  return execucoes.get(usuarioId);
}

function chaveRequest(usuarioId, envioId) {
  return `${usuarioId}:${envioId}`;
}

// Brasil não observa horário de verão desde 2019 -- offset fixo -03:00.
const OFFSET_BR = '-03:00';

function inicioDoDiaBR(data = new Date()) {
  const dataSP = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(data); // "YYYY-MM-DD" já no fuso de SP
  return new Date(`${dataSP}T00:00:00${OFFSET_BR}`);
}

// Intervalo entre mensagens: usa intervalo_ms do envio (fixo) quando informado,
// senão cai no range aleatório MIN_DELAY..MAX_DELAY (comportamento anterior).
function delayEntreMensagens(intervaloMs) {
  const ms = intervaloMs > 0 ? intervaloMs : Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function montarMensagem(template, cliente) {
  const valorNumerico = cliente.valor != null ? Number(String(cliente.valor).replace(',', '.')) : null;
  return (template || '')
    .replaceAll('{{nome}}', cliente.nome || '')
    .replaceAll('{{telefone}}', cliente.telefone || '')
    .replaceAll('{{valor}}', valorNumerico && !Number.isNaN(valorNumerico) ? `R$ ${valorNumerico.toFixed(2)}` : '')
    .replaceAll('{{vencimento}}', cliente.vencimento || '')
    .replaceAll('{{pix}}', cliente.pix_code || '');
}

// Sorteia uma das (até 5) variações de mensagem cadastradas no envio. Existir
// mais de um texto possível -- com pequenas diferenças de redação -- e
// escolher aleatoriamente qual sai em cada mensagem ajuda a evitar o padrão
// "mesmo texto pra todo mundo" que aumenta risco de bloqueio do número.
// Sem variações cadastradas (lotes antigos, ou só 1 preenchida), cai no
// template_mensagem normal -- comportamento igual a antes.
export function escolherTemplate(envio) {
  const variacoes = Array.isArray(envio.variacoes_mensagem)
    ? envio.variacoes_mensagem.filter((v) => typeof v === 'string' && v.trim().length > 0)
    : [];
  if (!variacoes.length) return envio.template_mensagem;
  const indice = Math.floor(Math.random() * variacoes.length);
  return variacoes[indice];
}

// Conta quantas mensagens já foram enviadas hoje POR ESTE USUÁRIO (o limite
// diário é uma cota por operador -- cada um tem seu próprio WhatsApp e seu
// próprio risco de bloqueio, não faz sentido mais uma cota global somando
// todo mundo).
async function contarEnviadosHoje(usuarioId) {
  const inicioDoDia = inicioDoDiaBR();

  const { count, error } = await supabase
    .from('envio_itens')
    .select('*, envios!inner(usuario_id)', { count: 'exact', head: true })
    .eq('status', 'enviado')
    .eq('envios.usuario_id', usuarioId)
    .gte('enviado_em', inicioDoDia.toISOString());

  if (error) throw error;
  return count || 0;
}

// Calcula o próximo horário permitido (meia-noite do dia seguinte, no fuso de SP)
function proximaJanela() {
  const inicioHojeBR = inicioDoDiaBR();
  return new Date(inicioHojeBR.getTime() + 24 * 60 * 60 * 1000);
}

// [bug] Grava o status 'enviado' com retry próprio, NUNCA lançando erro pro
// chamador. Existe porque antes essa gravação era um `await` normal dentro do
// mesmo try/catch do envio -- se o WhatsApp mandasse a mensagem com sucesso
// mas esse UPDATE falhasse por qualquer instabilidade passageira (rede,
// Supabase), o item caía no catch e virava 'erro'. `reenviarErros` então
// reprocessava esse item mais tarde e mandava a MESMA fatura pro cliente de
// novo -- ou seja, uma falha só na gravação do status virava um disparo
// físico duplicado de verdade. Com retry aqui, o caso comum (instabilidade
// passageira) se resolve sozinho sem nunca marcar 'erro' num envio que já
// saiu.
async function atualizarStatusEnviado(itemId, dadosAtualizacao, tentativas = 3) {
  for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
    const { error } = await supabase.from('envio_itens').update(dadosAtualizacao).eq('id', itemId);
    if (!error) return true;
    console.error(`[dispatch] tentativa ${tentativa}/${tentativas} falhou ao gravar status 'enviado' do item ${itemId}:`, error.message);
    if (tentativa < tentativas) await new Promise((resolve) => setTimeout(resolve, 1000 * tentativa));
  }
  return false;
}

async function enviarItem(item, envio, usuarioId) {
  const cliente = item.clientes;
  const templateDoItem = item.mensagem_override || escolherTemplate(envio);
  let mensagem = montarMensagem(templateDoItem, cliente);

  // Lote "só Pix" (ver migration-17): nunca anexa o PDF, mesmo que o
  // cliente tenha um. Se o template não usa a variável {{pix}}, gruda o
  // código no fim da mensagem -- sem isso, um template sem a variável
  // mandaria uma mensagem de texto genérica sem o Pix nenhum, o que
  // inverteria o propósito do modo.
  if (envio.enviar_pix && cliente.pix_code && !templateDoItem.includes('{{pix}}')) {
    mensagem = `${mensagem}\n\nPix copia e cola:\n${cliente.pix_code}`;
  }

  // [2026-08] DOIS ZAPS: `envio.slot` (1|2) deixa o operador FIXAR um número
  // pra este lote inteiro (ex.: campanha que precisa sair sempre do mesmo
  // Zap); sem isso, cada item escolhe seu próprio slot via
  // escolherSlotParaEnvio -- rodízio 50/50 quando os dois estão conectados,
  // ou o único disponível quando só 1 está. Restaura a distribuição entre 2
  // números que existia antes do multi-tenant (ver services/whatsapp.js).
  const slot = envio.slot || escolherSlotParaEnvio(usuarioId) || 1;

  try {
    // [2026-09] ATIVAÇÃO CHIP: cliente dessa campanha pode ter até 3 telefones
    // (telefone/telefone_2/telefone_3, ver migration-25-ativacao-chip.sql) --
    // tenta em ordem até um existir no WhatsApp, em vez de desistir no
    // primeiro que falhar (planilha de origem não garante qual dos 3 está
    // certo). Clientes de cobrança continuam com um único telefone, sem
    // mudança de comportamento.
    const telefonesCandidatos =
      cliente.campanha === 'chip_ativacao'
        ? [cliente.telefone, cliente.telefone_2, cliente.telefone_3].filter(Boolean)
        : [cliente.telefone];

    let telefoneUsado = null;
    let jid = null;
    for (const candidato of telefonesCandidatos) {
      const resultado = await validarNumero(candidato, usuarioId, slot);
      if (resultado.existe) {
        telefoneUsado = candidato;
        jid = resultado.jid;
        break;
      }
    }

    if (!telefoneUsado) {
      await supabase
        .from('envio_itens')
        .update({ status: 'numero_invalido', erro: 'Número não encontrado no WhatsApp' })
        .eq('id', item.id);

      await dispararWebhook('numero_invalido', { cliente, envio_id: envio.id });
      return;
    }

    // [2026-09] FOTO DO LOTE (ver migration-26-disparo-foto.sql): imagem
    // única, escolhida na hora de montar o envio inteiro (não por cliente,
    // diferente do PDF abaixo) -- essencial pra Ativação Chip, onde o
    // cliente nunca tem PDF cadastrado. Quando o lote tem foto, ela tem
    // PRIORIDADE sobre o PDF do cliente (o WhatsApp só aceita 1 anexo por
    // mensagem, e o operador escolheu a foto de propósito pra esse lote).
    // `envio.enviar_pix` continua forçando texto puro, igual já fazia com o
    // PDF -- o modo "só Pix" não deve sair com anexo nenhum.
    const fotoUrlAssinada = !envio.enviar_pix && envio.foto_path ? await gerarSignedUrl(CHAT_BUCKET, envio.foto_path) : null;

    // Bucket privado: assina uma URL só pro Baileys baixar AGORA (curta
    // duração) -- nunca reaproveita/persiste uma URL pública fixa.
    // `envio.enviar_pix` força texto puro mesmo com PDF cadastrado.
    const pdfUrlAssinada =
      !fotoUrlAssinada && !envio.enviar_pix && cliente.pdf_path ? await gerarSignedUrl(BUCKET, cliente.pdf_path) : null;

    let messageId;
    if (fotoUrlAssinada) {
      ({ messageId } = await enviarMensagemComAnexo({
        numero: telefoneUsado,
        jid,
        mensagem,
        anexoUrl: fotoUrlAssinada,
        anexoNome: envio.foto_nome || 'foto.jpg',
        anexoTipo: 'imagem',
        anexoMimetype: envio.foto_mimetype || 'image/jpeg',
        usuarioId,
        slot,
      }));
    } else if (pdfUrlAssinada) {
      ({ messageId } = await enviarMensagemComPdf({
        numero: telefoneUsado,
        jid,
        mensagem,
        pdfUrl: pdfUrlAssinada,
        pdfNome: `fatura-${cliente.nome}.pdf`,
        usuarioId,
        slot,
      }));
    } else {
      ({ messageId } = await enviarMensagemTexto({ numero: telefoneUsado, jid, mensagem, usuarioId, slot }));
    }

    // A partir daqui a mensagem JÁ FOI enviada de verdade pelo WhatsApp --
    // ver comentário em atualizarStatusEnviado sobre por que essa gravação
    // não pode mais lançar erro e cair no catch abaixo como 'erro'.
    const statusGravado = await atualizarStatusEnviado(item.id, {
      status: 'enviado',
      erro: null,
      message_id: messageId,
      status_entrega: 'enviado',
      enviado_em: new Date().toISOString(),
      // Registra qual dos 2 Zaps enviou de verdade -- coluna já existia
      // (migration-4), só não era mais preenchida desde a virada single-Zap.
      slot,
      // Qual dos até 3 telefones respondeu de verdade -- só relevante (e só
      // preenchido) pra clientes de chip, ver início desta função.
      ...(cliente.campanha === 'chip_ativacao' ? { telefone_usado: telefoneUsado } : {}),
    });
    if (!statusGravado) {
      console.error(
        `[dispatch] CRÍTICO: mensagem enviada pro WhatsApp mas não foi possível gravar o status no banco pro item ${item.id} (cliente ${cliente.nome}). NÃO reenviar automaticamente -- corrigir manualmente pra evitar duplicar o envio.`,
      );
    }

    // Sem isso, disparo em massa nunca aparecia na aba Chat -- a conversa só nascia
    // quando o cliente respondia. Grava aqui o mesmo jeito que a resposta manual do
    // Chat grava (registrarMensagemSaida), então o histórico fica completo dos dois lados.
    try {
      await registrarMensagemSaida({
        telefone: telefoneUsado,
        texto: mensagem,
        tipo: fotoUrlAssinada ? 'imagem' : pdfUrlAssinada ? 'documento' : 'texto',
        anexoPath: fotoUrlAssinada ? envio.foto_path : pdfUrlAssinada ? cliente.pdf_path : null,
        anexoNome: fotoUrlAssinada ? envio.foto_nome || 'foto.jpg' : pdfUrlAssinada ? `fatura-${cliente.nome}.pdf` : null,
        messageId,
        usuarioId,
        campanha: envio.campanha || 'cobranca',
      });
    } catch (chatErr) {
      console.error(`[dispatch] erro ao registrar no chat para ${cliente.nome}:`, chatErr.message);
    }

    await dispararWebhook('mensagem_enviada', { cliente, envio_id: envio.id, message_id: messageId });
  } catch (err) {
    console.error(`[dispatch] erro ao enviar para ${cliente.nome}:`, err.message);
    await supabase.from('envio_itens').update({ status: 'erro', erro: err.message }).eq('id', item.id);

    await dispararWebhook('erro_envio', { cliente, envio_id: envio.id, erro: err.message });
  }
}

// Processa um disparo em lote: pega itens 'pendente' de um envio_id e dispara um a um.
// usuarioId é sempre o dono do envio (vem de req.user.id na rota) -- nunca do
// corpo da requisição, pra não dar pra um usuário disparar um envio de outro.
export async function processarDisparo(envioId, usuarioId) {
  const execucao = getExecucao(usuarioId);
  if (execucao.isRunning) {
    throw new Error('Já existe um disparo seu em andamento. Aguarde finalizar.');
  }
  execucao.isRunning = true;
  execucao.envioAtualId = envioId;
  let contadorLote = 0;

  try {
    const { data: envio, error: envioError } = await supabase
      .from('envios')
      .select('*')
      .eq('id', envioId)
      .eq('usuario_id', usuarioId)
      .single();

    if (envioError || !envio) throw new Error('Envio não encontrado');

    await supabase.from('envios').update({ status: 'em_andamento', retomar_em: null }).eq('id', envioId).eq('usuario_id', usuarioId);
    await dispararWebhook('disparo_iniciado', { envio_id: envioId });

    const { data: itens, error: itensError } = await supabase
      .from('envio_itens')
      .select('*, clientes(*)')
      .eq('envio_id', envioId)
      .eq('status', 'pendente');

    if (itensError) throw itensError;

    // Intervalo de disparo: se o envio tem uma janela de tempo total definida
    // (envios.janela_ms), espalha os itens PENDENTES DESTA CHAMADA igualmente
    // dentro dela -- primeira mensagem sai já, a última antes da janela fechar.
    // Recalculado a cada chamada (novo disparo OU continuar um pausado), então
    // se sobrarem 20 de 60 itens depois de retomar, os 20 restantes dividem a
    // MESMA duração configurada, contada a partir de agora.
    // Sem janela_ms definida, funciona exatamente como antes (sem restrição).
    const delayDaJanela =
      envio.janela_ms > 0 && itens.length > 0 ? Math.floor(envio.janela_ms / itens.length) : null;

    try {
      for (const item of itens) {
        // Pausar/cancelar pedido via API (botão na aba Disparo/Histórico). Checado
        // no início de cada item -- nunca interrompe um envio já em voo, só evita
        // começar o próximo. Cancelar tem prioridade se os dois foram pedidos.
        const chave = chaveRequest(usuarioId, envioId);
        if (cancelRequests.has(chave)) {
          cancelRequests.delete(chave);
          pauseRequests.delete(chave);
          await supabase
            .from('envios')
            .update({ status: 'cancelado', finalizado_em: new Date().toISOString() })
            .eq('id', envioId)
            .eq('usuario_id', usuarioId);
          await marcarItensPendentesComoCancelados(envioId);
          await dispararWebhook('disparo_cancelado', { envio_id: envioId });
          console.log(`[dispatch] disparo ${envioId} cancelado pelo usuário.`);
          return;
        }
        if (pauseRequests.has(chave)) {
          pauseRequests.delete(chave);
          await supabase.from('envios').update({ status: 'pausado', retomar_em: null }).eq('id', envioId).eq('usuario_id', usuarioId);
          await dispararWebhook('disparo_pausado_manual', { envio_id: envioId });
          console.log(`[dispatch] disparo ${envioId} pausado pelo usuário.`);
          return;
        }

        // Sem isso: se o WhatsApp cair no meio do disparo (ex: celular sem internet,
        // sessão derrubada), o loop continuava e marcava CADA item restante como
        // 'erro' um por um -- ainda esperando o delay normal entre eles -- em vez de
        // parar. Com 300 itens pendentes isso significava minutos/horas queimando a
        // fila inteira em erro por nada. Agora, se este usuário não tem WhatsApp
        // conectado, pausa (fica 'pendente' pra tentar de novo) e o scheduler.js
        // retoma sozinho quando -- e se -- a conexão voltar.
        // [2026-08] DOIS ZAPS: só pausa se NENHUM dos 2 estiver conectado --
        // com 1 disponível, o disparo continua nele normalmente (ver
        // escolherSlotParaEnvio em enviarItem).
        if (!isConnectedQualquerSlot(usuarioId)) {
          const retomarEm = new Date(Date.now() + RECONEXAO_RETRY_MS);
          await supabase
            .from('envios')
            .update({ status: 'pausado', retomar_em: retomarEm.toISOString() })
            .eq('id', envioId)
            .eq('usuario_id', usuarioId);

          await dispararWebhook('disparo_pausado_sem_conexao', {
            envio_id: envioId,
            retomar_em: retomarEm.toISOString(),
          });

          console.log(
            `[dispatch] conexão WhatsApp indisponível (usuário ${usuarioId}), pausando disparo ${envioId}. Retomando em ${retomarEm.toISOString()}`
          );
          return;
        }

        if (DAILY_LIMIT > 0) {
          const enviadosHoje = await contarEnviadosHoje(usuarioId);
          if (enviadosHoje >= DAILY_LIMIT) {
            const retomarEm = proximaJanela();
            await supabase
              .from('envios')
              .update({ status: 'pausado', retomar_em: retomarEm.toISOString() })
              .eq('id', envioId)
              .eq('usuario_id', usuarioId);

            await dispararWebhook('disparo_pausado_limite_diario', {
              envio_id: envioId,
              retomar_em: retomarEm.toISOString(),
            });

            console.log(`[dispatch] limite diário (${DAILY_LIMIT}) atingido. Retomando em ${retomarEm.toISOString()}`);
            return; // encerra por hoje; o scheduler retoma amanhã
          }
        }

        await enviarItem(item, envio, usuarioId);
        contadorLote++;

        if (delayDaJanela != null) {
          // Janela de tempo ativa: ignora a pausa-longa por lote e o
          // aleatório/fixo normal -- o espaçamento calculado já É a proteção
          // contra queda do Zap, no ritmo que o próprio usuário definiu.
          await new Promise((resolve) => setTimeout(resolve, delayDaJanela));
        } else if (BATCH_SIZE > 0 && contadorLote % BATCH_SIZE === 0) {
          console.log(`[dispatch] pausa longa após ${BATCH_SIZE} mensagens (${BATCH_PAUSE_MS / 1000}s)`);
          await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
        } else {
          await delayEntreMensagens(envio.intervalo_ms);
        }
      }
    } catch (err) {
      console.error(`[dispatch] erro inesperado no disparo ${envioId}, pausando:`, err.message);
      // retomar_em precisa de um valor -- o scheduler só retoma envios 'pausado'
      // com retomar_em <= agora; com null a comparação nunca bate e o lote fica
      // travado pra sempre (só saía do 'pausado' com clique manual). Agora ele
      // se autorecupera como os outros casos de pausa (sem conexão / limite diário).
      const retomarEm = new Date(Date.now() + RECONEXAO_RETRY_MS);
      await supabase
        .from('envios')
        .update({ status: 'pausado', retomar_em: retomarEm.toISOString() })
        .eq('id', envioId)
        .eq('usuario_id', usuarioId);

      await dispararWebhook('disparo_erro_inesperado', {
        envio_id: envioId,
        erro: err.message,
        retomar_em: retomarEm.toISOString(),
      });
      return;
    }

    await supabase
      .from('envios')
      .update({ status: 'concluido', finalizado_em: new Date().toISOString() })
      .eq('id', envioId)
      .eq('usuario_id', usuarioId);

    await dispararWebhook('disparo_concluido', { envio_id: envioId });
  } finally {
    execucao.isRunning = false;
    execucao.envioAtualId = null;
    // Limpa qualquer pedido de pausar/cancelar que não chegou a ser consumido
    // (ex: pedido chegou depois do último item, ou o envio terminou/pausou por
    // outro motivo antes do loop checar de novo) -- não deixa "vazando" pro
    // próximo envio que vier a usar esse mesmo id (não deveria acontecer, mas
    // não custa garantir).
    const chave = chaveRequest(usuarioId, envioId);
    pauseRequests.delete(chave);
    cancelRequests.delete(chave);
  }
}

// Reenvia apenas os itens que falharam (status 'erro') de um envio -- não mexe nos já enviados
export async function reenviarErros(envioId, usuarioId) {
  const { error } = await supabase
    .from('envio_itens')
    .update({ status: 'pendente', erro: null })
    .eq('envio_id', envioId)
    .eq('status', 'erro');

  if (error) throw error;

  return processarDisparo(envioId, usuarioId);
}

export function disparoEmAndamento(usuarioId) {
  return getExecucao(usuarioId).isRunning;
}

// Id do envio rodando agora neste processo (null se nenhum) -- usado pelas
// rotas pra decidir como aplicar pausar/cancelar.
export function envioEmExecucaoId(usuarioId) {
  const execucao = getExecucao(usuarioId);
  return execucao.isRunning ? execucao.envioAtualId : null;
}

// Configuração do disparo, pro frontend mostrar (ex: "pausa automática de 10min
// a cada 20 mensagens") sem precisar hardcodar esses números no front.
export function configDisparo() {
  return {
    min_delay_ms: MIN_DELAY,
    max_delay_ms: MAX_DELAY,
    daily_limit: DAILY_LIMIT,
    batch_size: BATCH_SIZE,
    batch_pause_ms: BATCH_PAUSE_MS,
  };
}

// Pede pra pausar um envio (retomada manual só, via botão "Continuar
// disparo" -- por isso retomar_em fica null, diferente da pausa automática
// por limite diário/queda de conexão). Se o envio está rodando NESTE
// processo, só sinaliza -- o loop para com segurança depois do item atual
// (nunca no meio de um envio) e atualiza o status sozinho. Se não está
// rodando aqui (ex: preso em 'em_andamento' de um processo anterior que
// caiu, antes de recuperarEnviosTravados rodar), atualiza direto no banco.
export async function solicitarPausa(envioId, usuarioId) {
  const execucao = getExecucao(usuarioId);
  if (execucao.isRunning && execucao.envioAtualId === envioId) {
    pauseRequests.add(chaveRequest(usuarioId, envioId));
    return { status: 'pausando' };
  }

  const { data, error } = await supabase
    .from('envios')
    .update({ status: 'pausado', retomar_em: null })
    .eq('id', envioId)
    .eq('usuario_id', usuarioId)
    .eq('status', 'em_andamento')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Este envio não está em andamento no momento.');
  return { status: 'pausado' };
}

// Pede pra cancelar (interromper de vez) um envio. Itens já enviados
// continuam enviados; os itens ainda pendentes são marcados como 'cancelado'
// (não ficam "pendente" pra sempre -- sem isso o dashboard e os filtros de
// histórico continuavam contando como pendente algo que nunca mais vai ser
// disparado). Não é retomável pelo scheduler nem pelo botão "Continuar
// disparo" (status 'cancelado' não aparece nas condições deles).
export async function solicitarCancelamento(envioId, usuarioId) {
  const execucao = getExecucao(usuarioId);
  if (execucao.isRunning && execucao.envioAtualId === envioId) {
    cancelRequests.add(chaveRequest(usuarioId, envioId));
    return { status: 'cancelando' };
  }

  const { data, error } = await supabase
    .from('envios')
    .update({ status: 'cancelado', finalizado_em: new Date().toISOString() })
    .eq('id', envioId)
    .eq('usuario_id', usuarioId)
    .in('status', ['em_andamento', 'pendente', 'pausado', 'agendado'])
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Este envio não pode mais ser cancelado (já foi concluído ou não existe).');

  await marcarItensPendentesComoCancelados(envioId);
  return { status: 'cancelado' };
}

async function marcarItensPendentesComoCancelados(envioId) {
  const { error } = await supabase
    .from('envio_itens')
    .update({ status: 'cancelado' })
    .eq('envio_id', envioId)
    .eq('status', 'pendente');
  if (error) console.error(`[dispatch] erro ao marcar itens pendentes como cancelados (envio ${envioId}):`, error.message);
}

// Roda uma vez na inicialização do servidor. Se o processo morreu (crash, redeploy)
// no meio de um disparo, o envio fica marcado 'em_andamento' no banco pra sempre.
// É seguro voltar pra 'pendente': o dispatch só processa itens ainda 'pendente'.
export async function recuperarEnviosTravados() {
  const { data, error } = await supabase
    .from('envios')
    .update({ status: 'pendente' })
    .eq('status', 'em_andamento')
    .select('id');

  if (error) {
    console.error('[dispatch] erro ao recuperar envios travados:', error.message);
    return;
  }

  if (data?.length) {
    console.log(`[dispatch] ${data.length} envio(s) travado(s) em 'em_andamento' recuperado(s) para 'pendente'`);
  }
}
