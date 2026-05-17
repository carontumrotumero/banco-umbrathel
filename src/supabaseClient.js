import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigError =
  !supabaseUrl || !supabaseAnonKey
    ? 'Faltan variables de entorno de Supabase: VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.'
    : null

export const supabase = supabaseConfigError ? null : createClient(supabaseUrl, supabaseAnonKey)
