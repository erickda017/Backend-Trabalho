import XLSX from 'xlsx';

function paraCsv(linhas) {
  if (!linhas.length) return '';
  const colunas = Object.keys(linhas[0]);
  const escapar = (v) => {
    // Só strings entram na checagem de fórmula -- números (ex: valor -150.50,
    // um estorno legítimo) não devem ser tratados como possível fórmula.
    if (typeof v !== 'string') {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }
    let s = v;
    // Neutraliza CSV/Formula Injection (CWE-1236): valores que começam com "="
    // ou "@" são interpretados por Excel/Sheets como início de fórmula -- um
    // campo como "nome" vindo de uma planilha importada por qualquer usuário
    // podia virar uma fórmula executável (ex: =HYPERLINK(...)) quando outra
    // pessoa abrisse o CSV exportado no Excel. Prefixar com um apóstrofo força
    // a leitura como texto literal. "+"/"-" isolados ficam de fora de propósito
    // (alta taxa de falso positivo em nomes/valores de negócio legítimos, ex:
    // "-Empresa Beta" ou um valor negativo que já chegou como texto).
    if (/^[=@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cabecalho = colunas.join(';');
  const corpo = linhas.map((linha) => colunas.map((c) => escapar(linha[c])).join(';'));
  return [cabecalho, ...corpo].join('\n');
}

// Mesma neutralização de fórmula aplicada ao caminho XLSX -- json_to_sheet grava
// o valor como veio, então sem isso um XLSX exportado herdava o mesmo risco do CSV.
function neutralizarFormulas(linhas) {
  return linhas.map((linha) => {
    const nova = {};
    for (const [k, v] of Object.entries(linha)) {
      if (typeof v === 'string' && /^[=@\t\r]/.test(v)) {
        nova[k] = `'${v}`;
      } else {
        nova[k] = v;
      }
    }
    return nova;
  });
}

function paraXlsx(linhas) {
  const planilha = XLSX.utils.json_to_sheet(neutralizarFormulas(linhas));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, planilha, 'Dados');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

// Escreve `linhas` (array de objetos simples) como CSV ou XLSX na resposta,
// já com o Content-Disposition de download.
export function responderExportacao(res, formato, nomeArquivo, linhas) {
  if (formato === 'xlsx') {
    const buffer = paraXlsx(linhas);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.xlsx"`);
    return res.send(buffer);
  }

  const csv = paraCsv(linhas);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.csv"`);
  // BOM pra Excel no Windows reconhecer UTF-8 sem virar acento quebrado
  return res.send('\uFEFF' + csv);
}
