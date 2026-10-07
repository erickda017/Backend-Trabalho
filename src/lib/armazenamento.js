// [2026-10] Armazenamento de arquivos: Cloudflare R2 (novo) + Supabase Storage
// (legado), atrás da MESMA interface que o código já usava
// (`supabase.storage.from(bucket).upload/download/remove/move/createSignedUrl`).
// Cada chamador só trocou `supabase.storage` por `armazenamento` -- nada de
// path novo, coluna nova ou mudança no front.
//
// Regras:
//   - Chave no R2 = `<bucket>/<path>` (o MESMO path gravado no banco hoje:
//     clientes.pdf_path, mensagens.anexo_path, envios.foto_path...). Um
//     bucket R2 só, privado; o "bucket" do Supabase vira prefixo.
//   - ESCRITA: vai pro R2 quando as 4 variáveis R2_* existem; sem elas, segue
//     no Supabase (deploy sem configurar nada não quebra).
//   - LEITURA / URL assinada: tenta R2, se o objeto não estiver lá cai no
//     Supabase -- arquivos antigos continuam acessíveis durante a migração
//     (scripts/migrarStorageParaR2.js copia o legado pro R2).
//   - DELETE: apaga nos dois (o objeto pode estar em qualquer um).
//   - `STORAGE_LEGADO_SUPABASE=false` desliga o fallback depois que a
//     migração estiver verificada.
// Autorização NÃO mora aqui: continua nas rotas (ex.: arquivos.routes.js
// confere o dono antes de assinar). Credenciais R2 são só do backend.
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { supabase } from './supabase.js';

// Teto da URL assinada, mesmo que alguém peça mais (Baileys/proxy usam 60-600s).
const TTL_MAXIMO_SEGUNDOS = 3600;

// [2026-10] SEGURANÇA (auditoria): path de arquivo vem de URL (proxy
// /api/arquivos), de body (foto_path) e de remetente do WhatsApp (nome do
// documento). Antes só o ramo R2 validava -- e o erro caía no fallback do
// Supabase legado, que monta a URL sem encode: "MEU_ID/../OUTRO/x.pdf",
// "a/%2e%2e/b" ou "a\\..\\b" viravam travessia e o backend assinava (com a
// service_role) arquivo de outro operador/bucket. Agora TODA operação valida
// aqui antes de escolher R2 ou legado.
// Recusa: vazio, barra inicial, barra invertida, caractere de controle e
// segmento "."/".." em qualquer forma que o parser de URL resolve (%2e).
const SEGMENTO_PONTO = /^(?:\.|%2e){1,2}$/i;
export function pathArmazenamentoValido(path) {
  const p = String(path ?? '');
  return Boolean(p) && p.length <= 1024 && !p.startsWith('/') && !/[\\\u0000-\u001f\u007f]/.test(p) && !p.split('/').some((s) => SEGMENTO_PONTO.test(s));
}

export function chaveR2(bucket, path) {
  if (!pathArmazenamentoValido(path)) throw new Error(`path de arquivo inválido: ${String(path ?? '').slice(0, 80)}`);
  return `${bucket}/${path}`;
}

const pathInvalido = () => ({ data: null, error: new Error('path de arquivo inválido') });

// Tipos que o navegador EXECUTA quando o front abre o arquivo como blob: na
// origem do app (HTML/SVG/XML com script). Mimetype vem do cliente (multer /
// WhatsApp) -- esses viram download binário em vez de página.
const TIPOS_EXECUTAVEIS = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript)(?:$|[;\s])/i;
export function tipoSeguro(contentType) {
  const t = String(contentType || '').trim();
  return !t || TIPOS_EXECUTAVEIS.test(t) ? 'application/octet-stream' : t;
}

function naoExiste(err) {
  return err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
}

// Fábrica (testável): `s3` = S3Client (ou null = R2 desligado), `legado` =
// supabase.storage (ou null = sem fallback).
export function criarArmazenamento({ s3, bucketR2, legado }) {
  const r2 = s3 && bucketR2 ? { s3, bucketR2 } : null;

  async function existeNoR2(chave) {
    try {
      const h = await r2.s3.send(new HeadObjectCommand({ Bucket: r2.bucketR2, Key: chave }));
      return { existe: true, tamanho: h.ContentLength ?? null };
    } catch (err) {
      if (naoExiste(err)) return { existe: false };
      throw err;
    }
  }

  // Erro do SDK pode trazer endpoint/account id -- loga o original e devolve
  // mensagem genérica (rotas repassam `error.message` pro cliente).
  function falha(op, bucket, path, err) {
    console.error(`[armazenamento] ${op} falhou (bucket=${bucket}, path=${String(path).slice(0, 120)}):`, err?.name, err?.message);
    return Object.assign(new Error('falha no armazenamento de arquivos'), { causa: err?.name });
  }

  function from(bucket) {
    const leg = legado ? legado.from(bucket) : null;

    return {
      async upload(path, corpo, { contentType, upsert } = {}) {
        if (!pathArmazenamentoValido(path)) return pathInvalido();
        if (!r2) return leg.upload(path, corpo, { contentType: tipoSeguro(contentType), upsert });
        try {
          const chave = chaveR2(bucket, path);
          await r2.s3.send(new PutObjectCommand({
            Bucket: r2.bucketR2,
            Key: chave,
            Body: Buffer.isBuffer(corpo) || corpo instanceof Uint8Array ? corpo : Buffer.from(await new Response(corpo).arrayBuffer()),
            ContentType: tipoSeguro(contentType),
          }));
          return { data: { path }, error: null };
        } catch (err) {
          return { data: null, error: falha('upload', bucket, path, err) };
        }
      },

      // { data: Blob } como o supabase-js. Erro do R2 (fora do ar, 403...) não
      // derruba a leitura de arquivo ainda não migrado: cai no legado.
      async download(path) {
        if (!pathArmazenamentoValido(path)) return pathInvalido();
        if (r2) {
          try {
            const obj = await r2.s3.send(new GetObjectCommand({ Bucket: r2.bucketR2, Key: chaveR2(bucket, path) }));
            const bytes = await obj.Body.transformToByteArray();
            return { data: new Blob([bytes], { type: obj.ContentType || 'application/octet-stream' }), error: null };
          } catch (err) {
            if (!naoExiste(err)) {
              const e = falha('download', bucket, path, err);
              if (!leg) return { data: null, error: e };
            }
          }
        }
        if (leg) return leg.download(path);
        return { data: null, error: new Error('arquivo não encontrado') };
      },

      async createSignedUrl(path, ttlSegundos) {
        if (!pathArmazenamentoValido(path)) return pathInvalido();
        const ttl = Math.max(1, Math.min(Number(ttlSegundos) || 600, TTL_MAXIMO_SEGUNDOS));
        if (r2) {
          try {
            const chave = chaveR2(bucket, path);
            if ((await existeNoR2(chave)).existe) {
              const signedUrl = await getSignedUrl(r2.s3, new GetObjectCommand({ Bucket: r2.bucketR2, Key: chave }), { expiresIn: ttl });
              return { data: { signedUrl }, error: null };
            }
          } catch (err) {
            const e = falha('assinar', bucket, path, err);
            if (!leg) return { data: null, error: e };
          }
        }
        if (leg) return leg.createSignedUrl(path, ttl);
        return { data: null, error: new Error('arquivo não encontrado') };
      },

      // Contrato do Supabase: `data` traz SÓ o que foi apagado de fato
      // (exclusaoCriterios.js confirma pela contagem). DeleteObjects do S3 diz
      // "Deleted" até pra chave inexistente, então no R2 só conta o que o HEAD
      // achou antes; no legado, o que ele confirmar. Erro em qualquer lado =
      // erro (melhor não confirmar do que confirmar errado).
      async remove(paths) {
        // Path inválido fica fora de `data` (quem chama trata como "não
        // removido"); lançar erro derrubaria o lote inteiro da exclusão.
        const lista = (paths || []).filter(Boolean).filter((p) => pathArmazenamentoValido(p) || (console.error('[armazenamento] remove ignorou path inválido'), false));
        if (!r2) return leg.remove(lista);
        if (!lista.length) return { data: [], error: null };
        const removidos = new Set();
        try {
          const chaves = lista.map((p) => chaveR2(bucket, p));
          const existiam = await Promise.all(chaves.map(async (k) => (await existeNoR2(k)).existe));
          const r = await r2.s3.send(new DeleteObjectsCommand({
            Bucket: r2.bucketR2,
            Delete: { Objects: chaves.map((Key) => ({ Key })), Quiet: false },
          }));
          if (r.Errors?.length) return { data: null, error: falha('remover', bucket, r.Errors.map((e) => e.Key).join(','), new Error(r.Errors[0].Message)) };
          lista.forEach((p, idx) => existiam[idx] && removidos.add(p));
        } catch (err) {
          return { data: null, error: falha('remover', bucket, lista[0], err) };
        }
        if (leg) {
          const { data, error } = await leg.remove(lista);
          if (error) return { data: null, error };
          for (const o of data || []) removidos.add(o.name);
        }
        return { data: lista.filter((p) => removidos.has(p)).map((name) => ({ name })), error: null };
      },

      // Objeto no R2: copia + apaga (e apaga a cópia antiga no legado, se
      // houver). Ainda só no legado: move lá mesmo (segue legível pelo
      // fallback; o script de migração leva depois).
      async move(de, para) {
        if (!pathArmazenamentoValido(de) || !pathArmazenamentoValido(para)) return pathInvalido();
        if (r2) {
          try {
            const origem = chaveR2(bucket, de);
            if ((await existeNoR2(origem)).existe) {
              await r2.s3.send(new CopyObjectCommand({
                Bucket: r2.bucketR2,
                Key: chaveR2(bucket, para),
                CopySource: `${r2.bucketR2}/${origem.split('/').map(encodeURIComponent).join('/')}`,
              }));
              await r2.s3.send(new DeleteObjectCommand({ Bucket: r2.bucketR2, Key: origem }));
              if (leg) await leg.remove([de]).catch(() => {});
              return { data: { message: 'ok' }, error: null };
            }
          } catch (err) {
            return { data: null, error: falha('mover', bucket, de, err) };
          }
        }
        if (leg) return leg.move(de, para);
        return { data: null, error: new Error('arquivo não encontrado') };
      },

      // Só o diagnóstico do painel de exclusão usa list() (1 nível, até
      // 1000 itens): junta o que houver no R2 e no legado.
      async list(prefixo = '', opcoes) {
        if (prefixo && !pathArmazenamentoValido(prefixo)) return pathInvalido();
        const nomes = new Map();
        if (r2) {
          try {
            const base = prefixo ? `${chaveR2(bucket, prefixo)}/` : `${bucket}/`;
            const r = await r2.s3.send(new ListObjectsV2Command({ Bucket: r2.bucketR2, Prefix: base, Delimiter: '/' }));
            for (const o of r.Contents || []) nomes.set(o.Key.slice(base.length), { name: o.Key.slice(base.length) });
          } catch (err) {
            return { data: null, error: falha('listar', bucket, prefixo, err) };
          }
        }
        if (leg) {
          const { data, error } = await leg.list(prefixo, opcoes);
          if (error) return { data: null, error };
          for (const o of data || []) nomes.set(o.name, o);
        }
        return { data: [...nomes.values()], error: null };
      },
    };
  }

  return { from, r2Ativo: Boolean(r2), legadoAtivo: Boolean(legado), existeNoR2: r2 ? existeNoR2 : null };
}

export function configurarR2DoAmbiente(env = process.env) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ENDPOINT } = env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !(R2_ACCOUNT_ID || R2_ENDPOINT)) return null;
  const s3 = new S3Client({
    region: 'auto',
    // R2_ENDPOINT só pra teste local (servidor S3 fake); em produção vem do account id.
    endpoint: R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    forcePathStyle: Boolean(R2_ENDPOINT),
    // SDK >= 3.729 manda checksum CRC32 por padrão; Cloudflare recomenda só quando exigido.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { s3, bucketR2: R2_BUCKET_NAME };
}

const r2Ambiente = configurarR2DoAmbiente();
export const armazenamento = criarArmazenamento({
  s3: r2Ambiente?.s3 ?? null,
  bucketR2: r2Ambiente?.bucketR2 ?? null,
  legado: process.env.STORAGE_LEGADO_SUPABASE === 'false' && r2Ambiente ? null : supabase.storage,
});

console.log(
  `[armazenamento] R2 ${armazenamento.r2Ativo ? 'ATIVO (novos arquivos vão pro R2)' : 'desligado (sem R2_* no ambiente -- tudo no Supabase Storage)'}` +
    `${armazenamento.r2Ativo ? `, fallback Supabase ${armazenamento.legadoAtivo ? 'ligado' : 'desligado'}` : ''}`,
);
