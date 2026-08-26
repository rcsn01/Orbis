import { parentPort, workerData } from "node:worker_threads"
import { ProgressiveScanControl, ScanCanceledError, type ScanProgress, type ScanResult } from "./scanner"
import { refreshPersistentIndex, type ActivePersistentIndex } from './refresh-engine'
import type { JournalCursor } from './index-manifest'
import { subscribeScanDiagnostics, type OrbisTimingEvent } from "./diagnostics"
import { readMetadataCursorDiagnostics, resetMetadataCursorDiagnostics, type FolderSizeEstimate, type MetadataCursorDiagnostics } from "./scan-metadata"

interface WorkerStartMessage {
  readonly type: "start"
  readonly generation: number
  readonly requestId: number
  readonly target: string
  readonly partialPath: string
  readonly publishedPath: string
  readonly indexDirectory: string
  readonly startupRoot: boolean
  readonly initialEstimate?: FolderSizeEstimate
  readonly active?: ActivePersistentIndex
}
interface WorkerCancelMessage { readonly type: "cancel"; readonly generation: number; readonly requestId: number }
interface WorkerPauseMessage { readonly type: 'pause'; readonly generation: number; readonly requestId: number }
interface WorkerFocusMessage { readonly type: "focus"; readonly generation: number; readonly requestId: number; readonly id: string }
interface WorkerResolveMessage { readonly type: "resolve-node"; readonly generation: number; readonly requestId: number; readonly id: string }
type WorkerMessage = WorkerStartMessage | WorkerCancelMessage | WorkerPauseMessage | WorkerFocusMessage | WorkerResolveMessage

if (!parentPort) throw new Error("Orbis scan worker requires a parent port")
const port = parentPort

let active: { readonly generation: number; readonly abort: AbortController; readonly control: ProgressiveScanControl; lastRequestId: number; pauseRequestId?: number; checkpointSequence: number; checkpointCount: number } | undefined
port.on("message", (message: WorkerMessage) => {
  if (message.type === "start") {
    if (active && (message.generation < active.generation || message.generation === active.generation && message.requestId <= active.lastRequestId)) return
    active?.abort.abort()
    const run = { generation: message.generation, abort: new AbortController(), control: new ProgressiveScanControl(), lastRequestId: message.requestId, checkpointSequence: 0, checkpointCount: 0 }
    active = run
    void execute(message, run)
    return
  }
  if (message.type === "cancel" || message.type === 'pause') {
    if (acceptRequest(message)) {
      if (message.type === 'pause') active!.pauseRequestId = message.requestId
      active!.abort.abort()
    }
    return
  }
  if (message.type === "focus") {
    const accepted = acceptRequest(message) && active!.control.focus(message.id)
    port.postMessage({ type: "focus-accepted", generation: message.generation, requestId: message.requestId, accepted: Boolean(accepted) })
    return
  }
  if (message.type === "resolve-node") {
    const path = acceptRequest(message) ? active!.control.resolveNode(message.id) : undefined
    port.postMessage({ type: "resolved-node", generation: message.generation, requestId: message.requestId, path: path ?? null })
    return
  }
})

function acceptRequest(message: { readonly generation: number; readonly requestId: number }): boolean {
  if (!active || active.generation !== message.generation || message.requestId <= active.lastRequestId) return false
  active.lastRequestId = message.requestId
  return true
}

async function execute(message: WorkerStartMessage, run: NonNullable<typeof active>): Promise<void> {
  const timings: OrbisTimingEvent[] | undefined = process.env.ORBIS_SCAN_DIAGNOSTICS === "1" ? [] : undefined
  if (timings) resetMetadataCursorDiagnostics()
  const unsubscribe = timings ? subscribeScanDiagnostics((event) => { if (event.generation === message.generation) timings.push(event) }) : undefined
  try {
    const outcome = await refreshPersistentIndex({
      generation: message.generation, target: message.target, partialPath: message.partialPath, publishedPath: message.publishedPath,
      indexDirectory: message.indexDirectory, startupRoot: message.startupRoot,
      ...(message.initialEstimate ? { initialEstimate: message.initialEstimate } : {}),
      ...(message.active ? { active: message.active } : {}),
      signal: run.abort.signal, control: run.control,
      ...nativeAddonPath(), ...referenceScan(),
      onCheckpoint: (sequence) => { run.checkpointSequence = sequence; run.checkpointCount += 1 },
      onProgress: (progress) => { if (active === run) port.postMessage({ type: "progress", generation: message.generation, requestId: run.lastRequestId, progress }) },
      onPreview: (preview) => { if (active === run) port.postMessage({ type: "preview", generation: message.generation, requestId: run.lastRequestId, preview }) }
    })
    if (active !== run) return
    postDiagnostics(message.generation, run.lastRequestId, run.checkpointCount, timings)
    if (outcome.kind === 'unchanged') {
      port.postMessage({ type: 'unchanged', generation: message.generation, requestId: run.lastRequestId, journal: outcome.journal, totals: outcome.totals, basePublicationId: outcome.basePublicationId })
    } else {
      port.postMessage({
        type: 'complete', generation: message.generation, requestId: run.lastRequestId, result: outcome.result,
        refresh: { strategy: outcome.strategy, journal: outcome.journal, ...(outcome.basePublicationId ? { basePublicationId: outcome.basePublicationId } : {}), ...(outcome.fallbackReason ? { fallbackReason: outcome.fallbackReason } : {}), ...(isReferenceScan() ? { reference: true as const } : {}) }
      })
    }
  } catch (error) {
    if (active !== run) return
    postDiagnostics(message.generation, run.lastRequestId, run.checkpointCount, timings)
    if (error instanceof ScanCanceledError || run.abort.signal.aborted) {
      if (run.pauseRequestId !== undefined) port.postMessage({ type: 'paused', generation: message.generation, requestId: run.pauseRequestId, checkpointSequence: run.checkpointSequence })
      else port.postMessage({ type: "canceled", generation: message.generation, requestId: run.lastRequestId })
    }
    else port.postMessage({ type: "error", generation: message.generation, requestId: run.lastRequestId, error: serializeError(error) })
  } finally {
    unsubscribe?.()
    if (active === run) { active = undefined; port.close() }
  }
}

function postDiagnostics(generation: number, requestId: number, checkpointCount: number, timings: readonly OrbisTimingEvent[] | undefined): void {
  if (timings) port.postMessage({
    type: "diagnostics", generation, requestId, timings, checkpointCount,
    counters: readMetadataCursorDiagnostics() satisfies MetadataCursorDiagnostics
  })
}
function nativeAddonPath(): { readonly nativeAddonPath?: string } {
  const value = workerData && typeof workerData === "object" && "nativeAddonPath" in workerData ? (workerData as { nativeAddonPath?: unknown }).nativeAddonPath : undefined
  return typeof value === "string" && value.length > 0 ? { nativeAddonPath: value } : {}
}
function referenceScan(): { readonly referenceScan?: true } { return isReferenceScan() ? { referenceScan: true } : {} }
function isReferenceScan(): boolean {
  return Boolean(workerData && typeof workerData === "object" && "referenceScan" in workerData && (workerData as { referenceScan?: unknown }).referenceScan === true)
}

function serializeError(error: unknown): { readonly message: string; readonly code?: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return { message, code: (error as { code: string }).code }
  return { message }
}

export type { WorkerMessage, WorkerStartMessage, ScanProgress, ScanResult, JournalCursor }
