import { parentPort } from "node:worker_threads"
import { scanFilesystem, ScanCanceledError, type ScanProgress, type ScanResult } from "./scanner"

interface WorkerStartMessage {
  readonly type: "start"
  readonly generation: number
  readonly target: string
  readonly partialPath: string
  readonly publishedPath: string
  readonly indexDirectory: string
  readonly startupRoot: boolean
}

interface WorkerCancelMessage { readonly type: "cancel" }
type WorkerMessage = WorkerStartMessage | WorkerCancelMessage

if (!parentPort) throw new Error("Orbis scan worker requires a parent port")
const port = parentPort

let activeAbort: AbortController | undefined
port.on("message", (message: WorkerMessage) => {
  if (message.type === "cancel") {
    activeAbort?.abort()
    return
  }
  activeAbort?.abort()
  activeAbort = new AbortController()
  void run(message, activeAbort)
})

async function run(message: WorkerStartMessage, abort: AbortController): Promise<void> {
  try {
    const result = await scanFilesystem({
      generation: message.generation,
      target: message.target,
      partialPath: message.partialPath,
      publishedPath: message.publishedPath,
      indexDirectory: message.indexDirectory,
      startupRoot: message.startupRoot,
      signal: abort.signal,
      onProgress: (progress) => port.postMessage({ type: "progress", generation: message.generation, progress })
    })
    port.postMessage({ type: "complete", generation: message.generation, result })
  } catch (error) {
    if (error instanceof ScanCanceledError || abort.signal.aborted) {
      port.postMessage({ type: "canceled", generation: message.generation })
    } else {
      port.postMessage({ type: "error", generation: message.generation, error: serializeError(error) })
    }
  } finally {
    if (activeAbort === abort) {
      activeAbort = undefined
      port.close()
    }
  }
}

function serializeError(error: unknown): { readonly message: string; readonly code?: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return { message, code: (error as { code: string }).code }
  return { message }
}

export type { WorkerMessage, WorkerStartMessage, ScanProgress, ScanResult }
