import { createHmac } from 'node:crypto'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { OrbisController } from "../src/main/controller"
import type { OrbisSnapshot } from "../src/shared/contracts"
import type {
  FocusOutcome, ResolveNodeOutcome, ScanExecution, ScanExecutionRequest, ScanOutcome, ScanSession, ScanUpdate
} from "../src/main/scan-execution"
import { scanFilesystem, type ProgressivePreview, type ScanResult } from "../src/main/scanner"
import { RESUME_CONTROLLER_PHASES, RESUME_PREPARATION_MESSAGES, RESUME_PREPARATION_PHASES, subscribeControllerDiagnostics, type OrbisTimingEvent } from "../src/main/diagnostics"
import { ConstructionDatabase } from '../src/main/construction-database'
import { FullScanResumeStore } from '../src/main/full-scan-resume'

class FakeScanSession implements ScanSession {
  readonly #updates = new TestAsyncQueue<ScanUpdate>()
  readonly #outcome = testDeferred<ScanOutcome>()
  readonly events: AsyncIterable<ScanUpdate> = this.#updates
  readonly result = this.#outcome.promise
  request!: ScanExecutionRequest
  generation = 0
  terminated = false
  settled = false

  begin(request: ScanExecutionRequest, generation: number): void { this.request = request; this.generation = generation }
  startMessage(): ScanExecutionRequest & { readonly generation: number } { return { ...this.request, generation: this.generation } }
  update(update: ScanUpdate): void { this.#updates.push(update) }
  complete(result: ScanResult, refresh?: Extract<ScanOutcome, { kind: 'completed' }>['refresh']): void {
    this.#settle({ kind: 'completed', result, ...(refresh ? { refresh } : {}) })
  }
  unchanged(outcome: Omit<Extract<ScanOutcome, { kind: 'unchanged' }>, 'kind'>): void { this.#settle({ kind: 'unchanged', ...outcome }) }
  fail(error: Error): void { this.#settle({ kind: 'failed', error }) }
  focus(_nodeId: string): Promise<FocusOutcome> { return Promise.resolve(this.settled ? { kind: 'unavailable' } : { kind: 'accepted' }) }
  resolveNode(_nodeId: string): Promise<ResolveNodeOutcome> { return new Promise((resolve) => { void this.result.then(() => resolve({ kind: 'unavailable' })) }) }
  pause(): Promise<ScanOutcome> {
    this.terminated = true
    if (!this.settled) this.#settle({ kind: 'paused', acknowledged: true, checkpointSequence: 1 })
    return this.result
  }
  #settle(outcome: ScanOutcome): void {
    if (this.settled) return
    this.settled = true
    this.#updates.close()
    this.#outcome.resolve(outcome)
  }
}

class BlockingFailureSession extends FakeScanSession {
  readonly pauseEntered = testDeferred<void>()
  readonly releasePause = testDeferred<void>()

  async pause(): Promise<ScanOutcome> {
    this.terminated = true
    this.pauseEntered.resolve(undefined)
    await this.releasePause.promise
    return this.result
  }
}

class FakeScanExecution implements ScanExecution {
  #active: FakeScanSession | undefined
  #generation = 0
  constructor(private readonly createSession: () => FakeScanSession) {}
  async start(request: ScanExecutionRequest): Promise<ScanSession> {
    if (this.#active && !this.#active.settled) await this.#active.pause()
    const session = this.createSession()
    session.begin(request, ++this.#generation)
    this.#active = session
    return session
  }
  async close(): Promise<void> { if (this.#active && !this.#active.settled) await this.#active.pause() }
}

class DeferredScanExecution implements ScanExecution {
  readonly started = testDeferred<void>()
  readonly session = testDeferred<ScanSession>()
  request: ScanExecutionRequest | undefined
  start(request: ScanExecutionRequest): Promise<ScanSession> {
    this.request = request
    this.started.resolve()
    return this.session.promise
  }
  async close(): Promise<void> { /* The test resolves the pending session before closing. */ }
}

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

function testDeferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((resolvePromise) => { resolve = resolvePromise }), resolve: (value) => resolve(value) }
}

function createController(workers: { create(): FakeScanSession }, options: ConstructorParameters<typeof OrbisController>[1]): OrbisController {
  return new OrbisController(new FakeScanExecution(() => workers.create()), options)
}

async function makeTarget(name: string): Promise<{ readonly directory: string; readonly target: string }> {
  const directory = await mkdtemp(join(tmpdir(), `orbis-controller-${name}-`))
  const target = join(directory, "target")
  await mkdir(target)
  await writeFile(join(target, "file.txt"), "contents")
  return { directory, target }
}

async function publish(worker: FakeScanSession, controller: OrbisController): Promise<void> {
  const start = worker.startMessage()
  const result = await scanFilesystem({ ...start })
  const completed = new Promise<void>((resolveCompleted) => {
    const unsubscribe = controller.subscribe((snapshot) => {
      if (snapshot.scan.status === "completed") { unsubscribe(); resolveCompleted() }
    })
  })
  worker.complete(result)
  await completed
}

describe("OrbisController", () => {
  it("loads the published index after restart without creating a worker", async () => {
    const target = await makeTarget("persistent-restart")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-persistent-index-"))
    const firstWorkers: FakeScanSession[] = []
    const first = createController({ create: () => { const worker = new FakeScanSession(); firstWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await first.initialize()
      await first.startScan()
      await publish(firstWorkers[0]!, first)
      const firstSnapshot = first.snapshot()
      const indexPath = firstWorkers[0]!.startMessage().publishedPath
      await first.close()
      await expect(access(indexPath)).resolves.toBeUndefined()
      await expect(access(join(indexDirectory, "locations.json"))).resolves.toBeUndefined()
      await expect(access(join(indexDirectory, "current.json"))).rejects.toThrow()

      const restartedWorkers: FakeScanSession[] = []
      const restarted = createController({ create: () => { const worker = new FakeScanSession(); restartedWorkers.push(worker); return worker } }, { indexDirectory })
      try {
        await restarted.initialize()
        expect(restartedWorkers).toHaveLength(0)
        expect(restarted.snapshot()).toMatchObject({ committed: true, target: firstSnapshot.target, focus: { name: "target", kind: "directory" } })
      } finally { await restarted.close() }
    } finally {
      await first.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("retains the last index while its target is temporarily disconnected", async () => {
    const target = await makeTarget("disconnected-target")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-disconnected-index-"))
    const workers: FakeScanSession[] = []
    const first = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await first.startScan()
      await publish(workers[0]!, first)
      await first.close()
      await rm(target.target, { recursive: true, force: true })

      const restartedWorkers: FakeScanSession[] = []
      const restarted = createController({ create: () => { const worker = new FakeScanSession(); restartedWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
      try {
        await restarted.initialize()
        expect(restarted.snapshot()).toMatchObject({ committed: true, focus: { name: "target" } })
        expect(restartedWorkers).toHaveLength(0)
      } finally { await restarted.close() }
    } finally {
      await first.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("does not load a stored index after the target directory is replaced", async () => {
    const target = await makeTarget("replaced-target")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-replaced-index-"))
    const workers: FakeScanSession[] = []
    const first = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await first.startScan()
      await publish(workers[0]!, first)
      await first.close()
      await rm(target.target, { recursive: true, force: true })
      await mkdir(target.target)
      await writeFile(join(target.target, "replacement.txt"), "new identity")

      const restartedWorkers: FakeScanSession[] = []
      const restarted = createController({ create: () => { const worker = new FakeScanSession(); restartedWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
      try {
        await restarted.initialize()
        expect(restarted.snapshot().committed).toBe(false)
        await restarted.startScan()
        expect(restartedWorkers).toHaveLength(1)
        await publish(restartedWorkers[0]!, restarted)
        expect(restarted.snapshot().committed).toBe(true)
      } finally { await restarted.close() }
    } finally {
      await first.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("advances the journal cursor without replacing an unchanged index", async () => {
    const target = await makeTarget("unchanged-cursor")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-unchanged-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      const firstStart = workers[0]!.startMessage()
      const result = await scanFilesystem({ ...firstStart })
      const firstCompleted = new Promise<void>((resolveCompleted) => {
        const unsubscribe = controller.subscribe((snapshot) => { if (snapshot.scan.status === "completed") { unsubscribe(); resolveCompleted() } })
      })
      workers[0]!.complete(result, { strategy: "full", journal: { uuid: "volume-journal", eventId: "10" } })
      await firstCompleted
      const originalPath = firstStart.publishedPath

      await controller.rescan()
      const secondStart = workers[1]!.startMessage()
      expect(secondStart.active).toMatchObject({ path: originalPath, manifest: { journal: { uuid: "volume-journal", eventId: "10" } } })
      const secondCompleted = new Promise<void>((resolveCompleted) => {
        const unsubscribe = controller.subscribe((snapshot) => { if (snapshot.scan.status === "completed" && snapshot.scan.generation === 2) { unsubscribe(); resolveCompleted() } })
      })
      const candidateFile = basename(secondStart.publishedPath)
      const scanId = candidateFile.slice('index-'.length, -'.sqlite'.length)
      const partialFile = `index-${scanId}.partial.sqlite`
      await writeFile(join(indexDirectory, partialFile), "saved construction")
      await writeFile(join(indexDirectory, "scan-resume.json"), `${JSON.stringify({ scanId, partialFile, candidateFile })}\n`)
      workers[1]!.unchanged({
        journal: { uuid: "volume-journal", eventId: "12" }, totals: result.totals,
        basePublicationId: secondStart.active!.manifest.publicationId
      })
      await secondCompleted
      expect(controller.snapshot()).toMatchObject({ committed: true, scan: { status: "completed", totals: result.totals } })
      await expect(access(originalPath)).resolves.toBeUndefined()
      const catalog = JSON.parse(await readFile(join(indexDirectory, "locations.json"), "utf8"))
      expect(catalog.publications[0].journal).toEqual({ uuid: "volume-journal", eventId: "12" })
      await expect(access(secondStart.publishedPath)).rejects.toThrow()
      await expect(access(join(indexDirectory, "scan-resume.json"))).rejects.toThrow()
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("restores focus by path and falls back to a surviving ancestor", async () => {
    const target = await makeTarget("focus-restore")
    await mkdir(join(target.target, "folder", "nested"), { recursive: true })
    await writeFile(join(target.target, "folder", "nested", "item"), "item")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-focus-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      const folder = controller.snapshot().largestItems.find((item) => item.name === "folder")!
      await controller.focusNode(folder.id)
      await controller.rescan()
      await publish(workers[1]!, controller)
      expect(controller.snapshot().focus?.name).toBe("folder")

      await rm(join(target.target, "folder"), { recursive: true })
      await controller.rescan()
      await publish(workers[2]!, controller)
      expect(controller.snapshot().focus?.name).toBe("target")
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("keeps the previous index visible during rescan and cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-controller-index-"))
    const firstTarget = await makeTarget("first")
    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory: join(directory, "indexes"), initialTarget: firstTarget.target })
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      expect(controller.snapshot().scan.status).toBe("completed")
      expect(controller.snapshot().target.name).toBe("target")
      await controller.rescan()
      const beforeCancel = controller.snapshot()
      expect(beforeCancel.focus?.name).toBe("target")
      await controller.cancelScan()
      const canceled = controller.snapshot()
      expect(canceled.scan.status).toBe("canceled")
      expect(canceled.focus?.name).toBe("target")
      expect(workers[1]!.terminated).toBe(true)

    } finally {
      await controller.close()
      await rm(directory, { recursive: true, force: true })
      await rm(firstTarget.directory, { recursive: true, force: true })

    }
  })

  it("reuses completed folder sizes immediately on rescan and after restart", async () => {
    const target = await makeTarget("estimate-cache")
    const cachedFolder = join(target.target, "Applications")
    const cachedUsers = join(target.target, "Users")
    await mkdir(cachedFolder)
    await mkdir(cachedUsers)
    await writeFile(join(cachedFolder, "app.bin"), Buffer.alloc(4096))
    await writeFile(join(cachedUsers, "profile.bin"), Buffer.alloc(8192))
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-estimate-cache-index-"))
    const firstWorkers: FakeScanSession[] = []
    const first = createController({ create: () => { const worker = new FakeScanSession(); firstWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await first.startScan()
      await publish(firstWorkers[0]!, first)
      const exactSize = first.snapshot().largestItems.find((item) => item.name === "Applications")!.sizeBytes
      const exactUsersSize = first.snapshot().largestItems.find((item) => item.name === "Users")!.sizeBytes

      await first.rescan()
      expect(firstWorkers[1]!.startMessage().initialEstimate?.items).toEqual(expect.arrayContaining([
        { name: "Applications", estimatedBytes: exactSize },
        { name: "Users", estimatedBytes: exactUsersSize }
      ]))
      await first.cancelScan()
      await first.close()

      const restartedWorkers: FakeScanSession[] = []
      const restarted = createController({ create: () => { const worker = new FakeScanSession(); restartedWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
      try {
        await restarted.startScan()
        expect(restartedWorkers[0]!.startMessage().initialEstimate?.items).toEqual(expect.arrayContaining([
          { name: "Applications", estimatedBytes: exactSize },
          { name: "Users", estimatedBytes: exactUsersSize }
        ]))
      } finally { await restarted.close() }
    } finally {
      await first.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("does not delete unrelated files in the index directory during shutdown", async () => {
    const target = await makeTarget("safe-shutdown")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-safe-shutdown-index-"))
    const keep = join(indexDirectory, "keep.txt")
    await writeFile(keep, "host data")
    const controller = createController({ create: () => new FakeScanSession() }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.close()
      await expect(access(keep)).resolves.toBeUndefined()
    } finally {
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("starts a folder choice with the chosen target rather than the previous target", async () => {
    const firstTarget = await makeTarget("choose-first")
    const secondTarget = await makeTarget("choose-second")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-choose-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController(
      { create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } },
      { indexDirectory, initialTarget: firstTarget.target, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [secondTarget.target] }) } }
    )
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      const snapshot = await controller.chooseFolder()
      expect(workers[1]!.startMessage().target).toBe(await realpath(secondTarget.target))
      expect(snapshot.target.name).toBe("target (2)")
      expect(snapshot.committed).toBe(false)
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(firstTarget.directory, { recursive: true, force: true })
      await rm(secondTarget.directory, { recursive: true, force: true })
    }
  })

  it("reuses a covered descendant as a boundary-safe saved location without starting a worker", async () => {
    const target = await makeTarget("covered-descendant")
    const child = join(target.target, "child")
    await mkdir(child)
    await writeFile(join(child, "inside.txt"), "inside")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-covered-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController(
      { create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } },
      { indexDirectory, initialTarget: target.target, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [child] }) } }
    )
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      const parentId = controller.snapshot().selectedLocationId
      const childSnapshot = await controller.addLocation()
      expect(workers).toHaveLength(1)
      expect(childSnapshot).toMatchObject({ committed: true, target: { name: "child" }, focus: { name: "child", parentId: null } })
      expect(childSnapshot.locations).toHaveLength(2)
      expect(childSnapshot.locations.find((item) => item.id === childSnapshot.selectedLocationId)?.coverage).toBe("ancestor")
      await expect(controller.focusNode(childSnapshot.breadcrumbs[0]!.id)).resolves.toMatchObject({ target: { name: "child" } })
      await controller.rescan()
      expect(workers[1]!.startMessage()).toMatchObject({ target: await realpath(target.target), active: { manifest: { target: await realpath(target.target) } } })
      await publish(workers[1]!, controller)
      const withoutParent = await controller.removeLocation(parentId)
      expect(withoutParent).toMatchObject({ committed: true, target: { name: "child" }, locations: [{ coverage: "ancestor" }] })
      expect(JSON.parse(await readFile(join(indexDirectory, "locations.json"), "utf8")).publications).toHaveLength(1)
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("scans a newly added ancestor before consolidating covered child locations", async () => {
    const target = await makeTarget("ancestor")
    const child = join(target.target, "child")
    await mkdir(child)
    await writeFile(join(child, "inside.txt"), "inside")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-ancestor-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController(
      { create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } },
      { indexDirectory, initialTarget: child, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [target.target] }) } }
    )
    try {
      await controller.startScan(); await publish(workers[0]!, controller)
      const childId = controller.snapshot().selectedLocationId
      const oldPath = workers[0]!.startMessage().publishedPath
      const pending = await controller.addLocation()
      expect(workers).toHaveLength(2)
      expect(pending).toMatchObject({ committed: false, locations: [{ coverage: "direct" }, { coverage: "none" }] })
      await expect(access(oldPath)).resolves.toBeUndefined()
      await publish(workers[1]!, controller)
      await controller.selectLocation(childId)
      expect(controller.snapshot()).toMatchObject({ committed: true, target: { name: "child" } })
      expect(controller.snapshot().locations.find((item) => item.id === childId)?.coverage).toBe("ancestor")
      await expect(access(oldPath)).rejects.toThrow()
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("selects an exact saved target instead of duplicating or rescanning it", async () => {
    const target = await makeTarget("exact-location")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-exact-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController(
      { create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } },
      { indexDirectory, initialTarget: target.target, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [target.target] }) } }
    )
    try {
      await controller.startScan(); await publish(workers[0]!, controller)
      const snapshot = await controller.addLocation()
      expect(snapshot.locations).toHaveLength(1)
      expect(workers).toHaveLength(1)
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("keeps the previous index when a rescan publishes an invalid database", async () => {
    const target = await makeTarget("failed-rescan")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-failed-rescan-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      expect(controller.snapshot().scan.status).toBe("completed")
      await controller.rescan()
      const start = workers[1]!.startMessage()
      await writeFile(start.publishedPath, "not a sqlite database")
      const failed = new Promise<void>((resolveFailed) => {
        controller.subscribe((snapshot) => { if (snapshot.scan.status === "fatal-error") resolveFailed() })
      })
      workers[1]!.complete({ generation: start.generation, target: start.target, rootId: "n-1", publishedPath: start.publishedPath, capacityBytes: 0, freeBytes: 0, scannedBytes: 0, totals: { scannedItems: 0, discoveredBytes: 0, elapsedMs: 0, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 } })
      await failed
      const snapshot = controller.snapshot()
      expect(snapshot.scan.status).toBe("fatal-error")
      expect(snapshot.focus?.name).toBe("target")
      await expectDatabaseFilesAbsent(start.publishedPath)
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("keeps a published index after scan execution reports completion", async () => {
    const target = await makeTarget("normal-exit")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-normal-exit-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      const result = await scanFilesystem({ ...workers[0]!.startMessage() })
      const completed = new Promise<void>((resolveCompleted) => {
        controller.subscribe((snapshot) => { if (snapshot.scan.status === "completed") resolveCompleted() })
      })
      workers[0]!.complete(result)
      await completed
      expect(controller.snapshot().scan.status).toBe("completed")
      expect(controller.snapshot().focus?.name).toBe("target")
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it('publishes resume preparation before worker startup resolves and pauses the eventual session', async () => {
    const target = await makeTarget('deferred-resume')
    const indexDirectory = await mkdtemp(join(tmpdir(), 'orbis-controller-deferred-resume-index-'))
    const targetStats = await lstat(target.target)
    const indexStats = await lstat(indexDirectory)
    const store = new FullScanResumeStore(indexDirectory)
    const descriptor = store.descriptor({
      scanId: 'd2234567-89ab-4cde-8fab-0123456789ab', target: target.target,
      targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
      indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
      checkpoint: { device: String(targetStats.dev), journalUuid: 'journal', eventId: '0' }
    })
    const database = ConstructionDatabase.create(join(indexDirectory, descriptor.partialFile), {
      scanId: descriptor.scanId, journalDevice: descriptor.journalDevice, journalUuid: descriptor.journalUuid, journalBaseline: descriptor.journalBaseline
    })
    const rootId = `n-${createHmac('sha256', Buffer.from(database.nodeIdSeed, 'hex')).update('root').update('\0').update(target.target).digest('hex').slice(0, 32)}`
    database.insertRoot({ id: rootId, parentId: null, name: 'target', path: target.target, kind: 'directory', ownBytes: 8, device: String(targetStats.dev), inode: String(targetStats.ino) })
    database.finish({ kind: 'pause' })
    await store.publish(descriptor)
    const execution = new DeferredScanExecution()
    const controller = new OrbisController(execution, { indexDirectory, initialTarget: target.target })
    try {
      const snapshot = await controller.rescan()
      expect(snapshot).toMatchObject({ focus: { name: 'target' }, scan: { progress: { stage: 'resuming', currentItem: 'Validating saved scan' } } })
      await execution.started.promise
      const session = new FakeScanSession()
      session.begin(execution.request!, 1)
      const pausing = controller.cancelScan()
      execution.session.resolve(session)
      await pausing
      expect(session.terminated).toBe(true)
      expect(controller.snapshot().scan.status).toBe('canceled')
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("notifies the started scan exactly once before worker startup runs", async () => {
    const target = await makeTarget("started-order")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-started-order-index-"))
    const execution = new DeferredScanExecution()
    const controller = new OrbisController(execution, { indexDirectory, initialTarget: target.target })
    try {
      const snapshots: OrbisSnapshot[] = []
      controller.subscribe((snapshot) => snapshots.push(snapshot))
      const started = controller.startScan()
      await execution.started.promise
      // The controller publishes the started scan before the queued worker
      // startup callback runs, and that first turn carries exactly one event.
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({ scan: { status: "scanning", generation: 1 } })
      const snapshot = await started
      expect(snapshot).toMatchObject({ scan: { status: "scanning", generation: 1 } })
      const session = new FakeScanSession()
      session.begin(execution.request!, 1)
      execution.session.resolve(session)
      await controller.close()
      expect(session.terminated).toBe(true)
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it('carries an acknowledged pause receipt into the next worker only once', async () => {
    const target = await makeTarget('resume-receipt')
    const indexDirectory = await mkdtemp(join(tmpdir(), 'orbis-controller-resume-receipt-index-'))
    const targetStats = await lstat(target.target)
    const indexStats = await lstat(indexDirectory)
    const store = new FullScanResumeStore(indexDirectory)
    const descriptor = store.descriptor({
      scanId: 'd3234567-89ab-4cde-8fab-0123456789ab', target: target.target,
      targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
      indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
      checkpoint: { device: String(targetStats.dev), journalUuid: 'journal', eventId: '0' }
    })
    const database = ConstructionDatabase.create(join(indexDirectory, descriptor.partialFile), {
      scanId: descriptor.scanId, journalDevice: descriptor.journalDevice, journalUuid: descriptor.journalUuid, journalBaseline: descriptor.journalBaseline
    })
    const rootId = `n-${createHmac('sha256', Buffer.from(database.nodeIdSeed, 'hex')).update('root').update('\0').update(target.target).digest('hex').slice(0, 32)}`
    database.insertRoot({ id: rootId, parentId: null, name: 'target', path: target.target, kind: 'directory', ownBytes: 8, device: String(targetStats.dev), inode: String(targetStats.ino) })
    database.finish({ kind: 'pause' })
    await store.publish(descriptor)
    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.rescan()
      expect(workers[0]!.startMessage().resumeReceipt?.source).toBe('full-validation')
      await controller.cancelScan()
      await controller.rescan()
      expect(workers[1]!.startMessage().resumeReceipt?.source).toBe('acknowledged-pause')
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it('reports generation-scoped resume milestones without exposing them as snapshots', async () => {
    const target = await makeTarget('resume-diagnostics')
    const indexDirectory = await mkdtemp(join(tmpdir(), 'orbis-controller-resume-diagnostics-index-'))
    const targetStats = await lstat(target.target)
    const indexStats = await lstat(indexDirectory)
    const store = new FullScanResumeStore(indexDirectory)
    const descriptor = store.descriptor({
      scanId: 'd1234567-89ab-4cde-8fab-0123456789ab', target: target.target,
      targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
      indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
      checkpoint: { device: String(targetStats.dev), journalUuid: 'journal', eventId: '0' }
    })
    const database = ConstructionDatabase.create(join(indexDirectory, descriptor.partialFile), {
      scanId: descriptor.scanId, journalDevice: descriptor.journalDevice, journalUuid: descriptor.journalUuid, journalBaseline: descriptor.journalBaseline
    })
    const rootId = `n-${createHmac('sha256', Buffer.from(database.nodeIdSeed, 'hex')).update('root').update('\0').update(target.target).digest('hex').slice(0, 32)}`
    database.insertRoot({ id: rootId, parentId: null, name: 'target', path: target.target, kind: 'directory', ownBytes: 0, device: String(targetStats.dev), inode: String(targetStats.ino) })
    database.finish({ kind: 'pause' })
    await store.publish(descriptor)
    const workers: FakeScanSession[] = []
    const events: OrbisTimingEvent[] = []
    const unsubscribe = subscribeControllerDiagnostics((event) => events.push(event))
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      const resuming = await controller.rescan()
      expect(workers[0]!.startMessage().resumeExpected).toBe(true)
      expect(resuming).toMatchObject({ focus: { name: 'target' }, scan: { status: 'scanning', generation: 1, progress: { stage: 'resuming', currentItem: RESUME_PREPARATION_MESSAGES.validating } } })
      const chart = resuming.chart
      workers[0]!.update({ type: 'resume-milestone', milestone: 'preparation-started' })
      for (const phase of RESUME_PREPARATION_PHASES) {
        workers[0]!.update({ type: 'resume-preparation', phase })
        await new Promise((resolve) => setImmediate(resolve))
        expect(controller.snapshot().scan.progress).toMatchObject({ stage: 'resuming', currentItem: RESUME_PREPARATION_MESSAGES[phase] })
        expect(controller.snapshot().chart).toEqual(chart)
      }
      workers[0]!.update({ type: 'progress', progress: { stage: 'traversing', scannedItems: 1, discoveredBytes: 0, elapsedMs: 0, currentItem: 'target' } })
      await new Promise((resolve) => setImmediate(resolve))
      expect(controller.snapshot().scan.progress?.stage).toBe('traversing')
      workers[0]!.update({ type: 'resume-milestone', milestone: 'first-metadata-page' })
      workers[0]!.update({ type: 'resume-milestone', milestone: 'first-metadata-preview' })
      await new Promise((resolve) => setImmediate(resolve))
      for (const phase of RESUME_CONTROLLER_PHASES) {
        const matches = events.filter((event) => event.phase === phase && event.generation === 1)
        expect(matches, phase).toHaveLength(1)
        expect(matches[0]!.durationMs).toBeGreaterThanOrEqual(0)
      }
    } finally {
      unsubscribe()
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("reports first-publication and snapshot timings through the internal diagnostics seam", async () => {
    const target = await makeTarget("diagnostics")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-diagnostics-index-"))
    const workers: FakeScanSession[] = []
    const events: OrbisTimingEvent[] = []
    const unsubscribe = subscribeControllerDiagnostics((event) => events.push(event))
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      const completed = new Promise<void>((resolveCompleted) => {
        controller.subscribe((snapshot) => { if (snapshot.scan.status === "completed") resolveCompleted() })
      })
      await controller.startScan()
      await publish(workers[0]!, controller)
      await completed
      await new Promise((resolve) => setImmediate(resolve))
      const required = ["index-open", "partial-index-cleanup", "snapshot-root-query", "snapshot-projection-query", "snapshot-total", "listener-notify", "publication-total"]
      for (const phase of required) {
        const matches = events.filter((event) => event.phase === phase && event.generation === 1)
        expect(matches, phase).toHaveLength(1)
        expect(matches[0]!.durationMs).toBeGreaterThanOrEqual(0)
      }
    } finally {
      unsubscribe()
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("removes every owned database artifact after a worker error", async () => {
    const target = await makeTarget("worker-error")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-worker-error-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      const failed = new Promise<void>((resolveFailed) => {
        controller.subscribe((snapshot) => { if (snapshot.scan.status === "fatal-error") resolveFailed() })
      })
      await controller.startScan()
      const start = workers[0]!.startMessage()
      for (const path of [start.partialPath, start.publishedPath]) {
        for (const suffix of ["", "-journal", "-wal", "-shm"]) await writeFile(`${path}${suffix}`, "artifact")
      }
      workers[0]!.fail(new Error("worker failed"))
      await failed
      for (const path of [start.partialPath, start.publishedPath]) await expectDatabaseFilesAbsent(path)
      expect(workers[0]!.terminated).toBe(true)
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it('does not race a rescan with failed-run catalog cleanup', async () => {
    const target = await makeTarget('failed-rescan-race')
    const indexDirectory = await mkdtemp(join(tmpdir(), 'orbis-controller-failed-rescan-race-index-'))
    const workers: FakeScanSession[] = []
    let created = 0
    let failedWorker: BlockingFailureSession | undefined
    const controller = createController({ create: () => {
      const worker = created++ === 0 ? new BlockingFailureSession() : new FakeScanSession()
      workers.push(worker)
      if (worker instanceof BlockingFailureSession) failedWorker = worker
      return worker
    } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      const first = failedWorker!
      first.fail(new Error('scan failed'))
      await first.pauseEntered.promise

      const rescanning = controller.rescan()
      first.releasePause.resolve(undefined)
      await expect(rescanning).resolves.toMatchObject({ scan: { status: 'scanning' } })
      expect(workers).toHaveLength(2)
    } finally {
      failedWorker?.releasePause.resolve(undefined)
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it('seals cleanly while failed-run cleanup is still stopping the worker', async () => {
    const target = await makeTarget('failed-cleanup-shutdown')
    const indexDirectory = await mkdtemp(join(tmpdir(), 'orbis-controller-failed-cleanup-shutdown-index-'))
    let failedWorker: BlockingFailureSession | undefined
    const controller = createController({ create: () => {
      const worker = new BlockingFailureSession()
      failedWorker = worker
      return worker
    } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      failedWorker!.fail(new Error('scan failed'))
      await failedWorker!.pauseEntered.promise

      const closing = controller.close()
      failedWorker!.releasePause.resolve(undefined)
      await expect(closing).resolves.toBeUndefined()
      expect(failedWorker!.terminated).toBe(true)
    } finally {
      failedWorker?.releasePause.resolve(undefined)
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it('releases a pending owner on restart when no Resume artifact exists', async () => {
    const target = await makeTarget('restart-without-resume')
    const indexDirectory = await mkdtemp(join(tmpdir(), 'orbis-controller-restart-without-resume-index-'))
    const firstWorkers: FakeScanSession[] = []
    const first = createController({ create: () => { const worker = new FakeScanSession(); firstWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await first.startScan()
      await first.close()

      const restartedWorkers: FakeScanSession[] = []
      const restarted = createController({ create: () => { const worker = new FakeScanSession(); restartedWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
      try {
        await restarted.initialize()
        const snapshot = await restarted.rescan()
        expect(snapshot.scan.status).toBe('scanning')
        expect(restartedWorkers).toHaveLength(1)
      } finally { await restarted.close() }
    } finally {
      await first.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it('retains a valid saved construction after failure and restart', async () => {
    const target = await makeTarget('failed-restart-resume')
    const indexDirectory = await mkdtemp(join(tmpdir(), 'orbis-controller-failed-restart-resume-index-'))
    const targetStats = await lstat(target.target)
    const indexStats = await lstat(indexDirectory)
    const store = new FullScanResumeStore(indexDirectory)
    const scanId = 'd4234567-89ab-4cde-8fab-0123456789ab'
    const descriptor = store.descriptor({
      scanId, target: target.target, targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
      indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
      checkpoint: { device: String(targetStats.dev), journalUuid: 'journal', eventId: '0' }
    })
    const database = ConstructionDatabase.create(join(indexDirectory, descriptor.partialFile), {
      scanId, journalDevice: descriptor.journalDevice, journalUuid: descriptor.journalUuid, journalBaseline: descriptor.journalBaseline
    })
    const rootId = `n-${createHmac('sha256', Buffer.from(database.nodeIdSeed, 'hex')).update('root').update('\0').update(target.target).digest('hex').slice(0, 32)}`
    database.insertRoot({ id: rootId, parentId: null, name: 'target', path: target.target, kind: 'directory', ownBytes: 8, device: String(targetStats.dev), inode: String(targetStats.ino) })
    database.finish({ kind: 'pause' })
    await store.publish(descriptor)

    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      const canceled = new Promise<void>((resolveCanceled) => {
        const unsubscribe = controller.subscribe((snapshot) => {
          if (snapshot.scan.status === 'canceled' && snapshot.scan.generation === 1) { unsubscribe(); resolveCanceled() }
        })
      })
      const resuming = await controller.rescan()
      expect(resuming).toMatchObject({ focus: { name: 'target' }, scan: { status: 'scanning' } })
      workers[0]!.fail(new Error('scan failed after checkpoint'))
      await canceled
      expect(controller.snapshot()).toMatchObject({ scan: { resume: { available: true } }, focus: { name: 'target' } })
      await controller.close()

      const restarted = createController({ create: () => new FakeScanSession() }, { indexDirectory, initialTarget: target.target })
      try {
        await restarted.initialize()
        expect(restarted.snapshot()).toMatchObject({ scan: { status: 'canceled', resume: { available: true } }, focus: { name: 'target' } })
      } finally { await restarted.close() }
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("does not let a settled session replace a newer scan", async () => {
    const target = await makeTarget("stale")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-stale-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      const staleStart = workers[0]!.startMessage()
      const staleResult = await scanFilesystem({ ...staleStart })
      await controller.rescan()
      workers[0]!.complete(staleResult)
      expect(controller.snapshot().focus).toBeNull()
      await publish(workers[1]!, controller)
      expect(controller.snapshot().scan.generation).toBe(2)
      expect(controller.snapshot().scan.status).toBe("completed")
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("rejects a pending preview reveal when focus changes", async () => {
    const target = await makeTarget("pending-reveal")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-pending-reveal-index-"))
    const workers: FakeScanSession[] = []
    const revealed: string[] = []
    const controller = createController(
      { create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } },
      { indexDirectory, initialTarget: target.target, shell: { showItemInFolder: (path) => { revealed.push(path) }, quickLook: () => undefined, openInTerminal: async () => undefined, openExternal: async () => undefined } }
    )
    try {
      await controller.startScan()
      const start = workers[0]!.startMessage()
      let resolvePreview!: (preview: ProgressivePreview) => void
      const previewPromise = new Promise<ProgressivePreview>((resolvePreviewValue) => { resolvePreview = resolvePreviewValue })
      const scan = scanFilesystem({ ...start, onPreview: (preview) => { if (preview.largestItems.length > 0) resolvePreview(preview) } })
      const preview = await previewPromise
      workers[0]!.update({ type: 'preview', preview })
      await new Promise((resolve) => setImmediate(resolve))
      const item = preview.largestItems[0]!
      const reveal = controller.revealNode(item.id)
      await controller.focusNode(preview.focus.id)
      await expect(reveal).rejects.toThrow("focused folder changed")
      await scan
      expect(revealed).toEqual([])
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("rejects a revealed item that was replaced by a symlink", async () => {
    const target = await makeTarget("reveal-symlink")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-reveal-symlink-index-"))
    const outside = join(target.directory, "outside.txt")
    const workers: FakeScanSession[] = []
    const controller = createController(
      { create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } },
      { indexDirectory, initialTarget: target.target, shell: { showItemInFolder: () => undefined, quickLook: () => undefined, openInTerminal: async () => undefined, openExternal: async () => undefined } }
    )
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      await writeFile(outside, "outside")
      await rm(join(target.target, "file.txt"))
      await symlink(outside, join(target.target, "file.txt"))
      const file = controller.snapshot().largestItems.find((item) => item.name === "file.txt")!
      await expect(controller.revealNode(file.id)).rejects.toThrow("no longer a scanned item")
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("runs Quick Look, Finder, and Terminal actions on validated canonical paths", async () => {
    const target = await makeTarget("native-actions")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-native-actions-index-"))
    const workers: FakeScanSession[] = []
    const previewed: string[] = []
    const revealed: string[] = []
    const terminals: string[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, {
      indexDirectory,
      initialTarget: target.target,
      shell: {
        quickLook: (path) => { previewed.push(path) },
        showItemInFolder: (path) => { revealed.push(path) },
        openInTerminal: async (directory) => { terminals.push(directory) },
        openExternal: async () => undefined
      }
    })
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      const snapshot = controller.snapshot()
      const file = snapshot.largestItems.find((item) => item.name === "file.txt")!
      const root = snapshot.focus!
      const canonicalFile = await realpath(join(target.target, "file.txt"))
      const canonicalRoot = await realpath(target.target)

      await controller.performNodeAction(file.id, "quick-look")
      await controller.performNodeAction(file.id, "show-in-finder")
      await controller.performNodeAction(root.id, "open-in-terminal")
      await controller.performNodeAction(file.id, "open-in-terminal")

      expect(previewed).toEqual([canonicalFile])
      expect(revealed).toEqual([canonicalFile])
      expect(terminals).toEqual([canonicalRoot, canonicalRoot])
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("runs no native action when an indexed file disappears or changes kind", async () => {
    const target = await makeTarget("native-action-races")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-native-action-races-index-"))
    const workers: FakeScanSession[] = []
    const actions: string[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, {
      indexDirectory,
      initialTarget: target.target,
      shell: {
        quickLook: () => { actions.push("quick-look") },
        showItemInFolder: () => { actions.push("finder") },
        openInTerminal: async () => { actions.push("terminal") },
        openExternal: async () => undefined
      }
    })
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      const file = controller.snapshot().largestItems.find((item) => item.name === "file.txt")!
      await rm(join(target.target, "file.txt"))
      await expect(controller.performNodeAction(file.id, "quick-look")).rejects.toThrow("no longer available")
      await mkdir(join(target.target, "file.txt"))
      await expect(controller.performNodeAction(file.id, "show-in-finder")).rejects.toThrow("kind changed")
      expect(actions).toEqual([])
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("rejects unknown reveal ids and resolves valid ids through the active index", async () => {
    const target = await makeTarget("reveal")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-reveal-index-"))
    const revealed: string[] = []
    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target, shell: { showItemInFolder: (path) => { revealed.push(path) }, quickLook: () => undefined, openInTerminal: async () => undefined, openExternal: async () => undefined } })
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      await expect(controller.revealNode("n-999")).rejects.toThrow("Unknown Orbis node")
      const file = controller.snapshot().largestItems.find((item) => item.name === "file.txt")!
      await controller.revealNode(file.id)
      expect(revealed).toEqual([await realpath(join(target.target, "file.txt"))])
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("maps each lifecycle transition to one renderer snapshot and returns the applied state", async () => {
    const target = await makeTarget("lifecycle-façade")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-lifecycle-façade-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    const snapshots: OrbisSnapshot[] = []
    controller.subscribe((snapshot) => snapshots.push(snapshot))
    try {
      const started = await controller.startScan()
      expect(snapshots).toHaveLength(1)
      expect(started).toEqual(snapshots[0])
      expect(started.scan).toMatchObject({ status: "scanning", generation: 1 })

      const canceled = await controller.cancelScan()
      expect(snapshots).toHaveLength(2)
      expect(canceled).toEqual(snapshots[1])
      expect(canceled.scan.status).toBe("canceled")
      expect(workers[0]!.terminated).toBe(true)
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("keeps shutdown idempotent and makes post-shutdown subscriptions inert", async () => {
    const target = await makeTarget("shutdown-contract")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-shutdown-contract-index-"))
    const controller = createController({ create: () => new FakeScanSession() }, { indexDirectory, initialTarget: target.target })
    let notifications = 0
    controller.subscribe(() => { notifications += 1 })
    try {
      await controller.initialize()
      await controller.close()
      await controller.close()
      const unsubscribe = controller.subscribe(() => { notifications += 1 })
      await expect(controller.startScan()).rejects.toThrow("Orbis is shutting down")
      unsubscribe()
      expect(notifications).toBe(0)
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("uses the selected target for the next run after publication", async () => {
    const target = await makeTarget("publication-target-reset")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-publication-target-reset-index-"))
    const workers: FakeScanSession[] = []
    const controller = createController({ create: () => { const worker = new FakeScanSession(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      expect(controller.snapshot().target.name).toBe("target")
      await controller.rescan()
      expect(workers[1]!.startMessage().target).toBe(await realpath(target.target))
      await controller.cancelScan()
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })
})

async function expectDatabaseFilesAbsent(path: string): Promise<void> {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) await expect(access(`${path}${suffix}`)).rejects.toThrow()
}
