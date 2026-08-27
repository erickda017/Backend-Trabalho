import { Router } from 'express';
import { persistirExtracaoPix } from '../lib/pixPersistencia.js';

// [2026-08] Rota nova do fluxo "boleto avulso": o PDF inteiro NUNCA chega aqui.
// O navegador fatia o PDF (pdf-lib), manda cada página pro Cloudflare Worker
// (https://processo-de-pdf.erickramiro2010.workers.dev), que faz OCR + valida
// o Pix via Regex -- ver frontend/src/lib/pixWorkerClient.ts. Este endpoint só
// recebe o JSON já pronto ({ pixCopiaCola, valor, vencimento, linhaDigitavel })
// e persiste. Sem multer, sem parsing de multipart, sem libs pesadas de
// PDF/imagem -- por isso não há risco de estourar os 512MB do Render aqui.
const router = Router();

// EMV/BR Code do Pix: sempre começa com o payload fixo "000201" e contém o
// domínio do Banco Central. Revalidamos no servidor mesmo já validado pelo
// Worker -- não confiamos cegamente em payload vindo do cliente.
function pixCopiaColaValido(valor) {
  return typeof valor === 'string' && valor.startsWith('000201') && valor.includes('br.gov.bcb.pix');
}

// [2026-08] resolverCliente()/serializar() foram extraídas pra
// lib/pixPersistencia.js (persistirExtracaoPix) -- reaproveitadas também
// pela extração no servidor (POST /api/pix/extrair-servidor, ver
// routes/pix.routes.js e CONTEXTO.md). Mesmo critério de sempre: 1) clienteId
// explícito, 2) fallback pelo nome do arquivo. Sempre escopado por
// usuarioId -- nunca casa/edita um cliente que não seja do operador
// autenticado.

// POST /api/boletos/salvar-pix
// Body: { pixCopiaCola, valor?, vencimento?, linhaDigitavel?, arquivo?, clienteId? }
router.post('/salvar-pix', async (req, res) => {
  const usuarioId = req.user.id;
  const { pixCopiaCola, valor, vencimento, linhaDigitavel, arquivo, clienteId } = req.body || {};

  if (!pixCopiaColaValido(pixCopiaCola)) {
    return res.status(400).json({ error: 'pixCopiaCola ausente ou inválido (não parece um código Pix EMV válido)' });
  }

  try {
    const resultado = await persistirExtracaoPix({
      usuarioId,
      arquivo,
      pixCopiaCola,
      valor,
      vencimento,
      linhaDigitavel,
      clienteId,
      origem: 'navegador',
    });
    res.status(201).json(resultado);
  } catch (err) {
    console.error('[boletos] erro em /salvar-pix:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
