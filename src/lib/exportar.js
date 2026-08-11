import XLSX from 'xlsx';

function paraCsv(linhas) {
  if (!linhas.length) return '';
  const colunas = Object.keys(linhas[0]);
  const escapar = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cabecalho = colunas.join(';');
  const corpo = linhas.map((linha) => colunas.map((c) => escapar(linha[c])).join(';'));
  return [cabecalho, ...corpo].join('\n');
}

function paraXlsx(linhas) {
  const planilha = XLSX.utils.json_to_sheet(linhas);
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
