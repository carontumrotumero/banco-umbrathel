import { createClient } from '@supabase/supabase-js'

const fallbackSupabaseUrl = 'https://silmmqannyzuzjlphyjn.supabase.co'
const fallbackSupabaseAnonKey =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpbG1tcWFubnl6dXpqbHBoeWpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwNDEzNzksImV4cCI6MjA5NDYxNzM3OX0.mVMnvdOQC3fVCB3NWZcqm3kUlTiYFZtbjEJ67YWK8RI'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || fallbackSupabaseUrl
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || fallbackSupabaseAnonKey

export const supabaseConfigError =
  !supabaseUrl || !supabaseAnonKey
    ? 'Faltan variables de entorno de Supabase: VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.'
    : null

export const supabase = supabaseConfigError ? null : createClient(supabaseUrl, supabaseAnonKey)
