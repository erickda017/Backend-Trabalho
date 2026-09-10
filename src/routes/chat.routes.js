import { Router } from 'express';
import multer from 'multer';
import { supabase, BUCKET, CHAT_BUCKET, gerarSignedUrl, urlsProxyArquivo } from '../lib/supabase.js';
import { enviarMensagemTexto, enviarMensagemComAnexo, validarNumero } from '../services/whatsapp.js';
import { registrarMensagemSaida } from '../services/chatIngest.js';
import { registrarAuditoriaExclusao } from '../lib/auditoria.js';
import { achatarTags } from '../lib/achatarTags.js';
import { nomeArquivoSeguro } from '../lib/nomeArquivoSeguro.js';
import { comTratamentoDeErroUpload } from '../lib/uploadComTratamentoDeErro.js';
import { limiteSensivel } from '../lib/rateLimit.js';
import { lerPaginacao } from '../lib/paginacao.js';
const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB -- mesma ordem de grandeza do WhatsApp
  // [2026-09] Sem fileFilter de tipo aqui de propósito -- diferente das
  // outras rotas de upload (só PDF), um anexo de chat pode ser
  // imagem/áudio/documento de verdade (mesma variedade que o WhatsApp
  // aceita), então restringir mimetype quebraria o uso real da função.
});
const uploadAnexoComTratamentoDeErro = comTratamentoDeErroUpload(upload.single('anexo'), { limiteMb: 30, logPrefixo: '[chat]' });

function tipoPorMimetype(mimetype) {
  if (!mimetype) return 'documento';
  if (mimetype.startsWith('image/')) return 'imagem';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'documento';
}

// [2026-08] SEGURANÇA: buckets "faturas" e "chat-midia" agora são privados.
// pdf_url/anexo_url não são mais persistidas -- sempre recalculadas a
// partir de pdf_path/anexo_path.
//
// [2026-08] Duas categorias diferentes de URL aqui, não confundir:
//   - Pra EXIBIR no navegador (`/conversas`, `/conversas/:id/mensagens`
//     abaixo): usa `urlsProxyArquivo`, um path relativo ao proxy deste
//     backend (ver routes/arquivos.routes.js) -- esconde o domínio do
//     Supabase da barra de endereço quando o front abre o anexo/PDF.
//   - Pra o BAILEYS BAIXAR e mandar pro WhatsApp (envio de mensagem com
//     anexo, envio de fatura -- mais abaixo neste arquivo): continua
//     `gerarSignedUrl`, uma signed URL de verdade do Supabase. Essas nunca
//     chegam a virar link clicável no navegador do operador -- é o
//     servidor (Baileys) que busca o arquivo via HTTP pra anexar na
//     mensagem, então não faz sentido (nem funcionaria sem dar mais uma
//     volta desnecessária pelo proxy) usar o path do proxy aqui.
// [2026-08] MULTI-TENANT: toda rota abaixo é escopada por req.user.id --
// conversas/mensagens/envio de WhatsApp sempre do operador autenticado.

// Lista conversas, mais recente primeiro
// [2026-09] PAGINADO (mesmo padrão de GET /clientes, ver clientes.routes.js) --
// antes vinha tudo numa query só, sem `.range()`; o PostgREST corta em 1000
// linhas por padrão sem avisar, então uma carteira de chat com mais de 1000
// conversas (plausível depois de meses de uso) perderia as mais antigas da
// lista em silêncio. Devolve `{ itens, total }`; ver lib/clientesPaginados.ts
// no front pro helper que pagina até trazer tudo usando esse total.
router.get('/conversas', async (req, res) => {
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });
  // [2026-09] ATIVAÇÃO CHIP: campanha separa as duas carteiras de chat (ver
  // migration-25-ativacao-chip.sql) -- sem filtro explícito, sempre
  // 'cobranca' (comportamento de sempre). A tela de Ativação Chip passa
  // ?campanha=chip_ativacao.
  const campanha = req.query.campanha === 'chip_ativacao' ? 'chip_ativacao' : 'cobranca';

  // [2026-08] QUALIDADE/CHAT: cliente_tags(tags(...)) junto pra mostrar a tag
  // do cliente no card da lista e no cabeçalho da conversa aberta -- mesmo
  // formato achatado (achatarTags) usado em clientes/qualidade/supervisor.
  const { data, error, count } = await supabase
    .from('conversas')
    .select('*, clientes(nome, pdf_path, pix_code, cliente_tags(tags(id, nome, cor)))', { count: 'exact' })
    .eq('usuario_id', req.user.id)
    .eq('campanha', campanha)
    .order('ultima_mensagem_em', { ascending: false, nullsFirst: false })
    .range(from, to);

  if (error) return res.status(500).json({ error: error.message });

  const conversas = data || [];
  const urls = urlsProxyArquivo('faturas', conversas.map((c) => c.clientes?.pdf_path || null));
  res.json({
    itens: conversas.map((c, i) => ({
      ...c,
      clientes: c.clientes ? { ...achatarTags(c.clientes), pdf_url: urls[i] } : null,
    })),
    total: count ?? conversas.length,
  });
});

// Histórico de mensagens de uma conversa
router.get('/conversas/:id/mensagens', async (req, res) => {
  const { id } = req.params;

  // Confirma dono da conversa antes de listar (mensagens não tem usuario_id
  // próprio -- segue a referência conversa_id -> conversas.usuario_id).
  const { data: dona } = await supabase.from('conversas').select('id').eq('id', id).eq('usuario_id', req.user.id).maybeSingle();
  if (!dona) return res.status(404).json({ error: 'conversa não encontrada' });

  const { data, error } = await supabase
    .from('mensagens')
    .select('*')
    .eq('conversa_id', id)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) return res.status(500).json({ error: error.message });

  const mensagens = data || [];
  const urls = urlsProxyArquivo('chat-midia', mensagens.map((m) => m.anexo_path || null));
  res.json(mensagens.map((m, i) => ({ ...m, anexo_url: urls[i] })));
});

// Apaga a conversa e o histórico de mensagens dela (ex: contatos de teste, ou
// conversas fantasma criadas por um "@lid" não resolvido -- ver fix em chatIngest.js).
// mensagens some junto por causa do "on delete cascade" no schema.
// [2026-08] SEGURANÇA: auditoria da exclusão (LGPD) -- ver clientes.routes.js
// pro mesmo padrão. [2026-08] MULTI-TENANT: só apaga se a conversa for do
// usuário logado.
router.delete('/conversas/:id', async (req, res) => {
  const { id } = req.params;

  const { data: conversa } = await supabase
    .from('conversas')
    .select('telefone, nome_contato')
    .eq('id', id)
    .eq('usuario_id', req.user.id)
    .maybeSingle();

  if (!conversa) return res.status(404).json({ error: 'conversa não encontrada' });

  const { error } = await supabase.from('conversas').delete().eq('id', id).eq('usuario_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });

  await registrarAuditoriaExclusao({
    entidade: 'conversa',
    entidadeId: id,
    usuario: req.user,
    detalhes: { telefone: conversa.telefone, nome_contato: conversa.nome_contato },
  });

  res.json({ ok: true });
});

// Marca conversa como lida (zera o contador de não lidas)
router.post('/conversas/:id/marcar-lida', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('conversas')
    .update({ nao_lidas: 0 })
    .eq('id', id)
    .eq('usuario_id', req.user.id)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'conversa não encontrada' });
  res.json(data);
});

// [bug] Vincula manualmente uma conversa a um cliente cadastrado. Existe
// porque a identificação automática (telefone/variantes com e sem 9º dígito,
// resolução de @lid -- ver services/chatIngest.js) pode legitimamente falhar
// (número que nunca bateu com nenhum cliente, ou @lid nunca resolvido), e
// antes disso não tinha NENHUM jeito de corrigir pela tela -- o contato ficava
// pra sempre mostrando só telefone/nome do WhatsApp, sem poder enviar fatura
// nem aparecer corretamente em métricas por cliente. `cliente_id: null` no
// corpo desvincula (volta a mostrar nome_contato/telefone).
router.post('/conversas/:id/vincular-cliente', async (req, res) => {
  const { id } = req.params;
  const { cliente_id: clienteId } = req.body || {};
  const usuarioId = req.user.id;

  const { data: conversa } = await supabase.from('conversas').select('id').eq('id', id).eq('usuario_id', usuarioId).maybeSingle();
  if (!conversa) return res.status(404).json({ error: 'conversa não encontrada' });

  if (clienteId) {
    const { data: cliente } = await supabase.from('clientes').select('id').eq('id', clienteId).eq('usuario_id', usuarioId).maybeSingle();
    if (!cliente) return res.status(404).json({ error: 'cliente não encontrado' });
  }

  const { data, error } = await supabase
    .from('conversas')
    .update({ cliente_id: clienteId || null })
    .eq('id', id)
    .eq('usuario_id', usuarioId)
    .select('*, clientes(nome, pdf_path, pix_code, cliente_tags(tags(id, nome, cor)))')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  const urls = urlsProxyArquivo('faturas', [data?.clientes?.pdf_path || null]);
  res.json({ ...data, clientes: data?.clientes ? { ...achatarTags(data.clientes), pdf_url: urls[0] } : null });
});

// Envia uma resposta pro cliente (texto e/ou anexo) e grava no histórico do chat
router.post('/conversas/:id/mensagens', limiteSensivel, uploadAnexoComTratamentoDeErro, async (req, res) => {
  const { id } = req.params;
  const usuarioId = req.user.id;
  const mensagem = (req.body?.mensagem || '').trim();

  if (!mensagem && !req.file) {
    return res.status(400).json({ error: 'envie uma mensagem ou um anexo' });
  }

  const { data: conversa, error: conversaError } = await supabase
    .from('conversas')
    .select('telefone, numero_nao_confirmado, campanha')
    .eq('id', id)
    .eq('usuario_id', usuarioId)
    .maybeSingle();

  if (conversaError) return res.status(500).json({ error: conversaError.message });
  if (!conversa) return res.status(404).json({ error: 'conversa não encontrada' });
  // O WhatsApp ainda não revelou o número real desse contato (protegido por @lid) --
  // não dá pra mandar mensagem sem o telefone de verdade. Espera o contato mandar
  // outra mensagem (às vezes o número aparece depois) ou vincule manualmente um
  // cliente cadastrado a essa conversa.
  if (conversa.numero_nao_confirmado) {
    return res.status(400).json({ error: 'Ainda não temos o número real deste contato (o WhatsApp está ocultando-o). Aguarde uma nova mensagem dele ou vincule um cliente cadastrado.' });
  }

  try {
    let anexoUrl = null;
    let anexoNome = null;
    let tipo = 'texto';

    let anexoPath = null;
    if (req.file) {
      tipo = tipoPorMimetype(req.file.mimetype);
      // [2026-08] SEGURANÇA/MULTI-TENANT: prefixado com usuarioId -- sem isso,
      // dois operadores com um cliente de mesmo telefone escreveriam no MESMO
      // object key do bucket chat-midia (upsert:true sobrescreve em silêncio),
      // vazando/substituindo anexo de um na conversa do outro.
      // [2026-09] originalname sanitizado antes de virar object key -- antes
      // ia cru, diferente das outras rotas de upload do sistema (risco real
      // de path traversal via nome de arquivo controlado por quem envia).
      const caminho = `${usuarioId}/${conversa.telefone}/${Date.now()}-${nomeArquivoSeguro(req.file.originalname, 'anexo')}`;

      const { error: uploadError } = await supabase.storage
        .from(CHAT_BUCKET)
        .upload(caminho, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
      if (uploadError) throw uploadError;

      // Bucket privado: gera uma signed URL só pra ESTE envio (o Baileys
      // precisa buscar o arquivo agora, na hora de mandar pro WhatsApp).
      // anexoPath é o que persiste no banco; anexoUrl é descartável.
      anexoPath = caminho;
      anexoUrl = await gerarSignedUrl(CHAT_BUCKET, caminho);
      anexoNome = req.file.originalname;
    }

    // Confirma o JID real antes de mandar -- mesma regra do disparo em massa
    // (dispatchQueue.js). Sem isso o Baileys aceita o envio sem erro mas manda
    // pra um número "adivinhado" que pode não bater com o dispositivo real.
    const { existe, jid } = await validarNumero(conversa.telefone, usuarioId);
    if (!existe) {
      return res.status(400).json({ error: 'Este número não foi encontrado no WhatsApp' });
    }

    const { messageId } = anexoUrl
      ? await enviarMensagemComAnexo({
          numero: conversa.telefone,
          jid,
          mensagem,
          anexoUrl,
          anexoNome,
          anexoTipo: tipo,
          anexoMimetype: req.file.mimetype,
          usuarioId,
        })
      : await enviarMensagemTexto({ numero: conversa.telefone, jid, mensagem, usuarioId });

    // Grava anexo_path (fonte da verdade, bucket privado) -- não persiste a
    // signed URL usada só pra este envio, ela já expira sozinha.
    const { mensagem: linhaSalva } = await registrarMensagemSaida({
      telefone: conversa.telefone,
      texto: mensagem || null,
      tipo,
      anexoPath,
      anexoNome,
      messageId,
      usuarioId,
      campanha: conversa.campanha,
    });

    // A resposta pro front (que renderiza a mensagem na hora, sem F5) precisa
    // de uma URL utilizável -- mas não a signed URL crua que acabamos de
    // gerar pro Baileys (isso exporia o domínio do Supabase se o front abrir
    // o anexo em nova aba). Convertemos pro path do proxy aqui, igual ao
    // resto das rotas de listagem deste arquivo.
    const anexoUrlProxy = anexoPath ? urlsProxyArquivo('chat-midia', [anexoPath])[0] : null;
    res.status(201).json({ ...linhaSalva, anexo_url: anexoUrlProxy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manda a fatura (PDF) do cliente vinculado a essa conversa, e junto o código Pix
// já extraído do QR do PDF (se tiver) como mensagem de texto separada -- assim o
// cliente recebe o boleto E o "copia e cola" pronto, sem precisar escanear nada.
// modo: "pdf" | "pix" | "pdf_pix" (default "pdf_pix" -- manda os dois)
router.post('/conversas/:id/enviar-fatura', async (req, res) => {
  const { id } = req.params;
  const usuarioId = req.user.id;
  const modo = req.body?.modo === 'pdf' || req.body?.modo === 'pix' ? req.body.modo : 'pdf_pix';

  const { data: conversa, error: conversaError } = await supabase
    .from('conversas')
    .select('telefone, cliente_id, campanha, clientes(nome, pdf_path, pix_code)')
    .eq('id', id)
    .eq('usuario_id', usuarioId)
    .maybeSingle();

  if (conversaError) return res.status(500).json({ error: conversaError.message });
  if (!conversa) return res.status(404).json({ error: 'conversa não encontrada' });

  const cliente = conversa.clientes;
  if (!conversa.cliente_id || !cliente) {
    return res.status(400).json({ error: 'Este contato não está vinculado a um cliente cadastrado' });
  }
  if (modo === 'pdf' && !cliente.pdf_path) {
    return res.status(400).json({ error: 'Este cliente não tem fatura (PDF) cadastrada' });
  }
  if (modo === 'pix' && !cliente.pix_code) {
    return res.status(400).json({ error: 'Não encontramos um código Pix nesta fatura' });
  }
  if (modo === 'pdf_pix' && !cliente.pdf_path && !cliente.pix_code) {
    return res.status(400).json({ error: 'Este cliente não tem fatura nem código Pix cadastrados' });
  }

  try {
    const { existe, jid } = await validarNumero(conversa.telefone, usuarioId);
    if (!existe) return res.status(400).json({ error: 'Este número não foi encontrado no WhatsApp' });

    const nomeArquivo = `fatura-${cliente.nome || 'cliente'}.pdf`;

    let linhaFatura = null;
    if ((modo === 'pdf' || modo === 'pdf_pix') && cliente.pdf_path) {
      // Bucket privado: assina uma URL só pro Baileys baixar AGORA. Não
      // reaproveita nem persiste -- cada envio gera a sua.
      const pdfUrlAssinada = await gerarSignedUrl(BUCKET, cliente.pdf_path);
      if (!pdfUrlAssinada) throw new Error('Não foi possível gerar o link do PDF (arquivo pode ter sido removido do Storage).');

      const { messageId } = await enviarMensagemComAnexo({
        numero: conversa.telefone,
        jid,
        anexoUrl: pdfUrlAssinada,
        anexoNome: nomeArquivo,
        anexoTipo: 'documento',
        anexoMimetype: 'application/pdf',
        usuarioId,
      });
      const { mensagem } = await registrarMensagemSaida({
        telefone: conversa.telefone,
        texto: null,
        tipo: 'documento',
        anexoPath: cliente.pdf_path,
        anexoNome: nomeArquivo,
        messageId,
        usuarioId,
        campanha: conversa.campanha,
      });
      // Resposta pro front usa o path do proxy (não a signed URL crua que
      // acabamos de gerar pro Baileys) -- mesmo motivo do envio de anexo
      // avulso logo acima neste arquivo: evita expor o domínio do Supabase
      // se o operador abrir o PDF direto da tela do chat.
      const anexoUrlProxy = urlsProxyArquivo('faturas', [cliente.pdf_path])[0];
      linhaFatura = mensagem ? { ...mensagem, anexo_url: anexoUrlProxy } : null;
    }

    let linhaPix = null;
    if ((modo === 'pix' || modo === 'pdf_pix') && cliente.pix_code) {
      const textoPix = `Código Pix (copia e cola):\n${cliente.pix_code}`;
      const { messageId: pixMessageId } = await enviarMensagemTexto({
        numero: conversa.telefone,
        jid,
        mensagem: textoPix,
        usuarioId,
      });
      const { mensagem } = await registrarMensagemSaida({
        telefone: conversa.telefone,
        texto: textoPix,
        tipo: 'texto',
        messageId: pixMessageId,
        usuarioId,
        campanha: conversa.campanha,
      });
      linhaPix = mensagem;
    }

    res.status(201).json({ fatura: linhaFatura, pix: linhaPix });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
