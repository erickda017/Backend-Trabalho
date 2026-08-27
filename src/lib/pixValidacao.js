// [2026-08] Validação completa do payload Pix (EMV/BR Code), espelhando a
// mesma lógica já usada no navegador (ver frontend/src/lib/pixExtractor.ts).
// Extraída pra um lib próprio porque agora existem DOIS lugares no backend
// que precisam validar um código Pix antes de persistir:
//   1) boletos.routes.js (POST /salvar-pix) -- já existia, fazia uma checagem
//      mais simples (só prefixo + domínio do BCB, sem CRC).
//   2) services/extratorServidorPix.js (novo -- extração no servidor, ver
//      CONTEXTO.md) -- precisa da MESMA validação, senão aceitaria QR lido
//      errado (jsQR decodifica "algo", não garante que é um Pix válido).
// Ter os dois checando CRC (não só prefixo/domínio) evita gravar lixo no
// banco quando o QR lido por engano é de outro tipo (ex: QR de propaganda
// perto do Pix no boleto, ver comentário extenso em pixExtractor.ts).

export function crc16ccitt(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function isValidPixPayload(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const payload = raw.trim();

  if (!payload.startsWith('000201')) return false;
  if (!payload.includes('br.gov.bcb.pix')) return false;

  const crcMatch = payload.match(/6304([0-9A-Fa-f]{4})$/);
  if (!crcMatch) return false;

  const providedCrc = crcMatch[1].toUpperCase();
  const payloadForCrc = payload.slice(0, payload.length - 4);
  return providedCrc === crc16ccitt(payloadForCrc);
}
