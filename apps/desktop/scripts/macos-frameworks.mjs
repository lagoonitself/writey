// macOS: sherpa-onnx and ONNX Runtime (with CoreML for the Apple GPU) are shared libraries
// that ship inside Writey.app. After `cargo build --release` has placed them next to the
// binary, this copies them to frameworks/ and lists them in tauri.macos.conf.json, which
// `tauri build` merges into the config.
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const from = process.argv[2] ?? 'target/release'
const libs = readdirSync(from).filter((f) => f.endsWith('.dylib'))
if (!libs.length) throw new Error(`no .dylib files in ${from}; run cargo build --release first`)
mkdirSync('frameworks', { recursive: true })
for (const f of libs) copyFileSync(join(from, f), join('frameworks', f))
const config = { bundle: { macOS: { frameworks: libs.map((f) => `frameworks/${f}`) } } }
writeFileSync('tauri.macos.conf.json', `${JSON.stringify(config, null, 2)}\n`)
console.log('bundling', libs.join(', '))
