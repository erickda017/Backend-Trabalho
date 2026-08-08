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
// grade for fina demais. Por isso testa VÁRIAS granularidades de grade (página
// inteira, 2x2, 3x3, 4x4) e junta tudo que foi achado em qualquer uma -- cobre
// tanto o caso "um QR grande sozinho" quanto "vários QR pequenos disputando
// espaço".
function escanearBlocos(ctx, largura, altura) {
  const achados = new Set();

  for (const grade of [1, 2, 3, 4]) {
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
  return achados;
}

// Renderiza cada página do PDF como imagem e tenta achar um QR code Pix entre
// possivelmente vários QRs na mesma página. Retorna o código Pix (string) ou
// null se não achar nenhum QR que bata com o padrão Pix.
export async function extrairPixDoPdf(buffer) {
  try {
    const data = new Uint8Array(buffer);
    const doc = await pdfjsLib.getDocument({ data, disableFontFace: true }).promise;

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      // scale 2.5 dá DPI suficiente pro jsQR achar um QR pequeno numa página A4
      // sem gastar memória/tempo demais com scale mais alto.
      const viewport = page.getViewport({ scale: 2.5 });
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

