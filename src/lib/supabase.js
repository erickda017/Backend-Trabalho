import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// createClient() joga uma exceção SÍNCRONA se a URL vier vazia/inválida — isso
// acontecia direto no `import` deste arquivo, antes até do server.js conseguir
// chamar app.listen(), derrubando o processo sem nem logar o aviso de env var
// faltando. Usamos uma URL de placeholder válida (nunca alcançável de verdade) só
// pra o client conseguir ser instanciado; qualquer chamada real vai falhar de forma
// assíncrona normal (capturada pelos .catch() em server.js) até a env var certa ser
// configurada no Render.
const url = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-key';

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

export const BUCKET = process.env.SUPABASE_BUCKET || 'faturas';

// Bucket separado pra mídia trocada no Chat (fotos/áudios/documentos recebidos ou
// enviados por lá) -- fica isolado do bucket de faturas (BUCKET) de propósito.
export const CHAT_BUCKET = process.env.SUPABASE_CHAT_BUCKET || 'chat-midia';
