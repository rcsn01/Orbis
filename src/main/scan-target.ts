import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, normalize, relative, sep } from 'node:path'
import type { NodeKind } from '../shared/contracts'

/**
 * Target and node-action path resolution shared by the controller and scan-run
 * lifecycle adapters. Pure filesystem helpers: no module state.
 */

export function isWithinPath(path: string, parent: string): boolean {
  const child = normalize(path)
  const root = normalize(parent)
  const remainder = relative(root, child)
  return child === root || remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`)
}

export async function resolveTarget(value: string): Promise<{ target: string; targetDevice: string; targetInode: string }> {
  if (!isAbsolute(value) || value.includes('\0')) throw new Error('Choose an absolute folder')
  const target = normalize(await realpath(value))
  const stats = await lstat(target)
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Choose a directory')
  return { target, targetDevice: String(stats.dev), targetInode: String(stats.ino) }
}

export async function validateNodeActionPath(path: string, target: string, kind: NodeKind): Promise<string> {
  if (!isAbsolute(path) || !isWithinPath(path, target)) throw new Error('The worker returned an unsafe item path')
  const stats = await lstat(path).catch((error: unknown) => {
    if (isMissingPath(error)) throw new Error('The item is no longer available')
    throw error
  })
  if (stats.isSymbolicLink()) throw new Error('The path is no longer a scanned item')
  if (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) throw new Error('The item kind changed after it was scanned')
  const canonical = await realpath(path).catch((error: unknown) => {
    if (isMissingPath(error)) throw new Error('The item is no longer available')
    throw error
  })
  const canonicalTarget = await realpath(target).catch((error: unknown) => {
    if (isMissingPath(error)) throw new Error('The scan target is no longer available')
    throw error
  })
  if (!isWithinPath(canonical, canonicalTarget)) throw new Error('The item path escaped the scan target')
  return canonical
}

export function isMissingPath(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
}