import type { ProgressSnapshot } from '../shared/contracts'
import type { OrbisTimingEvent, ResumeMilestone, ResumePreparationPhase, ResumeReceiptFallbackReason, ScanCounterRecord } from './diagnostics'
import type { JournalCursor } from './index-manifest'
import type { FolderSizeEstimate, NativeAddonStatus } from './scan-metadata'
import type { ConstructionCheckpointNotice } from './construction-database'
import type { ProgressivePreview, ScanResult, ScanTotals } from './scanner'
import type { ActivePersistentIndex } from './refresh-engine'
import type { ResumeValidationReceipt } from './full-scan-resume'

export interface WorkerStartMessage {
  readonly type: 'start'
  readonly generation: number
  readonly requestId: number
  readonly target: string
  readonly partialPath: string
  readonly publishedPath: string
  readonly indexDirectory: string
  readonly startupRoot: boolean
  readonly resumeExpected: boolean
  readonly resumeReceipt?: ResumeValidationReceipt
  readonly initialEstimate?: FolderSizeEstimate
  readonly active?: ActivePersistentIndex
}

export interface WorkerCancelMessage { readonly type: 'cancel'; readonly generation: number; readonly requestId: number }
export interface WorkerPauseMessage { readonly type: 'pause'; readonly generation: number; readonly requestId: number }
export interface WorkerFocusMessage { readonly type: 'focus'; readonly generation: number; readonly requestId: number; readonly id: string }
export interface WorkerResolveMessage { readonly type: 'resolve-node'; readonly generation: number; readonly requestId: number; readonly id: string }
export type WorkerMessage = WorkerStartMessage | WorkerCancelMessage | WorkerPauseMessage | WorkerFocusMessage | WorkerResolveMessage

export interface WorkerProgressMessage { readonly type: 'progress'; readonly generation: number; readonly requestId: number; readonly progress: ProgressSnapshot }
export interface WorkerPreviewMessage { readonly type: 'preview'; readonly generation: number; readonly requestId: number; readonly preview: ProgressivePreview }
export interface WorkerResumeMilestoneMessage { readonly type: 'resume-milestone'; readonly generation: number; readonly requestId: number; readonly milestone: ResumeMilestone }
export interface WorkerResumePreparationMessage { readonly type: 'resume-preparation'; readonly generation: number; readonly requestId: number; readonly phase: ResumePreparationPhase }
export interface WorkerCheckpointMessage { readonly type: 'checkpoint'; readonly generation: number; readonly requestId: number; readonly checkpoint: ConstructionCheckpointNotice }
export interface WorkerNativeAddonStatusMessage { readonly type: 'native-addon-status'; readonly generation: number; readonly requestId: number; readonly status: NativeAddonStatus }
export interface WorkerResolvedNodeMessage { readonly type: 'resolved-node'; readonly generation: number; readonly requestId: number; readonly path: string | null }
export interface WorkerFocusAcceptedMessage { readonly type: 'focus-accepted'; readonly generation: number; readonly requestId: number; readonly accepted: boolean }
export interface WorkerCompleteMessage {
  readonly type: 'complete'
  readonly generation: number
  readonly requestId: number
  readonly result: ScanResult
  readonly refresh?: {
    readonly strategy: 'full' | 'incremental'
    readonly journal: JournalCursor | null
    readonly basePublicationId?: string
    readonly fallbackReason?: string
    readonly reference?: true
  }
}
export interface WorkerUnchangedMessage { readonly type: 'unchanged'; readonly generation: number; readonly requestId: number; readonly journal: JournalCursor; readonly totals: ScanTotals; readonly basePublicationId: string }
export interface WorkerCanceledMessage { readonly type: 'canceled'; readonly generation: number; readonly requestId: number }
export interface WorkerPausedMessage { readonly type: 'paused'; readonly generation: number; readonly requestId: number; readonly checkpointSequence: number }
export interface WorkerErrorMessage { readonly type: 'error'; readonly generation: number; readonly requestId: number; readonly error: { readonly message: string; readonly code?: string } }
export interface WorkerDiagnosticsMessage {
  readonly type: 'diagnostics'
  readonly generation: number
  readonly requestId: number
  readonly timings: readonly OrbisTimingEvent[]
  readonly checkpointCount: number
  readonly counters: ScanCounterRecord
  readonly resumeReceiptFallbackReasons?: readonly ResumeReceiptFallbackReason[]
}
export type WorkerResultMessage = WorkerProgressMessage | WorkerPreviewMessage | WorkerResumeMilestoneMessage | WorkerResumePreparationMessage | WorkerCheckpointMessage | WorkerNativeAddonStatusMessage | WorkerResolvedNodeMessage | WorkerFocusAcceptedMessage | WorkerCompleteMessage | WorkerUnchangedMessage | WorkerCanceledMessage | WorkerPausedMessage | WorkerErrorMessage | WorkerDiagnosticsMessage
