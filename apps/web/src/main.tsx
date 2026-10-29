import '@fontsource-variable/geist'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import '@fontsource/caveat/500.css'
import '@fontsource/caveat/700.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installDesktopShell } from './lib/shell'
import { runDesktopLogin } from './site/desktopLogin'
import './styles.css'

installDesktopShell()

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
// A tab only passing a Google sign-in on to the desktop app shows nothing.
if (!runDesktopLogin())
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
