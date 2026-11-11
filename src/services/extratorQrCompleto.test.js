// Leitura do QR Pix em PDF "escaneado" (uma imagem de baixa resolução): modo completo (integração EnnyChat) lê
// também com um QR de propaganda colado no Pix, caso em que o modo padrão não lê. PDF sintético, sem dado real.
import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc16ccitt } from '../lib/pixValidacao.js';
import { extrairPixDeArquivoNoServidor } from './extratorServidorPix.js';

const base = '00020126580014br.gov.bcb.pix0136123e4567-e89b-12d3-a456-4266141740005204000053039865802BR5909FULANO TE6009SAO PAULO62070503***6304';
const pix = base + crc16ccitt(base);
const propaganda = 'https://exemplo.com/app-da-operadora?campanha=promocao-novembro-2026-aaaaaaaaaaaaaaaa';

// matriz de módulos -> raster 1 pixel por módulo * `px`
function raster(texto, px) {
  const q = QRCode.create(texto, { errorCorrectionLevel: 'L' });
  const n = q.modules.size;
  const dim = (n + 8) * px; // quiet zone de 4 módulos
  const img = Buffer.alloc(dim * dim, 255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.modules.get(x, y)) {
    for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) img[((y + 4) * px + dy) * dim + (x + 4) * px + dx] = 0;
  }
  return { img, dim };
}

function pdfComPagina({ larg, alt, qrs, ppt }) {
  // página raster W x H (cinza); `ppt` = pixels por ponto (144dpi => 2)
  const W = Math.round(595 * ppt), H = Math.round(842 * ppt);
  const pag = Buffer.alloc(W * H, 255);
  for (const { texto, px, xPt, yPt } of qrs) {
    const { img, dim } = raster(texto, px);
    const x0 = Math.round(xPt * ppt), y0 = Math.round(yPt * ppt);
    for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) if (y0 + y < H && x0 + x < W) pag[(y0 + y) * W + x0 + x] = img[y * dim + x];
  }
  const dados = zlib.deflateSync(pag);
  const objs = [];
  const add = (b) => { objs.push(b); return objs.length; };
  add(Buffer.from('<</Type/Catalog/Pages 2 0 R>>'));
  add(Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>'));
  add(Buffer.from('<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</XObject<</Im0 5 0 R>>>>>>'));
  const cont = '595 0 0 842 0 0 cm /Im0 Do';
  add(Buffer.from(`<</Length ${cont.length}>>\nstream\n${cont}\nendstream`));
  add(Buffer.concat([Buffer.from(`<</Type/XObject/Subtype/Image/Width ${W}/Height ${H}/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode/Length ${dados.length}>>\nstream\n`), dados, Buffer.from('\nendstream')]));
  let out = Buffer.from('%PDF-1.4\n'); const off = [];
  objs.forEach((o, i) => { off.push(out.length); out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]); });
  const x = out.length;
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF`;
  return Buffer.concat([out, Buffer.from(xref)]);
}


async function ler(qrs, completo) {
  const arq = path.join(os.tmpdir(), `qrteste-${process.pid}-${Date.now()}.pdf`);
  fs.writeFileSync(arq, pdfComPagina({ ppt: 2, qrs }));
  try {
    return (await extrairPixDeArquivoNoServidor(arq, { completo }))?.pixCopiaCola ?? null;
  } finally {
    fs.rmSync(arq, { force: true });
  }
}

test('QR Pix em PDF de imagem (144dpi): modo completo lê sozinho e com QR de propaganda colado', async () => {
  assert.equal(await ler([{ texto: pix, px: 2, xPt: 430, yPt: 700 }], true), pix);
  const dois = [{ texto: propaganda, px: 2, xPt: 430, yPt: 640 }, { texto: pix, px: 2, xPt: 430, yPt: 700 }];
  assert.equal(await ler(dois, true), pix);
});
