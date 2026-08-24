import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const require_ = createRequire(import.meta.url)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@moirasia/desktop-shell', '@moirasia/feature-orbis', '@moirasia/ui-react'] })],
    resolve: { alias: { '@shared': resolve('../../packages/feature-orbis/src/shared'), '@orbis': resolve('../../packages/feature-orbis/src') } },
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@moirasia/feature-orbis'] })],
    resolve: { alias: { '@shared': resolve('../../packages/feature-orbis/src/shared') } },
    build: {
      rollupOptions: {
        input: require_.resolve('@moirasia/feature-orbis/preload'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { dedupe: ['react', 'react-dom'] },
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      include: [
        '@moirasia/ui-react > recharts',
        '@moirasia/ui-react > recharts > use-sync-external-store/shim/with-selector'
      ]
    },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
