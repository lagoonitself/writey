import { createClient } from '@supabase/supabase-js'
import { desktopLoginPending } from '../../site/desktopLogin'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const supabaseConfigured = Boolean(url && key)

export const supabase = createClient(url ?? 'http://invalid.local', key ?? 'missing', {
  // A sign-in code meant for the desktop app goes to the app, not to this tab's session.
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: !desktopLoginPending(),
  },
})
