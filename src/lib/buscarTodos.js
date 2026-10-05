// [2026-10] O PostgREST do Supabase corta TODA resposta no "Max rows" do
// projeto (1000 por padrão) -- e `.limit(20000)` NÃO passa por cima disso,
// só pede até 20000 e recebe no máximo 1000, sem erro nenhum. Rotas que
// precisam da lista inteira (planilha do supervisor, casamento de PDF por
// nome) ficavam silenciosamente incompletas acima de 1000 linhas.
// Este helper pagina com `.range()` até esgotar. `montarQuery` precisa
// devolver uma query NOVA a cada chamada (builders do supabase-js são de uso
// único) e com ordenação estável, senão páginas podem repetir/pular linhas.
const TAMANHO_PAGINA = 1000;

export async function buscarTodos(montarQuery, { maxLinhas = 200000 } = {}) {
  const linhas = [];
  for (let from = 0; from < maxLinhas; from += TAMANHO_PAGINA) {
    const { data, error } = await montarQuery().range(from, from + TAMANHO_PAGINA - 1);
    if (error) return { data: null, error };
    linhas.push(...(data || []));
    if (!data || data.length < TAMANHO_PAGINA) break;
  }
  return { data: linhas, error: null };
}
