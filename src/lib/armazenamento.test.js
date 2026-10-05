// node --test src/lib/armazenamento.test.js -- sem rede: S3 e Supabase falsos em memória.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { criarArmazenamento, chaveR2, tipoSeguro } from './armazenamento.js';

// S3 falso: guarda objetos num Map e responde aos comandos pelo nome da classe.
function s3Falso() {
  const objetos = new Map();
  const s3 = new S3Client({ region: 'auto', endpoint: 'https://conta.r2.cloudflarestorage.com', credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
  const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  s3.send = async (cmd) => {
    const i = cmd.input;
    switch (cmd.constructor.name) {
      case 'PutObjectCommand': objetos.set(i.Key, { body: Buffer.from(i.Body), tipo: i.ContentType }); return {};
      case 'HeadObjectCommand': if (!objetos.has(i.Key)) throw notFound(); return { ContentLength: objetos.get(i.Key).body.length };
      case 'GetObjectCommand': {
        const o = objetos.get(i.Key);
        if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { ContentType: o.tipo, Body: { transformToByteArray: async () => new Uint8Array(o.body) } };
      }
      case 'DeleteObjectsCommand': i.Delete.Objects.forEach((o) => objetos.delete(o.Key)); return { Deleted: i.Delete.Objects.map((o) => ({ Key: o.Key })) };
      case 'DeleteObjectCommand': objetos.delete(i.Key); return {};
      case 'CopyObjectCommand': objetos.set(i.Key, objetos.get(decodeURIComponent(i.CopySource.slice(i.Bucket.length + 1)))); return {};
      case 'ListObjectsV2Command': return { Contents: [...objetos.keys()].filter((k) => k.startsWith(i.Prefix) && !k.slice(i.Prefix.length).includes('/')).map((Key) => ({ Key })) };
      default: throw new Error(`comando não simulado: ${cmd.constructor.name}`);
    }
  };
  return { s3, objetos };
}

// Supabase Storage falso (mesma forma de retorno do supabase-js).
function legadoFalso(inicial = {}) {
  const arquivos = new Map(Object.entries(inicial));
  return {
    arquivos,
    from: (bucket) => ({
      upload: async (p, corpo) => (arquivos.set(`${bucket}/${p}`, Buffer.from(corpo)), { data: { path: p }, error: null }),
      download: async (p) => (arquivos.has(`${bucket}/${p}`) ? { data: new Blob([arquivos.get(`${bucket}/${p}`)]), error: null } : { data: null, error: new Error('Object not found') }),
      createSignedUrl: async (p, ttl) => (arquivos.has(`${bucket}/${p}`) ? { data: { signedUrl: `https://x.supabase.co/sign/${bucket}/${p}?ttl=${ttl}` }, error: null } : { data: null, error: new Error('Object not found') }),
      remove: async (ps) => ({ data: ps.filter((p) => arquivos.delete(`${bucket}/${p}`)).map((name) => ({ name })), error: null }),
      move: async (de, para) => (arquivos.set(`${bucket}/${para}`, arquivos.get(`${bucket}/${de}`)), arquivos.delete(`${bucket}/${de}`), { data: {}, error: null }),
      list: async () => ({ data: [], error: null }),
    }),
  };
}

test('chaveR2 recusa path traversal / absoluto / vazio', () => {
  assert.equal(chaveR2('faturas', 'cli-1/123-a.pdf'), 'faturas/cli-1/123-a.pdf');
  for (const ruim of ['../x', 'a/../../b', '/etc/passwd', '', 'a/./b', 'a\u0000b']) assert.throws(() => chaveR2('faturas', ruim));
});

test('novo arquivo vai pro R2; leitura e URL assinada vêm do R2', async () => {
  const { s3, objetos } = s3Falso();
  const leg = legadoFalso();
  const a = criarArmazenamento({ s3, bucketR2: 'meu-bucket', legado: leg });
  const { error } = await a.from('faturas').upload('cli-1/1-fatura.pdf', Buffer.from('%PDF-novo'), { contentType: 'application/pdf', upsert: true });
  assert.equal(error, null);
  assert.ok(objetos.has('faturas/cli-1/1-fatura.pdf'));
  assert.equal(leg.arquivos.size, 0, 'não grava mais no Supabase');

  const { data: blob } = await a.from('faturas').download('cli-1/1-fatura.pdf');
  assert.equal(await blob.text(), '%PDF-novo');
  assert.equal(blob.type, 'application/pdf');

  const { data } = await a.from('faturas').createSignedUrl('cli-1/1-fatura.pdf', 60);
  const url = new URL(data.signedUrl);
  assert.match(url.pathname, /faturas\/cli-1\/1-fatura\.pdf$/);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
  assert.ok(!data.signedUrl.includes('supabase'));
});

test('arquivo antigo (só no Supabase) continua legível pelo fallback', async () => {
  const { s3 } = s3Falso();
  const leg = legadoFalso({ 'faturas/cli-9/velho.pdf': Buffer.from('%PDF-velho') });
  const a = criarArmazenamento({ s3, bucketR2: 'b', legado: leg });
  assert.equal(await (await a.from('faturas').download('cli-9/velho.pdf')).data.text(), '%PDF-velho');
  assert.match((await a.from('faturas').createSignedUrl('cli-9/velho.pdf', 60)).data.signedUrl, /supabase\.co/);
});

test('arquivo inexistente em ambos -> erro (não URL inválida)', async () => {
  const a = criarArmazenamento({ s3: s3Falso().s3, bucketR2: 'b', legado: legadoFalso() });
  assert.ok((await a.from('faturas').createSignedUrl('nao/existe.pdf', 60)).error);
  assert.ok((await a.from('faturas').download('nao/existe.pdf')).error);
});

test('TTL da URL assinada tem teto de 1h', async () => {
  const { s3 } = s3Falso();
  const a = criarArmazenamento({ s3, bucketR2: 'b', legado: null });
  await a.from('faturas').upload('c/x.pdf', Buffer.from('x'));
  const url = new URL((await a.from('faturas').createSignedUrl('c/x.pdf', 999999)).data.signedUrl);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '3600');
});

test('remove apaga nos dois e confirma cada path', async () => {
  const { s3, objetos } = s3Falso();
  const leg = legadoFalso({ 'faturas/c/velho.pdf': Buffer.from('v') });
  const a = criarArmazenamento({ s3, bucketR2: 'b', legado: leg });
  await a.from('faturas').upload('c/novo.pdf', Buffer.from('n'));
  const { data, error } = await a.from('faturas').remove(['c/novo.pdf', 'c/velho.pdf']);
  assert.equal(error, null);
  assert.deepEqual(data.map((d) => d.name).sort(), ['c/novo.pdf', 'c/velho.pdf']);
  assert.equal(objetos.size, 0);
  assert.equal(leg.arquivos.size, 0);
});

test('move dentro do R2 e move de arquivo legado', async () => {
  const { s3, objetos } = s3Falso();
  const leg = legadoFalso({ 'faturas/pendentes/u1/velho.pdf': Buffer.from('v') });
  const a = criarArmazenamento({ s3, bucketR2: 'b', legado: leg });
  await a.from('faturas').upload('pendentes/u1/1-a b.pdf', Buffer.from('n'));
  assert.equal((await a.from('faturas').move('pendentes/u1/1-a b.pdf', 'cli-1/1-a b.pdf')).error, null);
  assert.deepEqual([...objetos.keys()], ['faturas/cli-1/1-a b.pdf']);
  assert.equal((await a.from('faturas').move('pendentes/u1/velho.pdf', 'cli-1/velho.pdf')).error, null);
  assert.ok(leg.arquivos.has('faturas/cli-1/velho.pdf'));
});

test('sem R2 configurado tudo continua no Supabase (deploy sem env não quebra)', async () => {
  const leg = legadoFalso();
  const a = criarArmazenamento({ s3: null, bucketR2: null, legado: leg });
  assert.equal(a.r2Ativo, false);
  await a.from('avatars').upload('u1/avatar', Buffer.from('img'), { contentType: 'image/png', upsert: true });
  assert.ok(leg.arquivos.has('avatars/u1/avatar'));
  assert.match((await a.from('avatars').createSignedUrl('u1/avatar', 60)).data.signedUrl, /supabase/);
});

test('list() enxerga arquivo do R2 (diagnóstico do painel de exclusão)', async () => {
  const { s3 } = s3Falso();
  const a = criarArmazenamento({ s3, bucketR2: 'b', legado: legadoFalso() });
  await a.from('faturas').upload('_diagnostico/teste-1.txt', Buffer.from('t'));
  assert.deepEqual((await a.from('faturas').list('_diagnostico')).data.map((f) => f.name), ['teste-1.txt']);
  await a.from('faturas').remove(['_diagnostico/teste-1.txt']);
  assert.deepEqual((await a.from('faturas').list('_diagnostico')).data, []);
});

test('tipo executável (html/svg) nunca é gravado como tal', async () => {
  assert.equal(tipoSeguro('text/html; charset=utf-8'), 'application/octet-stream');
  assert.equal(tipoSeguro('image/svg+xml'), 'application/octet-stream');
  assert.equal(tipoSeguro(''), 'application/octet-stream');
  assert.equal(tipoSeguro('application/pdf'), 'application/pdf');
  assert.equal(tipoSeguro('image/jpeg'), 'image/jpeg');
  const { s3, objetos } = s3Falso();
  const a = criarArmazenamento({ s3, bucketR2: 'b', legado: null });
  await a.from('chat-midia').upload('u1/55/x.html', Buffer.from('<script>alert(1)</script>'), { contentType: 'text/html' });
  assert.equal(objetos.get('chat-midia/u1/55/x.html').tipo, 'application/octet-stream');
});

test('remove NÃO confirma arquivo que não foi apagado (S3 diz "Deleted" até pra chave inexistente)', async () => {
  const { s3 } = s3Falso();
  const leg = legadoFalso(); // arquivo não existe em lugar nenhum
  const a = criarArmazenamento({ s3, bucketR2: 'b', legado: leg });
  const { data, error } = await a.from('faturas').remove(['c/sumiu.pdf']);
  assert.equal(error, null);
  assert.deepEqual(data, [], 'painel de exclusão precisa ver 0 confirmados');
});

test('R2 fora do ar: arquivo antigo segue abrindo pelo Supabase e o erro não vaza detalhe', async () => {
  const { s3 } = s3Falso();
  s3.send = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND conta-secreta.r2.cloudflarestorage.com'), { name: 'Error', $metadata: { httpStatusCode: 503 } }); };
  const leg = legadoFalso({ 'faturas/c/velho.pdf': Buffer.from('v') });
  const a = criarArmazenamento({ s3, bucketR2: 'b', legado: leg });
  assert.equal(await (await a.from('faturas').download('c/velho.pdf')).data.text(), 'v');
  assert.match((await a.from('faturas').createSignedUrl('c/velho.pdf', 60)).data.signedUrl, /supabase/);
  const up = await a.from('faturas').upload('c/novo.pdf', Buffer.from('n'));
  assert.equal(up.error.message, 'falha no armazenamento de arquivos');
  assert.ok(!up.error.message.includes('conta-secreta'));
});
