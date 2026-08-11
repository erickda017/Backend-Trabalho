// Escapa caracteres especiais da sintaxe de filtro do PostgREST (usada dentro de
// `.or()`, `.ilike()` etc: vírgula separa condições, parênteses agrupam, % é
// wildcard) antes de interpolar texto vindo do usuário (ex: campo de busca).
//
// Sem isso, um valor de busca contendo vírgula/parênteses deixava o usuário final
// montar ou quebrar a sintaxe do filtro (ex: "x,telefone.ilike.%25" adicionava uma
// condição extra não pretendida à query). Não é SQL injection clássico -- o
// PostgREST parametriza o SQL de fato -- mas é injeção na sintaxe do FILTRO, o
// que já é suficiente pra vazar linhas que a busca não deveria trazer.
export function escaparFiltroPostgrest(texto) {
  return String(texto).replace(/[%,()]/g, '\\$&');
}
