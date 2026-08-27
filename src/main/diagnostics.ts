import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'
import { performance } from 'node:perf_hooks'

export interface OrbisTimingEvent {
  readonly scope: 'scan' | 'controller'
  readonly phase: string
  readonly durationMs: number
  readonly generation: number
}

export const RESUME_SCAN_PHASES = [
  'resume-load-total', 'resume-history-validation', 'resume-database-open', 'resume-incomplete-recovery',
  'resume-semantic-totals', 'resume-checkpoint',
  'resume-descriptor-validation', 'resume-file-validation', 'resume-candidate-validation',
  'resume-construction-validation', 'resume-integrity-check', 'resume-foreign-key-check',
  'resume-hardlink-repair', 'resume-aggregate-repair', 'resume-scheduler-repair',
  'resume-first-metadata-page'
] as const

export const RESUME_SCAN_WORK_PHASES = [
  'resume-descriptor-validation', 'resume-file-validation', 'resume-candidate-validation',
  'resume-construction-validation', 'resume-integrity-check', 'resume-foreign-key-check',
  'resume-hardlink-repair', 'resume-aggregate-repair', 'resume-scheduler-repair'
] as const

export const RESUME_SCAN_MILESTONE_PHASES = ['resume-first-metadata-page'] as const

export const RESUME_CONTROLLER_PHASES = [
  'resume-click-to-session', 'resume-click-to-preparation', 'resume-click-to-first-progress',
  'resume-click-to-first-metadata-page', 'resume-click-to-first-metadata-preview'
] as const

export type ResumeMilestone = 'preparation-started' | 'first-metadata-page' | 'first-metadata-preview'

export const RESUME_RECEIPT_FALLBACK_REASONS = [
  'malformed-receipt', 'descriptor-mismatch', 'target-mismatch', 'target-identity-mismatch',
  'index-directory-identity-mismatch', 'artifact-presence-mismatch', 'database-stamp-mismatch',
  'sidecar-stamp-mismatch', 'resume-row-mismatch', 'candidate-metadata-mismatch',
  'sqlite-validation-failed', 'validation-race', 'unacknowledged-journal-state'
] as const
export type ResumeReceiptFallbackReason = typeof RESUME_RECEIPT_FALLBACK_REASONS[number]

export interface OrbisResumeReceiptFallbackEvent {
  readonly scope: 'scan'
  readonly kind: 'resume-receipt-fallback'
  readonly reason: ResumeReceiptFallbackReason
  readonly generation: number
}

type ResumeReceiptFallbackListener = (event: OrbisResumeReceiptFallbackEvent) => void

export const RESUME_PREPARATION_PHASES = [
  'validating', 'history', 'recovering', 'repairing', 'starting'
] as const
export type ResumePreparationPhase = typeof RESUME_PREPARATION_PHASES[number]

export const RESUME_PREPARATION_MESSAGES: Readonly<Record<ResumePreparationPhase, string>> = Object.freeze({
  validating: 'Validating saved scan',
  history: 'Checking filesystem changes',
  recovering: 'Preparing interrupted directories',
  repairing: 'Repairing saved index',
  starting: 'Starting filesystem traversal'
})

export function isResumePreparationPhase(value: unknown): value is ResumePreparationPhase {
  return typeof value === 'string' && (RESUME_PREPARATION_PHASES as readonly string[]).includes(value)
}

export const SCAN_COUNTER_NAMES = [
  'fullScanAttempts', 'fullScanRetries', 'nativePageReads', 'nodePageReads', 'nativePayloadBytes',
  'metadataEntries', 'metadataBatchFlushes', 'metadataRowsFlushed', 'schedulerSelects',
  'completionTransitions', 'databaseCheckpoints', 'hardlinkPathRows',
  'resumeFullValidations', 'resumeReceiptValidations', 'resumeReceiptFallbacks', 'resumeRecoveryRoots',
  'resumeDeletedNodes', 'resumeAffectedHardlinkIdentities', 'resumeRepairedAncestors',
  'resumeRepairedSchedulerRows', 'resumeReplayedEntries'
] as const
export type ScanCounterName = typeof SCAN_COUNTER_NAMES[number]
export type ScanCounterRecord = Readonly<Record<ScanCounterName, number>>

export interface OrbisCounterEvent {
  readonly scope: 'scan'
  readonly counter: ScanCounterName
  readonly value: number
  readonly generation: number
}

type TimingListener = (event: OrbisTimingEvent) => void
type CounterListener = (event: OrbisCounterEvent) => void

export interface ScanTimingAccumulator {
  measure<T>(operation: () => T): T
  measureAsync<T>(operation: () => Promise<T>): Promise<T>
  publish(): void
}

export interface ScanTimingMilestones { mark(phase: string): void }
export interface ControllerTimingMilestones { mark(generation: number, phase: string): void }

const scanChannel = channel('orbis.scan.timing')
const counterChannel = channel('orbis.scan.counter')
const controllerChannel = channel('orbis.controller.timing')
const resumeReceiptFallbackChannel = channel('orbis.scan.resume-receipt-fallback')
const scanContext = new AsyncLocalStorage<{ readonly generation: number; readonly workDurations: Map<string, number> }>()

export function runWithScanDiagnostics<T>(generation: number, operation: () => T): T {
  if (!scanChannel.hasSubscribers && !counterChannel.hasSubscribers && !resumeReceiptFallbackChannel.hasSubscribers) return operation()
  return scanContext.run({ generation, workDurations: new Map() }, operation)
}

export function emptyScanCounters(): Record<ScanCounterName, number> {
  return Object.fromEntries(SCAN_COUNTER_NAMES.map((name) => [name, 0])) as Record<ScanCounterName, number>
}

export function recordScanCounter(counter: ScanCounterName, value = 1): void {
  if (!counterChannel.hasSubscribers || !Number.isFinite(value) || value <= 0) return
  const context = scanContext.getStore()
  if (!context) return
  counterChannel.publish({ scope: 'scan', counter, value, generation: context.generation } satisfies OrbisCounterEvent)
}

export function measureScanWork<T>(phase: string, operation: () => T): T {
  if (!scanChannel.hasSubscribers) return operation()
  const startedAt = performance.now()
  try { return operation() }
  finally {
    const context = scanContext.getStore()
    if (context) context.workDurations.set(phase, (context.workDurations.get(phase) ?? 0) + performance.now() - startedAt)
  }
}

export function publishScanWork(phase: string): void {
  const context = scanContext.getStore()
  publishScan(phase, context?.workDurations.get(phase) ?? 0)
}

export function createScanTimingMilestones(now: () => number = () => performance.now()): ScanTimingMilestones {
  if (!scanChannel.hasSubscribers) return { mark: () => undefined }
  const startedAt = now()
  const published = new Set<string>()
  return {
    mark: (phase): void => {
      if (published.has(phase)) return
      published.add(phase)
      publishScan(phase, Math.max(0, now() - startedAt))
    }
  }
}

export function createControllerTimingMilestones(now: () => number = () => performance.now()): ControllerTimingMilestones {
  if (!controllerChannel.hasSubscribers) return { mark: () => undefined }
  const startedAt = now()
  const published = new Set<string>()
  return {
    mark: (generation, phase): void => {
      if (published.has(phase)) return
      published.add(phase)
      controllerChannel.publish({ scope: 'controller', phase, durationMs: Math.max(0, now() - startedAt), generation } satisfies OrbisTimingEvent)
    }
  }
}

export function createScanTimingAccumulator(phase: string): ScanTimingAccumulator {
  let durationMs = 0
  return {
    measure: <T>(operation: () => T): T => {
      if (!scanChannel.hasSubscribers) return operation()
      const startedAt = performance.now()
      try { return operation() }
      finally { durationMs += performance.now() - startedAt }
    },
    measureAsync: async <T>(operation: () => Promise<T>): Promise<T> => {
      if (!scanChannel.hasSubscribers) return operation()
      const startedAt = performance.now()
      try { return await operation() }
      finally { durationMs += performance.now() - startedAt }
    },
    publish: (): void => publishScan(phase, durationMs)
  }
}

export function measureScan<T>(phase: string, operation: () => T): T {
  if (!scanChannel.hasSubscribers) return operation()
  const startedAt = performance.now()
  try { return operation() }
  finally { publishScan(phase, performance.now() - startedAt) }
}

export async function measureScanAsync<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  if (!scanChannel.hasSubscribers) return operation()
  const startedAt = performance.now()
  try { return await operation() }
  finally { publishScan(phase, performance.now() - startedAt) }
}

export function measureController<T>(generation: number, phase: string, operation: () => T): T {
  if (!controllerChannel.hasSubscribers) return operation()
  const startedAt = performance.now()
  try { return operation() }
  finally { controllerChannel.publish({ scope: 'controller', phase, durationMs: performance.now() - startedAt, generation } satisfies OrbisTimingEvent) }
}

export async function measureControllerAsync<T>(generation: number, phase: string, operation: () => Promise<T>): Promise<T> {
  if (!controllerChannel.hasSubscribers) return operation()
  const startedAt = performance.now()
  try { return await operation() }
  finally { controllerChannel.publish({ scope: 'controller', phase, durationMs: performance.now() - startedAt, generation } satisfies OrbisTimingEvent) }
}

export function subscribeScanDiagnostics(listener: TimingListener): () => void {
  const subscription = (message: unknown): void => listener(message as OrbisTimingEvent)
  scanChannel.subscribe(subscription)
  return () => scanChannel.unsubscribe(subscription)
}

export function subscribeScanCounters(listener: CounterListener): () => void {
  const subscription = (message: unknown): void => listener(message as OrbisCounterEvent)
  counterChannel.subscribe(subscription)
  return () => counterChannel.unsubscribe(subscription)
}

export function publishResumeReceiptFallback(reason: ResumeReceiptFallbackReason): void {
  const context = scanContext.getStore()
  if (!context) return
  resumeReceiptFallbackChannel.publish({ scope: 'scan', kind: 'resume-receipt-fallback', reason, generation: context.generation } satisfies OrbisResumeReceiptFallbackEvent)
}

export function subscribeResumeReceiptFallbacks(listener: ResumeReceiptFallbackListener): () => void {
  const subscription = (message: unknown): void => listener(message as OrbisResumeReceiptFallbackEvent)
  resumeReceiptFallbackChannel.subscribe(subscription)
  return () => resumeReceiptFallbackChannel.unsubscribe(subscription)
}

export function subscribeControllerDiagnostics(listener: TimingListener): () => void {
  const subscription = (message: unknown): void => listener(message as OrbisTimingEvent)
  controllerChannel.subscribe(subscription)
  return () => controllerChannel.unsubscribe(subscription)
}

function publishScan(phase: string, durationMs: number): void {
  const context = scanContext.getStore()
  if (!context) return
  scanChannel.publish({ scope: 'scan', phase, durationMs, generation: context.generation } satisfies OrbisTimingEvent)
}
