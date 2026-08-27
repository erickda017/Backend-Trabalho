// Faz o parse de uma lista "crua" de clientes no formato usado nos relatórios de
// cobrança (ver docs/ou exemplo enviado pelo usuário): blocos de texto separados
// por linhas em branco/"#####", cada bloco tendo, NESSA ORDEM:
//   NOME (linha só com letras/espaços, tudo maiúsculo)
//   contrato (linha só com dígitos -- número identificador, guardado em
//     `numero_contrato`; NÃO é uma data, então não alimenta `data_contrato`)
//   "CPF ###.###.###-##" (IGNORADO -- às vezes vem CNPJ mesmo rotulado "CPF")
//   um ou mais telefones (uma linha por número, só dígitos)
//   "Fatura N" (opcional -- N=1 vira tipo_fatura "FPD", N=2 vira "SPD",
//     qualquer outro número fica sem tipo_fatura reconhecido)
//   "R$ 123,45" ou "—" (valor da fatura -- opcional)
//   "— DD/MM/AAAA" (opcional -- data de PRAZO da fatura; o traço antes da
//     data é um placeholder de outra coluna do relatório, sempre "—" nos
//     exemplos reais até hoje, mas a data é extraída de qualquer lugar da
//     linha por regex, não por posição fixa, pra não quebrar se esse
//     placeholder mudar)
//
// Não dá pra confiar no tamanho do número pra distinguir contrato de telefone
// (varia de 6 a 9 dígitos nos dois), então a distinção é por POSIÇÃO no bloco:
// o primeiro número após o nome é sempre contrato, os números depois do CPF são
// sempre telefone -- até aparecer "Fatura" ou um novo nome.
//
// Retorna um item POR TELEFONE (cliente com 2 números vira 2 linhas), já no
// formato que a planilha modelo usa, ampliado com os campos de safra:
// { nome, numero, valor, arquivo, tipo_fatura, data_prazo, numero_contrato, data_contrato }.

function normalizarLinha(l) {
  let s = l.replace(/\t/g, ' ').trim();
  // Anotações explicativas coladas na linha (ex: "IRANDIR GONCALVES ALVES = NOME",
  // "CPF 233.228.379-04 (NAO UTILIZE ESSA INFORMAÇÃO)") não fazem parte do dado
  // real -- removidas antes de classificar a linha, senão a linha vira "lixo"
  // e o bloco inteiro se perde.
  const idxIgual = s.indexOf(' = ');
  if (idxIgual > 0) s = s.slice(0, idxIgual).trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return s;
}

function ehSeparador(l) {
  return l === '' || /^#+$/.test(l);
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

// Linha que contém uma data no formato brasileiro (DD/MM/AAAA ou DD/MM/AA),
// em qualquer posição da linha -- cobre tanto "24/09/2026" sozinho quanto
// "—    24/09/2026" (placeholder + data, formato real observado nas listas
// de cobrança da empresa).
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
// dados reais até hoje, mas evita descartar a linha inteira se aparecer).
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
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'cliente'
  );
}

// Estados do parser
const EXPECT_NOME = 'EXPECT_NOME';
const EXPECT_CONTRATO = 'EXPECT_CONTRATO';
const EXPECT_CPF = 'EXPECT_CPF';
const COLETANDO_TELEFONES = 'COLETANDO_TELEFONES';
const EXPECT_VALOR = 'EXPECT_VALOR';
// Linha "— DD/MM/AAAA" que vem depois do valor (data de PRAZO da fatura) --
// só existe nas listas mais novas (as que já trazem Fatura N); listas
// antigas/mais simples nunca chegam nesse estado e continuam funcionando
// exatamente como antes.
const EXPECT_PRAZO = 'EXPECT_PRAZO';

// Extrai só os NOMES de uma lista "crua" no mesmo formato reconhecido acima
// (bloco NOME/contrato/CPF/telefone(s)/Fatura/valor) -- usado por fluxos que
// só precisam CASAR com um cliente já cadastrado (ex: POST
// /clientes/importar-pagos), não criar cliente novo, então contrato/CPF/
// telefone(s)/Fatura/valor são só ruído a ignorar; cada linha classificada
// como nome (`ehLinhaNome`) vira um item, sem depender de posição/estado --
// por isso também aceita, sem nenhuma mudança, o formato simples "1 nome por
// linha" que este fluxo já suportava (cada linha OK já é uma linha-nome).
export function extrairNomesDeListaCrua(textoCru) {
  const linhas = String(textoCru || '')
    .split(/\r?\n/)
    .map(normalizarLinha);

  const nomes = [];
  for (const l of linhas) {
    if (ehSeparador(l)) continue;
    if (ehLinhaNome(l)) nomes.push(l);
  }
  return nomes;
}

export function parseListaClientes(textoCru) {
  const linhas = String(textoCru || '')
    .split(/\r?\n/)
    .map(normalizarLinha);

  const itens = []; // { nome, numero, valor, arquivo, tipo_fatura, data_prazo, numero_contrato, data_contrato }
  const avisos = [];

  let estado = EXPECT_NOME;
  let atual = null; // { nome, telefones: [], tipo_fatura, numero_contrato }

  function novoBloco(nome) {
    return { nome, telefones: [], tipo_fatura: null, numero_contrato: null };
  }

  function finalizarBloco(valor, dataPrazo) {
    if (!atual) return;
    if (atual.telefones.length === 0) {
      avisos.push(`"${atual.nome}" ignorado: nenhum telefone encontrado.`);
    } else {
      const arquivo = `${slugNome(atual.nome)}.pdf`;
      for (const numero of atual.telefones) {
        itens.push({
          nome: atual.nome,
          numero,
          valor: valor ?? null,
          arquivo,
          tipo_fatura: atual.tipo_fatura ?? null,
          data_prazo: dataPrazo ?? null,
          numero_contrato: atual.numero_contrato ?? null,
          // Nenhum formato de lista crua observado até hoje traz uma data de
          // contrato distinta da data de prazo (ver comentário no topo do
          // arquivo) -- fica reservado pra quando/se isso aparecer.
          data_contrato: null,
        });
      }
    }
    atual = null;
    estado = EXPECT_NOME;
  }

  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];

    if (estado === EXPECT_NOME) {
      if (ehSeparador(l)) continue;
      if (ehLinhaNome(l)) {
        atual = novoBloco(l);
        estado = EXPECT_CONTRATO;
      }
      // linha "solta" que não parece nome (lixo entre blocos) -- ignora e segue
      continue;
    }

    if (estado === EXPECT_CONTRATO) {
      if (ehSeparador(l)) continue;
      if (ehLinhaDigitos(l)) {
        atual.numero_contrato = l.replace(/\D/g, '');
        estado = EXPECT_CPF;
        continue;
      }
      // bloco sem contrato (raro/malformado) -- se já veio CPF ou telefone, segue o fluxo
      if (ehLinhaCpf(l)) {
        estado = COLETANDO_TELEFONES;
        continue;
      }
      if (ehLinhaNome(l)) {
        // nome novo sem nunca ter achado contrato/telefone -- descarta o anterior
        finalizarBloco(null, null);
        atual = novoBloco(l);
        estado = EXPECT_CONTRATO;
      }
      continue;
    }

    if (estado === EXPECT_CPF) {
      if (ehSeparador(l)) continue;
      if (ehLinhaCpf(l)) {
        estado = COLETANDO_TELEFONES;
        continue;
      }
      if (ehLinhaNome(l)) {
        finalizarBloco(null, null);
        atual = novoBloco(l);
        estado = EXPECT_CONTRATO;
      }
      continue;
    }

    if (estado === COLETANDO_TELEFONES) {
      if (ehSeparador(l)) continue;
      if (ehLinhaDigitos(l)) {
        atual.telefones.push(l.replace(/\D/g, ''));
        continue;
      }
      if (ehLinhaFatura(l)) {
        atual.tipo_fatura = tipoFaturaDeLinha(l);
        estado = EXPECT_VALOR;
        continue;
      }
      if (ehLinhaValor(l)) {
        // "Fatura N" ausente, valor vem direto (sem prazo -- formato antigo)
        finalizarBloco(parseValor(l), null);
        continue;
      }
      if (ehLinhaNome(l)) {
        // bloco terminou sem Fatura/valor (ex: MARIA ZENIR... no exemplo real)
        finalizarBloco(null, null);
        atual = novoBloco(l);
        estado = EXPECT_CONTRATO;
      }
      continue;
    }

    if (estado === EXPECT_VALOR) {
      if (ehSeparador(l)) continue;
      if (ehLinhaComData(l)) {
        // Sem linha de valor separada -- essa linha já é a de prazo (ex.:
        // "Fatura N" seguido direto de "— DD/MM/AAAA", sem a linha
        // R$/— do meio).
        finalizarBloco(null, parseDataBr(l));
        continue;
      }
      if (ehLinhaValor(l)) {
        atual.valorPendente = parseValor(l);
        estado = EXPECT_PRAZO;
        continue;
      }
      if (ehLinhaNome(l)) {
        // "Fatura N" veio mas não tinha linha de valor nem de prazo depois
        finalizarBloco(null, null);
        atual = novoBloco(l);
        estado = EXPECT_CONTRATO;
      }
      continue;
    }

    if (estado === EXPECT_PRAZO) {
      if (ehSeparador(l)) continue;
      if (ehLinhaComData(l)) {
        finalizarBloco(atual.valorPendente, parseDataBr(l));
        continue;
      }
      if (ehLinhaNome(l)) {
        // valor veio, mas a linha de prazo não -- finaliza só com o que tem
        finalizarBloco(atual.valorPendente, null);
        atual = novoBloco(l);
        estado = EXPECT_CONTRATO;
      }
      continue;
    }
  }

  // Último bloco do arquivo (EOF sem Fatura/valor/prazo -- comum quando o
  // texto foi cortado). Se já tinha um valor pendente (parou bem depois da
  // linha de valor, sem a de prazo), preserva-o.
  finalizarBloco(atual?.valorPendente ?? null, null);

  return { itens, avisos };
}
