// Integração EnnyChat -- lê um boleto PDF NO SERVIDOR e devolve { codigo, nome, vencimento, pix }.
// Ordem: camada de texto do PDF (instantâneo, PDF digital) -> Worker de OCR (PDF imagem, o mesmo
// de verificacaoVencimentos.js). O Pix vem do QR (extratorServidorPix.js) e só vale se passar
// isValidPixPayload (CRC16). Nunca chuta: campo não achado fica null e o vínculo vira revisão.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { carregarPdfjs, carregarCanvas, criarFabricaCanvas, executarSequencial, extrairPixDeArquivoNoServidor } from './extratorServidorPix.js';
import { renderizarPrimeiraPaginaComoJpeg, chamarWorker } from './verificacaoVencimentos.js';
import { extrairCamposPorTexto } from '../lib/ennychat/textoCabecalhoPdf.js';
import { isValidPixPayload } from '../lib/pixValidacao.js';
import { logLimitado } from '../lib/log.js';

async function lerTexto(bytes) {
  const [pdfjsLib, { createCanvas }] = await Promise.all([carregarPdfjs(), carregarCanvas()]);
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    canvasFactory: criarFabricaCanvas(createCanvas),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;
  try {
    return await extrairCamposPorTexto(doc);
  } finally {
    try { await doc.destroy(); } catch { /* noop */ }
  }
}

async function lerPorWorker(bytes) {
  const jpeg = await renderizarPrimeiraPaginaComoJpeg(new Uint8Array(bytes));
  return jpeg ? chamarWorker(jpeg) : null;
}

async function lerPix(bytes) {
  const arquivo = path.join(os.tmpdir(), `ennychat-${crypto.randomUUID()}.pdf`);
  await fs.writeFile(arquivo, bytes);
  try {
    const r = await extrairPixDeArquivoNoServidor(arquivo);
    return r?.pixCopiaCola ?? null;
  } finally {
    await fs.rm(arquivo, { force: true });
  }
}

// -> { codigo, nome, vencimento ("DD/MM/AAAA"), pix (string válida | null) }
export async function lerBoletoPdf(bytes) {
  // Sem executarSequencial aqui: extrairPixDeArquivoNoServidor já enfileira por conta própria
  // (aninhar a fila travaria). Texto e Worker entram na fila individualmente.
  {
    let campos = { codigo: null, nome: null, vencimento: null, pixCopiaColaTexto: null };
    try {
      campos = await executarSequencial(() => lerTexto(bytes));
    } catch (err) {
      logLimitado('ennychat-texto', 'warn', '[ennychat] leitura de texto do PDF falhou:', err.message);
    }
    // Worker só quando o texto não deu os 3 campos (PDF imagem ou layout fora do padrão).
    if (!campos.codigo || !campos.nome || !campos.vencimento) {
      try {
        const w = await executarSequencial(() => lerPorWorker(bytes));
        if (w) {
          campos = {
            ...campos,
            codigo: campos.codigo ?? w.codigo ?? null,
            nome: campos.nome ?? w.nome ?? null,
            vencimento: campos.vencimento ?? w.vencimento ?? null,
            pixCopiaColaTexto: campos.pixCopiaColaTexto ?? w.pixCopiaCola ?? null,
          };
        }
      } catch (err) {
        logLimitado('ennychat-worker', 'warn', '[ennychat] Worker de OCR falhou:', err.message);
      }
    }
    let pix = null;
    try {
      pix = await lerPix(bytes);
    } catch (err) {
      logLimitado('ennychat-pix', 'warn', '[ennychat] leitura do QR Pix falhou:', err.message);
    }
    if (!isValidPixPayload(pix)) pix = isValidPixPayload(campos.pixCopiaColaTexto) ? campos.pixCopiaColaTexto : null;
    return { codigo: campos.codigo ?? null, nome: campos.nome ?? null, vencimento: campos.vencimento ?? null, pix };
  }
}
