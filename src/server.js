import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import { startWhatsApp } from './services/whatsapp.js';
import { iniciarScheduler } from './services/scheduler.js';
import { recuperarEnviosTravados } from './services/dispatchQueue.js';
import { requireAuth } from './middleware/auth.js';
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

dotenv.config();

// Checagem de variáveis obrigatórias na subida — sem isso o servidor loga um aviso
// claro e continua no ar (health check passa, rotas de auth funcionam), em vez de
// crashar sem explicação. Sem essas duas o WhatsApp/banco não funcionam, mas o
// serviço não cai por isso.
const obrigatorias = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const faltando = obrigatorias.filter((v) => !process.env[v]);
if (faltando.length) {
  console.error(
    `[server] AVISO: variável(is) de ambiente faltando: ${faltando.join(', ')}. ` +
      'O servidor vai subir mesmo assim, mas WhatsApp/banco/disparo não vão funcionar ' +
      'até você configurar isso no Render (Environment → adicionar as chaves do Supabase).'
  );
}

// Rede de segurança: uma promise rejeitada sem .catch() derrubava o processo inteiro
// (Node trata unhandledRejection como erro fatal por padrão desde a v15). Isso já
// aconteceu na prática com as chamadas de startup abaixo quando o Supabase não estava
// configurado ainda. Logamos e seguimos no ar em vez de matar o serviço.
process.on('unhandledRejection', (reason) => {
  console.error('[server] promise rejeitada sem tratamento:', reason);
});

const app = express();

const origensPermitidas = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(',').map((o) => o.trim())
  : true; // sem restrição em dev, se a env var não estiver setada

app.use(cors({ origin: origensPermitidas }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

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

// Handler de erro global -- sem isso, erros como multer (arquivo grande demais, tipo
// errado) ou qualquer exceção síncrona em uma rota caem no handler padrão do Express,
// que responde com uma página HTML em vez de JSON (quebra o `res.json()` que o frontend espera).
app.use((err, req, res, next) => {
  console.error('[server] erro não tratado:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
});

const PORT = process.env.PORT || 3333;

const server = app.listen(PORT, () => {
  console.log(`[server] rodando em http://localhost:${PORT}`);

  // Cada chamada de startup agora tem seu próprio .catch — uma falha em uma (ex:
  // Supabase mal configurado) não derruba as outras nem o processo inteiro.
  startWhatsApp().catch((err) =>
    console.error('[server] falha ao iniciar WhatsApp (servidor continua no ar):', err.message || err)
  );
  iniciarScheduler();
  recuperarEnviosTravados().catch((err) =>
    console.error('[server] falha ao recuperar envios travados:', err.message || err)
  );
});

// Importação de planilha grande (ex: 300+ clientes/PDFs) pode levar minutos --
// o timeout padrão de requisição do Node (5 min desde a v18) derrubava a conexão
// no meio do processamento, mesmo com o back-end ainda trabalhando normalmente.
// Desativa o timeout aqui; quem ainda limita isso é o proxy da hospedagem (ex:
// Render), que fica fora do nosso controle -- ver nota no README_CLAUDE_BACKEND.md.
server.requestTimeout = 0;
server.headersTimeout = 0;
