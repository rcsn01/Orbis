import { createHmac, randomBytes } from "node:crypto"
import { lstat, open, opendir, realpath, rename, statfs } from "node:fs/promises"
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path"
import type { Breadcrumb, ChartSegment, NodeSummary, VolumeSnapshot } from "../shared/contracts"
import { buildChart } from "./chart"
import { prepareDatabaseDirectory, removeDatabaseFiles } from "./database"
import { createScanTimingAccumulator, measureScan, measureScanAsync, publishScanWork, recordScanCounter, runWithScanDiagnostics, type ResumeMilestone, type ResumePreparationPhase, type ScanTimingAccumulator } from "./diagnostics"
import {
  ConstructionDatabase,
  ConstructionError,
  type ConstructionCheckpointRequest,
  type ConstructionInput,
  type ConstructionPage,
  type ConstructionPageResult,
  type ConstructionCheckpointNotice,
  type DirectoryTask
} from "./construction-database"
import type { FullScanResumeDescriptor, FullScanResumeStore } from './full-scan-resume'
import {
  createDirectoryMetadataSource, loadNativeMetadataAddon, NodeDirectoryMetadataSource,
  type DirectoryMetadataCursor, type DirectoryMetadataSource, type FolderSizeEstimate, type NativeAddonProbe
} from "./scan-metadata"
import {
  DEFAULT_METADATA_CONCURRENCY, STARTUP_EXCLUSIONS, ScanCanceledError,
  type ScanFileSystem, type ScanOptions, type ScanProgress, type ScanResult, type ScanStats, type ScanTotals
} from "./legacy-scanner"

interface ScanWorkTimings {
  readonly scheduler: ScanTimingAccumulator
  readonly metadataOpen: ScanTimingAccumulator
  readonly metadataRead: ScanTimingAccumulator
  readonly pageNormalize: ScanTimingAccumulator
  readonly aggregation: ScanTimingAccumulator
  readonly candidateFinalize: ScanTimingAccumulator
}

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

export class ResumeJournalInvalidatedError extends Error {
  constructor(readonly reason: string) {
    super(`resume-invalidated:${reason}`)
    this.name = 'ResumeJournalInvalidatedError'
  }
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
  readonly onCheckpointNotice?: (notice: ConstructionCheckpointNotice) => void
  readonly onNativeAddonStatus?: NativeAddonProbe
  readonly onResumeMilestone?: (milestone: ResumeMilestone) => void
  readonly onResumePreparation?: (phase: ResumePreparationPhase) => void | Promise<void>
  readonly onMetadataPageAccepted?: () => void
  readonly drainResumeJournal?: (eventId: string) => { readonly throughEventId: string; readonly scopes: readonly string[]; readonly restartReason?: string }
  /** Internal traversal tuning. The benchmark worker uses ORBIS_METADATA_BATCH_SIZE instead. */
  readonly metadataBatchSize?: number
}

export class ProgressiveScanControl {
  #database: ConstructionDatabase | undefined
  #focusId: string | undefined
  #focusRequested = false
  #onFocus: (() => void) | undefined

  attach(database: ConstructionDatabase, rootId: string, onFocus?: () => void): void {
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
  lstat: async (path) => lstat(path, { bigint: true }),
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
  const nativeAddon = await loadNativeMetadataAddon(options.nativeAddonPath, options.onNativeAddonStatus)
  const nodeMetadataSource = new NodeDirectoryMetadataSource(fileSystem, metadataConcurrency)
  let bulkMetadataSource = options.directoryMetadataSource
  const startedAt = Date.now()
  const totals = mutableTotals()
  const reporter = new PreviewReporter(options, startedAt, totals)
  const workTimings: ScanWorkTimings = {
    scheduler: createScanTimingAccumulator('scheduler'), metadataOpen: createScanTimingAccumulator('metadata-open'),
    metadataRead: createScanTimingAccumulator('metadata-read'), pageNormalize: createScanTimingAccumulator('page-normalize'),
    aggregation: createScanTimingAccumulator('aggregation'), candidateFinalize: createScanTimingAccumulator('candidate-finalize')
  }
  let workTimingsPublished = false
  const publishWorkTimings = (): void => {
    if (workTimingsPublished) return
    workTimingsPublished = true
    for (const timing of Object.values(workTimings)) timing.publish()
    publishScanWork('metadata-batch-flush')
    publishScanWork('database-checkpoint')
    reporter.publishTimings()
  }
  let key = randomBytes(32)
  const nodeId = (parentId: string, name: string): string => `n-${createHmac("sha256", key).update(parentId).update("\0").update(name).digest("hex").slice(0, 32)}`
  const cursors = new Map<string, ActiveCursor>()
  const bulkFallbackDirectories = new Set<string>()
  let database: ConstructionDatabase | undefined
  let constructionActive = true
  let resumeMetadataPageReported = false
  const reportAcceptedMetadataPage = (): boolean => {
    options.onMetadataPageAccepted?.()
    if (!options.resumable?.resume || resumeMetadataPageReported) return false
    resumeMetadataPageReported = true
    options.onResumeMilestone?.('first-metadata-page')
    return true
  }

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
      if (options.resumable?.resume) {
        const descriptor = options.resumable.descriptor
        if (target !== descriptor.target || indexIdentity !== descriptor.indexDirectoryIdentity
          || part(rootStats.dev) !== descriptor.targetDevice || part(rootStats.ino) !== descriptor.targetInode) {
          throw new Error('resume-invalidated:resume-identity-mismatch')
        }
      }
      if (!options.resumable?.resume) await removeDatabaseFiles(options.partialPath)
      return {
        indexRoot, indexIdentity, target, rootStats, rootDevice: part(rootStats.dev),
        targetRealpath: await fileSystem.realpath(target),
        capacityBytes: blockBytes(volume.blocks, volume.bsize), freeBytes: blockBytes(volume.bfree, volume.bsize)
      }
    })
  } catch (error) {
    options.control.detach()
    publishWorkTimings()
    if (!options.resumable) await removeDatabaseFiles(options.partialPath)
    throw error
  }

  bulkMetadataSource ??= createDirectoryMetadataSource(nativeAddon, fileSystem, metadataConcurrency, preflight.target, options.onNativeAddonStatus)

  let rootId = ''
  let activeElapsedBefore = 0
  let lastCheckpointAt = Date.now()
  let entriesSinceCheckpoint = 0
  let lastJournalDrainAt = Date.now()
  let resumeJournal: { readonly drainedThrough: string; readonly dirtyScopes: readonly string[] } | undefined
  try {
    if (options.resumable?.resume) {
      await options.onResumePreparation?.('recovering')
      database = measureScan('resume-database-open', () => ConstructionDatabase.openResumable(options.partialPath, {
        candidatePath: options.publishedPath, onCheckpoint: (notice: ConstructionCheckpointNotice) => {
          options.onCheckpointNotice?.(notice)
          options.onCheckpoint?.(notice.sequence)
        }
      }))
      key = Buffer.from(database.nodeIdSeed, 'hex')
      rootId = nodeId('root', preflight.target)
      let recovered: ReturnType<ConstructionDatabase['recoverIncompleteDirectories']>
      try {
        recovered = measureScan('resume-incomplete-recovery', () => database!.recoverIncompleteDirectories())
      } catch (error) {
        if (error instanceof ConstructionError && error.code === 'invalid-resume') {
          throw new Error('resume-invalidated:invalid-construction-state', { cause: error })
        }
        throw error
      }
      recordScanCounter('resumeRecoveryRoots', recovered.roots)
      recordScanCounter('resumeDeletedNodes', recovered.deletedNodes)
      recordScanCounter('resumeAffectedHardlinkIdentities', recovered.affectedHardlinkIdentities)
      recordScanCounter('resumeRepairedAncestors', recovered.repairedAncestors)
      recordScanCounter('resumeRepairedSchedulerRows', recovered.repairedSchedulerRows)
      await options.onResumePreparation?.('repairing')
      const persisted = measureScan('resume-semantic-totals', () => database!.semanticTotals())
      Object.assign(totals, persisted)
      activeElapsedBefore = persisted.activeElapsedMs
      measureScan('resume-checkpoint', () => database!.checkpoint({ reason: 'resume' }))
      await options.onResumePreparation?.('starting')
    } else if (options.resumable) {
      const descriptor = options.resumable.descriptor
      database = measureScan('database-create', () => ConstructionDatabase.create(options.partialPath, {
        scanId: descriptor.scanId, journalDevice: descriptor.journalDevice, journalUuid: descriptor.journalUuid,
        journalBaseline: descriptor.journalBaseline, candidatePath: options.publishedPath,
        onCheckpoint: (notice: ConstructionCheckpointNotice) => {
          options.onCheckpointNotice?.(notice)
          options.onCheckpoint?.(notice.sequence)
        }
      }))
      key = Buffer.from(database.nodeIdSeed, 'hex')
      rootId = nodeId('root', preflight.target)
      database.checkpoint({ reason: 'startup' })
      await options.resumable.store.publish(descriptor)
    } else {
      database = measureScan("database-create", () => new ConstructionDatabase(options.partialPath))
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

    if (options.initialEstimate && !options.resumable?.resume) {
      database.applyEstimates(options.initialEstimate)
      database.bumpRevision()
    }
    reporter.initial(database, preflight)
    reporter.progress(displayName(preflight.target), true)

    let focusTurns = 0
    const checkpointNow = (finalDrain: boolean): void => {
      if (!options.resumable || !database) return
      const now = Date.now()
      const drainDue = Boolean(options.drainResumeJournal) && (finalDrain || now - lastJournalDrainAt >= 30_000)
      let journalDrain: ConstructionCheckpointRequest['journalDrain']
      if (drainDue && options.drainResumeJournal) {
        const drain = options.drainResumeJournal(database.drainedThrough)
        if (drain.restartReason) throw new ResumeJournalInvalidatedError(drain.restartReason)
        journalDrain = { scopes: drain.scopes, throughEventId: drain.throughEventId }
        lastJournalDrainAt = now
      }
      database.checkpoint({
        reason: finalDrain ? 'finalize' : 'scheduled', activeElapsedDeltaMs: now - lastCheckpointAt,
        ...(journalDrain ? { journalDrain } : {})
      })
      lastCheckpointAt = now
      entriesSinceCheckpoint = 0
    }
    const checkpointDue = (): void => {
      if (!options.resumable || !database) return
      const now = Date.now()
      const journalDue = Boolean(options.drainResumeJournal) && now - lastJournalDrainAt >= 30_000
      if (now - lastCheckpointAt >= 5_000 || entriesSinceCheckpoint >= 32_768 || journalDue) checkpointNow(false)
    }
    await measureScanAsync("traversal", async () => {
      // Native bulk pages are synchronous and already contain metadata. Node
      // fallback uses the Stage 5 scan-wide mapper, so keep several eligible
      // directory pages in flight while applying their results in scheduler
      // order. SQLite and hard-link decisions remain single-threaded.
      const pageConcurrency = bulkMetadataSource
        ? Math.max(1, Math.min(metadataConcurrency, bulkMetadataSource.pageConcurrency ?? 1))
        : metadataConcurrency
      while (true) {
        throwIfCanceled(options.signal)
        const batch = workTimings.scheduler.measure(() => database!.takeWork({ limit: pageConcurrency, focusTurns }))
        const tasks = batch.work
        focusTurns = batch.focusTurns
        if (batch.done) break
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
              const active = await openCursor(task.path, preflight.targetRealpath, undefined, nodeMetadataSource, bulkFallbackDirectories, workTimings)
              await skipEntries(active.cursor, task.entriesRead, metadataBatchSize, options.signal)
              cursors.set(task.id, active)
            } catch (error) { preparationErrors.set(task.id, error) }
          }
        }
        const reads = await Promise.all(tasks.map((task) => {
          const preparationError = preparationErrors.get(task.id)
          return preparationError === undefined
            ? readTaskPage(task, cursors, preflight.targetRealpath, bulkMetadataSource, nodeMetadataSource, bulkFallbackDirectories, metadataBatchSize, options, workTimings)
            : Promise.resolve<TaskPageRead>({ ok: false, task, error: preparationError })
        }))
        for (const read of reads) {
          throwIfCanceled(options.signal)
          const task = read.task
          if (!read.ok) {
            const delta = workTimings.aggregation.measure(() => database!.accept({ kind: 'unreadable', taskId: task.id, disappearing: isDisappearing(read.error), enumerationEpoch: task.enumerationEpoch }))
            addConstructionTotals(totals, delta)
            const firstResumePage = reportAcceptedMetadataPage()
            checkpointDue()
            reporter.batch(database!, task, preflight, task.id === rootId || firstResumePage)
            continue
          }
          const page = read.page
          const firstRootPage = task.id === rootId && task.entriesRead === 0
          const focused = task.focused || database!.taskIsFocused(task.id)
          const input: ConstructionInput = {
            kind: 'page',
            page: workTimings.pageNormalize.measure(() => normalizeConstructionPage(page, task, focused, options, preflight, nodeId))
          }
          const delta = workTimings.aggregation.measure(() => database!.accept(input))
          addConstructionTotals(totals, delta)
          entriesSinceCheckpoint += page.entries.length
          if (options.resumable?.resume) recordScanCounter('resumeReplayedEntries', page.entries.length)
          const firstResumePage = page.entries.length > 0 || page.done ? reportAcceptedMetadataPage() : false
          if (page.entries.length === 0 && !page.done) options.onMetadataPageAccepted?.()
          if (page.done) await closeCursor(cursors, task.id)
          reporter.batch(database!, task, preflight, task.id === rootId && firstRootPage || firstResumePage)
          checkpointDue()
        }
      }
    })
    await closeAll(cursors)
    await bulkMetadataSource?.close?.()
    constructionActive = false
    throwIfCanceled(options.signal)
    let finalJournalDrain: ConstructionCheckpointRequest['journalDrain']
    if (options.resumable && options.drainResumeJournal) {
      const drain = options.drainResumeJournal(database.drainedThrough)
      if (drain.restartReason) throw new ResumeJournalInvalidatedError(drain.restartReason)
      finalJournalDrain = { scopes: drain.scopes, throughEventId: drain.throughEventId }
    }
    const root = database.getNode(rootId)
    if (!root || root.scanState !== "complete" && root.scanState !== "unreadable") throw new Error("Progressive scan root did not reach a terminal state")
    const finalSemantic = database.semanticTotals()
    rebaseConstructionTotals(totals, finalSemantic, Boolean(options.resumable))
    reporter.progress(displayName(preflight.target), true, "indexing")
    if (options.resumable) {
      const dirtyScopes = [...new Set([...database.dirtyScopes, ...(finalJournalDrain?.scopes ?? [])])].sort()
      resumeJournal = { drainedThrough: finalJournalDrain?.throughEventId ?? database.drainedThrough, dirtyScopes }
    }
    const elapsedMs = activeElapsedBefore + Date.now() - startedAt
    const finalTotals: ScanTotals = {
      scannedItems: totals.scannedItems, discoveredBytes: root.confirmedBytes, elapsedMs, skippedItems: totals.skippedItems,
      unreadableItems: totals.unreadableItems, nestedMounts: totals.nestedMounts, symlinks: totals.symlinks,
      duplicateHardLinks: totals.duplicateHardLinks, disappearingItems: totals.disappearingItems
    }
    const capturedAt = new Date().toISOString()
    const metadata = {
      target: preflight.target, rootId, capacityBytes: preflight.capacityBytes, freeBytes: preflight.freeBytes,
      scannedBytes: root.confirmedBytes, totals: finalTotals, targetDevice: preflight.rootDevice,
      targetInode: part(preflight.rootStats.ino), ...(preflight.indexIdentity ? { indexDirectoryIdentity: preflight.indexIdentity } : {}),
      indexRevision: 1, capturedAt, refreshedAt: capturedAt, ...(resumeJournal ? { resume: resumeJournal } : {})
    }
    if (options.resumable) {
      const finalization = measureScan("index-create", () => workTimings.candidateFinalize.measure(() => database!.finish({
        kind: 'finalize', metadata, checkpoint: {
          activeElapsedDeltaMs: Math.max(0, Date.now() - lastCheckpointAt), ...(finalJournalDrain ? { journalDrain: finalJournalDrain } : {})
        }
      })))
      if (finalization.kind !== 'candidate') throw new Error(`Unexpected construction finish result: ${finalization.kind}`)
      database = undefined
      options.control.detach()
      throwIfCanceled(options.signal)
      reporter.progress(displayName(preflight.target), true, "indexing")
      throwIfCanceled(options.signal)
      publishWorkTimings()
      return {
        generation: options.generation, target: preflight.target, rootId, publishedPath: finalization.candidatePath,
        capacityBytes: preflight.capacityBytes, freeBytes: preflight.freeBytes, scannedBytes: root.confirmedBytes, totals: finalTotals,
        metadata: {
          bulkMetadataEntries: totals.bulkMetadataEntries, fallbackMetadataEntries: totals.fallbackMetadataEntries,
          ...(resumeJournal ? { resume: resumeJournal } : {})
        }
      }
    }
    measureScan("index-create", () => workTimings.candidateFinalize.measure(() => database!.finalize()))
    measureScan("metadata-write", () => database!.writeMetadata(metadata))
    database.complete()
    database = undefined
    options.control.detach()
    throwIfCanceled(options.signal)
    await measureScanAsync("publish-rename", () => durableRename(options.partialPath, options.publishedPath))
    reporter.progress(displayName(preflight.target), true, "indexing")
    throwIfCanceled(options.signal)
    publishWorkTimings()
    return {
      generation: options.generation, target: preflight.target, rootId, publishedPath: options.publishedPath,
      capacityBytes: preflight.capacityBytes, freeBytes: preflight.freeBytes, scannedBytes: root.confirmedBytes, totals: finalTotals,
      metadata: { bulkMetadataEntries: totals.bulkMetadataEntries, fallbackMetadataEntries: totals.fallbackMetadataEntries }
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
        if (error instanceof ScanCanceledError || options.signal?.aborted) {
          let journalDrain: ConstructionCheckpointRequest['journalDrain']
          if (options.drainResumeJournal) {
            try {
              const drain = options.drainResumeJournal(failedDatabase.drainedThrough)
              if (!drain.restartReason) journalDrain = { scopes: drain.scopes, throughEventId: drain.throughEventId }
            } catch { /* A failed drain must not discard the pause checkpoint. */ }
          }
          const result = failedDatabase.finish({
            kind: 'pause', activeElapsedDeltaMs: Math.max(0, Date.now() - lastCheckpointAt),
            ...(journalDrain ? { journalDrain } : {})
          })
          void result
        } else if (error instanceof ResumeJournalInvalidatedError) {
          // The failed drain never advanced the watermark. Preserve all
          // committed traversal work at the last trusted cursor so a later
          // Resume can validate the missing history before continuing.
          failedDatabase.finish({ kind: 'pause', activeElapsedDeltaMs: Math.max(0, Date.now() - lastCheckpointAt) })
        } else {
          failedDatabase.finish({ kind: 'unexpected-failure', cause: error })
        }
      } catch { failedDatabase.abort() }
    } else failedDatabase?.abort()
    if (!options.resumable) {
      await removeDatabaseFiles(options.partialPath)
      await removeDatabaseFiles(options.publishedPath)
    }
    publishWorkTimings()
    throw error
  }
}

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
  fallbackDirectories: Set<string>, timings: Pick<ScanWorkTimings, 'metadataOpen'>
): Promise<ActiveCursor> {
  if (bulk && !fallbackDirectories.has(path)) {
    try { return { cursor: await timings.metadataOpen.measureAsync(() => bulk.open(path, targetRealpath)), source: "bulk" } }
    catch { fallbackDirectories.add(path) }
  }
  return { cursor: await timings.metadataOpen.measureAsync(() => node.open(path, targetRealpath)), source: "node" }
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
  fallbackDirectories: Set<string>, batchSize: number, options: ProgressiveScanOptions,
  timings: Pick<ScanWorkTimings, 'metadataOpen' | 'metadataRead'>
): Promise<TaskPageRead> {
  let active = cursors.get(task.id)
  try {
    if (!active) {
      active = await openCursor(task.path, targetRealpath, bulk, node, fallbackDirectories, timings)
      await skipEntries(active.cursor, task.entriesRead, batchSize, options.signal)
      cursors.set(task.id, active)
    }
    const firstRootBatch = Boolean(options.onPreview) && task.depth === 0 && task.entriesRead === 0
    const page = await timings.metadataRead.measureAsync(() => active!.cursor.readPage(firstRootBatch ? FIRST_PREVIEW_ENTRIES : batchSize, options.signal ?? new AbortController().signal))
    return { ok: true, task, page }
  } catch (error) {
    if (active?.source === "bulk" && !options.signal?.aborted) {
      await closeCursor(cursors, task.id)
      fallbackDirectories.add(task.path)
      try {
        const fallback = await timings.metadataOpen.measureAsync(() => node.open(task.path, targetRealpath))
        await skipEntries(fallback, task.entriesRead, batchSize, options.signal)
        active = { cursor: fallback, source: "node" }
        cursors.set(task.id, active)
        const firstRootBatch = Boolean(options.onPreview) && task.depth === 0 && task.entriesRead === 0
        const page = await timings.metadataRead.measureAsync(() => fallback.readPage(firstRootBatch ? FIRST_PREVIEW_ENTRIES : batchSize, options.signal ?? new AbortController().signal))
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

function normalizeConstructionPage(
  page: DirectoryMetadataPage, task: DirectoryTask, focused: boolean, options: ProgressiveScanOptions,
  preflight: Awaited<ReturnType<typeof preflightShape>>, nodeId: (parentId: string, name: string) => string
): ConstructionPage {
  const entries: ConstructionPage['entries'][number][] = []
  for (const entry of page.entries) {
    throwIfCanceled(options.signal)
    const path = normalize(resolve(task.path, entry.name))
    if (entry.error) {
      entries.push({ kind: 'skipped', observation: isDisappearing(entry.error) ? { disappearing: true } : { unreadable: true } })
      continue
    }
    if (!isWithin(path, preflight.target) || shouldExclude(path, options, preflight.indexRoot)) {
      entries.push({ kind: 'skipped', observation: {} })
      continue
    }
    if (entry.kind === 'symlink') {
      entries.push({ kind: 'skipped', observation: { symlink: true } })
      continue
    }
    if (entry.mountPoint || entry.device !== '' && entry.device !== preflight.rootDevice) {
      entries.push({ kind: 'skipped', observation: { nestedMount: true } })
      continue
    }
    if (preflight.indexIdentity && entry.kind === 'directory' && identity({ dev: entry.device, ino: entry.inode }) === preflight.indexIdentity) {
      entries.push({ kind: 'skipped', observation: {} })
      continue
    }
    const kind = entry.kind === 'directory' || entry.kind === 'file' ? entry.kind : undefined
    if (!kind) {
      entries.push({ kind: 'skipped', observation: {} })
      continue
    }
    const node = {
      id: nodeId(task.id, entry.name), parentId: task.id, name: entry.name, path, kind,
      ownBytes: Math.max(0, entry.allocatedBytes), device: entry.device, inode: entry.inode
    }
    entries.push({ kind: 'node', node: { node, pathKey: relative(preflight.target, path), ...(entry.linkCount === undefined ? {} : { linkCount: entry.linkCount }) } })
  }
  return {
    taskId: task.id, depth: task.depth, focused, entriesRead: task.entriesRead, enumerationEpoch: task.enumerationEpoch, done: page.done, entries,
    bulkMetadataEntries: page.bulkEntries, fallbackMetadataEntries: page.fallbackEntries
  }
}

function addConstructionTotals(totals: ReturnType<typeof mutableTotals>, delta: ConstructionPageResult): void {
  totals.scannedItems += delta.scannedItems
  totals.discoveredBytes += delta.discoveredBytes
  totals.skippedItems += delta.skippedItems
  totals.unreadableItems += delta.unreadableItems
  totals.disappearingItems += delta.disappearingItems
  totals.symlinks += delta.symlinks
  totals.nestedMounts += delta.nestedMounts
  totals.duplicateHardLinks += delta.duplicateHardLinks
  totals.bulkMetadataEntries += delta.bulkMetadataEntries
  totals.fallbackMetadataEntries += delta.fallbackMetadataEntries
}

function rebaseConstructionTotals(totals: ReturnType<typeof mutableTotals>, semantic: ReturnType<ConstructionDatabase['semanticTotals']>, includeMetadataCounters: boolean): void {
  totals.scannedItems = semantic.scannedItems
  totals.discoveredBytes = semantic.discoveredBytes
  totals.skippedItems = semantic.skippedItems
  totals.unreadableItems = semantic.unreadableItems
  totals.disappearingItems = semantic.disappearingItems
  totals.symlinks = semantic.symlinks
  totals.nestedMounts = semantic.nestedMounts
  totals.duplicateHardLinks = semantic.duplicateHardLinks
  if (includeMetadataCounters) {
    totals.bulkMetadataEntries = semantic.bulkMetadataEntries
    totals.fallbackMetadataEntries = semantic.fallbackMetadataEntries
  }
}

// Gives TypeScript a named structural type for preflight data without exporting private paths.
async function preflightShape() {
  return { indexRoot: "", indexIdentity: undefined as string | undefined, target: "", targetRealpath: "", rootStats: {} as ScanStats, rootDevice: "", capacityBytes: 0, freeBytes: 0 }
}

class PreviewReporter {
  #lastProgress = 0
  #lastPreview = 0
  #firstPreview = false
  readonly #previewTiming = createScanTimingAccumulator('preview-build')
  constructor(private readonly options: ProgressiveScanOptions, private readonly startedAt: number, private readonly totals: ReturnType<typeof mutableTotals>) {}
  progress(item: string, force = false, stage: ScanProgress["stage"] = "traversing"): void {
    const now = Date.now()
    if (!force && now - this.#lastProgress < PREVIEW_INTERVAL_MS) return
    this.#lastProgress = now
    this.options.onProgress?.({ stage, scannedItems: this.totals.scannedItems, discoveredBytes: this.totals.discoveredBytes, elapsedMs: now - this.startedAt, currentItem: item })
  }
  focus(database: ConstructionDatabase, volume: { target: string; capacityBytes: number; freeBytes: number }): void {
    if (!this.#firstPreview) return
    this.emit(database, volume, false)
  }
  estimate(database: ConstructionDatabase, volume: { target: string; capacityBytes: number; freeBytes: number }): void {
    if (!this.#firstPreview) return
    this.emit(database, volume, false)
  }
  initial(database: ConstructionDatabase, volume: { target: string; capacityBytes: number; freeBytes: number }): void {
    if (!this.options.onPreview) return
    this.emit(database, volume, true, false)
    // This bootstrap preview gives the renderer a root model before progress
    // starts. It must not delay the first data-bearing root-page preview.
    this.#firstPreview = false
    this.#lastPreview = 0
  }
  batch(database: ConstructionDatabase, task: DirectoryTask, volume: { target: string; capacityBytes: number; freeBytes: number }, rootPageCompleted: boolean): void {
    this.progress(displayName(task.path))
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
  publishTimings(): void { this.#previewTiming.publish() }
  private emit(database: ConstructionDatabase, volume: { target: string; capacityBytes: number; freeBytes: number }, first: boolean, prepare = true): void {
    this.#previewTiming.measure(() => {
      if (prepare) database.preparePreviewReadModel()
      this.build(database, volume, first)
    })
  }
  private build(database: ConstructionDatabase, volume: { target: string; capacityBytes: number; freeBytes: number }, first: boolean): void {
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
    const scannedBytes = database.semanticTotals().discoveredBytes
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

function summary(node: NonNullable<ReturnType<ConstructionDatabase["getNode"]>>): NodeSummary {
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
