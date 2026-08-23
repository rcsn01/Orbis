import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { OrbisController, type OrbisWorker } from "../src/main/controller"
import { scanFilesystem } from "../src/main/scanner"

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
  emitExit(code: number): void { for (const listener of this.#exitListeners) listener(code) }
  startMessage(): { generation: number; target: string; partialPath: string; publishedPath: string; indexDirectory: string; startupRoot: boolean } { return this.messages[0] as never }
}

async function makeTarget(name: string): Promise<{ readonly directory: string; readonly target: string }> {
  const directory = await mkdtemp(join(tmpdir(), `orbis-controller-${name}-`))
  const target = join(directory, "target")
  await mkdir(target)
  await writeFile(join(target, "file.txt"), "contents")
  return { directory, target }
}

async function publish(worker: FakeWorker): Promise<void> {
  const start = worker.startMessage()
  const result = await scanFilesystem({ ...start })
  worker.emit({ type: "complete", generation: result.generation, result })
  await new Promise((resolve) => setImmediate(resolve))
}

describe("OrbisController", () => {
  it("keeps the previous index visible during rescan and cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-controller-index-"))
    const firstTarget = await makeTarget("first")
    const workers: FakeWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory: join(directory, "indexes"), initialTarget: firstTarget.target })
    try {
      await controller.startScan()
      await publish(workers[0]!)
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

  it("keeps a published index when the worker exits after posting completion", async () => {
    const target = await makeTarget("normal-exit")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-normal-exit-index-"))
    const workers: FakeWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target })
    try {
      await controller.startScan()
      const result = await scanFilesystem({ ...workers[0]!.startMessage() })
      workers[0]!.emit({ type: "complete", generation: result.generation, result })
      workers[0]!.emitExit(0)
      await new Promise((resolve) => setImmediate(resolve))
      expect(controller.snapshot().scan.status).toBe("completed")
      expect(controller.snapshot().focus?.name).toBe("target")
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
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
      workers[0]!.emit({ type: "complete", generation: staleResult.generation, result: staleResult })
      expect(controller.snapshot().focus).toBeNull()
      await publish(workers[1]!)
      expect(controller.snapshot().scan.generation).toBe(2)
      expect(controller.snapshot().scan.status).toBe("completed")
      await expect(access(staleResult.publishedPath)).rejects.toThrow()
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })

  it("rejects unknown reveal ids and resolves valid ids through the active index", async () => {
    const target = await makeTarget("reveal")
    const indexDirectory = await mkdtemp(join(tmpdir(), "orbis-controller-reveal-index-"))
    const revealed: string[] = []
    const workers: FakeWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new FakeWorker(); workers.push(worker); return worker } }, { indexDirectory, initialTarget: target.target, shell: { showItemInFolder: (path) => revealed.push(path), openExternal: async () => undefined } })
    try {
      await controller.startScan()
      await publish(workers[0]!)
      await expect(controller.revealNode("n-999")).rejects.toThrow("Unknown Orbis node")
      const file = controller.snapshot().largestItems.find((item) => item.name === "file.txt")!
      await controller.revealNode(file.id)
      expect(revealed).toEqual([join(target.target, "file.txt")])
    } finally { await controller.close(); await rm(indexDirectory, { recursive: true, force: true }); await rm(target.directory, { recursive: true, force: true }) }
  })
})
