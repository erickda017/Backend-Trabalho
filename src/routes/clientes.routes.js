import { Router } from 'express';
import multer from 'multer';
import { supabase, BUCKET, gerarSignedUrl, gerarSignedUrls } from '../lib/supabase.js';
import { normalizarTelefone } from '../lib/telefone.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { escaparFiltroPostgrest } from '../lib/filtros.js';
import { parseListaClientes } from '../lib/parseListaClientes.js';
import { registrarAuditoriaExclusao } from '../lib/auditoria.js';
import { propagarDadosFatura, vincularNumero, desvincularNumero, membrosDoGrupo } from '../lib/faturaPropagacao.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB -- evita upload gigante travar a request
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Envie um arquivo PDF'));
    }
    cb(null, true);
  },
});

// Achata cliente_tags(tags(...)) pra um array simples `tags: [{id,nome,cor}]`
function achatarTags({ cliente_tags, ...c }) {
  return { ...c, tags: (cliente_tags || []).map((ct) => ct.tags).filter(Boolean) };
}

// [2026-08] SEGURANÇA: bucket "faturas" agora é privado. `pdf_url` nunca é lido
// direto do banco (a coluna é deprecated, ver comment on column no schema) --
// sempre recalculamos uma Signed URL de curta duração a partir de pdf_path na
// hora de responder. `clienteComSignedUrl`/`clientesComSignedUrls` fazem isso
// e substituem o campo `pdf_url` da resposta antes de devolver ao front (que
// continua lendo `cliente.pdf_url` normalmente, sem saber da mudança).
async function clienteComSignedUrl(cliente) {
  if (!cliente) return cliente;
  const pdf_url = await gerarSignedUrl(BUCKET, cliente.pdf_path);
  return { ...cliente, pdf_url };
}

async function clientesComSignedUrls(clientes) {
  const urls = await gerarSignedUrls(BUCKET, clientes.map((c) => c.pdf_path));
  return clientes.map((c, i) => ({ ...c, pdf_url: urls[i] }));
}

// Nome de arquivo seguro pra usar como parte da chave do Storage: mantém só
// caracteres inofensivos e nunca deixa passar "/", "\" ou "..", que
// permitiriam ao originalname (controlado por quem faz o upload) escapar da
// pasta `${id}/` pretendida e escrever em outro caminho do bucket.
function nomeArquivoSeguro(nome) {
  const base = String(nome || 'arquivo.pdf').split(/[\\/]/).pop() || 'arquivo.pdf';
  return base.replace(/\.\./g, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'arquivo.pdf';
}

// ---------------------------------------------------------------------------
// Conversor de lista crua -- recebe o texto colado (formato NOME/contrato/CPF/
// telefone(s)/Fatura/valor) e devolve as linhas já no layout da planilha modelo
// (1 linha por telefone). Só faz o parse -- não grava nada no banco ainda,
// pra dar chance de revisar antes de importar (ver POST /importar-lista).
router.post('/converter-lista', (req, res) => {
  const { texto } = req.body || {};
  if (!texto || typeof texto !== 'string' || !texto.trim()) {
    return res.status(400).json({ error: 'Cole o texto da lista de clientes no campo "texto"' });
  }

  const { itens, avisos } = parseListaClientes(texto);
  res.json({ itens, avisos, total: itens.length });
});

// Importa direto os itens já convertidos/revisados (upsert por telefone --
// mesmo comportamento do resto do sistema, não duplica cliente). Não grava
// PDF nenhum aqui -- isso continua casando depois pelo fluxo normal de
// Importar (zip + planilha), usando a coluna "arquivo" que esse conversor já
// deixa pronta no mesmo padrão (slug do nome).
// [2026-08] MULTI-TENANT: usuario_id sempre vem de req.user.id -- upsert
// escopado por (usuario_id, telefone), nunca só telefone (ver migration-13).
router.post('/importar-lista', async (req, res) => {
  const { itens } = req.body || {};
  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ error: 'Campo "itens" (array) é obrigatório' });
  }
  if (itens.length > 1000) {
    return res.status(413).json({ error: `Lote grande demais (${itens.length} linhas, limite 1000). Divida em partes menores.` });
  }

  const criados = [];
  const erros = [];

  for (const item of itens) {
    const telefoneNormalizado = normalizarTelefone(item?.numero);
    if (!item?.nome || !telefoneNormalizado) {
      erros.push({ ...item, erro: 'nome ou telefone inválido' });
      continue;
    }

    const { data, error } = await supabase
      .from('clientes')
      .upsert(
        { usuario_id: req.user.id, nome: item.nome, telefone: telefoneNormalizado, valor: item.valor ?? null },
        { onConflict: 'usuario_id,telefone' },
      )
      .select('id')
      .single();

    if (error) {
      erros.push({ ...item, erro: error.message });
      continue;
    }
    criados.push({ ...item, cliente_id: data.id });
  }

  res.status(201).json({ criados: criados.length, erros, total: itens.length });
});

// Lista clientes (paginado, com filtros busca/tag/com_pix/sem_pix)
// [2026-08] MULTI-TENANT: sempre filtrado por usuario_id -- cada operador só
// vê seus próprios clientes.
router.get('/', async (req, res) => {
  const { busca, tag, com_pix, sem_pix, com_pdf, sem_pdf } = req.query;
  const { from, to } = lerPaginacao(req.query, { perPageDefault: 1000, perPageMax: 5000 });

  let query = supabase
    .from('clientes')
    .select('*, cliente_tags(tags(id, nome, cor))', { count: 'exact' })
    .eq('usuario_id', req.user.id)
    .order('nome');

  if (busca) {
    const buscaEscapada = escaparFiltroPostgrest(busca);
    query = query.or(`nome.ilike.%${buscaEscapada}%,telefone.ilike.%${buscaEscapada}%`);
  }
  if (com_pix === 'true' || com_pix === '1') query = query.not('pix_code', 'is', null);
  if (sem_pix === 'true' || sem_pix === '1') query = query.is('pix_code', null);
  // com_pdf/sem_pdf: usado pela "rodar verificação" do Extrator de Pix, que
  // busca quem tem PDF mas ainda não tem Pix (ver routes/pix.tsx).
  if (com_pdf === 'true' || com_pdf === '1') query = query.not('pdf_path', 'is', null);
  if (sem_pdf === 'true' || sem_pdf === '1') query = query.is('pdf_path', null);

  let clienteIdsPorTag = null;
  if (tag) {
    // tags também são por usuário -- mas cliente_tags não tem usuario_id
    // próprio (segue a referência via cliente_id -> clientes.usuario_id, já
    // garantido pelo filtro acima na query principal). Aqui só filtramos
    // pelas relações da tag em si; como a query principal já restringe
    // `.eq('usuario_id', req.user.id)`, um cliente_id de outro usuário que
    // por acaso aparecesse aqui não vazaria -- o `.in('id', ...)` abaixo só
    // FILTRA, não ignora o filtro de dono já aplicado.
    const { data: relacoes, error: tagError } = await supabase.from('cliente_tags').select('cliente_id').eq('tag_id', tag);
    if (tagError) return res.status(500).json({ error: tagError.message });
    clienteIdsPorTag = (relacoes || []).map((r) => r.cliente_id);
    if (!clienteIdsPorTag.length) return res.json([]);
    query = query.in('id', clienteIdsPorTag);
  }

  const { data, error } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  const clientes = await clientesComSignedUrls((data || []).map(achatarTags));
  res.json(clientes);
});

// Busca um cliente específico
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('clientes')
    .select('*, cliente_tags(tags(id, nome, cor))')
    .eq('id', id)
    .eq('usuario_id', req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Cliente não encontrado' });
  const vinculados = await membrosDoGrupo(id, req.user.id);
  res.json({ ...(await clienteComSignedUrl(achatarTags(data))), vinculados });
});

// Cria cliente (sem PDF ainda)
router.post('/', async (req, res) => {
  const { nome, telefone, valor, vencimento } = req.body;

  if (!nome || !telefone) {
    return res.status(400).json({ error: 'nome e telefone são obrigatórios' });
  }

  // aceita "150,00" (padrão BR) além de "150.00" -- coluna no banco é numérica e rejeita vírgula
  const valorNormalizado = valor ? String(valor).trim().replace(',', '.') : null;
  const telefoneNormalizado = normalizarTelefone(telefone);
  if (!telefoneNormalizado) {
    return res.status(400).json({ error: 'telefone inválido' });
  }

  const { data, error } = await supabase
    .from('clientes')
    .insert({ usuario_id: req.user.id, nome, telefone: telefoneNormalizado, valor: valorNormalizado, vencimento })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ...data, tags: [] });
});

// Upload/associação do PDF da fatura a um cliente.
// [2026-08] O backend NÃO extrai mais o Pix do PDF (removido @napi-rs/canvas +
// jsQR + pdfjs-dist daqui). O navegador já fatia o PDF e chama o Cloudflare
// Worker de OCR ANTES de mandar o arquivo pra cá (ver
// frontend/src/lib/pixWorkerClient.ts) -- os campos pixCode/valor/vencimento/
// linhaDigitavel, se enviados no body junto do arquivo, já vêm prontos do
// Worker; esta rota só guarda o PDF no Storage e persiste o que recebeu.
router.post('/:id/pdf', upload.single('pdf'), async (req, res) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: 'arquivo pdf não enviado' });

  // Confirma que o cliente é do usuário autenticado ANTES de gravar qualquer
  // coisa no Storage -- sem isso, um id de cliente de outro usuário (mesmo
  // que difícil de adivinhar, é um UUID) permitiria sobrescrever o PDF dele.
  const { data: donoCliente } = await supabase.from('clientes').select('id').eq('id', id).eq('usuario_id', req.user.id).maybeSingle();
  if (!donoCliente) return res.status(404).json({ error: 'Cliente não encontrado' });

  const caminho = `${id}/${Date.now()}-${nomeArquivoSeguro(req.file.originalname)}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(caminho, req.file.buffer, { contentType: 'application/pdf', upsert: true });

  if (uploadError) return res.status(500).json({ error: uploadError.message });

  // Não grava mais getPublicUrl() -- o bucket é privado, uma URL "pública"
  // dele nem funcionaria. pdf_path é a fonte da verdade; a URL assinada é
  // calculada sob demanda em cada resposta (clienteComSignedUrl abaixo).
  const { pixCode, valor, vencimento, linhaDigitavel } = req.body || {};

  // [2026-08] NÚMEROS VINCULADOS: se este cliente tiver outro(s) número(s)
  // apontando pra ele (ou apontar pra outro), o PDF/pix/valor/vencimento
  // valem pro grupo inteiro, não só pra esta linha -- ver
  // lib/faturaPropagacao.js e migration-15.
  const { data, error } = await propagarDadosFatura(id, req.user.id, {
    pdf_path: caminho,
    pix_code: pixCode || null,
    ...(valor ? { valor } : {}),
    ...(vencimento ? { vencimento } : {}),
    ...(linhaDigitavel ? { linha_digitavel: linhaDigitavel } : {}),
    pdf_atualizado_em: new Date().toISOString(),
  });

  if (error) return res.status(500).json({ error: error.message });
  const clienteAtualizado = (data || []).find((c) => c.id === id) || data?.[0];
  res.json(await clienteComSignedUrl(achatarTags(clienteAtualizado)));
});

// Atualiza cliente
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, telefone, valor, vencimento } = req.body;

  // `valor` só entra no update se foi de fato enviado no body -- antes,
  // `valor ? ... : null` recaía em `null` sempre que o campo vinha
  // ausente/undefined (não só quando o usuário queria limpá-lo), então
  // qualquer PUT parcial que não reenviasse o valor (ex: editar só o nome via
  // outra tela/integração) apagava silenciosamente o valor já cadastrado do
  // cliente. Agora só grava algo em `valor` quando a chave foi enviada; para
  // limpar de propósito, o chamador ainda pode mandar `valor: ""`/`null`.
  const valorFoiEnviado = Object.prototype.hasOwnProperty.call(req.body, 'valor');
  const valorNormalizado = valor ? String(valor).trim().replace(',', '.') : null;
  const telefoneNormalizado = telefone ? normalizarTelefone(telefone) : undefined;
  if (telefone && !telefoneNormalizado) {
    return res.status(400).json({ error: 'telefone inválido' });
  }

  // nome/telefone são por linha (não propagam pro grupo); valor/vencimento
  // são dados da FATURA e propagam pros números vinculados (ver
  // lib/faturaPropagacao.js) -- gravados juntos numa mesma chamada, senão o
  // grupo ficaria com valor/vencimento divergente entre os números.
  const { error: errorProprios } = await supabase
    .from('clientes')
    .update({
      ...(nome !== undefined ? { nome } : {}),
      ...(telefoneNormalizado ? { telefone: telefoneNormalizado } : {}),
    })
    .eq('id', id)
    .eq('usuario_id', req.user.id);
  if (errorProprios) return res.status(500).json({ error: errorProprios.message });

  const { data, error } = await propagarDadosFatura(id, req.user.id, {
    ...(valorFoiEnviado ? { valor: valorNormalizado } : {}),
    ...(vencimento !== undefined ? { vencimento } : {}),
  });
  if (error) return res.status(500).json({ error: error.message });

  const { data: atualizado, error: buscaError } = await supabase
    .from('clientes')
    .select('*, cliente_tags(tags(id, nome, cor))')
    .eq('id', id)
    .eq('usuario_id', req.user.id)
    .maybeSingle();
  if (buscaError) return res.status(500).json({ error: buscaError.message });
  if (!atualizado) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(await clienteComSignedUrl(achatarTags(atualizado)));
});

// Vincula outro cliente (outro número de telefone) como o MESMO cliente --
// a partir daqui, PDF/pix/valor/vencimento gravados em qualquer um dos dois
// valem pro grupo inteiro (ver lib/faturaPropagacao.js e migration-15).
// Nome/telefone de cada linha continuam próprios, não mudam.
router.post('/:id/vincular/:outroId', async (req, res) => {
  const { id, outroId } = req.params;
  try {
    await vincularNumero(id, outroId, req.user.id);
    const { data } = await supabase
      .from('clientes')
      .select('*, cliente_tags(tags(id, nome, cor))')
      .eq('id', id)
      .eq('usuario_id', req.user.id)
      .maybeSingle();
    const vinculados = await membrosDoGrupo(id, req.user.id);
    res.json({ ...(await clienteComSignedUrl(achatarTags(data))), vinculados });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Desvincula este cliente do grupo -- volta a ser um número independente
// (não apaga nada, só para de espelhar a fatura dali pra frente).
router.delete('/:id/vincular', async (req, res) => {
  const { id } = req.params;
  try {
    await desvincularNumero(id, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Grava só o Pix (sem mexer no PDF) -- usado pela "rodar verificação" do
// Extrator de Pix, que roda o QR de novo em cima do PDF já salvo de quem
// tem PDF mas ainda não tem Pix, e só precisa persistir o código achado.
// Propaga pro grupo igual ao upload de PDF.
router.patch('/:id/pix', async (req, res) => {
  const { id } = req.params;
  const { pixCode } = req.body || {};
  if (!pixCode || typeof pixCode !== 'string') {
    return res.status(400).json({ error: 'pixCode é obrigatório' });
  }

  const { data, error } = await propagarDadosFatura(id, req.user.id, { pix_code: pixCode });
  if (error) return res.status(500).json({ error: error.message });
  const clienteAtualizado = (data || []).find((c) => c.id === id) || data?.[0];
  if (!clienteAtualizado) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(await clienteComSignedUrl(achatarTags(clienteAtualizado)));
});

// Histórico de envios de um cliente específico
router.get('/:id/historico', async (req, res) => {
  const { id } = req.params;

  // Confirma dono antes de listar histórico (envio_itens não tem usuario_id
  // próprio -- passa pela referência cliente_id -> clientes.usuario_id).
  const { data: donoCliente } = await supabase.from('clientes').select('id').eq('id', id).eq('usuario_id', req.user.id).maybeSingle();
  if (!donoCliente) return res.status(404).json({ error: 'Cliente não encontrado' });

  const { data, error } = await supabase
    .from('envio_itens')
    .select('id, status, status_entrega, erro, enviado_em, created_at, envios(template_mensagem, created_at)')
    .eq('cliente_id', id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Remove cliente (e o PDF associado no Storage, se houver).
// [2026-08] SEGURANÇA: registra em auditoria_exclusoes quem apagou, quando e
// os dados do cliente removido (nome/telefone/path do PDF) -- rastreabilidade
// exigida pra operações sobre dados pessoais (LGPD). req.user vem do
// middleware requireAuth (token Supabase Auth já validado antes de chegar
// aqui). [2026-08] MULTI-TENANT: só apaga se o cliente for do usuário logado.
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  const { data: cliente } = await supabase
    .from('clientes')
    .select('nome, telefone, pdf_path')
    .eq('id', id)
    .eq('usuario_id', req.user.id)
    .maybeSingle();

  if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

  const { error } = await supabase.from('clientes').delete().eq('id', id).eq('usuario_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });

  await registrarAuditoriaExclusao({
    entidade: 'cliente',
    entidadeId: id,
    usuario: req.user,
    detalhes: { nome: cliente.nome, telefone: cliente.telefone, pdf_path: cliente.pdf_path || null },
  });

  if (cliente.pdf_path) {
    const { error: storageError } = await supabase.storage.from(BUCKET).remove([cliente.pdf_path]);
    if (storageError) console.error('[clientes] erro ao remover pdf do storage:', storageError.message);
  }

  res.json({ ok: true });
});

export default router;
