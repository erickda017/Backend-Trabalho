// Catálogo de critérios do Painel de Exclusão (supervisor -- ver
// docs/superpowers/specs/2026-09-10-painel-exclusao-design.md e
// routes/exclusao.routes.js). Cada critério tem duas funções: `contar`
// (preview, nunca escreve nada) e `executar` (apaga de verdade). As duas
// devolvem a MESMA unidade de "quantidade" (ex.: mensagens, não conversas,
// pra `historico_mensagens`) -- o número mostrado no preview tem que bater
// com o número reportado depois de apagar.
//
// [CRÍTICO] Supervisor-wide: NENHUMA consulta aqui filtra por usuario_id de
// propósito -- é o ÚNICO lugar do sistema que enxerga/apaga a carteira de
// TODOS os operadores de uma vez, por isso a rota que usa este catálogo
// exige requireSupervisor (ver exclusao.routes.js). Nunca reaproveitar
// estas funções fora desse contexto.
import { supabase, BUCKET, CHAT_BUCKET } from './supabase.js';
import { rotuloSafra } from './safras.js';
import { armazenamento } from './armazenamento.js';
import { buscarTodos } from './buscarTodos.js';
import { contarExtracoesPix, apagarExtracoesPix } from './pixLimpeza.js';

// [CRÍTICO -- bug real corrigido 2026-10] Antes isto usava `.limit(50000)`,
// mas o PostgREST corta TODA resposta no "Max rows" do projeto (1000) e o
// `.limit()` não passa por cima -- cada "APAGAR" processava no máximo 1000
// clientes/mensagens e dizia que tinha terminado; o resto da carteira
// continuava lá (relatado: "apaguei tudo e ainda sobraram vários clientes").
// Agora toda leitura grande pagina com `buscarTodos` e todo `.in()` com muitos
// ids é fatiado em lotes (URL do PostgREST tem tamanho máximo).
const LOTE_IN = 200;

function emLotes(lista, tamanho = LOTE_IN) {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamanho) lotes.push(lista.slice(i, i + tamanho));
  return lotes;
}

async function lerTodos(montarQuery) {
  const { data, error } = await buscarTodos(montarQuery);
  if (error) throw error;
  return data || [];
}

// [CRÍTICO -- bug real corrigido 2026-09, 2 rodadas] Rodada 1: esta função só
// logava o erro e seguia a vida (mesmo "best-effort" que limpezaAutomatica.js
// usa) -- só que quem chama SEMPRE limpava pdf_path do cliente logo em
// seguida, MESMO quando a remoção do Storage falhava de verdade. Corrigido
// pra devolver QUAIS caminhos falharam, baseado em `error`.
//
// Rodada 2 (relatado: painel dizia "apagado", bucket continuava com TODOS os
// arquivos): a API do Supabase Storage pode devolver `error: null` e mesmo
// assim não remover nada -- ela não erra pra "arquivo não encontrado" nem
// pra alguns cenários de permissão, só devolve em `data` a lista do que
// FOI removido de verdade. Confiar só em `error` (rodada 1) não pega esse
// caso -- por isso agora comparamos o tamanho de `data` com o do lote
// pedido: se vier menor (ou vazio) sem erro nenhum, trata o LOTE INTEIRO
// como não confirmado (não dá pra saber com certeza QUAL item específico
// falhou só pelo tamanho da lista, e é sempre mais seguro não limpar um
// ponteiro que ainda pode estar apontando pra um arquivo real).
async function removerDoStorageEmLotes(bucket, caminhos) {
  const TAMANHO_LOTE = 100; // limite prático da API do Supabase Storage por chamada de .remove()
  const falharam = [];
  for (let i = 0; i < caminhos.length; i += TAMANHO_LOTE) {
    const lote = caminhos.slice(i, i + TAMANHO_LOTE);
    const { data, error } = await armazenamento.from(bucket).remove(lote);
    if (error) {
      console.error(`[exclusao] erro ao remover arquivos do bucket ${bucket}:`, error.message);
      falharam.push(...lote);
      continue;
    }
    const confirmados = (data || []).length;
    if (confirmados < lote.length) {
      console.error(
        `[exclusao] ATENÇÃO -- Storage não confirmou a remoção de todos os arquivos pedidos (bucket=${bucket}): ` +
          `pedimos ${lote.length}, confirmou ${confirmados}, SEM erro reportado. Isso indica bucket/policy errado ` +
          `ou paths que não batem com o que está salvo -- confira manualmente no painel do Supabase. Caminhos pedidos: ${lote.join(', ')}`,
      );
      falharam.push(...lote);
    }
  }
  return falharam;
}

function amostraClientes(clientes) {
  return clientes.slice(0, 5).map((c) => `${c.nome} (${c.telefone})`);
}

// ---------------------------------------------------------------------------
// pdfs_por_safra / pdfs_por_tipo_fatura -- só o ARQUIVO some, cliente sobrevive
// (mesmo efeito da limpeza automática de 40 dias, ver limpezaAutomatica.js,
// só que sob demanda e por critério escolhido em vez de por idade).
// ---------------------------------------------------------------------------
async function buscarClientesComPdf(coluna, valor) {
  return lerTodos(() =>
    supabase.from('clientes').select('id, nome, telefone, pdf_path').eq(coluna, valor).not('pdf_path', 'is', null).order('id'),
  );
}

async function apagarPdfsDeClientes(clientes) {
  if (!clientes.length) return 0;
  const falharam = new Set(await removerDoStorageEmLotes(BUCKET, clientes.map((c) => c.pdf_path).filter(Boolean)));

  // Só limpa pdf_path de quem CONFIRMADAMENTE teve o arquivo removido --
  // cliente cujo arquivo falhou continua com o ponteiro intacto (aparece nas
  // próximas execuções/preview em vez de virar um órfão inrrastreável no
  // Storage).
  const comSucesso = clientes.filter((c) => !falharam.has(c.pdf_path));
  if (!comSucesso.length) {
    console.error(`[exclusao] TODAS as ${clientes.length} remoções de Storage falharam -- nenhum pdf_path foi limpo.`);
    return 0;
  }

  for (const lote of emLotes(comSucesso)) {
    const { error } = await supabase
      .from('clientes')
      .update({ pdf_url: null, pdf_path: null, pdf_atualizado_em: null })
      .in(
        'id',
        lote.map((c) => c.id),
      );
    if (error) throw error;
  }

  if (falharam.size) {
    console.error(`[exclusao] ${falharam.size} de ${clientes.length} PDF(s) não foram removidos do Storage -- pdf_path preservado pra esses.`);
  }
  return comSucesso.length;
}

const pdfsPorSafra = {
  label: 'PDFs por safra',
  async contar(filtro) {
    if (!filtro?.safra) throw new Error('parâmetro "safra" é obrigatório');
    const clientes = await buscarClientesComPdf('safra', filtro.safra);
    return { quantidade: clientes.length, amostra: amostraClientes(clientes) };
  },
  async executar(filtro) {
    if (!filtro?.safra) throw new Error('parâmetro "safra" é obrigatório');
    const clientes = await buscarClientesComPdf('safra', filtro.safra);
    return apagarPdfsDeClientes(clientes);
  },
};

const pdfsPorTipoFatura = {
  label: 'PDFs por FPD/SPD',
  async contar(filtro) {
    if (filtro?.tipo_fatura !== 'FPD' && filtro?.tipo_fatura !== 'SPD') {
      throw new Error('parâmetro "tipo_fatura" deve ser "FPD" ou "SPD"');
    }
    const clientes = await buscarClientesComPdf('tipo_fatura', filtro.tipo_fatura);
    return { quantidade: clientes.length, amostra: amostraClientes(clientes) };
  },
  async executar(filtro) {
    if (filtro?.tipo_fatura !== 'FPD' && filtro?.tipo_fatura !== 'SPD') {
      throw new Error('parâmetro "tipo_fatura" deve ser "FPD" ou "SPD"');
    }
    const clientes = await buscarClientesComPdf('tipo_fatura', filtro.tipo_fatura);
    return apagarPdfsDeClientes(clientes);
  },
};

// [2026-09] `safra` é gerada a partir de `data_prazo` (ver
// migration-19-safras-faturas.sql) -- cadastros de ANTES desse conceito
// existir (planilha antiga, cadastro manual sem prazo) ficam com `safra`
// null pra sempre. Sem este critério, esses PDFs "legados" nunca apareciam
// em NENHUM critério (pdfs_por_safra só pega quem tem safra preenchida) --
// relatado pelo usuário: 400+ PDFs assim, invisíveis pro painel inteiro.
async function buscarClientesComPdfSemSafra() {
  return lerTodos(() =>
    supabase.from('clientes').select('id, nome, telefone, pdf_path').is('safra', null).not('pdf_path', 'is', null).order('id'),
  );
}

const pdfsSemSafra = {
  label: 'PDFs sem safra (cadastros antigos)',
  async contar() {
    const clientes = await buscarClientesComPdfSemSafra();
    return { quantidade: clientes.length, amostra: amostraClientes(clientes) };
  },
  async executar() {
    const clientes = await buscarClientesComPdfSemSafra();
    return apagarPdfsDeClientes(clientes);
  },
};

// ---------------------------------------------------------------------------
// clientes_por_tag -- apaga o CLIENTE INTEIRO (cascade já existente cuida de
// envio_itens/tratativas/cliente_tags; conversas/pix_extracoes viram null em
// cliente_id, não são apagadas). PDF do Storage é removido explicitamente
// antes -- cascade de banco não sabe nada sobre arquivo.
//
// Tag é por operador (unique em usuario_id+lower(nome), ver
// migration-13-multi-tenant.sql), então "a tag Pago" pode ser várias linhas
// diferentes (uma por operador) com o mesmo nome -- casa por NOME
// (case-insensitive), não por um tag_id específico, pra cobrir a carteira
// inteira de todos os operadores de uma vez (é isso que faz sentido numa
// tela supervisor-wide).
// ---------------------------------------------------------------------------
async function buscarClientesPorTagNome(tagNome) {
  if (!tagNome || typeof tagNome !== 'string' || !tagNome.trim()) {
    throw new Error('parâmetro "tag_nome" é obrigatório');
  }
  const { data: tags, error: tagsError } = await supabase.from('tags').select('id').ilike('nome', tagNome.trim());
  if (tagsError) throw tagsError;
  const tagIds = (tags || []).map((t) => t.id);
  if (!tagIds.length) return [];

  const relacoes = await lerTodos(() =>
    supabase.from('cliente_tags').select('cliente_id, tag_id').in('tag_id', tagIds).order('cliente_id').order('tag_id'),
  );
  const clienteIds = [...new Set(relacoes.map((r) => r.cliente_id))];
  if (!clienteIds.length) return [];

  const clientes = [];
  for (const lote of emLotes(clienteIds)) {
    const { data, error: clientesError } = await supabase.from('clientes').select('id, nome, telefone, pdf_path').in('id', lote);
    if (clientesError) throw clientesError;
    clientes.push(...(data || []));
  }
  return clientes;
}

const clientesPorTag = {
  label: 'Clientes por tag',
  async contar(filtro) {
    const clientes = await buscarClientesPorTagNome(filtro?.tag_nome);
    return { quantidade: clientes.length, amostra: amostraClientes(clientes) };
  },
  async executar(filtro) {
    const clientes = await buscarClientesPorTagNome(filtro?.tag_nome);
    if (!clientes.length) return 0;
    // [2026-09] Diferente de apagarPdfsDeClientes: aqui o CLIENTE inteiro é
    // apagado de qualquer forma (é o propósito deste critério) -- uma falha
    // isolada na limpeza do Storage não deveria bloquear a exclusão do
    // cadastro. Ainda assim loga alto se sobrar arquivo órfão, pra não
    // silenciar o mesmo tipo de sintoma relatado (Storage não diminuindo).
    const pdfPaths = clientes.map((c) => c.pdf_path).filter(Boolean);
    if (pdfPaths.length) {
      const falharam = await removerDoStorageEmLotes(BUCKET, pdfPaths);
      if (falharam.length) {
        console.error(`[exclusao] ${falharam.length} PDF(s) ficaram órfãos no Storage (cliente foi apagado mesmo assim). Primeiros:`, falharam.slice(0, 10));
      }
    }
    await apagarClientesPorId(clientes.map((c) => c.id));
    return clientes.length;
  },
};

async function apagarClientesPorId(ids) {
  for (const lote of emLotes(ids)) {
    const { error } = await supabase.from('clientes').delete().in('id', lote);
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------------
// clientes_sem_fatura -- [2026-10] "sobras" da carteira: cliente que ficou só
// com o nome depois que o PDF foi apagado (painel/limpeza de 40 dias) e nunca
// mais recebeu fatura. Os critérios de PDF acima preservam o cliente de
// propósito, então sem este não existia jeito de limpar a carteira em massa.
// Só a campanha de cobrança (a de Ativação Chip nunca tem PDF/valor).
// `sem_valor` (padrão true) exige também valor vazio -- é o que separa a
// "sobra" de um cliente recém-importado que ainda espera o PDF mas já tem valor.
// ---------------------------------------------------------------------------
async function buscarClientesSemFatura(filtro) {
  const semValor = filtro?.sem_valor !== false;
  return lerTodos(() => {
    let q = supabase
      .from('clientes')
      .select('id, nome, telefone')
      .eq('campanha', 'cobranca')
      .is('pdf_path', null)
      .is('pdf_url', null);
    if (semValor) q = q.is('valor', null);
    return q.order('id');
  });
}

const clientesSemFatura = {
  label: 'Clientes sem fatura',
  async contar(filtro) {
    const clientes = await buscarClientesSemFatura(filtro);
    return { quantidade: clientes.length, amostra: amostraClientes(clientes) };
  },
  async executar(filtro) {
    const clientes = await buscarClientesSemFatura(filtro);
    if (!clientes.length) return 0;
    await apagarClientesPorId(clientes.map((c) => c.id));
    return clientes.length;
  },
};

// ---------------------------------------------------------------------------
// pix_extracoes -- histórico do Extrator de PIX (lista que passava de mil
// linhas). Ver lib/pixLimpeza.js; aqui é a porta supervisor-wide (sem usuario_id).
// ---------------------------------------------------------------------------
function opcoesPix(filtro) {
  return { usuarioId: null, modo: filtro?.modo, antesDe: filtro?.antes_de };
}

const pixExtracoes = {
  label: 'Extrações de Pix',
  contar: (filtro) => contarExtracoesPix(opcoesPix(filtro)),
  executar: (filtro) => apagarExtracoesPix(opcoesPix(filtro)),
};

// ---------------------------------------------------------------------------
// historico_mensagens -- apaga conversas (mensagens cascadeiam sozinhas, ver
// supabase-schema.sql). Anexos do Storage removidos explicitamente antes.
// "quantidade" reportada é sempre em MENSAGENS (é a unidade que representa
// espaço/volume de verdade -- uma conversa "vazia" de anexo pesado ainda
// conta pouco, enquanto uma conversa com centenas de mensagens conta muito),
// não em conversas.
// ---------------------------------------------------------------------------
function limiteDeData(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

async function buscarConversasParaApagar(filtro) {
  const campanha = filtro?.campanha === 'chip_ativacao' ? 'chip_ativacao' : filtro?.campanha === 'cobranca' ? 'cobranca' : null;
  const dias = Number(filtro?.dias_mais_antigo_que) || 0;
  if (dias < 0) throw new Error('"dias_mais_antigo_que" não pode ser negativo');

  return lerTodos(() => {
    let query = supabase.from('conversas').select('id, telefone, nome_contato');
    if (campanha) query = query.eq('campanha', campanha);
    if (dias > 0) query = query.lt('ultima_mensagem_em', limiteDeData(dias));
    return query.order('id');
  });
}

async function contarMensagensDeConversas(ids) {
  let total = 0;
  for (const lote of emLotes(ids)) {
    const { count, error } = await supabase.from('mensagens').select('id', { count: 'exact', head: true }).in('conversa_id', lote);
    if (error) throw error;
    total += count || 0;
  }
  return total;
}

const historicoMensagens = {
  label: 'Histórico de mensagens',
  async contar(filtro) {
    const conversas = await buscarConversasParaApagar(filtro);
    if (!conversas.length) return { quantidade: 0, amostra: [] };
    const ids = conversas.map((c) => c.id);
    return {
      quantidade: await contarMensagensDeConversas(ids),
      amostra: conversas.slice(0, 5).map((c) => `${c.nome_contato || c.telefone}`),
    };
  },
  async executar(filtro) {
    const conversas = await buscarConversasParaApagar(filtro);
    if (!conversas.length) return 0;
    const ids = conversas.map((c) => c.id);

    const mensagens = [];
    for (const lote of emLotes(ids)) {
      mensagens.push(
        ...(await lerTodos(() => supabase.from('mensagens').select('id, anexo_path').in('conversa_id', lote).order('id'))),
      );
    }

    // Conversas são apagadas de qualquer forma (é o propósito deste
    // critério); falha isolada num anexo não bloqueia -- só loga alto pra
    // não silenciar um órfão no bucket chat-midia.
    const caminhos = mensagens.map((m) => m.anexo_path).filter(Boolean);
    if (caminhos.length) {
      const falharam = await removerDoStorageEmLotes(CHAT_BUCKET, caminhos);
      if (falharam.length) {
        console.error(`[exclusao] ${falharam.length} anexo(s) ficaram órfãos no Storage (conversa foi apagada mesmo assim). Primeiros:`, falharam.slice(0, 10));
      }
    }

    for (const lote of emLotes(ids)) {
      const { error } = await supabase.from('conversas').delete().in('id', lote);
      if (error) throw error;
    }
    return mensagens.length;
  },
};

export const CRITERIOS = {
  pdfs_por_safra: pdfsPorSafra,
  pdfs_por_tipo_fatura: pdfsPorTipoFatura,
  pdfs_sem_safra: pdfsSemSafra,
  clientes_por_tag: clientesPorTag,
  clientes_sem_fatura: clientesSemFatura,
  pix_extracoes: pixExtracoes,
  historico_mensagens: historicoMensagens,
};

// ---------------------------------------------------------------------------
// "O que mais está ocupando espaço" -- varre os 5 critérios com um filtro
// natural cada (uma linha por safra/tipo/tag/campanha que de fato tem algo
// pra apagar, + "sem safra" pros cadastros legados) e devolve tudo numa
// lista só, ordenada por quantidade decrescente. Puramente informativo --
// nunca apaga nada.
// ---------------------------------------------------------------------------
async function contarMensagensPorCampanha(campanha) {
  const conversas = await lerTodos(() => supabase.from('conversas').select('id').eq('campanha', campanha).order('id'));
  const ids = conversas.map((c) => c.id);
  if (!ids.length) return { conversas: 0, mensagens: 0 };
  return { conversas: ids.length, mensagens: await contarMensagensDeConversas(ids) };
}

export async function montarResumoExclusao() {
  const itens = [];

  const clientesComPdf = await lerTodos(() =>
    supabase.from('clientes').select('safra, tipo_fatura').not('pdf_path', 'is', null).order('id'),
  );

  const porSafra = new Map();
  const porTipo = new Map();
  let semSafra = 0;
  for (const c of clientesComPdf) {
    if (c.safra) porSafra.set(c.safra, (porSafra.get(c.safra) || 0) + 1);
    else semSafra += 1;
    if (c.tipo_fatura) porTipo.set(c.tipo_fatura, (porTipo.get(c.tipo_fatura) || 0) + 1);
  }
  if (semSafra > 0) {
    itens.push({
      criterio: 'pdfs_sem_safra',
      filtro: {},
      rotulo: 'PDFs — sem safra (cadastros antigos)',
      quantidade: semSafra,
      detalhe: `${semSafra} PDF(s) de antes do conceito de safra existir`,
    });
  }
  for (const [safra, quantidade] of porSafra) {
    itens.push({
      criterio: 'pdfs_por_safra',
      filtro: { safra },
      rotulo: `PDFs — Safra ${rotuloSafra(safra)}`,
      quantidade,
      detalhe: `${quantidade} PDF(s)`,
    });
  }
  for (const [tipo, quantidade] of porTipo) {
    itens.push({
      criterio: 'pdfs_por_tipo_fatura',
      filtro: { tipo_fatura: tipo },
      rotulo: `PDFs — ${tipo}`,
      quantidade,
      detalhe: `${quantidade} PDF(s)`,
    });
  }

  const tags = await lerTodos(() => supabase.from('tags').select('nome').order('id'));
  const nomesUnicos = [...new Set((tags || []).map((t) => t.nome.trim()))];
  const resultadosTags = await Promise.all(
    nomesUnicos.map(async (nome) => ({ nome, clientes: await buscarClientesPorTagNome(nome) })),
  );
  for (const { nome, clientes } of resultadosTags) {
    if (clientes.length) {
      itens.push({
        criterio: 'clientes_por_tag',
        filtro: { tag_nome: nome },
        rotulo: `Clientes — tag "${nome}"`,
        quantidade: clientes.length,
        detalhe: `${clientes.length} cliente(s)`,
      });
    }
  }

  const semFatura = await buscarClientesSemFatura({ sem_valor: true });
  if (semFatura.length) {
    itens.push({
      criterio: 'clientes_sem_fatura',
      filtro: { sem_valor: true },
      rotulo: 'Clientes — sem PDF e sem valor (sobras)',
      quantidade: semFatura.length,
      detalhe: `${semFatura.length} cliente(s) que ficaram só com o nome`,
    });
  }
  const semPdfComValor = (await buscarClientesSemFatura({ sem_valor: false })).length - semFatura.length;
  if (semPdfComValor > 0) {
    itens.push({
      criterio: 'clientes_sem_fatura',
      filtro: { sem_valor: false },
      rotulo: 'Clientes — sem PDF (mesmo com valor)',
      quantidade: semPdfComValor + semFatura.length,
      detalhe: `${semPdfComValor + semFatura.length} cliente(s) sem PDF, incluindo os que ainda têm valor`,
    });
  }

  for (const [modo, rotulo] of [
    ['todas', 'Extrações de Pix — todas'],
    ['sem_cliente', 'Extrações de Pix — sem cliente vinculado'],
    ['com_erro', 'Extrações de Pix — com erro / não encontrado'],
  ]) {
    const { quantidade } = await contarExtracoesPix({ usuarioId: null, modo });
    if (quantidade > 0) {
      itens.push({ criterio: 'pix_extracoes', filtro: { modo }, rotulo, quantidade, detalhe: `${quantidade} extração(ões)` });
    }
  }

  for (const campanha of ['cobranca', 'chip_ativacao']) {
    const { conversas, mensagens } = await contarMensagensPorCampanha(campanha);
    if (mensagens > 0) {
      itens.push({
        criterio: 'historico_mensagens',
        // dias_mais_antigo_que: 0 = sem corte de idade (todo o histórico) --
        // é só o valor SUGERIDO pro formulário; o supervisor pode ajustar
        // antes de pedir o preview de verdade.
        filtro: { campanha, dias_mais_antigo_que: 0 },
        rotulo: `Mensagens — ${campanha === 'cobranca' ? 'cobrança' : 'ativação chip'}`,
        quantidade: mensagens,
        detalhe: `${mensagens} mensagem(ns) em ${conversas} conversa(s)`,
      });
    }
  }

  itens.sort((a, b) => b.quantidade - a.quantidade);
  return itens;
}
