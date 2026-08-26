import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'
import { performance } from 'node:perf_hooks'

export interface OrbisTimingEvent {
  readonly scope: 'scan' | 'controller'
  readonly phase: string
  readonly durationMs: number
  readonly generation: number
}

type TimingListener = (event: OrbisTimingEvent) => void

export interface ScanTimingAccumulator {
  measure<T>(operation: () => T): T
  publish(): void
}

const scanChannel = channel('orbis.scan.timing')
const controllerChannel = channel('orbis.controller.timing')
const scanContext = new AsyncLocalStorage<{ readonly generation: number }>()

export function runWithScanDiagnostics<T>(generation: number, operation: () => T): T {
  if (!scanChannel.hasSubscribers) return operation()
  return scanContext.run({ generation }, operation)
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
