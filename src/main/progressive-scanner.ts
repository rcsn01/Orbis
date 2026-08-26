import { createHmac, randomBytes } from "node:crypto"
import { lstat, open, opendir, realpath, rename, statfs } from "node:fs/promises"
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path"
import type { Breadcrumb, ChartSegment, NodeSummary, VolumeSnapshot } from "../shared/contracts"
import { buildChart } from "./chart"
import { prepareDatabaseDirectory, removeDatabaseFiles } from "./database"
import { createScanTimingAccumulator, measureScan, measureScanAsync, runWithScanDiagnostics } from "./diagnostics"
import { ProgressiveScanDatabase, type DirectoryTask } from "./progressive-database"
import type { FullScanResumeDescriptor, FullScanResumeStore } from './full-scan-resume'
import {
  createDirectoryMetadataSource, loadNativeMetadataAddon, NodeDirectoryMetadataSource,
  type DirectoryMetadataCursor, type DirectoryMetadataEntry, type DirectoryMetadataSource, type FolderSizeEstimate
} from "./scan-metadata"
import {
  DEFAULT_METADATA_CONCURRENCY, STARTUP_EXCLUSIONS, ScanCanceledError,
  type ScanFileSystem, type ScanOptions, type ScanProgress, type ScanResult, type ScanStats, type ScanTotals
} from "./legacy-scanner"

interface ActiveCursor {
  readonly cursor: DirectoryMetadataCursor
  readonly source: "bulk" | "node"
}

export interface ProgressivePreview {
  readonly generation: number
  readonly revision: number
  readonly committed: false
  readonly target: { readonly name: string; readonly isStartup: boolean }
  readonly focus: NodeSummary
  readonly breadcrumbs: readonly Breadcrumb[]
  readonly chart: readonly ChartSegment[]
  readonly largestItems: readonly NodeSummary[]
  readonly volume: VolumeSnapshot
}

export interface ProgressiveScanOptions extends ScanOptions {
  readonly control: ProgressiveScanControl
  readonly resumable?: {
    readonly descriptor: FullScanResumeDescriptor
    readonly store: FullScanResumeStore
    readonly resume: boolean
  }
  readonly onPreview?: (preview: ProgressivePreview) => void
  readonly initialEstimate?: FolderSizeEstimate
  readonly directoryMetadataSource?: DirectoryMetadataSource
  readonly nativeAddonPath?: string
  readonly onCheckpoint?: (sequence: number) => void
  readonly drainResumeJournal?: (eventId: string) => { readonly throughEventId: string; readonly scopes: readonly string[]; readonly restartReason?: string }
  /** Internal traversal tuning. The benchmark worker uses ORBIS_METADATA_BATCH_SIZE instead. */
  readonly metadataBatchSize?: number
}

export class ProgressiveScanControl {
  #database: ProgressiveScanDatabase | undefined
  #focusId: string | undefined
  #focusRequested = false
  #onFocus: (() => void) | undefined

  attach(database: ProgressiveScanDatabase, rootId: string, onFocus?: () => void): void {
    this.#database = database
    this.#focusId = rootId
    this.#focusRequested = false
    this.#onFocus = onFocus
  }
  detach(): void {
    this.#database = undefined
    this.#onFocus = undefined
  }
  focus(id: string): boolean {
    const database = this.#database
    const node = database?.getNode(id)
    if (!database || !node || node.kind !== "directory") return false
    database.promoteSubtree(id)
    database.bumpRevision()
    this.#focusId = id
    this.#focusRequested = true
    this.#onFocus?.()
    return true
  }
  consumeFocusRequest(): boolean { const value = this.#focusRequested; this.#focusRequested = false; return value }
  get focusId(): string | undefined { return this.#focusId }
  resolveNode(id: string): string | undefined { return this.#database?.resolvePath(id) }
}

const FIRST_PREVIEW_ENTRIES = 32
const DEFAULT_METADATA_BATCH_SIZE = 256
const MAX_METADATA_BATCH_SIZE = 1_024
const MAX_OPEN_HANDLES = 8
const PREVIEW_INTERVAL_MS = 100

const nativeFileSystem: ScanFileSystem & { opendir(path: string): Promise<NodeDirectoryHandle> } = {
  lstat: async (path) => lstat(path),
  readdir: async () => { throw new Error("Progressive scans use opendir") },
  statfs: async (path) => statfs(path),
  realpath: async (path) => realpath(path),
  opendir: async (path) => opendir(path)
}

export function scanFilesystemProgressive(options: ProgressiveScanOptions): Promise<ScanResult> {
  return runWithScanDiagnostics(options.generation, () => measureScanAsync("scan-total", () => scanImpl(options)))
}

async function scanImpl(options: ProgressiveScanOptions): Promise<ScanResult> {
  if (!isAbsolute(options.target)) throw new Error("Scan target must be an absolute path")
  const fileSystem = options.fileSystem ?? nativeFileSystem
  const metadataConcurrency = resolveConcurrency(options.metadataConcurrency)
  const metadataBatchSize = resolveMetadataBatchSize(options.metadataBatchSize)
  const nativeAddon = await loadNativeMetadataAddon(options.nativeAddonPath)
  const nodeMetadataSource = new NodeDirectoryMetadataSource(fileSystem, metadataConcurrency)
  const bulkMetadataSource = options.directoryMetadataSource
    ?? createDirectoryMetadataSource(nativeAddon, fileSystem, metadataConcurrency)
  const startedAt = Date.now()
  const totals = mutableTotals()
  const reporter = new PreviewReporter(options, startedAt, totals)
  let key = randomBytes(32)
  const nodeId = (parentId: string, name: string): string => `n-${createHmac("sha256", key).update(parentId).update("\0").update(name).digest("hex").slice(0, 32)}`
  const cursors = new Map<string, ActiveCursor>()
  const bulkFallbackDirectories = new Set<string>()
  let database: ProgressiveScanDatabase | undefined
  let constructionActive = true

  let preflight: Awaited<ReturnType<typeof preflightShape>>
  try {
    preflight = await measureScanAsync("preflight", async () => {
      await prepareDatabaseDirectory(options.partialPath)
      const indexRoot = await fileSystem.realpath(options.indexDirectory).catch(() => resolve(options.indexDirectory))
      const indexStats = await fileSystem.lstat(indexRoot).catch(() => undefined)
      const indexIdentity = indexStats?.isDirectory() ? identity(indexStats) : undefined
      const target = normalize(resolve(options.target))
      const rootStats = await fileSystem.lstat(target)
      throwIfCanceled(options.signal)
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error("Scan target must be a directory")
      const volume = await fileSystem.statfs(target)
      if (!options.resumable?.resume) await removeDatabaseFiles(options.partialPath)
      return {
        indexRoot, indexIdentity, target, rootStats, rootDevice: part(rootStats.dev),
        targetRealpath: await fileSystem.realpath(target),
        capacityBytes: blockBytes(volume.blocks, volume.bsize), freeBytes: blockBytes(volume.bfree, volume.bsize)
      }
    })
  } catch (error) {
    options.control.detach()
    if (!options.resumable) await removeDatabaseFiles(options.partialPath)
    throw error
  }

  let rootId = ''
  let activeElapsedBefore = 0
  let lastCheckpointAt = Date.now()
  let entriesSinceCheckpoint = 0
  let lastJournalDrainAt = Date.now()
  let resumeJournal: { readonly drainedThrough: string; readonly dirtyScopes: readonly string[] } | undefined
  try {
    if (options.resumable?.resume) {
      database = measureScan('database-resume', () => ProgressiveScanDatabase.openResumable(options.partialPath))
      key = Buffer.from(database.nodeIdSeed, 'hex')
      rootId = nodeId('root', preflight.target)
      const recovered = database.recoverIncompleteDirectories()
      const persisted = database.semanticTotals()
      Object.assign(totals, persisted)
      activeElapsedBefore = persisted.activeElapsedMs
      void recovered
      notifyCheckpoint(options, database.checkpoint())
    } else if (options.resumable) {
      const descriptor = options.resumable.descriptor
      database = measureScan('database-create', () => ProgressiveScanDatabase.create(options.partialPath, {
        scanId: descriptor.scanId, journalDevice: descriptor.journalDevice, journalUuid: descriptor.journalUuid,
        journalBaseline: descriptor.journalBaseline
      }))
      key = Buffer.from(database.nodeIdSeed, 'hex')
      rootId = nodeId('root', preflight.target)
      notifyCheckpoint(options, database.checkpoint())
      await options.resumable.store.publish(descriptor)
    } else {
      database = measureScan("database-create", () => new ProgressiveScanDatabase(options.partialPath))
      rootId = nodeId('root', preflight.target)
    }
    const rootBytes = allocatedBytes(preflight.rootStats)
    if (!database.getNode(rootId)) {
      database.insertRoot({ id: rootId, parentId: null, name: displayName(preflight.target), path: preflight.target, kind: "directory", ownBytes: rootBytes, device: preflight.rootDevice, inode: part(preflight.rootStats.ino) })
      database.setHardLinkOwner(part(preflight.rootStats.dev), part(preflight.rootStats.ino), rootId, "")
    }
    options.control.attach(database, rootId, () => {
      queueMicrotask(() => { if (database && constructionActive) reporter.focus(database, preflight) })
    })
    if (totals.scannedItems === 0) totals.scannedItems = 1
    if (totals.discoveredBytes === 0) totals.discoveredBytes = rootBytes
    reporter.progress(displayName(preflight.target), true)

    if (options.initialEstimate && !options.resumable?.resume) {
      database.applyEstimates(options.initialEstimate)
      database.bumpRevision()
    }
    if (options.resumable?.resume) reporter.resume(database, preflight)

    const aggregationTiming = createScanTimingAccumulator("aggregation")
    let focusTurns = 0
    const checkpointNow = (finalDrain: boolean): void => {
      if (!options.resumable || !database) return
      const now = Date.now()
      const drainDue = Boolean(options.drainResumeJournal) && (finalDrain || now - lastJournalDrainAt >= 30_000)
      if (drainDue && options.drainResumeJournal) {
        const drain = options.drainResumeJournal(database.drainedThrough)
        if (drain.restartReason) throw new Error(`resume-invalidated:${drain.restartReason}`)
        database.setJournalDrain(drain.scopes, drain.throughEventId)
        lastJournalDrainAt = now
      }
      notifyCheckpoint(options, database.checkpoint(now - lastCheckpointAt))
      lastCheckpointAt = now
      entriesSinceCheckpoint = 0
    }
    const checkpointDue = (): void => {
      if (!options.resumable || !database) return
      const now = Date.now()
      const journalDue = Boolean(options.drainResumeJournal) && now - lastJournalDrainAt >= 30_000
      if (now - lastCheckpointAt >= 2_000 || entriesSinceCheckpoint >= 4_096 || journalDue) checkpointNow(false)
    }
    const checkpointForced = (finalDrain = false): void => checkpointNow(finalDrain)

    await measureScanAsync("traversal", async () => {
      // Native bulk pages are synchronous and already contain metadata. Node
      // fallback uses the Stage 5 scan-wide mapper, so keep several eligible
      // directory pages in flight while applying their results in scheduler
      // order. SQLite and hard-link decisions remain single-threaded.
      const pageConcurrency = bulkMetadataSource
        ? Math.max(1, Math.min(metadataConcurrency, bulkMetadataSource.pageConcurrency ?? 1))
        : metadataConcurrency
      while (database!.hasPendingTasks()) {
        throwIfCanceled(options.signal)
        const reserved = new Set<string>()
        const tasks: DirectoryTask[] = []
        while (tasks.length < pageConcurrency) {
          const focusedAvailable = database!.hasPendingTasks(true)
          const normalAvailable = database!.hasPendingTasks(false)
          const takeFocused = focusedAvailable && (focusTurns < 3 || !normalAvailable)
          let task = database!.nextTask(takeFocused, reserved)
          if (!task) task = database!.nextTask(!takeFocused, reserved)
          if (!task) break
          reserved.add(task.id)
          tasks.push(task)
          if (task.focused) focusTurns += 1
          else focusTurns = 0
          if (task.focused && focusTurns >= 3 && database!.hasPendingTasks(false)) focusTurns = 3
        }
        if (tasks.length === 0) throw new Error("Directory queue is inconsistent")

        const missingCursors = tasks.reduce((count, task) => count + (cursors.has(task.id) ? 0 : 1), 0)
        while (cursors.size + missingCursors > MAX_OPEN_HANDLES && cursors.size > 0) await closeOneCursor(cursors, "")
        const preparationErrors = new Map<string, unknown>()
        // Keep directory admission deterministic for the Node fallback. Its
        // shared mapper still overlaps the expensive lstat work across pages.
        if (!bulkMetadataSource) {
          for (const task of tasks) {
            if (cursors.has(task.id)) continue
            try {
              const active = await openCursor(task.path, preflight.targetRealpath, undefined, nodeMetadataSource, bulkFallbackDirectories)
              await skipEntries(active.cursor, task.entriesRead, metadataBatchSize, options.signal)
              cursors.set(task.id, active)
            } catch (error) { preparationErrors.set(task.id, error) }
          }
        }
        const reads = await Promise.all(tasks.map((task) => {
          const preparationError = preparationErrors.get(task.id)
          return preparationError === undefined
            ? readTaskPage(task, cursors, preflight.targetRealpath, bulkMetadataSource, nodeMetadataSource, bulkFallbackDirectories, metadataBatchSize, options)
            : Promise.resolve<TaskPageRead>({ ok: false, task, error: preparationError })
        }))
        for (const read of reads) {
          throwIfCanceled(options.signal)
          const task = read.task
          if (!read.ok) {
            applyUnreadableBatch(database!, task, isDisappearing(read.error), totals)
            checkpointDue()
            reporter.batch(database!, task.id, preflight, task.id === rootId)
            continue
          }
          const page = read.page
          const totalsBeforeBatch = { ...totals }
          const firstRootPage = task.id === rootId && task.entriesRead === 0
          try {
            database!.applyMetadataBatch(() => {
              if (!page.done) database!.startTask(task.id)
              processPage(page.entries, task, database!, options, preflight, totals, nodeId, aggregationTiming.measure)
              database!.addMetadataCounters(page.bulkEntries, page.fallbackEntries)
              database!.bumpRevision()
              if (page.done) database!.finishEnumeration(task.id)
              else {
                database!.advanceTask(task.id, page.entries.length)
                database!.yieldTask(task.id)
              }
            })
          } catch (error) {
            Object.assign(totals, totalsBeforeBatch)
            throw error
          }
          totals.bulkMetadataEntries += page.bulkEntries
          totals.fallbackMetadataEntries += page.fallbackEntries
          entriesSinceCheckpoint += page.entries.length
          if (page.done) await closeCursor(cursors, task.id)
          reporter.batch(database!, task.id, preflight, task.id === rootId && firstRootPage)
          checkpointDue()
        }
      }
    })
    aggregationTiming.publish()
    await closeAll(cursors)
    await bulkMetadataSource?.close?.()
    constructionActive = false
    throwIfCanceled(options.signal)
    if (options.resumable) {
      database.setPhase('awaiting-reconciliation')
      checkpointForced(true)
    }
    const root = database.getNode(rootId)
    if (!root || root.scanState !== "complete" && root.scanState !== "unreadable") throw new Error("Progressive scan root did not reach a terminal state")
    reporter.progress(displayName(preflight.target), true, "indexing")
    if (options.resumable) resumeJournal = { drainedThrough: database.drainedThrough, dirtyScopes: database.dirtyScopes }
    measureScan("index-create", () => database!.finalize())
    const elapsedMs = activeElapsedBefore + Date.now() - startedAt
    const finalTotals: ScanTotals = {
      scannedItems: totals.scannedItems, discoveredBytes: root.confirmedBytes, elapsedMs, skippedItems: totals.skippedItems,
      unreadableItems: totals.unreadableItems, nestedMounts: totals.nestedMounts, symlinks: totals.symlinks,
      duplicateHardLinks: totals.duplicateHardLinks, disappearingItems: totals.disappearingItems
    }
    const capturedAt = new Date().toISOString()
    measureScan("metadata-write", () => database!.writeMetadata({
      target: preflight.target, rootId, capacityBytes: preflight.capacityBytes, freeBytes: preflight.freeBytes,
      scannedBytes: root.confirmedBytes, totals: finalTotals, targetDevice: preflight.rootDevice,
      targetInode: part(preflight.rootStats.ino), ...(preflight.indexIdentity ? { indexDirectoryIdentity: preflight.indexIdentity } : {}),
      indexRevision: 1, capturedAt, refreshedAt: capturedAt, ...(resumeJournal ? { resume: resumeJournal } : {})
    }))
    database.complete()
    database = undefined
    options.control.detach()
    throwIfCanceled(options.signal)
    await measureScanAsync("publish-rename", () => durableRename(options.partialPath, options.publishedPath))
    reporter.progress(displayName(preflight.target), true, "indexing")
    throwIfCanceled(options.signal)
    return {
      generation: options.generation, target: preflight.target, rootId, publishedPath: options.publishedPath,
      capacityBytes: preflight.capacityBytes, freeBytes: preflight.freeBytes, scannedBytes: root.confirmedBytes, totals: finalTotals,
      metadata: {
        bulkMetadataEntries: totals.bulkMetadataEntries, fallbackMetadataEntries: totals.fallbackMetadataEntries,
        ...(resumeJournal ? { resume: resumeJournal } : {})
      }
    }
  } catch (error) {
    constructionActive = false
    await closeAll(cursors)
    await bulkMetadataSource?.close?.().catch(() => undefined)
    options.control.detach()
    const failedDatabase = database
    database = undefined
    if (failedDatabase && options.resumable) {
      try {
        if (options.drainResumeJournal) {
          const drain = options.drainResumeJournal(failedDatabase.drainedThrough)
          if (!drain.restartReason) failedDatabase.setJournalDrain(drain.scopes, drain.throughEventId)
        }
        notifyCheckpoint(options, failedDatabase.checkpoint(Date.now() - lastCheckpointAt))
      } catch { /* The previous committed checkpoint remains resumable. */ }
      failedDatabase.abort()
    } else failedDatabase?.abort()
    if (!options.resumable) {
      await removeDatabaseFiles(options.partialPath)
      await removeDatabaseFiles(options.publishedPath)
    }
    throw error
  }
}

function notifyCheckpoint(options: ProgressiveScanOptions, sequence: number): void { options.onCheckpoint?.(sequence) }

async function durableRename(partialPath: string, publishedPath: string): Promise<void> {
  const partial = await open(partialPath, 'r')
  try { await partial.sync() } finally { await partial.close() }
  await rename(partialPath, publishedPath)
  const directory = await open(dirname(publishedPath), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

async function openCursor(
  path: string,
  targetRealpath: string,
  bulk: DirectoryMetadataSource | undefined,
  node: DirectoryMetadataSource,
  fallbackDirectories: Set<string>
): Promise<ActiveCursor> {
  if (bulk && !fallbackDirectories.has(path)) {
    try { return { cursor: await bulk.open(path, targetRealpath), source: "bulk" } }
    catch { fallbackDirectories.add(path) }
  }
  return { cursor: await node.open(path, targetRealpath), source: "node" }
}

async function skipEntries(cursor: DirectoryMetadataCursor, count: number, batchSize: number, signal: AbortSignal | undefined): Promise<void> {
  let remaining = Math.max(0, Math.floor(count))
  while (remaining > 0) {
    const page = await cursor.readPage(Math.min(batchSize, remaining), signal ?? new AbortController().signal)
    if (page.entries.length === 0) return
    remaining -= page.entries.length
    if (page.done) return
  }
}

type DirectoryMetadataPage = Awaited<ReturnType<DirectoryMetadataCursor["readPage"]>>
type TaskPageRead =
  | { readonly ok: true; readonly task: DirectoryTask; readonly page: DirectoryMetadataPage }
  | { readonly ok: false; readonly task: DirectoryTask; readonly error: unknown }

async function readTaskPage(
  task: DirectoryTask, cursors: Map<string, ActiveCursor>, targetRealpath: string,
  bulk: DirectoryMetadataSource | undefined, node: DirectoryMetadataSource,
  fallbackDirectories: Set<string>, batchSize: number, options: ProgressiveScanOptions
): Promise<TaskPageRead> {
  let active = cursors.get(task.id)
  try {
    if (!active) {
      active = await openCursor(task.path, targetRealpath, bulk, node, fallbackDirectories)
      await skipEntries(active.cursor, task.entriesRead, batchSize, options.signal)
      cursors.set(task.id, active)
    }
    const firstRootBatch = Boolean(options.onPreview) && task.depth === 0 && task.entriesRead === 0
    const page = await active.cursor.readPage(firstRootBatch ? FIRST_PREVIEW_ENTRIES : batchSize, options.signal ?? new AbortController().signal)
    return { ok: true, task, page }
  } catch (error) {
    if (active?.source === "bulk" && !options.signal?.aborted) {
      await closeCursor(cursors, task.id)
      fallbackDirectories.add(task.path)
      try {
        const fallback = await node.open(task.path, targetRealpath)
        await skipEntries(fallback, task.entriesRead, batchSize, options.signal)
        active = { cursor: fallback, source: "node" }
        cursors.set(task.id, active)
        const firstRootBatch = Boolean(options.onPreview) && task.depth === 0 && task.entriesRead === 0
        const page = await fallback.readPage(firstRootBatch ? FIRST_PREVIEW_ENTRIES : batchSize, options.signal ?? new AbortController().signal)
        return { ok: true, task, page }
      } catch (fallbackError) {
        await closeCursor(cursors, task.id)
        return { ok: false, task, error: fallbackError }
      }
    }
    await closeCursor(cursors, task.id)
    return { ok: false, task, error }
  }
}

function applyUnreadableBatch(
  database: ProgressiveScanDatabase, task: DirectoryTask, disappearing: boolean, totals: ReturnType<typeof mutableTotals>
): void {
  const totalsBeforeBatch = { ...totals }
  try {
    database.applyMetadataBatch(() => {
      database.startTask(task.id)
      database.markUnreadable(task.id, disappearing)
      database.bumpRevision()
      totals.skippedItems += 1
      totals.unreadableItems += 1
      if (disappearing) totals.disappearingItems += 1
    })
  } catch (error) {
    Object.assign(totals, totalsBeforeBatch)
    throw error
  }
}

function processPage(
  entries: readonly DirectoryMetadataEntry[], task: DirectoryTask, database: ProgressiveScanDatabase, options: ProgressiveScanOptions,
  preflight: Awaited<ReturnType<typeof preflightShape>>, totals: ReturnType<typeof mutableTotals>,
  nodeId: (parentId: string, name: string) => string, recordAggregation: (operation: () => void) => void
): number {
  let accepted = 0
  const focused = task.focused || database.taskIsFocused(task.id)
  for (const entry of entries) {
    throwIfCanceled(options.signal)
    const path = normalize(resolve(task.path, entry.name))
    if (entry.error) {
      const disappearing = isDisappearing(entry.error)
      totals.skippedItems += 1
      database.observeSkipped(task.id, disappearing ? { disappearing: true } : { unreadable: true })
      if (disappearing) totals.disappearingItems += 1
      else totals.unreadableItems += 1
      continue
    }
    if (!isWithin(path, preflight.target) || shouldExclude(path, options, preflight.indexRoot)) { totals.skippedItems += 1; database.observeSkipped(task.id); continue }
    if (entry.kind === "symlink") { totals.skippedItems += 1; totals.symlinks += 1; database.observeSkipped(task.id, { symlink: true }); continue }
    if (entry.mountPoint || entry.device !== "" && entry.device !== preflight.rootDevice) { totals.skippedItems += 1; totals.nestedMounts += 1; database.observeSkipped(task.id, { nestedMount: true }); continue }
    if (preflight.indexIdentity && entry.kind === "directory" && identity({ dev: entry.device, ino: entry.inode }) === preflight.indexIdentity) { totals.skippedItems += 1; database.observeSkipped(task.id); continue }
    const kind = entry.kind === "directory" || entry.kind === "file" ? entry.kind : undefined
    if (!kind) { totals.skippedItems += 1; database.observeSkipped(task.id); continue }
    const id = nodeId(task.id, entry.name)
    const bytes = Math.max(0, entry.allocatedBytes)
    const pathKey = relative(preflight.target, path)
    let replacingOwner = false
    if (kind === "file") database.insertFileAlias(task.id, entry.name, pathKey, entry.device, entry.inode, bytes)
    const needsHardLinkOwnership = kind === "file" && entry.device !== "" && entry.inode !== "" && entry.linkCount !== 1
    if (needsHardLinkOwnership) {
      const owner = database.getHardLinkOwner(entry.device, entry.inode)
      if (owner) {
        totals.skippedItems += 1
        totals.duplicateHardLinks += 1
        if (comparePaths(pathKey, owner.pathKey) >= 0) {
          database.observeSkipped(task.id, { duplicate: true })
          continue
        }
        const previousParentId = database.getNode(owner.nodeId)?.parentId
        if (previousParentId) database.observeSkipped(previousParentId, { duplicate: true })
        replacingOwner = true
        recordAggregation(() => database.removeOwnedFile(owner.nodeId))
      }
    }
    recordAggregation(() => database.insertChild({ id, parentId: task.id, name: entry.name, path, kind, ownBytes: bytes, device: entry.device, inode: entry.inode }, task.depth + 1, focused))
    if (needsHardLinkOwnership) database.setHardLinkOwner(entry.device, entry.inode, id, pathKey)
    if (!replacingOwner) {
      totals.scannedItems += 1
      totals.discoveredBytes += bytes
    }
    accepted += 1
  }
  return accepted
}

// Gives TypeScript a named structural type for preflight data without exporting private paths.
async function preflightShape() {
  return { indexRoot: "", indexIdentity: undefined as string | undefined, target: "", targetRealpath: "", rootStats: {} as ScanStats, rootDevice: "", capacityBytes: 0, freeBytes: 0 }
}

class PreviewReporter {
  #lastProgress = 0
  #lastPreview = 0
  #firstPreview = false
  constructor(private readonly options: ProgressiveScanOptions, private readonly startedAt: number, private readonly totals: ReturnType<typeof mutableTotals>) {}
  progress(item: string, force = false, stage: ScanProgress["stage"] = "traversing"): void {
    const now = Date.now()
    if (!force && now - this.#lastProgress < PREVIEW_INTERVAL_MS) return
    this.#lastProgress = now
    this.options.onProgress?.({ stage, scannedItems: this.totals.scannedItems, discoveredBytes: this.totals.discoveredBytes, elapsedMs: now - this.startedAt, currentItem: item })
  }
  focus(database: ProgressiveScanDatabase, volume: { target: string; capacityBytes: number; freeBytes: number }): void {
    if (!this.#firstPreview) return
    this.emit(database, volume, false)
  }
  estimate(database: ProgressiveScanDatabase, volume: { target: string; capacityBytes: number; freeBytes: number }): void {
    if (!this.#firstPreview) return
    this.emit(database, volume, false)
  }
  resume(database: ProgressiveScanDatabase, volume: { target: string; capacityBytes: number; freeBytes: number }): void {
    if (!this.options.onPreview) return
    this.emit(database, volume, true)
  }
  batch(database: ProgressiveScanDatabase, taskId: string, volume: { target: string; capacityBytes: number; freeBytes: number }, rootPageCompleted: boolean): void {
    this.progress(database.getNode(taskId)?.name ?? "")
    this.options.control.consumeFocusRequest()
    if (!this.options.onPreview) return
    const now = Date.now()
    if (!this.#firstPreview) {
      if (!rootPageCompleted) return
      this.emit(database, volume, true)
      return
    }
    if (now - this.#lastPreview < PREVIEW_INTERVAL_MS) return
    this.emit(database, volume, false)
  }
  private emit(database: ProgressiveScanDatabase, volume: { target: string; capacityBytes: number; freeBytes: number }, first: boolean): void {
    const now = Date.now()
    if (!first && now - this.#lastPreview < PREVIEW_INTERVAL_MS) return
    const onPreview = this.options.onPreview
    if (!onPreview) return
    const focusId = this.options.control.focusId
    const focus = focusId ? database.getNode(focusId) : undefined
    if (!focus || focus.kind !== "directory") return
    this.#firstPreview = true
    this.#lastPreview = now
    const breadcrumbs = database.getBreadcrumbs(focus.id)
    const rootId = breadcrumbs[0]?.id ?? focus.id
    const root = database.getNode(rootId)
    const scannedBytes = root?.confirmedBytes ?? focus.confirmedBytes
    const unscannedBytes = volume.target === "/" ? Math.max(0, volume.capacityBytes - volume.freeBytes - scannedBytes) : 0
    onPreview({
      generation: this.options.generation, revision: database.revision, committed: false,
      target: { name: displayName(volume.target), isStartup: volume.target === "/" },
      focus: summary(focus), breadcrumbs, chart: buildChart(database, focus, {
        rootTotalBytes: focus.id === rootId && volume.target === "/" ? volume.capacityBytes : 0
      }), largestItems: database.getLargestItems(focus.id),
      volume: { capacityBytes: volume.capacityBytes, freeBytes: volume.freeBytes, scannedBytes, unscannedBytes, sizeAccuracy: unscannedBytes > 0 ? "estimated" : focus.sizeAccuracy }
    })
  }
}

function summary(node: NonNullable<ReturnType<ProgressiveScanDatabase["getNode"]>>): NodeSummary {
  return { id: node.id, parentId: node.parentId, name: node.name, kind: node.kind, sizeBytes: node.sizeBytes, ...(node.estimatedBytes > 0 ? { estimatedSizeBytes: node.estimatedBytes } : {}), directChildren: node.directChildren, descendantCount: node.descendantCount, unreadableCount: node.unreadableCount, scanState: node.scanState, sizeAccuracy: node.sizeAccuracy }
}

async function closeCursor(cursors: Map<string, ActiveCursor>, id: string): Promise<void> {
  const handle = cursors.get(id)
  cursors.delete(id)
  if (handle) await handle.cursor.close().catch(() => undefined)
}
async function closeOneCursor(cursors: Map<string, ActiveCursor>, except: string): Promise<void> { const id = [...cursors.keys()].find((value) => value !== except); if (id) await closeCursor(cursors, id) }
async function closeAll(cursors: Map<string, ActiveCursor>): Promise<void> { await Promise.all([...cursors.keys()].map((id) => closeCursor(cursors, id))) }

function mutableTotals() {
  return {
    scannedItems: 0, discoveredBytes: 0, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0,
    duplicateHardLinks: 0, disappearingItems: 0, bulkMetadataEntries: 0, fallbackMetadataEntries: 0
  }
}
function resolveConcurrency(value: number | undefined): number { const configured = value ?? Number(process.env.ORBIS_SCAN_CONCURRENCY ?? DEFAULT_METADATA_CONCURRENCY); return Number.isFinite(configured) ? Math.max(1, Math.min(64, Math.floor(configured))) : DEFAULT_METADATA_CONCURRENCY }
function resolveMetadataBatchSize(value: number | undefined): number {
  const configured = value ?? Number(process.env.ORBIS_METADATA_BATCH_SIZE ?? DEFAULT_METADATA_BATCH_SIZE)
  return Number.isFinite(configured) ? Math.max(1, Math.min(MAX_METADATA_BATCH_SIZE, Math.floor(configured))) : DEFAULT_METADATA_BATCH_SIZE
}
function shouldExclude(path: string, options: ScanOptions, indexRoot: string): boolean { return isWithin(path, indexRoot) || options.startupRoot !== false && normalize(options.target) === "/" && STARTUP_EXCLUSIONS.some((excluded) => isWithin(path, excluded)) }
function isWithin(path: string, parent: string): boolean { const child = normalize(path); const root = normalize(parent); const remainder = relative(root, child); return child === root || remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) }
function comparePaths(left: string, right: string): number { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')) }
function displayName(path: string): string { return path === "/" ? "/" : basename(path) || path }
function part(value: number | bigint | string): string { return String(value) }
function identity(stats: { readonly dev: number | bigint | string; readonly ino: number | bigint | string }): string { return `${part(stats.dev)}:${part(stats.ino)}` }
function allocatedBytes(stats: Pick<ScanStats, "blocks">): number { return numberValue(stats.blocks ?? 0) * 512 }
function blockBytes(blocks: number | bigint, size: number | bigint): number { return numberValue(blocks) * numberValue(size) }
function numberValue(value: number | bigint): number { const number = typeof value === "bigint" ? Number(value) : Number(value); return Number.isFinite(number) && number > 0 ? number : 0 }
function throwIfCanceled(signal: AbortSignal | undefined): void { if (signal?.aborted) throw new ScanCanceledError() }
function isDisappearing(error: unknown): boolean { const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : ""; return code === "ENOENT" || code === "ENOTDIR" }

type NodeDirectoryHandle = { read(): Promise<{ name: string } | null>; close(): Promise<void> }

export type { ScanProgress, ScanResult, ScanTotals }
