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

// PostgREST corta em 1000 linhas sem `.limit()` explícito (mesmo bug já
// corrigido em outras rotas, ver clientes.routes.js/GET) -- aqui não pagina
// de verdade (é uma tela de manutenção, não uma listagem operacional), só
// garante um teto alto o bastante pra não truncar em silêncio.
const LIMITE_LINHAS = 50000;

// [CRÍTICO -- bug real corrigido 2026-09] Antes esta função só logava o erro
// e seguia a vida (mesmo "best-effort" que limpezaAutomatica.js usa) -- só
// que quem chama SEMPRE limpava pdf_path do cliente logo em seguida, MESMO
// quando a remoção do Storage falhava de verdade. Resultado: o arquivo
// ficava órfão no bucket pra sempre (ninguém mais sabe o path dele, já que
// a única referência acabou de ser apagada do banco) e o operador via
// "sucesso" sem saber que o espaço em disco não foi liberado -- exatamente
// o sintoma relatado (Storage size não caiu depois de apagar). Agora
// devolve QUAIS caminhos falharam, e quem chama só limpa o ponteiro no
// banco pros que realmente confirmaram remoção.
async function removerDoStorageEmLotes(bucket, caminhos) {
  const TAMANHO_LOTE = 100; // limite prático da API do Supabase Storage por chamada de .remove()
  const falharam = [];
  for (let i = 0; i < caminhos.length; i += TAMANHO_LOTE) {
    const lote = caminhos.slice(i, i + TAMANHO_LOTE);
    const { error } = await supabase.storage.from(bucket).remove(lote);
    if (error) {
      console.error(`[exclusao] erro ao remover arquivos do bucket ${bucket}:`, error.message);
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
  const { data, error } = await supabase
    .from('clientes')
    .select('id, nome, telefone, pdf_path')
    .eq(coluna, valor)
    .not('pdf_path', 'is', null)
    .limit(LIMITE_LINHAS);
  if (error) throw error;
  return data || [];
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

  const { error } = await supabase
    .from('clientes')
    .update({ pdf_url: null, pdf_path: null, pdf_atualizado_em: null })
    .in(
      'id',
      comSucesso.map((c) => c.id),
    );
  if (error) throw error;

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
  const { data, error } = await supabase
    .from('clientes')
    .select('id, nome, telefone, pdf_path')
    .is('safra', null)
    .not('pdf_path', 'is', null)
    .limit(LIMITE_LINHAS);
  if (error) throw error;
  return data || [];
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

  const { data: relacoes, error: relError } = await supabase
    .from('cliente_tags')
    .select('cliente_id')
    .in('tag_id', tagIds)
    .limit(LIMITE_LINHAS);
  if (relError) throw relError;
  const clienteIds = [...new Set((relacoes || []).map((r) => r.cliente_id))];
  if (!clienteIds.length) return [];

  const { data: clientes, error: clientesError } = await supabase
    .from('clientes')
    .select('id, nome, telefone, pdf_path')
    .in('id', clienteIds);
  if (clientesError) throw clientesError;
  return clientes || [];
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
        console.error(`[exclusao] ${falharam.length} PDF(s) ficaram órfãos no Storage (cliente foi apagado mesmo assim):`, falharam);
      }
    }
    const { error } = await supabase
      .from('clientes')
      .delete()
      .in(
        'id',
        clientes.map((c) => c.id),
      );
    if (error) throw error;
    return clientes.length;
  },
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

  let query = supabase.from('conversas').select('id, telefone, nome_contato').limit(LIMITE_LINHAS);
  if (campanha) query = query.eq('campanha', campanha);
  if (dias > 0) query = query.lt('ultima_mensagem_em', limiteDeData(dias));

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

const historicoMensagens = {
  label: 'Histórico de mensagens',
  async contar(filtro) {
    const conversas = await buscarConversasParaApagar(filtro);
    if (!conversas.length) return { quantidade: 0, amostra: [] };
    const ids = conversas.map((c) => c.id);
    const { count, error } = await supabase.from('mensagens').select('id', { count: 'exact', head: true }).in('conversa_id', ids);
    if (error) throw error;
    return {
      quantidade: count || 0,
      amostra: conversas.slice(0, 5).map((c) => `${c.nome_contato || c.telefone}`),
    };
  },
  async executar(filtro) {
    const conversas = await buscarConversasParaApagar(filtro);
    if (!conversas.length) return 0;
    const ids = conversas.map((c) => c.id);

    const { data: mensagens, error: msgError } = await supabase
      .from('mensagens')
      .select('id, anexo_path')
      .in('conversa_id', ids)
      .limit(LIMITE_LINHAS);
    if (msgError) throw msgError;

    // Conversas são apagadas de qualquer forma (é o propósito deste
    // critério); falha isolada num anexo não bloqueia -- só loga alto pra
    // não silenciar um órfão no bucket chat-midia.
    const caminhos = (mensagens || []).map((m) => m.anexo_path).filter(Boolean);
    if (caminhos.length) {
      const falharam = await removerDoStorageEmLotes(CHAT_BUCKET, caminhos);
      if (falharam.length) {
        console.error(`[exclusao] ${falharam.length} anexo(s) ficaram órfãos no Storage (conversa foi apagada mesmo assim):`, falharam);
      }
    }

    const { error } = await supabase.from('conversas').delete().in('id', ids);
    if (error) throw error;
    return (mensagens || []).length;
  },
};

export const CRITERIOS = {
  pdfs_por_safra: pdfsPorSafra,
  pdfs_por_tipo_fatura: pdfsPorTipoFatura,
  pdfs_sem_safra: pdfsSemSafra,
  clientes_por_tag: clientesPorTag,
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
  const { data: conversas, error } = await supabase.from('conversas').select('id').eq('campanha', campanha).limit(LIMITE_LINHAS);
  if (error) throw error;
  const ids = (conversas || []).map((c) => c.id);
  if (!ids.length) return { conversas: 0, mensagens: 0 };
  const { count, error: msgErr } = await supabase.from('mensagens').select('id', { count: 'exact', head: true }).in('conversa_id', ids);
  if (msgErr) throw msgErr;
  return { conversas: ids.length, mensagens: count || 0 };
}

export async function montarResumoExclusao() {
  const itens = [];

  const { data: clientesComPdf, error: pdfErr } = await supabase
    .from('clientes')
    .select('safra, tipo_fatura')
    .not('pdf_path', 'is', null)
    .limit(LIMITE_LINHAS);
  if (pdfErr) throw pdfErr;

  const porSafra = new Map();
  const porTipo = new Map();
  let semSafra = 0;
  for (const c of clientesComPdf || []) {
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

  const { data: tags, error: tagsErr } = await supabase.from('tags').select('nome');
  if (tagsErr) throw tagsErr;
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
