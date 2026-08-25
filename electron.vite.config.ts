import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const require_ = createRequire(import.meta.url)
const featureRoot = resolve('../../packages/feature-orbis/src')
const featureAliases = [
  { find: /^@moirasia\/feature-orbis\/main$/u, replacement: resolve(featureRoot, 'main/feature.ts') },
  { find: /^@moirasia\/feature-orbis\/standalone$/u, replacement: resolve(featureRoot, 'main/standalone.ts') },
  { find: /^@moirasia\/feature-orbis\/preload$/u, replacement: resolve(featureRoot, 'preload/index.ts') },
  { find: /^@moirasia\/feature-orbis\/renderer\/panel$/u, replacement: resolve(featureRoot, 'renderer/App.tsx') },
  { find: /^@moirasia\/feature-orbis\/renderer\/sunburst$/u, replacement: resolve(featureRoot, 'renderer/Sunburst.tsx') },
  { find: /^@moirasia\/feature-orbis\/renderer$/u, replacement: resolve(featureRoot, 'renderer/mount.tsx') },
  { find: /^@moirasia\/feature-orbis\/styles\.css$/u, replacement: resolve(featureRoot, 'renderer/styles.css') },
  { find: '@moirasia/feature-orbis', replacement: featureRoot }
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@moirasia/desktop-shell', '@moirasia/feature-orbis', '@moirasia/ui-react'] })],
    resolve: { alias: [...featureAliases, { find: '@shared', replacement: resolve(featureRoot, 'shared') }, { find: '@orbis', replacement: featureRoot }] },
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@moirasia/feature-orbis'] })],
    resolve: { alias: [...featureAliases, { find: '@shared', replacement: resolve(featureRoot, 'shared') }] },
    build: {
      rollupOptions: {
        input: require_.resolve('@moirasia/feature-orbis/preload'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { dedupe: ['react', 'react-dom'], alias: featureAliases },
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
