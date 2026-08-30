import { constants } from 'node:fs'
import { copyFile, lstat, open, rename, statfs } from 'node:fs/promises'
import { basename, dirname, normalize, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ChangeJournal } from './change-journal'
import { createChangeJournal, FSEVENT_FLAGS, nativeChangeJournalAddon } from './change-journal'
import { prepareDatabaseDirectory, readMetadata, removeDatabaseFiles } from './database'
import { createScanTimingMilestones, measureScan, measureScanAsync, recordScanCounter, runWithScanDiagnostics, type ResumeMilestone, type ResumePreparationPhase } from './diagnostics'
import { FullScanResumeStore, type FullScanResumeDescriptor, type FullScanResumeLoad, type ResumeValidationReceipt } from './full-scan-resume'
import type { IndexManifest, JournalCursor } from './index-manifest'
import { planDirtyScopes, scanReplacementScopes } from './incremental-scanner'
import { IncrementalFallbackError, replaceIndexSubtrees } from './persistent-index-database'
import { publicationIdFromDatabaseFile } from './publication-artifacts'
import { loadNativeOrbisAddon } from './scan-metadata'
import { ScanCanceledError, STARTUP_EXCLUSIONS, scanFilesystem, type ScanOptions, type ScanResult, type ScanTotals } from './scanner'
import { ResumeJournalInvalidatedError } from './progressive-scanner'

export interface ActivePersistentIndex {
  readonly manifest: IndexManifest
  readonly path: string
}

export interface RefreshRequest extends ScanOptions {
  readonly active?: ActivePersistentIndex
  readonly changeJournal?: ChangeJournal
  readonly resumeExpected?: boolean
  readonly resumeReceipt?: ResumeValidationReceipt
  readonly onResumePreparation?: (phase: ResumePreparationPhase) => void | Promise<void>
}

export type RefreshOutcome =
  | { readonly kind: 'candidate'; readonly strategy: 'full' | 'incremental'; readonly result: ScanResult; readonly journal: JournalCursor | null; readonly basePublicationId?: string; readonly fallbackReason?: string }
  | { readonly kind: 'unchanged'; readonly strategy: 'incremental'; readonly journal: JournalCursor; readonly totals: ScanTotals; readonly basePublicationId: string }

const MAX_EVENTS = 50_000
const HISTORY_TIMEOUT_MS = 10_000
// Drains and replays return as soon as history is caught up plus a short
// straggler hedge; the cursor model catches anything later at the next drain
// or scan. The resume-validation read keeps the default 100ms quiet wait.
const REPLAY_QUIET_MS = 10

export function refreshPersistentIndex(request: RefreshRequest): Promise<RefreshOutcome> {
  return runWithScanDiagnostics(request.generation, () => {
    const timing = request.resumeExpected ? createScanTimingMilestones() : undefined
    const report = (milestone: ResumeMilestone): void => {
      if (milestone === 'first-metadata-page') timing?.mark('resume-first-metadata-page')
      request.onResumeMilestone?.(milestone)
    }
    if (request.resumeExpected) report('preparation-started')
    return measureScanAsync('refresh-total', () => refreshPersistentIndexImpl({ ...request, onResumeMilestone: report }))
  })
}

async function refreshPersistentIndexImpl(request: RefreshRequest): Promise<RefreshOutcome> {
  const refreshStartedAt = Date.now()
  if (request.referenceScan === true) {
    return { kind: 'candidate', strategy: 'full', result: await scanFilesystem(request), journal: null }
  }
  const addon = request.changeJournal ? undefined : await loadNativeOrbisAddon(request.nativeAddonPath, request.onNativeAddonStatus)
  const journal = request.changeJournal ?? createChangeJournal(nativeChangeJournalAddon(addon))
  const activeCursor = request.active?.manifest.journal
  if (request.resumeExpected) await request.onResumePreparation?.('validating')
  const saved = journal && process.env.ORBIS_DISABLE_INCREMENTAL_SCAN !== '1'
    ? await new FullScanResumeStore(request.indexDirectory).load(request.target, request.resumeReceipt) : { kind: 'none' as const }
  if (saved.kind === 'construction' || saved.kind === 'candidate') return fullRefresh(request, journal, undefined, 0, 0, saved)
  if (process.env.ORBIS_DISABLE_INCREMENTAL_SCAN === '1' || !request.active || !journal || !activeCursor) {
    return fullRefresh(request, journal)
  }
  const active = request.active
  const identityFailure = await validateActiveTarget(active.manifest)
  if (identityFailure) return fullRefresh(request, journal, identityFailure)

  const batch = await measureScanAsync('journal-replay', async () => journal.readChanges(request.target, activeCursor, MAX_EVENTS, HISTORY_TIMEOUT_MS, REPLAY_QUIET_MS))
  if (batch.requiresFullScan) return fullRefresh(request, journal, batch.reason ?? 'history-unavailable')
  const nextCursor = { uuid: activeCursor.uuid, eventId: batch.throughEventId }
  if (batch.events.length === 0) {
    return {
      kind: 'unchanged', strategy: 'incremental', journal: nextCursor,
      totals: readTotals(active.path), basePublicationId: active.manifest.publicationId
    }
  }

  const lookup = createIdentityLookup(active.path, request.target)
  let plan
  try {
    plan = await planDirtyScopes({ target: request.target, indexDirectory: request.indexDirectory, events: batch.events, ...(request.startupRoot !== undefined ? { startupRoot: request.startupRoot } : {}), lookupIdentity: lookup.lookup })
  } finally { lookup.close() }
  if (plan.kind === 'full') return fullRefresh(request, journal, plan.reason)
  if (plan.scopes.length === 0) {
    return {
      kind: 'unchanged', strategy: 'incremental', journal: nextCursor,
      totals: readTotals(active.path), basePublicationId: active.manifest.publicationId
    }
  }

  try {
    throwIfCanceled(request.signal)
    await measureScanAsync('candidate-clone', () => cloneIndex(active.path, request.partialPath))
    const scans = await measureScanAsync('incremental-traversal', () => scanReplacementScopes({
      generation: request.generation,
      indexDirectory: request.indexDirectory,
      scopes: plan.scopes,
      ...(request.nativeAddonPath ? { nativeAddonPath: request.nativeAddonPath } : {}),
      ...(request.directoryMetadataSource ? { directoryMetadataSource: request.directoryMetadataSource } : {}),
      ...(request.fileSystem ? { fileSystem: request.fileSystem } : {}),
      ...(request.metadataConcurrency !== undefined ? { metadataConcurrency: request.metadataConcurrency } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onNativeAddonStatus ? { onNativeAddonStatus: request.onNativeAddonStatus } : {})
    }))
    try {
      throwIfCanceled(request.signal)
      const volume = await volumeFor(request.target)
      const result = replaceIndexSubtrees({
        candidatePath: request.partialPath, target: request.target, replacements: scans.replacements,
        indexRevision: active.manifest.indexRevision + 1, capacityBytes: volume.capacityBytes,
        freeBytes: volume.freeBytes, elapsedMs: Date.now() - refreshStartedAt, targetAllocatedBytes: volume.targetAllocatedBytes
      })
      throwIfCanceled(request.signal)
      await measureScanAsync('candidate-publication', () => publishCandidate(request.partialPath, request.publishedPath))
      return {
        kind: 'candidate', strategy: 'incremental', journal: nextCursor,
        basePublicationId: active.manifest.publicationId,
        result: {
          generation: request.generation, target: request.target, rootId: result.rootId,
          publishedPath: request.publishedPath, capacityBytes: volume.capacityBytes, freeBytes: volume.freeBytes,
          scannedBytes: result.scannedBytes, totals: result.totals
        }
      }
    } finally { await scans.cleanup() }
  } catch (error) {
    await Promise.all([removeDatabaseFiles(request.partialPath), removeDatabaseFiles(request.publishedPath)])
    if (error instanceof ScanCanceledError || request.signal?.aborted) throw error
    return fullRefresh(request, journal, error instanceof IncrementalFallbackError ? error.message : 'incremental-failed')
  }
}

async function fullRefresh(request: RefreshRequest, journal: ChangeJournal | undefined, fallbackReason?: string, raceRetry = 0, resumeRestarts = 0, saved?: FullScanResumeLoad): Promise<RefreshOutcome> {
  const resumeStore = new FullScanResumeStore(request.indexDirectory)
  const resumable = journal && resumeRestarts === 0 && process.env.ORBIS_DISABLE_INCREMENTAL_SCAN !== '1'
    ? await prepareResumableFullScan(request, journal, resumeStore, saved)
    : undefined
  if (!resumable) await Promise.all([removeDatabaseFiles(request.partialPath), removeDatabaseFiles(request.publishedPath)])
  const checkpoint = resumable
    ? { device: resumable.descriptor.journalDevice, journalUuid: resumable.descriptor.journalUuid, eventId: resumable.descriptor.journalBaseline }
    : journal && process.env.ORBIS_DISABLE_INCREMENTAL_SCAN !== '1' ? safeCheckpoint(journal, request.target) : undefined
  let result: ScanResult
  try {
    if (!resumable?.candidate) recordScanCounter('fullScanAttempts')
    if (resumable?.candidate) await request.onResumePreparation?.('starting')
    result = resumable?.candidate
      ? readCandidateResult(resumable.candidate, request.generation)
      : await scanFilesystem({ ...request, partialPath: resumable?.partialPath ?? request.partialPath, publishedPath: resumable?.candidatePath ?? request.publishedPath,
          ...(resumable ? {
            resumable: { descriptor: resumable.descriptor, store: resumeStore, resume: resumable.resume },
            drainResumeJournal: createResumeJournalDrain(request, journal!, resumable.descriptor)
          } : {}) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (resumable && !(error instanceof ResumeJournalInvalidatedError) && message.startsWith('resume-invalidated:')) {
      await resumeStore.discard(resumable.descriptor.scanId)
      recordScanCounter('fullScanRetries')
      return fullRefresh(request, journal, message.slice('resume-invalidated:'.length), raceRetry, resumeRestarts + 1)
    }
    throw error
  }
  const privateDrain = result.metadata?.resume
  let cursor = checkpoint?.journalUuid && checkpoint.device === metadataTargetDevice(result.publishedPath)
    ? { uuid: checkpoint.journalUuid, eventId: privateDrain?.drainedThrough ?? checkpoint.eventId }
    : null

  // Reconcile changes after the pre-traversal fence. Retry one full traversal
  // when that fence is untrustworthy; a repeated failure discards the candidate
  // rather than publishing a snapshot invalidated during traversal.
  if (cursor && journal) {
    let reconciled = false
    const batch = await measureScanAsync('journal-replay', async () => journal.readChanges(request.target, cursor!, MAX_EVENTS, HISTORY_TIMEOUT_MS, REPLAY_QUIET_MS))
    if (batch.requiresFullScan) return retryFullRefresh(request, journal, batch.reason ?? 'post-scan-history-unavailable', raceRetry, resumeRestarts)
    else if (batch.events.length === 0 && (privateDrain?.dirtyScopes.length ?? 0) === 0) cursor = { uuid: cursor.uuid, eventId: batch.throughEventId }
    else {
      try {
        const lookup = createIdentityLookup(result.publishedPath, request.target)
        let plan
        try { plan = batch.events.length === 0
          ? { kind: 'incremental' as const, scopes: [] as readonly string[] }
          : await planDirtyScopes({ target: request.target, indexDirectory: request.indexDirectory, events: batch.events, ...(request.startupRoot !== undefined ? { startupRoot: request.startupRoot } : {}), lookupIdentity: lookup.lookup }) }
        finally { lookup.close() }
        if (plan.kind === 'full') return retryFullRefresh(request, journal, plan.reason, raceRetry, resumeRestarts)
        const reconciliationScopes = coalesceAbsoluteScopes([...(privateDrain?.dirtyScopes ?? []), ...plan.scopes])
        if (reconciliationScopes.length === 0) cursor = { uuid: cursor.uuid, eventId: batch.throughEventId }
        else {
          result = await reconcileFullCandidate(request, result, reconciliationScopes)
          reconciled = true
          cursor = { uuid: cursor.uuid, eventId: batch.throughEventId }
        }
      } catch (error) {
        if (error instanceof ScanCanceledError || request.signal?.aborted) throw error
        return retryFullRefresh(request, journal, 'post-scan-reconciliation-failed', raceRetry, resumeRestarts)
      }
    }
    if (reconciled) {
      let closed = false
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const closing = await measureScanAsync('journal-replay', async () => journal.readChanges(request.target, cursor!, MAX_EVENTS, HISTORY_TIMEOUT_MS, REPLAY_QUIET_MS))
        if (closing.requiresFullScan) return retryFullRefresh(request, journal, closing.reason ?? 'reconciliation-history-unavailable', raceRetry, resumeRestarts)
        const newEvents = closing.events.filter((event) => BigInt(event.eventId) > BigInt(cursor!.eventId))
        if (newEvents.length === 0) {
          cursor = { uuid: cursor.uuid, eventId: closing.throughEventId }
          closed = true
          break
        }
        const lookup = createIdentityLookup(result.publishedPath, request.target)
        let closingPlan
        try { closingPlan = await planDirtyScopes({ target: request.target, indexDirectory: request.indexDirectory, events: newEvents, ...(request.startupRoot !== undefined ? { startupRoot: request.startupRoot } : {}), lookupIdentity: lookup.lookup }) }
        finally { lookup.close() }
        if (closingPlan.kind === 'full') return retryFullRefresh(request, journal, closingPlan.reason, raceRetry, resumeRestarts)
        if (closingPlan.scopes.length > 0) result = await reconcileFullCandidate(request, result, closingPlan.scopes)
        cursor = { uuid: cursor.uuid, eventId: closing.throughEventId }
      }
      if (!closed) return retryFullRefresh(request, journal, 'reconciliation-window-busy', raceRetry, resumeRestarts)
    }
  }
  const effectiveFallback = fallbackReason ?? resumable?.expiredReason
  return {
    kind: 'candidate', strategy: 'full', result, journal: cursor,
    ...(effectiveFallback ? { fallbackReason: effectiveFallback } : {})
  }
}

async function reconcileFullCandidate(request: RefreshRequest, result: ScanResult, scopes: readonly string[]): Promise<ScanResult> {
  const scans = await scanReplacementScopes({
    generation: request.generation, indexDirectory: request.indexDirectory, scopes,
    ...(request.nativeAddonPath ? { nativeAddonPath: request.nativeAddonPath } : {}),
    ...(request.directoryMetadataSource ? { directoryMetadataSource: request.directoryMetadataSource } : {}),
    ...(request.fileSystem ? { fileSystem: request.fileSystem } : {}),
    ...(request.metadataConcurrency !== undefined ? { metadataConcurrency: request.metadataConcurrency } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.onNativeAddonStatus ? { onNativeAddonStatus: request.onNativeAddonStatus } : {})
  })
  try {
    const volume = await volumeFor(request.target)
    const updated = replaceIndexSubtrees({
      candidatePath: result.publishedPath, target: request.target, replacements: scans.replacements,
      indexRevision: metadataRevision(result.publishedPath) + 1, capacityBytes: volume.capacityBytes,
      freeBytes: volume.freeBytes, elapsedMs: result.totals.elapsedMs, targetAllocatedBytes: volume.targetAllocatedBytes
    })
    return { ...result, rootId: updated.rootId, scannedBytes: updated.scannedBytes, totals: updated.totals, capacityBytes: volume.capacityBytes, freeBytes: volume.freeBytes }
  } finally { await scans.cleanup() }
}

export function createResumeJournalDrain(request: RefreshRequest, journal: ChangeJournal, descriptor: FullScanResumeDescriptor) {
  return (eventId: string): { readonly throughEventId: string; readonly scopes: readonly string[]; readonly restartReason?: string } => {
    const batch = journal.readChanges(request.target, { uuid: descriptor.journalUuid, eventId }, MAX_EVENTS, HISTORY_TIMEOUT_MS, REPLAY_QUIET_MS)
    if (batch.requiresFullScan) return { throughEventId: eventId, scopes: [], restartReason: batch.reason ?? 'history-unavailable' }
    const target = normalize(resolve(request.target))
    const indexDirectory = normalize(resolve(request.indexDirectory))
    const requested: string[] = []
    for (const event of batch.events) {
      if (event.relativePath === '') return { throughEventId: eventId, scopes: [], restartReason: 'target-root-dirty' }
      const path = normalize(resolve(target, event.relativePath))
      if (!withinPath(path, target)) return { throughEventId: eventId, scopes: [], restartReason: 'malformed-history' }
      if (withinPath(path, indexDirectory)) continue
      if (target === '/' && request.startupRoot !== false && STARTUP_EXCLUSIONS.some((excluded) => withinPath(path, excluded))) continue
      const isDirectory = Boolean(event.flags & FSEVENT_FLAGS.itemIsDir)
      const membership = Boolean(event.flags & (FSEVENT_FLAGS.itemCreated | FSEVENT_FLAGS.itemRemoved | FSEVENT_FLAGS.itemRenamed))
      requested.push(isDirectory || event.flags & FSEVENT_FLAGS.mustScanSubDirs ? path : dirname(path))
      if (isDirectory && membership) requested.push(dirname(path))
    }
    const scopes = coalesceAbsoluteScopes(requested)
    if (scopes.some((scope) => scope === target)) return { throughEventId: eventId, scopes: [], restartReason: 'target-root-dirty' }
    if (scopes.length > 1024) return { throughEventId: eventId, scopes: [], restartReason: 'too-many-dirty-scopes' }
    return { throughEventId: batch.throughEventId, scopes }
  }
}

function coalesceAbsoluteScopes(paths: readonly string[]): readonly string[] {
  const sorted = [...new Set(paths.map((path) => normalize(resolve(path))))].sort((left, right) => left.length - right.length || left.localeCompare(right))
  const result: string[] = []
  for (const path of sorted) if (!result.some((parent) => withinPath(path, parent))) result.push(path)
  return result
}

function withinPath(path: string, parent: string): boolean {
  const remainder = relative(parent, path)
  return path === parent || remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`)
}

interface PreparedResume {
  readonly descriptor: FullScanResumeDescriptor
  readonly partialPath: string
  readonly candidatePath: string
  readonly resume: boolean
  readonly candidate?: string
  readonly expiredReason?: string
}

async function prepareResumableFullScan(request: RefreshRequest, journal: ChangeJournal, store: FullScanResumeStore, saved?: FullScanResumeLoad): Promise<PreparedResume | undefined> {
  const loaded = saved ?? await store.load(request.target)
  if (loaded.kind === 'construction' || loaded.kind === 'candidate') {
    const checkpoint = safeCheckpoint(journal, request.target)
    if (!checkpoint || checkpoint.device !== loaded.descriptor.journalDevice || checkpoint.journalUuid !== loaded.descriptor.journalUuid) {
      await store.discard(loaded.descriptor.scanId)
      const fresh = await createResumableFullScan(request, journal, store)
      return fresh ? { ...fresh, expiredReason: 'resume-expired:journal-changed' } : undefined
    }
    // Validate only the window since the saved scan's last successful drain.
    // The scan absorbed everything up to that watermark into its dirty scopes
    // (persisted at each 30s drain and at pause), so replaying from the
    // scan-start baseline would discard a perfectly resumable scan whenever
    // the long window trips a journal limit or drop flag.
    await request.onResumePreparation?.('history')
    const history = measureScan('resume-history-validation', () => journal.readChanges(request.target, store.cursor(loaded.descriptor, loaded.drainedThrough), MAX_EVENTS, HISTORY_TIMEOUT_MS))
    if (history.requiresFullScan) {
      // The construction is still valid, but its uncheckpointed history is
      // not currently readable. Keep the descriptor and let the caller retry
      // once the journal window is trustworthy instead of silently restarting
      // from an empty database.
      throw new Error(`resume-history-unavailable:${history.reason ?? 'history-unavailable'}`)
    }
    return loaded.kind === 'candidate'
      ? { descriptor: loaded.descriptor, partialPath: joinOwned(store.directory, loaded.descriptor.partialFile), candidatePath: loaded.candidatePath, candidate: loaded.candidatePath, resume: true }
      : { descriptor: loaded.descriptor, partialPath: loaded.partialPath, candidatePath: loaded.candidatePath, resume: true }
  }
  if (loaded.kind === 'restart') {
    if (loaded.reason === 'target-unavailable') throw new Error('The saved scan target is unavailable')
    if (loaded.reason === 'saved-scan-target-mismatch') return undefined
    if (loaded.descriptor) await store.discard(loaded.descriptor.scanId)
    else await store.removeDescriptor()
  }
  return createResumableFullScan(request, journal, store)
}

async function createResumableFullScan(request: RefreshRequest, journal: ChangeJournal, store: FullScanResumeStore): Promise<PreparedResume | undefined> {
  const scanId = scanIdFromPaths(request.partialPath, request.publishedPath)
  if (!scanId) return undefined
  const checkpoint = safeCheckpoint(journal, request.target)
  if (!checkpoint?.journalUuid) return undefined
  const [target, directory] = await Promise.all([lstat(request.target, { bigint: true }), lstat(request.indexDirectory, { bigint: true })])
  if (!target.isDirectory() || target.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink() || checkpoint.device !== String(target.dev)) return undefined
  const descriptor = store.descriptor({
    scanId, target: request.target, targetDevice: String(target.dev), targetInode: String(target.ino),
    indexDirectoryIdentity: `${String(directory.dev)}:${String(directory.ino)}`, startupRoot: request.startupRoot !== false,
    checkpoint: { device: checkpoint.device, journalUuid: checkpoint.journalUuid, eventId: checkpoint.eventId }
  })
  return { descriptor, partialPath: request.partialPath, candidatePath: request.publishedPath, resume: false }
}

function scanIdFromPaths(partialPath: string, candidatePath: string): string | undefined {
  const partial = publicationIdFromDatabaseFile(basename(partialPath), true)
  const candidate = publicationIdFromDatabaseFile(basename(candidatePath), false)
  return partial && partial === candidate ? partial : undefined
}

function joinOwned(directory: string, file: string): string { return `${directory}/${file}` }

function readCandidateResult(path: string, generation: number): ScanResult {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const metadata = readMetadata(database)
    const totals = JSON.parse(metadata.totals ?? '{}') as ScanTotals
    const volume = JSON.parse(metadata.volume ?? '{}') as { capacityBytes?: number; freeBytes?: number }
    const dirtyScopes = JSON.parse(metadata.resumeDirtyScopes ?? '[]') as unknown
    const resume = typeof metadata.resumeDrainedThrough === 'string' && Array.isArray(dirtyScopes) && dirtyScopes.every((scope) => typeof scope === 'string')
      ? { drainedThrough: metadata.resumeDrainedThrough, dirtyScopes: dirtyScopes as string[] } : undefined
    return {
      generation, target: metadata.target ?? '', rootId: metadata.rootId ?? '', publishedPath: path,
      capacityBytes: Number(volume.capacityBytes ?? 0), freeBytes: Number(volume.freeBytes ?? 0),
      scannedBytes: Number(metadata.scannedBytes ?? totals.discoveredBytes ?? 0), totals,
      metadata: { bulkMetadataEntries: 0, fallbackMetadataEntries: 0, ...(resume ? { resume } : {}) }
    }
  } finally { database.close() }
}

async function retryFullRefresh(request: RefreshRequest, journal: ChangeJournal, reason: string, raceRetry: number, resumeRestarts: number): Promise<RefreshOutcome> {
  if (raceRetry < 1) {
    recordScanCounter('fullScanRetries')
    await new FullScanResumeStore(request.indexDirectory).discard().catch(() => false)
    return fullRefresh(request, journal, reason, raceRetry + 1, Math.max(1, resumeRestarts))
  }
  // Preserve the checkpointed candidate and descriptor: a busy FSEvents
  // window must not destroy resumable progress. The controller surfaces the
  // saved scan as canceled-with-resume so the user can retry once the window
  // settles. Unreferenced artifacts (no saved scan) are removed here and
  // leftover run files are cleaned by the controller's failure path.
  const saved = await new FullScanResumeStore(request.indexDirectory).load(request.target)
  if (saved.kind !== 'construction' && saved.kind !== 'candidate') {
    await Promise.all([removeDatabaseFiles(request.partialPath), removeDatabaseFiles(request.publishedPath)])
  }
  throw new Error(`Unable to close the full-scan FSEvents window: ${reason}`)
}

function createIdentityLookup(path: string, target: string): { lookup(path: string): { device: string; inode: string } | undefined; close(): void } {
  const database = new DatabaseSync(path, { readOnly: true })
  const node = database.prepare('SELECT device, inode FROM nodes WHERE path = ?')
  const alias = database.prepare('SELECT device, inode FROM hardlink_paths WHERE path_key = ?')
  return {
    lookup: (absolutePath) => {
      const direct = node.get(absolutePath) as { device?: string; inode?: string } | undefined
      if (direct?.device && direct.inode) return { device: direct.device, inode: direct.inode }
      const pathKey = relative(target, absolutePath)
      const stored = alias.get(pathKey) as { device?: string; inode?: string } | undefined
      return stored?.device && stored.inode ? { device: stored.device, inode: stored.inode } : undefined
    },
    close: () => database.close()
  }
}

async function cloneIndex(source: string, destination: string): Promise<void> {
  await prepareDatabaseDirectory(destination)
  await removeDatabaseFiles(destination)
  try { await copyFile(source, destination, constants.COPYFILE_FICLONE) }
  catch { await copyFile(source, destination) }
}

async function publishCandidate(partialPath: string, publishedPath: string): Promise<void> {
  const file = await open(partialPath, 'r')
  try { await file.sync() } finally { await file.close() }
  await rename(partialPath, publishedPath)
  const directory = await open(dirname(publishedPath), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

function safeCheckpoint(journal: ChangeJournal, target: string) {
  try { return journal.captureCheckpoint(target) } catch { return undefined }
}

async function validateActiveTarget(manifest: IndexManifest): Promise<string | undefined> {
  try {
    const stats = await lstat(manifest.target, { bigint: true })
    if (!stats.isDirectory() || stats.isSymbolicLink()) return 'target-replaced'
    return String(stats.dev) === manifest.targetDevice && String(stats.ino) === manifest.targetInode ? undefined : 'target-replaced'
  } catch { return 'target-unavailable' }
}

function readTotals(path: string): ScanTotals {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const metadata = readMetadata(database)
    return JSON.parse(metadata.totals ?? '{}') as ScanTotals
  } finally { database.close() }
}

function metadataTargetDevice(path: string): string | undefined {
  const database = new DatabaseSync(path, { readOnly: true })
  try { return readMetadata(database).targetDevice }
  finally { database.close() }
}

function metadataRevision(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true })
  try { return Number(readMetadata(database).indexRevision ?? 1) }
  finally { database.close() }
}

async function volumeFor(target: string): Promise<{ capacityBytes: number; freeBytes: number; targetAllocatedBytes: number }> {
  const [value, targetStats] = await Promise.all([statfs(target), lstat(target, { bigint: true })])
  return {
    capacityBytes: Number(value.blocks) * Number(value.bsize),
    freeBytes: Number(value.bfree) * Number(value.bsize),
    targetAllocatedBytes: Number(targetStats.blocks) * 512
  }
}

function throwIfCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ScanCanceledError()
}

