// Achata o formato de join do Supabase `cliente_tags(tags(id, nome, cor))`
// pra um array simples `tags: [{id, nome, cor}]` -- usado por toda rota que
// devolve cliente(s) com tags (clientes, qualidade, supervisor). Extraída pra
// cá porque as 3 rotas tinham cada uma sua própria cópia idêntica desta
// função.
export function achatarTags({ cliente_tags, ...resto }) {
  return { ...resto, tags: (cliente_tags || []).map((ct) => ct.tags).filter(Boolean) };
}
