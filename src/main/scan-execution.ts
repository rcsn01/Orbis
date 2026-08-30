import type { ProgressSnapshot } from '../shared/contracts'
import { isResumePreparationPhase, RESUME_PREPARATION_PHASES, type ResumeMilestone, type ResumePreparationPhase } from './diagnostics'
import type { JournalCursor } from './index-manifest'
import { PublicationArtifacts } from './publication-artifacts'
import type { FolderSizeEstimate, NativeAddonStatus } from './scan-metadata'
import { ScanFailureDiagnosticsStore, type ScanFailureDiagnosticsFailureInput, type ScanFailureKind } from './scan-failure-diagnostics'
import type { ConstructionCheckpointNotice } from './construction-database'
import type { ActivePersistentIndex } from './refresh-engine'
import type { ResumeValidationReceipt } from './full-scan-resume'
import type { ProgressivePreview, ScanResult, ScanTotals } from './scanner'
import type {
  WorkerCompleteMessage, WorkerFocusAcceptedMessage, WorkerMessage, WorkerPausedMessage,
  WorkerResolvedNodeMessage, WorkerResultMessage
} from './scan-execution-protocol'

export interface WorkerTransport {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): WorkerTransport
  on(event: 'error', listener: (error: unknown) => void): WorkerTransport
  on(event: 'exit', listener: (code: number) => void): WorkerTransport
  terminate(): Promise<number> | void
}

export interface WorkerTransportFactory { create(): WorkerTransport }

export interface ScanExecutionRequest {
  readonly target: string
  readonly partialPath: string
  readonly publishedPath: string
  readonly indexDirectory: string
  readonly startupRoot: boolean
  readonly resumeExpected?: boolean
  readonly resumeReceipt?: ResumeValidationReceipt
  readonly initialEstimate?: FolderSizeEstimate
  readonly active?: ActivePersistentIndex
}

export type ScanUpdate =
  | { readonly type: 'progress'; readonly progress: ProgressSnapshot }
  | { readonly type: 'preview'; readonly preview: ProgressivePreview }
  | { readonly type: 'resume-milestone'; readonly milestone: ResumeMilestone }
  | { readonly type: 'resume-preparation'; readonly phase: ResumePreparationPhase }

export type ScanOutcome =
  | { readonly kind: 'completed'; readonly result: ScanResult; readonly refresh?: WorkerCompleteMessage['refresh'] }
  | { readonly kind: 'unchanged'; readonly journal: JournalCursor; readonly totals: ScanTotals; readonly basePublicationId: string }
  | { readonly kind: 'paused'; readonly acknowledged: boolean; readonly checkpointSequence?: number }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'failed'; readonly error: Error }

export type FocusOutcome = { readonly kind: 'accepted' } | { readonly kind: 'unavailable' }
export type ResolveNodeOutcome = { readonly kind: 'resolved'; readonly path: string } | { readonly kind: 'unavailable' }

export interface ScanSession {
  readonly events: AsyncIterable<ScanUpdate>
  readonly result: Promise<ScanOutcome>
  focus(nodeId: string): Promise<FocusOutcome>
  resolveNode(nodeId: string): Promise<ResolveNodeOutcome>
  pause(): Promise<ScanOutcome>
}

export interface ScanExecution {
  start(request: ScanExecutionRequest): Promise<ScanSession>
  recordFailure?(generation: number, failure: Omit<ScanFailureDiagnosticsFailureInput, 'generation'>): Promise<void>
  close(): Promise<void>
}

export interface WorkerScanExecutionOptions {
  readonly pauseTimeoutMs?: number
  readonly discardStaleCandidate?: (path: string, indexDirectory: string) => Promise<void>
  readonly diagnostics?: ScanFailureDiagnosticsStore | (() => ScanFailureDiagnosticsStore | undefined)
}

type DiagnosticsProvider = ScanFailureDiagnosticsStore | (() => ScanFailureDiagnosticsStore | undefined)

export class WorkerScanExecution implements ScanExecution {
  readonly #pauseTimeoutMs: number
  readonly #discardStaleCandidate: (path: string, indexDirectory: string) => Promise<void>
  readonly #diagnostics: DiagnosticsProvider | undefined
  #generation = 0
  #active: WorkerScanSession | undefined
  #diagnosticsResolved = false
  #diagnosticsInstance: ScanFailureDiagnosticsStore | undefined
  #startQueue: Promise<void> = Promise.resolve()
  #closed = false

  constructor(private readonly workers: WorkerTransportFactory, options: WorkerScanExecutionOptions = {}) {
    this.#pauseTimeoutMs = options.pauseTimeoutMs ?? 250
    this.#discardStaleCandidate = options.discardStaleCandidate ?? discardStaleCandidate
    this.#diagnostics = options.diagnostics
  }

  async start(request: ScanExecutionRequest): Promise<ScanSession> {
    let release!: () => void
    const previous = this.#startQueue
    this.#startQueue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      if (this.#closed) throw new Error('Scan execution is closed')
      if (this.#active && !this.#active.settled) await this.#active.pause()
      const generation = ++this.#generation
      const diagnostics = this.#resolveDiagnostics()
      const diagnosticsStarted = Promise.resolve(diagnostics?.startRun({ generation, resumeExpected: request.resumeExpected === true })).catch(() => undefined)
      let worker: WorkerTransport
      try { worker = this.workers.create() }
      catch (error) {
        await diagnosticsStarted
        void Promise.resolve(diagnostics?.recordFailure({ generation, kind: 'worker-transport', code: errorCode(error) })).catch(() => undefined)
        return new FailedScanSession(error)
      }
      const session = new WorkerScanSession(
        worker, generation, request, this.#pauseTimeoutMs, this.#discardStaleCandidate, diagnostics,
        () => { if (this.#active === session && session.settled) this.#active = undefined }
      )
      this.#active = session
      session.start()
      await diagnosticsStarted
      return session
    } finally {
      release()
    }
  }

  async recordFailure(generation: number, failure: Omit<ScanFailureDiagnosticsFailureInput, 'generation'>): Promise<void> {
    const diagnostics = this.#resolveDiagnostics()
    try { await diagnostics?.recordFailure({ generation, ...failure }) } catch { /* Diagnostics are best effort. */ }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#startQueue
    const active = this.#active
    this.#active = undefined
    if (active && !active.settled) await active.pause()
  }

  #resolveDiagnostics(): ScanFailureDiagnosticsStore | undefined {
    if (!this.#diagnosticsResolved) {
      this.#diagnosticsResolved = true
      this.#diagnosticsInstance = resolveDiagnostics(this.#diagnostics)
    }
    return this.#diagnosticsInstance
  }
}

class WorkerScanSession implements ScanSession {
  readonly #updates = new AsyncQueue<ScanUpdate>()
  readonly #outcome = deferred<ScanOutcome>()
  readonly #pendingFocus = new Map<number, (outcome: FocusOutcome) => void>()
  readonly #pendingResolutions = new Map<number, (outcome: ResolveNodeOutcome) => void>()
  readonly events: AsyncIterable<ScanUpdate> = this.#updates
  readonly result = this.#outcome.promise
  #requestId = 1
  #latestPreviewRevision = -1
  #latestResumePreparation = -1
  #terminal = false
  #stopping = false
  #terminated = false
  #pauseRequestId: number | undefined
  #pauseAcknowledgement: ReturnType<typeof deferred<WorkerPausedMessage>> | undefined
  #stopPromise: Promise<void> | undefined
  #failureInProgress = false
  #failurePromise: Promise<void> | undefined
  #latestCheckpoint: ConstructionCheckpointNotice | undefined
  #nativeAddonStatus: NativeAddonStatus | undefined

  constructor(
    private readonly worker: WorkerTransport,
    private readonly generation: number,
    private readonly request: ScanExecutionRequest,
    private readonly pauseTimeoutMs: number,
    private readonly discardStaleCandidate: (path: string, indexDirectory: string) => Promise<void>,
    private readonly diagnostics: ScanFailureDiagnosticsStore | undefined,
    private readonly onSettled: () => void
  ) {}

  get settled(): boolean { return this.#terminal }

  start(): void {
    void this.diagnostics?.setStage(this.generation, 'starting')
    this.worker.on('message', (message) => this.#handleMessage(message))
    this.worker.on('error', (error) => this.#fail(error, 'worker-transport'))
    this.worker.on('exit', (code) => {
      if (!this.#terminal && !this.#stopping) this.#fail(new Error(code === 0 ? 'The scan worker exited before completing.' : `The scan worker stopped unexpectedly (code ${code}).`), 'worker-exit', code)
    })
    const message: WorkerMessage = {
      type: 'start', generation: this.generation, requestId: this.#requestId,
      target: this.request.target, partialPath: this.request.partialPath, publishedPath: this.request.publishedPath,
      indexDirectory: this.request.indexDirectory, startupRoot: this.request.startupRoot, resumeExpected: this.request.resumeExpected === true,
      ...(this.request.resumeReceipt ? { resumeReceipt: this.request.resumeReceipt } : {}),
      ...(this.request.initialEstimate ? { initialEstimate: this.request.initialEstimate } : {}),
      ...(this.request.active ? { active: this.request.active } : {})
    }
    try { this.worker.postMessage(message) } catch (error) { this.#fail(error, 'worker-transport') }
  }

  async focus(nodeId: string): Promise<FocusOutcome> {
    if (this.#terminal || this.#stopping) return { kind: 'unavailable' }
    const requestId = ++this.#requestId
    const outcome = new Promise<FocusOutcome>((resolve) => this.#pendingFocus.set(requestId, resolve))
    try { this.worker.postMessage({ type: 'focus', generation: this.generation, requestId, id: nodeId } satisfies WorkerMessage) }
    catch { this.#pendingFocus.delete(requestId); return { kind: 'unavailable' } }
    return outcome
  }

  async resolveNode(nodeId: string): Promise<ResolveNodeOutcome> {
    if (this.#terminal || this.#stopping) return { kind: 'unavailable' }
    const requestId = ++this.#requestId
    const outcome = new Promise<ResolveNodeOutcome>((resolve) => this.#pendingResolutions.set(requestId, resolve))
    try { this.worker.postMessage({ type: 'resolve-node', generation: this.generation, requestId, id: nodeId } satisfies WorkerMessage) }
    catch { this.#pendingResolutions.delete(requestId); return { kind: 'unavailable' } }
    return outcome
  }

  async pause(): Promise<ScanOutcome> {
    if (this.#failureInProgress) await this.#failurePromise
    if (this.#terminal) {
      await this.#stopPromise
      return this.result
    }
    this.#stopPromise ??= this.#pauseAndTerminate()
    await this.#stopPromise
    return this.result
  }

  async #pauseAndTerminate(): Promise<void> {
    this.#stopping = true
    const requestId = ++this.#requestId
    this.#pauseRequestId = requestId
    this.#pauseAcknowledgement = deferred<WorkerPausedMessage>()
    try { this.worker.postMessage({ type: 'pause', generation: this.generation, requestId } satisfies WorkerMessage) } catch { /* Termination still preserves the last durable checkpoint. */ }
    void this.diagnostics?.setStage(this.generation, 'pausing')
    const paused = await Promise.race([
      this.#pauseAcknowledgement.promise.then((message) => ({ acknowledged: true, checkpointSequence: message.checkpointSequence })),
      delay(this.pauseTimeoutMs).then(() => ({ acknowledged: false as const }))
    ])
    if (paused.acknowledged) {
      void Promise.resolve(this.diagnostics?.clearActive(this.generation)).catch(() => undefined)
    } else {
      void Promise.resolve(this.diagnostics?.recordFailure({ generation: this.generation, kind: 'pause-timeout', lifecycleStage: 'pausing',
        ...(this.#latestCheckpoint ? { latestCheckpoint: this.#latestCheckpoint } : {}),
        ...(this.#nativeAddonStatus ? { nativeAddon: this.#nativeAddonStatus } : {}) })).catch(() => undefined)
    }
    await this.#terminate()
    if (!this.#terminal) this.#settle({ kind: 'paused', ...paused })
  }

  #handleMessage(value: unknown): void {
    const message = value as Partial<WorkerResultMessage>
    if (message.type === 'paused' && message.generation === this.generation && message.requestId === this.#pauseRequestId) {
      this.#pauseAcknowledgement?.resolve(message as WorkerPausedMessage)
      return
    }
    if (message.generation !== this.generation || !validRequestId(message.requestId, this.#requestId)) {
      if (isComplete(message)) void this.#discard(message.result.publishedPath)
      return
    }
    if (this.#terminal || this.#stopping) {
      if (isComplete(message)) void this.#discard(message.result.publishedPath)
      return
    }
    if (message.type === 'checkpoint' && isCheckpoint(message.checkpoint)) {
      this.#latestCheckpoint = message.checkpoint
      void this.diagnostics?.setCheckpoint(this.generation, message.checkpoint)
    } else if (message.type === 'native-addon-status' && isNativeAddonStatus(message.status)) {
      this.#nativeAddonStatus = message.status
      void this.diagnostics?.setNativeAddonStatus(this.generation, message.status)
    } else if (message.type === 'progress' && message.progress) {
      this.#latestResumePreparation = RESUME_PREPARATION_PHASES.length
      void this.diagnostics?.setStage(this.generation, message.progress.stage)
      this.#updates.push({ type: 'progress', progress: message.progress })
    } else if (message.type === 'resume-preparation' && message.requestId === this.#requestId && this.request.resumeExpected === true && isResumePreparationPhase(message.phase)) {
      void this.diagnostics?.setStage(this.generation, message.phase)
      const phase = RESUME_PREPARATION_PHASES.indexOf(message.phase)
      if (phase > this.#latestResumePreparation) {
        this.#latestResumePreparation = phase
        this.#updates.push({ type: 'resume-preparation', phase: message.phase })
      }
    } else if (message.type === 'resume-milestone' && isResumeMilestone(message.milestone)) {
      this.#updates.push({ type: 'resume-milestone', milestone: message.milestone })
    } else if (message.type === 'preview' && message.preview) {
      if (message.preview.revision >= this.#latestPreviewRevision) {
        this.#latestPreviewRevision = message.preview.revision
        this.#updates.push({ type: 'preview', preview: message.preview })
      }
    } else if (message.type === 'focus-accepted' && typeof message.requestId === 'number') {
      const resolve = this.#pendingFocus.get(message.requestId)
      if (resolve) {
        this.#pendingFocus.delete(message.requestId)
        resolve((message as WorkerFocusAcceptedMessage).accepted ? { kind: 'accepted' } : { kind: 'unavailable' })
      }
    } else if (message.type === 'resolved-node' && typeof message.requestId === 'number') {
      const resolve = this.#pendingResolutions.get(message.requestId)
      if (resolve) {
        this.#pendingResolutions.delete(message.requestId)
        const path = (message as WorkerResolvedNodeMessage).path
        resolve(path ? { kind: 'resolved', path } : { kind: 'unavailable' })
      }
    } else if (isComplete(message)) {
      if (message.result.generation !== this.generation || message.result.target !== this.request.target || message.result.publishedPath !== this.request.publishedPath) {
        void this.#discard(message.result.publishedPath)
        this.#fail(new Error('The scan worker returned an invalid publication.'), 'invalid-publication')
      } else void this.#complete({ kind: 'completed', result: message.result, ...(message.refresh ? { refresh: message.refresh } : {}) })
    } else if (message.type === 'unchanged' && message.journal && message.totals && typeof message.basePublicationId === 'string') {
      void this.#clearAndSettle({ kind: 'unchanged', journal: message.journal, totals: message.totals, basePublicationId: message.basePublicationId })
    } else if (message.type === 'canceled') {
      void this.#clearAndSettle({ kind: 'canceled' })
    } else if (message.type === 'error' && message.error && typeof message.error.message === 'string') {
      this.#fail(Object.assign(new Error(message.error.message), message.error.code ? { code: message.error.code } : {}))
    }
  }

  #fail(error: unknown, kind: ScanFailureKind = 'worker-error', exitCode?: number): void {
    if (this.#terminal || this.#stopping || this.#failureInProgress) return
    this.#failureInProgress = true
    const failure = error instanceof Error ? error : new Error(String(error))
    void Promise.resolve(this.diagnostics?.recordFailure({ generation: this.generation, kind, code: errorCode(failure), exitCode,
      ...(this.#latestCheckpoint ? { latestCheckpoint: this.#latestCheckpoint } : {}),
      ...(this.#nativeAddonStatus ? { nativeAddon: this.#nativeAddonStatus } : {}) })).catch(() => undefined)
    this.#settle({ kind: 'failed', error: failure })
    this.#stopPromise ??= this.#stopAfterFailure()
    this.#failurePromise = Promise.resolve()
  }

  #complete(outcome: Extract<ScanOutcome, { readonly kind: 'completed' }>): void {
    void Promise.resolve(this.diagnostics?.clearActive(this.generation)).catch(() => undefined)
    this.#settle(outcome)
  }

  #clearAndSettle(outcome: ScanOutcome): void {
    void Promise.resolve(this.diagnostics?.clearActive(this.generation)).catch(() => undefined)
    this.#settle(outcome)
  }

  async #stopAfterFailure(): Promise<void> {
    this.#stopping = true
    const requestId = ++this.#requestId
    this.#pauseRequestId = requestId
    this.#pauseAcknowledgement = deferred<WorkerPausedMessage>()
    try { this.worker.postMessage({ type: 'pause', generation: this.generation, requestId } satisfies WorkerMessage) } catch { /* The worker may already have stopped. */ }
    await Promise.race([this.#pauseAcknowledgement.promise.then(() => undefined), delay(this.pauseTimeoutMs)])
    await this.#terminate()
  }

  #settle(outcome: ScanOutcome): void {
    if (this.#terminal) return
    this.#terminal = true
    this.#updates.close()
    for (const resolve of this.#pendingFocus.values()) resolve({ kind: 'unavailable' })
    for (const resolve of this.#pendingResolutions.values()) resolve({ kind: 'unavailable' })
    this.#pendingFocus.clear()
    this.#pendingResolutions.clear()
    this.#outcome.resolve(outcome)
    this.onSettled()
  }

  async #discard(path: string): Promise<void> {
    try { await this.discardStaleCandidate(path, this.request.indexDirectory) } catch { /* Cleanup retries during controller shutdown. */ }
  }

  async #terminate(): Promise<void> {
    if (this.#terminated) return
    this.#terminated = true
    try { await Promise.resolve(this.worker.terminate()) } catch { /* Termination is best effort after a terminal outcome. */ }
  }
}

class FailedScanSession implements ScanSession {
  readonly events: AsyncIterable<ScanUpdate> = {
    async *[Symbol.asyncIterator](): AsyncIterator<ScanUpdate> { return }
  }
  readonly result: Promise<ScanOutcome>
  constructor(error: unknown) {
    this.result = Promise.resolve({ kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) })
  }
  focus(_nodeId: string): Promise<FocusOutcome> { return Promise.resolve({ kind: 'unavailable' }) }
  resolveNode(_nodeId: string): Promise<ResolveNodeOutcome> { return Promise.resolve({ kind: 'unavailable' }) }
  pause(): Promise<ScanOutcome> { return this.result }
}

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #values: T[] = []
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false;

  [Symbol.asyncIterator](): AsyncIterator<T> { return this }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.#closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  push(value: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ done: false, value })
    else this.#values.push(value)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
  }
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
function isResumeMilestone(value: unknown): value is ResumeMilestone {
  return value === 'preparation-started' || value === 'first-metadata-page' || value === 'first-metadata-preview'
}
function validRequestId(value: unknown, latest: number): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= latest }
function isComplete(value: Partial<WorkerResultMessage>): value is WorkerCompleteMessage { return value.type === 'complete' && !!value.result }
function resolveDiagnostics(provider: DiagnosticsProvider | undefined): ScanFailureDiagnosticsStore | undefined {
  try { return typeof provider === 'function' ? provider() : provider } catch { return undefined }
}
function errorCode(error: unknown): string | undefined {
  const value = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : undefined
}
function isCheckpoint(value: unknown): value is ConstructionCheckpointNotice {
  if (!value || typeof value !== 'object') return false
  const checkpoint = value as Partial<ConstructionCheckpointNotice>
  return typeof checkpoint.sequence === 'number' && Number.isSafeInteger(checkpoint.sequence) && checkpoint.sequence >= 0
    && typeof checkpoint.count === 'number' && Number.isSafeInteger(checkpoint.count) && checkpoint.count >= 0
    && typeof checkpoint.reason === 'string' && typeof checkpoint.phase === 'string'
}
function isNativeAddonStatus(value: unknown): value is NativeAddonStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as Partial<NativeAddonStatus>
  return (status.loadStatus === 'not-requested' || status.loadStatus === 'loaded' || status.loadStatus === 'load-failed' || status.loadStatus === 'unknown')
    && (status.journalCapability === 'unknown' || status.journalCapability === 'available' || status.journalCapability === 'missing' || status.journalCapability === 'disabled')
    && (status.metadataCapability === 'unknown' || status.metadataCapability === 'available' || status.metadataCapability === 'missing' || status.metadataCapability === 'disabled')
}

async function discardStaleCandidate(path: string, indexDirectory: string): Promise<void> {
  await new PublicationArtifacts(indexDirectory).discardUnreferencedDatabase(path)
}
