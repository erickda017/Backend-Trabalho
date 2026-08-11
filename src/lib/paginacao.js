// Lê `page`/`per_page` da query string e devolve { page, perPage, from, to }
// prontos pra usar em `.range(from, to)` do supabase-js.
export function lerPaginacao(query, { perPageDefault = 20, perPageMax = 200 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const perPage = Math.min(perPageMax, Math.max(1, parseInt(query.per_page, 10) || perPageDefault));
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;
  return { page, perPage, from, to };
}
