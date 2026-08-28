// [CRÍTICO] Verificação em massa do VENCIMENTO real de cada cliente, lendo o
// PDF da fatura já anexada (`clientes.pdf_path`) -- pedido explícito: depois
// da integração de safras (que usa `data_prazo`, o PRAZO final do ciclo),
// grande parte da carteira nunca teve o `vencimento` (data real impressa no
// boleto) preenchido, e prazo != vencimento (vencimento costuma ser ~30 dias
// ANTES do prazo, ver comentário em routes/clientes.routes.js).
//
// Reaproveita a MESMA infraestrutura de renderização de PDF já usada por
// extratorServidorPix.js (pdfjs-dist + @napi-rs/canvas, sem depender de
// DOM/Worker de navegador) e o MESMO Cloudflare Worker que já faz OCR pra
// extrair o vencimento (ver worker-processo-de-pdf/worker.js,
// `extractVencimento`) -- só que aqui rodando em lote, no servidor, 1 cliente
// de cada vez.
//
// Fila: reusa `executarSequencial` de extratorServidorPix.js -- nunca roda
// mais de 1 renderização de PDF pesada por vez NESTE PROCESSO, nem que dois
// operadores (de tenants diferentes) disparem a verificação ao mesmo tempo
// (mesmo motivo documentado lá: proteger o limite de RAM do plano free do
// Render). Progresso fica em memória, por usuário -- some se o processo
// reiniciar no meio (mesmo trade-off já aceito pelo resto do sistema pra
// jobs em memória, ver dispatchQueue.js).
import { supabase, BUCKET } from '../lib/supabase.js';
import { propagarDadosFatura } from '../lib/faturaPropagacao.js';
import { executarSequencial, carregarPdfjs, carregarCanvas, criarFabricaCanvas } from './extratorServidorPix.js';

const WORKER_URL = process.env.WORKER_URL || 'https://processo-de-pdf.erickramiro2010.workers.dev';
// Delay entre clientes -- o Worker chama o OCR.space (rate limit de terceiro,
// plano gratuito) e o próprio Render tem CPU/RAM limitados; não vale a pena
// martelar em sequência sem respiro (mesmo espírito de MIN_DELAY_MS no
// dispatchQueue, mas aqui é um valor fixo -- não é conversa com humano do
// outro lado, não precisa de aleatoriedade).
const DELAY_ENTRE_ITENS_MS = Number(process.env.VERIFICACAO_VENCIMENTO_DELAY_MS || 1500);
const ALVO_PX_PAGINA = 1600;
const LIMITE_BYTES_WORKER = 1024 * 1024; // 1MB -- mesmo limite de worker.js (OCR_SPACE_LIMIT_BYTES)
const QUALIDADES_JPEG = [0.75, 0.5, 0.3];

// Job em memória por usuário (mesmo padrão multi-tenant de outros serviços
// deste arquivo/módulo -- 1 processo Node, vários tenants isolados por chave).
const jobsPorUsuario = new Map();

function estadoInicial() {
  return {
    rodando: false,
    total: 0,
    processados: 0,
    encontrados: 0,
    nao_encontrados: 0,
    erros: [],
    iniciado_em: null,
    concluido_em: null,
  };
}

/** Estado atual (pra polling do front) -- nunca lança, devolve "idle" se nunca rodou. */
export function statusVerificacao(usuarioId) {
  return jobsPorUsuario.get(usuarioId) || estadoInicial();
}

// Inicia o job pra este usuário (idempotente: se já está rodando, devolve o
// mesmo estado em vez de duplicar). `apenasPendentes=true` (padrão) só
// processa quem ainda não tem `vencimento` -- é o caso de uso real pedido
// (achar o vencimento de quem nunca teve), evita reprocessar (custo de
// OCR/tempo) quem já foi verificado. `apenasPendentes=false` força reverificar
// todo mundo com PDF.
export function iniciarVerificacao(usuarioId, { apenasPendentes = true } = {}) {
  const atual = jobsPorUsuario.get(usuarioId);
  if (atual?.rodando) return atual;

  const estado = estadoInicial();
  estado.rodando = true;
  estado.iniciado_em = new Date().toISOString();
  jobsPorUsuario.set(usuarioId, estado);

  processarEmBackground(usuarioId, estado, apenasPendentes).catch((err) => {
    console.error('[verificacaoVencimentos] erro fatal no job:', err.message);
    estado.rodando = false;
    estado.concluido_em = new Date().toISOString();
  });

  return estado;
}

async function processarEmBackground(usuarioId, estado, apenasPendentes) {
  let query = supabase
    .from('clientes')
    .select('id, nome, pdf_path')
    .eq('usuario_id', usuarioId)
    .not('pdf_path', 'is', null)
    .limit(5000);
  if (apenasPendentes) query = query.is('vencimento', null);

  const { data: clientes, error } = await query;
  if (error) throw error;

  estado.total = (clientes || []).length;

  for (const cliente of clientes || []) {
    try {
      const vencimento = await executarSequencial(() => extrairVencimentoDoPdf(cliente.pdf_path));
      if (vencimento) {
        // Só grava `vencimento` -- NUNCA `data_prazo` (são datas diferentes,
        // ver comentário no topo do arquivo). propagarDadosFatura já cuida de
        // espelhar pro grupo inteiro (números vinculados, ver migration-15).
        await propagarDadosFatura(cliente.id, usuarioId, { vencimento });
        estado.encontrados += 1;
      } else {
        estado.nao_encontrados += 1;
      }
    } catch (err) {
      estado.erros.push({ cliente_id: cliente.id, cliente_nome: cliente.nome, erro: err.message });
    } finally {
      estado.processados += 1;
    }
    if (DELAY_ENTRE_ITENS_MS > 0) await esperar(DELAY_ENTRE_ITENS_MS);
  }

  estado.rodando = false;
  estado.concluido_em = new Date().toISOString();
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Baixa o PDF do Storage, renderiza a 1ª página como JPEG (comprimida o
// suficiente pra caber no limite do OCR.space) e manda pro Worker extrair o
// vencimento -- devolve a data já no formato BR ("DD/MM/AAAA", o mesmo que
// `clientes.vencimento` usa em todo o resto do sistema) ou null se não achou.
async function extrairVencimentoDoPdf(pdfPath) {
  const { data: blob, error } = await supabase.storage.from(BUCKET).download(pdfPath);
  if (error || !blob) throw new Error(error?.message || 'não foi possível baixar o PDF do Storage');
  const bytes = new Uint8Array(await blob.arrayBuffer());

  const jpegBuffer = await renderizarPrimeiraPaginaComoJpeg(bytes);
  if (!jpegBuffer) return null; // página grande/complexa demais pra caber no limite mesmo comprimida

  const dados = await chamarWorker(jpegBuffer);
  return dados?.vencimento || null;
}

async function renderizarPrimeiraPaginaComoJpeg(bytes) {
  const [pdfjsLib, { createCanvas }] = await Promise.all([carregarPdfjs(), carregarCanvas()]);
  const fabricaCanvas = criarFabricaCanvas(createCanvas);

  let doc = null;
  let pagina = null;
  try {
    doc = await pdfjsLib.getDocument({
      data: bytes,
      canvasFactory: fabricaCanvas,
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise;

    pagina = await doc.getPage(1);
    const base = pagina.getViewport({ scale: 1 });
    const escala = Math.min(3, Math.max(0.5, ALVO_PX_PAGINA / Math.max(base.width, base.height)));
    const viewport = pagina.getViewport({ scale: escala });

    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pagina.render({ canvasContext: ctx, viewport }).promise;

    // Tenta qualidades decrescentes até caber no limite do Worker/OCR.space --
    // mesma régua que o front já aplica antes de mandar pro Worker.
    for (const qualidade of QUALIDADES_JPEG) {
      const buffer = await canvas.encode('jpeg', qualidade);
      if (buffer.byteLength <= LIMITE_BYTES_WORKER) return buffer;
    }
    return null;
  } finally {
    if (pagina && typeof pagina.cleanup === 'function') {
      try { pagina.cleanup(); } catch (_) { /* noop */ }
    }
    if (doc && typeof doc.destroy === 'function') {
      try { await doc.destroy(); } catch (_) { /* noop */ }
    }
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch (_) { /* noop */ }
    }
  }
}

async function chamarWorker(jpegBuffer) {
  const form = new FormData();
  form.append('file', new Blob([jpegBuffer], { type: 'image/jpeg' }), 'pagina.jpg');

  const resposta = await fetch(WORKER_URL, { method: 'POST', body: form });
  if (!resposta.ok) throw new Error(`Worker respondeu HTTP ${resposta.status}`);

  const json = await resposta.json();
  if (!json?.success) throw new Error(json?.error || 'Worker não retornou sucesso');
  return json.data;
}
