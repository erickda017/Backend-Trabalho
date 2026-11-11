// SÓ PARA TESTES: cliente Supabase em memória com o subconjunto de PostgREST que a aba Disparo / E-mail usa
// (select/insert/update/upsert/delete, eq/in/is/not/gte, order/limit/range, single/maybeSingle, count head).
// Restrições de unicidade entram por `restricoes[tabela]` (iguais aos índices da migration), devolvendo código 23505.
let contador = 0;
const novoId = () => `00000000-0000-4000-8000-${String(++contador).padStart(12, '0')}`;

export function criarSupabaseFalso({ tabelas = {}, restricoes = {}, tabelasAusentes = [] } = {}) {
  const dados = Object.fromEntries(Object.entries(tabelas).map(([k, v]) => [k, v.map((l) => ({ ...l }))]));
  const tab = (nome) => (dados[nome] ??= []);

  function construir(nomeTabela) {
    const filtros = [];
    const ordens = [];
    let op = 'select';
    let payload;
    let opcoes = {};
    let limite = null;
    let faixa = null;
    let retornar = false;
    let unico = null; // 'single' | 'maybeSingle'
    let conflito = null;

    const q = {
      select(_cols, o) { if (op === 'select') opcoes = o ?? {}; else retornar = true; return q; },
      insert(p) { op = 'insert'; payload = Array.isArray(p) ? p : [p]; return q; },
      update(p) { op = 'update'; payload = p; return q; },
      upsert(p, o) { op = 'upsert'; payload = Array.isArray(p) ? p : [p]; conflito = o?.onConflict; return q; },
      delete() { op = 'delete'; return q; },
      eq(c, v) { filtros.push((l) => l[c] === v); return q; },
      neq(c, v) { filtros.push((l) => l[c] !== v); return q; },
      in(c, vs) { filtros.push((l) => vs.includes(l[c])); return q; },
      is(c, v) { filtros.push((l) => (v === null ? l[c] == null : l[c] === v)); return q; },
      // "col.is.null,col.eq.valor" (qualquer uma casa). Só is/eq: o que as rotas usam.
      or(expr) {
        const cond = String(expr).split(',').map((t) => {
          const [c, o, ...r] = t.split('.');
          const v = r.join('.');
          return (l) => (o === 'is' ? (v === 'null' ? l[c] == null : String(l[c]) === v) : String(l[c]) === v);
        });
        filtros.push((l) => cond.some((f) => f(l)));
        return q;
      },
      not(c, o, v) { if (o === 'is' && v === null) filtros.push((l) => l[c] != null); return q; },
      gte(c, v) { filtros.push((l) => l[c] != null && String(l[c]) >= String(v)); return q; },
      order(c, o) { ordens.push([c, o?.ascending === false ? -1 : 1]); return q; },
      limit(n) { limite = n; return q; },
      range(a, b) { faixa = [a, b]; return q; },
      single() { unico = 'single'; return q; },
      maybeSingle() { unico = 'maybeSingle'; return q; },
      then(ok, err) { return Promise.resolve(executar()).then(ok, err); },
    };

    function violacao(linhas, nova, ignorarIdx = -1) {
      return (restricoes[nomeTabela] ?? []).some((r) => linhas.some((l, i) => i !== ignorarIdx && r(l, nova)));
    }

    function executar() {
      if (tabelasAusentes.includes(nomeTabela)) return { data: null, error: { code: '42P01', message: 'relation does not exist' } };
      const T = tab(nomeTabela);
      const casa = (l) => filtros.every((f) => f(l));
      if (op === 'insert') {
        const criados = [];
        for (const p of payload) {
          const nova = { id: novoId(), criado_em: new Date().toISOString(), atualizado_em: new Date().toISOString(), tentativas: 0, status: undefined, ...p };
          if (nomeTabela === 'email_envios') nova.status ??= 'na_fila';
          if (nomeTabela === 'email_lotes') { nova.status ??= 'em_andamento'; nova.reenvio ??= false; }
          if (violacao(T, nova)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          T.push(nova);
          criados.push(nova);
        }
        return fim(retornar ? criados : null);
      }
      if (op === 'upsert') {
        const colunas = String(conflito).split(',');
        for (const p of payload) {
          const i = T.findIndex((l) => colunas.every((c) => l[c] === p[c]));
          if (i >= 0) Object.assign(T[i], p); else T.push({ id: novoId(), ...p });
        }
        return { data: null, error: null };
      }
      if (op === 'update') {
        const alvo = T.filter(casa);
        const antes = alvo.map((l) => ({ ...l }));
        for (let k = 0; k < alvo.length; k++) {
          const candidato = { ...alvo[k], ...payload };
          if (violacao(T, candidato, T.indexOf(alvo[k]))) { alvo.forEach((l, j) => Object.assign(l, antes[j])); return { data: null, error: { code: '23505', message: 'duplicate key' } }; }
          Object.assign(alvo[k], payload);
        }
        return fim(retornar ? alvo : null);
      }
      if (op === 'delete') {
        dados[nomeTabela] = T.filter((l) => !casa(l));
        return { data: null, error: null };
      }
      // select
      let r = T.filter(casa);
      if (opcoes.count && opcoes.head) return { data: null, count: r.length, error: null };
      for (const [c, d] of [...ordens].reverse()) r = [...r].sort((a, b) => (a[c] > b[c] ? d : a[c] < b[c] ? -d : 0));
      if (faixa) r = r.slice(faixa[0], faixa[1] + 1);
      if (limite !== null) r = r.slice(0, limite);
      return fim(r, opcoes.count ? r.length : undefined);
    }

    function fim(linhas, count) {
      const copia = linhas ? linhas.map((l) => ({ ...l })) : null;
      if (unico === 'single') return copia?.length === 1 ? { data: copia[0], error: null } : { data: null, error: { message: 'single: esperava 1 linha' } };
      if (unico === 'maybeSingle') return { data: copia?.[0] ?? null, error: null };
      return { data: copia, error: null, ...(count !== undefined ? { count } : {}) };
    }

    return q;
  }

  return { from: construir, __dados: dados };
}
