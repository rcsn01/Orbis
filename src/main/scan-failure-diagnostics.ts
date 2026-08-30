import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { ConstructionCheckpointNotice } from "./construction-database"
import type { NativeAddonStatus } from "./scan-metadata"

export type ScanFailureKind =
  | "worker-error"
  | "worker-exit"
  | "worker-transport"
  | "invalid-publication"
  | "pause-timeout"
  | "host-process-ended"
  | string

export interface ScanDiagnosticsActiveRun {
  readonly generation: number
  readonly startedAt: string
  readonly updatedAt: string
  readonly resumeExpected: boolean
  readonly lifecycleStage: string
  readonly latestCheckpoint?: ConstructionCheckpointNotice
  readonly nativeAddon?: NativeAddonStatus
}

export interface ScanDiagnosticsFailure {
  readonly generation: number
  readonly occurredAt: string
  readonly kind: ScanFailureKind
  readonly resumeExpected: boolean
  readonly lifecycleStage: string
  readonly latestCheckpoint?: ConstructionCheckpointNotice
  readonly nativeAddon?: NativeAddonStatus
  readonly exitCode?: number
  readonly code?: string
}

export interface ScanFailureDiagnosticsDocument {
  readonly version: 1
  readonly activeRun?: ScanDiagnosticsActiveRun
  readonly lastFailure?: ScanDiagnosticsFailure
}

export interface ScanFailureDiagnosticsStart {
  readonly generation: number
  readonly resumeExpected: boolean
  readonly lifecycleStage?: string
  readonly startedAt?: string
}

export interface ScanFailureDiagnosticsFailureInput {
  readonly generation: number
  readonly kind: ScanFailureKind
  readonly code?: unknown
  readonly exitCode?: unknown
  readonly lifecycleStage?: string
  readonly latestCheckpoint?: ConstructionCheckpointNotice
  readonly nativeAddon?: NativeAddonStatus
}

export class ScanFailureDiagnosticsStore {
  readonly filePath: string
  readonly temporaryPath: string
  readonly #clock: () => string
  #tail: Promise<void> = Promise.resolve()
  #loaded = false
  #document: ScanFailureDiagnosticsDocument = { version: 1 }

  constructor(pathOrDirectory: string, options: { readonly clock?: () => string } = {}) {
    const resolved = resolve(pathOrDirectory)
    this.filePath = resolved.endsWith(".json") ? resolved : join(resolved, "scan-diagnostics.json")
    this.temporaryPath = `${this.filePath}.tmp`
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  async startRun(input: ScanFailureDiagnosticsStart): Promise<void> {
    await this.#enqueue(async () => {
      const previous = this.#document.activeRun
      if (previous) {
        this.#document = {
          version: 1,
          lastFailure: {
            generation: previous.generation,
            occurredAt: this.#clock(),
            kind: "host-process-ended",
            resumeExpected: previous.resumeExpected,
            lifecycleStage: previous.lifecycleStage,
            ...(previous.latestCheckpoint ? { latestCheckpoint: previous.latestCheckpoint } : {}),
            ...(previous.nativeAddon ? { nativeAddon: previous.nativeAddon } : {})
          }
        }
      }
      const startedAt = safeTimestamp(input.startedAt ?? this.#clock())
      this.#document = {
        version: 1,
        ...(this.#document.lastFailure ? { lastFailure: this.#document.lastFailure } : {}),
        activeRun: {
          generation: safeGeneration(input.generation),
          startedAt,
          updatedAt: startedAt,
          resumeExpected: Boolean(input.resumeExpected),
          lifecycleStage: safeText(input.lifecycleStage ?? "starting")
        }
      }
      await this.#persist()
    })
  }

  async setStage(generation: number, lifecycleStage: string): Promise<void> {
    await this.#enqueue(async () => {
      const run = this.#currentRun(generation)
      if (!run) return
      const stage = safeText(lifecycleStage)
      if (run.lifecycleStage === stage) return
      this.#document = { ...this.#document, activeRun: { ...run, updatedAt: this.#clock(), lifecycleStage: stage } }
      await this.#persist()
    })
  }

  async setCheckpoint(generation: number, checkpoint: ConstructionCheckpointNotice): Promise<void> {
    await this.#enqueue(async () => {
      const run = this.#currentRun(generation)
      if (!run) return
      this.#document = {
        ...this.#document,
        activeRun: { ...run, updatedAt: this.#clock(), latestCheckpoint: safeCheckpoint(checkpoint) }
      }
      await this.#persist()
    })
  }

  async setNativeAddonStatus(generation: number, status: NativeAddonStatus): Promise<void> {
    await this.#enqueue(async () => {
      const run = this.#currentRun(generation)
      if (!run) return
      const nativeAddon = safeNativeAddonStatus(status)
      if (JSON.stringify(run.nativeAddon) === JSON.stringify(nativeAddon)) return
      this.#document = {
        ...this.#document,
        activeRun: { ...run, updatedAt: this.#clock(), nativeAddon }
      }
      await this.#persist()
    })
  }

  async recordFailure(input: ScanFailureDiagnosticsFailureInput): Promise<void> {
    await this.#enqueue(async () => {
      const active = this.#document.activeRun
      if (active && active.generation !== safeGeneration(input.generation)) return
      const generation = active?.generation ?? safeGeneration(input.generation)
      const failure: ScanDiagnosticsFailure = {
        generation,
        occurredAt: this.#clock(),
        kind: safeText(input.kind),
        resumeExpected: active?.resumeExpected ?? false,
        lifecycleStage: safeText(input.lifecycleStage ?? active?.lifecycleStage ?? "failed"),
        ...((input.latestCheckpoint ?? active?.latestCheckpoint) ? { latestCheckpoint: safeCheckpoint(input.latestCheckpoint ?? active!.latestCheckpoint!) } : {}),
        ...((input.nativeAddon ?? active?.nativeAddon) ? { nativeAddon: safeNativeAddonStatus(input.nativeAddon ?? active!.nativeAddon!) } : {}),
        ...safeExitCode(input.exitCode),
        ...safeCode(input.code)
      }
      this.#document = { version: 1, lastFailure: failure }
      await this.#persist()
    })
  }

  async clearActive(generation: number): Promise<void> {
    await this.#enqueue(async () => {
      if (!this.#currentRun(generation)) return
      const { activeRun: _activeRun, ...withoutActive } = this.#document
      this.#document = withoutActive
      await this.#persist()
    })
  }

  async read(): Promise<ScanFailureDiagnosticsDocument> {
    await this.#enqueue(async () => undefined)
    return cloneDocument(this.#document)
  }

  #currentRun(generation: number): ScanDiagnosticsActiveRun | undefined {
    const run = this.#document.activeRun
    return run && run.generation === safeGeneration(generation) ? run : undefined
  }

  async #enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.#tail.then(async () => {
      if (!this.#loaded) {
        this.#document = await readDocument(this.filePath)
        this.#loaded = true
      }
      await operation()
    })
    this.#tail = task.catch(() => undefined)
    await this.#tail
  }

  async #persist(): Promise<void> {
    const value = `${JSON.stringify(this.#document)}\n`
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      const handle = await open(this.temporaryPath, "w", 0o600)
      try {
        await handle.chmod(0o600)
        await handle.writeFile(value, "utf8")
        await handle.sync()
      } finally { await handle.close() }
      await rename(this.temporaryPath, this.filePath)
      const directory = await open(dirname(this.filePath), "r")
      try { await directory.sync() } finally { await directory.close() }
    } catch {
      try { await rm(this.temporaryPath, { force: true }) } catch { /* Diagnostics are best effort. */ }
    }
  }
}

async function readDocument(path: string): Promise<ScanFailureDiagnosticsDocument> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    return isDocument(parsed) ? sanitizeDocument(parsed) : { version: 1 }
  } catch { return { version: 1 } }
}

function sanitizeDocument(document: ScanFailureDiagnosticsDocument): ScanFailureDiagnosticsDocument {
  const active = document.activeRun
  const failure = document.lastFailure
  return {
    version: 1,
    ...(active ? { activeRun: {
      generation: safeGeneration(active.generation), startedAt: safeTimestamp(active.startedAt), updatedAt: safeTimestamp(active.updatedAt),
      resumeExpected: active.resumeExpected, lifecycleStage: safeText(active.lifecycleStage),
      ...(isStoredCheckpoint(active.latestCheckpoint) ? { latestCheckpoint: safeCheckpoint(active.latestCheckpoint) } : {}),
      ...(isStoredNativeAddonStatus(active.nativeAddon) ? { nativeAddon: safeNativeAddonStatus(active.nativeAddon) } : {})
    } } : {}),
    ...(failure ? { lastFailure: {
      generation: safeGeneration(failure.generation), occurredAt: safeTimestamp(failure.occurredAt), kind: safeText(failure.kind),
      resumeExpected: failure.resumeExpected, lifecycleStage: safeText(failure.lifecycleStage),
      ...(isStoredCheckpoint(failure.latestCheckpoint) ? { latestCheckpoint: safeCheckpoint(failure.latestCheckpoint) } : {}),
      ...(isStoredNativeAddonStatus(failure.nativeAddon) ? { nativeAddon: safeNativeAddonStatus(failure.nativeAddon) } : {}),
      ...safeExitCode(failure.exitCode), ...safeCode(failure.code)
    } } : {})
  }
}

function isDocument(value: unknown): value is ScanFailureDiagnosticsDocument {
  if (!value || typeof value !== "object") return false
  const document = value as { version?: unknown; activeRun?: unknown; lastFailure?: unknown }
  return document.version === 1 && (document.activeRun === undefined || isActiveRun(document.activeRun))
    && (document.lastFailure === undefined || isFailure(document.lastFailure))
}

function isActiveRun(value: unknown): value is ScanDiagnosticsActiveRun {
  if (!value || typeof value !== "object") return false
  const run = value as Partial<ScanDiagnosticsActiveRun>
  return Number.isSafeInteger(run.generation) && typeof run.startedAt === "string" && typeof run.updatedAt === "string"
    && typeof run.resumeExpected === "boolean" && typeof run.lifecycleStage === "string"
}

function isFailure(value: unknown): value is ScanDiagnosticsFailure {
  if (!value || typeof value !== "object") return false
  const failure = value as Partial<ScanDiagnosticsFailure>
  return Number.isSafeInteger(failure.generation) && typeof failure.occurredAt === "string"
    && typeof failure.kind === "string" && typeof failure.resumeExpected === "boolean" && typeof failure.lifecycleStage === "string"
}

function cloneDocument(document: ScanFailureDiagnosticsDocument): ScanFailureDiagnosticsDocument {
  return JSON.parse(JSON.stringify(document)) as ScanFailureDiagnosticsDocument
}

function safeCheckpoint(checkpoint: ConstructionCheckpointNotice): ConstructionCheckpointNotice {
  return {
    sequence: safeNonnegativeInteger(checkpoint.sequence), reason: safeCheckpointReason(checkpoint.reason),
    phase: safeConstructionPhase(checkpoint.phase), count: safeNonnegativeInteger(checkpoint.count)
  }
}

function safeCheckpointReason(value: unknown): ConstructionCheckpointNotice["reason"] {
  return value === "startup" || value === "resume" || value === "scheduled" || value === "journal-drain" || value === "pause" || value === "finalize" ? value : "scheduled"
}
function safeConstructionPhase(value: unknown): ConstructionCheckpointNotice["phase"] {
  return value === "scanning" || value === "paused" || value === "awaiting-reconciliation" || value === "finalizing" ? value : "scanning"
}

function safeNativeAddonStatus(status: NativeAddonStatus): NativeAddonStatus {
  return {
    loadStatus: safeNativeLoadStatus(status.loadStatus),
    journalCapability: safeNativeCapability(status.journalCapability),
    metadataCapability: safeNativeCapability(status.metadataCapability),
    ...(typeof status.errorCode === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(status.errorCode) ? { errorCode: status.errorCode } : {})
  }
}
function safeNativeLoadStatus(value: unknown): NativeAddonStatus["loadStatus"] {
  return value === "not-requested" || value === "loaded" || value === "load-failed" || value === "unknown" ? value : "unknown"
}
function safeNativeCapability(value: unknown): NativeAddonStatus["journalCapability"] {
  return value === "unknown" || value === "available" || value === "missing" || value === "disabled" ? value : "unknown"
}

function isStoredCheckpoint(value: unknown): value is ConstructionCheckpointNotice {
  if (!value || typeof value !== "object") return false
  const checkpoint = value as Partial<ConstructionCheckpointNotice>
  return typeof checkpoint.sequence === "number" && typeof checkpoint.count === "number"
    && typeof checkpoint.reason === "string" && typeof checkpoint.phase === "string"
}
function isStoredNativeAddonStatus(value: unknown): value is NativeAddonStatus {
  if (!value || typeof value !== "object") return false
  const status = value as Partial<NativeAddonStatus>
  return (status.loadStatus === "not-requested" || status.loadStatus === "loaded" || status.loadStatus === "load-failed" || status.loadStatus === "unknown")
    && (status.journalCapability === "unknown" || status.journalCapability === "available" || status.journalCapability === "missing" || status.journalCapability === "disabled")
    && (status.metadataCapability === "unknown" || status.metadataCapability === "available" || status.metadataCapability === "missing" || status.metadataCapability === "disabled")
}
function safeGeneration(value: number): number { return Number.isSafeInteger(value) && value >= 0 ? value : 0 }
function safeNonnegativeInteger(value: number): number { return Number.isSafeInteger(value) && value >= 0 ? value : 0 }
function safeTimestamp(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ? value : "unknown"
}
function safeText(value: unknown): string {
  const text = String(value)
  return /^[A-Za-z0-9._-]{1,80}$/u.test(text) ? text : "unknown"
}
function safeCode(value: unknown): { readonly code?: string } {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? { code: value } : {}
}
function safeExitCode(value: unknown): { readonly exitCode?: number } {
  return typeof value === "number" && Number.isSafeInteger(value) ? { exitCode: value } : {}
}
