import XLSX from 'xlsx';
import { supabase } from '../lib/supabase.js';
import { normalizarTelefone } from '../lib/telefone.js';
import { normalizarTexto } from '../lib/nomeMatch.js';

// Planilha de Ativação Chip é bem diferente da de fatura (nome/telefone/
// valor/vencimento) -- não tem PDF nem OCR envolvido, então (diferente do
// fluxo de importLote.js) o parse inteiro roda aqui no servidor mesmo, sem
// precisar do navegador fazer trabalho pesado antes.
//
// Colunas reais da planilha (ver CONTEXTO.md / spec): OPERADORA, OS, CLIENTE,
// CPF, NM_CIDADE (ou "NOME DA CIDADE"), BKO (RESPONSÁVEL), VENDEDOR,
// TEL 1/2/3. Cada alias abaixo já normalizado (normalizarTexto: sem acento,
// minúsculo) pra comparar com o cabeçalho real da planilha, que pode variar
// um pouco (maiúscula, espaço extra, com/sem parênteses).
const ALIASES = {
  operadora: ['operadora'],
  os_numero: ['os'],
  nome: ['cliente', 'nome'],
  cpf: ['cpf'],
  cidade: ['nm_cidade', 'nome da cidade', 'cidade'],
  bko_responsavel: ['bko (responsavel)', 'bko responsavel', 'bko'],
  vendedor: ['vendedor'],
  telefone: ['tel 1 (telefone)', 'tel 1 (telefone', 'tel 1', 'telefone 1', 'telefone'],
  telefone_2: ['tel 2 (telefone)', 'tel 2 (telefone', 'tel 2', 'telefone 2'],
  telefone_3: ['tel 3 (telefone)', 'tel 3 (telefone', 'tel 3', 'telefone 3'],
};

// Acha, pro campo `campo`, qual chave do objeto-linha (já com os cabeçalhos
// originais da planilha) corresponde -- comparando a versão normalizada do
// cabeçalho com os aliases aceitos.
function acharChave(linhaChaves, aliases) {
  return linhaChaves.find((chave) => aliases.includes(normalizarTexto(chave).replace(/\s+/g, ' ').trim()));
}

function mapearCabecalhos(primeiraLinha) {
  const chaves = Object.keys(primeiraLinha || {});
  const mapa = {};
  for (const [campo, aliases] of Object.entries(ALIASES)) {
    mapa[campo] = acharChave(chaves, aliases);
  }
  return mapa;
}

// Lê o buffer (.xlsx/.xls/.csv) e devolve as linhas já normalizadas pro
// formato que vamos persistir. Não grava nada no banco ainda -- só parse +
// validação (mesmo espírito de POST /clientes/converter-lista, dá chance de
// revisar antes de importar de fato).
export function parsePlanilhaChip(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const primeiraAba = workbook.SheetNames[0];
  if (!primeiraAba) return { itens: [], semDados: [] };

  const linhasCruas = XLSX.utils.sheet_to_json(workbook.Sheets[primeiraAba], { defval: '' });
  if (!linhasCruas.length) return { itens: [], semDados: [] };

  const mapa = mapearCabecalhos(linhasCruas[0]);

  const itens = [];
  const semDados = [];

  for (const linha of linhasCruas) {
    const nome = mapa.nome ? String(linha[mapa.nome] || '').trim() : '';
    const telefoneCru = mapa.telefone ? linha[mapa.telefone] : '';
    const telefone = normalizarTelefone(telefoneCru);

    if (!nome || !telefone) {
      semDados.push({ ...linha, erro: !nome ? 'nome (CLIENTE) ausente' : 'TEL 1 ausente ou inválido' });
      continue;
    }

    itens.push({
      nome,
      telefone,
      telefone_2: mapa.telefone_2 ? normalizarTelefone(linha[mapa.telefone_2]) || null : null,
      telefone_3: mapa.telefone_3 ? normalizarTelefone(linha[mapa.telefone_3]) || null : null,
      operadora: mapa.operadora ? String(linha[mapa.operadora] || '').trim() || null : null,
      os_numero: mapa.os_numero ? String(linha[mapa.os_numero] || '').trim() || null : null,
      cpf: mapa.cpf ? String(linha[mapa.cpf] || '').trim() || null : null,
      cidade: mapa.cidade ? String(linha[mapa.cidade] || '').trim() || null : null,
      bko_responsavel: mapa.bko_responsavel ? String(linha[mapa.bko_responsavel] || '').trim() || null : null,
      vendedor: mapa.vendedor ? String(linha[mapa.vendedor] || '').trim() || null : null,
    });
  }

  return { itens, semDados };
}

const MAX_ITENS = 2000;

// Faz o upsert de fato (por usuario_id+telefone, campanha fixa
// 'chip_ativacao') e monta o lote de envio já pronto pra disparar -- mesmo
// padrão de montarResumoECriarEnvio em importLote.js, mas sem PDF/mensagem
// padrão de fatura (o operador escreve o texto na hora de montar o disparo,
// na tela de Disparos).
export async function processarImportacaoChip({ itens, semDados, usuarioId }) {
  if (!usuarioId) throw new Error('usuarioId é obrigatório');
  if (itens.length > MAX_ITENS) {
    throw new Error(`Lote grande demais (${itens.length} linhas, limite ${MAX_ITENS}). Divida em partes menores.`);
  }

  const criados = [];
  const erros = [...semDados];

  for (const item of itens) {
    const { data, error } = await supabase
      .from('clientes')
      .upsert(
        {
          usuario_id: usuarioId,
          campanha: 'chip_ativacao',
          nome: item.nome,
          telefone: item.telefone,
          telefone_2: item.telefone_2,
          telefone_3: item.telefone_3,
          operadora: item.operadora,
          os_numero: item.os_numero,
          cpf: item.cpf,
          cidade: item.cidade,
          bko_responsavel: item.bko_responsavel,
          vendedor: item.vendedor,
        },
        { onConflict: 'usuario_id,telefone,campanha' },
      )
      .select('id')
      .single();

    if (error) {
      erros.push({ ...item, erro: error.message });
      continue;
    }
    criados.push({ ...item, cliente_id: data.id });
  }

  return { criados: criados.length, clienteIds: criados.map((c) => c.cliente_id), erros, total: itens.length + semDados.length };
}
