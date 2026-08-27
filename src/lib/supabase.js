import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// createClient() joga uma exceção SÍNCRONA se a URL vier vazia/inválida — isso
// acontecia direto no `import` deste arquivo, antes até do server.js conseguir
// chamar app.listen(), derrubando o processo sem nem logar o aviso de env var
// faltando. Usamos uma URL de placeholder válida (nunca alcançável de verdade) só
// pra o client conseguir ser instanciado; qualquer chamada real vai falhar de forma
// assíncrona normal (capturada pelos .catch() em server.js) até a env var certa ser
// configurada no Render.
const url = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-key';

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

export const BUCKET = process.env.SUPABASE_BUCKET || 'faturas';

// Bucket separado pra mídia trocada no Chat (fotos/áudios/documentos recebidos ou
// enviados por lá) -- fica isolado do bucket de faturas (BUCKET) de propósito.
export const CHAT_BUCKET = process.env.SUPABASE_CHAT_BUCKET || 'chat-midia';

// [2026-08] SEGURANÇA: os dois buckets acima guardam documentos com dados
// pessoais de cliente (nome, endereço, CPF impresso no PDF da fatura/boleto,
// fotos/áudios trocados no chat). Eles são PRIVADOS agora (ver migration de
// segurança) -- nunca usar supabase.storage.from(BUCKET).getPublicUrl() de
// novo, a URL pública funcionaria pra sempre pra qualquer um que a obtivesse
// (log, print, referrer, link compartilhado), sem checar login nenhum.
//
// Em vez disso, toda leitura de PDF/mídia passa por aqui: gera uma Signed URL
// (assinada com a service_role key, só o backend consegue gerar) que expira
// sozinha depois de `SIGNED_URL_TTL_SEGUNDOS`. O front sempre recebe uma URL
// já assinada e de curta duração, nunca o path cru nem uma URL permanente.
//
// TTL padrão: 10 minutos. Curto o bastante pra não valer a pena vazar/guardar
// a URL, longo o bastante pra abrir o PDF, carregar uma imagem no chat, ou o
// Baileys baixar o arquivo pra mandar no WhatsApp (esse download acontece na
// hora, não precisa de mais que alguns segundos).
const SIGNED_URL_TTL_SEGUNDOS = Number(process.env.SIGNED_URL_TTL_SEGUNDOS || 600);

// Gera uma signed URL pra um path de um bucket privado. Retorna null se o
// path for vazio/nulo (cliente sem PDF, mensagem sem anexo) ou se a geração
// falhar (path não existe mais no Storage, por ex. após a limpeza automática
// apagar o arquivo mas o registro no banco ainda não ter sido atualizado --
// nesse caso é melhor devolver null do que quebrar a resposta inteira).
export async function gerarSignedUrl(bucket, path, ttlSegundos = SIGNED_URL_TTL_SEGUNDOS) {
  if (!path || typeof path !== 'string') return null;
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttlSegundos);
    if (error) {
      console.error(`[storage] erro ao assinar URL (bucket=${bucket}, path=${path}):`, error.message);
      return null;
    }
    return data?.signedUrl || null;
  } catch (err) {
    console.error(`[storage] exceção ao assinar URL (bucket=${bucket}, path=${path}):`, err.message);
    return null;
  }
}

// Assina em lote (Promise.all) -- usado nas rotas de listagem (várias linhas,
// uma signed URL por linha) pra não serializar N chamadas de rede uma atrás
// da outra.
export async function gerarSignedUrls(bucket, paths, ttlSegundos = SIGNED_URL_TTL_SEGUNDOS) {
  return Promise.all(paths.map((path) => gerarSignedUrl(bucket, path, ttlSegundos)));
}

// [2026-08] PROXY DE ARQUIVOS: em vez de expor a signed URL do Supabase
// direto pro front (que a usava como href, revelando o domínio do Supabase
// na barra de endereço quando o navegador abre o PDF/imagem -- ver
// routes/arquivos.routes.js pro proxy que resolve isso), as rotas que
// devolvem `pdf_url`/`anexo_url` agora usam esta função pra montar um path
// RELATIVO ao proxy do próprio backend, nunca ao Supabase.
//
// Mantém a mesma "forma" de resposta que o front já esperava (uma string em
// `pdf_url`) -- só o que tem dentro da string mudou, de uma URL absoluta do
// Supabase pra um path relativo tipo "/api/arquivos/faturas/<path>". O
// front resolve isso com `fetch` + Blob (ver arquivoProtegido.ts), não mais
// com `<a href>` direto.
//
// `bucketApelido` é o nome curto usado na rota do proxy (ver
// BUCKETS_PERMITIDOS em arquivos.routes.js) -- "faturas" ou "chat-midia",
// não o nome real do bucket no Supabase (que pode ser diferente, vem de
// env var). Retorna null se não houver path (mesmo contrato de
// `gerarSignedUrl`, pra não quebrar os callers que já tratam null).
export function urlProxyArquivo(bucketApelido, path) {
  if (!path || typeof path !== 'string') return null;
  return `/api/arquivos/${bucketApelido}/${path}`;
}

export function urlsProxyArquivo(bucketApelido, paths) {
  return paths.map((path) => urlProxyArquivo(bucketApelido, path));
}
