// Normaliza um telefone BR para o formato completo com código do país (ex: 5511999999999).
// Usado tanto para persistir no banco (garante que o unique index em `clientes.telefone`
// realmente evita duplicados, mesmo que a planilha/formulário venha com formatação diferente:
// "(11) 99999-9999", "11 99999-9999", "5511999999999" etc. todos viram o mesmo valor)
// quanto para montar o JID do WhatsApp.
//
// IMPORTANTE: não dá pra decidir "já tem código do país" checando se a string começa com
// "55" (como o código antigo fazia) -- DDD 55 existe de verdade (região de Santa Maria/RS),
// então um número local "55991234567" seria confundido com um número já internacionalizado
// e ficaria faltando o código do país de verdade. Em vez disso, decide pelo tamanho:
// números BR sem código do país têm 10 ou 11 dígitos (DDD + 8 ou 9 dígitos).
export function normalizarTelefone(numero) {
  const limpo = String(numero || '').replace(/\D/g, '');
  if (!limpo) return '';
  return limpo.length <= 11 ? `55${limpo}` : limpo;
}

export function formatJid(numero) {
  return `${normalizarTelefone(numero)}@s.whatsapp.net`;
}
