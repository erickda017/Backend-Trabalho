// [2026-09] Extraída de clientes.routes.js/faturasPendentes.routes.js, onde
// existia duplicada palavra-por-palavra -- também usada agora por
// chat.routes.js (upload de anexo do chat não sanitizava o nome do arquivo
// antes de usar no object key, diferente das outras rotas de upload).
//
// Sanitiza um nome de arquivo vindo do upload (`req.file.originalname`)
// antes de usar como object key no Storage: sem isso, um nome de arquivo
// malicioso (ex.: "../outra-pasta/arquivo.pdf", ou com caracteres que
// confundem o path) poderia escapar da pasta pretendida.
export function nomeArquivoSeguro(nome, fallback = 'arquivo.pdf') {
  const base = String(nome || fallback).split(/[\\/]/).pop() || fallback;
  return base.replace(/\.\./g, '').replace(/[^a-zA-Z0-9._-]/g, '_') || fallback;
}
