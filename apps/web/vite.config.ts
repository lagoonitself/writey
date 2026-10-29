import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// One build serves both the desktop app (Tauri loads dist/) and the website (the Worker
// serves dist/ as the download page).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // `wrangler dev` serves the website's API on 8787 during development.
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: {
    // WebView2 is current Chromium; macOS 12+ ships Safari 15+.
    target: ['chrome110', 'safari15'],
  },
})
