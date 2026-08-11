import { createCanvas } from '@napi-rs/canvas';
import jsQR from 'jsqr';

// pdfjs-dist precisa do build "legacy" pra rodar em Node puro (sem DOM/worker).
const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

// Um código Pix "copia e cola" (BR Code / EMV) sempre começa com esse payload
// fixo (id "00", tamanho "02", versão "01") e sempre contém o domínio do Banco
// Central. As duas condições juntas evitam confundir com QR de promoção/app
// (que são URLs, nunca batem com nenhuma das duas).
function ehCodigoPix(texto) {
  return typeof texto === 'string' && texto.startsWith('000201') && texto.includes('br.gov.bcb.pix');
}

// jsQR só decodifica UM QR por chamada -- se a página tem mais de um QR (comum
// em boleto: um é o Pix, outros costumam ser link de promoção ou do app da
// empresa), escanear a página inteira de uma vez frequentemente não acha
// NENHUM (os múltiplos padrões de localização confundem o algoritmo, ele falha
// fechado em vez de escolher errado). Por outro lado, um QR grande sozinho na
// página pode ficar maior que um bloco da grade e não ser detectado se a
// grade for fina demais.
//
// ANTES: testava grades 1x1, 2x2, 3x3 e 4x4 (30 blocos, 30 getImageData + 30
// decodificações de QR por página). Com dezenas/centenas de PDFs multi-página
// em importação e concorrência > 1, isso sozinho é o maior consumidor de CPU/RAM
// do fluxo de importação (chegava a travar o event loop e derrubar o processo
// -- inclusive a sessão do WhatsApp, que roda no mesmo processo). Reduz para
// grades 1x1 e 2x2 (5 blocos), que cobre a esmagadora maioria dos boletos reais
// (QR único e razoavelmente grande na página), e SÓ tenta 3x3 como último
// recurso, se as grades mais baratas não acharem nada -- caso raro.
function escanearBlocos(ctx, largura, altura) {
  const achados = new Set();

  function tentarGrade(grade) {
    const sobreposicao = 0.2; // 20% -- garante que um QR na borda de um bloco apareça inteiro em algum bloco vizinho
    const tileW = largura / grade;
    const tileH = altura / grade;

    for (let cy = 0; cy < grade; cy++) {
      for (let cx = 0; cx < grade; cx++) {
        const x0 = Math.max(0, Math.floor(cx * tileW - tileW * sobreposicao));
        const y0 = Math.max(0, Math.floor(cy * tileH - tileH * sobreposicao));
        const x1 = Math.min(largura, Math.ceil((cx + 1) * tileW + tileW * sobreposicao));
        const y1 = Math.min(altura, Math.ceil((cy + 1) * tileH + tileH * sobreposicao));

        const bloco = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
        const resultado = jsQR(bloco.data, bloco.width, bloco.height);
        if (resultado) achados.add(resultado.data);
      }
    }
  }

  tentarGrade(1);
  tentarGrade(2);
  if (achados.size === 0) tentarGrade(3); // fallback caro, só quando necessário

  return achados;
}

// Timeout de segurança por PDF -- um único documento corrompido, com página
// gigante ou muitas imagens pode travar a renderização por tempo desproporcional.
// Sem isso, um PDF problemático no meio de uma importação de 100+ arquivos podia
// prender o worker (e, por extensão, atrasar toda a fila) por minutos.
const TIMEOUT_POR_PDF_MS = 15_000;

function comTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// Renderiza cada página do PDF como imagem e tenta achar um QR code Pix entre
// possivelmente vários QRs na mesma página. Retorna o código Pix (string) ou
// null se não achar nenhum QR que bata com o padrão Pix.
export async function extrairPixDoPdf(buffer) {
  return comTimeout(extrairPixDoPdfSemTimeout(buffer), TIMEOUT_POR_PDF_MS);
}

async function extrairPixDoPdfSemTimeout(buffer) {
  try {
    const data = new Uint8Array(buffer);
    const doc = await pdfjsLib.getDocument({ data, disableFontFace: true }).promise;

    // Limita a busca às primeiras 3 páginas -- na prática o QR do Pix sempre
    // está bem no início do boleto (capa/1ª via). Documentos com muitas páginas
    // (anexos, contratos) só faziam a importação gastar tempo/memória à toa
    // renderizando páginas de texto sem QR nenhum.
    const paginasParaChecar = Math.min(doc.numPages, 3);

    for (let i = 1; i <= paginasParaChecar; i++) {
      const page = await doc.getPage(i);
      // scale 2.0 já dá DPI suficiente pro jsQR achar um QR pequeno numa página
      // A4 (era 2.5 -- reduzir gera um canvas ~35% menor em pixels, cortando
      // proporcionalmente o custo de renderização e de cada getImageData).
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');

      // pdfjs deixa áreas não pintadas do PDF como transparente (RGB preto,
      // alpha 0). jsQR lê RGB ignorando alpha, então "transparente" vira preto
      // pra ele e corrompe a leitura -- por isso pinta o fundo de branco ANTES
      // de renderizar por cima.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;

      const achados = escanearBlocos(ctx, canvas.width, canvas.height);
      const pix = [...achados].find(ehCodigoPix);
      if (pix) return pix;
    }
    return null;
  } catch (err) {
    console.error('[pixFromPdf] erro ao tentar extrair pix do pdf:', err.message);
    return null; // nunca derruba o fluxo de upload/importação por causa disso
  }
}

