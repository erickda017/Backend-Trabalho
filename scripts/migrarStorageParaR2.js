// [2026-10] Copia os arquivos do Supabase Storage (legado) pro Cloudflare R2,
// mantendo a MESMA chave (`<bucket>/<path>`, ver src/lib/armazenamento.js) --
// nada no banco muda. NUNCA apaga nada do Supabase: remover o legado é um
// passo manual, depois de rodar `--verificar` sem pendências.
//
// Uso (na pasta backend/, com o .env de produção: SUPABASE_* + R2_*):
//   node scripts/migrarStorageParaR2.js              -> só conta (simulação)
//   node scripts/migrarStorageParaR2.js --executar   -> copia o que falta
//   node scripts/migrarStorageParaR2.js --verificar  -> confere existência + tamanho
// Pode rodar quantas vezes quiser: o que já está no R2 com o mesmo tamanho é pulado.
import fs from 'node:fs';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { supabase, BUCKET, CHAT_BUCKET, AVATAR_BUCKET } from '../src/lib/supabase.js';
import { configurarR2DoAmbiente, chaveR2, tipoSeguro } from '../src/lib/armazenamento.js';

const BUCKETS = [BUCKET, CHAT_BUCKET, AVATAR_BUCKET, process.env.SUPABASE_PIX_BUCKET || 'pix-extracoes'];
const modo = process.argv.includes('--executar') ? 'executar' : process.argv.includes('--verificar') ? 'verificar' : 'simular';
const CONCORRENCIA = 4;

const r2 = configurarR2DoAmbiente();
if (!r2) {
  console.error('Faltam variáveis R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME.');
  process.exit(1);
}

// Lista recursiva (o list() do Supabase é por "pasta", 1 nível, paginado).
async function listarTudo(bucket, prefixo = '') {
  const arquivos = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(bucket).list(prefixo, { limit: 1000, offset });
    if (error) throw error;
    for (const item of data || []) {
      const caminho = prefixo ? `${prefixo}/${item.name}` : item.name;
      if (item.id === null) arquivos.push(...(await listarTudo(bucket, caminho))); // pasta
      else arquivos.push({ caminho, tamanho: item.metadata?.size ?? null, tipo: item.metadata?.mimetype || 'application/octet-stream' });
    }
    if (!data || data.length < 1000) return arquivos;
  }
}

async function tamanhoNoR2(chave) {
  try {
    return (await r2.s3.send(new HeadObjectCommand({ Bucket: r2.bucketR2, Key: chave }))).ContentLength;
  } catch (err) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function processar(bucket, arq) {
  const chave = chaveR2(bucket, arq.caminho);
  const noR2 = await tamanhoNoR2(chave);
  if (noR2 != null && (arq.tamanho == null || noR2 === arq.tamanho)) return 'ja_no_r2';
  if (modo !== 'executar') return noR2 == null ? 'faltando' : 'tamanho_diferente';

  const { data: blob, error } = await supabase.storage.from(bucket).download(arq.caminho);
  if (error || !blob) throw new Error(`download falhou: ${error?.message}`);
  const bytes = Buffer.from(await blob.arrayBuffer());
  await r2.s3.send(new PutObjectCommand({ Bucket: r2.bucketR2, Key: chave, Body: bytes, ContentType: tipoSeguro(arq.tipo) }));

  const conferido = await tamanhoNoR2(chave);
  if (conferido !== bytes.length) throw new Error(`conferência falhou: R2=${conferido} esperado=${bytes.length}`);
  return 'copiado';
}

const relatorio = { modo, inicio: new Date().toISOString(), buckets: {}, erros: [] };
for (const bucket of BUCKETS) {
  let arquivos;
  try {
    arquivos = await listarTudo(bucket);
  } catch (err) {
    console.warn(`[${bucket}] não listado (bucket inexistente?): ${err.message}`);
    relatorio.buckets[bucket] = { falha_listagem: err.message };
    relatorio.erros.push({ bucket, erro: `listagem: ${err.message}` });
    continue;
  }
  const contagem = { total: arquivos.length, bytes: arquivos.reduce((s, a) => s + (a.tamanho || 0), 0) };
  for (let i = 0; i < arquivos.length; i += CONCORRENCIA) {
    await Promise.all(arquivos.slice(i, i + CONCORRENCIA).map(async (arq) => {
      try {
        const r = await processar(bucket, arq);
        contagem[r] = (contagem[r] || 0) + 1;
      } catch (err) {
        contagem.erro = (contagem.erro || 0) + 1;
        relatorio.erros.push({ bucket, caminho: arq.caminho, erro: err.message });
      }
    }));
    process.stdout.write(`\r[${bucket}] ${Math.min(i + CONCORRENCIA, arquivos.length)}/${arquivos.length}`);
  }
  console.log(`\n[${bucket}]`, contagem);
  relatorio.buckets[bucket] = contagem;
}
relatorio.fim = new Date().toISOString();
const saida = `relatorio-migracao-r2-${modo}-${Date.now()}.json`;
fs.writeFileSync(saida, JSON.stringify(relatorio, null, 2));
console.log(`Relatório: ${saida}`);

const pendentes = Object.values(relatorio.buckets).reduce((s, b) => s + (b.faltando || 0) + (b.tamanho_diferente || 0), 0) + relatorio.erros.length;
if (modo === 'verificar') console.log(pendentes ? `PENDENTE: ${pendentes} arquivo(s) ainda não conferem no R2.` : 'OK: todo arquivo do Supabase existe no R2 com o mesmo tamanho.');
process.exit(pendentes && modo !== 'simular' ? 1 : 0);
