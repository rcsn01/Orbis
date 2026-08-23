import { mkdir, rm } from "node:fs/promises"
import { basename, isAbsolute, normalize, resolve } from "node:path"
import type { OrbisSnapshot, ProgressSnapshot } from "@shared/contracts"
import { buildChart } from "./chart"
import { removeDatabaseFiles } from "./database"
import { DiskIndex } from "./index-store"
import type { ScanResult, ScanTotals } from "./scanner"

export interface OrbisWorker {
  postMessage(message: unknown): void
  on(event: "message", listener: (message: unknown) => void): OrbisWorker
  on(event: "error", listener: (error: unknown) => void): OrbisWorker
  on(event: "exit", listener: (code: number) => void): OrbisWorker
  terminate(): Promise<number> | void
}

export interface OrbisWorkerFactory { create(): OrbisWorker }
export interface OrbisDialog { showOpenDialog(options: { readonly properties: Array<"openDirectory"> }): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }> }
export interface OrbisShell { showItemInFolder(path: string): void; openExternal(url: string): Promise<void> }

interface WorkerProgressMessage { readonly type: "progress"; readonly generation: number; readonly progress: ProgressSnapshot }
interface WorkerCompleteMessage { readonly type: "complete"; readonly generation: number; readonly result: ScanResult }
interface WorkerCanceledMessage { readonly type: "canceled"; readonly generation: number }
interface WorkerErrorMessage { readonly type: "error"; readonly generation: number; readonly error: { readonly message: string; readonly code?: string } }
type WorkerResultMessage = WorkerProgressMessage | WorkerCompleteMessage | WorkerCanceledMessage | WorkerErrorMessage

interface ScanRun {
  readonly generation: number
  readonly partialPath: string
  readonly publishedPath: string
  readonly worker: OrbisWorker
  completed: boolean
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
  #active: DiskIndex | undefined
  #target: string
  #focusId: string | undefined
  #generation = 0
  #run: ScanRun | undefined
  #scanStatus: OrbisSnapshot["scan"] = { status: "idle", generation: 0, progress: null, totals: null, error: null }
  #listeners = new Set<(snapshot: OrbisSnapshot) => void>()
  #closed = false

  constructor(
    private readonly workers: OrbisWorkerFactory,
    options: { readonly indexDirectory: string; readonly initialTarget?: string; readonly dialog?: OrbisDialog; readonly shell?: OrbisShell }
  ) {
    this.indexDirectory = resolve(options.indexDirectory)
    this.#target = normalize(resolve(options.initialTarget ?? process.env.ORBIS_SCAN_ROOT ?? "/"))
    this.#dialog = options.dialog
    this.#shell = options.shell
  }

  #dialog: OrbisDialog | undefined
  #shell: OrbisShell | undefined

  subscribe(listener: (snapshot: OrbisSnapshot) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  snapshot(): OrbisSnapshot {
    const active = this.#active
    const focus = active && this.#focusId ? active.getNode(this.#focusId) : undefined
    const target = active?.target ?? this.#target
    const activeTotals = active ? parseTotals(active.metadata.totals) : null
    const volume = active ? parseVolume(active.metadata.volume, active.root?.sizeBytes ?? 0, active.target) : { capacityBytes: 0, freeBytes: 0, scannedBytes: 0, unscannedBytes: 0 }
    return {
      version: 1,
      target: { name: active?.root?.name ?? displayName(target), isStartup: target === "/" },
      focus: focus ? toSnapshotNode(focus) : null,
      breadcrumbs: focus && active ? active.getBreadcrumbs(focus.id) : [],
      chart: focus && active ? buildChart(active, focus, { extraRootBytes: focus.id === active.rootId && active.target === "/" ? volume.unscannedBytes : 0 }) : [],
      largestItems: focus && active ? active.getLargestItems(focus.id) : [],
      volume,
      scan: { ...this.#scanStatus, totals: this.#scanStatus.totals ?? activeTotals }
    }
  }

  async startScan(): Promise<OrbisSnapshot> { return this.startScanAt(this.#target) }

  async rescan(): Promise<OrbisSnapshot> { return this.startScanAt(this.#target) }

  async chooseFolder(): Promise<OrbisSnapshot> {
    if (!this.#dialog) throw new Error("Folder selection is unavailable")
    const result = await this.#dialog.showOpenDialog({ properties: ["openDirectory"] })
    if (!result.canceled && result.filePaths[0]) return this.startScanAt(result.filePaths[0])
    return this.snapshot()
  }

  async cancelScan(): Promise<OrbisSnapshot> {
    const run = this.#run
    if (!run) return this.snapshot()
    this.#run = undefined
    this.#scanStatus = { status: "canceled", generation: run.generation, progress: null, totals: null, error: null }
    run.worker.postMessage({ type: "cancel" })
    await Promise.resolve(run.worker.terminate())
    await removeDatabaseFiles(run.partialPath)
    await removeDatabaseFiles(run.publishedPath)
    this.#emit()
    return this.snapshot()
  }

  async focusNode(id: string): Promise<OrbisSnapshot> {
    const active = this.#active
    if (!active) throw new Error("No completed scan is available")
    const node = active.getNode(id)
    if (!node) throw new Error("Unknown Orbis node")
    if (node.kind !== "directory") throw new Error("Only directories can become the chart root")
    this.#focusId = node.id
    this.#emit()
    return this.snapshot()
  }

  async revealNode(id: string): Promise<void> {
    if (!this.#active || !this.#shell) throw new Error("No completed scan is available")
    const path = this.#active.resolvePath(id)
    if (!path) throw new Error("Unknown Orbis node")
    this.#shell.showItemInFolder(path)
  }

  async openFullDiskAccess(): Promise<void> {
    if (!this.#shell) throw new Error("Full Disk Access settings are unavailable")
    await this.#shell.openExternal("x-apple.systempreferences:com.apple.settings.PrivacySecurity_Privacy_FullDiskAccess")
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const run = this.#run
    this.#run = undefined
    if (run) {
      run.worker.postMessage({ type: "cancel" })
      await Promise.resolve(run.worker.terminate())
    }
    this.#active?.close()
    this.#active = undefined
    await rm(this.indexDirectory, { recursive: true, force: true })
    this.#listeners.clear()
  }

  private async startScanAt(value: string): Promise<OrbisSnapshot> {
    if (this.#closed) throw new Error("Orbis is shutting down")
    if (!isAbsolute(value) || value.includes("\u0000")) throw new Error("Choose an absolute folder")
    const previous = this.#run
    if (previous) {
      this.#run = undefined
      previous.worker.postMessage({ type: "cancel" })
      await Promise.resolve(previous.worker.terminate())
      await removeDatabaseFiles(previous.partialPath)
      await removeDatabaseFiles(previous.publishedPath)
    }
    await mkdir(this.indexDirectory, { recursive: true })
    const generation = ++this.#generation
    const partialPath = resolve(this.indexDirectory, `scan-${generation}.partial.sqlite`)
    const publishedPath = resolve(this.indexDirectory, `scan-${generation}.sqlite`)
    await removeDatabaseFiles(partialPath)
    await removeDatabaseFiles(publishedPath)
    const worker = this.workers.create()
    const run: ScanRun = { generation, partialPath, publishedPath, worker, completed: false }
    this.#run = run
    this.#target = normalize(resolve(value))
    this.#scanStatus = { status: "scanning", generation, progress: null, totals: null, error: null }
    this.#wireWorker(run)
    worker.postMessage({ type: "start", generation, target: this.#target, partialPath, publishedPath, indexDirectory: this.indexDirectory, startupRoot: this.#target === "/" })
    this.#emit()
    return this.snapshot()
  }

  #wireWorker(run: ScanRun): void {
    run.worker.on("message", (message) => this.#handleWorkerMessage(run, message))
    run.worker.on("error", (error) => this.#handleWorkerError(run, error))
    run.worker.on("exit", (code) => { if (this.#run?.generation === run.generation && !run.completed) this.#fail(run, code === 0 ? "The scan worker exited before completing." : `The scan worker stopped unexpectedly (code ${code}).`) })
  }

  #handleWorkerMessage(run: ScanRun, unknownMessage: unknown): void {
    if (this.#run?.generation !== run.generation || this.#closed) {
      if (isComplete(unknownMessage)) void removeDatabaseFiles(unknownMessage.result.publishedPath)
      return
    }
    const message = unknownMessage as Partial<WorkerResultMessage>
    if (message.type === "progress" && message.progress) {
      this.#scanStatus = { status: "scanning", generation: run.generation, progress: message.progress, totals: null, error: null }
      this.#emit()
    } else if (message.type === "complete" && message.result) {
      run.completed = true
      void this.#publish(run, message.result)
    } else if (message.type === "canceled") {
      this.#run = undefined
      this.#scanStatus = { status: "canceled", generation: run.generation, progress: null, totals: null, error: null }
      void removeDatabaseFiles(run.partialPath)
      void removeDatabaseFiles(run.publishedPath)
      this.#emit()
    } else if (message.type === "error" && message.error) {
      this.#fail(run, message.error.message)
    }
  }

  #handleWorkerError(run: ScanRun, error: unknown): void {
    if (this.#run?.generation !== run.generation || this.#closed) return
    this.#fail(run, error instanceof Error ? error.message : String(error))
  }

  async #publish(run: ScanRun, result: ScanResult): Promise<void> {
    if (this.#run?.generation !== run.generation || this.#closed) {
      await removeDatabaseFiles(result.publishedPath)
      return
    }
    try {
      const next = new DiskIndex(result.publishedPath)
      const old = this.#active
      this.#active = next
      this.#focusId = next.rootId
      this.#target = next.target
      this.#run = undefined
      this.#scanStatus = { status: "completed", generation: run.generation, progress: null, totals: result.totals, error: null }
      old?.close()
      if (old) await removeDatabaseFiles(old.path)
      await removeDatabaseFiles(run.partialPath)
      this.#emit()
    } catch (error) {
      await removeDatabaseFiles(result.publishedPath)
      this.#fail(run, error instanceof Error ? error.message : String(error))
    }
  }

  #fail(run: ScanRun, error: string): void {
    if (this.#run?.generation !== run.generation) return
    this.#run = undefined
    void run.worker.terminate()
    this.#scanStatus = { status: "fatal-error", generation: run.generation, progress: null, totals: null, error }
    void removeDatabaseFiles(run.partialPath)
    void removeDatabaseFiles(run.publishedPath)
    this.#emit()
  }

  #emit(): void { const snapshot = this.snapshot(); for (const listener of this.#listeners) listener(snapshot) }
}

function isComplete(value: unknown): value is WorkerCompleteMessage { return !!value && typeof value === "object" && (value as { type?: unknown }).type === "complete" && !!(value as { result?: unknown }).result }
function toSnapshotNode(node: { id: string; parentId: string | null; name: string; kind: "directory" | "file"; sizeBytes: number; directChildren: number; descendantCount: number; unreadableCount: number }) { return { id: node.id, parentId: node.parentId, name: node.name, kind: node.kind, sizeBytes: node.sizeBytes, directChildren: node.directChildren, descendantCount: node.descendantCount, unreadableCount: node.unreadableCount } }
function parseVolume(value: string | undefined, scannedBytes: number, target: string): OrbisSnapshot["volume"] {
  try {
    const parsed = JSON.parse(value ?? "{}") as { capacityBytes?: unknown; freeBytes?: unknown }
    const capacityBytes = finite(parsed.capacityBytes)
    const freeBytes = finite(parsed.freeBytes)
    const unscannedBytes = target === "/" ? Math.max(0, capacityBytes - freeBytes - scannedBytes) : 0
    return { capacityBytes, freeBytes, scannedBytes, unscannedBytes }
  } catch { return { capacityBytes: 0, freeBytes: 0, scannedBytes, unscannedBytes: 0 } }
}
function parseTotals(value: string | undefined): ScanTotals {
  try {
    const parsed = JSON.parse(value ?? "null") as Partial<ScanTotals> | null
    if (!parsed) return EMPTY_TOTALS
    return { ...EMPTY_TOTALS, ...Object.fromEntries(Object.keys(EMPTY_TOTALS).map((key) => [key, finite(parsed[key as keyof ScanTotals])])) } as ScanTotals
  } catch { return EMPTY_TOTALS }
}
function finite(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0 }
function displayName(path: string): string { return path === "/" ? "/" : basename(path) || path }
export type { WorkerResultMessage }
