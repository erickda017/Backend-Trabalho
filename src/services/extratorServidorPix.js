import fs from 'node:fs/promises';
import jsQR from 'jsqr';
import { isValidPixPayload } from '../lib/pixValidacao.js';

// ---------------------------------------------------------------------------
// [2026-08] EXTRAÇÃO DE PIX NO SERVIDOR -- "opção 2" (a padrão continua sendo
// 100% no navegador, ver frontend/src/lib/pixExtractor.ts). Existe porque, em
// alguns aparelhos (celular fraco, navegador sem suporte a Worker/
// OffscreenCanvas, muitos PDFs de uma vez), a extração local trava ou é
// inviável -- ver CONTEXTO.md pro histórico completo dessa decisão.
//
// A tentativa ANTERIOR de processar PDF no servidor (removida, ver git
// history de importLote.js/pix.routes.js) processava o LOTE inteiro de uma
// vez (zip com centenas de PDFs em memória) e estourava os 512MB do plano
// free do Render. A diferença desta vez, que é o que faz valer a pena
// reintroduzir:
//
//   1) Cada requisição HTTP processa NO MÁXIMO 1 PDF (ver
//      routes/pix.routes.js, POST /extrair-servidor, multer.single). O
//      próprio front dirige a fila (manda 1, espera a resposta, manda o
//      próximo) -- nunca existe mais de 1 PDF "em voo" por causa desta
//      rota.
//   2) MESMO ASSIM, se duas abas/pessoas chamarem ao mesmo tempo, uma FILA
//      em memória (`executarSequencial` abaixo) serializa as extrações --
//      nunca duas renderizações de PDF rodam em paralelo neste processo,
//      não importa quantas requisições cheguem juntas.
//   3) multer usa diskStorage (não memoryStorage) na rota -- o arquivo cru
//      nunca fica inteiro num Buffer da aplicação, só lido sob demanda daqui
//      (fs.readFile) e apagado logo em seguida (ver rota).
//   4) Cleanup explícito e agressivo entre páginas/arquivos: `doc.destroy()`,
//      `canvas.width = canvas.height = 0`, e uma chamada opcional a
//      `global.gc()` se o processo tiver sido iniciado com `--expose-gc`
//      (ver comentário no render.yaml sobre isso -- opcional, ajuda mas não
//      é obrigatório).
//
// Ainda assim, isso É mais pesado que o resto do backend (pdfjs-dist +
// @napi-rs/canvas rendem página de PDF em memória) -- por isso é uma opção
// EXPLÍCITA (o operador escolhe usar), não o caminho padrão, e por isso os
// limites abaixo são mais conservadores que os do extrator client-side.

const MAX_PAGINAS_POR_PDF = 3; // client-side tenta 4 -- aqui 3 já cobre a
// esmagadora maioria e cada página a menos é uma renderização a menos em RAM.

// Corner (canto inferior direito, onde o Pix normalmente está) -- só 1 alvo
// de resolução por tentativa (client-side tenta 2 por região); se não achar,
// tenta a página inteira, também com 1 alvo só. Menos tentativas = menos
// picos de memória, ao custo de (raramente) precisar cair pro navegador pra
// boletos de layout muito fora do padrão.
const REGIAO_CANTO_JUSTA = { x0: 0.45, y0: 0.55, x1: 1, y1: 1 };
const REGIAO_CANTO_AMPLA = { x0: 0.28, y0: 0.38, x1: 1, y1: 1 };
const REGIAO_PAGINA_INTEIRA = { x0: 0, y0: 0, x1: 1, y1: 1 };
const ALVO_PX_CANTO = 1800;
const ALVO_PX_PAGINA_INTEIRA = 1800;

// ---------------------------------------------------------------------------
// Fila em memória -- garante que só 1 extração roda por vez NESTE processo,
// mesmo que várias requisições cheguem juntas (ver ponto 2 do comentário
// acima). Cada chamada espera a anterior terminar (sucesso ou erro) antes de
// começar -- é o "acabou uma, próxima" pedido.
// ---------------------------------------------------------------------------
let filaAtual = Promise.resolve();

export function executarSequencial(tarefa) {
  const proxima = filaAtual.then(tarefa, tarefa);
  // nunca deixa a fila "travada" em rejeição -- cada elo trata seu próprio
  // erro (devolvido pra quem chamou via `proxima`), a fila em si só precisa
  // continuar andando pro próximo item.
  filaAtual = proxima.then(
    () => undefined,
    () => undefined,
  );
  return proxima;
}

let pdfjsLibPromise = null;
// Exportado pra reuso por outros serviços que também precisam renderizar PDF
// no servidor (ver services/verificacaoVencimentos.js) -- evita duplicar a
// lógica de carregamento/cache do módulo pdfjs-dist.
export async function carregarPdfjs() {
  if (!pdfjsLibPromise) {
    // Build "legacy" -- sem dependência de Worker/DOM do navegador, feita
    // pra rodar em Node. Import dinâmico (não no topo do módulo) só por
    // consistência com o resto do projeto (evita custo de carregar isso em
    // processos que nunca vão usar a extração no servidor).
    pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsLibPromise;
}

let canvasLibPromise = null;
export async function carregarCanvas() {
  if (!canvasLibPromise) {
    canvasLibPromise = import('@napi-rs/canvas');
  }
  return canvasLibPromise;
}

// Fábrica de canvas exigida pelo pdfjs-dist quando não há um <canvas> de DOM
// disponível (caso do Node) -- implementa a mesma interface mínima que o
// pdfjs espera (create/reset/destroy), usando @napi-rs/canvas (binário
// pré-compilado, sem precisar de libs nativas do sistema tipo Cairo/Pango --
// diferente do pacote `canvas` clássico, mais pesado de instalar no Render).
export function criarFabricaCanvas(createCanvas) {
  return {
    create(width, height) {
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext('2d') };
    },
    reset(canvasAndContext, width, height) {
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    },
    destroy(canvasAndContext) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    },
  };
}

function liberarCanvas(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch (_) {
    /* noop */
  }
}

function lerQrDoCanvas(context, width, height) {
  if (width < 20 || height < 20) return null;
  try {
    const imageData = context.getImageData(0, 0, width, height);
    const resultado = jsQR(imageData.data, imageData.width, imageData.height);
    const payload = resultado?.data?.trim();
    return isValidPixPayload(payload) ? payload : null;
  } catch (err) {
    console.warn('[extratorServidorPix] jsQR falhou:', err.message);
    return null;
  }
}

// Renderiza só o retângulo pedido da página (fração 0..1) num canvas do
// TAMANHO DO RECORTE (não da página inteira) -- mesma ideia do client-side
// (ver renderizarRegiaoDaPagina em pixExtractor.ts), permite mirar uma
// resolução mais alta sem alocar memória pra página inteira nessa resolução.
async function renderizarRegiao(pagina, regiao, alvoPx, criarCanvas) {
  const base = pagina.getViewport({ scale: 1 });
  const larguraRecortePt = base.width * (regiao.x1 - regiao.x0);
  const alturaRecortePt = base.height * (regiao.y1 - regiao.y0);
  const maiorLadoRecortePt = Math.max(larguraRecortePt, alturaRecortePt);
  const escala = Math.min(6, Math.max(0.5, alvoPx / Math.max(1, maiorLadoRecortePt)));

  const viewportCompleto = pagina.getViewport({ scale: escala });
  const x0 = viewportCompleto.width * regiao.x0;
  const y0 = viewportCompleto.height * regiao.y0;
  const x1 = viewportCompleto.width * regiao.x1;
  const y1 = viewportCompleto.height * regiao.y1;

  const largura = Math.max(1, Math.ceil(x1 - x0));
  const altura = Math.max(1, Math.ceil(y1 - y0));
  const canvas = criarCanvas(largura, altura);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, largura, altura);
  ctx.translate(-x0, -y0);

  await pagina.render({ canvasContext: ctx, viewport: viewportCompleto }).promise;
  return canvas;
}

async function extrairPixDaPagina(pagina, indicePagina, criarCanvas) {
  let canvas = await renderizarRegiao(pagina, REGIAO_CANTO_JUSTA, ALVO_PX_CANTO, criarCanvas);
  let pix = lerQrDoCanvas(canvas.getContext('2d'), canvas.width, canvas.height);
  liberarCanvas(canvas);
  if (pix) return { pixCopiaCola: pix, pagina: indicePagina + 1, origem: 'canto' };

  canvas = await renderizarRegiao(pagina, REGIAO_CANTO_AMPLA, ALVO_PX_CANTO, criarCanvas);
  pix = lerQrDoCanvas(canvas.getContext('2d'), canvas.width, canvas.height);
  liberarCanvas(canvas);
  if (pix) return { pixCopiaCola: pix, pagina: indicePagina + 1, origem: 'canto-ampliado' };

  canvas = await renderizarRegiao(pagina, REGIAO_PAGINA_INTEIRA, ALVO_PX_PAGINA_INTEIRA, criarCanvas);
  pix = lerQrDoCanvas(canvas.getContext('2d'), canvas.width, canvas.height);
  liberarCanvas(canvas);
  if (pix) return { pixCopiaCola: pix, pagina: indicePagina + 1, origem: 'pagina-inteira' };

  return null;
}

// Ponto de entrada: extrai o Pix de 1 PDF já salvo em disco (`caminhoArquivo`,
// escrito pelo multer diskStorage -- ver routes/pix.routes.js). SEMPRE
// enfileirado (ver executarSequencial) -- só 1 execução real por vez neste
// processo, não importa quantas chamadas cheguem ao mesmo tempo.
export async function extrairPixDeArquivoNoServidor(caminhoArquivo) {
  return executarSequencial(async () => {
    const [pdfjsLib, { createCanvas }] = await Promise.all([carregarPdfjs(), carregarCanvas()]);
    const fabricaCanvas = criarFabricaCanvas(createCanvas);

    const bufferLido = await fs.readFile(caminhoArquivo);
    // pdfjs-dist rejeita `Buffer` explicitamente (mesmo sendo subclasse de
    // Uint8Array) -- precisa ser um Uint8Array "puro". `new Uint8Array(buf)`
    // copia os bytes (não é view sobre o mesmo backing buffer do Buffer, que
    // pode vir de um pool interno do Node) -- mais seguro aqui, arquivo já é
    // pequeno (checado pelo multer/limits antes de chegar aqui).
    const bytes = new Uint8Array(bufferLido);
    let doc = null;
    try {
      doc = await pdfjsLib.getDocument({
        data: bytes,
        canvasFactory: fabricaCanvas,
        // Sem isso o pdfjs tenta carregar fontes/CMaps padrão de rede/disco
        // que não existem neste ambiente -- não impede achar o Pix (não
        // depende de texto renderizado corretamente, só do QR).
        useSystemFonts: true,
        isEvalSupported: false,
      }).promise;

      const totalPaginas = Math.min(doc.numPages, MAX_PAGINAS_POR_PDF);
      for (let indice = 0; indice < totalPaginas; indice++) {
        let pagina = null;
        try {
          pagina = await doc.getPage(indice + 1);
          const resultado = await extrairPixDaPagina(pagina, indice, (w, h) => fabricaCanvas.create(w, h).canvas);
          if (resultado) return resultado;
        } finally {
          if (pagina && typeof pagina.cleanup === 'function') {
            try { pagina.cleanup(); } catch (_) { /* noop */ }
          }
        }
      }
      return null;
    } finally {
      if (doc && typeof doc.destroy === 'function') {
        try { await doc.destroy(); } catch (_) { /* noop */ }
      }
      // Best-effort: só existe se o processo subiu com `node --expose-gc`
      // (ver comentário no render.yaml). Ajuda a devolver a memória dos
      // canvases/buffers pro SO mais rápido entre um PDF e o próximo, mas
      // não é obrigatório -- sem o flag, o V8 ainda libera sozinho, só que
      // no próprio ritmo dele.
      if (typeof global.gc === 'function') {
        try { global.gc(); } catch (_) { /* noop */ }
      }
    }
  });
}
