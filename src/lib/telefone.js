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

// Gera as variações "com o 9º dígito" e "sem o 9º dígito" de um número BR já
// normalizado (com código do país).
//
// POR QUE ISSO EXISTE: celular brasileiro tinha 8 dígitos (depois do DDD) até a
// operadora acrescentar um "9" na frente pra todo mundo, alguns anos atrás. Uma
// planilha antiga, um cadastro feito há tempos, ou até uma exportação de outro
// sistema pode ter o número SEM o 9 (ex: "5511987654321" vira "551187654321").
// O WhatsApp, hoje, sempre te dá o número no formato ATUAL (com 9) no `remoteJid`
// de uma mensagem recebida -- então se o cadastro/conversa tiver salvo a versão
// sem o 9, uma mensagem legítima do MESMO contato não bate com o telefone já
// registrado: gera cliente/conversa "novo" pro sistema, quando é a mesma pessoa.
// Isso é a causa de outro bug relatado: "cliente recebe a fatura e, quando
// responde, vira outro chat com o número/nome dele do WhatsApp".
//
// Não dá pra decidir isso olhando só o número em si (nem todo BR "óbvio" -- DDDs
// de 2 dígitos, mas o dígito de linha pode legitimamente começar com 9 mesmo no
// formato de 8 dígitos em rarésimos planos antigos de fixo/9XXXX). Por isso a
// estratégia é sempre gerar as DUAS variações possíveis e comparar/buscar por
// ambas, em vez de tentar "adivinhar" qual delas é a certa.
export function normalizarVariantes(numero) {
  const base = normalizarTelefone(numero);
  if (!base || !base.startsWith('55') || base.length < 12) return [base].filter(Boolean);

  const resto = base.slice(2); // tira o "55"
  const ddd = resto.slice(0, 2);
  const linha = resto.slice(2);

  const variantes = new Set([base]);
  if (linha.length === 9 && linha.startsWith('9')) {
    variantes.add(`55${ddd}${linha.slice(1)}`); // tira o 9 extra
  } else if (linha.length === 8) {
    variantes.add(`55${ddd}9${linha}`); // acrescenta o 9
  }
  return [...variantes];
}
