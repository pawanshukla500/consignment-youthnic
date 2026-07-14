import { createClient } from '@supabase/supabase-js'

// Realtime Broadcast only — operational DB and files stay off Supabase (free tier).
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = supabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      realtime: {
        params: {
          eventsPerSecond: 20,
        },
      },
    })
  : null

export function applySupabaseRealtimeToken(token) {
  if (!supabase || !token) return
  supabase.realtime.setAuth(token)
}
