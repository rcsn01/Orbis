import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type { ChangeEvent } from './change-journal'
import { FSEVENT_FLAGS } from './change-journal'
import { STARTUP_EXCLUSIONS, scanFilesystem, type ScanOptions } from './scanner'
import type { SubtreeReplacement } from './persistent-index-database'
import type { NativeAddonProbe } from './scan-metadata'

export type DirtyScopePlan =
  | { readonly kind: 'incremental'; readonly scopes: readonly string[] }
  | { readonly kind: 'full'; readonly reason: string }

export interface DirtyScopeOptions {
  readonly target: string
  readonly indexDirectory: string
  readonly events: readonly ChangeEvent[]
  readonly startupRoot?: boolean
  readonly lookupIdentity?: (absolutePath: string) => { readonly device: string; readonly inode: string } | undefined
}

export interface ReplacementScanOptions extends Pick<ScanOptions, 'generation' | 'indexDirectory' | 'nativeAddonPath' | 'directoryMetadataSource' | 'fileSystem' | 'metadataConcurrency' | 'signal'> {
  readonly onNativeAddonStatus?: NativeAddonProbe
  readonly scopes: readonly string[]
}

export interface ReplacementScanSet {
  readonly replacements: readonly SubtreeReplacement[]
  cleanup(): Promise<void>
}

export async function planDirtyScopes(options: DirtyScopeOptions): Promise<DirtyScopePlan> {
  const target = normalize(resolve(options.target))
  const indexDirectory = normalize(resolve(options.indexDirectory))
  if (!isAbsolute(target)) return { kind: 'full', reason: 'invalid-target' }
  const excludedPaths = options.events
    .filter((event) => event.relativePath !== '' && isExcludedEvent(target, indexDirectory, event.relativePath, options.startupRoot))
    .map((event) => normalize(resolve(target, event.relativePath)))
  const specific = options.events.filter((event) => event.relativePath !== '' && !isExcludedEvent(target, indexDirectory, event.relativePath, options.startupRoot))
  const rootEvents = options.events.filter((event) => event.relativePath === '')
  if (rootEvents.some((event) => event.flags & FSEVENT_FLAGS.mustScanSubDirs)) return { kind: 'full', reason: 'target-root-recursive' }
  if (specific.length === 0 && rootEvents.length > 0) {
    return excludedPaths.length > 0 ? { kind: 'incremental', scopes: [] } : { kind: 'full', reason: 'target-root-dirty' }
  }
  if (specific.length === 0) return { kind: 'incremental', scopes: [] }

  const requested: string[] = []
  for (const event of specific) {
    const absolutePath = normalize(resolve(target, event.relativePath))
    if (!within(absolutePath, target)) return { kind: 'full', reason: 'malformed-event-path' }
    const stableDirectory = Boolean(event.flags & FSEVENT_FLAGS.itemIsDir)
      && await isExistingIndexedDirectory(absolutePath, options.lookupIdentity)
    if (stableDirectory && excludedPaths.some((excluded) => within(excluded, absolutePath))) continue
    let scope = dirname(absolutePath)
    const isDirectory = Boolean(event.flags & FSEVENT_FLAGS.itemIsDir)
    const recursive = Boolean(event.flags & FSEVENT_FLAGS.mustScanSubDirs)
    const changesMembership = Boolean(event.flags & (FSEVENT_FLAGS.itemCreated | FSEVENT_FLAGS.itemRemoved | FSEVENT_FLAGS.itemRenamed))
    if ((isDirectory || recursive) && (!changesMembership || await isExistingIndexedDirectory(absolutePath, options.lookupIdentity))) scope = absolutePath
    scope = await nearestExistingDirectory(scope, target)
    if (scope === target) return { kind: 'full', reason: 'target-root-dirty' }
    if (target === '/' && options.startupRoot !== false && STARTUP_EXCLUSIONS.some((excluded) => within(excluded, scope))) {
      return { kind: 'full', reason: 'startup-exclusion-overlap' }
    }
    requested.push(scope)
  }
  const scopes = coalesceScopes(requested)
  return scopes.length > 8 ? { kind: 'full', reason: 'too-many-dirty-scopes' } : { kind: 'incremental', scopes }
}

export async function scanReplacementScopes(options: ReplacementScanOptions): Promise<ReplacementScanSet> {
  const temporaryDirectory = await mkdtemp(join(options.indexDirectory, '.incremental-'))
  const replacements: SubtreeReplacement[] = []
  try {
    for (let index = 0; index < options.scopes.length; index += 1) {
      const path = options.scopes[index]!
      const result = await scanFilesystem({
        generation: options.generation,
        target: path,
        partialPath: join(temporaryDirectory, `${index}.partial.sqlite`),
        publishedPath: join(temporaryDirectory, `${index}.sqlite`),
        indexDirectory: options.indexDirectory,
        ...(options.nativeAddonPath ? { nativeAddonPath: options.nativeAddonPath } : {}),
        ...(options.directoryMetadataSource ? { directoryMetadataSource: options.directoryMetadataSource } : {}),
        ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
        ...(options.metadataConcurrency !== undefined ? { metadataConcurrency: options.metadataConcurrency } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onNativeAddonStatus ? { onNativeAddonStatus: options.onNativeAddonStatus } : {})
      })
      replacements.push({ path, indexPath: result.publishedPath })
    }
    return { replacements, cleanup: () => rm(temporaryDirectory, { recursive: true, force: true }) }
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
}

async function isExistingIndexedDirectory(path: string, lookup: DirtyScopeOptions['lookupIdentity']): Promise<boolean> {
  if (!lookup) return false
  const before = lookup(path)
  const current = await lstat(path).catch(() => undefined)
  return Boolean(before && current?.isDirectory() && !current.isSymbolicLink()
    && before.device === String(current.dev) && before.inode === String(current.ino))
}

async function nearestExistingDirectory(path: string, target: string): Promise<string> {
  let current = path
  while (within(current, target)) {
    const stats = await lstat(current).catch(() => undefined)
    if (stats?.isDirectory() && !stats.isSymbolicLink()) return current
    if (current === target) return target
    current = dirname(current)
  }
  return target
}

function coalesceScopes(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort((left, right) => left.length - right.length || (left < right ? -1 : 1))
  const accepted = new Set<string>()
  const scopes: string[] = []
  for (const path of sorted) {
    let ancestor = dirname(path)
    let covered = false
    while (ancestor !== path) {
      if (accepted.has(ancestor)) { covered = true; break }
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
    if (!covered) { accepted.add(path); scopes.push(path) }
  }
  return scopes
}

function isExcludedEvent(target: string, indexDirectory: string, relativePath: string, startupRoot: boolean | undefined): boolean {
  const path = normalize(resolve(target, relativePath))
  if (!within(path, target)) return false
  if (within(path, indexDirectory)) return true
  return target === '/' && startupRoot !== false && STARTUP_EXCLUSIONS.some((excluded) => within(path, excluded))
}

function within(path: string, parent: string): boolean {
  const value = relative(parent, path)
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}
