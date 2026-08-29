import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  ScanRunLifecycle,
  type CompletedOutcome,
  type CompletedPublicationResult,
  type ScanLifecycleDependencies,
  type ScanLifecycleState,
  type ScanLifecycleTransition,
  type ScanRunContext,
  type ScanStartGuards,
  type UnchangedOutcome,
  type UnchangedPublicationResult
} from "../src/main/scan-run-lifecycle"
import type { FullScanResumeDescriptor, FullScanResumeLoad, FullScanResumePeek, ResumeValidationReceipt } from "../src/main/full-scan-resume"
import { RESUME_PREPARATION_MESSAGES, createControllerTimingMilestones } from "../src/main/diagnostics"
import type { PendingScanRecord } from "../src/main/location-catalog"
import type { FocusOutcome, ResolveNodeOutcome, ScanExecution, ScanExecutionRequest, ScanOutcome, ScanSession, ScanUpdate } from "../src/main/scan-execution"
import type { ProgressivePreview, ScanResult, ScanTotals } from "../src/main/scanner"
import type { Breadcrumb, ChartSegment, LocationId, NodeSummary, ProgressSnapshot } from "../src/shared/contracts"

const TARGET = "/target"
const OWNER: LocationId = "loc-owner" as LocationId
const TOTALS: ScanTotals = { scannedItems: 3, discoveredBytes: 8, elapsedMs: 5, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 }

type ConstructionLoad = Extract<FullScanResumeLoad, { readonly kind: "construction" }>

class TestAsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
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
  push(value: T): void { const waiter = this.#waiters.shift(); if (waiter) waiter({ done: false, value }); else this.#values.push(value) }
  close(): void { this.#closed = true; for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined }) }
}

function testDeferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: Error) => void
  return {
    promise: new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise }),
    resolve: (value) => resolve(value),
    reject: (error) => reject(error)
  }
}

class FakeLifecycleSession implements ScanSession {
  readonly #updates = new TestAsyncQueue<ScanUpdate>()
  readonly #outcome = testDeferred<ScanOutcome>()
  readonly #resolveNodeOutcome = testDeferred<ResolveNodeOutcome>()
  readonly events: AsyncIterable<ScanUpdate> = this.#updates
  readonly result = this.#outcome.promise
  request: ScanExecutionRequest | undefined
  terminated = false
  settled = false
  focusRequests: string[] = []
  resolveNodeRequests: string[] = []

  begin(request: ScanExecutionRequest): void { this.request = request }

  update(update: ScanUpdate): void { this.#updates.push(update) }

  complete(result: ScanResult): void { this.#settle({ kind: "completed", result }) }

  unchanged(outcome: Omit<Extract<ScanOutcome, { kind: "unchanged" }>, "kind">): void { this.#settle({ kind: "unchanged", ...outcome }) }

  fail(error: Error): void { this.#settle({ kind: "failed", error }) }

  settleWith(outcome: ScanOutcome): void { this.#settle(outcome) }

  focus(nodeId: string): Promise<FocusOutcome> {
    this.focusRequests.push(nodeId)
    return Promise.resolve({ kind: "accepted" })
  }

  resolveNode(nodeId: string): Promise<ResolveNodeOutcome> {
    this.resolveNodeRequests.push(nodeId)
    return this.#resolveNodeOutcome.promise
  }

  resolveNodeWith(outcome: ResolveNodeOutcome): void { this.#resolveNodeOutcome.resolve(outcome) }

  pause(): Promise<ScanOutcome> {
    this.terminated = true
    if (!this.settled) this.#settle({ kind: "paused", acknowledged: true, checkpointSequence: 1 })
    return this.result
  }

  #settle(outcome: ScanOutcome): void {
    if (this.settled) return
    this.settled = true
    this.#updates.close()
    this.#outcome.resolve(outcome)
  }
}

/** A session whose pause() cannot settle it, so late updates and outcomes stay reachable. */
class StubbornSession extends FakeLifecycleSession {
  pause(): Promise<ScanOutcome> {
    this.terminated = true
    return Promise.resolve({ kind: "canceled" })
  }
}

class FakeLifecycleExecution implements ScanExecution {
  active: FakeLifecycleSession | undefined
  closed = false
  constructor(readonly createSession: () => FakeLifecycleSession, readonly onEvent: (event: string) => void) {}

  async start(request: ScanExecutionRequest): Promise<ScanSession> {
    this.onEvent("execution:start")
    if (this.active && !this.active.settled) await this.active.pause()
    const session = this.createSession()
    session.begin(request)
    this.active = session
    return session
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.active && !this.active.settled) await this.active.pause()
  }
}

class ExplodingExecution implements ScanExecution {
  active: FakeLifecycleSession | undefined
  closed = false
  request: ScanExecutionRequest | undefined
  async start(request: ScanExecutionRequest): Promise<ScanSession> {
    this.request = request
    throw new Error("worker exploded")
  }
  async close(): Promise<void> { this.closed = true }
}

type HarnessExecution = FakeLifecycleExecution | ExplodingExecution

function makeDescriptor(target: string, scanId = "d1234567-89ab-4cde-8fab-0123456789ab"): FullScanResumeDescriptor {
  return {
    version: 1, scanId, partialFile: `index-${scanId}.partial.sqlite`, candidateFile: `index-${scanId}.sqlite`,
    target, targetDevice: "1", targetInode: "2", indexDirectoryIdentity: "1:2", startupRoot: false,
    schemaVersion: 1, constructionSchemaVersion: 3, accountingVersion: "v2", exclusionPolicyVersion: "v1",
    hardLinkOrderingVersion: "utf8", journalDevice: "1", journalUuid: "journal", journalBaseline: "0",
    createdAt: "2026-01-01T00:00:00.000Z"
  }
}

function makeReceipt(scanId: string, source: "acknowledged-pause" | "full-validation" = "full-validation"): ResumeValidationReceipt {
  return {
    version: 1, kind: "construction", scanId, descriptorDigest: "a".repeat(64), drainedThrough: "checkpoint",
    database: { file: "partial", device: "1", inode: "2", size: 8, modifiedNs: "1", changedNs: "2" }, source
  }
}

function makeConstructionLoad(target: string, options: { readonly scanId?: string; readonly receipt?: ResumeValidationReceipt } = {}): ConstructionLoad {
  const scanId = options.scanId ?? "d1234567-89ab-4cde-8fab-0123456789ab"
  return {
    kind: "construction", descriptor: makeDescriptor(target, scanId),
    partialPath: `/indexes/index-${scanId}.partial.sqlite`, candidatePath: `/indexes/index-${scanId}.sqlite`,
    checkpointSequence: 4, checkpointedAt: "2026-01-01T00:00:00.000Z", drainedThrough: "checkpoint",
    receipt: options.receipt ?? makeReceipt(scanId)
  }
}

function makePreview(generation: number, revision: number, focusId = "n-root"): ProgressivePreview {
  const root: NodeSummary = { id: focusId, parentId: null, name: "target", kind: "directory", sizeBytes: 10, directChildren: 1, descendantCount: 2, unreadableCount: 0, scanState: "queued", sizeAccuracy: "partial" }
  const file: NodeSummary = { id: "n-file", parentId: "n-root", name: "file.txt", kind: "file", sizeBytes: 8, directChildren: 0, descendantCount: 1, unreadableCount: 0, scanState: "complete", sizeAccuracy: "partial" }
  const breadcrumbs: readonly Breadcrumb[] = [{ id: focusId, name: "target" }]
  const chart: readonly ChartSegment[] = [{ id: "n-file", name: "file.txt", kind: "file", depth: 1, startAngle: 0, endAngle: 6, sizeBytes: 8, percentage: 0.8, drillable: false, colorKey: "file", scanState: "complete", sizeAccuracy: "partial" }]
  return {
    generation, revision, committed: false, target: { name: "target", isStartup: false }, focus: root,
    breadcrumbs, chart, largestItems: [root, file],
    volume: { capacityBytes: 100, freeBytes: 50, scannedBytes: 10, unscannedBytes: 0, sizeAccuracy: "partial" }
  }
}

function makeProgress(stage: "resuming" | "traversing" | "indexing" = "traversing"): ProgressSnapshot {
  return { stage, scannedItems: 2, discoveredBytes: 4, elapsedMs: 1, currentItem: "target" }
}

function makeScanResult(publishedPath: string): ScanResult {
  return { generation: 1, target: TARGET, rootId: "n-root", publishedPath, capacityBytes: 100, freeBytes: 50, scannedBytes: 10, totals: TOTALS }
}

interface Harness {
  readonly lifecycle: ScanRunLifecycle
  readonly execution: HarnessExecution
  readonly indexDirectory: string
  readonly transitions: ScanLifecycleTransition[]
  readonly events: string[]
  readonly calls: {
    readonly beginScan: Array<{ record: PendingScanRecord; previousScanId: string | undefined; guards: ScanStartGuards }>
    readonly discarded: string[]
    readonly clearPendingScan: string[]
    readonly resumeDiscard: Array<string | undefined>
    readonly resumeLoad: Array<string | undefined>
    readonly resumeCheckpointLoad: Array<{ target: string; sequence: number }>
    readonly resumeRemoveDescriptor: number
    readonly publishCompleted: Array<{ run: ScanRunContext; outcome: CompletedOutcome }>
    readonly publishUnchanged: Array<{ run: ScanRunContext; outcome: UnchangedOutcome }>
    readonly validated: Array<{ path: string; target: string }>
  }
  readonly config: {
    peek: FullScanResumePeek
    peekError: Error | undefined
    load: FullScanResumeLoad
    loadGate: Promise<void> | undefined
    checkpointLoad: FullScanResumeLoad | undefined
    constructionPreview: ProgressivePreview | undefined
    constructionPath: string | undefined
    beginScanError: Error | undefined
    prepareError: Error | undefined
    prepareGate: Promise<void> | undefined
    prepareEntered: Promise<void>
    publishCompleted: ((run: ScanRunContext, outcome: CompletedOutcome) => Promise<CompletedPublicationResult>) | undefined
    publishUnchanged: ((run: ScanRunContext, outcome: UnchangedOutcome) => Promise<UnchangedPublicationResult>) | undefined
    validateRevealPathGate: Promise<void> | undefined
    pendingScanId: string | undefined
  }
}

interface HarnessOptions {
  readonly createSession?: () => FakeLifecycleSession
  readonly execution?: ScanExecution
}

const harnessDirectories: string[] = []

function createHarness(initialTarget = TARGET, options: HarnessOptions = {}): Harness {
  const events: string[] = []
  const transitions: ScanLifecycleTransition[] = []
  const execution = new FakeLifecycleExecution(options.createSession ?? (() => new FakeLifecycleSession()), (event) => { events.push(event) })
  const calls = {
    beginScan: [] as Harness["calls"]["beginScan"],
    discarded: [] as string[],
    clearPendingScan: [] as string[],
    resumeDiscard: [] as Array<string | undefined>,
    resumeLoad: [] as Array<string | undefined>,
    resumeCheckpointLoad: [] as Array<{ target: string; sequence: number }>,
    resumeRemoveDescriptor: 0,
    publishCompleted: [] as Harness["calls"]["publishCompleted"],
    publishUnchanged: [] as Harness["calls"]["publishUnchanged"],
    validated: [] as Harness["calls"]["validated"]
  }
  const prepareEntered = testDeferred<void>()
  const config: Harness["config"] = {
    peek: { kind: "none" },
    peekError: undefined,
    load: { kind: "none" },
    loadGate: undefined,
    checkpointLoad: undefined,
    constructionPreview: undefined,
    constructionPath: undefined,
    beginScanError: undefined,
    prepareError: undefined,
    prepareGate: undefined,
    prepareEntered: prepareEntered.promise,
    publishCompleted: undefined,
    publishUnchanged: undefined,
    validateRevealPathGate: undefined,
    pendingScanId: undefined
  }
  let publicationIdCounter = 0
  const indexDirectory = join(tmpdir(), `orbis-lifecycle-${Math.random().toString(36).slice(2)}`)
  harnessDirectories.push(indexDirectory)
  const deps: ScanLifecycleDependencies = {
    indexDirectory,
    scanExecution: options.execution ?? execution,
    resume: {
      peek: async () => {
        events.push("resume:peek")
        if (config.peekError) throw config.peekError
        return config.peek
      },
      load: async (expectedTarget) => {
        events.push("resume:load")
        calls.resumeLoad.push(expectedTarget)
        if (config.loadGate) await config.loadGate
        return config.load
      },
      loadAcknowledgedCheckpoint: async (expectedTarget, checkpointSequence) => {
        events.push("resume:checkpoint")
        calls.resumeCheckpointLoad.push({ target: expectedTarget, sequence: checkpointSequence })
        return config.checkpointLoad ?? config.load
      },
      discard: async (expectedScanId) => {
        calls.resumeDiscard.push(expectedScanId)
        return true
      },
      removeDescriptor: async () => { calls.resumeRemoveDescriptor += 1 }
    },
    ensureInitialized: async () => { events.push("initialized") },
    prepareStartContext: async () => {
      events.push("prepare")
      prepareEntered.resolve(undefined)
      if (config.prepareGate) await config.prepareGate
      if (config.prepareError) throw config.prepareError
      return {
        identity: { targetDevice: "1", targetInode: "2" }, ownerId: OWNER, basePublicationId: null,
        initialEstimate: undefined, active: undefined, guards: { expectedRevision: 7, selectedLocationId: OWNER }
      }
    },
    createPublicationId: () => {
      publicationIdCounter += 1
      return `00000000-0000-4000-8000-${String(publicationIdCounter).padStart(12, "0")}`
    },
    runPaths: (publicationId) => ({
      partialPath: join(indexDirectory, `index-${publicationId}.partial.sqlite`),
      publishedPath: join(indexDirectory, `index-${publicationId}.sqlite`)
    }),
    beginScan: async (record, previousScanId, guards) => {
      events.push("beginScan")
      calls.beginScan.push({ record, previousScanId, guards })
      if (config.beginScanError) throw config.beginScanError
    },
    publishCompleted: async (run, outcome) => {
      events.push("publish:completed")
      calls.publishCompleted.push({ run, outcome })
      if (config.publishCompleted) return config.publishCompleted(run, outcome)
      return { kind: "published", totals: TOTALS, activeTarget: run.target, warnings: [] }
    },
    publishUnchanged: async (run, outcome) => {
      events.push("publish:unchanged")
      calls.publishUnchanged.push({ run, outcome })
      if (config.publishUnchanged) return config.publishUnchanged(run, outcome)
      return { kind: "published", totals: TOTALS, activeTarget: run.target, warnings: [] }
    },
    clearPendingScan: async (scanId) => { calls.clearPendingScan.push(scanId) },
    discardUnreferencedDatabase: async (path) => { calls.discarded.push(path) },
    pendingScanId: () => config.pendingScanId,
    readConstructionPreview: async (_load, generation, focusId) => {
      const base = config.constructionPreview
      if (!base) return undefined
      if (focusId === undefined || base.focus.id === focusId) return { ...base, generation }
      const item = base.largestItems.find((node) => node.id === focusId)
      return item ? { ...base, generation, focus: item } : undefined
    },
    resolveConstructionNodePath: async () => config.constructionPath,
    validateRevealPath: async (path, target) => {
      calls.validated.push({ path, target })
      if (config.validateRevealPathGate) await config.validateRevealPathGate
      return path
    },
    createMilestones: () => createControllerTimingMilestones()
  }
  const lifecycle = new ScanRunLifecycle(deps, initialTarget)
  lifecycle.subscribe((transition) => {
    transitions.push(transition)
    events.push(`transition:${transition.kind}`)
  })
  return { lifecycle, execution, indexDirectory, transitions, events, calls, config }
}

async function startScan(harness: Harness, target = TARGET): Promise<{ readonly state: ScanLifecycleState; readonly session: FakeLifecycleSession }> {
  const state = await harness.lifecycle.startScan({ target })
  const session = (harness.execution as FakeLifecycleExecution).active!
  return { state, session }
}

async function waitFor(predicate: () => boolean, rounds = 200): Promise<void> {
  for (let attempt = 0; attempt < rounds && !predicate(); attempt += 1) await new Promise((resolve) => setImmediate(resolve))
  expect(predicate(), "Timed out waiting for the lifecycle state").toBe(true)
}

afterEach(async () => {
  while (harnessDirectories.length > 0) {
    const directory = harnessDirectories.pop()!
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("ScanRunLifecycle", () => {
  it("sends one started transition with resuming progress before the session starts", async () => {
    const harness = createHarness()
    const load = makeConstructionLoad(TARGET)
    harness.config.peek = { kind: "construction", descriptor: load.descriptor }
    const state = await harness.lifecycle.startScan({ target: TARGET })
    expect(state.scanStatus).toMatchObject({ status: "scanning", generation: 1, progress: { stage: "resuming" } })
    expect(state.scanStatus.progress).toEqual({
      stage: "resuming", scannedItems: 0, discoveredBytes: 0, elapsedMs: 0,
      currentItem: RESUME_PREPARATION_MESSAGES.validating
    })
    expect(harness.transitions).toHaveLength(1)
    expect(harness.transitions[0]).toMatchObject({ kind: "started", generation: 1 })
    expect(harness.transitions[0]!.state.scanStatus.progress?.currentItem).toBe(RESUME_PREPARATION_MESSAGES.validating)
    // The notification crossed before the deferred scanExecution.start callback ran.
    expect(harness.events.indexOf("transition:started")).toBeLessThan(harness.events.indexOf("execution:start"))
    await harness.lifecycle.seal()
  })

  it("serializes the start preparation order and stops the previous run", async () => {
    const harness = createHarness()
    const first = await startScan(harness)
    const second = await startScan(harness)
    expect(second.state.scanStatus.generation).toBe(2)
    expect(first.session.terminated).toBe(true)
    const beginCalls = harness.calls.beginScan
    expect(beginCalls).toHaveLength(2)
    expect(beginCalls[0]!.previousScanId).toBeUndefined()
    expect(beginCalls[1]!.previousScanId).toBe(beginCalls[0]!.record.scanId)
    for (const call of beginCalls) {
      expect(call.record).toMatchObject({ target: TARGET, targetDevice: "1", targetInode: "2", basePublicationId: null })
      expect(call.guards).toEqual({ expectedRevision: 7, selectedLocationId: "loc-owner" })
    }
    expect(harness.events).toEqual([
      "initialized", "resume:peek", "prepare", "beginScan", "transition:started", "execution:start",
      "initialized", "resume:checkpoint", "prepare", "beginScan", "transition:started", "execution:start"
    ])
    await harness.lifecycle.seal()
  })

  it("rejects a start for another target while a run is active", async () => {
    const harness = createHarness()
    await startScan(harness)
    await expect(harness.lifecycle.startScan({ target: "/other" })).rejects.toThrow("Pause and discard the saved scan before choosing another folder")
    await harness.lifecycle.seal()
  })

  it("releases the queue and leaves a defined state when preparation steps fail", async () => {
    const harness = createHarness()
    harness.config.peekError = new Error("peek failed")
    await expect(harness.lifecycle.startScan({ target: TARGET })).rejects.toThrow("peek failed")
    expect(harness.lifecycle.state.scanStatus).toMatchObject({ status: "idle", generation: 0 })
    expect(harness.lifecycle.state.run).toBeUndefined()

    harness.config.peekError = undefined
    harness.config.beginScanError = new Error("catalog rejected")
    await expect(harness.lifecycle.startScan({ target: TARGET })).rejects.toThrow("catalog rejected")
    expect(harness.lifecycle.state.scanStatus.status).toBe("idle")
    // Failed starts consume a generation but produce no transition.
    expect(harness.transitions).toHaveLength(0)
    expect(harness.events).not.toContain("execution:start")

    harness.config.beginScanError = undefined
    const next = await startScan(harness)
    expect(next.state.scanStatus).toMatchObject({ status: "scanning", generation: 3 })
    expect(harness.transitions.map((transition) => transition.kind)).toEqual(["started"])
    await harness.lifecycle.seal()
  })

  it("fails the run and cleans up when worker startup throws", async () => {
    const exploding = new ExplodingExecution()
    const harness = createHarness(TARGET, { execution: exploding })
    await harness.lifecycle.startScan({ target: TARGET })
    await waitFor(() => harness.lifecycle.state.scanStatus.status === "fatal-error")
    expect(harness.lifecycle.state.scanStatus).toMatchObject({ status: "fatal-error", generation: 1, error: "worker exploded" })
    await waitFor(() => harness.transitions.some((transition) => transition.kind === "failed"))
    // The failure cleanup retires the catalog record and both run paths.
    expect(harness.calls.clearPendingScan).toEqual([harness.calls.beginScan[0]!.record.scanId])
    expect(harness.calls.discarded).toEqual(expect.arrayContaining([
      join(harness.indexDirectory, `index-${harness.calls.beginScan[0]!.record.scanId}.partial.sqlite`),
      join(harness.indexDirectory, `index-${harness.calls.beginScan[0]!.record.scanId}.sqlite`)
    ]))
    await harness.lifecycle.seal()
  })

  it("discards a superseded run's updates, outcomes, and uncommitted candidates", async () => {
    let stubborn: StubbornSession | undefined
    const harness = createHarness(TARGET, {
      createSession: () => {
        if (stubborn) return new FakeLifecycleSession()
        stubborn = new StubbornSession()
        return stubborn
      }
    })
    const first = await startScan(harness)
    const firstScanId = harness.calls.beginScan[0]!.record.scanId
    const second = await startScan(harness)
    expect(second.state.scanStatus.generation).toBe(2)
    expect(second.state.run?.target).toBe(TARGET)
    const transitionCount = harness.transitions.length
    // Updates and outcomes of the stopped run cannot touch the newer run's state.
    stubborn!.update({ type: "progress", progress: makeProgress() })
    stubborn!.update({ type: "preview", preview: makePreview(1, 5) })
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.lifecycle.state.preview).toBeUndefined()
    expect(harness.lifecycle.state.scanStatus.progress).toBeNull()
    const staleCandidate = `/indexes/index-${firstScanId}.sqlite`
    stubborn!.complete(makeScanResult(staleCandidate))
    await waitFor(() => harness.calls.discarded.includes(staleCandidate))
    expect(harness.transitions.length).toBe(transitionCount)
    expect(harness.calls.publishCompleted).toHaveLength(0)
    void first
    await harness.lifecycle.seal()
  })

  it("discards the candidate of an outcome that arrives after its run was stopped", async () => {
    let stubborn: StubbornSession | undefined
    const harness = createHarness(TARGET, {
      createSession: () => {
        if (stubborn) return new FakeLifecycleSession()
        stubborn = new StubbornSession()
        return stubborn
      }
    })
    await startScan(harness)
    const state = await harness.lifecycle.pauseScan()
    // The stubborn stop has no checkpoint proof, so no resume may be claimed.
    expect(state.resume).toBeUndefined()
    expect(state.scanStatus).toMatchObject({ status: "canceled", generation: 1 })
    const lateCandidate = "/indexes/index-late.sqlite"
    stubborn!.complete(makeScanResult(lateCandidate))
    await waitFor(() => harness.calls.discarded.includes(lateCandidate))
    expect(harness.calls.publishCompleted).toHaveLength(0)
    expect(harness.lifecycle.state.scanStatus.status).toBe("canceled")
    expect(harness.transitions.filter((transition) => transition.kind === "paused")).toHaveLength(1)
    await harness.lifecycle.seal()
  })

  it("consumes the resume receipt once per generation", async () => {
    const harness = createHarness()
    const firstLoad = makeConstructionLoad(TARGET, { receipt: makeReceipt("d1234567-89ab-4cde-8fab-0123456789ab", "full-validation") })
    await harness.lifecycle.adoptStartupState({ saved: firstLoad, selectedTarget: TARGET })
    harness.config.peek = { kind: "construction", descriptor: firstLoad.descriptor }
    const first = await startScan(harness)
    expect(first.session.request?.resumeExpected).toBe(true)
    expect(first.session.request?.resumeReceipt?.source).toBe("full-validation")

    const secondReceipt = makeReceipt("d1234567-89ab-4cde-8fab-0123456789ab", "acknowledged-pause")
    harness.config.checkpointLoad = makeConstructionLoad(TARGET, { receipt: secondReceipt })
    harness.config.constructionPreview = makePreview(2, 1)
    await harness.lifecycle.pauseScan()
    const second = await startScan(harness)
    expect(second.session.request?.resumeExpected).toBe(true)
    expect(second.session.request?.resumeReceipt?.source).toBe("acknowledged-pause")
    // A receipt is single-use: the first generation's receipt never survives.
    expect(second.session.request?.resumeReceipt).not.toBe(first.session.request?.resumeReceipt)
    await harness.lifecycle.seal()
  })

  it("discards resume state when incremental scan is disabled", async () => {
    const harness = createHarness()
    const load = makeConstructionLoad(TARGET)
    harness.config.peek = { kind: "construction", descriptor: load.descriptor }
    const previous = process.env.ORBIS_DISABLE_INCREMENTAL_SCAN
    process.env.ORBIS_DISABLE_INCREMENTAL_SCAN = "1"
    try {
      const started = await startScan(harness)
      expect(harness.calls.resumeDiscard).toEqual([load.descriptor.scanId])
      expect(started.session.request?.resumeExpected).toBe(false)
      expect(started.session.request?.resumeReceipt).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.ORBIS_DISABLE_INCREMENTAL_SCAN
      else process.env.ORBIS_DISABLE_INCREMENTAL_SCAN = previous
    }
    await harness.lifecycle.seal()
  })

  it("gates preview updates by generation and revision", async () => {
    const harness = createHarness()
    const { session } = await startScan(harness)
    session.update({ type: "preview", preview: makePreview(99, 1) })
    session.update({ type: "preview", preview: makePreview(1, 1) })
    await waitFor(() => harness.transitions.some((transition) => transition.kind === "preview"))
    expect(harness.transitions.filter((transition) => transition.kind === "preview")).toHaveLength(1)
    session.update({ type: "preview", preview: makePreview(1, 0) })
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.transitions.filter((transition) => transition.kind === "preview")).toHaveLength(1)
    session.update({ type: "preview", preview: makePreview(1, 2) })
    await waitFor(() => harness.transitions.filter((transition) => transition.kind === "preview").length === 2)
    expect(harness.lifecycle.state.preview).toMatchObject({ revision: 2 })
    await harness.lifecycle.seal()
  })

  it("relays resume preparation phases through one progress transition each", async () => {
    const harness = createHarness()
    const load = makeConstructionLoad(TARGET)
    harness.config.peek = { kind: "construction", descriptor: load.descriptor }
    const { session } = await startScan(harness)
    session.update({ type: "resume-preparation", phase: "history" })
    await waitFor(() => harness.lifecycle.state.scanStatus.progress?.currentItem === RESUME_PREPARATION_MESSAGES.history)
    session.update({ type: "resume-preparation", phase: "starting" })
    await waitFor(() => harness.lifecycle.state.scanStatus.progress?.currentItem === RESUME_PREPARATION_MESSAGES.starting)
    const progressTransitions = harness.transitions.filter((transition) => transition.kind === "progress")
    expect(progressTransitions).toHaveLength(2)
    expect(progressTransitions.every((transition) => transition.generation === 1)).toBe(true)
    // Milestone markers are diagnostics only and never notify.
    session.update({ type: "resume-milestone", milestone: "first-metadata-page" })
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.transitions.filter((transition) => transition.kind === "progress")).toHaveLength(2)
    await harness.lifecycle.seal()
  })

  it("pauses through the acknowledged checkpoint load and adopts the saved construction", async () => {
    const harness = createHarness()
    const { session } = await startScan(harness)
    const checkpointLoad = makeConstructionLoad(TARGET)
    harness.config.checkpointLoad = checkpointLoad
    harness.config.constructionPreview = makePreview(1, 3)
    const state = await harness.lifecycle.pauseScan()
    expect(harness.calls.resumeCheckpointLoad).toEqual([{ target: TARGET, sequence: 1 }])
    expect(state.scanStatus).toMatchObject({ status: "canceled", generation: 1 })
    expect(state.resume).toEqual({ available: true, checkpointedAt: checkpointLoad.checkpointedAt })
    expect(state.preview).toMatchObject({ generation: 1, revision: 3 })
    expect(harness.transitions).toEqual([
      { kind: "started", generation: 1, state: expect.anything() },
      { kind: "paused", generation: 1, state: expect.anything() }
    ])
    void session
    await harness.lifecycle.seal()
  })

  it("falls back to the authoritative load when a pause is not acknowledged", async () => {
    const harness = createHarness()
    const { session } = await startScan(harness)
    harness.config.load = makeConstructionLoad(TARGET)
    session.settleWith({ kind: "paused", acknowledged: false })
    await waitFor(() => harness.calls.resumeLoad.length === 1)
    expect(harness.calls.resumeCheckpointLoad).toHaveLength(0)
    const state = await harness.lifecycle.pauseScan()
    expect(state.scanStatus.status).toBe("canceled")
    expect(state.resume?.available).toBe(true)
    expect(harness.transitions.filter((transition) => transition.kind === "paused")).toHaveLength(1)
    await harness.lifecycle.seal()
  })

  it("serializes pause behind an in-flight start preparation", async () => {
    const harness = createHarness()
    const gate = testDeferred<void>()
    harness.config.prepareGate = gate.promise
    const starting = harness.lifecycle.startScan({ target: TARGET })
    const pausing = harness.lifecycle.pauseScan()
    gate.resolve()
    await starting
    const state = await pausing
    // The pause cannot return leaving the just-started run active: it ran
    // after registration and stopped the run.
    expect(state.run).toBeUndefined()
    expect(state.scanStatus).toMatchObject({ status: "canceled", generation: 1 })
    expect((harness.execution as FakeLifecycleExecution).active?.terminated).toBe(true)
    expect(harness.transitions.map((transition) => transition.kind)).toEqual(["started", "paused"])
    await harness.lifecycle.seal()
  })

  it("restores the durable preview and construction when a run fails", async () => {
    const harness = createHarness()
    const load = makeConstructionLoad(TARGET)
    harness.config.constructionPreview = makePreview(1, 2)
    await harness.lifecycle.adoptStartupState({ saved: load, selectedTarget: TARGET })
    harness.config.peek = { kind: "construction", descriptor: load.descriptor }
    harness.config.load = load
    const { session } = await startScan(harness)
    session.fail(new Error("worker failed"))
    await waitFor(() => harness.lifecycle.state.scanStatus.status === "canceled")
    const state = harness.lifecycle.state
    // The failed run falls back to the durable preview at its own generation.
    expect(state.preview).toMatchObject({ generation: 1, revision: 2 })
    expect(state.resume).toMatchObject({ available: true })
    expect(state.scanStatus).toMatchObject({ status: "canceled", generation: 1, error: null })
    expect(harness.transitions.filter((transition) => transition.kind === "failed")).toHaveLength(1)
    await harness.lifecycle.seal()
  })

  it("dispatches completion through the injected operation and applies the result once", async () => {
    const harness = createHarness()
    const { session } = await startScan(harness)
    session.complete(makeScanResult("/indexes/index-new.sqlite"))
    await waitFor(() => harness.transitions.some((transition) => transition.kind === "completed"))
    expect(harness.calls.publishCompleted).toHaveLength(1)
    expect(harness.calls.publishCompleted[0]!.run).toMatchObject({
      generation: 1, locationId: "loc-owner", target: TARGET, basePublicationId: null
    })
    const state = harness.lifecycle.state
    expect(state.scanStatus).toMatchObject({ status: "completed", generation: 1, totals: TOTALS, error: null })
    expect(state.run).toBeUndefined()
    expect(state.resume).toBeUndefined()
    expect(state.preview).toBeUndefined()
    expect(harness.transitions.filter((transition) => transition.kind === "completed")).toHaveLength(1)
    await harness.lifecycle.seal()
  })

  it("waits for a pending publication before starting the next run", async () => {
    const harness = createHarness()
    const gate = testDeferred<void>()
    harness.config.publishCompleted = async (run) => {
      await gate.promise
      return { kind: "published", totals: TOTALS, activeTarget: run.target, warnings: [] }
    }
    const { session } = await startScan(harness)
    session.complete(makeScanResult("/indexes/index-a.sqlite"))
    await waitFor(() => harness.calls.publishCompleted.length === 1)
    const second = harness.lifecycle.startScan({ target: TARGET })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    // The start waits behind the previous run's publication before registering.
    expect(harness.lifecycle.state.run?.completed).toBe(true)
    expect(harness.calls.beginScan).toHaveLength(1)
    gate.resolve()
    const state = await second
    expect(state.scanStatus.generation).toBe(2)
    expect(state.run?.target).toBe(TARGET)
    expect(harness.transitions.map((transition) => `${transition.kind}:${transition.generation}`)).toEqual([
      "started:1", "completed:1", "started:2"
    ])
    await harness.lifecycle.seal()
  })

  it("never applies a publication that resolves after seal", async () => {
    const harness = createHarness()
    const gate = testDeferred<void>()
    harness.config.publishCompleted = async (run) => {
      await gate.promise
      return { kind: "published", totals: TOTALS, activeTarget: run.target, warnings: [] }
    }
    const { session } = await startScan(harness)
    session.complete(makeScanResult("/indexes/index-sealed.sqlite"))
    await waitFor(() => harness.calls.publishCompleted.length === 1)
    const sealing = harness.lifecycle.seal()
    gate.resolve()
    await sealing
    expect(harness.transitions.filter((transition) => transition.kind === "completed")).toHaveLength(0)
    expect(harness.lifecycle.state.sealed).toBe(true)
    expect(harness.lifecycle.state.run).toBeUndefined()
  })

  it("fails the run when the publication reports staleness", async () => {
    const harness = createHarness()
    const { session } = await startScan(harness)
    const scanId = harness.calls.beginScan[0]!.record.scanId
    harness.config.publishCompleted = async () => ({ kind: "stale", reason: "stale-install", candidateDisposition: "discarded" })
    session.complete(makeScanResult("/indexes/index-a.sqlite"))
    await waitFor(() => harness.lifecycle.state.scanStatus.status === "fatal-error")
    expect(harness.lifecycle.state.scanStatus.error).toBe("The scan result became stale before publication.")
    await waitFor(() => harness.transitions.some((transition) => transition.kind === "failed"))
    // The failure cleanup retires the catalog record and discards both run paths.
    expect(harness.calls.clearPendingScan).toContain(scanId)
    expect(harness.calls.discarded).toEqual(expect.arrayContaining([
      join(harness.indexDirectory, `index-${scanId}.partial.sqlite`),
      join(harness.indexDirectory, `index-${scanId}.sqlite`)
    ]))
    await harness.lifecycle.seal()
  })

  it("clears the pending scan before failing a completed publication error", async () => {
    const harness = createHarness()
    const { session } = await startScan(harness)
    const scanId = harness.calls.beginScan[0]!.record.scanId
    const loadGate = testDeferred<void>()
    harness.config.loadGate = loadGate.promise
    harness.config.publishCompleted = async () => { throw new Error("install failed") }
    session.complete(makeScanResult("/indexes/index-b.sqlite"))
    await waitFor(() => harness.lifecycle.state.scanStatus.status === "fatal-error")
    // The direct clear happened synchronously, before the failure was observable.
    expect(harness.calls.clearPendingScan).toEqual([scanId])
    expect(harness.lifecycle.state.scanStatus.error).toBe("install failed")
    loadGate.resolve()
    await harness.lifecycle.seal()
  })

  it("fails an unchanged publication error without a direct pending-scan clear", async () => {
    const harness = createHarness()
    const { session } = await startScan(harness)
    const loadGate = testDeferred<void>()
    harness.config.loadGate = loadGate.promise
    harness.config.publishUnchanged = async () => { throw new Error("retirement failed") }
    session.unchanged({ journal: { uuid: "journal", eventId: "12" }, totals: TOTALS, basePublicationId: "base-id" })
    await waitFor(() => harness.lifecycle.state.scanStatus.status === "fatal-error")
    expect(harness.lifecycle.state.scanStatus.error).toBe("retirement failed")
    // No direct clear: the pending record is only touched by the failure
    // cleanup, which cannot even start while the authoritative load is pending.
    expect(harness.calls.clearPendingScan).toHaveLength(0)
    loadGate.resolve()
    await waitFor(() => harness.transitions.some((transition) => transition.kind === "failed"))
    // The failure cleanup then retires the catalog record.
    expect(harness.calls.clearPendingScan).toEqual([harness.calls.beginScan[0]!.record.scanId])
    await harness.lifecycle.seal()
  })

  it("dispatches an unchanged outcome through the unchanged publication operation and applies the result", async () => {
    const harness = createHarness()
    const { session } = await startScan(harness)
    harness.config.publishUnchanged = async (run) => {
      expect(harness.calls.publishUnchanged).toHaveLength(1)
      expect(run.generation).toBe(1)
      return { kind: "published", totals: TOTALS, activeTarget: "/next", warnings: ["cleanup"] }
    }
    session.unchanged({ journal: { uuid: "journal", eventId: "12" }, totals: TOTALS, basePublicationId: "base-id" })
    await waitFor(() => harness.lifecycle.state.scanStatus.status === "completed")
    expect(harness.calls.publishUnchanged[0]!.outcome.journal).toEqual({ uuid: "journal", eventId: "12" })
    expect(harness.lifecycle.state.scanStatus.totals).toEqual(TOTALS)
    expect(harness.lifecycle.state.activeTarget).toBe("/next")
    expect(harness.transitions.filter((transition) => transition.kind === "completed")).toHaveLength(1)
    await harness.lifecycle.seal()
  })

  it("discards saved state through the resume port and catalog", async () => {
    const harness = createHarness()
    const load = makeConstructionLoad(TARGET)
    harness.config.constructionPreview = makePreview(0, 1)
    await harness.lifecycle.adoptStartupState({ saved: load, selectedTarget: TARGET })
    harness.config.pendingScanId = load.descriptor.scanId
    const state = await harness.lifecycle.discardSavedScan()
    expect(harness.calls.resumeDiscard).toEqual([load.descriptor.scanId])
    expect(harness.calls.clearPendingScan).toEqual([load.descriptor.scanId])
    expect(state.scanStatus).toMatchObject({ status: "idle", generation: 0 })
    expect(state.resume).toBeUndefined()
    expect(state.preview).toBeUndefined()
    expect(harness.transitions.at(-1)).toMatchObject({ kind: "discarded" })
    await harness.lifecycle.seal()
  })

  it("sends no transition for a no-op discard", async () => {
    const harness = createHarness()
    const transitions: ScanLifecycleTransition[] = []
    harness.lifecycle.subscribe((transition) => transitions.push(transition))
    const state = await harness.lifecycle.discardSavedScan()
    expect(state.scanStatus.status).toBe("idle")
    expect(transitions).toHaveLength(0)
    await harness.lifecycle.seal()
  })

  it("resolves live reveals with validated paths", async () => {
    const harness = createHarness()
    const { session } = await startScan(harness)
    session.update({ type: "preview", preview: makePreview(1, 1) })
    await waitFor(() => harness.lifecycle.state.preview !== undefined)
    const reveal = harness.lifecycle.revealNode("n-file")
    await waitFor(() => session.resolveNodeRequests.length === 1)
    session.resolveNodeWith({ kind: "resolved", path: `${TARGET}/file.txt` })
    await expect(reveal).resolves.toEqual({ kind: "live", validatedPath: `${TARGET}/file.txt` })
    expect(harness.calls.validated).toEqual([{ path: `${TARGET}/file.txt`, target: TARGET }])
    await harness.lifecycle.seal()
  })

  it("rejects a live reveal when the focus changes or the run is superseded", async () => {
    const harness = createHarness()
    const { session } = await startScan(harness)
    session.update({ type: "preview", preview: makePreview(1, 1) })
    await waitFor(() => harness.lifecycle.state.preview !== undefined)
    const reveal = harness.lifecycle.revealNode("n-file")
    await waitFor(() => session.resolveNodeRequests.length === 1)
    const focus = harness.lifecycle.focusNode("n-root")
    await expect(reveal).rejects.toThrow("The focused folder changed before the item could be revealed")
    await expect(focus).resolves.toBe("applied")
    expect(session.focusRequests).toEqual(["n-root"])

    const gatedReveal = harness.lifecycle.revealNode("n-file")
    await waitFor(() => session.resolveNodeRequests.length === 2)
    const gate = testDeferred<void>()
    harness.config.validateRevealPathGate = gate.promise
    session.resolveNodeWith({ kind: "resolved", path: `${TARGET}/file.txt` })
    await waitFor(() => harness.calls.validated.length === 1)
    await startScan(harness)
    gate.resolve()
    await expect(gatedReveal).rejects.toThrow("The scan changed before the item could be revealed")
    await harness.lifecycle.seal()
  })

  it("resolves saved-construction reveals and focus with the final token check", async () => {
    const harness = createHarness()
    const load = makeConstructionLoad(TARGET)
    harness.config.constructionPreview = makePreview(0, 1)
    await harness.lifecycle.adoptStartupState({ saved: load, selectedTarget: TARGET })
    harness.config.constructionPath = `${TARGET}/file.txt`
    await expect(harness.lifecycle.revealNode("n-file")).resolves.toEqual({ kind: "saved", validatedPath: `${TARGET}/file.txt` })
    harness.config.constructionPreview = makePreview(0, 2, "n-file")
    await expect(harness.lifecycle.focusNode("n-file")).resolves.toBe("applied")
    expect(harness.lifecycle.state.preview).toMatchObject({ revision: 2, focus: { id: "n-file" } })
    expect(harness.transitions.at(-1)).toMatchObject({ kind: "preview" })
    await expect(harness.lifecycle.focusNode("n-missing")).rejects.toThrow("Unknown Orbis node")
    await harness.lifecycle.seal()
  })

  it("returns not-running when neither a run nor a saved construction is present", async () => {
    const harness = createHarness()
    await expect(harness.lifecycle.revealNode("n-file")).resolves.toEqual({ kind: "not-running" })
    await expect(harness.lifecycle.focusNode("n-file")).resolves.toBe("not-running")
    await harness.lifecycle.seal()
  })

  it("seals in order and wins over a racing adoption", async () => {
    const harness = createHarness()
    const { session } = await startScan(harness)
    const order: string[] = []
    const initialization = (async () => {
      order.push("initialization")
      await new Promise((resolve) => setImmediate(resolve))
    })()
    const sealing = harness.lifecycle.seal(initialization)
    expect(harness.lifecycle.state.sealed).toBe(true)
    const load = makeConstructionLoad(TARGET)
    harness.config.constructionPreview = makePreview(0, 9)
    await harness.lifecycle.adoptStartupState({ saved: load, selectedTarget: TARGET })
    order.push("adopted")
    await sealing
    order.push("sealed")
    expect(order).toEqual(["initialization", "adopted", "sealed"])
    expect((harness.execution as FakeLifecycleExecution).closed).toBe(true)
    expect(session.terminated).toBe(true)
    // The seal's final reset wins over the racing adoption.
    expect(harness.lifecycle.state.preview).toBeUndefined()
    expect(harness.lifecycle.state.sealed).toBe(true)
    // Post-seal contract: repeated seal is idempotent, commands reject or no-op.
    await expect(harness.lifecycle.seal()).resolves.toBeUndefined()
    await expect(harness.lifecycle.startScan({ target: TARGET })).rejects.toThrow("Orbis is shutting down")
    expect((await harness.lifecycle.pauseScan()).sealed).toBe(true)
    expect((await harness.lifecycle.discardSavedScan()).sealed).toBe(true)
    expect(typeof harness.lifecycle.subscribe(() => undefined)).toBe("function")
  })

  it("waits for an in-flight start to register, then stops the run", async () => {
    const harness = createHarness()
    const gate = testDeferred<void>()
    harness.config.prepareGate = gate.promise
    const starting = harness.lifecycle.startScan({ target: TARGET })
    // Let the start pass its entry checks and reach preparation.
    await harness.config.prepareEntered
    const sealing = harness.lifecycle.seal()
    gate.resolve()
    const state = await starting
    // The start was past its sealed re-check, so it registered and reported
    // scanning state; the seal then drained the queue and stopped the run.
    expect(state.sealed).toBe(true)
    expect(state.scanStatus).toMatchObject({ status: "scanning", generation: 1 })
    await sealing
    expect((harness.execution as FakeLifecycleExecution).active?.terminated).toBe(true)
    expect(harness.lifecycle.state.run).toBeUndefined()
    await expect(harness.lifecycle.startScan({ target: TARGET })).rejects.toThrow("Orbis is shutting down")
  })

  it("notifies exactly once per observable change and never for diagnostics or adoption", async () => {
    const harness = createHarness()
    const load = makeConstructionLoad(TARGET)
    harness.config.constructionPreview = makePreview(0, 1)
    await harness.lifecycle.adoptStartupState({ saved: load, selectedTarget: TARGET })
    expect(harness.transitions).toHaveLength(0)
    harness.config.peek = { kind: "construction", descriptor: load.descriptor }
    const { session } = await startScan(harness)
    expect(harness.transitions.filter((transition) => transition.kind === "started")).toHaveLength(1)
    session.update({ type: "resume-milestone", milestone: "first-metadata-page" })
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.transitions).toHaveLength(1)
    await expect(harness.lifecycle.focusNode("n-root")).resolves.toBe("applied")
    expect(harness.transitions).toHaveLength(1)
    await harness.lifecycle.seal()
    expect(harness.transitions).toHaveLength(1)
  })
})