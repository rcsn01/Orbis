import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@moirasia/desktop-shell', '@moirasia/ui-react'] })],
    resolve: { alias: [{ find: '@shared', replacement: resolve('src/shared') }, { find: '@orbis', replacement: resolve('src') }] },
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@moirasia/desktop-shell'] })],
    resolve: { alias: [{ find: '@shared', replacement: resolve('src/shared') }] },
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
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
