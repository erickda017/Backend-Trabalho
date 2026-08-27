import { Router } from 'express';
import multer from 'multer';
import { supabase, BUCKET, urlProxyArquivo, urlsProxyArquivo } from '../lib/supabase.js';
import { normalizarTelefone } from '../lib/telefone.js';
import { lerPaginacao } from '../lib/paginacao.js';
import { escaparFiltroPostgrest } from '../lib/filtros.js';
import { parseListaClientes, extrairNomesDeListaCrua } from '../lib/parseListaClientes.js';
import { registrarAuditoriaExclusao } from '../lib/auditoria.js';
import { propagarDadosFatura, vincularNumero, desvincularNumero, membrosDoGrupo } from '../lib/faturaPropagacao.js';
import { casarClientePorNome, normalizarTexto } from '../lib/nomeMatch.js';
import { cancelarItensPendentesDosClientes } from '../lib/tagsEfeito.js';
import { associarPendentesAoCliente } from '../lib/faturasPendentes.js';

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
// sempre recalculamos a partir de pdf_path na hora de responder.
// `clienteComSignedUrl`/`clientesComSignedUrls` fazem isso e substituem o
// campo `pdf_url` da resposta antes de devolver ao front (que continua
// lendo `cliente.pdf_url` normalmente, sem saber da mudança).
//
// [2026-08] O valor de `pdf_url` NÃO é mais uma signed URL do Supabase --
// é um path relativo ao proxy de arquivos deste backend (ver
// `urlProxyArquivo` em lib/supabase.js e routes/arquivos.routes.js), pra
// não expor o domínio do Supabase na barra de endereço do navegador quando
// o front abre o PDF. Os nomes das funções (`*ComSignedUrl*`) ficaram
// desatualizados de propósito -- renomear tocaria em todo lugar que as
// chama só por causa do nome, sem nenhum ganho real.
async function clienteComSignedUrl(cliente) {
  if (!cliente) return cliente;
  const pdf_url = urlProxyArquivo('faturas', cliente.pdf_path);
  return { ...cliente, pdf_url };
}

async function clientesComSignedUrls(clientes) {
  const urls = urlsProxyArquivo('faturas', clientes.map((c) => c.pdf_path));
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

// Formata uma data ISO ('2026-09-24') pro padrar brasileiro de exibição
// ('24/09/2026') -- mesmo formato que a coluna `vencimento` (texto livre) já
// usa em todo o resto do sistema (mensagem interpolada, telas). Mantém
// `vencimento` alimentado mesmo pra quem entra pela lista crua, que antes
// desta feature nunca preenchia esse campo.
function formatarDataIsoParaBr(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, ano, mes, dia] = match;
  return `${dia}/${mes}/${ano}`;
}

// Importa direto os itens já convertidos/revisados (upsert por telefone --
// mesmo comportamento do resto do sistema, não duplica cliente). Não grava
// PDF nenhum aqui -- isso continua casando depois pelo fluxo normal de
// Importar (zip + planilha), usando a coluna "arquivo" que esse conversor já
// deixa pronta no mesmo padrão (slug do nome).
// [2026-08] MULTI-TENANT: usuario_id sempre vem de req.user.id -- upsert
// escopado por (usuario_id, telefone), nunca só telefone (ver migration-13).
// [2026-08] SAFRAS: além de nome/telefone/valor, agora também persiste
// tipo_fatura (FPD/SPD), data_prazo e numero_contrato quando a lista crua
// trouxer essa informação (ver lib/parseListaClientes.js e
// migration-19-safras-faturas.sql). `safra` é coluna GERADA a partir de
// data_prazo -- nunca é enviada no upsert. Também alimenta `vencimento`
// (texto de exibição/mensagem) a partir de data_prazo, que este fluxo nunca
// preenchia antes.
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
        {
          usuario_id: req.user.id,
          nome: item.nome,
          telefone: telefoneNormalizado,
          valor: item.valor ?? null,
          tipo_fatura: item.tipo_fatura ?? null,
          data_prazo: item.data_prazo ?? null,
          numero_contrato: item.numero_contrato ?? null,
          data_contrato: item.data_contrato ?? null,
          ...(item.data_prazo ? { vencimento: formatarDataIsoParaBr(item.data_prazo) } : {}),
        },
        { onConflict: 'usuario_id,telefone' },
      )
      .select('id')
      .single();

    if (error) {
      erros.push({ ...item, erro: error.message });
      continue;
    }
    criados.push({ ...item, cliente_id: data.id });
    // Mesmo comportamento do cadastro manual (POST /) -- ver comentário lá.
    await associarPendentesAoCliente(data.id, item.nome, req.user.id);
  }

  res.status(201).json({ criados: criados.length, erros, total: itens.length });
});

// Lista clientes (paginado, com filtros busca/tag/com_pix/sem_pix)
// [2026-08] MULTI-TENANT: sempre filtrado por usuario_id -- cada operador só
// vê seus próprios clientes.
// ---------------------------------------------------------------------------
// "Importar clientes PAGOS" -- mesmo espírito de /converter-lista +
// /importar-lista (colar uma lista e deixar o sistema resolver), mas ao
// invés de CRIAR clientes, aqui a lista é só de NOMES de quem já pagou, e o
// que se quer é ACHAR esses clientes entre os já cadastrados e marcar todos
// com uma tag "Pago" (criada automaticamente se ainda não existir, já como
// `permite_disparo: false` -- então quem leva essa tag sai na hora dos
// disparos pendentes/futuros, mesmo efeito de qualquer outra tag desse tipo,
// ver lib/tagsEfeito.js e routes/tags.routes.js).
//
// Aceita 1 nome por linha (cole direto de uma planilha, uma coluna só).
// Devolve quem foi encontrado (e marcado) e quem não bateu com ninguém, pra
// o operador revisar/corrigir manualmente os que sobraram.
router.post('/importar-pagos', async (req, res) => {
  const { texto } = req.body || {};
  if (!texto || typeof texto !== 'string' || !texto.trim()) {
    return res.status(400).json({ error: 'Cole a lista de nomes no campo "texto" (1 nome por linha)' });
  }
  const usuarioId = req.user.id;

  // Mesmo reconhecimento de nome usado em "converter lista crua de clientes"
  // (ver parseListaClientes.js) -- aceita tanto colar só nomes (1 por linha)
  // quanto colar o mesmo bloco cru NOME/contrato/CPF/telefone(s)/Fatura/valor
  // do relatório de cobrança, ignorando o resto e ficando só com os nomes.
  const nomes = [...new Set(extrairNomesDeListaCrua(texto))];
  if (!nomes.length) return res.status(400).json({ error: 'Nenhum nome encontrado no texto colado' });
  if (nomes.length > 2000) return res.status(400).json({ error: 'Máximo de 2000 nomes por importação' });

  const { data: clientes, error: clientesError } = await supabase
    .from('clientes')
    .select('id, nome')
    .eq('usuario_id', usuarioId);
  if (clientesError) return res.status(500).json({ error: clientesError.message });

  // Garante a tag "Pago" (cria se ainda não existir pra este usuário --
  // mesma unique constraint de (usuario_id, lower(nome)) usada em POST /tags,
  // então uma corrida rara de criar duas é tratada como "já existe, usa ela").
  let tag = null;
  const { data: tagExistente } = await supabase
    .from('tags')
    .select('*')
    .eq('usuario_id', usuarioId)
    .ilike('nome', 'Pago')
    .maybeSingle();
  if (tagExistente) {
    tag = tagExistente;
  } else {
    const { data: tagCriada, error: tagError } = await supabase
      .from('tags')
      .insert({ usuario_id: usuarioId, nome: 'Pago', cor: '#16a34a', permite_disparo: false })
      .select()
      .single();
    if (tagError && tagError.code !== '23505') return res.status(500).json({ error: tagError.message });
    tag = tagCriada || (await supabase.from('tags').select('*').eq('usuario_id', usuarioId).ilike('nome', 'Pago').maybeSingle()).data;
  }
  if (!tag) return res.status(500).json({ error: 'Não foi possível localizar/criar a tag "Pago"' });

  const encontrados = [];
  const naoEncontrados = [];
  const jaMarcadosVistos = new Set();

  for (const nomeColado of nomes) {
    const clienteCasado = casarClientePorNome(nomeColado, clientes || []);
    if (!clienteCasado || jaMarcadosVistos.has(clienteCasado.id)) {
      if (!clienteCasado) naoEncontrados.push(nomeColado);
      continue;
    }
    jaMarcadosVistos.add(clienteCasado.id);
    encontrados.push({ nome_colado: nomeColado, cliente_id: clienteCasado.id, cliente_nome: clienteCasado.nome });
  }

  if (encontrados.length) {
    const linhas = encontrados.map((e) => ({ cliente_id: e.cliente_id, tag_id: tag.id }));
    // upsert evita erro de unique (cliente_tags) se o cliente já tivesse a
    // tag "Pago" de uma importação anterior.
    const { error: upsertError } = await supabase.from('cliente_tags').upsert(linhas, { onConflict: 'cliente_id,tag_id', ignoreDuplicates: true });
    if (upsertError) return res.status(500).json({ error: upsertError.message });

    await cancelarItensPendentesDosClientes(encontrados.map((e) => e.cliente_id), usuarioId);
  }

  res.json({
    tag,
    total_colados: nomes.length,
    encontrados,
    nao_encontrados: naoEncontrados,
  });
});

router.get('/', async (req, res) => {
  const { busca, tag, com_pix, sem_pix, com_pdf, sem_pdf, recebeu_disparo, safra, tipo_fatura } = req.query;
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
  // [2026-08] SAFRAS: filtro por mês/ano de prazo ('YYYY-MM', ver
  // migration-19-safras-faturas.sql) e por tipo de fatura (FPD/SPD) -- usado
  // pela tela /safras pra listar quem compõe uma safra específica.
  if (safra) query = query.eq('safra', safra);
  if (tipo_fatura === 'FPD' || tipo_fatura === 'SPD') query = query.eq('tipo_fatura', tipo_fatura);

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

  // [2026-08] "Quantos disparos cada cliente recebeu" -- filtro
  // recebeu_disparo=true|false. Calculado a partir de envio_itens com
  // status='enviado' (mensagem efetivamente enviada, não só agendada) em
  // QUALQUER envio do usuário -- não só o mais recente, é o histórico
  // completo. Igual ao filtro por tag acima, resolvemos o conjunto de IDs
  // ANTES da query principal, pra paginação continuar correta.
  if (recebeu_disparo === 'true' || recebeu_disparo === 'false') {
    const { data: enviosDoUsuario } = await supabase.from('envios').select('id').eq('usuario_id', req.user.id);
    const envioIdsDoUsuario = (enviosDoUsuario || []).map((e) => e.id);
    let clienteIdsComDisparo = [];
    if (envioIdsDoUsuario.length) {
      const { data: itensEnviados } = await supabase
        .from('envio_itens')
        .select('cliente_id')
        .in('envio_id', envioIdsDoUsuario)
        .eq('status', 'enviado');
      clienteIdsComDisparo = [...new Set((itensEnviados || []).map((i) => i.cliente_id).filter(Boolean))];
    }
    if (recebeu_disparo === 'true') {
      if (!clienteIdsComDisparo.length) return res.json([]);
      query = query.in('id', clienteIdsComDisparo);
    } else {
      if (clienteIdsComDisparo.length) query = query.not('id', 'in', `(${clienteIdsComDisparo.join(',')})`);
    }
  }

  const { data, error } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  const clientesBase = (data || []).map(achatarTags);

  // Contagem de disparos recebidos por cliente (só da página atual, pra não
  // pesar a listagem inteira numa carteira grande) -- mostrada como badge na
  // tela de Clientes.
  const idsDaPagina = clientesBase.map((c) => c.id);
  let contagemPorCliente = {};
  if (idsDaPagina.length) {
    const { data: enviosDoUsuario } = await supabase.from('envios').select('id').eq('usuario_id', req.user.id);
    const envioIdsDoUsuario = (enviosDoUsuario || []).map((e) => e.id);
    if (envioIdsDoUsuario.length) {
      const { data: itens } = await supabase
        .from('envio_itens')
        .select('cliente_id')
        .in('envio_id', envioIdsDoUsuario)
        .in('cliente_id', idsDaPagina)
        .eq('status', 'enviado');
      contagemPorCliente = (itens || []).reduce((acc, i) => {
        acc[i.cliente_id] = (acc[i.cliente_id] || 0) + 1;
        return acc;
      }, {});
    }
  }

  const clientes = await clientesComSignedUrls(
    clientesBase.map((c) => ({ ...c, disparos_recebidos: contagemPorCliente[c.id] || 0 })),
  );
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

  // [2026-08] "Upload de faturas avulsas, sem planilha": se já existir um
  // PDF avulso esperando por um cliente com este nome (subido antes deste
  // cadastro existir), associa agora -- ver lib/faturasPendentes.js.
  // Best-effort: nunca falha a criação do cliente por causa disso.
  await associarPendentesAoCliente(data.id, data.nome, req.user.id);

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
  const { nome, telefone, valor, vencimento, tipo_fatura, data_prazo, numero_contrato, data_contrato } = req.body;

  if (tipo_fatura !== undefined && tipo_fatura !== null && tipo_fatura !== 'FPD' && tipo_fatura !== 'SPD') {
    return res.status(400).json({ error: "tipo_fatura deve ser 'FPD', 'SPD' ou null" });
  }

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
    ...(tipo_fatura !== undefined ? { tipo_fatura } : {}),
    ...(data_prazo !== undefined ? { data_prazo } : {}),
    ...(numero_contrato !== undefined ? { numero_contrato } : {}),
    ...(data_contrato !== undefined ? { data_contrato } : {}),
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
