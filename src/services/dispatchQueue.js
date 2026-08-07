import { supabase } from '../lib/supabase.js';
import { enviarMensagemComPdf, enviarMensagemTexto, validarNumero } from './whatsapp.js';
import { dispararWebhook } from './webhook.js';

const MIN_DELAY = Number(process.env.MIN_DELAY_MS || 5000);
const MAX_DELAY = Number(process.env.MAX_DELAY_MS || 15000);

// Limite diário de mensagens (todas os envios somados). 0 = sem limite.
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 100);

// A cada N mensagens enviadas, faz uma pausa mais longa (simula comportamento humano)
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 20);
const BATCH_PAUSE_MS = Number(process.env.BATCH_PAUSE_MS || 10 * 60 * 1000); // 10 min

let isRunning = false;
let contadorLote = 0;

// Brasil não observa horário de verão desde 2019 -- offset fixo -03:00.
// IMPORTANTE: o servidor (Render) roda em UTC, não no horário de Brasília. Usar
// `new Date(); setHours(0,0,0,0)` (como antes) calcula a "meia-noite" em UTC, que
// corresponde às 21h em Brasília -- isso reiniciava o limite diário 3h mais cedo
// do que o esperado. Por isso o "início do dia" é calculado explicitamente no
// fuso de São Paulo aqui, independente do fuso do servidor.
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

function delayAleatorio() {
  const ms = Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function montarMensagem(template, cliente) {
  const valorNumerico = cliente.valor != null ? Number(String(cliente.valor).replace(',', '.')) : null;
  return template
    .replaceAll('{{nome}}', cliente.nome || '')
    .replaceAll('{{valor}}', valorNumerico && !Number.isNaN(valorNumerico) ? `R$ ${valorNumerico.toFixed(2)}` : '')
    .replaceAll('{{vencimento}}', cliente.vencimento || '');
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

  // valida se o número existe no WhatsApp antes de gastar tempo/risco enviando.
  // Também dentro do try/catch: se a validação falhar (ex: conexão caiu no meio do
  // disparo), o item vira 'erro' (retry-ável) em vez de derrubar o lote inteiro.
  try {
    const { existe } = await validarNumero(cliente.telefone);
    if (!existe) {
      await supabase
        .from('envio_itens')
        .update({ status: 'numero_invalido', erro: 'Número não encontrado no WhatsApp' })
        .eq('id', item.id);

      await dispararWebhook('numero_invalido', { cliente, envio_id: envio.id });
      return;
    }

    const { messageId } = cliente.pdf_url
      ? await enviarMensagemComPdf({
          numero: cliente.telefone,
          mensagem,
          pdfUrl: cliente.pdf_url,
          pdfNome: `fatura-${cliente.nome}.pdf`,
        })
      : await enviarMensagemTexto({ numero: cliente.telefone, mensagem });

    await supabase
      .from('envio_itens')
      .update({
        status: 'enviado',
        erro: null,
        message_id: messageId,
        status_entrega: 'enviado',
        enviado_em: new Date().toISOString(),
      })
      .eq('id', item.id);

    await dispararWebhook('mensagem_enviada', { cliente, envio_id: envio.id, message_id: messageId });
  } catch (err) {
    console.error(`[dispatch] erro ao enviar para ${cliente.nome}:`, err.message);
    await supabase
      .from('envio_itens')
      .update({ status: 'erro', erro: err.message })
      .eq('id', item.id);

    await dispararWebhook('erro_envio', { cliente, envio_id: envio.id, erro: err.message });
  }
}

// Processa um disparo em lote: pega itens 'pendente' de um envio_id e dispara um a um,
// respeitando delay aleatório, limite diário e pausa longa a cada lote.
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
          await delayAleatorio();
        }
      }
    } catch (err) {
      // Qualquer erro inesperado aqui (ex: conexão do WhatsApp caiu no meio do disparo)
      // NUNCA deve deixar o envio travado em 'em_andamento' pra sempre -- isso deixaria
      // o usuário sem conseguir retomar ou reenviar pela interface. Marca como pausado
      // com o erro registrado; os itens que ainda estão 'pendente' podem ser retomados
      // depois (basta clicar em disparar de novo, ou o scheduler não mexe nesse caso
      // porque não há retomar_em -- fica visível como pausado até ação manual).
      console.error(`[dispatch] erro inesperado no disparo ${envioId}, pausando:`, err.message);
      await supabase
        .from('envios')
        .update({ status: 'pausado', retomar_em: null })
        .eq('id', envioId);

      await dispararWebhook('disparo_erro_inesperado', { envio_id: envioId, erro: err.message });
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
// no meio de um disparo, o envio fica marcado 'em_andamento' no banco pra sempre,
// já que `isRunning` (em memória) reseta pra false ao reiniciar, mas nada nunca
// avisa o banco disso. Sem essa recuperação, o envio ficaria travado na tela de
// progresso pra sempre, sem nenhum jeito de retomar pela interface.
// É seguro voltar pra 'pendente': o dispatch só processa itens ainda 'pendente',
// então nada é reenviado em duplicidade.
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
