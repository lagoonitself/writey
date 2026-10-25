import { createReadStream, readFileSync } from 'node:fs'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Voice detection runs Silero VAD in the browser (docs §7.1). Its model, audio worklet and
 * the ONNX runtime's WebAssembly are served from Writey itself under /vad/, not a CDN. Dev
 * serves them straight from node_modules (Vite won't let code import from public/); the
 * build emits them as assets.
 */
function vadAssets(): Plugin {
  const modules = join(import.meta.dirname, 'node_modules')
  const vad = join(modules, '@ricky0123', 'vad-web', 'dist')
  const ort = join(modules, 'onnxruntime-web', 'dist')
  const files: Record<string, string> = {
    'silero_vad_v5.onnx': join(vad, 'silero_vad_v5.onnx'),
    'vad.worklet.bundle.min.js': join(vad, 'vad.worklet.bundle.min.js'),
    'ort-wasm-simd-threaded.wasm': join(ort, 'ort-wasm-simd-threaded.wasm'),
    'ort-wasm-simd-threaded.mjs': join(ort, 'ort-wasm-simd-threaded.mjs'),
  }
  const types: Record<string, string> = {
    onnx: 'application/octet-stream',
    wasm: 'application/wasm',
    js: 'text/javascript',
    mjs: 'text/javascript',
  }
  return {
    name: 'writey-vad-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0]?.replace(/^\/vad\//, '') ?? ''
        const path = req.url?.startsWith('/vad/') ? files[name] : undefined
        if (!path) return next()
        const ext = name.split('.').pop() as string
        res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
        createReadStream(path).pipe(res)
      })
    },
    generateBundle() {
      for (const [name, path] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName: `vad/${name}`, source: readFileSync(path) })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), vadAssets()],
  server: {
    port: 5173,
    // `wrangler dev` serves the Worker API on 8787 during development.
    proxy: { '/api': 'http://localhost:8787' },
  },
})
