import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
  }
);

export const BUCKET = process.env.SUPABASE_BUCKET || 'faturas';

// Bucket separado pra mídia trocada no Chat (fotos/áudios/documentos recebidos ou
// enviados por lá) -- fica isolado do bucket de faturas (BUCKET) de propósito.
export const CHAT_BUCKET = process.env.SUPABASE_CHAT_BUCKET || 'chat-midia';
