import { Router } from 'express';
import multer from 'multer';
import { supabase, BUCKET, urlProxyArquivo } from '../lib/supabase.js';
import { casarClientePorArquivo } from '../lib/nomeMatch.js';
import { propagarDadosFatura } from '../lib/faturaPropagacao.js';
import { criarPendencia } from '../lib/faturasPendentes.js';
import { nomeArquivoSeguro } from '../lib/nomeArquivoSeguro.js';
import { comTratamentoDeErroUpload } from '../lib/uploadComTratamentoDeErro.js';

// ---------------------------------------------------------------------------
// "Upload de faturas avulsas, sem depender de planilha" -- pra quando o
// operador só tem os PDFs soltos (sem xlsx/csv linkando nome+telefone+
// arquivo) e quer subir 1 ou vários de uma vez, deixando o sistema casar
// cada um com o cliente certo pelo nome do arquivo. Complementa a
// importação em massa (planilha+zip) e o extrator de Pix -- não substitui
// nenhum dos dois.
//
// Igual ao resto do sistema, o PDF já chega aqui com o Pix/valor/vencimento
// (se houver) já extraídos no NAVEGADOR (ver frontend/src/lib/
// pixWorkerClient.ts) -- este endpoint só guarda o arquivo e decide se
// associa na hora ou deixa pendente (ver lib/faturasPendentes.js).
// ---------------------------------------------------------------------------
const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Envie um arquivo PDF'));
    cb(null, true);
  },
});

const uploadPdfComTratamentoDeErro = comTratamentoDeErroUpload(upload.single('pdf'), { limiteMb: 20, logPrefixo: '[faturas-avulsas]' });

// POST /api/faturas/avulsas -- 1 PDF por requisição (o front chama uma vez
// por arquivo, igual ao restante dos fluxos de upload deste projeto).
// Body (multipart): pdf (arquivo), pixCode?/valor?/vencimento?/linhaDigitavel?
router.post('/avulsas', uploadPdfComTratamentoDeErro, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'arquivo pdf não enviado' });
  const usuarioId = req.user.id;
  const nomeOriginal = req.file.originalname;
  const { pixCode, valor, vencimento, linhaDigitavel } = req.body || {};

  try {
    // Casa pelo nome do arquivo contra os clientes JÁ cadastrados do
    // usuário -- mesmo critério usado em todo o resto do sistema.
    const { data: clientes, error: clientesError } = await supabase
      .from('clientes')
      .select('id, nome')
      .eq('usuario_id', usuarioId);
    if (clientesError) return res.status(500).json({ error: clientesError.message });

    const clienteCasado = casarClientePorArquivo(nomeOriginal, clientes || []);

    if (clienteCasado) {
      const caminho = `${clienteCasado.id}/${Date.now()}-${nomeArquivoSeguro(nomeOriginal)}`;
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(caminho, req.file.buffer, { contentType: 'application/pdf', upsert: true });
      if (uploadError) return res.status(500).json({ error: uploadError.message });

      const { error: updateError } = await propagarDadosFatura(clienteCasado.id, usuarioId, {
        pdf_path: caminho,
        pix_code: pixCode || null,
        ...(valor ? { valor } : {}),
        ...(vencimento ? { vencimento } : {}),
        ...(linhaDigitavel ? { linha_digitavel: linhaDigitavel } : {}),
        pdf_atualizado_em: new Date().toISOString(),
      });
      if (updateError) return res.status(500).json({ error: updateError.message });

      return res.status(200).json({
        associado: true,
        arquivo: nomeOriginal,
        cliente_id: clienteCasado.id,
        cliente_nome: clienteCasado.nome,
      });
    }

    // Nenhum cliente casou ainda -- guarda o PDF numa pasta própria
    // ("pendentes/<usuario>/...", fora da pasta de qualquer cliente) e
    // registra a pendência. Assim que um cliente com nome compatível for
    // criado (cadastro manual, lista colada, importação em lote), a
    // associação é feita sozinha (ver lib/faturasPendentes.js).
    const caminhoPendente = `pendentes/${usuarioId}/${Date.now()}-${nomeArquivoSeguro(nomeOriginal)}`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(caminhoPendente, req.file.buffer, { contentType: 'application/pdf', upsert: true });
    if (uploadError) return res.status(500).json({ error: uploadError.message });

    const pendencia = await criarPendencia({
      usuarioId,
      arquivo: nomeOriginal,
      pdfPath: caminhoPendente,
      pixCode,
      valor,
      vencimento,
      linhaDigitavel,
    });

    res.status(202).json({ associado: false, arquivo: nomeOriginal, pendencia_id: pendencia.id });
  } catch (err) {
    console.error('[faturas-avulsas] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Lista as pendências do usuário -- pra revisão manual (vincular a um
// cliente existente na mão, quando o casamento automático nunca vier a
// acontecer, ex: nome do arquivo não bate com nada de propósito).
router.get('/avulsas/pendentes', async (req, res) => {
  const { data, error } = await supabase
    .from('faturas_pendentes')
    .select('*')
    .eq('usuario_id', req.user.id)
    .order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  res.json(
    (data || []).map((p) => ({
      id: p.id,
      arquivo: p.arquivo,
      pdf_url: urlProxyArquivo('faturas', p.pdf_path),
      pix_code: p.pix_code,
      valor: p.valor,
      vencimento: p.vencimento,
      criado_em: p.criado_em,
    })),
  );
});

// Vínculo manual: usado quando o casamento automático (por nome de arquivo)
// não achou ninguém e o operador quer apontar manualmente pra um cliente.
router.post('/avulsas/pendentes/:id/associar', async (req, res) => {
  const { id } = req.params;
  const usuarioId = req.user.id;
  const { cliente_id } = req.body || {};
  if (!cliente_id) return res.status(400).json({ error: 'cliente_id é obrigatório' });

  const { data: pendencia, error } = await supabase
    .from('faturas_pendentes')
    .select('*')
    .eq('id', id)
    .eq('usuario_id', usuarioId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!pendencia) return res.status(404).json({ error: 'Pendência não encontrada' });

  const { data: donoCliente } = await supabase.from('clientes').select('id').eq('id', cliente_id).eq('usuario_id', usuarioId).maybeSingle();
  if (!donoCliente) return res.status(404).json({ error: 'Cliente não encontrado' });

  const novoCaminho = `${cliente_id}/${Date.now()}-${nomeArquivoSeguro(pendencia.arquivo)}`;
  const { error: moveError } = await supabase.storage.from(BUCKET).move(pendencia.pdf_path, novoCaminho);
  if (moveError) return res.status(500).json({ error: moveError.message });

  const { error: updateError } = await propagarDadosFatura(cliente_id, usuarioId, {
    pdf_path: novoCaminho,
    pix_code: pendencia.pix_code,
    ...(pendencia.valor ? { valor: pendencia.valor } : {}),
    ...(pendencia.vencimento ? { vencimento: pendencia.vencimento } : {}),
    ...(pendencia.linha_digitavel ? { linha_digitavel: pendencia.linha_digitavel } : {}),
    pdf_atualizado_em: new Date().toISOString(),
  });
  if (updateError) return res.status(500).json({ error: updateError.message });

  await supabase.from('faturas_pendentes').delete().eq('id', id);
  res.json({ ok: true });
});

// Descarta uma pendência (o operador decidiu que esse PDF não serve/foi
// enviado por engano) -- remove do Storage e da tabela.
router.delete('/avulsas/pendentes/:id', async (req, res) => {
  const { id } = req.params;
  const usuarioId = req.user.id;

  const { data: pendencia } = await supabase
    .from('faturas_pendentes')
    .select('pdf_path')
    .eq('id', id)
    .eq('usuario_id', usuarioId)
    .maybeSingle();
  if (!pendencia) return res.status(404).json({ error: 'Pendência não encontrada' });

  await supabase.storage.from(BUCKET).remove([pendencia.pdf_path]);
  await supabase.from('faturas_pendentes').delete().eq('id', id).eq('usuario_id', usuarioId);
  res.json({ ok: true });
});

export default router;
