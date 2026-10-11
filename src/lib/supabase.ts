import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const configurationError = !url || !key
  ? 'Configurá VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY en .env.local y reiniciá la aplicación.'
  : !/^https?:\/\//.test(url)
    ? 'VITE_SUPABASE_URL debe ser una URL válida de Supabase.'
    : null

export const supabase = configurationError ? null : createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
})
