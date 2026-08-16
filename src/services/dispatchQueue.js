import { supabase } from '../lib/supabase.js';
import { enviarMensagemComPdf, enviarMensagemTexto, validarNumero, isConnected } from './whatsapp.js';
import { escolherSlot } from '../lib/estrategia.js';
import { dispararWebhook } from './webhook.js';
import { registrarMensagemSaida } from './chatIngest.js';

const MIN_DELAY = Number(process.env.MIN_DELAY_MS || 5000);
const MAX_DELAY = Number(process.env.MAX_DELAY_MS || 15000);

// Limite diário de mensagens (todas os envios somados). 0 = sem limite.
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 100);

// A cada N mensagens enviadas, faz uma pausa mais longa (simula comportamento humano)
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 20);
const BATCH_PAUSE_MS = Number(process.env.BATCH_PAUSE_MS || 10 * 60 * 1000); // 10 min

// Se a conexão WhatsApp cair no meio de um disparo, pausa e tenta de novo depois
// desse intervalo (o scheduler.js verifica envios 'pausado' a cada 1 min) -- em vez
// de continuar o loop e marcar CADA item restante como 'erro' um por um.
const RECONEXAO_RETRY_MS = Number(process.env.RECONEXAO_RETRY_MS || 2 * 60 * 1000); // 2 min

let isRunning = false;
let contadorLote = 0;

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

// Conta quantas mensagens já foram enviadas hoje (considerando todos os envios)
async function contarEnviadosHoje() {
  const inicioDoDia = inicioDoDiaBR();

  const { count, error } = await supabase
    .from('envio_itens')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'enviado')
    .gte('enviado_em', inicioDoDia.toISOString());

  if (error) throw error;
  return count || 0;
}

// Calcula o próximo horário permitido (meia-noite do dia seguinte, no fuso de SP)
function proximaJanela() {
  const inicioHojeBR = inicioDoDiaBR();
  return new Date(inicioHojeBR.getTime() + 24 * 60 * 60 * 1000);
}

async function enviarItem(item, envio) {
  const cliente = item.clientes;
  const templateDoItem = item.mensagem_override || envio.template_mensagem;
  const mensagem = montarMensagem(templateDoItem, cliente);

  // Escolhe o slot pra ESTA mensagem: slot fixo do envio, ou a estratégia
  // configurada (round_robin alterna mensagem a mensagem entre os conectados).
  let slotEscolhido;
  try {
    slotEscolhido = await escolherSlot(envio.slot);
  } catch (err) {
    await supabase.from('envio_itens').update({ status: 'erro', erro: err.message }).eq('id', item.id);
    await dispararWebhook('erro_envio', { cliente, envio_id: envio.id, erro: err.message });
    return;
  }

  try {
    const { existe, jid } = await validarNumero(cliente.telefone, slotEscolhido);
    if (!existe) {
      await supabase
        .from('envio_itens')
        .update({ status: 'numero_invalido', erro: 'Número não encontrado no WhatsApp', slot: slotEscolhido })
        .eq('id', item.id);

      await dispararWebhook('numero_invalido', { cliente, envio_id: envio.id });
      return;
    }

    const { messageId, slot: slotUsado } = cliente.pdf_url
      ? await enviarMensagemComPdf({
          numero: cliente.telefone,
          jid,
          mensagem,
          pdfUrl: cliente.pdf_url,
          pdfNome: `fatura-${cliente.nome}.pdf`,
          slot: slotEscolhido,
        })
      : await enviarMensagemTexto({ numero: cliente.telefone, jid, mensagem, slot: slotEscolhido });

    await supabase
      .from('envio_itens')
      .update({
        status: 'enviado',
        erro: null,
        message_id: messageId,
        status_entrega: 'enviado',
        enviado_em: new Date().toISOString(),
        slot: slotUsado,
      })
      .eq('id', item.id);

    // Sem isso, disparo em massa nunca aparecia na aba Chat -- a conversa só nascia
    // quando o cliente respondia. Grava aqui o mesmo jeito que a resposta manual do
    // Chat grava (registrarMensagemSaida), então o histórico fica completo dos dois lados.
    try {
      await registrarMensagemSaida({
        telefone: cliente.telefone,
        texto: mensagem,
        tipo: cliente.pdf_url ? 'documento' : 'texto',
        anexoUrl: cliente.pdf_url || null,
        anexoNome: cliente.pdf_url ? `fatura-${cliente.nome}.pdf` : null,
        messageId,
        slot: slotUsado,
      });
    } catch (chatErr) {
      console.error(`[dispatch] erro ao registrar no chat para ${cliente.nome}:`, chatErr.message);
    }

    await dispararWebhook('mensagem_enviada', { cliente, envio_id: envio.id, message_id: messageId, slot: slotUsado });
  } catch (err) {
    console.error(`[dispatch] erro ao enviar para ${cliente.nome}:`, err.message);
    await supabase
      .from('envio_itens')
      .update({ status: 'erro', erro: err.message, slot: slotEscolhido })
      .eq('id', item.id);

    await dispararWebhook('erro_envio', { cliente, envio_id: envio.id, erro: err.message });
  }
}

// Processa um disparo em lote: pega itens 'pendente' de um envio_id e dispara um a um.
export async function processarDisparo(envioId) {
  if (isRunning) {
    throw new Error('Já existe um disparo em andamento. Aguarde finalizar.');
  }
  isRunning = true;

  try {
    const { data: envio, error: envioError } = await supabase
      .from('envios')
      .select('*')
      .eq('id', envioId)
      .single();

    if (envioError || !envio) throw new Error('Envio não encontrado');

    await supabase.from('envios').update({ status: 'em_andamento', retomar_em: null }).eq('id', envioId);
    await dispararWebhook('disparo_iniciado', { envio_id: envioId });

    const { data: itens, error: itensError } = await supabase
      .from('envio_itens')
      .select('*, clientes(*)')
      .eq('envio_id', envioId)
      .eq('status', 'pendente');

    if (itensError) throw itensError;

    try {
      for (const item of itens) {
        // Sem isso: se o WhatsApp cair no meio do disparo (ex: celular sem internet,
        // sessão derrubada), o loop continuava e marcava CADA item restante como
        // 'erro' um por um -- ainda esperando o delay normal entre eles -- em vez de
        // parar. Com 300 itens pendentes isso significava minutos/horas queimando a
        // fila inteira em erro por nada. Agora, se não há conexão disponível pro slot
        // que esse envio usa, pausa (fica 'pendente' pra tentar de novo) e o
        // scheduler.js retoma sozinho quando -- e se -- a conexão voltar.
        if (!isConnected(envio.slot)) {
          const retomarEm = new Date(Date.now() + RECONEXAO_RETRY_MS);
          await supabase
            .from('envios')
            .update({ status: 'pausado', retomar_em: retomarEm.toISOString() })
            .eq('id', envioId);

          await dispararWebhook('disparo_pausado_sem_conexao', {
            envio_id: envioId,
            slot: envio.slot || null,
            retomar_em: retomarEm.toISOString(),
          });

          console.log(
            `[dispatch] conexão WhatsApp indisponível (slot ${envio.slot || 'qualquer'}), pausando disparo ${envioId}. Retomando em ${retomarEm.toISOString()}`
          );
          return;
        }

        if (DAILY_LIMIT > 0) {
          const enviadosHoje = await contarEnviadosHoje();
          if (enviadosHoje >= DAILY_LIMIT) {
            const retomarEm = proximaJanela();
            await supabase
              .from('envios')
              .update({ status: 'pausado', retomar_em: retomarEm.toISOString() })
              .eq('id', envioId);

            await dispararWebhook('disparo_pausado_limite_diario', {
              envio_id: envioId,
              retomar_em: retomarEm.toISOString(),
            });

            console.log(`[dispatch] limite diário (${DAILY_LIMIT}) atingido. Retomando em ${retomarEm.toISOString()}`);
            return; // encerra por hoje; o scheduler retoma amanhã
          }
        }

        await enviarItem(item, envio);
        contadorLote++;

        if (BATCH_SIZE > 0 && contadorLote % BATCH_SIZE === 0) {
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
        .eq('id', envioId);

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
      .eq('id', envioId);

    await dispararWebhook('disparo_concluido', { envio_id: envioId });
  } finally {
    isRunning = false;
  }
}

// Reenvia apenas os itens que falharam (status 'erro') de um envio -- não mexe nos já enviados
export async function reenviarErros(envioId) {
  const { error } = await supabase
    .from('envio_itens')
    .update({ status: 'pendente', erro: null })
    .eq('envio_id', envioId)
    .eq('status', 'erro');

  if (error) throw error;

  return processarDisparo(envioId);
}

export function disparoEmAndamento() {
  return isRunning;
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
