import { supabase } from './supabase.js';

// Registra uma exclusão na tabela auditoria_exclusoes (LGPD: rastreabilidade
// de operações sobre dados pessoais -- quem apagou o quê e quando).
// Nunca lança: uma falha ao gravar auditoria não pode impedir/reverter a
// exclusão em si (a operação principal já aconteceu quando chamamos isso).
// Loga o erro pra não passar em silêncio, mas segue a vida.
export async function registrarAuditoriaExclusao({ entidade, entidadeId, usuario, detalhes }) {
  try {
    const { error } = await supabase.from('auditoria_exclusoes').insert({
      entidade,
      entidade_id: String(entidadeId),
      usuario_id: usuario?.id || null,
      usuario_email: usuario?.email || null,
      detalhes: detalhes || null,
    });
    if (error) {
      console.error(`[auditoria] falha ao registrar exclusão (${entidade}/${entidadeId}):`, error.message);
    }
  } catch (err) {
    console.error(`[auditoria] exceção ao registrar exclusão (${entidade}/${entidadeId}):`, err.message);
  }
}
