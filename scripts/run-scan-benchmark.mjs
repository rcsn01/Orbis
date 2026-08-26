import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'vite'

const arguments_ = process.argv.slice(2)
const prepareIndex = arguments_.indexOf('--prepare-only')
const preparedDirectory = prepareIndex >= 0 ? resolve(arguments_[prepareIndex + 1] ?? 'benchmark-dist') : undefined
const outputDirectory = preparedDirectory ?? await mkdtemp(join(tmpdir(), 'orbis-benchmark-runner-'))
const entry = resolve(import.meta.dirname, 'benchmark-scan.ts')
const output = join(outputDirectory, 'benchmark-scan.mjs')

try {
  if (preparedDirectory) {
    await rm(preparedDirectory, { recursive: true, force: true })
    await mkdir(preparedDirectory, { recursive: true })
  }
  await build({
    configFile: false,
    logLevel: 'warn',
    ssr: { target: 'node22', noExternal: true, external: [/^node:/] },
    build: {
      ssr: entry,
      outDir: outputDirectory,
      emptyOutDir: false,
      target: 'node22',
      rollupOptions: {
        input: entry,
        external: (id) => id.startsWith('node:'),
        output: { format: 'es', entryFileNames: 'benchmark-scan.mjs', inlineDynamicImports: true }
      }
    }
  })
  if (preparedDirectory) {
    console.log(`Prepared Orbis benchmark runner at ${output}`)
  } else {
    const child = spawn(process.execPath, [output, ...arguments_], {
      cwd: process.cwd(),
      env: { ...process.env, ORBIS_SCAN_DIAGNOSTICS: '1' },
      stdio: 'inherit'
    })
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('exit', (code, signal) => signal ? rejectExit(new Error(`Benchmark stopped by ${signal}`)) : resolveExit(code ?? 1))
    })
    if (exitCode !== 0) process.exitCode = exitCode
  }
} finally {
  if (!preparedDirectory) await rm(outputDirectory, { recursive: true, force: true })
}
