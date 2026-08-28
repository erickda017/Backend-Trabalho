import { Router } from 'express';
import multer from 'multer';
import { supabase, AVATAR_BUCKET, urlProxyArquivo } from '../lib/supabase.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB -- é uma foto de perfil, não precisa de mais
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Envie um arquivo de imagem'));
    cb(null, true);
  },
});

// [2026-08] Nome + foto de perfil (ver migration-21-perfil-avatar.sql) --
// antes viviam só no localStorage do navegador. Path fixo por usuário
// (`${id}/avatar`, upload novo sobrescreve via upsert) -- só existe UMA foto
// de perfil de cada vez, diferente do histórico de faturas de um cliente.
async function buscarPerfil(usuarioId, dadosAuth) {
  const { data, error } = await supabase
    .from('perfis')
    .select('id, email, nome, role, avatar_path')
    .eq('id', usuarioId)
    .maybeSingle();
  if (error) throw error;
  return {
    id: dadosAuth.id,
    email: data?.email ?? dadosAuth.email,
    role: data?.role || 'operador',
    nome: data?.nome || null,
    avatar_url: urlProxyArquivo('avatars', data?.avatar_path || null),
  };
}

// Qualquer autenticado pode ver o PRÓPRIO perfil.
router.get('/me', async (req, res) => {
  try {
    res.json(await buscarPerfil(req.user.id, req.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualiza nome e/ou foto do próprio perfil. multipart/form-data:
// `nome` (texto, opcional) + `foto` (arquivo de imagem, opcional) +
// `remover_foto` ("true", opcional -- apaga a foto atual sem enviar outra).
router.put('/me', upload.single('foto'), async (req, res) => {
  const usuarioId = req.user.id;
  const { nome, remover_foto: removerFoto } = req.body || {};
  const atualizacao = {};

  if (typeof nome === 'string') atualizacao.nome = nome.trim().slice(0, 60) || null;

  const caminhoAvatar = `${usuarioId}/avatar`;
  if (req.file) {
    const { error: uploadError } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(caminhoAvatar, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (uploadError) return res.status(500).json({ error: uploadError.message });
    atualizacao.avatar_path = caminhoAvatar;
  } else if (removerFoto === 'true' || removerFoto === '1') {
    await supabase.storage.from(AVATAR_BUCKET).remove([caminhoAvatar]).catch(() => {});
    atualizacao.avatar_path = null;
  }

  if (Object.keys(atualizacao).length) {
    const { error } = await supabase.from('perfis').update(atualizacao).eq('id', usuarioId);
    if (error) return res.status(500).json({ error: error.message });
  }

  try {
    res.json(await buscarPerfil(usuarioId, req.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
