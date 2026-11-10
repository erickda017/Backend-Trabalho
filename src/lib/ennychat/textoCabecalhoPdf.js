// Porte, para o backend, de Front-Trabalho/src/lib/textoCabecalhoPdf.ts (só a parte
// de TEXTO: extrairCamposDoTexto, linhasDoTopo, extrairCamposPorTexto). Mantenha as
// duas em sincronia -- se a regra de leitura mudar lá, mude aqui (e o teste).
// Sem OCR: lê a camada de texto do PDF via pdfjs `getTextContent`. PDF imagem
// (sem texto) cai no Worker em services/ennychatExtracao.js.
//
// Precisão acima de cobertura: só aceita Código/Vencimento vindos de um RÓTULO
// ("Código", "Vencimento") -- nunca "a primeira data/número que aparecer". Campo
// não achado fica null (nunca chuta).
//
// campos: { codigo, vencimento ("DD/MM/AAAA"), valor ("123,45"), nome,
//           linhaDigitavel (só dígitos), pixCopiaColaTexto (Pix impresso como texto) }

// Palavras que são RÓTULO, nunca parte de nome (onde o nome para).
const RE_ROTULO =
  /^(?:c[óo]d(?:igo)?\.?|cliente|venc(?:imento|to)?\.?|valor|total|cpf|cnpj|emiss[ãa]o|data|n[ºo°]\.?|contrato|plano|refer[êe]ncia|m[êe]s|fatura|endere[çc]o)[:.]?$/i;

const DATA = String.raw`(\d{2})\s*[/.-]\s*(\d{2})\s*[/.-]\s*(\d{4})`;

function dataValida(d, m, a) {
  const [dia, mes, ano] = [Number(d), Number(m), Number(a)];
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || ano < 2000 || ano > 2100) return null;
  return `${d}/${m}/${a}`;
}

// Texto já em linhas (ordem de leitura). Linhas são juntadas com " | " pra
// rótulo e valor em linhas vizinhas ("Vencimento" / "10/08/2026") ainda
// casarem, sem deixar o regex atravessar o documento inteiro.
export function extrairCamposDoTexto(linhas) {
  const texto = linhas
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' | ');

  // "Código: 010/022067040", "Cód. Cliente 22067040", "CODIGO DO CLIENTE: ..."
  // Exige rótulo e ≥ 6 dígitos (OS real); não confunde com "Código de barras".
  const mCodigo =
    /c[óo]d(?:igo)?\.?(?!\s*(?:de\s+)?barras)(?:\s+(?:do\s+)?(?:cliente|assinante|contrato))?\s*[:\-–]?\s*(?:\|\s*)?(\d{1,4}\s*\/\s*\d{4,}|\d{6,})/i.exec(
      texto,
    );
  const codigo = mCodigo ? mCodigo[1].replace(/\s+/g, '') : null;

  // Vencimento: data logo depois do rótulo (até ~40 caracteres, pode pular
  // pra linha seguinte). "Vencimento", "Venc.", "Vencto", "Data de vencimento".
  let vencimento = null;
  const reVenc = new RegExp(String.raw`venc(?:imento|to)?\.?[^\d|]{0,25}(?:\|[^\d|]{0,25})?` + DATA, 'gi');
  for (const m of texto.matchAll(reVenc)) {
    vencimento = dataValida(m[1], m[2], m[3]);
    if (vencimento) break;
  }

  // Valor: "Valor", "Valor do documento", "Total a pagar" seguido de R$ x,xx.
  const mValor =
    /(?:valor(?:\s+(?:do\s+documento|cobrado|a\s+pagar|total))?|total\s+a\s+pagar)[^\d|]{0,25}(?:\|[^\d|]{0,10})?(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})\b/i.exec(
      texto,
    );
  const valor = mValor ? mValor[1] : null;

  // Nome: depois de "Cliente"/"Nome"/"Titular"/"Pagador", mínimo 2 palavras,
  // parando no próximo rótulo ("... SILVA Cód. Cliente" -> "... SILVA").
  let nome = null;
  const mNome =
    /(?:nome\s+do\s+(?:cliente|titular|assinante)|cliente|nome|titular|pagador|assinante)\s*[:\-–]?\s*(?:\|\s*)?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'.]+(?:\s+[A-Za-zÀ-ÿ'.]+){1,9})/i.exec(
      texto,
    );
  if (mNome) {
    const palavras = [];
    for (const p of mNome[1].split(/\s+/)) {
      if (RE_ROTULO.test(p)) break;
      palavras.push(p);
    }
    if (palavras.length >= 2) nome = palavras.join(' ');
  }

  // Linha digitável: boleto bancário (47) ou concessionária (48 dígitos),
  // impressa com pontos/espaços.
  let linhaDigitavel = null;
  for (const m of texto.matchAll(/(?:\d[\d.\s]{44,60}\d)/g)) {
    const digitos = m[0].replace(/\D/g, '');
    if (digitos.length === 47 || digitos.length === 48) {
      linhaDigitavel = digitos;
      break;
    }
  }

  const mPix = /000201[0-9A-Za-z .:/@*\-_+]{40,}?6304[0-9A-Fa-f]{4}/.exec(texto.replace(/\s*\|\s*/g, ''));
  return {
    codigo,
    vencimento,
    valor,
    nome,
    linhaDigitavel,
    pixCopiaColaTexto: mPix ? mPix[0].replace(/\s/g, '') : null,
  };
}

// Rótulos que, em fatura em TABELA, ficam numa linha com o valor embaixo:
//   Cliente            Código          Vencimento
//   ANA T. G. DA SILVA 010/004202130   15/07/2026
const RE_ROTULO_TABELA =
  /^(?:c[óo]d(?:igo)?\.?(?:\s+(?:do\s+)?(?:cliente|assinante|contrato))?|venc(?:imento|to)?\.?|data\s+de\s+vencimento|valor(?:\s+a\s+pagar|\s+do\s+documento|\s+total)?|total\s+a\s+pagar|cliente|nome(?:\s+do\s+cliente)?|titular|pagador)\s*:?$/i;

// Itens de texto -> segmentos (itens vizinhos na mesma linha, com espaço
// pequeno entre eles, viram um pedaço só: "Código" "do" "Cliente").
function segmentos(itens) {
  const ordenados = [...itens].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  const linhas = [];
  let yAtual = Number.NaN;
  for (const i of ordenados) {
    const y = i.transform[5];
    const x0 = i.transform[4];
    const tamanhoFonte = Math.abs(i.transform[0]) || 10;
    const x1 = x0 + (i.width ?? i.str.length * tamanhoFonte * 0.5);
    if (!(Math.abs(y - yAtual) <= 3)) {
      linhas.push([]);
      yAtual = y;
    }
    const linha = linhas[linhas.length - 1];
    const ultimo = linha[linha.length - 1];
    // Espaço maior que ~1,5 caractere separa colunas.
    if (ultimo && x0 - ultimo.x1 <= tamanhoFonte * 1.5) {
      ultimo.texto += (x0 - ultimo.x1 > tamanhoFonte * 0.15 ? ' ' : '') + i.str;
      ultimo.x1 = x1;
    } else {
      linha.push({ texto: i.str, x0, x1, y });
    }
  }
  return linhas.map((l) => l.map((sg) => ({ ...sg, texto: sg.texto.replace(/\s+/g, ' ').trim() })).filter((sg) => sg.texto));
}

// Pares "Rótulo: valor" de tabela: pra cada segmento que é só um rótulo,
// o segmento da linha de baixo (até 3 linhas) que mais se sobrepõe na
// horizontal. Vira uma linha sintética "Código: 010/004202130".
function paresDeTabela(linhas) {
  const pares = [];
  linhas.forEach((linha, li) => {
    for (const rotulo of linha) {
      if (!RE_ROTULO_TABELA.test(rotulo.texto)) continue;
      for (const abaixo of linhas.slice(li + 1, li + 4)) {
        let melhor = null;
        let melhorSobreposicao = 0;
        for (const sg of abaixo) {
          const sobreposicao = Math.min(rotulo.x1, sg.x1) - Math.max(rotulo.x0, sg.x0);
          // Alinhado pela esquerda também conta (valor mais largo que o rótulo).
          const alinhado = Math.abs(sg.x0 - rotulo.x0) <= 12;
          const pontos = sobreposicao > 0 ? sobreposicao : alinhado ? 1 : 0;
          if (pontos > melhorSobreposicao && !RE_ROTULO_TABELA.test(sg.texto)) {
            melhor = sg;
            melhorSobreposicao = pontos;
          }
        }
        if (melhor) {
          pares.push(`${rotulo.texto.replace(/:$/, '')}: ${melhor.texto}`);
          break;
        }
      }
    }
  });
  return pares;
}

// Linhas de texto (ordem de leitura) da faixa de cima da página: `fracao`
// = quanto da altura, a partir do topo (0.25 = quarto de cima). Os pares
// de tabela vêm PRIMEIRO (mais precisos), seguidos das linhas normais.
export async function linhasDoTopo(pagina, fracao) {
  const altura = pagina.getViewport({ scale: 1 }).height;
  const conteudo = await pagina.getTextContent();
  const limiteY = altura * (1 - fracao); // y do PDF cresce de baixo pra cima
  const itens = conteudo.items.filter((i) => typeof i.str === 'string' && i.str.trim() && i.transform[5] >= limiteY);
  const linhas = segmentos(itens);
  return [...paresDeTabela(linhas), ...linhas.map((l) => l.map((sg) => sg.texto).join('   '))];
}

// ~0 caracteres = PDF escaneado (só imagem): aí o Worker (OCR) é o único caminho.
async function temCamadaDeTexto(pagina) {
  const conteudo = await pagina.getTextContent();
  const total = conteudo.items.reduce((s, i) => s + (i.str?.trim().length ?? 0), 0);
  return total >= 20;
}

// Faixas tentadas, da menor pra maior: para assim que achar Código + Vencimento.
const FRACOES = [0.25, 0.5, 1];

// Procura nas primeiras `maxPaginas` páginas (1ª pode ser propaganda). Combina
// campos de faixas/páginas diferentes sem sobrescrever o que já foi achado (o
// primeiro achado, mais perto do topo, vale).
export async function extrairCamposPorTexto(doc, maxPaginas = 3) {
  const acumulado = { codigo: null, vencimento: null, valor: null, nome: null, linhaDigitavel: null, pixCopiaColaTexto: null };
  let algumaComTexto = false;
  const paginas = Math.min(doc.numPages, maxPaginas);
  for (let p = 1; p <= paginas; p++) {
    const pagina = await doc.getPage(p);
    try {
      if (!(await temCamadaDeTexto(pagina))) continue;
      algumaComTexto = true;
      for (const fracao of FRACOES) {
        const campos = extrairCamposDoTexto(await linhasDoTopo(pagina, fracao));
        for (const k of Object.keys(acumulado)) acumulado[k] ??= campos[k];
        if (acumulado.codigo && acumulado.vencimento) {
          // Linha digitável/Pix impresso ficam no rodapé: varre a página
          // inteira só pra esses dois.
          if (fracao < 1 && (!acumulado.linhaDigitavel || !acumulado.pixCopiaColaTexto)) {
            const inteira = extrairCamposDoTexto(await linhasDoTopo(pagina, 1));
            acumulado.linhaDigitavel ??= inteira.linhaDigitavel;
            acumulado.pixCopiaColaTexto ??= inteira.pixCopiaColaTexto;
          }
          return { ...acumulado, semTexto: false };
        }
      }
    } finally {
      try {
        pagina.cleanup();
      } catch {
        /* noop */
      }
    }
  }
  return { ...acumulado, semTexto: !algumaComTexto };
}
