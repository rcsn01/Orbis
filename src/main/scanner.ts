import {
  scanFilesystem as scanFilesystemLegacy,
  type ScanOptions as LegacyScanOptions,
  type ScanResult
} from "./legacy-scanner"
import { ProgressiveScanControl, scanFilesystemProgressive, type ProgressivePreview } from "./progressive-scanner"
import type { DirectoryMetadataSource, FolderSizeEstimate, NativeAddonProbe } from "./scan-metadata"
import type { ConstructionCheckpointNotice } from './construction-database'
import type { ResumeMilestone, ResumePreparationPhase } from './diagnostics'
import type { FullScanResumeDescriptor, FullScanResumeStore } from './full-scan-resume'
import { canUseNativeScanner, scanFilesystemNative } from './native-scanner'

export interface ScanOptions extends LegacyScanOptions {
  readonly control?: ProgressiveScanControl
  readonly onPreview?: (preview: ProgressivePreview) => void
  readonly initialEstimate?: FolderSizeEstimate
  readonly directoryMetadataSource?: DirectoryMetadataSource
  readonly nativeAddonPath?: string
  /** Internal traversal tuning used by tests and benchmarks. */
  readonly metadataBatchSize?: number
  readonly resumable?: { readonly descriptor: FullScanResumeDescriptor; readonly store: FullScanResumeStore; readonly resume: boolean }
  /** Legacy sequence callback; new consumers should use onCheckpointNotice. */
  readonly onCheckpoint?: (sequence: number) => void
  readonly onCheckpointNotice?: (notice: ConstructionCheckpointNotice) => void
  readonly onResumeMilestone?: (milestone: ResumeMilestone) => void
  readonly onResumePreparation?: (phase: ResumePreparationPhase) => void | Promise<void>
  readonly onMetadataPageAccepted?: () => void
  readonly onNativeAddonStatus?: NativeAddonProbe
  /** Benchmark-only reference implementation; production callers must omit it. */
  readonly referenceScan?: boolean
  readonly drainResumeJournal?: (eventId: string) => { readonly throughEventId: string; readonly scopes: readonly string[]; readonly restartReason?: string }
}

export async function scanFilesystem(options: ScanOptions): Promise<ScanResult> {
  if (options.referenceScan === true) return scanFilesystemLegacy(options)
  if (await canUseNativeScanner(options)) return scanFilesystemNative(options)
  const control = options.control ?? new ProgressiveScanControl()
  return scanFilesystemProgressive({ ...options, control })
}

export * from "./legacy-scanner"
export { ProgressiveScanControl }
export type { ProgressivePreview }
