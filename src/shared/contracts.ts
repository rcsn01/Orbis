export type ScanStage = "traversing" | "indexing"
export type ScanStatus = "idle" | "scanning" | "completed" | "canceled" | "fatal-error"
export type NodeKind = "directory" | "file"
export type DirectoryScanState = "queued" | "scanning" | "complete" | "unreadable"
export type SizeAccuracy = "estimated" | "partial" | "exact"

export interface NodeSummary {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly kind: NodeKind
  readonly sizeBytes: number
  /** Pinned provisional value shown while exact traversal continues. */
  readonly estimatedSizeBytes?: number
  readonly directChildren: number
  readonly descendantCount: number
  readonly unreadableCount: number
  readonly scanState: DirectoryScanState
  readonly sizeAccuracy: SizeAccuracy
}

export interface Breadcrumb {
  readonly id: string
  readonly name: string
}

export interface ChartSegment {
  readonly id: string | null
  readonly name: string
  readonly kind: NodeKind | "other" | "unavailable"
  readonly depth: number
  readonly startAngle: number
  readonly endAngle: number
  readonly sizeBytes: number
  readonly estimatedSizeBytes?: number
  readonly percentage: number
  /** Number of concrete children represented by an aggregate segment. */
  readonly itemCount?: number
  readonly drillable: boolean
  readonly colorKey: string
  readonly scanState: DirectoryScanState
  readonly sizeAccuracy: SizeAccuracy
}

export interface ProgressSnapshot {
  readonly stage: ScanStage
  readonly scannedItems: number
  readonly discoveredBytes: number
  readonly elapsedMs: number
  readonly currentItem: string
}

export interface ScanTotals {
  readonly scannedItems: number
  readonly discoveredBytes: number
  readonly elapsedMs: number
  readonly skippedItems: number
  readonly unreadableItems: number
  readonly nestedMounts: number
  readonly symlinks: number
  readonly duplicateHardLinks: number
  readonly disappearingItems: number
  readonly bulkMetadataEntries?: number
  readonly fallbackMetadataEntries?: number
}

export interface VolumeSnapshot {
  readonly capacityBytes: number
  readonly freeBytes: number
  readonly scannedBytes: number
  readonly unscannedBytes: number
  readonly sizeAccuracy: SizeAccuracy
}

export interface OrbisSnapshot {
  readonly version: 3
  readonly committed: boolean
  readonly target: { readonly name: string; readonly isStartup: boolean }
  readonly focus: NodeSummary | null
  readonly breadcrumbs: readonly Breadcrumb[]
  readonly chart: readonly ChartSegment[]
  readonly largestItems: readonly NodeSummary[]
  readonly volume: VolumeSnapshot
  readonly scan: {
    readonly status: ScanStatus
    readonly generation: number
    readonly progress: ProgressSnapshot | null
    readonly totals: ScanTotals | null
    readonly error: string | null
    readonly resume?: { readonly available: boolean; readonly checkpointedAt: string }
  }
}

export interface OrbisApi {
  getSnapshot(): Promise<OrbisSnapshot>
  startScan(): Promise<OrbisSnapshot>
  chooseFolder(): Promise<OrbisSnapshot>
  cancelScan(): Promise<OrbisSnapshot>
  discardSavedScan(): Promise<OrbisSnapshot>
  rescan(): Promise<OrbisSnapshot>
  focusNode(id: string): Promise<OrbisSnapshot>
  revealNode(id: string): Promise<void>
  openFullDiskAccess(): Promise<void>
  subscribe(listener: (snapshot: OrbisSnapshot) => void): () => void
}

export const IPC = {
  getSnapshot: "orbis:get-snapshot",
  startScan: "orbis:start-scan",
  chooseFolder: "orbis:choose-folder",
  cancelScan: "orbis:cancel-scan",
  discardSavedScan: "orbis:discard-saved-scan",
  rescan: "orbis:rescan",
  focusNode: "orbis:focus-node",
  revealNode: "orbis:reveal-node",
  openFullDiskAccess: "orbis:open-full-disk-access",
  snapshot: "orbis:snapshot"
} as const

export function isNodeId(value: unknown): value is string {
  return typeof value === "string" && /^n-[a-z0-9]+$/u.test(value) && value.length <= 80
}

export function isSizeAccuracy(value: unknown): value is SizeAccuracy {
  return value === "estimated" || value === "partial" || value === "exact"
}

export function isOrbisSnapshot(value: unknown): value is OrbisSnapshot {
  if (!isRecord(value) || value.version !== 3 || typeof value.committed !== "boolean") return false
  if (!isRecord(value.target) || typeof value.target.name !== "string" || typeof value.target.isStartup !== "boolean") return false
  if (value.focus !== null && !isNodeSummary(value.focus)) return false
  if (!Array.isArray(value.breadcrumbs) || !value.breadcrumbs.every(isBreadcrumb)) return false
  if (!Array.isArray(value.chart) || !value.chart.every(isChartSegment)) return false
  if (!Array.isArray(value.largestItems) || !value.largestItems.every(isNodeSummary)) return false
  if (!isVolume(value.volume) || !isScan(value.scan)) return false
  return true
}

function isScan(value: unknown): boolean {
  if (!isRecord(value)) return false
  const statuses: readonly ScanStatus[] = ["idle", "scanning", "completed", "canceled", "fatal-error"]
  if (!statuses.includes(value.status as ScanStatus) || !integer(value.generation) || value.generation < 0) return false
  if (value.progress !== null && !isProgress(value.progress)) return false
  if (value.totals !== null && !isTotals(value.totals)) return false
  if (value.resume !== undefined && (!isRecord(value.resume) || typeof value.resume.available !== 'boolean' || typeof value.resume.checkpointedAt !== 'string')) return false
  return value.error === null || typeof value.error === "string"
}

function isProgress(value: unknown): boolean {
  if (!isRecord(value) || (value.stage !== "traversing" && value.stage !== "indexing")) return false
  return integer(value.scannedItems) && nonnegative(value.scannedItems) && finite(value.discoveredBytes) && nonnegative(value.discoveredBytes)
    && finite(value.elapsedMs) && nonnegative(value.elapsedMs) && typeof value.currentItem === "string"
}

function isTotals(value: unknown): boolean {
  if (!isRecord(value)) return false
  const required = ["scannedItems", "discoveredBytes", "elapsedMs", "skippedItems", "unreadableItems", "nestedMounts", "symlinks", "duplicateHardLinks", "disappearingItems"] as const
  return required.every((key) => finite(value[key]) && nonnegative(value[key]))
}

function isVolume(value: unknown): value is VolumeSnapshot {
  return isRecord(value) && finite(value.capacityBytes) && nonnegative(value.capacityBytes) && finite(value.freeBytes) && nonnegative(value.freeBytes)
    && finite(value.scannedBytes) && nonnegative(value.scannedBytes) && finite(value.unscannedBytes) && nonnegative(value.unscannedBytes) && isSizeAccuracy(value.sizeAccuracy)
}

function isNodeSummary(value: unknown): value is NodeSummary {
  return isRecord(value) && isNodeId(value.id) && (value.parentId === null || isNodeId(value.parentId)) && typeof value.name === "string"
    && (value.kind === "directory" || value.kind === "file") && finite(value.sizeBytes) && nonnegative(value.sizeBytes)
    && (value.estimatedSizeBytes === undefined || finite(value.estimatedSizeBytes) && nonnegative(value.estimatedSizeBytes))
    && integer(value.directChildren) && nonnegative(value.directChildren) && integer(value.descendantCount) && nonnegative(value.descendantCount)
    && integer(value.unreadableCount) && nonnegative(value.unreadableCount) && isDirectoryScanState(value.scanState) && isSizeAccuracy(value.sizeAccuracy)
}

function isBreadcrumb(value: unknown): value is Breadcrumb { return isRecord(value) && isNodeId(value.id) && typeof value.name === "string" }

function isChartSegment(value: unknown): value is ChartSegment {
  return isRecord(value) && (value.id === null || isNodeId(value.id)) && typeof value.name === "string"
    && (value.kind === "directory" || value.kind === "file" || value.kind === "other" || value.kind === "unavailable")
    && integer(value.depth) && value.depth > 0 && finite(value.startAngle) && finite(value.endAngle) && value.endAngle >= value.startAngle
    && finite(value.sizeBytes) && nonnegative(value.sizeBytes)
    && (value.estimatedSizeBytes === undefined || finite(value.estimatedSizeBytes) && nonnegative(value.estimatedSizeBytes))
    && finite(value.percentage) && nonnegative(value.percentage)
    && (value.itemCount === undefined || integer(value.itemCount) && nonnegative(value.itemCount))
    && typeof value.drillable === "boolean" && typeof value.colorKey === "string" && isDirectoryScanState(value.scanState) && isSizeAccuracy(value.sizeAccuracy)
    && (value.drillable ? value.id !== null && value.kind === "directory" : true)
}

function isDirectoryScanState(value: unknown): value is DirectoryScanState { return value === "queued" || value === "scanning" || value === "complete" || value === "unreadable" }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) }
function integer(value: unknown): value is number { return finite(value) && Number.isInteger(value) }
function nonnegative(value: unknown): value is number { return finite(value) && value >= 0 }
