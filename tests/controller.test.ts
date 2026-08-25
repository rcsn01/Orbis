import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { OrbisController, type OrbisWorker } from "../src/main/controller"
import { scanFilesystem, type ProgressivePreview } from "../src/main/scanner"
import { subscribeControllerDiagnostics, type OrbisTimingEvent } from "../../../packages/feature-orbis/src/main/diagnostics"

class FakeWorker implements OrbisWorker {
  readonly messages: unknown[] = []
  #messageListeners: Array<(message: unknown) => void> = []
  #errorListeners: Array<(error: unknown) => void> = []
  #exitListeners: Array<(code: number) => void> = []
  terminated = false
  postMessage(message: unknown): void { this.messages.push(message) }
  on(event: "message" | "error" | "exit", listener: ((value: unknown) => void) | ((code: number) => void)): OrbisWorker {
    if (event === "message") this.#messageListeners.push(listener as (message: unknown) => void)
    else if (event === "error") this.#errorListeners.push(listener as (error: unknown) => void)
    else this.#exitListeners.push(listener as (code: number) => void)
    return this
  }
  terminate(): Promise<number> { this.terminated = true; return Promise.resolve(0) }
  emit(message: unknown): void { for (const listener of this.#messageListeners) listener(message) }
  emitError(error: unknown): void { for (const listener of this.#errorListeners) listener(error) }
  emitExit(code: number): void { for (const listener of this.#exitListeners) listener(code) }
  startMessage(): { generation: number; requestId: number; target: string; partialPath: string; publishedPath: string; indexDirectory: string; startupRoot: boolean; initialEstimate?: { readonly items: readonly { readonly name: string; readonly estimatedBytes: number }[] }; active?: { readonly manifest: { readonly publicationId: string; readonly journal: { readonly uuid: string; readonly eventId: string } | null }; readonly path: string } } { return this.messages[0] as never }
}

async function makeTarget(name: string): Promise<{ readonly directory: string; readonly target: string }> {
  const directory = await mkdtemp(join(tmpdir(), `orbis-controller-${name}-`))
  const target = join(directory, "target")
  await mkdir(target)
  await writeFile(join(target, "file.txt"), "contents")
  return { directory, target }
}

async function publish(worker: FakeWorker, controller: OrbisController): Promise<void> {
  const start = worker.startMessage()
  const result = await scanFilesystem({ ...start })
  const completed = new Promise<void>((resolveCompleted) => {
    const unsubscribe = controller.subscribe((snapshot) => {
      if (snapshot.scan.status === "completed") { unsubscribe(); resolveCompleted() }
    })
  })
  worker.emit({ type: "complete", generation: result.generation, requestId: start.requestId, result })
  await completed
}

describe("OrbisController", () => {
  it("loads the published index after restart without creating a worker", async () => {
    const target = await makeTarget("persistent-restart")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-persistent-index-"))
    const firstWorkers: FakeWorker[] = []
    const first = new OrbisController({ create: () => { const worker = new FakeWorker(); firstWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await first.initialize()
      await first.startScan()
      await publish(firstWorkers[0]!, first)
      const firstSnapshot = first.snapshot()
      const indexPath = firstWorkers[0]!.startMessage().publishedPath
      await first.close()
      await expect(access(indexPath)).resolves.toBeUndefined()
      await expect(access(join(indexDirectory, "current.json"))).resolves.toBeUndefined()

      const restartedWorkers: FakeWorker[] = []
      const restarted = new OrbisController({ create: () => { const worker = new FakeWorker(); restartedWorkers.push(worker); return worker } }, { indexDirectory })
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
    const workers: FakeWorker[] = []
    const first = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await first.startScan()
      await publish(workers[0]!, first)
      await first.close()
      await rm(target.target, { recursive: true, force: true })

      const restartedWorkers: FakeWorker[] = []
      const restarted = new OrbisController({ create: () => { const worker = new FakeWorker(); restartedWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
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
    const workers: FakeWorker[] = []
    const first = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await first.startScan()
      await publish(workers[0]!, first)
      await first.close()
      await rm(target.target, { recursive: true, force: true })
      await mkdir(target.target)
      await writeFile(join(target.target, "replacement.txt"), "new identity")

      const restartedWorkers: FakeWorker[] = []
      const restarted = new OrbisController({ create: () => { const worker = new FakeWorker(); restartedWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
      try {
        await restarted.initialize()
        expect(restarted.snapshot().committed).toBe(false)
        await restarted.startScan()
        expect(restartedWorkers).toHaveLength(1)
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
    const workers: FakeWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      const firstStart = workers[0]!.startMessage()
      const result = await scanFilesystem({ ...firstStart })
      const firstCompleted = new Promise<void>((resolveCompleted) => {
        const unsubscribe = controller.subscribe((snapshot) => { if (snapshot.scan.status === "completed") { unsubscribe(); resolveCompleted() } })
      })
      workers[0]!.emit({ type: "complete", generation: result.generation, requestId: firstStart.requestId, result, refresh: { strategy: "full", journal: { uuid: "volume-journal", eventId: "10" } } })
      await firstCompleted
      const originalPath = firstStart.publishedPath

      await controller.rescan()
      const secondStart = workers[1]!.startMessage()
      expect(secondStart.active).toMatchObject({ path: originalPath, manifest: { journal: { uuid: "volume-journal", eventId: "10" } } })
      const secondCompleted = new Promise<void>((resolveCompleted) => {
        const unsubscribe = controller.subscribe((snapshot) => { if (snapshot.scan.status === "completed" && snapshot.scan.generation === 2) { unsubscribe(); resolveCompleted() } })
      })
      workers[1]!.emit({
        type: "unchanged", generation: 2, requestId: secondStart.requestId,
        journal: { uuid: "volume-journal", eventId: "12" }, totals: result.totals,
        basePublicationId: secondStart.active!.manifest.publicationId
      })
      await secondCompleted
      expect(controller.snapshot()).toMatchObject({ committed: true, scan: { status: "completed", totals: result.totals } })
      await expect(access(originalPath)).resolves.toBeUndefined()
      const manifest = JSON.parse(await readFile(join(indexDirectory, "current.json"), "utf8"))
      expect(manifest.journal).toEqual({ uuid: "volume-journal", eventId: "12" })
      await expect(access(secondStart.publishedPath)).rejects.toThrow()
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
    const workers: FakeWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
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
    const workers: FakeWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory: join(directory, "indexes"), initialTarget: firstTarget.target })
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
    const firstWorkers: FakeWorker[] = []
    const first = new OrbisController({ create: () => { const worker = new FakeWorker(); firstWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
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

      const restartedWorkers: FakeWorker[] = []
      const restarted = new OrbisController({ create: () => { const worker = new FakeWorker(); restartedWorkers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
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
    const controller = new OrbisController({ create: () => new FakeWorker() }, { indexDirectory, initialTarget: target.target })
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
    const workers: FakeWorker[] = []
    const controller = new OrbisController(
      { create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } },
      { indexDirectory, initialTarget: firstTarget.target, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [secondTarget.target] }) } }
    )
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      const snapshot = await controller.chooseFolder()
      expect(workers[1]!.startMessage().target).toBe(secondTarget.target)
      expect(snapshot.target.name).toBe("target")
      expect(snapshot.committed).toBe(false)
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(firstTarget.directory, { recursive: true, force: true })
      await rm(secondTarget.directory, { recursive: true, force: true })
    }
  })

  it("keeps the previous index when a rescan publishes an invalid database", async () => {
    const target = await makeTarget("failed-rescan")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-failed-rescan-index-"))
    const workers: FakeWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
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
      workers[1]!.emit({ type: "complete", generation: start.generation, requestId: start.requestId, result: { generation: start.generation, target: start.target, rootId: "n-1", publishedPath: start.publishedPath, capacityBytes: 0, freeBytes: 0, scannedBytes: 0, totals: { scannedItems: 0, discoveredBytes: 0, elapsedMs: 0, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 } } })
      await failed
      const snapshot = controller.snapshot()
      expect(snapshot.scan.status).toBe("fatal-error")
      expect(snapshot.focus?.name).toBe("target")
      await expectDatabaseFilesAbsent(start.publishedPath)
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("keeps a published index when the worker exits after posting completion", async () => {
    const target = await makeTarget("normal-exit")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-normal-exit-index-"))
    const workers: FakeWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      const result = await scanFilesystem({ ...workers[0]!.startMessage() })
      const completed = new Promise<void>((resolveCompleted) => {
        controller.subscribe((snapshot) => { if (snapshot.scan.status === "completed") resolveCompleted() })
      })
      workers[0]!.emit({ type: "complete", generation: result.generation, requestId: workers[0]!.startMessage().requestId, result })
      workers[0]!.emitExit(0)
      await completed
      expect(controller.snapshot().scan.status).toBe("completed")
      expect(controller.snapshot().focus?.name).toBe("target")
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("reports first-publication and snapshot timings through the internal diagnostics seam", async () => {
    const target = await makeTarget("diagnostics")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-diagnostics-index-"))
    const workers: FakeWorker[] = []
    const events: OrbisTimingEvent[] = []
    const unsubscribe = subscribeControllerDiagnostics((event) => events.push(event))
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      const completed = new Promise<void>((resolveCompleted) => {
        controller.subscribe((snapshot) => { if (snapshot.scan.status === "completed") resolveCompleted() })
      })
      await controller.startScan()
      await publish(workers[0]!, controller)
      await completed
      await new Promise((resolve) => setImmediate(resolve))
      const required = ["index-open", "partial-index-cleanup", "snapshot-focus-query", "snapshot-root-query", "snapshot-breadcrumbs-query", "snapshot-chart-query", "snapshot-largest-items-query", "snapshot-total", "listener-notify", "publication-total"]
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
    const workers: FakeWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      const failed = new Promise<void>((resolveFailed) => {
        controller.subscribe((snapshot) => { if (snapshot.scan.status === "fatal-error") resolveFailed() })
      })
      await controller.startScan()
      const start = workers[0]!.startMessage()
      for (const path of [start.partialPath, start.publishedPath]) {
        for (const suffix of ["", "-journal", "-wal", "-shm"]) await writeFile(`${path}${suffix}`, "artifact")
      }
      workers[0]!.emitError(new Error("worker failed"))
      await failed
      for (const path of [start.partialPath, start.publishedPath]) await expectDatabaseFilesAbsent(path)
      expect(workers[0]!.terminated).toBe(true)
    } finally {
      await controller.close()
      await rm(indexDirectory, { recursive: true, force: true })
      await rm(target.directory, { recursive: true, force: true })
    }
  })

  it("does not let a stale generation replace a newer scan", async () => {
    const target = await makeTarget("stale")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-stale-index-"))
    const workers: FakeWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      const staleStart = workers[0]!.startMessage()
      const staleResult = await scanFilesystem({ ...staleStart })
      await controller.rescan()
      workers[0]!.emit({ type: "complete", generation: staleResult.generation, requestId: staleStart.requestId, result: staleResult })
      expect(controller.snapshot().focus).toBeNull()
      await publish(workers[1]!, controller)
      expect(controller.snapshot().scan.generation).toBe(2)
      expect(controller.snapshot().scan.status).toBe("completed")
      await expect(access(staleResult.publishedPath)).rejects.toThrow()
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("rejects a pending preview reveal when focus changes", async () => {
    const target = await makeTarget("pending-reveal")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-pending-reveal-index-"))
    const workers: FakeWorker[] = []
    const revealed: string[] = []
    const controller = new OrbisController(
      { create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } },
      { indexDirectory, initialTarget: target.target, shell: { showItemInFolder: (path) => revealed.push(path), openExternal: async () => undefined } }
    )
    try {
      await controller.startScan()
      const start = workers[0]!.startMessage()
      let resolvePreview!: (preview: ProgressivePreview) => void
      const previewPromise = new Promise<ProgressivePreview>((resolvePreviewValue) => { resolvePreview = resolvePreviewValue })
      const scan = scanFilesystem({ ...start, onPreview: (preview) => resolvePreview(preview) })
      const preview = await previewPromise
      workers[0]!.emit({ type: "preview", generation: start.generation, requestId: start.requestId, preview })
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
    const workers: FakeWorker[] = []
    const controller = new OrbisController(
      { create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } },
      { indexDirectory, initialTarget: target.target, shell: { showItemInFolder: () => undefined, openExternal: async () => undefined } }
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

  it("rejects unknown reveal ids and resolves valid ids through the active index", async () => {
    const target = await makeTarget("reveal")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-reveal-index-"))
    const revealed: string[] = []
    const workers: FakeWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target, shell: { showItemInFolder: (path) => revealed.push(path), openExternal: async () => undefined } })
    try {
      await controller.startScan()
      await publish(workers[0]!, controller)
      await expect(controller.revealNode("n-999")).rejects.toThrow("Unknown Orbis node")
      const file = controller.snapshot().largestItems.find((item) => item.name === "file.txt")!
      await controller.revealNode(file.id)
      expect(revealed).toEqual([await realpath(join(target.target, "file.txt"))])
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })
})

async function expectDatabaseFilesAbsent(path: string): Promise<void> {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) await expect(access(`${path}${suffix}`)).rejects.toThrow()
}
