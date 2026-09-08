import { Router } from 'express';
import { supabase, BUCKET, CHAT_BUCKET, AVATAR_BUCKET } from '../lib/supabase.js';

const router = Router();

// [2026-08] PROXY DE ARQUIVOS: antes, o front recebia direto uma signed URL
// do Supabase Storage (`pdf_url`/`anexo_url`) e usava ela como `href` de um
// `<a target="_blank">`. Isso funciona (o bucket é privado, a URL expira em
// 10min, ver lib/supabase.js), mas quando o navegador abre o PDF/imagem em
// nova aba, a BARRA DE ENDEREÇO mostra a URL real do Supabase
// (https://<projeto>.supabase.co/storage/...) -- isso expõe o nome do
// projeto Supabase pro cliente que só queria ver o boleto.
//
// A troca: o front não recebe mais a signed URL do Supabase, recebe um path
// relativo a este proxy (ver `clientes.routes.js`/`chat.routes.js`/
// `faturas.routes.js`, que agora devolvem uma URL tipo
// "/api/arquivos/faturas/<path>" em vez da signed URL crua). O front busca
// esse path via `fetch` (com o Authorization: Bearer de sempre -- únicos
// dois buckets, os dois já exigem login pra ver, e mesmo com o path exposto
// aqui, o Storage real continua privado, nunca alcançável sem passar por
// este endpoint autenticado), transforma a resposta num Blob e abre uma
// URL "blob:" local (ver `lib/arquivoProtegido.ts` no front) -- a barra de
// endereço passa a mostrar só "blob:https://seudominio.com/..." ou nem
// aparece (dependendo do navegador), nunca o domínio do Supabase.
//
// Por que não um `<a href>` direto pra esta rota: um link de navegação do
// navegador não consegue anexar o header `Authorization` -- só `fetch`
// (chamado do JS) controla headers. Por isso o front busca o Blob primeiro
// e só then abre/baixa; ver o comentário em `arquivoProtegido.ts`.
//
// `:path` pode ter barras (ex: "cliente-123/fatura.pdf") -- usamos `*`
// (wildcard do Express) em vez de `:path` simples, que só casaria um
// segmento sem barra.

const BUCKETS_PERMITIDOS = {
  faturas: BUCKET,
  'chat-midia': CHAT_BUCKET,
  avatars: AVATAR_BUCKET,
};

// [2026-09] CRÍTICO: antes desta checagem, esta era a ÚNICA rota do backend
// que não confirmava se o recurso pedido pertence ao usuario_id logado --
// qualquer operador autenticado que soubesse (ou adivinhasse) o path de um
// arquivo de OUTRO operador conseguia baixá-lo, quebrando o isolamento
// multi-tenant que todo o resto do sistema (clientes/envios/chat/...)
// implementa com cuidado. Agravado na prática porque o UUID do dono aparece
// literalmente no path de `faturas_pendentes` e é devolvido por
// `GET /supervisor/operadores`.
//
// Cada bucket guarda o path numa convenção diferente:
//   - `chat-midia` / `avatars`: SEMPRE `<usuario_id>/...` (ver
//     chat.routes.js / perfil.routes.js) -- checagem é só prefixo.
//   - `faturas`: TRÊS convenções coexistem, todas legadas de features
//     diferentes: `<cliente_id>/...` (upload manual/avulso/extrator, ver
//     clientes.routes.js/faturasPendentes.routes.js), `<usuario_id>/...`
//     (importação em lote client-side, ver importacao.routes.js) e
//     `pendentes/<usuario_id>/...` (fatura avulsa ainda sem cliente
//     casado). Só o caso `<cliente_id>/...` precisa de consulta ao banco
//     pra confirmar o dono -- os outros dois resolvem só olhando o path.
async function caminhoPertenceAoUsuario(bucketApelido, path, usuarioId) {
  const primeiroSegmento = path.split('/')[0];

  if (bucketApelido === 'chat-midia' || bucketApelido === 'avatars') {
    return primeiroSegmento === usuarioId;
  }

  // bucketApelido === 'faturas' a partir daqui.
  if (primeiroSegmento === 'pendentes') {
    return path.split('/')[1] === usuarioId;
  }
  if (primeiroSegmento === usuarioId) return true;

  const { data } = await supabase.from('clientes').select('id').eq('id', primeiroSegmento).eq('usuario_id', usuarioId).maybeSingle();
  return Boolean(data);
}

router.get('/:bucketApelido/*', async (req, res) => {
  const bucketReal = BUCKETS_PERMITIDOS[req.params.bucketApelido];
  if (!bucketReal) {
    return res.status(404).json({ error: 'bucket desconhecido' });
  }

  // O wildcard `*` na rota (`/:bucketApelido/*`) expõe o restante do path
  // (que pode ter barras, ex: "cliente-123/fatura.pdf") em `req.params[0]`
  // -- é assim que o Express (path-to-regexp) sempre lidou com `*` solto na
  // rota, diferente de um `:path` nomeado, que só casaria um segmento sem
  // barra.
  const path = req.params[0];
  if (!path) {
    return res.status(400).json({ error: 'path do arquivo ausente' });
  }

  // Supervisor já enxerga cliente/PDF de QUALQUER operador em outras rotas
  // (ex.: GET /supervisor/clientes monta proxy URL de `faturas` de todo
  // mundo) -- segue liberado aqui, senão essa tela quebraria. Pra qualquer
  // outro papel, 404 (não 403) pra não confirmar que o arquivo existe.
  if (req.user.role !== 'supervisor') {
    const pertence = await caminhoPertenceAoUsuario(req.params.bucketApelido, path, req.user.id);
    if (!pertence) {
      return res.status(404).json({ error: 'arquivo não encontrado' });
    }
  }

  try {
    // TTL curto (60s) -- só usada internamente aqui, pelo próprio backend,
    // pra baixar o arquivo do Storage e repassar; não é exposta ao cliente
    // em nenhum momento, então não precisa dos 10min do TTL padrão.
    const { data, error } = await supabase.storage.from(bucketReal).createSignedUrl(path, 60);
    if (error || !data?.signedUrl) {
      console.error(`[arquivos] falha ao assinar (bucket=${bucketReal}, path=${path}):`, error?.message);
      return res.status(404).json({ error: 'arquivo não encontrado' });
    }

    const respostaStorage = await fetch(data.signedUrl);
    if (!respostaStorage.ok || !respostaStorage.body) {
      return res.status(respostaStorage.status || 502).json({ error: 'falha ao buscar arquivo no storage' });
    }

    // Repassa o Content-Type original (Supabase já infere certo a partir da
    // extensão no upload) -- o front decide o que fazer com o Blob (exibir
    // inline como imagem, abrir como PDF, etc.) a partir dele.
    const contentType = respostaStorage.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = respostaStorage.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Nunca cachear no navegador/CDN intermediário -- o arquivo é sensível
    // (dado pessoal de cliente) e a signed URL de origem já é de curtíssima
    // duração; cachear aqui reintroduziria o mesmo risco que o TTL evita.
    res.setHeader('Cache-Control', 'no-store');

    const bufferArquivo = Buffer.from(await respostaStorage.arrayBuffer());
    res.send(bufferArquivo);
  } catch (err) {
    console.error(`[arquivos] erro ao servir (bucket=${bucketReal}, path=${path}):`, err.message);
    res.status(500).json({ error: 'erro ao buscar arquivo' });
  }
});

export default router;
