import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

// 画面に表示するバージョンは app.json から取る（パック時の版とずれないように）
const manifest = JSON.parse(readFileSync(new URL('./app.json', import.meta.url), 'utf8'))

// base './' keeps asset URLs relative so the packaged .ehpk works from any path.
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(manifest.version),
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  server: {
    port: 5173,
  },
})
