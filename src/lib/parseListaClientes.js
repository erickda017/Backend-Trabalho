// Faz o parse de uma lista "crua" de clientes no formato usado nos relatórios de
// cobrança, aceitando DUAS variações da mesma informação:
//
//   (a) FORMATO ANTIGO (1 campo por linha, várias linhas por cliente): blocos de
//       texto separados por linha em branco/"#####", cada bloco tendo, NESSA
//       ORDEM: nome / contrato / "CPF ..." / telefone(s) / "Fatura N" / valor /
//       "— DD/MM/AAAA".
//   (b) FORMATO COMPOSTO (vários campos numa mesma linha, ex.: relatório colado
//       direto de uma planilha/site): "JOÃO DA SILVA | CPF 123... | 41999999999
//       | R$ 150,00 | ...", separados por "|", tab, 2+ espaços ou " - ".
//
// A ideia central: em vez de classificar a LINHA inteira (que só funciona se
// cada linha tiver exatamente 1 campo) e exigir os campos numa ORDEM fixa
// (como a versão antiga deste arquivo fazia, com uma máquina de estados
// EXPECT_NOME -> EXPECT_CONTRATO -> ... -> EXPECT_PRAZO), cada linha é
// primeiro dividida em SEGMENTOS (ver dividirEmSegmentos) e cada segmento é
// classificado e encaixado no cliente ATUAL, na hora, não importa em que
// ordem apareceu -- um NOME sempre abre um bloco novo (fechando o anterior,
// mesmo incompleto), e qualquer outro campo reconhecido (CPF/contrato/
// telefone/Fatura/valor/prazo) preenche o bloco aberto no momento.
//
// Isso é necessário porque exigir ordem fixa quebra o caso mais comum de
// lista composta ("NOME | TELEFONE | VALOR", sem contrato nem CPF): com
// ordem fixa, o primeiro número depois do nome seria sempre lido como
// "contrato" (por posição), engolindo o telefone de verdade por engano.
//
// Contrato x telefone agora se distingue pelo TAMANHO do número (não mais só
// pela posição): 10 a 13 dígitos = telefone (DDD+8/9 dígitos, com ou sem
// código do país); 4 a 9 dígitos = número de contrato. Cobre os casos reais
// observados (contrato de 6 dígitos, telefone de 10/11/13) sem depender de
// vir sempre logo depois do nome.
//
// Retorna um item POR TELEFONE (cliente com 2 números vira 2 linhas), já no
// formato que a planilha modelo usa, ampliado com os campos de safra:
// { nome, numero, valor, arquivo, tipo_fatura, data_prazo, numero_contrato, data_contrato }.
// Também devolve `avisos`: 1 por bloco sem telefone E 1 por trecho que não foi
// reconhecido como nenhum campo esperado (pra não sumir dado silenciosamente
// -- ver POST /clientes/converter-lista, que mostra isso pro operador antes
// de importar de verdade).

// Divide uma linha em segmentos por separador de coluna explícito: "|", tab,
// 2+ espaços seguidos, ou " - " (traço COM espaço dos dois lados -- de
// propósito, pra nunca cortar um CPF/telefone formatado com traço colado,
// tipo "233.228.379-04" ou "99999-9999", que não tem espaço ao redor do
// traço). Vírgula NÃO é separador aqui: no formato BR, vírgula é separador
// decimal ("R$ 150,00"), cortar por ela quebraria o valor.
function dividirEmSegmentos(linha) {
  return linha
    .split(/\t+|\s*\|\s*|\s+-\s+|\s{2,}|\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Mesma limpeza de antes (normalizarLinha), mas aplicada por SEGMENTO: anotação
// explicativa colada (ex: "IRANDIR GONCALVES ALVES = NOME", "CPF 233.228.379-04
// (NAO UTILIZE ESSA INFORMAÇÃO)") não é dado real -- removida antes de
// classificar, senão o segmento vira "lixo" e a informação real dali se perde.
function normalizarSegmento(s) {
  let out = s.trim();
  const idxIgual = out.indexOf(' = ');
  if (idxIgual > 0) out = out.slice(0, idxIgual).trim();
  out = out.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return out;
}

function ehLinhaVazia(l) {
  return l === '';
}

// Separador EXPLÍCITO de bloco (### ou variantes) -- só isso fecha o bloco
// atual. Linha em branco pura NÃO fecha mais (ver ehLinhaVazia acima e seu
// uso em parseListaClientes): listas coladas direto de PDF costumam ter uma
// linha em branco entre CADA campo (nome / contrato / CPF / telefone), não
// só entre clientes diferentes -- tratar toda linha em branco como fim de
// bloco descartava o cliente inteiro (nome fechado sem telefone, e os
// campos seguintes viravam "trecho não reconhecido" por não ter bloco
// aberto). Como um NOME novo já fecha o bloco anterior sozinho (ver comentário
// "Um NOME sempre abre um bloco novo"), não é necessário depender da linha
// em branco pra separar clientes no caso comum.
function ehSeparadorExplicito(l) {
  return /^#+$/.test(l);
}

function ehSeparador(l) {
  return ehLinhaVazia(l) || ehSeparadorExplicito(l);
}

function ehLinhaDigitos(l) {
  return /^\d{4,}$/.test(l.replace(/\D/g, '')) && /^\d[\d\s]*$/.test(l);
}

function ehLinhaCpf(l) {
  return /^cpf\b/i.test(l);
}

function ehLinhaFatura(l) {
  return /^fatura\b/i.test(l);
}

function ehLinhaValor(l) {
  return /^r\$\s*[\d.,]+/i.test(l) || l === '—' || l === '-';
}

// Segmento que contém uma data no formato brasileiro (DD/MM/AAAA ou DD/MM/AA),
// em qualquer posição -- cobre tanto "24/09/2026" sozinho quanto "—
// 24/09/2026" (placeholder + data, formato real observado nas listas de
// cobrança da empresa).
const REGEX_DATA_BR = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/;
function ehLinhaComData(l) {
  return REGEX_DATA_BR.test(l);
}

// Nome: tem letra, não é nenhum dos casos acima.
function ehLinhaNome(l) {
  if (ehSeparador(l) || ehLinhaDigitos(l) || ehLinhaCpf(l) || ehLinhaFatura(l) || ehLinhaValor(l) || ehLinhaComData(l)) return false;
  return /[A-Za-zÀ-ÿ]/.test(l);
}

function parseValor(l) {
  if (l === '—' || l === '-') return null;
  const match = l.match(/[\d.,]+/);
  if (!match) return null;
  // "1.234,56" (BR) -> "1234.56"; também aceita "122,39" -> "122.39"
  const numero = Number(match[0].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(numero) ? numero : null;
}

// "24/09/2026" -> "2026-09-24" (ISO, o que o Postgres/coluna `date` espera).
// Aceita ano com 2 dígitos (assume 20XX -- nunca apareceu esse caso nos
// dados reais até hoje, mas evita descartar o bloco inteiro se aparecer).
function parseDataBr(l) {
  const match = l.match(REGEX_DATA_BR);
  if (!match) return null;
  const [, diaStr, mesStr, anoStr] = match;
  const dia = Number(diaStr);
  const mes = Number(mesStr);
  let ano = Number(anoStr);
  if (anoStr.length === 2) ano += 2000;
  if (!Number.isFinite(dia) || !Number.isFinite(mes) || !Number.isFinite(ano)) return null;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// "Fatura 1" -> 'FPD' (primeira fatura), "Fatura 2" -> 'SPD' (segunda
// fatura). Qualquer outro número (ou "Fatura" sem número) fica sem tipo
// reconhecido -- melhor null do que inventar um valor, já que o resto do
// sistema (safra, filtros) trata "sem tipo_fatura" como um caso normal, não
// um erro.
function tipoFaturaDeLinha(l) {
  const match = l.match(/^fatura\s*(\d+)/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (n === 1) return 'FPD';
  if (n === 2) return 'SPD';
  return null;
}

export function slugNome(nome) {
  return (
    String(nome || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'cliente'
  );
}

// Distingue telefone de número de contrato pelo TAMANHO (ver comentário no
// topo do arquivo pro porquê disso substituir a distinção por posição).
function pareceTelefone(digitos) {
  return digitos.length >= 10 && digitos.length <= 13;
}
function pareceContrato(digitos) {
  return digitos.length >= 4 && digitos.length <= 9;
}

// Extrai só os NOMES de uma lista "crua" no mesmo formato reconhecido acima
// (bloco NOME/contrato/CPF/telefone(s)/Fatura/valor, em linhas separadas OU
// tudo numa linha só) -- usado por fluxos que só precisam CASAR com um
// cliente já cadastrado (ex: POST /clientes/importar-pagos), não criar
// cliente novo, então contrato/CPF/telefone(s)/Fatura/valor são só ruído a
// ignorar; cada segmento classificado como nome (`ehLinhaNome`) vira um item,
// sem depender de posição/estado -- por isso também aceita, sem nenhuma
// mudança, o formato simples "1 nome por linha" que este fluxo já suportava.
export function extrairNomesDeListaCrua(textoCru) {
  const linhas = String(textoCru || '').split(/\r?\n/);

  const nomes = [];
  for (const linhaBruta of linhas) {
    if (ehSeparador(linhaBruta.trim())) continue;
    for (const segmentoBruto of dividirEmSegmentos(linhaBruta)) {
      const segmento = normalizarSegmento(segmentoBruto);
      if (segmento && ehLinhaNome(segmento)) nomes.push(segmento);
    }
  }
  return nomes;
}

export function parseListaClientes(textoCru) {
  const itens = []; // { nome, numero, valor, arquivo, tipo_fatura, data_prazo, numero_contrato, data_contrato }
  const avisos = [];

  // { nome, telefones: [], tipo_fatura, numero_contrato, valor, dataPrazo }
  let atual = null;

  function novoBloco(nome) {
    return { nome, telefones: [], tipo_fatura: null, numero_contrato: null, valor: null, dataPrazo: null };
  }

  function finalizarBloco() {
    if (!atual) return;
    if (atual.telefones.length === 0) {
      avisos.push(`"${atual.nome}" ignorado: nenhum telefone encontrado.`);
    } else {
      const arquivo = `${slugNome(atual.nome)}.pdf`;
      for (const numero of atual.telefones) {
        itens.push({
          nome: atual.nome,
          numero,
          valor: atual.valor,
          arquivo,
          tipo_fatura: atual.tipo_fatura,
          data_prazo: atual.dataPrazo,
          numero_contrato: atual.numero_contrato,
          // Nenhum formato de lista crua observado até hoje traz uma data de
          // contrato distinta da data de prazo (ver comentário no topo do
          // arquivo) -- fica reservado pra quando/se isso aparecer.
          data_contrato: null,
        });
      }
    }
    atual = null;
  }

  // Trecho não-vazio que não bateu com NENHUM campo reconhecido -- antes
  // isso desaparecia sem deixar rastro (bug real: operador não tinha como
  // saber que uma parte da lista colada foi ignorada). Agora vira aviso, com
  // o próprio texto do trecho, pra revisar antes de importar.
  function avisarTrechoIgnorado(segmento) {
    avisos.push(`Trecho não reconhecido, ignorado: "${segmento}"`);
  }

  const linhas = String(textoCru || '').split(/\r?\n/);

  // Acha o texto inteiro numa lista de tokens (marcando linha em branco e
  // separador explícito, além dos segmentos de verdade), pra dar pra olhar o
  // PRÓXIMO campo real antes de decidir se um trecho com letra é de fato um
  // nome de cliente novo -- ver por quê logo abaixo, no uso de
  // `proximoSegmentoReal`.
  const tokens = [];
  for (const linhaBruta of linhas) {
    const linha = linhaBruta.trim();
    if (ehSeparadorExplicito(linha)) {
      tokens.push({ tipo: 'separador' });
      continue;
    }
    if (ehLinhaVazia(linha)) {
      tokens.push({ tipo: 'vazio' });
      continue;
    }
    for (const segmentoBruto of dividirEmSegmentos(linhaBruta)) {
      const segmento = normalizarSegmento(segmentoBruto);
      if (segmento) tokens.push({ tipo: 'segmento', valor: segmento });
    }
  }

  // Próximo segmento de verdade depois do índice i, pulando linha(s) em
  // branco -- pára (devolve null) se achar um separador explícito ou o fim
  // do texto antes de achar um.
  function proximoSegmentoReal(i) {
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.tipo === 'vazio') continue;
      if (t.tipo === 'segmento') return t.valor;
      return null;
    }
    return null;
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.tipo === 'separador') {
      finalizarBloco();
      continue;
    }
    if (token.tipo === 'vazio') continue;

    const l = token.valor;

    // CPF nunca é guardado (às vezes vem CNPJ mesmo rotulado "CPF") --
    // ignora independente de ter ou não um bloco aberto.
    if (ehLinhaCpf(l)) continue;

    if (ehLinhaNome(l)) {
      // Um texto com letra logo seguido (pulando linha em branco) por
      // Fatura/valor/prazo -- sem contrato/CPF/telefone no meio -- não é um
      // cliente novo, é ruído tipo nome de plano/operadora colado entre os
      // telefones e a linha "Fatura N" (ex.: "CLARO MEGA"). Um cliente de
      // verdade NUNCA aparece assim: sempre tem contrato/CPF/telefone antes
      // de Fatura/valor/prazo (ver formato documentado no topo do arquivo).
      const proximo = proximoSegmentoReal(i);
      const proximoEhCampoDeFatura = proximo !== null && (ehLinhaFatura(proximo) || ehLinhaValor(proximo) || ehLinhaComData(proximo));
      if (proximoEhCampoDeFatura) {
        avisarTrechoIgnorado(l);
        continue;
      }

      // Um NOME de verdade sempre abre um bloco novo -- fecha o anterior
      // (mesmo que incompleto), não importa quantos campos ele já tinha
      // coletado.
      finalizarBloco();
      atual = novoBloco(l);
      continue;
    }

    if (!atual) {
      // Campo reconhecido (valor/data/fatura/dígitos) sem nenhum nome
      // aberto antes -- não tem a quem atribuir.
      avisarTrechoIgnorado(l);
      continue;
    }

    if (ehLinhaFatura(l)) {
      atual.tipo_fatura = tipoFaturaDeLinha(l);
      continue;
    }
    if (ehLinhaComData(l)) {
      atual.dataPrazo = parseDataBr(l);
      continue;
    }
    if (ehLinhaValor(l)) {
      atual.valor = parseValor(l);
      continue;
    }
    if (ehLinhaDigitos(l)) {
      const digitos = l.replace(/\D/g, '');
      if (pareceContrato(digitos) && !atual.numero_contrato && !pareceTelefone(digitos)) {
        atual.numero_contrato = digitos;
      } else {
        // Também cobre o fallback de um tamanho fora do esperado (melhor
        // tentar como telefone do que perder o número).
        atual.telefones.push(digitos);
      }
      continue;
    }
    avisarTrechoIgnorado(l);
  }

  // Último bloco do texto (EOF sem separador final -- comum quando o texto
  // foi cortado).
  finalizarBloco();

  return { itens, avisos };
}
