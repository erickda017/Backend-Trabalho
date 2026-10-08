import './lib/logSeguroInit.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import { startWhatsApp, iniciarLimpezaSessoesInativas } from './services/whatsapp.js';
import { iniciarScheduler } from './services/scheduler.js';
import { recuperarEnviosTravados } from './services/dispatchQueue.js';
import { iniciarLimpezaAutomatica } from './services/limpezaAutomatica.js';
import { requireAuth } from './middleware/auth.js';
import { requireSupervisor } from './middleware/supervisor.js';
import { limiteGeral } from './lib/rateLimit.js';
import { descreverErro } from './lib/redigir.js';
import { cifrarSessoesLegadas } from './lib/supabaseAuthState.js';
import { criptografiaAtiva } from './lib/criptografia.js';
import whatsappRoutes from './routes/whatsapp.routes.js';
import clientesRoutes from './routes/clientes.routes.js';
import enviosRoutes from './routes/envios.routes.js';
import importacaoRoutes from './routes/importacao.routes.js';
import chatRoutes from './routes/chat.routes.js';
import tagsRoutes from './routes/tags.routes.js';
import respostasRapidasRoutes from './routes/respostasRapidas.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import configuracoesRoutes from './routes/configuracoes.routes.js';
import pixRoutes from './routes/pix.routes.js';
import faturasRoutes from './routes/faturas.routes.js';
import boletosRoutes from './routes/boletos.routes.js';
import perfilRoutes from './routes/perfil.routes.js';
import supervisorRoutes from './routes/supervisor.routes.js';
import exclusaoRoutes from './routes/exclusao.routes.js';
import arquivosRoutes from './routes/arquivos.routes.js';
import faturasPendentesRoutes from './routes/faturasPendentes.routes.js';
import safrasRoutes from './routes/safras.routes.js';
import qualidadeRoutes from './routes/qualidade.routes.js';
import ativacaoChipRoutes from './routes/ativacaoChip.routes.js';
import integracaoPlanilhaRoutes from './routes/integracaoPlanilha.routes.js';
import { iniciarConsolidacaoSafras } from './lib/safras.js';

dotenv.config();

// Checagem de variáveis obrigatórias na subida.
const obrigatorias = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const faltando = obrigatorias.filter((v) => !process.env[v]);
const emProducaoBoot = Boolean(process.env.RENDER) || process.env.NODE_ENV === 'production';
// [2026-10] SEGURANÇA (auditoria): em produção, sobe SÓ com a configuração
// mínima certa (fail-fast). Antes subia com Supabase "placeholder" e CORS
// fechado, dando "Failed to fetch" sem explicação. Em dev local continua só
// avisando. Variáveis opcionais (planilha, R2, webhook) são validadas no
// próprio módulo quando usadas.
const errosConfig = [];
if (faltando.length) errosConfig.push(`faltando: ${faltando.join(', ')}`);
if (emProducaoBoot && !process.env.FRONTEND_ORIGIN) errosConfig.push('faltando: FRONTEND_ORIGIN');
if (/[*]/.test(process.env.FRONTEND_ORIGIN || '')) errosConfig.push('FRONTEND_ORIGIN não pode ter * (wildcard)');
if (emProducaoBoot && process.env.SUPABASE_URL && !/^https:\/\//.test(process.env.SUPABASE_URL.trim())) errosConfig.push('SUPABASE_URL precisa ser https://');
if (process.env.DATA_ENCRYPTION_KEY) {
  try {
    criptografiaAtiva();
  } catch (e) {
    errosConfig.push(e.message);
  }
} else if (emProducaoBoot) {
  console.warn('[server] AVISO: DATA_ENCRYPTION_KEY não definida -- sessão do WhatsApp fica em texto puro no Supabase. Gere 32 bytes base64 e configure no Render.');
}
if (errosConfig.length) {
  const msg = `[server] configuração inválida: ${errosConfig.join(' | ')}. Corrija em Render → Environment.`;
  if (emProducaoBoot) {
    console.error(msg);
    process.exit(1);
  }
  console.error(`${msg} (dev local: subindo mesmo assim)`);
}

// Rede de segurança: uma promise rejeitada sem .catch() derrubava o processo inteiro
// (Node trata unhandledRejection como erro fatal por padrão desde a v15). Isso já
// aconteceu na prática com as chamadas de startup abaixo quando o Supabase não estava
// configurado ainda. Logamos e seguimos no ar em vez de matar o serviço.
process.on('unhandledRejection', (reason) => {
  console.error('[server] promise rejeitada sem tratamento:', descreverErro(reason));
});

const app = express();

// [2026-10] SEGURANÇA (auditoria): atrás do proxy do Render, sem isto
// req.ip era o IP do proxy -- o rate limit por IP virava UM balde pra
// internet inteira (qualquer anônimo travava a API de todo mundo). 1 = só o
// salto do Render é confiável (X-Forwarded-For forjado pelo cliente não vale).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

// Cabeçalhos de segurança. API só devolve JSON/arquivo (nunca HTML), então
// CSP fechada; crossOriginResourcePolicy 'cross-origin' porque o front
// (Vercel) busca arquivos do proxy por fetch. Remove X-Powered-By.
app.use(
  helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  }),
);

// [2026-08] SEGURANÇA: em produção, CORS aberto (origin: true, libera
// QUALQUER site) nunca é aceitável -- basta esquecer de configurar
// FRONTEND_ORIGIN no Render (fácil de acontecer num deploy apressado) pra
// qualquer site na internet poder chamar a API em nome de quem estiver
// logado no painel (o navegador da vítima manda o cookie/token normalmente).
// `RENDER` é injetada automaticamente pela plataforma em todo deploy lá --
// não depende de configurarmos NODE_ENV manualmente, então não tem como
// esquecer de marcar "isso é produção".
const emProducao = Boolean(process.env.RENDER) || process.env.NODE_ENV === 'production';
const origensPermitidas = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean)
  : emProducao
    ? [] // produção sem FRONTEND_ORIGIN configurada: bloqueia todo CORS (fail-safe) em vez de liberar geral
    : true; // dev local sem a env var: sem restrição, pra não travar quem tá rodando na máquina

if (emProducao && !process.env.FRONTEND_ORIGIN) {
  console.error(
    '[server] ERRO DE CONFIGURAÇÃO: rodando em produção (RENDER/NODE_ENV=production) sem ' +
      'FRONTEND_ORIGIN definida. CORS está BLOQUEADO para todas as origens até essa variável ' +
      'ser configurada (Render → Environment → FRONTEND_ORIGIN=https://seu-frontend.vercel.app). ' +
      'Isso é intencional: liberar CORS geral em produção deixaria a API vulnerável a qualquer ' +
      'site chamando em nome de um usuário logado.'
  );
}

// [2026-10] Auth é Bearer (header Authorization), NÃO cookie: o navegador
// não manda o token sozinho, então não há CSRF e `credentials` fica DESLIGADO
// de propósito (ligar só abriria espaço pra cookie cross-site no futuro).
app.use(
  cors({
    origin: origensPermitidas,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  }),
);
// Limite maior que o default (100kb) por causa da importação client-side
// (POST /api/importacao/lote): o payload é só texto (nome, telefone, URLs do
// Storage, código Pix) para até 1000 linhas, o que pode passar de 100kb em
// lotes grandes. 5MB dá folga confortável sem risco real de RAM -- é texto, não
// o PDF binário que costumava vir junto (esse nunca mais passa pelo servidor
// nesse fluxo).
app.get('/api/health', (req, res) => res.json({ ok: true }));

// [2026-09] Rate limiting básico em toda /api/* -- ver lib/rateLimit.js.
// Registrado DEPOIS de GET /api/health (linha acima) de propósito: aquele
// handler já responde e encerra a requisição, então health check (batido
// por monitoramento externo com frequência) nunca chega a passar por este
// middleware. Rotas de maior impacto (disparo, importação, upload) ganham
// um limite mais apertado por cima deste, aplicado localmente em cada rota.
app.use('/api', limiteGeral);
// [2026-10] Parse do JSON DEPOIS do rate limit (antes, anônimo fazia o
// servidor bufferizar 5 MB por requisição sem limite nenhum). Respostas da
// API têm dado pessoal: nunca cachear.
app.use(express.json({ limit: '5mb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// todas as rotas abaixo exigem login (Supabase Auth)
app.use('/api/whatsapp', requireAuth, whatsappRoutes);
app.use('/api/clientes', requireAuth, clientesRoutes);
app.use('/api/envios', requireAuth, enviosRoutes);
app.use('/api/importacao', requireAuth, importacaoRoutes);
app.use('/api/chat', requireAuth, chatRoutes);
app.use('/api/tags', requireAuth, tagsRoutes);
app.use('/api/respostas-rapidas', requireAuth, respostasRapidasRoutes);
app.use('/api/dashboard', requireAuth, dashboardRoutes);
app.use('/api/configuracoes', requireAuth, configuracoesRoutes);
app.use('/api/pix/extracoes', requireAuth, pixRoutes);
app.use('/api/faturas', requireAuth, faturasRoutes);
// Fluxo novo do extrator de PIX (boleto avulso, processado pelo Cloudflare
// Worker no navegador -- ver boletos.routes.js). Fica junto do CORS acima,
// que já libera a origem do front (FRONTEND_ORIGIN).
app.use('/api/boletos', requireAuth, boletosRoutes);
app.use('/api/perfil', requireAuth, perfilRoutes);
// [2026-09] Montada ANTES de /api/supervisor (mais específica primeiro) --
// evita depender do fallthrough do Express caso supervisorRoutes um dia
// ganhe uma rota catch-all que engoliria /supervisor/exclusao/* antes de
// chegar aqui.
app.use('/api/supervisor/exclusao', requireAuth, requireSupervisor, exclusaoRoutes);
app.use('/api/supervisor', requireAuth, requireSupervisor, supervisorRoutes);
// [2026-08] Proxy de arquivos (esconde a URL do Supabase Storage do
// navegador -- ver comentário completo em routes/arquivos.routes.js).
// requireAuth aqui também: mesmo que o proxy já gere a signed URL
// internamente, sem isso qualquer um com o path do arquivo (que agora fica
// visível na URL do proxy, ex: /api/arquivos/faturas/cliente-123/x.pdf)
// conseguiria baixar o PDF de qualquer cliente sem estar logado.
app.use('/api/arquivos', requireAuth, arquivosRoutes);
app.use('/api/faturas', requireAuth, faturasPendentesRoutes);
app.use('/api/safras', requireAuth, safrasRoutes);
app.use('/api/qualidade', requireAuth, qualidadeRoutes);
app.use('/api/ativacao-chip', requireAuth, ativacaoChipRoutes);
// [2026-10] Botão "Atualizar Pix na planilha" (operador e supervisor) -- ver lib/planilhaIntegracao.js.
app.use('/api/integracao/planilha', requireAuth, integracaoPlanilhaRoutes);

// Handler de erro global -- sem isso, erros como multer (arquivo grande demais, tipo
// errado) ou qualquer exceção síncrona em uma rota caem no handler padrão do Express,
// que responde com uma página HTML em vez de JSON (quebra o `res.json()` que o frontend espera).
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  console.error('[server] erro não tratado:', descreverErro(err));
  // [2026-10] 5xx não devolve a mensagem interna (detalhe de Postgres/SDK);
  // 4xx (multer, JSON inválido, arquivo grande) segue explicando o motivo.
  res.status(status).json({ error: status >= 500 ? 'Erro interno' : err.message || 'Requisição inválida' });
});

const PORT = process.env.PORT || 3333;

const server = app.listen(PORT, () => {
  console.log(`[server] rodando em http://localhost:${PORT}`);

  // Cada chamada de startup agora tem seu próprio .catch — uma falha em uma (ex:
  // Supabase mal configurado) não derruba as outras nem o processo inteiro.
  // [2026-10] Cifra sessões antigas ANTES de o Baileys começar a gravar (evita
  // sobrescrever uma chave recém-rotacionada com a cópia antiga).
  cifrarSessoesLegadas()
    .then((n) => n && console.log(`[server] ${n} linha(s) de sessão do WhatsApp cifradas no banco`))
    .catch((err) => console.error('[server] falha ao cifrar sessões legadas:', descreverErro(err)))
    .then(() => startWhatsApp())
    .catch((err) => console.error('[server] falha ao iniciar WhatsApp (servidor continua no ar):', descreverErro(err)));
  iniciarScheduler();
  iniciarLimpezaAutomatica();
  iniciarLimpezaSessoesInativas();
  iniciarConsolidacaoSafras();
  recuperarEnviosTravados().catch((err) =>
    console.error('[server] falha ao recuperar envios travados:', err.message || err)
  );
});

// Importação de planilha grande (ex: 300+ clientes/PDFs) pode levar minutos --
// o timeout padrão de requisição do Node (5 min desde a v18) derrubava a conexão
// no meio do processamento, mesmo com o back-end ainda trabalhando normalmente.
// Desativa o timeout aqui; quem ainda limita isso é o proxy da hospedagem (ex:
// Render), que fica fora do nosso controle -- ver nota no README_CLAUDE_BACKEND.md.
// [2026-10] SEGURANÇA: antes 0/0 (sem limite) -- conexão lenta ficava aberta
// pra sempre (slowloris). requestTimeout = tempo pra RECEBER o corpo (não o
// processamento): 15 min cobre upload grande em rede ruim.
server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 60 * 1000;
