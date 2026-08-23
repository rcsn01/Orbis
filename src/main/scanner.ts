import { lstat as defaultLstat, realpath as defaultRealpath, readdir as defaultReaddir, rename, statfs as defaultStatfs } from "node:fs/promises"
import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path"
import { createScanDatabase, finalizeDatabase, insertNode, prepareDatabaseDirectory, removeDatabaseFiles, writeMetadata } from "./database"

export interface ScanStats {
  readonly blocks?: number | bigint
  readonly dev: number | bigint
  readonly ino: number | bigint
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface StatFsStats {
  readonly blocks: number | bigint
  readonly bfree: number | bigint
  readonly bsize: number | bigint
}

export interface ScanFileSystem {
  lstat(path: string): Promise<ScanStats>
  readdir(path: string): Promise<readonly string[]>
  statfs(path: string): Promise<StatFsStats>
  realpath(path: string): Promise<string>
}

export interface ScanProgress {
  readonly stage: "traversing" | "indexing"
  readonly scannedItems: number
  readonly discoveredBytes: number
  readonly elapsedMs: number
  readonly currentItem: string
}

export interface ScanTotals {
  readonly scannedItems: number
  readonly discoveredBytes: number
  readonly elapsedMs: number
  readonly skippedItems: number
  readonly unreadableItems: number
  readonly nestedMounts: number
  readonly symlinks: number
  readonly duplicateHardLinks: number
  readonly disappearingItems: number
}

export interface ScanResult {
  readonly generation: number
  readonly target: string
  readonly rootId: string
  readonly publishedPath: string
  readonly capacityBytes: number
  readonly freeBytes: number
  readonly scannedBytes: number
  readonly totals: ScanTotals
}

export interface ScanOptions {
  readonly generation: number
  readonly target: string
  readonly partialPath: string
  readonly publishedPath: string
  readonly indexDirectory: string
  readonly startupRoot?: boolean
  readonly signal?: AbortSignal
  readonly fileSystem?: ScanFileSystem
  readonly onProgress?: (progress: ScanProgress) => void
}

export class ScanCanceledError extends Error {
  constructor() { super("Scan canceled"); this.name = "ScanCanceledError" }
}

const defaultFileSystem: ScanFileSystem = {
  lstat: async (path) => defaultLstat(path),
  readdir: async (path) => await defaultReaddir(path, { encoding: "utf8" }),
  statfs: async (path) => defaultStatfs(path),
  realpath: async (path) => defaultRealpath(path)
}

const STARTUP_EXCLUSIONS = [
  "/System/Volumes",
  "/Volumes",
  "/dev",
  "/Network",
  "/net",
  "/automount",
  "/private/var/automount",
  "/private/var/run"
]

export async function scanFilesystem(options: ScanOptions): Promise<ScanResult> {
  if (!isAbsolute(options.target)) throw new Error("Scan target must be an absolute path")
  const fileSystem = options.fileSystem ?? defaultFileSystem
  const startedAt = Date.now()
  const totals = { scannedItems: 0, discoveredBytes: 0, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 }
  const reporter = new ProgressReporter(options.onProgress, startedAt, totals)
  const seenFiles = new Set<string>()
  await prepareDatabaseDirectory(options.partialPath)
  const indexRoot = await fileSystem.realpath(options.indexDirectory).catch(() => resolve(options.indexDirectory))
  const indexStats = await fileSystem.lstat(indexRoot).catch(() => undefined)
  const indexIdentity = indexStats?.isDirectory() ? fileIdentity(indexStats) : undefined
  const target = normalize(resolve(options.target))
  const rootStats = await fileSystem.lstat(target)
  throwIfCanceled(options.signal)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error("Scan target must be a directory")
  const rootDevice = identityPart(rootStats.dev)
  const volume = await fileSystem.statfs(target)
  const capacityBytes = blockBytes(volume.blocks, volume.bsize)
  const freeBytes = blockBytes(volume.bfree, volume.bsize)
  const rootId = "n-1"
  await removeDatabaseFiles(options.partialPath)
  const database = createScanDatabase(options.partialPath)
  try {
    database.exec("BEGIN")
    insertNode(database, {
      id: rootId,
      parentId: null,
      name: displayName(target),
      path: target,
      kind: "directory",
      ownBytes: allocatedBytes(rootStats),
      device: rootDevice,
      inode: identityPart(rootStats.ino)
    })
    seenFiles.add(fileIdentity(rootStats))
    totals.scannedItems += 1
    totals.discoveredBytes += allocatedBytes(rootStats)
    reporter.emit(displayName(target), true)
    await walkDirectory(target, rootId, rootDevice, database, options, fileSystem, indexRoot, indexIdentity, seenFiles, totals, reporter)
    throwIfCanceled(options.signal)
    database.exec("COMMIT")
    reporter.emit(displayName(target), true)
    reporter.stage("indexing", displayName(target), true)
    const nodes = finalizeDatabase(database, rootId)
    const root = nodes.get(rootId)
    if (!root) throw new Error("The scan did not produce a root directory")
    const elapsedMs = Date.now() - startedAt
    const finalTotals: ScanTotals = { ...totals, elapsedMs }
    writeMetadata(database, {
      target,
      rootId,
      capacityBytes,
      freeBytes,
      scannedBytes: root.sizeBytes,
      totals: finalTotals
    })
    database.exec("PRAGMA optimize")
    database.close()
    throwIfCanceled(options.signal)
    await rename(options.partialPath, options.publishedPath)
    options.onProgress?.({ stage: "indexing", scannedItems: totals.scannedItems, discoveredBytes: totals.discoveredBytes, elapsedMs, currentItem: displayName(target) })
    return { generation: options.generation, target, rootId, publishedPath: options.publishedPath, capacityBytes, freeBytes, scannedBytes: root.sizeBytes, totals: finalTotals }
  } catch (error) {
    try { database.exec("ROLLBACK") } catch { /* The transaction may already be closed. */ }
    try { database.close() } catch { /* Best effort during cancellation. */ }
    await removeDatabaseFiles(options.partialPath)
    await removeDatabaseFiles(options.publishedPath)
    throw error
  }
}

async function walkDirectory(
  directory: string,
  parentId: string,
  rootDevice: string,
  database: ReturnType<typeof createScanDatabase>,
  options: ScanOptions,
  fileSystem: ScanFileSystem,
  indexRoot: string,
  indexIdentity: string | undefined,
  seenFiles: Set<string>,
  totals: { scannedItems: number; discoveredBytes: number; skippedItems: number; unreadableItems: number; nestedMounts: number; symlinks: number; duplicateHardLinks: number; disappearingItems: number },
  reporter: ProgressReporter
): Promise<void> {
  throwIfCanceled(options.signal)
  let names: readonly string[]
  try {
    names = await fileSystem.readdir(directory)
  } catch (error) {
    markUnreadable(database, parentId)
    totals.skippedItems += 1
    totals.unreadableItems += 1
    if (isDisappearing(error)) totals.disappearingItems += 1
    reporter.emit(displayName(directory))
    return
  }
  const sortedNames = [...names].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }))
  for (const name of sortedNames) {
    throwIfCanceled(options.signal)
    const childPath = normalize(resolve(directory, name))
    if (shouldExclude(childPath, options, indexRoot)) {
      totals.skippedItems += 1
      continue
    }
    let stats: ScanStats
    try {
      stats = await fileSystem.lstat(childPath)
    } catch (error) {
      totals.skippedItems += 1
      if (isDisappearing(error)) totals.disappearingItems += 1
      else totals.unreadableItems += 1
      reporter.emit(name)
      continue
    }
    if (stats.isSymbolicLink()) {
      totals.skippedItems += 1
      totals.symlinks += 1
      reporter.emit(name)
      continue
    }
    if (identityPart(stats.dev) !== rootDevice) {
      totals.skippedItems += 1
      totals.nestedMounts += 1
      reporter.emit(name)
      continue
    }
    if (indexIdentity !== undefined && stats.isDirectory() && fileIdentity(stats) === indexIdentity) {
      totals.skippedItems += 1
      reporter.emit(name)
      continue
    }
    const kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : undefined
    if (!kind) {
      totals.skippedItems += 1
      reporter.emit(name)
      continue
    }
    if (kind === "file") {
      const identity = fileIdentity(stats)
      if (seenFiles.has(identity)) {
        totals.skippedItems += 1
        totals.duplicateHardLinks += 1
        reporter.emit(name)
        continue
      }
      seenFiles.add(identity)
    }
    const id = `n-${totals.scannedItems + 1}`
    const ownBytes = allocatedBytes(stats)
    insertNode(database, { id, parentId, name, path: childPath, kind, ownBytes, device: identityPart(stats.dev), inode: identityPart(stats.ino) })
    totals.scannedItems += 1
    totals.discoveredBytes += ownBytes
    reporter.emit(name)
    if (kind === "directory") await walkDirectory(childPath, id, rootDevice, database, options, fileSystem, indexRoot, indexIdentity, seenFiles, totals, reporter)
  }
}

function markUnreadable(database: ReturnType<typeof createScanDatabase>, id: string): void {
  database.prepare("UPDATE nodes SET own_unreadable = 1, unreadable_count = 1 WHERE id = ?").run(id)
}

function shouldExclude(path: string, options: ScanOptions, indexRoot: string): boolean {
  if (isWithin(path, indexRoot)) return true
  if (options.startupRoot !== false && normalize(options.target) === "/" && STARTUP_EXCLUSIONS.some((excluded) => isWithin(path, excluded))) return true
  return false
}

function isWithin(path: string, parent: string): boolean {
  const child = normalize(path)
  const root = normalize(parent)
  return child === root || relative(root, child) !== "" && !relative(root, child).startsWith(`..${sep}`) && relative(root, child) !== ".."
}

function displayName(path: string): string { return path === "/" ? "/" : basename(path) || path }
function identityPart(value: number | bigint): string { return String(value) }
function fileIdentity(stats: Pick<ScanStats, "dev" | "ino">): string { return `${identityPart(stats.dev)}:${identityPart(stats.ino)}` }
function allocatedBytes(stats: Pick<ScanStats, "blocks">): number { return blockCount(stats.blocks) * 512 }
function blockBytes(blocks: number | bigint, size: number | bigint): number { return numberValue(blocks) * numberValue(size) }
function blockCount(value: number | bigint | undefined): number { return value === undefined ? 0 : numberValue(value) }
function numberValue(value: number | bigint): number { const number = typeof value === "bigint" ? Number(value) : value; return Number.isFinite(number) && number > 0 ? number : 0 }
function throwIfCanceled(signal: AbortSignal | undefined): void { if (signal?.aborted) throw new ScanCanceledError() }
function isDisappearing(error: unknown): boolean { const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : ""; return code === "ENOENT" || code === "ENOTDIR" }

class ProgressReporter {
  #lastSent = 0
  constructor(private readonly callback: ((progress: ScanProgress) => void) | undefined, private readonly startedAt: number, private readonly totals: { scannedItems: number; discoveredBytes: number },) {}
  emit(currentItem: string, force = false): void {
    const now = Date.now()
    if (!force && now - this.#lastSent < 100) return
    this.#lastSent = now
    this.callback?.({ stage: "traversing", scannedItems: this.totals.scannedItems, discoveredBytes: this.totals.discoveredBytes, elapsedMs: now - this.startedAt, currentItem })
  }
  stage(stage: "traversing" | "indexing", currentItem: string, force = false): void {
    const now = Date.now()
    if (!force && now - this.#lastSent < 100) return
    this.#lastSent = now
    this.callback?.({ stage, scannedItems: this.totals.scannedItems, discoveredBytes: this.totals.discoveredBytes, elapsedMs: now - this.startedAt, currentItem })
  }
}

export function defaultScanFileSystem(): ScanFileSystem { return defaultFileSystem }
export { STARTUP_EXCLUSIONS }
