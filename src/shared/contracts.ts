export type ScanStage = "traversing" | "indexing"
export type ScanStatus = "idle" | "scanning" | "completed" | "canceled" | "fatal-error"
export type NodeKind = "directory" | "file"

export interface NodeSummary {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly kind: NodeKind
  readonly sizeBytes: number
  readonly directChildren: number
  readonly descendantCount: number
  readonly unreadableCount: number
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
  readonly percentage: number
  readonly drillable: boolean
  readonly colorKey: string
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
}

export interface VolumeSnapshot {
  readonly capacityBytes: number
  readonly freeBytes: number
  readonly scannedBytes: number
  readonly unscannedBytes: number
}

export interface OrbisSnapshot {
  readonly version: 1
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
  }
}

export interface OrbisApi {
  getSnapshot(): Promise<OrbisSnapshot>
  startScan(): Promise<OrbisSnapshot>
  chooseFolder(): Promise<OrbisSnapshot>
  cancelScan(): Promise<OrbisSnapshot>
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
  rescan: "orbis:rescan",
  focusNode: "orbis:focus-node",
  revealNode: "orbis:reveal-node",
  openFullDiskAccess: "orbis:open-full-disk-access",
  snapshot: "orbis:snapshot"
} as const

export function isNodeId(value: unknown): value is string {
  return typeof value === "string" && /^n-[a-z0-9]+$/u.test(value) && value.length <= 80
}
