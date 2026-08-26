import { mkdir, readdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { build } from 'vite'

const argumentIndex = process.argv.indexOf('--outDir')
const output = resolve(argumentIndex >= 0 ? process.argv[argumentIndex + 1] ?? 'dist' : process.env.ORBIS_WORKER_OUT ?? 'dist')
const entry = resolve(import.meta.dirname, '../src/main/scan-worker.ts')

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await build({
  configFile: false,
  logLevel: 'warn',
  ssr: { target: 'node22', noExternal: true, external: [/^node:/] },
  build: {
    ssr: entry,
    outDir: output,
    emptyOutDir: false,
    target: 'node22',
    rollupOptions: {
      input: entry,
      external: (id) => id.startsWith('node:'),
      output: { format: 'es', entryFileNames: 'scan-worker.mjs', inlineDynamicImports: true }
    }
  }
})

const files = await readdir(output)
const worker = join(output, 'scan-worker.mjs')
if (!files.includes('scan-worker.mjs')) throw new Error(`Worker build did not create ${worker}`)
console.log(`Built Orbis scan worker at ${worker}`)
