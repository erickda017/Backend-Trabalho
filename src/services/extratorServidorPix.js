import fs from 'node:fs/promises';
import jsQR from 'jsqr';
import { isValidPixPayload } from '../lib/pixValidacao.js';
import { logLimitado } from '../lib/log.js';

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
    logLimitado('jsqr', 'warn', '[extratorServidorPix] jsQR falhou:', err.message);
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

// [2026-11] Modo `completo` (usado pela integração EnnyChat): mesmas estratégias do extrator do navegador
// (frontend/src/lib/pixExtractor.ts) -- 4 páginas e 2 resoluções por região. O modo padrão continua conservador
// (3 páginas, 1 resolução) pra não pesar na RAM do plano free.
const ALVOS_PADRAO = { canto: [ALVO_PX_CANTO], ampla: [ALVO_PX_CANTO], inteira: [ALVO_PX_PAGINA_INTEIRA] };
const ALVOS_COMPLETO = { canto: [1800, 2600], ampla: [2200, 2800], inteira: [1800, 2600] };
const MAX_PAGINAS_COMPLETO = 4;

async function extrairPixDaPagina(pagina, indicePagina, criarCanvas, alvos = ALVOS_PADRAO) {
  const tentativas = [
    [REGIAO_CANTO_JUSTA, alvos.canto, 'canto'],
    [REGIAO_CANTO_AMPLA, alvos.ampla, 'canto-ampliado'],
    [REGIAO_PAGINA_INTEIRA, alvos.inteira, 'pagina-inteira'],
  ];
  for (const [regiao, pxs, origem] of tentativas) {
    for (const px of pxs) {
      const canvas = await renderizarRegiao(pagina, regiao, px, criarCanvas);
      const pix = lerQrDoCanvas(canvas.getContext('2d'), canvas.width, canvas.height);
      liberarCanvas(canvas);
      if (pix) return { pixCopiaCola: pix, pagina: indicePagina + 1, origem };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// [2026-11] MODO COMPLETO (integração EnnyChat): porta fiel das estratégias do extrator do navegador
// (frontend/src/lib/pixExtractor.ts) que o modo padrão do servidor não tinha:
//   1) CANTO "NATIVO": PDFs escaneados/de impressora virtual guardam a página como UMA imagem de ~144dpi, onde o QR
//      tem ~1px por módulo. Pedir escala alta ao pdfjs reamostra e borra; render em escala 2 (1px do canvas = 1px da
//      imagem) + ampliação 3x com suavização do próprio canvas lê. Roda ANTES, em todas as páginas.
//   2) VARREDURA EM BLOCOS (3x4, 40% de sobreposição): jsQR decodifica UM QR por chamada; com QR de propaganda
//      colado no Pix ele pode "travar" no errado. Isolar em blocos resolve.
// Nenhuma redução de qualidade: tudo renderiza a partir do PDF original.
// ---------------------------------------------------------------------------
const QR_TILE_COLS = 3;
const QR_TILE_ROWS = 4;
const QR_TILE_OVERLAP = 0.4;
const QR_TILE_MIN_DIMENSAO = 300;
const ESCALA_NATIVA = 2;
const FATOR_AMPLIACAO_NATIVO = 3;
const TIMEOUT_POR_PAGINA_MS = 20_000;

function lerQrDoRetangulo(ctx, x0, y0, w, h) {
  if (w < 20 || h < 20) return null;
  try {
    const imageData = ctx.getImageData(x0, y0, w, h);
    const resultado = jsQR(imageData.data, imageData.width, imageData.height);
    const payload = resultado?.data?.trim();
    return isValidPixPayload(payload) ? payload : null;
  } catch (err) {
    logLimitado('jsqr', 'warn', '[extratorServidorPix] jsQR falhou:', err.message);
    return null;
  }
}

function ordemDosBlocos(linhas, colunas) {
  const ordemLinhas = [linhas - 1, ...Array.from({ length: linhas - 1 }, (_, i) => i)]; // última linha primeiro
  const ordem = [];
  for (const linha of ordemLinhas) for (let coluna = 0; coluna < colunas; coluna++) ordem.push([linha, coluna]);
  return ordem;
}

function escanearBlocos(ctx, width, height) {
  if (width < QR_TILE_MIN_DIMENSAO || height < QR_TILE_MIN_DIMENSAO) return null;
  const tileW = width / QR_TILE_COLS;
  const tileH = height / QR_TILE_ROWS;
  for (const [linha, coluna] of ordemDosBlocos(QR_TILE_ROWS, QR_TILE_COLS)) {
    const x0 = Math.max(0, Math.floor(coluna * tileW - tileW * QR_TILE_OVERLAP));
    const y0 = Math.max(0, Math.floor(linha * tileH - tileH * QR_TILE_OVERLAP));
    const x1 = Math.min(width, Math.ceil((coluna + 1) * tileW + tileW * QR_TILE_OVERLAP));
    const y1 = Math.min(height, Math.ceil((linha + 1) * tileH + tileH * QR_TILE_OVERLAP));
    const pix = lerQrDoRetangulo(ctx, x0, y0, x1 - x0, y1 - y0);
    if (pix) return pix;
  }
  return null;
}

async function tentarRegiaoComBlocos(pagina, regiao, alvos, criarCanvas) {
  for (const px of alvos) {
    const canvas = await renderizarRegiao(pagina, regiao, px, criarCanvas);
    const ctx = canvas.getContext('2d');
    const pix = lerQrDoRetangulo(ctx, 0, 0, canvas.width, canvas.height) ?? escanearBlocos(ctx, canvas.width, canvas.height);
    liberarCanvas(canvas);
    if (pix) return pix;
  }
  return null;
}

async function tentarCantoNativo(pagina, regiao, comBlocos, criarCanvas) {
  const viewport = pagina.getViewport({ scale: ESCALA_NATIVA });
  const x0 = Math.floor(viewport.width * regiao.x0);
  const y0 = Math.floor(viewport.height * regiao.y0);
  const w = Math.max(1, Math.ceil(viewport.width * regiao.x1) - x0);
  const h = Math.max(1, Math.ceil(viewport.height * regiao.y1) - y0);

  const origem = criarCanvas(w, h);
  const ctxOrigem = origem.getContext('2d');
  ctxOrigem.fillStyle = '#ffffff';
  ctxOrigem.fillRect(0, 0, w, h);
  ctxOrigem.translate(-x0, -y0);
  await pagina.render({ canvasContext: ctxOrigem, viewport }).promise;

  const ampliado = criarCanvas(w * FATOR_AMPLIACAO_NATIVO, h * FATOR_AMPLIACAO_NATIVO);
  const ctxAmp = ampliado.getContext('2d');
  ctxAmp.imageSmoothingEnabled = true;
  ctxAmp.imageSmoothingQuality = 'high';
  ctxAmp.drawImage(origem, 0, 0, w, h, 0, 0, ampliado.width, ampliado.height);
  liberarCanvas(origem);

  let pix = lerQrDoRetangulo(ctxAmp, 0, 0, ampliado.width, ampliado.height);
  if (!pix && comBlocos) pix = escanearBlocos(ctxAmp, ampliado.width, ampliado.height);
  liberarCanvas(ampliado);
  return pix;
}

const comTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

async function extrairPixCompleto(doc, criarCanvas) {
  const totalPaginas = Math.min(doc.numPages, MAX_PAGINAS_COMPLETO);
  // 2 passadas (como o navegador): rápida/nativa em TODAS as páginas, depois a varredura completa.
  for (const rapido of [true, false]) {
    for (let indice = 0; indice < totalPaginas; indice++) {
      let pagina = null;
      try {
        pagina = await doc.getPage(indice + 1);
        const tarefa = rapido
          ? (async () => {
              for (const [regiao, origem] of [[REGIAO_CANTO_JUSTA, 'canto'], [REGIAO_CANTO_AMPLA, 'canto-ampliado']]) {
                const pix = await tentarCantoNativo(pagina, regiao, origem === 'canto', criarCanvas);
                if (pix) return { pixCopiaCola: pix, pagina: indice + 1, origem: `${origem}-nativo` };
              }
              return null;
            })()
          : (async () => {
              for (const [regiao, alvos, origem] of [
                [REGIAO_CANTO_JUSTA, ALVOS_COMPLETO.canto, 'canto'],
                [REGIAO_CANTO_AMPLA, ALVOS_COMPLETO.ampla, 'canto-ampliado'],
                [REGIAO_PAGINA_INTEIRA, ALVOS_COMPLETO.inteira, 'pagina-inteira'],
              ]) {
                const pix = await tentarRegiaoComBlocos(pagina, regiao, alvos, criarCanvas);
                if (pix) return { pixCopiaCola: pix, pagina: indice + 1, origem };
              }
              return null;
            })();
        const r = await comTimeout(tarefa, TIMEOUT_POR_PAGINA_MS);
        if (r) return r;
      } catch (err) {
        if (!rapido) throw err;
        logLimitado('qr-nativo', 'warn', '[extratorServidorPix] leitura nativa falhou, segue pro método completo:', err.message);
      } finally {
        if (pagina && typeof pagina.cleanup === 'function') {
          try { pagina.cleanup(); } catch (_) { /* noop */ }
        }
      }
    }
  }
  return null;
}

// Ponto de entrada: extrai o Pix de 1 PDF já salvo em disco (`caminhoArquivo`,
// escrito pelo multer diskStorage -- ver routes/pix.routes.js). SEMPRE
// enfileirado (ver executarSequencial) -- só 1 execução real por vez neste
// processo, não importa quantas chamadas cheguem ao mesmo tempo.
export async function extrairPixDeArquivoNoServidor(caminhoArquivo, { completo = false } = {}) {
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

      if (completo) return await extrairPixCompleto(doc, (w, h) => fabricaCanvas.create(w, h).canvas);

      const totalPaginas = Math.min(doc.numPages, MAX_PAGINAS_POR_PDF);
      for (let indice = 0; indice < totalPaginas; indice++) {
        let pagina = null;
        try {
          pagina = await doc.getPage(indice + 1);
          const resultado = await extrairPixDaPagina(pagina, indice, (w, h) => fabricaCanvas.create(w, h).canvas, ALVOS_PADRAO);
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
