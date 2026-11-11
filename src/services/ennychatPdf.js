// Integração EnnyChat -- lê um boleto PDF NO SERVIDOR e devolve { codigo, nome, vencimento, pix }.
// Ordem: camada de texto do PDF (instantâneo, PDF digital) -> Worker de OCR (PDF imagem, o mesmo
// de verificacaoVencimentos.js). O Pix vem do QR (extratorServidorPix.js) e só vale se passar
// isValidPixPayload (CRC16). Nunca chuta: campo não achado fica null e o vínculo vira revisão.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { carregarPdfjs, carregarCanvas, criarFabricaCanvas, executarSequencial, extrairPixDeArquivoNoServidor } from './extratorServidorPix.js';
import { chamarWorker } from './verificacaoVencimentos.js';
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

// Mesmo recorte que o navegador manda ao Worker (frontend/src/lib/pixWorkerClient.ts): só o TOPO (nome, "Código",
// vencimento, valor) e o RODAPÉ da página, empilhados num JPEG de ~200KB, renderizados a 1800px de largura.
// Página inteira reduzida (o que havia antes) fazia o OCR perder código e vencimento.
const FRACAO_FAIXA = 0.12;
const LARGURA_RECORTE_PX = 1800;
const LIMITE_BYTES_WORKER = 1024 * 1024;

export async function recorteCabecalhoJpeg(bytes, numeroPagina) {
  const [pdfjsLib, { createCanvas }] = await Promise.all([carregarPdfjs(), carregarCanvas()]);
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    canvasFactory: criarFabricaCanvas(createCanvas),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;
  let pagina = null;
  try {
    if (numeroPagina > doc.numPages) return null;
    pagina = await doc.getPage(numeroPagina);
    const base = pagina.getViewport({ scale: 1 });
    const viewport = pagina.getViewport({ scale: LARGURA_RECORTE_PX / base.width });
    const pag = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const pctx = pag.getContext('2d');
    pctx.fillStyle = '#ffffff';
    pctx.fillRect(0, 0, pag.width, pag.height);
    await pagina.render({ canvasContext: pctx, viewport }).promise;

    const w = pag.width;
    const faixa = Math.ceil(pag.height * FRACAO_FAIXA);
    const out = createCanvas(w, faixa * 2);
    const octx = out.getContext('2d');
    octx.drawImage(pag, 0, 0, w, faixa, 0, 0, w, faixa); // topo primeiro (o Worker usa a 1ª data como vencimento)
    octx.drawImage(pag, 0, pag.height - faixa, w, faixa, 0, faixa, w, faixa);
    for (const qualidade of [85, 60, 40]) { // @napi-rs/canvas: qualidade JPEG é 0-100
      const buf = await out.encode('jpeg', qualidade);
      if (buf.byteLength <= LIMITE_BYTES_WORKER) return buf;
    }
    return null;
  } finally {
    try { pagina?.cleanup(); } catch { /* noop */ }
    try { await doc.destroy(); } catch { /* noop */ }
  }
}

// Página 1 e, se ainda faltar o Código, a página 2 (a 1ª às vezes é propaganda). Junta o que cada uma leu.
// Até 2 tentativas por página só para falha de rede/5xx do Worker.
async function lerPorWorkerRecortes(bytes) {
  let acumulado = null;
  for (let p = 1; p <= 2; p++) {
    let lido = null;
    for (let t = 0; t < 2 && lido === null; t++) {
      const jpeg = await recorteCabecalhoJpeg(bytes, p);
      if (!jpeg) break;
      lido = await chamarWorker(jpeg).catch(() => null);
      if (lido === null && t === 0) await new Promise((r) => setTimeout(r, 2000));
    }
    if (lido) acumulado = { ...lido, ...Object.fromEntries(Object.entries(acumulado ?? {}).filter(([, v]) => v)) };
    if (acumulado?.codigo) break;
  }
  return acumulado;
}

async function lerPix(bytes) {
  const arquivo = path.join(os.tmpdir(), `ennychat-${crypto.randomUUID()}.pdf`);
  await fs.writeFile(arquivo, bytes);
  try {
    const r = await extrairPixDeArquivoNoServidor(arquivo, { completo: true });
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
    let campos = { codigo: null, nome: null, vencimento: null, pixCopiaColaTexto: null, linhaDigitavel: null };
    // Diagnóstico SEM dado pessoal (só flags e mensagem curta de erro técnico), devolvido ao site.
    const diag = { texto: 'ok', worker: 'pulado', pix_qr: false };
    try {
      campos = await executarSequencial(() => lerTexto(bytes));
      diag.texto = campos.semTexto ? 'sem_texto' : `ok:${['codigo', 'nome', 'vencimento'].filter((k) => campos[k]).join('+') || 'nada'}`;
    } catch (err) {
      diag.texto = `erro:${String(err.message).slice(0, 60)}`;
      logLimitado('ennychat-texto', 'warn', '[ennychat] leitura de texto do PDF falhou:', err.message);
    }
    // Worker só quando o texto não deu os 3 campos (PDF imagem ou layout fora do padrão).
    if (!campos.codigo || !campos.nome || !campos.vencimento) {
      try {
        const w = await executarSequencial(() => lerPorWorkerRecortes(bytes));
        diag.worker = w ? `ok:${['codigo', 'nome', 'vencimento'].filter((k) => w[k]).join('+') || 'nada'}` : 'sem_imagem';
        if (w) {
          campos = {
            ...campos,
            codigo: campos.codigo ?? w.codigo ?? null,
            nome: campos.nome ?? w.nome ?? null,
            vencimento: campos.vencimento ?? w.vencimento ?? null,
            pixCopiaColaTexto: campos.pixCopiaColaTexto ?? w.pixCopiaCola ?? null,
            linhaDigitavel: campos.linhaDigitavel ?? w.linhaDigitavel ?? null,
          };
        }
      } catch (err) {
        diag.worker = `erro:${String(err.message).slice(0, 60)}`;
        logLimitado('ennychat-worker', 'warn', '[ennychat] Worker de OCR falhou:', err.message);
      }
    }
    let pix = null;
    try {
      pix = await lerPix(bytes);
    } catch (err) {
      logLimitado('ennychat-pix', 'warn', '[ennychat] leitura do QR Pix falhou:', err.message);
    }
    diag.pix_qr = isValidPixPayload(pix);
    if (!isValidPixPayload(pix)) pix = isValidPixPayload(campos.pixCopiaColaTexto) ? campos.pixCopiaColaTexto : null;
    return { codigo: campos.codigo ?? null, nome: campos.nome ?? null, vencimento: campos.vencimento ?? null, linhaDigitavel: campos.linhaDigitavel ?? null, pix, diag };
  }
}
