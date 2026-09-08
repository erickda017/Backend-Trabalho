// [2026-09] Wrapper genérico pro erro do multer (arquivo grande, campo
// errado) NÃO cair no handler de erro global do Express (500 genérico) --
// devolve 413/400 com mensagem em PT-BR, igual importacao.routes.js e
// pix.routes.js já faziam cada um com sua própria cópia local dessa função.
// clientes.routes.js/faturasPendentes.routes.js/chat.routes.js recebiam PDF/
// anexo sem esse wrapper -- um arquivo grande demais nessas rotas caía no
// 500 genérico em vez do 413 amigável que o resto do sistema já padronizou.
export function comTratamentoDeErroUpload(middlewareMulterSingle, { limiteMb, logPrefixo = '[upload]' } = {}) {
  return function (req, res, next) {
    middlewareMulterSingle(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `Arquivo muito grande${limiteMb ? ` (limite: ${limiteMb}MB)` : ''}.` });
      }
      console.error(`${logPrefixo} erro no upload (multer):`, err.message);
      return res.status(400).json({ error: err.message || 'Erro ao processar o upload' });
    });
  };
}
