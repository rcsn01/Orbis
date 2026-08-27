import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type { OrbisSnapshot, ProgressSnapshot, SizeAccuracy } from '../shared/contracts'
import { buildChart } from './chart'
import { readConstructionPreview, resolveConstructionNodePath, type ConstructionResumeLoad } from './construction-preview'
import { createControllerTimingMilestones, measureController, measureControllerAsync, RESUME_PREPARATION_MESSAGES, type ControllerTimingMilestones } from './diagnostics'
import { FullScanResumeStore, type FullScanResumeLoad, type ResumeValidationReceipt } from './full-scan-resume'
import { DiskIndex, toSummary } from './index-store'
import {
  EXCLUSION_POLICY_VERSION, HARD_LINK_ORDERING_VERSION, IndexManifestStore, PERSISTENT_ACCOUNTING_VERSION,
  PERSISTENT_INDEX_SCHEMA_VERSION, type IndexManifest, type JournalCursor
} from './index-manifest'
import type { FolderSizeEstimate } from './scan-metadata'
import type { ScanExecution, ScanOutcome, ScanSession } from './scan-execution'
import type { PublicationArtifacts } from './publication-artifacts'
import type { ProgressivePreview, ScanResult, ScanTotals } from './scanner'

export interface OrbisDialog { showOpenDialog(options: { readonly properties: Array<'openDirectory'> }): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }> }
export interface OrbisShell { showItemInFolder(path: string): void; openExternal(url: string): Promise<void> }

export interface OrbisControllerOptions {
  /** The feature stores its private persistent index here. It must be the feature's indexes directory. */
  readonly indexDirectory?: string
  /** When supplied, indexes are stored at `${dataDirectory}/indexes`. */
  readonly dataDirectory?: string
  readonly initialTarget?: string
  readonly dialog?: OrbisDialog
  readonly shell?: OrbisShell
}

interface ScanRun {
  readonly generation: number
  readonly publicationId: string
  readonly target: string
  readonly partialPath: string
  readonly publishedPath: string
  readonly sessionPromise: Promise<ScanSession>
  readonly resumeMilestones?: ControllerTimingMilestones
  readonly durablePreview?: ProgressivePreview
  readonly durableConstruction?: ConstructionResumeLoad
  session?: ScanSession
  completed: boolean
  published: boolean
}

const EMPTY_TOTALS: ScanTotals = {
  scannedItems: 0,
  discoveredBytes: 0,
  elapsedMs: 0,
  skippedItems: 0,
  unreadableItems: 0,
  nestedMounts: 0,
  symlinks: 0,
  duplicateHardLinks: 0,
  disappearingItems: 0
}

export class OrbisController {
  readonly indexDirectory: string
  readonly #artifacts: PublicationArtifacts
  readonly #estimateCache: FolderEstimateCache
  readonly #manifestStore: IndexManifestStore
  readonly #resumeStore: FullScanResumeStore
  readonly #explicitInitialTarget: boolean
  #initialization: Promise<void> | undefined
  #active: DiskIndex | undefined
  #activeManifest: IndexManifest | undefined
  #manifestDurable = true
  #preview: ProgressivePreview | undefined
  #target: string
  #focusId: string | undefined
  #generation = 0
  #run: ScanRun | undefined
  #scanStatus: OrbisSnapshot['scan'] = { status: 'idle', generation: 0, progress: null, totals: null, error: null }
  #resume: { readonly available: boolean; readonly checkpointedAt: string } | undefined
  #savedConstruction: ConstructionResumeLoad | undefined
  #resumeReceipt: ResumeValidationReceipt | undefined
  #pausedProgress: ProgressSnapshot | undefined
  #listeners = new Set<(snapshot: OrbisSnapshot) => void>()
  #pendingTasks = new Set<Promise<void>>()
  #startQueue: Promise<void> = Promise.resolve()
  #closed = false
  #pendingRevealCancellations = new Set<(error: Error) => void>()
  #dialog: OrbisDialog | undefined
  #shell: OrbisShell | undefined

  constructor(
    private readonly scanExecution: ScanExecution,
    options: OrbisControllerOptions
  ) {
    const dataDirectory = options.dataDirectory ? resolve(options.dataDirectory) : undefined
    if (!options.indexDirectory && !dataDirectory) throw new Error('Orbis requires a writable data directory')
    this.indexDirectory = resolve(options.indexDirectory ?? join(dataDirectory!, 'indexes'))
    this.#estimateCache = new FolderEstimateCache(join(this.indexDirectory, 'folder-estimates.json'))
    this.#manifestStore = new IndexManifestStore(this.indexDirectory)
    this.#artifacts = this.#manifestStore.artifacts
    this.#resumeStore = new FullScanResumeStore(this.indexDirectory)
    this.#explicitInitialTarget = options.initialTarget !== undefined || process.env.ORBIS_SCAN_ROOT !== undefined
    this.#target = normalize(resolve(options.initialTarget ?? process.env.ORBIS_SCAN_ROOT ?? '/'))
    this.#dialog = options.dialog
    this.#shell = options.shell
  }

  initialize(): Promise<void> {
    this.#initialization ??= this.#initializePersistentIndex()
    return this.#initialization
  }

  subscribe(listener: (snapshot: OrbisSnapshot) => void): () => void {
    if (this.#closed) return () => undefined
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  snapshot(): OrbisSnapshot { return this.#buildSnapshot() }

  #buildSnapshot(diagnosticGeneration?: number): OrbisSnapshot {
    const preview = this.#preview
    if (preview) return {
      version: 3, committed: false, target: preview.target, focus: preview.focus, breadcrumbs: preview.breadcrumbs,
      chart: preview.chart, largestItems: preview.largestItems, volume: preview.volume,
      scan: { ...this.#scanStatus, ...(this.#resume ? { resume: this.#resume } : {}) }
    }
    const timed = <T>(phase: string, operation: () => T): T => diagnosticGeneration === undefined ? operation() : measureController(diagnosticGeneration, phase, operation)
    const target = this.#target
    const active = this.#active
    const compatible = active !== undefined && active.target === target
    const focus = timed('snapshot-focus-query', () => compatible && this.#focusId ? active!.getNode(this.#focusId) : undefined)
    const activeTotals = compatible ? parseTotals(active!.metadata.totals) : null
    const root = timed('snapshot-root-query', () => compatible ? active!.root : undefined)
    const volume = compatible ? parseVolume(active!.metadata.volume, root?.sizeBytes ?? 0, active!.target, root?.sizeAccuracy ?? 'partial') : emptyVolume()
    const breadcrumbs = timed('snapshot-breadcrumbs-query', () => focus && active ? active.getBreadcrumbs(focus.id) : [])
    const chart = timed('snapshot-chart-query', () => focus && active ? buildChart(active, focus, {
      rootTotalBytes: focus.id === active.rootId && active.target === '/' ? volume.capacityBytes : 0
    }) : [])
    const largestItems = timed('snapshot-largest-items-query', () => focus && active ? active.getLargestItems(focus.id) : [])
    return {
      version: 3, committed: compatible,
      target: { name: compatible ? root?.name ?? displayName(target) : displayName(target), isStartup: target === '/' },
      focus: focus ? toSummary(focus) : null, breadcrumbs, chart, largestItems, volume,
      scan: { ...this.#scanStatus, totals: this.#scanStatus.status === 'scanning' ? null : this.#scanStatus.totals ?? activeTotals, ...(this.#resume ? { resume: this.#resume } : {}) }
    }
  }

  async startScan(): Promise<OrbisSnapshot> { return this.#startScanAt(this.#target) }
  async rescan(): Promise<OrbisSnapshot> { return this.#startScanAt(this.#target) }

  async chooseFolder(): Promise<OrbisSnapshot> {
    if (!this.#dialog) throw new Error('Folder selection is unavailable')
    const result = await this.#dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (!result.canceled && result.filePaths[0]) return this.#startScanAt(result.filePaths[0])
    return this.snapshot()
  }

  async cancelScan(): Promise<OrbisSnapshot> {
    const run = this.#run
    if (!run) return this.snapshot()
    if (run.completed) {
      await Promise.allSettled([...this.#pendingTasks])
      return this.snapshot()
    }
    this.#run = undefined
    if (this.#scanStatus.progress && this.#scanStatus.progress.stage !== 'resuming') this.#pausedProgress = this.#scanStatus.progress
    this.#preview = undefined
    this.#savedConstruction = undefined
    this.#rejectPendingReveals('Scan paused')
    const stopped = await this.#stopRun(run)
    if (this.#closed || this.#generation !== run.generation || this.#run) return this.snapshot()
    const saved = await this.#loadResumeAfterStop(run.target, stopped)
    if (this.#closed || this.#generation !== run.generation || this.#run) return this.snapshot()
    this.#rememberResumeLoad(saved)
    this.#resume = saved.kind === 'construction' || saved.kind === 'candidate'
      ? { available: true, checkpointedAt: saved.kind === 'construction' ? saved.checkpointedAt : saved.descriptor.createdAt }
      : undefined
    await this.#restoreConstructionPreview(saved, run.generation)
    this.#scanStatus = { status: 'canceled', generation: run.generation, progress: null, totals: null, error: null }
    this.#emit()
    return this.snapshot()
  }

  async discardSavedScan(): Promise<OrbisSnapshot> {
    const run = this.#run
    if (run?.completed) await Promise.allSettled([...this.#pendingTasks])
    else if (run) {
      this.#run = undefined
      await this.#stopRun(run)
    }
    this.#preview = undefined
    this.#savedConstruction = undefined
    this.#resumeReceipt = undefined
    this.#rejectPendingReveals('Saved scan discarded')
    await this.#resumeStore.discard()
    this.#resume = undefined
    if (this.#scanStatus.status === 'canceled') this.#scanStatus = { status: 'idle', generation: this.#scanStatus.generation, progress: null, totals: null, error: null }
    this.#emit()
    return this.snapshot()
  }

  async focusNode(id: string): Promise<OrbisSnapshot> {
    const run = this.#run
    if (run && !run.completed && this.#preview) {
      const node = previewNode(this.#preview, id)
      if (!node) throw new Error('Unknown Orbis node')
      if (node.kind !== 'directory') throw new Error('Only directories can become the chart root')
      this.#rejectPendingReveals('The focused folder changed before the item could be revealed')
      const session = await run.sessionPromise
      if (this.#run !== run || run.completed) return this.snapshot()
      run.session = session
      void session.focus(id)
      return this.snapshot()
    }
    const saved = this.#savedConstruction
    if (saved && this.#preview) {
      const preview = await readConstructionPreview(saved, this.#scanStatus.generation, id)
      if (!preview) throw new Error('Unknown Orbis node')
      if (this.#closed || this.#run || this.#savedConstruction !== saved) throw new Error('The scan changed before the folder could be opened')
      this.#rejectPendingReveals('The focused folder changed before the item could be revealed')
      this.#preview = preview
      this.#emit()
      return this.snapshot()
    }
    const active = this.#active
    if (!active) throw new Error('No completed scan is available')
    const node = active.getNode(id)
    if (!node) throw new Error('Unknown Orbis node')
    if (node.kind !== 'directory') throw new Error('Only directories can become the chart root')
    this.#focusId = node.id
    this.#emit()
    return this.snapshot()
  }

  async revealNode(id: string): Promise<void> {
    if (!this.#shell) throw new Error('Reveal in Finder is unavailable')
    const run = this.#run
    if (run && !run.completed && this.#preview) {
      if (!previewNode(this.#preview, id)) throw new Error('Unknown Orbis node')
      const outcome = await this.#resolveLiveNode(run, id)
      if (outcome.kind !== 'resolved') throw new Error('Unknown Orbis node')
      if (this.#run !== run) throw new Error('The scan changed before the item could be revealed')
      const safePath = await validateRevealPath(outcome.path, run.target)
      this.#shell.showItemInFolder(safePath)
      return
    }
    const saved = this.#savedConstruction
    if (saved && this.#preview) {
      const path = await resolveConstructionNodePath(saved, id)
      if (!path) throw new Error('Unknown Orbis node')
      const safePath = await validateRevealPath(path, saved.descriptor.target)
      if (this.#closed || this.#run || this.#savedConstruction !== saved) throw new Error('The scan changed before the item could be revealed')
      this.#shell.showItemInFolder(safePath)
      return
    }
    const active = this.#active
    if (!active) throw new Error('No completed scan is available')
    const path = active.resolvePath(id)
    if (!path) throw new Error('Unknown Orbis node')
    const safePath = await validateRevealPath(path, active.target)
    if (this.#active !== active) throw new Error('The scan changed before the item could be revealed')
    this.#shell.showItemInFolder(safePath)
  }

  async openFullDiskAccess(): Promise<void> {
    if (!this.#shell) throw new Error('Full Disk Access settings are unavailable')
    await this.#shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity_Privacy_FullDiskAccess')
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#startQueue
    if (this.#initialization) await this.#initialization.catch(() => undefined)
    const run = this.#run
    if (run && !run.completed) {
      this.#run = undefined
      await this.#stopRun(run)
    }
    await this.scanExecution.close()
    await Promise.allSettled([...this.#pendingTasks])
    this.#run = undefined
    try { this.#active?.close() } catch { /* Shutdown continues so owned artifacts can still be removed. */ }
    this.#active = undefined
    this.#preview = undefined
    this.#savedConstruction = undefined
    this.#resumeReceipt = undefined
    this.#rejectPendingReveals('Orbis is shutting down')
    this.#focusId = undefined
    // Preserve both possible publications if the manifest-directory sync failed.
    if (this.#manifestDurable) {
      await this.#manifestStore.initialize().then(() => this.#manifestStore.cleanup(this.#activeManifest?.indexFile)).catch(() => undefined)
    }
    this.#listeners.clear()
  }

  async #initializePersistentIndex(): Promise<void> {
    await this.#manifestStore.initialize()
    const manifest = await this.#manifestStore.load()
    this.#activeManifest = manifest
    let saved = await this.#resumeStore.load()
    this.#rememberResumeLoad(saved)
    if (process.env.ORBIS_DISABLE_INCREMENTAL_SCAN === '1' && saved.kind !== 'none') {
      if (saved.kind === 'construction' || saved.kind === 'candidate' || saved.descriptor) await this.#resumeStore.discard(saved.descriptor?.scanId)
      else await this.#resumeStore.removeDescriptor()
      saved = { kind: 'none' }
      this.#resumeReceipt = undefined
    }
    if (manifest && saved.kind === 'candidate' && saved.descriptor.candidateFile === manifest.indexFile) {
      await this.#resumeStore.complete(saved.descriptor.scanId)
      saved = { kind: 'none' }
      this.#resumeReceipt = undefined
    }
    if (saved.kind === 'construction' || saved.kind === 'candidate') {
      this.#resume = { available: true, checkpointedAt: saved.kind === 'construction' ? saved.checkpointedAt : saved.descriptor.createdAt }
      if (!this.#explicitInitialTarget) this.#target = saved.descriptor.target
      this.#scanStatus = { status: 'canceled', generation: 0, progress: null, totals: null, error: null }
    } else if (saved.kind === 'restart' && saved.reason === 'target-unavailable' && saved.descriptor) {
      this.#resume = { available: true, checkpointedAt: saved.descriptor.createdAt }
      if (!this.#explicitInitialTarget) this.#target = saved.descriptor.target
      this.#scanStatus = { status: 'canceled', generation: 0, progress: null, totals: null, error: null }
    } else if (saved.kind === 'restart') {
      if (saved.descriptor) await this.#resumeStore.discard(saved.descriptor.scanId)
      else await this.#resumeStore.removeDescriptor()
    }
    if (saved.kind === 'construction' && saved.descriptor.target === this.#target) await this.#restoreConstructionPreview(saved, 0)
    await this.#manifestStore.cleanup(manifest?.indexFile)
    if (!manifest || this.#explicitInitialTarget && manifest.target !== this.#target) return
    let index: DiskIndex | undefined
    try {
      index = new DiskIndex(join(this.indexDirectory, manifest.indexFile))
      if (!matchesManifest(index, manifest) || !await targetIdentityIsCompatible(manifest) || !await indexDirectoryIdentityIsCompatible(index, this.indexDirectory)) throw new Error('Stored Orbis index is incompatible')
      if (this.#closed) { index.close(); return }
      this.#active = index
      this.#activeManifest = manifest
      this.#target = manifest.target
      this.#focusId = index.rootId
    } catch {
      try { index?.close() } catch { /* Ignore an invalid stored index. */ }
      this.#activeManifest = undefined
      await this.#artifacts.removeManifestMetadata().catch(() => undefined)
      await this.#manifestStore.cleanup().catch(() => undefined)
    }
  }

  #startTask(task: Promise<void>): void {
    this.#pendingTasks.add(task)
    void task.finally(() => this.#pendingTasks.delete(task)).catch(() => undefined)
  }

  async #stopRun(run: ScanRun): Promise<ScanOutcome> {
    try {
      const session = await run.sessionPromise
      run.session = session
      return await session.pause()
    } catch (error) {
      // A failed or timed-out stop has no clean-pause proof. The caller must
      // use the authoritative loader instead.
      return { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  async #removeRunFiles(run: ScanRun): Promise<void> {
    await Promise.all([this.#artifacts.discardUnreferencedDatabase(run.partialPath), this.#artifacts.discardUnreferencedDatabase(run.publishedPath)])
  }

  async #startScanAt(value: string): Promise<OrbisSnapshot> {
    const resumeMilestones = createControllerTimingMilestones()
    let release!: () => void
    const previous = this.#startQueue
    this.#startQueue = new Promise<void>((resolveQueue) => { release = resolveQueue })
    await previous
    try {
      return await this.#startScanAtSerial(value, resumeMilestones)
    } finally {
      release()
    }
  }

  async #startScanAtSerial(value: string, resumeMilestones: ControllerTimingMilestones): Promise<OrbisSnapshot> {
    if (this.#closed) throw new Error('Orbis is shutting down')
    await this.initialize()
    if (!isAbsolute(value) || value.includes('\u0000')) throw new Error('Choose an absolute folder')
    const target = normalize(resolve(value))
    if (this.#run && this.#run.target !== target) throw new Error('Pause and discard the saved scan before choosing another folder')
    const previous = this.#run
    if (previous?.completed) await Promise.allSettled([...this.#pendingTasks])
    const current = this.#run
    let stoppedSaved: FullScanResumeLoad | undefined
    if (current) {
      this.#run = undefined
      const stopped = await this.#stopRun(current)
      stoppedSaved = await this.#loadResumeAfterStop(current.target, stopped)
      this.#rememberResumeLoad(stoppedSaved)
    }
    await mkdir(this.indexDirectory, { recursive: true, mode: 0o700 })
    if (this.#closed) throw new Error('Orbis is shutting down')
    const generation = ++this.#generation
    // Peek at the saved scan (descriptor + file existence) instead of fully
    // validating it: the worker performs the authoritative validation before
    // resuming, and full validation is O(index size) on large saved scans.
    let saved = stoppedSaved ?? await this.#resumeStore.peek()
    if (process.env.ORBIS_DISABLE_INCREMENTAL_SCAN === '1' && saved.kind !== 'none') {
      if (saved.kind === 'construction' || saved.kind === 'candidate' || saved.descriptor) await this.#resumeStore.discard(saved.descriptor?.scanId)
      else await this.#resumeStore.removeDescriptor()
      saved = { kind: 'none' }
      this.#resumeReceipt = undefined
    }
    const savedDescriptor = saved.kind === 'construction' || saved.kind === 'candidate' || saved.kind === 'restart' ? saved.descriptor : undefined
    if (savedDescriptor && savedDescriptor.target !== target) throw new Error('Discard the saved scan before choosing another folder')
    const publicationId = saved.kind === 'construction' || saved.kind === 'candidate' ? saved.descriptor.scanId : randomUUID()
    const { partialPath, indexPath: publishedPath } = this.#manifestStore.paths(publicationId)
    if (saved.kind !== 'construction' && saved.kind !== 'candidate') {
      await this.#artifacts.discardUnreferencedDatabase(partialPath)
      await this.#artifacts.discardUnreferencedDatabase(publishedPath)
    }
    const initialEstimate = this.#active?.target === target ? estimateFromIndex(this.#active) : await this.#estimateCache.load(target)
    const active = this.#active?.target === target && this.#activeManifest
      ? { manifest: this.#activeManifest, path: this.#active.path }
      : undefined
    const resumeExpected = saved.kind === 'construction' || saved.kind === 'candidate'
    const durablePreview = resumeExpected ? this.#preview : undefined
    const durableConstruction = resumeExpected ? this.#savedConstruction : undefined
    if (durablePreview) this.#preview = { ...durablePreview, generation }
    else if (!resumeExpected) this.#preview = undefined
    if (!resumeExpected) {
      this.#savedConstruction = undefined
      this.#resumeReceipt = undefined
      this.#pausedProgress = undefined
    }
    const resumeReceipt = resumeExpected ? this.#resumeReceipt : undefined
    // A receipt is single-use: once worker startup is scheduled it may not be
    // reused by a later generation or a second worker.
    this.#resumeReceipt = undefined
    this.#rejectPendingReveals('A newer scan started')
    const sessionPromise = Promise.resolve().then(() => this.scanExecution.start({
      target, partialPath, publishedPath, indexDirectory: this.indexDirectory, startupRoot: target === '/', resumeExpected,
      ...(resumeReceipt ? { resumeReceipt } : {}),
      ...(initialEstimate ? { initialEstimate } : {}), ...(active ? { active } : {})
    }))
    const run: ScanRun = {
      generation, publicationId, target, partialPath, publishedPath, sessionPromise,
      ...(resumeExpected ? { resumeMilestones } : {}),
      ...(durablePreview ? { durablePreview: { ...durablePreview, generation } } : {}),
      ...(durableConstruction ? { durableConstruction } : {}),
      completed: false, published: false
    }
    this.#run = run
    this.#target = target
    this.#resume = undefined
    const retained = this.#pausedProgress
    const progress: ProgressSnapshot | null = resumeExpected ? {
      stage: 'resuming', scannedItems: retained?.scannedItems ?? 0,
      discoveredBytes: retained?.discoveredBytes ?? durablePreview?.volume.scannedBytes ?? 0,
      elapsedMs: retained?.elapsedMs ?? 0, currentItem: RESUME_PREPARATION_MESSAGES.validating
    } : null
    this.#scanStatus = { status: 'scanning', generation, progress, totals: null, error: null }
    this.#startTask(this.#consumeRun(run))
    this.#emit()
    return this.snapshot()
  }

  async #consumeRun(run: ScanRun): Promise<void> {
    let session: ScanSession
    try {
      session = await run.sessionPromise
      run.session = session
      run.resumeMilestones?.mark(run.generation, 'resume-click-to-session')
    } catch (error) {
      if (this.#run === run && !this.#closed) await this.#handleRunOutcome(run, { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) })
      return
    }
    if (this.#run !== run || this.#closed || run.completed) {
      await session.pause()
      return
    }
    for await (const update of session.events) {
      if (this.#run !== run || this.#closed || run.completed) continue
      if (update.type === 'resume-milestone') {
        if (update.milestone === 'preparation-started') run.resumeMilestones?.mark(run.generation, 'resume-click-to-preparation')
        else if (update.milestone === 'first-metadata-page') run.resumeMilestones?.mark(run.generation, 'resume-click-to-first-metadata-page')
        else if (update.milestone === 'first-metadata-preview') run.resumeMilestones?.mark(run.generation, 'resume-click-to-first-metadata-preview')
        continue
      }
      if (update.type === 'resume-preparation') {
        const progress = this.#scanStatus.progress
        if (progress?.stage !== 'resuming') continue
        this.#scanStatus = { ...this.#scanStatus, progress: { ...progress, currentItem: RESUME_PREPARATION_MESSAGES[update.phase] } }
      } else if (update.type === 'progress') {
        run.resumeMilestones?.mark(run.generation, 'resume-click-to-first-progress')
        this.#scanStatus = { status: 'scanning', generation: run.generation, progress: update.progress, totals: null, error: null }
      } else if (update.preview.generation === run.generation && (!this.#preview || update.preview.revision >= this.#preview.revision)) {
        this.#preview = update.preview
      }
      this.#emit()
    }
    const outcome = await session.result
    if (this.#run !== run || this.#closed) {
      if (outcome.kind === 'completed' && !run.published) await this.#removeStaleCandidate(outcome.result.publishedPath)
      return
    }
    await this.#handleRunOutcome(run, outcome)
  }

  async #handleRunOutcome(run: ScanRun, outcome: ScanOutcome): Promise<void> {
    if (outcome.kind === 'completed') {
      run.completed = true
      await this.#publish(run, outcome.result, outcome.refresh)
    } else if (outcome.kind === 'unchanged') {
      run.completed = true
      await this.#publishUnchanged(run, outcome.journal, outcome.totals, outcome.basePublicationId)
    } else if (outcome.kind === 'canceled' || outcome.kind === 'paused') {
      this.#run = undefined
      this.#preview = undefined
      this.#savedConstruction = undefined
      this.#rejectPendingReveals('Scan paused')
      this.#scanStatus = { status: 'canceled', generation: run.generation, progress: null, totals: null, error: null }
      await this.#refreshResumeState(run.generation, true, { target: run.target, outcome })
      this.#emit()
    } else {
      this.#fail(run, outcome.error.message)
    }
  }

  async #publish(run: ScanRun, result: ScanResult, refresh?: Extract<ScanOutcome, { kind: 'completed' }>['refresh']): Promise<void> {
    return measureControllerAsync(run.generation, 'publication-total', async () => {
      if (result.target !== run.target || result.publishedPath !== run.publishedPath) {
        await this.#fail(run, 'The scan worker returned an invalid publication.')
        return
      }
      if (this.#run !== run || this.#closed) {
        await this.#artifacts.discardUnreferencedDatabase(result.publishedPath)
        return
      }
      if (refresh?.basePublicationId && refresh.basePublicationId !== this.#activeManifest?.publicationId) {
        await this.#fail(run, 'The incremental scan was based on a stale index.')
        return
      }
      let next: DiskIndex | undefined
      const old = this.#active
      const oldManifest = this.#activeManifest
      const oldFocusId = this.#focusId
      try {
        next = measureController(run.generation, 'index-open', () => new DiskIndex(result.publishedPath))
        const persistent = refresh?.reference !== true
        if (persistent && !await indexDirectoryIdentityIsCompatible(next, this.indexDirectory)) throw new Error('The scan worker returned an index for another index directory')
        const manifest = persistent ? manifestFor(run, next, refresh?.journal ?? null) : undefined
        if (manifest) {
          await measureControllerAsync(run.generation, 'manifest-publish', () => this.#manifestStore.publish(manifest))
          this.#manifestDurable = manifestPublicationWasDurable(this.#manifestStore)
          await this.#resumeStore.complete(run.publicationId).catch(() => false)
          this.#resume = undefined
          this.#savedConstruction = undefined
          this.#resumeReceipt = undefined
        }
        if (this.#run !== run) {
          try { next.close() } catch { /* A newer run owns controller state. */ }
          if (!manifest) await this.#artifacts.discardUnreferencedDatabase(result.publishedPath)
          return
        }
        run.published = true
        this.#active = next
        if (manifest) this.#activeManifest = manifest
        this.#preview = undefined
        this.#savedConstruction = undefined
        this.#resumeReceipt = undefined
        this.#rejectPendingReveals('Scan completed')
        this.#focusId = restoreFocus(next, old, oldFocusId)
        this.#target = next.target
        this.#scanStatus = { status: 'completed', generation: run.generation, progress: null, totals: result.totals, error: null }
        const snapshot = measureController(run.generation, 'snapshot-total', () => this.#buildSnapshot(run.generation))
        this.#run = undefined
        try { await this.#estimateCache.store(next.target, estimateFromIndex(next)) } catch { /* A cache failure must not invalidate an exact index. */ }
        try { await measureControllerAsync(run.generation, 'partial-index-cleanup', () => this.#artifacts.discardUnreferencedDatabase(run.partialPath)) } catch { /* Shutdown retries owned cleanup. */ }
        if (old) {
          try { old.close() } catch { /* The new index remains authoritative. */ }
          if (old.path !== next.path && (!persistent || this.#manifestDurable)) {
            try { await measureControllerAsync(run.generation, 'previous-index-cleanup', () => this.#artifacts.discardUnreferencedDatabase(old.path)) } catch { /* The new index remains authoritative. */ }
          }
        } else if (persistent && this.#manifestDurable && oldManifest && oldManifest.indexFile !== manifest?.indexFile) {
          try { await this.#artifacts.discardUnreferencedDatabase(join(this.indexDirectory, oldManifest.indexFile)) } catch { /* The new index remains authoritative. */ }
        }
        if (!this.#closed) measureController(run.generation, 'listener-notify', () => this.#emit(snapshot))
      } catch (error) {
        if (run.published) return
        if (this.#run === run) {
          this.#active = old
          this.#activeManifest = oldManifest
          this.#preview = undefined
          this.#focusId = oldFocusId
          this.#target = old?.target ?? run.target
          try { next?.close() } catch { /* Best effort while restoring the previous index. */ }
        }
        await this.#artifacts.discardUnreferencedDatabase(result.publishedPath)
        this.#fail(run, error instanceof Error ? error.message : String(error))
      }
    })
  }

  async #publishUnchanged(run: ScanRun, journal: JournalCursor, totals: ScanTotals, basePublicationId: string): Promise<void> {
    const active = this.#active
    const manifest = this.#activeManifest
    if (this.#run !== run || this.#closed) return
    if (!active || !manifest || active.target !== run.target || manifest.publicationId !== basePublicationId) {
      this.#fail(run, 'The incremental scan was based on a stale index.')
      return
    }
    try {
      const nextManifest: IndexManifest = { ...manifest, journal }
      await this.#manifestStore.publish(nextManifest)
      this.#manifestDurable = manifestPublicationWasDurable(this.#manifestStore)
      if (this.#run !== run || this.#closed) return
      this.#activeManifest = nextManifest
      this.#preview = undefined
      this.#savedConstruction = undefined
      this.#resumeReceipt = undefined
      this.#resume = undefined
      this.#scanStatus = { status: 'completed', generation: run.generation, progress: null, totals, error: null }
      this.#run = undefined
      await this.#removeRunFiles(run)
      this.#emit()
    } catch (error) {
      this.#fail(run, error instanceof Error ? error.message : String(error))
    }
  }

  async #removeStaleCandidate(path: string): Promise<void> {
    await this.#artifacts.discardUnreferencedDatabase(path, { retain: this.#activeManifest ? [this.#activeManifest.indexFile] : [] })
  }

  async #refreshResumeState(
    generation: number, restorePreview = false,
    stopped?: { readonly target: string; readonly outcome: ScanOutcome }
  ): Promise<void> {
    const saved = stopped ? await this.#loadResumeAfterStop(stopped.target, stopped.outcome) : await this.#resumeStore.load(this.#target)
    if (this.#closed || this.#generation !== generation || this.#run) return
    this.#rememberResumeLoad(saved)
    this.#resume = saved.kind === 'construction' || saved.kind === 'candidate'
      ? { available: true, checkpointedAt: saved.kind === 'construction' ? saved.checkpointedAt : saved.descriptor.createdAt }
      : undefined
    this.#savedConstruction = undefined
    if (restorePreview && saved.kind === 'construction' && saved.descriptor.target === this.#target) {
      const restored = await this.#restoreConstructionPreview(saved, generation)
      if (!restored && !this.#closed && this.#generation === generation && !this.#run) this.#preview = undefined
    } else if (restorePreview) this.#preview = undefined
  }

  async #restoreConstructionPreview(saved: FullScanResumeLoad, generation: number): Promise<boolean> {
    if (saved.kind !== 'construction' || saved.descriptor.target !== this.#target) return false
    const retainedFocusId = this.#preview?.focus.id
    const preview = await readConstructionPreview(saved, generation, retainedFocusId)
      ?? (retainedFocusId ? await readConstructionPreview(saved, generation) : undefined)
    if (!preview || this.#closed || this.#generation !== generation || this.#run || saved.descriptor.target !== this.#target) return false
    this.#savedConstruction = saved
    this.#preview = preview
    return true
  }

  #rememberResumeLoad(saved: FullScanResumeLoad): void {
    this.#resumeReceipt = saved.kind === 'construction' || saved.kind === 'candidate' ? saved.receipt : undefined
  }

  async #loadResumeAfterStop(target: string, outcome: ScanOutcome): Promise<FullScanResumeLoad> {
    if (outcome.kind === 'paused' && outcome.acknowledged && outcome.checkpointSequence !== undefined) {
      return this.#resumeStore.loadAcknowledgedCheckpoint(target, outcome.checkpointSequence)
    }
    return this.#resumeStore.load(target)
  }

  #fail(run: ScanRun, error: string): void {
    if (this.#run !== run) return
    this.#run = undefined
    this.#preview = run.durablePreview
    this.#savedConstruction = run.durableConstruction
    this.#rejectPendingReveals('Scan failed')
    this.#scanStatus = { status: 'fatal-error', generation: run.generation, progress: null, totals: null, error }
    this.#startTask(this.#stopRun(run).then(async () => {
      await this.#refreshResumeState(run.generation, true)
      if (this.#closed || this.#generation !== run.generation || this.#run) return
      if (this.#resume) this.#scanStatus = { status: 'canceled', generation: run.generation, progress: null, totals: null, error: null }
      else await this.#removeRunFiles(run)
      this.#emit()
    }))
  }

  async #resolveLiveNode(run: ScanRun, id: string): ReturnType<ScanSession['resolveNode']> {
    let rejectCancellation!: (error: Error) => void
    const canceled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    this.#pendingRevealCancellations.add(rejectCancellation)
    try {
      const session = await run.sessionPromise
      if (this.#run !== run || run.completed) throw new Error('The scan changed before the item could be revealed')
      run.session = session
      return await Promise.race([session.resolveNode(id), canceled])
    }
    finally { this.#pendingRevealCancellations.delete(rejectCancellation) }
  }

  #rejectPendingReveals(message: string): void {
    const error = new Error(message)
    for (const reject of this.#pendingRevealCancellations) reject(error)
    this.#pendingRevealCancellations.clear()
  }

  #emit(snapshot = this.snapshot()): void {
    for (const listener of this.#listeners) {
      try { listener(snapshot) } catch { /* A renderer listener must not break publication. */ }
    }
  }
}

function restoreFocus(next: DiskIndex, previous: DiskIndex | undefined, previousFocusId: string | undefined): string {
  if (previousFocusId) {
    const stable = next.getNode(previousFocusId)
    if (stable?.kind === 'directory') return stable.id
    let path = previous?.getNode(previousFocusId)?.path
    while (path && isWithinPath(path, next.target)) {
      const node = next.getNodeByPath(path)
      if (node?.kind === 'directory') return node.id
      if (path === next.target) break
      path = resolve(path, '..')
    }
  }
  return next.rootId
}

function manifestFor(run: ScanRun, index: DiskIndex, journal: JournalCursor | null): IndexManifest {
  const metadata = index.metadata
  const schemaVersion = positiveInteger(metadata.schemaVersion)
  const indexRevision = positiveInteger(metadata.indexRevision)
  const targetDevice = decimalString(metadata.targetDevice)
  const targetInode = decimalString(metadata.targetInode)
  if (schemaVersion !== PERSISTENT_INDEX_SCHEMA_VERSION || !indexRevision || !targetDevice || !targetInode
    || metadata.accountingVersion !== PERSISTENT_ACCOUNTING_VERSION
    || metadata.exclusionPolicyVersion !== EXCLUSION_POLICY_VERSION
    || metadata.hardLinkOrderingVersion !== HARD_LINK_ORDERING_VERSION) throw new Error('The scan worker returned an incompatible persistent index')
  return {
    version: 1, publicationId: run.publicationId, indexFile: basename(index.path), target: index.target,
    targetDevice, targetInode, schemaVersion, indexRevision, journal
  }
}

function matchesManifest(index: DiskIndex, manifest: IndexManifest): boolean {
  const metadata = index.metadata
  return index.target === manifest.target
    && metadata.schemaVersion === String(manifest.schemaVersion)
    && metadata.indexRevision === String(manifest.indexRevision)
    && metadata.targetDevice === manifest.targetDevice
    && metadata.targetInode === manifest.targetInode
    && metadata.accountingVersion === PERSISTENT_ACCOUNTING_VERSION
    && metadata.exclusionPolicyVersion === EXCLUSION_POLICY_VERSION
    && metadata.hardLinkOrderingVersion === HARD_LINK_ORDERING_VERSION
}

async function indexDirectoryIdentityIsCompatible(index: DiskIndex, directory: string): Promise<boolean> {
  try {
    const stats = await lstat(directory)
    return stats.isDirectory() && !stats.isSymbolicLink() && index.metadata.indexDirectoryIdentity === `${String(stats.dev)}:${String(stats.ino)}`
  } catch { return false }
}

async function targetIdentityIsCompatible(manifest: IndexManifest): Promise<boolean> {
  try {
    const stats = await lstat(manifest.target)
    return stats.isDirectory() && !stats.isSymbolicLink() && String(stats.dev) === manifest.targetDevice && String(stats.ino) === manifest.targetInode
  } catch (error) {
    const code = errorCode(error)
    return isMissingPath(error) || code === 'EACCES' || code === 'EPERM' || code === 'EIO' || code === 'ENXIO'
  }
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 ? number : undefined
}

function decimalString(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) ? value : undefined
}

interface EstimateCacheDocument {
  readonly version: 1
  readonly target: string
  readonly device: string
  readonly inode: string
  readonly capturedAt: string
  readonly estimate: FolderSizeEstimate
}

const ESTIMATE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000

class FolderEstimateCache {
  constructor(private readonly path: string) {}

  async load(target: string): Promise<FolderSizeEstimate | undefined> {
    try {
      const canonicalTarget = normalize(resolve(target))
      const stats = await lstat(canonicalTarget)
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!stats.isDirectory() || stats.isSymbolicLink() || !isEstimateCacheDocument(parsed)) return undefined
      const capturedAt = Date.parse(parsed.capturedAt)
      if (!Number.isFinite(capturedAt) || capturedAt > Date.now() + 60_000 || Date.now() - capturedAt > ESTIMATE_CACHE_MAX_AGE_MS) return undefined
      if (normalize(resolve(parsed.target)) !== canonicalTarget || parsed.device !== String(stats.dev) || parsed.inode !== String(stats.ino)) return undefined
      return parsed.estimate
    } catch { return undefined }
  }

  async store(target: string, estimate: FolderSizeEstimate): Promise<void> {
    const canonicalTarget = normalize(resolve(target))
    const stats = await lstat(canonicalTarget)
    if (!stats.isDirectory() || stats.isSymbolicLink()) return
    const document: EstimateCacheDocument = { version: 1, target: canonicalTarget, device: String(stats.dev), inode: String(stats.ino), capturedAt: new Date().toISOString(), estimate }
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }
}

function isEstimateCacheDocument(value: unknown): value is EstimateCacheDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as Partial<EstimateCacheDocument>
  const estimate = document.estimate
  return document.version === 1 && typeof document.target === 'string' && typeof document.device === 'string' && typeof document.inode === 'string' && typeof document.capturedAt === 'string'
    && !!estimate && Array.isArray(estimate.items) && estimate.items.length <= 400
    && estimate.items.every((item) => item && typeof item.name === 'string' && item.name.length <= 1024 && finiteNonnegative(item.estimatedBytes))
}

function finiteNonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }

function estimateFromIndex(index: DiskIndex): FolderSizeEstimate {
  const root = index.root
  return { items: root ? index.getChildren(root.id, 400).map((child) => ({ name: child.name, estimatedBytes: child.sizeBytes })) : [] }
}

function isWithinPath(path: string, parent: string): boolean {
  const child = normalize(path)
  const root = normalize(parent)
  const remainder = relative(root, child)
  return child === root || remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`)
}

async function validateRevealPath(path: string, target: string): Promise<string> {
  if (!isAbsolute(path) || !isWithinPath(path, target)) throw new Error('The worker returned an unsafe Finder path')
  const stats = await lstat(path).catch((error: unknown) => {
    if (isMissingPath(error)) throw new Error('The Finder item is no longer available')
    throw error
  })
  if (stats.isSymbolicLink()) throw new Error('The Finder path is no longer a scanned item')
  const canonical = await realpath(path).catch((error: unknown) => {
    if (isMissingPath(error)) throw new Error('The Finder item is no longer available')
    throw error
  })
  const canonicalTarget = await realpath(target).catch((error: unknown) => {
    if (isMissingPath(error)) throw new Error('The scan target is no longer available')
    throw error
  })
  if (!isWithinPath(canonical, canonicalTarget)) throw new Error('The Finder path escaped the scan target')
  return canonical
}

function isMissingPath(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function manifestPublicationWasDurable(store: IndexManifestStore): boolean {
  return (store as unknown as { readonly lastPublicationDurable?: boolean }).lastPublicationDurable !== false
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
}

function previewNode(preview: ProgressivePreview, id: string): { readonly id: string; readonly kind: 'directory' | 'file' } | undefined {
  if (preview.focus.id === id) return preview.focus
  if (preview.breadcrumbs.some((breadcrumb) => breadcrumb.id === id)) return { id, kind: 'directory' }
  const item = preview.largestItems.find((node) => node.id === id)
  if (item) return item
  const segment = preview.chart.find((node) => node.id === id)
  return segment?.id ? { id: segment.id, kind: segment.kind === 'file' ? 'file' : 'directory' } : undefined
}

function parseVolume(value: string | undefined, scannedBytes: number, target: string, accuracy: SizeAccuracy): OrbisSnapshot['volume'] {
  try {
    const parsed = JSON.parse(value ?? '{}') as { capacityBytes?: unknown; freeBytes?: unknown }
    const capacityBytes = finite(parsed.capacityBytes)
    const freeBytes = finite(parsed.freeBytes)
    const unscannedBytes = target === '/' ? Math.max(0, capacityBytes - freeBytes - scannedBytes) : 0
    return { capacityBytes, freeBytes, scannedBytes, unscannedBytes, sizeAccuracy: unscannedBytes > 0 ? 'estimated' : accuracy }
  } catch { return { capacityBytes: 0, freeBytes: 0, scannedBytes, unscannedBytes: 0, sizeAccuracy: accuracy } }
}

function emptyVolume(): OrbisSnapshot['volume'] { return { capacityBytes: 0, freeBytes: 0, scannedBytes: 0, unscannedBytes: 0, sizeAccuracy: 'partial' } }

function parseTotals(value: string | undefined): ScanTotals {
  try {
    const parsed = JSON.parse(value ?? 'null') as Partial<ScanTotals> | null
    if (!parsed) return EMPTY_TOTALS
    return { ...EMPTY_TOTALS, ...Object.fromEntries(Object.keys(EMPTY_TOTALS).map((key) => [key, finite(parsed[key as keyof ScanTotals])])) } as ScanTotals
  } catch { return EMPTY_TOTALS }
}

function finite(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0 }
function displayName(path: string): string { return path === '/' ? '/' : basename(path) || path }
