// Integração EnnyChat -- regra ESTRITA de vínculo PDF/Pix ao cliente. PURA.
// Exige igualdade exata de OS, nome e vencimento (PDF x cadastro persistido) +
// Pix válido. Sem aproximação de nome, sem tolerância de data, sem fallback
// por telefone: qualquer ausência/divergência => pendente_revisao com motivo.
import { normalizarTexto } from '../nomeMatch.js';
import { formatarDataCivil } from './payload.js';

// PDF de verdade começa com "%PDF-" (contrato: sem tolerar lixo antes do cabeçalho).
export function ehPdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

// Chave da OS = a MESMA regra do site (frontend/src/lib/casarPlanilhaPix.ts, chaveOs): trecho depois da última
// "/", só dígitos, sem zeros à esquerda. "010/022067040" e "22067040" => "22067040". O que vem ANTES da barra
// (prefixo do boleto) não entra na comparação. Aplicada aos dois lados (cadastro e PDF); sem dígitos => null.
export function osDoCodigo(valor) {
  if (valor === null || valor === undefined) return null;
  const s = String(valor);
  const depoisDaBarra = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
  const chave = depoisDaBarra.replace(/\D/g, '').replace(/^0+/, '');
  return chave || null;
}

// Só caixa/acento/espaços -- nada de "contém" ou parecido.
export function nomeCanonico(valor) {
  const s = normalizarTexto(valor).replace(/\s+/g, ' ').trim();
  return s || null;
}

// DD/MM/AAAA (ou D/M/AAAA, com / . -) e AAAA-MM-DD -> "DD/MM/AAAA"; inválida => null.
export function vencimentoCanonico(valor) {
  const s = String(valor ?? '').trim();
  const br = /^(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4})$/.exec(s);
  if (br) return formatarDataCivil(Number(br[3]), Number(br[2]), Number(br[1]));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return iso ? formatarDataCivil(Number(iso[1]), Number(iso[2]), Number(iso[3])) : null;
}

// alvo = cliente PERSISTIDO { os_numero, nome, vencimento }; extraido = PDF { codigo, nome, vencimento };
// pixValido = isValidPixPayload do que foi lido no PDF.
// -> { estado: 'vinculado'|'pendente_revisao', motivo, verificacoes: {os,nome,vencimento,pix} }
export function avaliarVinculo({ alvo, extraido, pixValido }) {
  const a = { os: osDoCodigo(alvo?.os_numero), nome: nomeCanonico(alvo?.nome), vencimento: vencimentoCanonico(alvo?.vencimento) };
  const p = { os: osDoCodigo(extraido?.codigo), nome: nomeCanonico(extraido?.nome), vencimento: vencimentoCanonico(extraido?.vencimento) };

  const bate = (campo) => a[campo] !== null && p[campo] !== null && a[campo] === p[campo];
  const verificacoes = { os: bate('os'), nome: bate('nome'), vencimento: bate('vencimento'), pix: pixValido === true };

  let motivo = null;
  if (Object.values(p).some((v) => v === null)) motivo = 'extracao_falhou';
  else if (Object.values(a).some((v) => v === null)) motivo = 'campo_ausente';
  else if (!verificacoes.os) motivo = 'os_divergente';
  else if (!verificacoes.nome) motivo = 'nome_divergente';
  else if (!verificacoes.vencimento) motivo = 'vencimento_divergente';
  else if (!verificacoes.pix) motivo = 'sem_pix';

  return { estado: motivo ? 'pendente_revisao' : 'vinculado', motivo, verificacoes };
}
