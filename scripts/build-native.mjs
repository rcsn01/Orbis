import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const appRoot = resolve(import.meta.dirname, '..')
const nativeRoot = resolve(appRoot, 'native')
const output = resolve(appRoot, 'native')
const target = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 'aarch64-apple-darwin'
const napi = resolve(appRoot, 'node_modules/.bin/napi')
if (!existsSync(napi)) throw new Error(`Install apps/integrated/Orbis dependencies before building Orbis native metadata: ${napi}`)
mkdirSync(output, { recursive: true })
const result = spawnSync(napi, [
  'build', '--cwd', nativeRoot, '--package-json-path', resolve(appRoot, 'package.json'),
  '--output-dir', output, '--platform', '--release', '--no-js', '--target', target
], { cwd: appRoot, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
