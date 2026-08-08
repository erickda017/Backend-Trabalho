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

dotenv.config();

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

// Handler de erro global -- sem isso, erros como multer (arquivo grande demais, tipo
// errado) ou qualquer exceção síncrona em uma rota caem no handler padrão do Express,
// que responde com uma página HTML em vez de JSON (quebra o `res.json()` que o frontend espera).
app.use((err, req, res, next) => {
  console.error('[server] erro não tratado:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
});

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
  console.log(`[server] rodando em http://localhost:${PORT}`);
  startWhatsApp();
  iniciarScheduler();
  recuperarEnviosTravados();
});
