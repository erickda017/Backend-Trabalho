import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { escaparFiltroPostgrest } from '../lib/filtros.js';
import { propagarDadosFatura } from '../lib/faturaPropagacao.js';

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

// Tenta casar o boleto com um cliente já cadastrado: 1) clienteId explícito
// (quando o usuário já vinculou na tela), 2) por fallback, pelo nome do
// arquivo -- mesmo critério usado no resto do sistema (ver pix.routes.js).
// [2026-08] MULTI-TENANT: sempre escopado por usuarioId -- nunca casa/edita
// um cliente que não seja do operador autenticado.
async function resolverCliente({ clienteId, arquivo, usuarioId }) {
  if (clienteId) {
    const { data } = await supabase.from('clientes').select('id').eq('id', clienteId).eq('usuario_id', usuarioId).maybeSingle();
    if (data?.id) return data.id;
  }
  if (arquivo) {
    const nomeBase = String(arquivo).replace(/\.pdf$/i, '').trim();
    if (nomeBase) {
      const { data } = await supabase
        .from('clientes')
        .select('id')
        .eq('usuario_id', usuarioId)
        .ilike('nome', `%${escaparFiltroPostgrest(nomeBase)}%`)
        .limit(1)
        .maybeSingle();
      if (data?.id) return data.id;
    }
  }
  return null;
}

function serializar(linha) {
  return {
    id: linha.id,
    arquivo: linha.arquivo,
    cliente_id: linha.cliente_id,
    cliente_nome: linha.clientes?.nome || null,
    status: linha.status,
    pix_code: linha.pix_code,
    valor: linha.valor,
    vencimento: linha.vencimento,
    linha_digitavel: linha.linha_digitavel,
    erro: linha.erro,
    criado_em: linha.criado_em,
  };
}

// POST /api/boletos/salvar-pix
// Body: { pixCopiaCola, valor?, vencimento?, linhaDigitavel?, arquivo?, clienteId? }
router.post('/salvar-pix', async (req, res) => {
  const usuarioId = req.user.id;
  const { pixCopiaCola, valor, vencimento, linhaDigitavel, arquivo, clienteId } = req.body || {};

  if (!pixCopiaColaValido(pixCopiaCola)) {
    return res.status(400).json({ error: 'pixCopiaCola ausente ou inválido (não parece um código Pix EMV válido)' });
  }

  try {
    const nomeArquivo = typeof arquivo === 'string' && arquivo.trim() ? arquivo.trim() : 'boleto.pdf';
    const clienteResolvido = await resolverCliente({ clienteId, arquivo: nomeArquivo, usuarioId });

    // Guarda o histórico da extração (auditoria/listagem em /pix) -- mesma
    // tabela usada pelo restante do extrator de Pix.
    const { data: extracao, error: insertError } = await supabase
      .from('pix_extracoes')
      .insert({
        usuario_id: usuarioId,
        arquivo: nomeArquivo,
        cliente_id: clienteResolvido,
        status: 'encontrado',
        pix_code: pixCopiaCola,
        valor: valor ?? null,
        vencimento: vencimento ?? null,
        linha_digitavel: linhaDigitavel ?? null,
      })
      .select('*, clientes(nome)')
      .single();

    if (insertError) return res.status(500).json({ error: insertError.message });

    // Se já achamos (ou o front já sabia) o cliente, grava a chave Pix + os
    // dados do boleto direto nele também -- é o que os disparos usam de
    // fato. Propaga pra outros números vinculados do mesmo cliente, se
    // houver (ver lib/faturaPropagacao.js).
    if (clienteResolvido) {
      const { error: updateError } = await propagarDadosFatura(clienteResolvido, usuarioId, {
        pix_code: pixCopiaCola,
        ...(valor ? { valor } : {}),
        ...(vencimento ? { vencimento } : {}),
        ...(linhaDigitavel ? { linha_digitavel: linhaDigitavel } : {}),
      });
      if (updateError) console.error('[boletos] falha ao atualizar cliente com o Pix:', updateError.message);
    }

    res.status(201).json(serializar(extracao));
  } catch (err) {
    console.error('[boletos] erro em /salvar-pix:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
