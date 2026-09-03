import { mkdir } from 'node:fs/promises'
import type { LocationId, NodeKind, ProgressSnapshot, ScanStatus } from '../shared/contracts'
import type { ConstructionResumeLoad } from './construction-preview'
import { RESUME_PREPARATION_MESSAGES, type ControllerTimingMilestones } from './diagnostics'
import type { FullScanResumeLoad, FullScanResumePeek, ResumeValidationReceipt } from './full-scan-resume'
import type { ActivePersistentIndex } from './refresh-engine'
import type { PendingScanRecord } from './location-catalog'
import type { FolderSizeEstimate } from './scan-metadata'
import type { ProgressivePreview, ScanTotals } from './scanner'
import type { ScanExecution, ScanOutcome, ScanSession } from './scan-execution'
import type { PublicationSettlement, SettlementResult, SettlementStaleReason } from './publication-settlement'

/**
 * The scan run lifecycle: the controller-side state machine above scan execution.
 *
 * It owns run identity, the generation counter, staleness discipline, the
 * transition-specific volatile-state reset, the single-use resume receipt, the
 * renderer-visible scan status, the serialized command queue, and sealed state.
 * It decides when a run becomes terminal and hands publication outcomes to
 * injected catalog-side operations. It does not own the worker session, catalog
 * transactions, snapshot assembly, or renderer navigation policy.
 */

export interface ScanLifecycleStatus {
  readonly status: ScanStatus
  readonly generation: number
  readonly progress: ProgressSnapshot | null
  readonly totals: ScanTotals | null
  readonly error: string | null
}

export interface ScanLifecycleResumeView {
  readonly available: boolean
  readonly checkpointedAt: string
}

export interface ScanLifecycleRunView {
  readonly locationId: LocationId
  readonly target: string
  readonly completed: boolean
}

export interface ScanLifecycleState {
  readonly sealed: boolean
  readonly run: ScanLifecycleRunView | undefined
  readonly scanStatus: ScanLifecycleStatus
  readonly preview: ProgressivePreview | undefined
  readonly resume: ScanLifecycleResumeView | undefined
  readonly activeTarget: string
}

export type ScanLifecycleTransitionKind =
  | 'started'
  | 'progress'
  | 'preview'
  | 'paused'
  | 'discarded'
  | 'failed'
  | 'completed'

export interface ScanLifecycleTransition {
  readonly kind: ScanLifecycleTransitionKind
  readonly generation: number
  readonly state: ScanLifecycleState
}

export interface ScanStartGuards {
  readonly expectedRevision: number
  readonly selectedLocationId: LocationId
}

export interface ScanStartContext {
  readonly identity: { readonly targetDevice: string; readonly targetInode: string }
  readonly ownerId: LocationId
  readonly basePublicationId: string | null
  readonly initialEstimate: FolderSizeEstimate | undefined
  readonly active: ActivePersistentIndex | undefined
  readonly guards: ScanStartGuards
}

export interface ScanRunContext {
  readonly generation: number
  readonly publicationId: string
  readonly locationId: LocationId
  readonly basePublicationId: string | null
  readonly target: string
  readonly partialPath: string
  readonly publishedPath: string
}

export type CompletedOutcome = Extract<ScanOutcome, { readonly kind: 'completed' }>
export type UnchangedOutcome = Extract<ScanOutcome, { readonly kind: 'unchanged' }>

const STALE_PUBLICATION_MESSAGES: Readonly<Record<SettlementStaleReason, string>> = Object.freeze({
  'stale-base-publication': 'The incremental scan was based on a stale index.',
  'stale-install': 'The scan result became stale before publication.'
})

export interface ScanLifecycleResumePort {
  peek(): Promise<FullScanResumePeek>
  load(expectedTarget?: string): Promise<FullScanResumeLoad>
  loadAcknowledgedCheckpoint(expectedTarget: string, checkpointSequence: number): Promise<FullScanResumeLoad>
  discard(expectedScanId?: string): Promise<boolean>
  removeDescriptor(): Promise<void>
}

export type ReadConstructionPreview =
  (load: ConstructionResumeLoad, generation: number, focusId?: string) => Promise<ProgressivePreview | undefined>
export type ResolveConstructionNodePath =
  (load: ConstructionResumeLoad, id: string) => Promise<string | undefined>

export interface ScanLifecycleDependencies {
  readonly indexDirectory: string
  readonly scanExecution: ScanExecution
  readonly resume: ScanLifecycleResumePort
  readonly ensureInitialized: () => Promise<void>
  readonly prepareStartContext: (target: string) => Promise<ScanStartContext>
  readonly createPublicationId: () => string
  readonly runPaths: (publicationId: string) => { readonly partialPath: string; readonly publishedPath: string }
  readonly beginScan: (record: PendingScanRecord, previousScanId: string | undefined, guards: ScanStartGuards) => Promise<void>
  readonly settlement: PublicationSettlement
  readonly clearPendingScan: (scanId: string) => Promise<void>
  readonly discardUnreferencedDatabase: (path: string) => Promise<void>
  readonly pendingScanId: () => string | undefined
  readonly readConstructionPreview: ReadConstructionPreview
  readonly resolveConstructionNodePath: ResolveConstructionNodePath
  readonly validateNodeActionPath: (path: string, target: string, kind: NodeKind) => Promise<string>
  readonly createMilestones: () => ControllerTimingMilestones
}

export type ScanFocusDisposition = 'applied' | 'not-running'
export type ScanNodePathDisposition =
  | { readonly kind: 'live' | 'saved'; readonly validatedPath: string; readonly nodeKind: NodeKind }
  | { readonly kind: 'not-running' }

interface LifecycleRun extends ScanRunContext {
  readonly sessionPromise: Promise<ScanSession>
  readonly resumeMilestones?: ControllerTimingMilestones
  readonly durablePreview?: ProgressivePreview
  readonly durableConstruction?: ConstructionResumeLoad
  session?: ScanSession
  completed: boolean
  published: boolean
}

export class ScanRunLifecycle {
  readonly #deps: ScanLifecycleDependencies
  #sealed = false
  #generation = 0
  #run: LifecycleRun | undefined
  #scanStatus: ScanLifecycleStatus = { status: 'idle', generation: 0, progress: null, totals: null, error: null }
  #preview: ProgressivePreview | undefined
  #savedConstruction: ConstructionResumeLoad | undefined
  #resumeReceipt: ResumeValidationReceipt | undefined
  #pausedProgress: ProgressSnapshot | undefined
  #resume: ScanLifecycleResumeView | undefined
  #activeTarget: string
  #pendingNodeResolutionCancellations = new Set<(error: Error) => void>()
  #pendingTasks = new Set<Promise<void>>()
  #pendingTerminalCleanup: Promise<void> | undefined
  #queue: Promise<void> = Promise.resolve()
  #listeners = new Set<(transition: ScanLifecycleTransition) => void>()

  constructor(deps: ScanLifecycleDependencies, initialTarget: string) {
    this.#deps = deps
    this.#activeTarget = initialTarget
  }

  get state(): ScanLifecycleState {
    const run = this.#run
    return Object.freeze({
      sealed: this.#sealed,
      run: run ? Object.freeze({ locationId: run.locationId, target: run.target, completed: run.completed }) : undefined,
      scanStatus: this.#scanStatus,
      preview: this.#preview,
      resume: this.#resume,
      activeTarget: this.#activeTarget
    })
  }

  subscribe(listener: (transition: ScanLifecycleTransition) => void): () => void {
    if (this.#sealed) return () => undefined
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  startScan(request: { readonly target: string }): Promise<ScanLifecycleState> {
    if (this.#sealed) return Promise.reject(new Error('Orbis is shutting down'))
    return this.#command(() => this.#startScanSerial(request.target))
  }

  pauseScan(): Promise<ScanLifecycleState> {
    if (this.#sealed) return Promise.resolve(this.state)
    return this.#command(() => this.#pauseSerial())
  }

  discardSavedScan(): Promise<ScanLifecycleState> {
    if (this.#sealed) return Promise.resolve(this.state)
    return this.#command(() => this.#discardSerial())
  }

  async focusNode(id: string): Promise<ScanFocusDisposition> {
    const run = this.#run
    if (run && !run.completed && this.#preview) {
      const node = previewNode(this.#preview, id)
      if (!node) throw new Error('Unknown Orbis node')
      if (node.kind !== 'directory') throw new Error('Only directories can become the chart root')
      this.#rejectPendingNodeResolutions('The focused folder changed before the item action could run')
      const session = await run.sessionPromise
      if (this.#run !== run || run.completed) return 'applied'
      run.session = session
      void session.focus(id)
      return 'applied'
    }
    const saved = this.#savedConstruction
    if (saved && this.#preview) {
      const preview = await this.#deps.readConstructionPreview(saved, this.#scanStatus.generation, id)
      if (!preview) throw new Error('Unknown Orbis node')
      if (this.#sealed || this.#run || this.#savedConstruction !== saved) throw new Error('The scan changed before the folder could be opened')
      this.#rejectPendingNodeResolutions('The focused folder changed before the item action could run')
      this.#preview = preview
      this.#notify('preview', this.#scanStatus.generation)
      return 'applied'
    }
    return 'not-running'
  }

  async resolveNodePath(id: string): Promise<ScanNodePathDisposition> {
    const run = this.#run
    if (run && !run.completed && this.#preview) {
      const node = previewNode(this.#preview, id)
      if (!node) throw new Error('Unknown Orbis node')
      const outcome = await this.#resolveLiveNode(run, id)
      if (outcome.kind !== 'resolved') throw new Error('Unknown Orbis node')
      if (this.#run !== run) throw new Error('The scan changed before the item action could run')
      const validatedPath = await this.#deps.validateNodeActionPath(outcome.path, run.target, node.kind)
      if (this.#run !== run) throw new Error('The scan changed before the item action could run')
      return { kind: 'live', validatedPath, nodeKind: node.kind }
    }
    const saved = this.#savedConstruction
    if (saved && this.#preview) {
      const node = previewNode(this.#preview, id)
      if (!node) throw new Error('Unknown Orbis node')
      const path = await this.#deps.resolveConstructionNodePath(saved, id)
      if (!path) throw new Error('Unknown Orbis node')
      const validatedPath = await this.#deps.validateNodeActionPath(path, saved.descriptor.target, node.kind)
      if (this.#sealed || this.#run || this.#savedConstruction !== saved) throw new Error('The scan changed before the item action could run')
      return { kind: 'saved', validatedPath, nodeKind: node.kind }
    }
    return { kind: 'not-running' }
  }

  async seal(initialization?: Promise<unknown>): Promise<void> {
    if (this.#sealed) return
    this.#sealed = true
    const queue = this.#queue
    await queue
    if (initialization) await initialization.catch(() => undefined)
    const run = this.#run
    if (run && !run.completed) {
      this.#run = undefined
      await this.#stopRun(run)
    }
    await this.#deps.scanExecution.close()
    await Promise.allSettled([...this.#pendingTasks])
    this.#run = undefined
    this.#preview = undefined
    this.#savedConstruction = undefined
    this.#resumeReceipt = undefined
    this.#rejectPendingNodeResolutions('Orbis is shutting down')
  }

  /** Initialization-only adoption at generation 0. Never enqueued behind ensureInitialized. */
  async adoptStartupState(input: { readonly saved: FullScanResumeLoad; readonly selectedTarget: string }): Promise<void> {
    this.#activeTarget = input.selectedTarget
    this.#rememberResumeLoad(input.saved)
    if (input.saved.kind === 'construction' || input.saved.kind === 'candidate') {
      this.#resume = {
        available: true,
        checkpointedAt: input.saved.kind === 'construction' ? input.saved.checkpointedAt : input.saved.descriptor.createdAt
      }
      this.#scanStatus = { status: 'canceled', generation: 0, progress: null, totals: null, error: null }
      if (input.saved.kind === 'construction') await this.#restoreConstructionPreview(input.saved, 0)
    } else if (input.saved.kind === 'restart' && input.saved.reason === 'target-unavailable' && input.saved.descriptor) {
      this.#resume = { available: true, checkpointedAt: input.saved.descriptor.createdAt }
      this.#scanStatus = { status: 'canceled', generation: 0, progress: null, totals: null, error: null }
    }
  }

  // --- serialized commands -------------------------------------------------------------

  #command<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.#queue
    this.#queue = new Promise<void>((resolveQueue) => { release = resolveQueue })
    return previous.then(operation, operation).finally(() => release())
  }

  async #startScanSerial(target: string): Promise<ScanLifecycleState> {
    if (this.#sealed) throw new Error('Orbis is shutting down')
    await this.#deps.ensureInitialized()
    await this.#awaitTerminalCleanup()
    if (this.#sealed) throw new Error('Orbis is shutting down')
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
    await mkdir(this.#deps.indexDirectory, { recursive: true, mode: 0o700 })
    if (this.#sealed) throw new Error('Orbis is shutting down')
    const generation = ++this.#generation
    // Peek at the saved scan (descriptor + file existence) instead of fully
    // validating it: the worker performs the authoritative validation before
    // resuming, and full validation is O(index size) on large saved scans.
    let saved = stoppedSaved ?? await this.#deps.resume.peek()
    if (process.env.ORBIS_DISABLE_INCREMENTAL_SCAN === '1' && saved.kind !== 'none') {
      if (saved.kind === 'construction' || saved.kind === 'candidate' || saved.descriptor) await this.#deps.resume.discard(saved.descriptor?.scanId)
      else await this.#deps.resume.removeDescriptor()
      saved = { kind: 'none' }
      this.#resumeReceipt = undefined
    }
    const savedDescriptor = saved.kind === 'construction' || saved.kind === 'candidate' || saved.kind === 'restart' ? saved.descriptor : undefined
    if (savedDescriptor && savedDescriptor.target !== target) throw new Error('Discard the saved scan before choosing another folder')
    const publicationId = saved.kind === 'construction' || saved.kind === 'candidate' ? saved.descriptor.scanId : this.#deps.createPublicationId()
    const { partialPath, publishedPath } = this.#deps.runPaths(publicationId)
    if (saved.kind !== 'construction' && saved.kind !== 'candidate') {
      await this.#deps.discardUnreferencedDatabase(partialPath)
      await this.#deps.discardUnreferencedDatabase(publishedPath)
    }
    const context = await this.#deps.prepareStartContext(target)
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
    this.#rejectPendingNodeResolutions('A newer scan started')
    await this.#deps.beginScan(
      { scanId: publicationId, locationId: context.ownerId, target, targetDevice: context.identity.targetDevice, targetInode: context.identity.targetInode, basePublicationId: context.basePublicationId },
      current?.publicationId,
      context.guards
    )
    const sessionPromise = Promise.resolve().then(() => this.#deps.scanExecution.start({
      target, partialPath, publishedPath, indexDirectory: this.#deps.indexDirectory, startupRoot: target === '/', resumeExpected,
      ...(resumeReceipt ? { resumeReceipt } : {}),
      ...(context.initialEstimate ? { initialEstimate: context.initialEstimate } : {}),
      ...(context.active ? { active: context.active } : {})
    }))
    const run: LifecycleRun = {
      generation, publicationId, locationId: context.ownerId, basePublicationId: context.basePublicationId, target, partialPath, publishedPath, sessionPromise,
      ...(resumeExpected ? { resumeMilestones: this.#deps.createMilestones() } : {}),
      ...(durablePreview ? { durablePreview: { ...durablePreview, generation } } : {}),
      ...(durableConstruction ? { durableConstruction } : {}),
      completed: false, published: false
    }
    this.#run = run
    this.#activeTarget = target
    this.#resume = undefined
    const retained = this.#pausedProgress
    const progress: ProgressSnapshot | null = resumeExpected ? {
      stage: 'resuming', scannedItems: retained?.scannedItems ?? 0,
      discoveredBytes: retained?.discoveredBytes ?? durablePreview?.volume.scannedBytes ?? 0,
      elapsedMs: retained?.elapsedMs ?? 0, currentItem: RESUME_PREPARATION_MESSAGES.validating
    } : null
    this.#scanStatus = { status: 'scanning', generation, progress, totals: null, error: null }
    this.#track(this.#consumeRun(run))
    this.#notify('started', generation)
    return this.state
  }

  async #pauseSerial(): Promise<ScanLifecycleState> {
    if (this.#sealed) return this.state
    await this.#awaitTerminalCleanup()
    if (this.#sealed) return this.state
    const run = this.#run
    if (!run) return this.state
    if (run.completed) {
      await Promise.allSettled([...this.#pendingTasks])
      return this.state
    }
    this.#run = undefined
    if (this.#scanStatus.progress && this.#scanStatus.progress.stage !== 'resuming') this.#pausedProgress = this.#scanStatus.progress
    this.#preview = undefined
    this.#savedConstruction = undefined
    this.#rejectPendingNodeResolutions('Scan paused')
    const stopped = await this.#stopRun(run)
    if (this.#sealed || this.#generation !== run.generation || this.#run) return this.state
    const saved = await this.#loadResumeAfterStop(run.target, stopped)
    if (this.#sealed || this.#generation !== run.generation || this.#run) return this.state
    this.#rememberResumeLoad(saved)
    this.#resume = saved.kind === 'construction' || saved.kind === 'candidate'
      ? { available: true, checkpointedAt: saved.kind === 'construction' ? saved.checkpointedAt : saved.descriptor.createdAt }
      : undefined
    await this.#restoreConstructionPreview(saved, run.generation)
    if (this.#resume === undefined) {
      // The pause could not claim a resume: no construction or candidate
      // survived the stop, so nothing may resume this run. Release its
      // catalog transaction and run files before reporting the pause, or
      // the next scan cannot begin ("Another Orbis scan owns the catalog").
      await this.#releaseDeadRun(run)
    }
    this.#scanStatus = { status: 'canceled', generation: run.generation, progress: null, totals: null, error: null }
    this.#notify('paused', run.generation)
    return this.state
  }

  async #discardSerial(): Promise<ScanLifecycleState> {
    if (this.#sealed) return this.state
    await this.#awaitTerminalCleanup()
    if (this.#sealed) return this.state
    const run = this.#run
    const changed =
      run !== undefined || this.#preview !== undefined || this.#savedConstruction !== undefined
      || this.#resumeReceipt !== undefined || this.#resume !== undefined || this.#scanStatus.status === 'canceled'
      || this.#deps.pendingScanId() !== undefined
    if (run?.completed) await Promise.allSettled([...this.#pendingTasks])
    else if (run) {
      this.#run = undefined
      await this.#stopRun(run)
    }
    this.#preview = undefined
    this.#savedConstruction = undefined
    this.#resumeReceipt = undefined
    this.#rejectPendingNodeResolutions('Saved scan discarded')
    const pendingScanId = this.#deps.pendingScanId()
    await this.#deps.resume.discard(pendingScanId)
    if (pendingScanId) await this.#deps.clearPendingScan(pendingScanId)
    this.#resume = undefined
    if (this.#scanStatus.status === 'canceled') this.#scanStatus = { status: 'idle', generation: this.#scanStatus.generation, progress: null, totals: null, error: null }
    if (changed) this.#notify('discarded', this.#scanStatus.generation)
    return this.state
  }

  // --- run consumption and outcome dispatch --------------------------------------------

  async #consumeRun(run: LifecycleRun): Promise<void> {
    let session: ScanSession
    try {
      session = await run.sessionPromise
      run.session = session
      run.resumeMilestones?.mark(run.generation, 'resume-click-to-session')
    } catch (error) {
      if (this.#run === run && !this.#sealed) {
        const failure = error instanceof Error ? error : new Error(String(error))
        void Promise.resolve(this.#deps.scanExecution.recordFailure?.(run.generation, { kind: 'worker-transport', code: failureCode(failure), lifecycleStage: 'starting' })).catch(() => undefined)
        await this.#dispatchOutcome(run, { kind: 'failed', error: failure })
      }
      return
    }
    if (this.#run !== run || this.#sealed || run.completed) {
      await session.pause()
      return
    }
    for await (const update of session.events) {
      if (this.#run !== run || this.#sealed || run.completed) continue
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
        this.#notify('progress', run.generation)
      } else if (update.type === 'progress') {
        run.resumeMilestones?.mark(run.generation, 'resume-click-to-first-progress')
        this.#scanStatus = { status: 'scanning', generation: run.generation, progress: update.progress, totals: null, error: null }
        this.#notify('progress', run.generation)
      } else if (update.preview.generation === run.generation && (!this.#preview || update.preview.revision >= this.#preview.revision)) {
        this.#preview = update.preview
        this.#notify('preview', run.generation)
      }
    }
    const outcome = await session.result
    if (this.#run !== run || this.#sealed) {
      if (outcome.kind === 'completed' && !run.published) await this.#deps.discardUnreferencedDatabase(outcome.result.publishedPath)
      return
    }
    await this.#dispatchOutcome(run, outcome)
  }

  async #dispatchOutcome(run: LifecycleRun, outcome: ScanOutcome): Promise<void> {
    if (outcome.kind === 'completed' || outcome.kind === 'unchanged') {
      run.completed = true
      await this.#settleRun(run, outcome)
    } else if (outcome.kind === 'canceled' || outcome.kind === 'paused') {
      this.#run = undefined
      this.#preview = undefined
      this.#savedConstruction = undefined
      this.#rejectPendingNodeResolutions('Scan paused')
      this.#scanStatus = { status: 'canceled', generation: run.generation, progress: null, totals: null, error: null }
      // The run ended from the worker side. Its terminal transition — the
      // resume load, the no-proof release, and the paused notification — runs
      // as tracked terminal cleanup, so a following command cannot begin
      // against the dead run's catalog record or files.
      const cleanup = (async () => {
        await this.#refreshResumeState(run.generation, true, { target: run.target, outcome })
        if (this.#sealed || this.#generation !== run.generation || this.#run) return
        if (this.#resume === undefined) await this.#releaseDeadRun(run)
        this.#notify('paused', run.generation)
      })().catch(() => undefined)
      this.#registerTerminalCleanup(cleanup)
      await cleanup
    } else {
      // WorkerScanSession records the concrete worker failure before settling;
      // do not replace it with a generic lifecycle error here.
      this.#failRun(run, outcome.error.message, 'worker-error', false)
    }
  }

  async #settleRun(run: LifecycleRun, outcome: CompletedOutcome | UnchangedOutcome): Promise<void> {
    if (outcome.kind === 'completed') {
      if (this.#run !== run || this.#sealed) {
        await this.#deps.discardUnreferencedDatabase(outcome.result.publishedPath)
        return
      }
    } else if (this.#run !== run || this.#sealed) return
    let result: SettlementResult
    try {
      result = await this.#deps.settlement.settle(run, outcome)
    } catch (error) {
      if (outcome.kind === 'completed') await this.#deps.clearPendingScan(run.publicationId).catch(() => undefined)
      this.#failRun(run, error instanceof Error ? error.message : String(error), 'publication-error')
      return
    }
    if (result.kind === 'stale') {
      this.#failRun(run, STALE_PUBLICATION_MESSAGES[result.reason], 'publication-stale')
      return
    }
    run.published = true
    if (this.#run !== run || this.#sealed) return
    this.#applyCompleted(run, result.totals, result.activeTarget)
  }

  #applyCompleted(run: LifecycleRun, totals: ScanTotals, activeTarget: string): void {
    this.#preview = undefined
    this.#savedConstruction = undefined
    this.#resumeReceipt = undefined
    this.#rejectPendingNodeResolutions('Scan completed')
    this.#resume = undefined
    this.#activeTarget = activeTarget
    this.#scanStatus = { status: 'completed', generation: run.generation, progress: null, totals, error: null }
    this.#run = undefined
    this.#notify('completed', run.generation)
  }

  #failRun(run: LifecycleRun, error: string, kind: string = 'lifecycle-error', recordDiagnostic = true): void {
    if (this.#run !== run) return
    this.#run = undefined
    this.#preview = run.durablePreview
    this.#savedConstruction = run.durableConstruction
    this.#rejectPendingNodeResolutions('Scan failed')
    this.#scanStatus = { status: 'fatal-error', generation: run.generation, progress: null, totals: null, error }
    if (recordDiagnostic) void Promise.resolve(this.#deps.scanExecution.recordFailure?.(run.generation, {
      kind, lifecycleStage: 'failed', code: failureCode(error)
    })).catch(() => undefined)
    const cleanup = this.#stopRun(run).then(async () => {
      await this.#refreshResumeState(run.generation, true)
      if (this.#sealed || this.#generation !== run.generation || this.#run) return
      if (this.#resume) this.#scanStatus = { status: 'canceled', generation: run.generation, progress: null, totals: null, error: null }
      else {
        await this.#deps.clearPendingScan(run.publicationId).catch(() => undefined)
        await this.#deps.discardUnreferencedDatabase(run.partialPath)
        await this.#deps.discardUnreferencedDatabase(run.publishedPath)
      }
      this.#notify('failed', run.generation)
    }).catch(() => undefined)
    this.#registerTerminalCleanup(cleanup)
  }

  // --- resume state ----------------------------------------------------------------------

  async #refreshResumeState(
    generation: number, restorePreview = false,
    stopped?: { readonly target: string; readonly outcome: ScanOutcome }
  ): Promise<void> {
    const saved = stopped ? await this.#loadResumeAfterStop(stopped.target, stopped.outcome) : await this.#deps.resume.load(this.#activeTarget)
    if (this.#sealed || this.#generation !== generation || this.#run) return
    this.#rememberResumeLoad(saved)
    this.#resume = saved.kind === 'construction' || saved.kind === 'candidate'
      ? { available: true, checkpointedAt: saved.kind === 'construction' ? saved.checkpointedAt : saved.descriptor.createdAt }
      : undefined
    this.#savedConstruction = undefined
    if (restorePreview && saved.kind === 'construction' && saved.descriptor.target === this.#activeTarget) {
      const restored = await this.#restoreConstructionPreview(saved, generation)
      if (!restored && !this.#sealed && this.#generation === generation && !this.#run) this.#preview = undefined
    } else if (restorePreview) this.#preview = undefined
  }

  async #restoreConstructionPreview(saved: FullScanResumeLoad, generation: number): Promise<boolean> {
    if (saved.kind !== 'construction' || saved.descriptor.target !== this.#activeTarget) return false
    const retainedFocusId = this.#preview?.focus.id
    const preview = await this.#deps.readConstructionPreview(saved, generation, retainedFocusId)
      ?? (retainedFocusId ? await this.#deps.readConstructionPreview(saved, generation) : undefined)
    if (!preview || this.#sealed || this.#generation !== generation || this.#run || saved.descriptor.target !== this.#activeTarget) return false
    this.#savedConstruction = saved
    this.#preview = preview
    return true
  }

  #rememberResumeLoad(saved: FullScanResumeLoad): void {
    this.#resumeReceipt = saved.kind === 'construction' || saved.kind === 'candidate' ? saved.receipt : undefined
  }

  async #loadResumeAfterStop(target: string, outcome: ScanOutcome): Promise<FullScanResumeLoad> {
    if (outcome.kind === 'paused' && outcome.acknowledged && outcome.checkpointSequence !== undefined) {
      return this.#deps.resume.loadAcknowledgedCheckpoint(target, outcome.checkpointSequence)
    }
    return this.#deps.resume.load(target)
  }

  // --- helpers ---------------------------------------------------------------------------

  async #awaitTerminalCleanup(): Promise<void> {
    const cleanup = this.#pendingTerminalCleanup
    if (cleanup) await cleanup
  }

  /** Tracks a dead run's terminal cleanup so later commands await it before starting. */
  #registerTerminalCleanup(cleanup: Promise<void>): void {
    this.#pendingTerminalCleanup = cleanup
    void cleanup.then(() => {
      if (this.#pendingTerminalCleanup === cleanup) this.#pendingTerminalCleanup = undefined
    })
    this.#track(cleanup)
  }

  /**
   * Releases a dead run's catalog transaction and run files when no resume
   * proof may claim them. Best effort: an absent or replaced record is
   * tolerated, discard failures defer to startup reconciliation, and the
   * reference check keeps any file a live descriptor still needs.
   */
  async #releaseDeadRun(run: LifecycleRun): Promise<void> {
    await this.#deps.clearPendingScan(run.publicationId).catch(() => undefined)
    try {
      await this.#deps.discardUnreferencedDatabase(run.partialPath)
      await this.#deps.discardUnreferencedDatabase(run.publishedPath)
    } catch { /* Startup reconciliation retries cleanup. */ }
  }

  async #stopRun(run: LifecycleRun): Promise<ScanOutcome> {
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

  async #resolveLiveNode(run: LifecycleRun, id: string): ReturnType<ScanSession['resolveNode']> {
    let rejectCancellation!: (error: Error) => void
    const canceled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    this.#pendingNodeResolutionCancellations.add(rejectCancellation)
    try {
      const session = await run.sessionPromise
      if (this.#run !== run || run.completed) throw new Error('The scan changed before the item could be revealed')
      run.session = session
      return await Promise.race([session.resolveNode(id), canceled])
    }
    finally { this.#pendingNodeResolutionCancellations.delete(rejectCancellation) }
  }

  #rejectPendingNodeResolutions(message: string): void {
    const error = new Error(message)
    for (const reject of this.#pendingNodeResolutionCancellations) reject(error)
    this.#pendingNodeResolutionCancellations.clear()
  }

  #track(task: Promise<void>): void {
    this.#pendingTasks.add(task)
    void task.finally(() => this.#pendingTasks.delete(task)).catch(() => undefined)
  }

  #notify(kind: ScanLifecycleTransitionKind, generation: number): void {
    const transition: ScanLifecycleTransition = Object.freeze({ kind, generation, state: this.state })
    for (const listener of this.#listeners) {
      try { listener(transition) } catch { /* A controller listener must not break the lifecycle. */ }
    }
  }
}

function failureCode(error: unknown): string | undefined {
  const value = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : undefined
}

function previewNode(preview: ProgressivePreview, id: string): { readonly id: string; readonly kind: 'directory' | 'file' } | undefined {
  if (preview.focus.id === id) return preview.focus
  if (preview.breadcrumbs.some((breadcrumb) => breadcrumb.id === id)) return { id, kind: 'directory' }
  const item = preview.largestItems.find((node) => node.id === id)
  if (item) return item
  const segment = preview.chart.find((node) => node.id === id)
  return segment?.id ? { id: segment.id, kind: segment.kind === 'file' ? 'file' : 'directory' } : undefined
}