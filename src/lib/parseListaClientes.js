// Faz o parse de uma lista "crua" de clientes no formato usado nos relatórios de
// cobrança (ver docs/ou exemplo enviado pelo usuário): blocos de texto separados
// por linhas em branco/"#####", cada bloco tendo, NESSA ORDEM:
//   NOME (linha só com letras/espaços, tudo maiúsculo)
//   contrato (linha só com dígitos -- IGNORADO)
//   "CPF ###.###.###-##" (IGNORADO -- às vezes vem CNPJ mesmo rotulado "CPF")
//   um ou mais telefones (uma linha por número, só dígitos)
//   "Fatura N" (IGNORADO -- opcional, alguns blocos não têm)
//   "R$ 123,45" ou "—" (valor da fatura -- opcional)
//
// Não dá pra confiar no tamanho do número pra distinguir contrato de telefone
// (varia de 6 a 9 dígitos nos dois), então a distinção é por POSIÇÃO no bloco:
// o primeiro número após o nome é sempre contrato, os números depois do CPF são
// sempre telefone -- até aparecer "Fatura" ou um novo nome.
//
// Retorna um item POR TELEFONE (cliente com 2 números vira 2 linhas), já no
// formato que a planilha modelo usa: { nome, numero, valor, arquivo }.

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

// Nome: tem letra, não é nenhum dos casos acima.
function ehLinhaNome(l) {
  if (ehSeparador(l) || ehLinhaDigitos(l) || ehLinhaCpf(l) || ehLinhaFatura(l) || ehLinhaValor(l)) return false;
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

export function parseListaClientes(textoCru) {
  const linhas = String(textoCru || '')
    .split(/\r?\n/)
    .map(normalizarLinha);

  const itens = []; // { nome, numero, valor, arquivo }
  const avisos = [];

  let estado = EXPECT_NOME;
  let atual = null; // { nome, telefones: [] }

  function finalizarBloco(valor) {
    if (!atual) return;
    if (atual.telefones.length === 0) {
      avisos.push(`"${atual.nome}" ignorado: nenhum telefone encontrado.`);
    } else {
      const arquivo = `${slugNome(atual.nome)}.pdf`;
      for (const numero of atual.telefones) {
        itens.push({ nome: atual.nome, numero, valor: valor ?? null, arquivo });
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
        atual = { nome: l, telefones: [] };
        estado = EXPECT_CONTRATO;
      }
      // linha "solta" que não parece nome (lixo entre blocos) -- ignora e segue
      continue;
    }

    if (estado === EXPECT_CONTRATO) {
      if (ehSeparador(l)) continue;
      if (ehLinhaDigitos(l)) {
        estado = EXPECT_CPF; // contrato ignorado de propósito
        continue;
      }
      // bloco sem contrato (raro/malformado) -- se já veio CPF ou telefone, segue o fluxo
      if (ehLinhaCpf(l)) {
        estado = COLETANDO_TELEFONES;
        continue;
      }
      if (ehLinhaNome(l)) {
        // nome novo sem nunca ter achado contrato/telefone -- descarta o anterior
        finalizarBloco(null);
        atual = { nome: l, telefones: [] };
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
        finalizarBloco(null);
        atual = { nome: l, telefones: [] };
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
        estado = EXPECT_VALOR;
        continue;
      }
      if (ehLinhaValor(l)) {
        // "Fatura N" ausente, valor vem direto
        finalizarBloco(parseValor(l));
        continue;
      }
      if (ehLinhaNome(l)) {
        // bloco terminou sem Fatura/valor (ex: MARIA ZENIR... no exemplo real)
        finalizarBloco(null);
        atual = { nome: l, telefones: [] };
        estado = EXPECT_CONTRATO;
      }
      continue;
    }

    if (estado === EXPECT_VALOR) {
      if (ehSeparador(l)) continue;
      if (ehLinhaValor(l)) {
        finalizarBloco(parseValor(l));
        continue;
      }
      if (ehLinhaNome(l)) {
        // "Fatura N" veio mas não tinha linha de valor depois
        finalizarBloco(null);
        atual = { nome: l, telefones: [] };
        estado = EXPECT_CONTRATO;
      }
      continue;
    }
  }

  // Último bloco do arquivo (EOF sem Fatura/valor -- comum quando o texto foi cortado)
  finalizarBloco(null);

  return { itens, avisos };
}
