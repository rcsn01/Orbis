import { lstat as defaultLstat, realpath as defaultRealpath, readdir as defaultReaddir, rename, statfs as defaultStatfs } from "node:fs/promises"
import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path"
import { createScanDatabase, prepareDatabaseDirectory, removeDatabaseFiles, type DirectoryAggregate, type ScanDatabase } from "./database"
import { createScanTimingAccumulator, measureScan, measureScanAsync, runWithScanDiagnostics } from "./diagnostics"
import { createOrderedConcurrentMapper, type OrderedConcurrentMapper } from "./ordered-concurrent-map"

export interface ScanStats {
  readonly blocks?: number | bigint
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly nlink?: number | bigint
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
  readonly bulkMetadataEntries?: number
  readonly fallbackMetadataEntries?: number
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
  readonly metadata?: {
    readonly bulkMetadataEntries: number
    readonly fallbackMetadataEntries: number
    readonly resume?: { readonly drainedThrough: string; readonly dirtyScopes: readonly string[] }
  }
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
  readonly metadataConcurrency?: number
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

export const DEFAULT_METADATA_CONCURRENCY = 4

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

export function scanFilesystem(options: ScanOptions): Promise<ScanResult> {
  return runWithScanDiagnostics(options.generation, () => measureScanAsync("scan-total", () => scanFilesystemImpl(options)))
}

async function scanFilesystemImpl(options: ScanOptions): Promise<ScanResult> {
  if (!isAbsolute(options.target)) throw new Error("Scan target must be an absolute path")
  const fileSystem = options.fileSystem ?? defaultFileSystem
  const metadataMapper = createOrderedConcurrentMapper(resolveMetadataConcurrency(options.metadataConcurrency))
  const startedAt = Date.now()
  const totals = { scannedItems: 0, discoveredBytes: 0, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 }
  const reporter = new ProgressReporter(options.onProgress, startedAt, totals)
  const seenFiles = new Set<string>()
  const preflight = await measureScanAsync("preflight", async () => {
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
    await removeDatabaseFiles(options.partialPath)
    return { indexRoot, indexIdentity, target, rootStats, rootDevice, capacityBytes, freeBytes }
  }).catch(async (error) => {
    await removeDatabaseFiles(options.partialPath)
    throw error
  })
  const { indexRoot, indexIdentity, target, rootStats, rootDevice, capacityBytes, freeBytes } = preflight
  const rootId = "n-1"
  let database: ScanDatabase | undefined
  try {
    const writer = measureScan("database-create", () => createScanDatabase(options.partialPath))
    database = writer
    const rootOwnBytes = allocatedBytes(rootStats)
    const aggregationTiming = createScanTimingAccumulator("aggregation")
    const root = await measureScanAsync("traversal", async () => {
      writer.insertNode({
        id: rootId,
        parentId: null,
        name: displayName(target),
        path: target,
        kind: "directory",
        ownBytes: rootOwnBytes,
        device: rootDevice,
        inode: identityPart(rootStats.ino)
      })
      seenFiles.add(fileIdentity(rootStats))
      totals.scannedItems += 1
      totals.discoveredBytes += rootOwnBytes
      reporter.emit(displayName(target), true)
      const aggregate = await walkDirectory(target, rootId, rootOwnBytes, rootDevice, writer, options, fileSystem, indexRoot, indexIdentity, seenFiles, totals, reporter, aggregationTiming.measure, metadataMapper)
      throwIfCanceled(options.signal)
      return aggregate
    })
    aggregationTiming.publish()
    reporter.emit(displayName(target), true)
    reporter.stage("indexing", displayName(target), true)
    writer.finalize()
    // Keep persisted and returned totals identical. End-to-end diagnostics separately include commit, close, and publication.
    const elapsedMs = Date.now() - startedAt
    const finalTotals: ScanTotals = { ...totals, elapsedMs }
    measureScan("metadata-write", () => writer.writeMetadata({
      target,
      rootId,
      capacityBytes,
      freeBytes,
      scannedBytes: root.sizeBytes,
      totals: finalTotals
    }))
    writer.complete()
    throwIfCanceled(options.signal)
    await measureScanAsync("publish-rename", () => rename(options.partialPath, options.publishedPath))
    throwIfCanceled(options.signal)
    options.onProgress?.({ stage: "indexing", scannedItems: totals.scannedItems, discoveredBytes: totals.discoveredBytes, elapsedMs, currentItem: displayName(target) })
    throwIfCanceled(options.signal)
    return { generation: options.generation, target, rootId, publishedPath: options.publishedPath, capacityBytes, freeBytes, scannedBytes: root.sizeBytes, totals: finalTotals }
  } catch (error) {
    database?.abort()
    await removeDatabaseFiles(options.partialPath)
    await removeDatabaseFiles(options.publishedPath)
    throw error
  }
}

async function walkDirectory(
  directory: string,
  parentId: string,
  ownBytes: number,
  rootDevice: string,
  database: ScanDatabase,
  options: ScanOptions,
  fileSystem: ScanFileSystem,
  indexRoot: string,
  indexIdentity: string | undefined,
  seenFiles: Set<string>,
  totals: { scannedItems: number; discoveredBytes: number; skippedItems: number; unreadableItems: number; nestedMounts: number; symlinks: number; duplicateHardLinks: number; disappearingItems: number },
  reporter: ProgressReporter,
  recordAggregation: (operation: () => void) => void,
  metadataMapper: OrderedConcurrentMapper
): Promise<DirectoryAggregate> {
  throwIfCanceled(options.signal)
  let names: readonly string[]
  try {
    names = await fileSystem.readdir(directory)
  } catch (error) {
    database.markUnreadable(parentId)
    totals.skippedItems += 1
    totals.unreadableItems += 1
    if (isDisappearing(error)) totals.disappearingItems += 1
    reporter.emit(displayName(directory))
    const aggregate = { sizeBytes: ownBytes, directChildren: 0, descendantCount: 0, unreadableCount: 1 }
    recordAggregation(() => database.updateDirectory(parentId, aggregate))
    return aggregate
  }
  let sizeBytes = ownBytes
  let directChildren = 0
  let descendantCount = 0
  let unreadableCount = 0
  const sortedNames = [...names].sort(compareEntryNames)
  const metadata = metadataMapper.map(sortedNames, { ...(options.signal ? { signal: options.signal } : {}), canceledError: () => new ScanCanceledError() }, async (name): Promise<MetadataResult> => {
    throwIfCanceled(options.signal)
    const childPath = normalize(resolve(directory, name))
    if (!isWithin(childPath, options.target)) return { status: "excluded", name, childPath }
    if (shouldExclude(childPath, options, indexRoot)) return { status: "excluded", name, childPath }
    try { return { status: "ready", name, childPath, stats: await fileSystem.lstat(childPath) } }
    catch (error) { return { status: "failed", name, childPath, error } }
  })
  for await (const entry of metadata) {
    const { name, childPath } = entry
    if (entry.status === "excluded") {
      totals.skippedItems += 1
      continue
    }
    if (entry.status === "failed") {
      totals.skippedItems += 1
      if (isDisappearing(entry.error)) totals.disappearingItems += 1
      else totals.unreadableItems += 1
      reporter.emit(name)
      continue
    }
    const stats = entry.stats
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
    database.insertNode({ id, parentId, name, path: childPath, kind, ownBytes, device: identityPart(stats.dev), inode: identityPart(stats.ino) })
    totals.scannedItems += 1
    totals.discoveredBytes += ownBytes
    reporter.emit(name)
    const child = kind === "directory"
      ? await walkDirectory(childPath, id, ownBytes, rootDevice, database, options, fileSystem, indexRoot, indexIdentity, seenFiles, totals, reporter, recordAggregation, metadataMapper)
      : { sizeBytes: ownBytes, directChildren: 0, descendantCount: 0, unreadableCount: 0 }
    sizeBytes += child.sizeBytes
    directChildren += 1
    descendantCount += 1 + child.descendantCount
    unreadableCount += child.unreadableCount
  }
  const aggregate = { sizeBytes, directChildren, descendantCount, unreadableCount }
  recordAggregation(() => database.updateDirectory(parentId, aggregate))
  return aggregate
}

type MetadataResult =
  | { readonly status: "excluded"; readonly name: string; readonly childPath: string }
  | { readonly status: "failed"; readonly name: string; readonly childPath: string; readonly error: unknown }
  | { readonly status: "ready"; readonly name: string; readonly childPath: string; readonly stats: ScanStats }

function resolveMetadataConcurrency(value: number | undefined): number {
  const configured = value ?? Number(process.env.ORBIS_SCAN_CONCURRENCY ?? DEFAULT_METADATA_CONCURRENCY)
  return Number.isFinite(configured) ? Math.max(1, Math.min(64, Math.floor(configured))) : DEFAULT_METADATA_CONCURRENCY
}

function compareEntryNames(left: string, right: string): number {
  const collated = left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
  return collated !== 0 ? collated : left < right ? -1 : left > right ? 1 : 0
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
