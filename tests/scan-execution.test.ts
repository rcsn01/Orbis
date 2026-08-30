import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  WorkerScanExecution, type ScanExecutionRequest, type ScanUpdate, type WorkerTransport
} from '../src/main/scan-execution'
import type { WorkerStartMessage } from '../src/main/scan-execution-protocol'
import type { ResumeValidationReceipt } from '../src/main/full-scan-resume'
import type { ProgressivePreview, ScanResult } from '../src/main/scanner'
import { ScanFailureDiagnosticsStore } from '../src/main/scan-failure-diagnostics'

class FakeWorker implements WorkerTransport {
  readonly messages: unknown[] = []
  readonly #messageListeners: Array<(message: unknown) => void> = []
  readonly #errorListeners: Array<(error: unknown) => void> = []
  readonly #exitListeners: Array<(code: number) => void> = []
  terminated = 0
  onPost?: (message: unknown) => void

  postMessage(message: unknown): void { this.messages.push(message); this.onPost?.(message) }
  on(event: 'message', listener: (message: unknown) => void): WorkerTransport
  on(event: 'error', listener: (error: unknown) => void): WorkerTransport
  on(event: 'exit', listener: (code: number) => void): WorkerTransport
  on(event: 'message' | 'error' | 'exit', listener: ((value: unknown) => void) | ((code: number) => void)): WorkerTransport {
    if (event === 'message') this.#messageListeners.push(listener as (message: unknown) => void)
    else if (event === 'error') this.#errorListeners.push(listener as (error: unknown) => void)
    else this.#exitListeners.push(listener as (code: number) => void)
    return this
  }
  terminate(): Promise<number> { this.terminated += 1; return Promise.resolve(0) }
  emit(message: unknown): void { for (const listener of this.#messageListeners) listener(message) }
  emitError(error: unknown): void { for (const listener of this.#errorListeners) listener(error) }
  emitExit(code: number): void { for (const listener of this.#exitListeners) listener(code) }
  startMessage(): WorkerStartMessage { return this.messages[0] as WorkerStartMessage }
}

const totals = {
  scannedItems: 1, discoveredBytes: 2, elapsedMs: 3, skippedItems: 0, unreadableItems: 0,
  nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0
}

function request(name = 'one'): ScanExecutionRequest {
  return {
    target: `/tmp/${name}`,
    partialPath: `/tmp/index-${name}.partial.sqlite`,
    publishedPath: `/tmp/index-${name}.sqlite`,
    indexDirectory: '/tmp',
    startupRoot: false
  }
}

function result(start: WorkerStartMessage): ScanResult {
  return {
    generation: start.generation, target: start.target, rootId: 'n-root', publishedPath: start.publishedPath,
    capacityBytes: 10, freeBytes: 5, scannedBytes: 2, totals
  }
}

function preview(generation: number, revision: number): ProgressivePreview {
  const root = {
    id: 'n-root', parentId: null, name: 'root', kind: 'directory' as const, sizeBytes: 2,
    directChildren: 0, descendantCount: 0, unreadableCount: 0, scanState: 'scanning' as const,
    sizeAccuracy: 'partial' as const
  }
  return {
    generation, revision, committed: false, target: { name: 'root', isStartup: false }, focus: root,
    breadcrumbs: [], chart: [], largestItems: [],
    volume: { capacityBytes: 10, freeBytes: 5, scannedBytes: 2, unscannedBytes: 0, sizeAccuracy: 'partial' }
  }
}

describe('WorkerScanExecution', () => {
  it('hides request correlation behind ordered updates and typed session methods', async () => {
    const worker = new FakeWorker()
    const execution = new WorkerScanExecution({ create: () => worker })
    const session = await execution.start(request())
    const start = worker.startMessage()
    const updates: string[] = []
    const consume = (async () => { for await (const update of session.events) updates.push(update.type === 'preview' ? `preview-${update.preview.revision}` : 'progress') })()

    worker.emit({ type: 'progress', generation: start.generation, requestId: start.requestId, progress: { stage: 'traversing', scannedItems: 1, discoveredBytes: 2, elapsedMs: 3, currentItem: 'file' } })
    worker.emit({ type: 'preview', generation: start.generation, requestId: start.requestId, preview: preview(start.generation, 2) })
    worker.emit({ type: 'preview', generation: start.generation, requestId: start.requestId, preview: preview(start.generation, 1) })

    const focus = session.focus('n-root')
    const focusMessage = worker.messages.at(-1) as { requestId: number }
    worker.emit({ type: 'focus-accepted', generation: start.generation, requestId: focusMessage.requestId, accepted: true })
    await expect(focus).resolves.toEqual({ kind: 'accepted' })

    const resolved = session.resolveNode('n-root')
    const resolveMessage = worker.messages.at(-1) as { requestId: number }
    worker.emit({ type: 'resolved-node', generation: start.generation, requestId: resolveMessage.requestId, path: '/tmp/one' })
    await expect(resolved).resolves.toEqual({ kind: 'resolved', path: '/tmp/one' })

    worker.emit({ type: 'complete', generation: start.generation, requestId: resolveMessage.requestId, result: result(start) })
    worker.emitExit(0)
    await expect(session.result).resolves.toMatchObject({ kind: 'completed', result: { target: '/tmp/one' } })
    await consume
    expect(updates).toEqual(['progress', 'preview-2'])
  })

  it('persists typed checkpoint and native diagnostics while rejecting stale messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-scan-diagnostics-'))
    try {
      const worker = new FakeWorker()
      const diagnostics = new ScanFailureDiagnosticsStore(directory)
      const execution = new WorkerScanExecution({ create: () => worker }, { diagnostics })
      const session = await execution.start({ ...request('diagnostics'), resumeExpected: true })
      const start = worker.startMessage()
      worker.emit({ type: 'checkpoint', generation: start.generation, requestId: start.requestId, checkpoint: { sequence: 4, reason: 'scheduled', phase: 'scanning', count: 2 } })
      worker.emit({ type: 'native-addon-status', generation: start.generation, requestId: start.requestId, status: { loadStatus: 'loaded', journalCapability: 'missing', metadataCapability: 'available' } })
      worker.emit({ type: 'checkpoint', generation: start.generation + 1, requestId: start.requestId, checkpoint: { sequence: 99, reason: 'pause', phase: 'paused', count: 99 } })
      worker.emit({ type: 'error', generation: start.generation, requestId: start.requestId, error: { message: 'worker failed', code: 'EIO' } })
      await expect(session.result).resolves.toMatchObject({ kind: 'failed' })
      const document = await diagnostics.read()
      expect(document.activeRun).toBeUndefined()
      expect(document.lastFailure).toMatchObject({ kind: 'worker-error', code: 'EIO', latestCheckpoint: { sequence: 4 }, nativeAddon: { metadataCapability: 'available' } })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('copies a resume receipt into the worker start message', async () => {
    const worker = new FakeWorker()
    const execution = new WorkerScanExecution({ create: () => worker })
    const receipt = { version: 1, kind: 'construction', scanId: 'd1234567-89ab-4cde-8fab-0123456789ab', descriptorDigest: '0'.repeat(64), checkpointSequence: 1, drainedThrough: '0', database: { file: 'index-d1234567-89ab-4cde-8fab-0123456789ab.partial.sqlite', device: '1', inode: '2', size: 1, modifiedNs: '3', changedNs: '4' }, source: 'acknowledged-pause' } satisfies ResumeValidationReceipt
    const session = await execution.start({ ...request('resume-receipt'), resumeExpected: true, resumeReceipt: receipt })
    expect(worker.startMessage().resumeReceipt).toEqual(receipt)
    await session.pause()
  })

  it('forwards only current resume milestones', async () => {
    const worker = new FakeWorker()
    const execution = new WorkerScanExecution({ create: () => worker })
    const session = await execution.start({ ...request('resume'), resumeExpected: true })
    const start = worker.startMessage()
    const milestones: string[] = []
    const consume = (async () => {
      for await (const update of session.events) if (update.type === 'resume-milestone') milestones.push(update.milestone)
    })()

    worker.emit({ type: 'resume-milestone', generation: start.generation + 1, requestId: start.requestId, milestone: 'preparation-started' })
    worker.emit({ type: 'resume-milestone', generation: start.generation, requestId: start.requestId, milestone: 'unknown' })
    worker.emit({ type: 'resume-milestone', generation: start.generation, requestId: start.requestId, milestone: 42 })
    worker.emit({ type: 'resume-milestone', generation: start.generation, requestId: start.requestId, milestone: 'preparation-started' })
    worker.emit({ type: 'resume-milestone', generation: start.generation, requestId: start.requestId, milestone: 'first-metadata-page' })
    worker.emit({ type: 'complete', generation: start.generation, requestId: start.requestId, result: result(start) })
    worker.emit({ type: 'resume-milestone', generation: start.generation, requestId: start.requestId, milestone: 'first-metadata-preview' })
    await session.result
    await consume
    expect(start.resumeExpected).toBe(true)
    expect(milestones).toEqual(['preparation-started', 'first-metadata-page'])
  })

  it('forwards only ordered preparation phases from the current resume request', async () => {
    const worker = new FakeWorker()
    const execution = new WorkerScanExecution({ create: () => worker })
    const session = await execution.start({ ...request('preparation'), resumeExpected: true })
    const start = worker.startMessage()
    const phases: string[] = []
    const consume = (async () => {
      for await (const update of session.events) if (update.type === 'resume-preparation') phases.push(update.phase)
    })()
    const send = (phase: unknown, overrides: Record<string, unknown> = {}): void => worker.emit({
      type: 'resume-preparation', generation: start.generation, requestId: start.requestId, phase, ...overrides
    })

    send('validating')
    send('validating')
    send('history')
    send('recovering')
    send('history')
    send('unknown')
    send(42)
    send('repairing', { generation: start.generation + 1 })
    const focus = session.focus('n-root')
    const currentRequest = (worker.messages.at(-1) as { requestId: number }).requestId
    send('repairing')
    worker.emit({ type: 'focus-accepted', generation: start.generation, requestId: currentRequest, accepted: true })
    await focus
    send('repairing', { requestId: currentRequest })
    send('starting', { requestId: currentRequest })
    worker.emit({ type: 'progress', generation: start.generation, requestId: currentRequest, progress: { stage: 'traversing', scannedItems: 1, discoveredBytes: 2, elapsedMs: 3, currentItem: 'file' } })
    send('starting', { requestId: currentRequest })
    worker.emit({ type: 'complete', generation: start.generation, requestId: currentRequest, result: result(start) })
    await session.result
    await consume
    expect(phases).toEqual(['validating', 'history', 'recovering', 'repairing', 'starting'])

    const freshWorker = new FakeWorker()
    const freshExecution = new WorkerScanExecution({ create: () => freshWorker })
    const fresh = await freshExecution.start(request('fresh'))
    const freshStart = freshWorker.startMessage()
    freshWorker.emit({ type: 'resume-preparation', generation: freshStart.generation, requestId: freshStart.requestId, phase: 'validating' })
    freshWorker.emit({ type: 'complete', generation: freshStart.generation, requestId: freshStart.requestId, result: result(freshStart) })
    const freshUpdates: ScanUpdate[] = []
    for await (const update of fresh.events) freshUpdates.push(update)
    expect(freshUpdates).toEqual([])
  })

  it('pauses and terminates the active session before starting its replacement', async () => {
    const workers: FakeWorker[] = []
    const execution = new WorkerScanExecution({ create: () => {
      const worker = new FakeWorker()
      worker.onPost = (message) => {
        const value = message as { type?: string; generation?: number; requestId?: number }
        if (value.type === 'pause') queueMicrotask(() => worker.emit({ type: 'paused', generation: value.generation, requestId: value.requestId, checkpointSequence: 7 }))
      }
      workers.push(worker)
      return worker
    } })
    const first = await execution.start(request('first'))
    const second = await execution.start(request('second'))

    await expect(first.result).resolves.toEqual({ kind: 'paused', acknowledged: true, checkpointSequence: 7 })
    expect(workers[0]!.terminated).toBe(1)
    expect(workers[0]!.startMessage().generation).toBe(1)
    expect(workers[1]!.startMessage().generation).toBe(2)
    await second.pause()
  })

  it('terminates after the pause acknowledgement timeout', async () => {
    const worker = new FakeWorker()
    const execution = new WorkerScanExecution({ create: () => worker }, { pauseTimeoutMs: 1 })
    const session = await execution.start(request('timeout'))

    await expect(session.pause()).resolves.toEqual({ kind: 'paused', acknowledged: false })
    expect(worker.terminated).toBe(1)
  })

  it('discards a completion that arrives after pausing starts', async () => {
    const worker = new FakeWorker()
    const discarded: string[] = []
    const execution = new WorkerScanExecution(
      { create: () => worker },
      { pauseTimeoutMs: 20, discardStaleCandidate: async (path) => { discarded.push(path) } }
    )
    const session = await execution.start(request('stale'))
    const start = worker.startMessage()
    worker.onPost = (message) => {
      const value = message as { type?: string; generation?: number; requestId?: number }
      if (value.type === 'pause') queueMicrotask(() => {
        worker.emit({ type: 'complete', generation: start.generation, requestId: value.requestId, result: result(start) })
        worker.emit({ type: 'paused', generation: start.generation, requestId: value.requestId, checkpointSequence: 4 })
      })
    }

    await expect(session.pause()).resolves.toEqual({ kind: 'paused', acknowledged: true, checkpointSequence: 4 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(discarded).toEqual([start.publishedPath])
  })

  it('turns worker startup failures into failed outcomes', async () => {
    const creation = new WorkerScanExecution({ create: () => { throw new Error('create failed') } })
    const creationSession = await creation.start(request('create-failure'))
    await expect(creationSession.result).resolves.toMatchObject({ kind: 'failed', error: { message: 'create failed' } })

    const worker = new FakeWorker()
    worker.onPost = () => { throw new Error('start failed') }
    const startup = new WorkerScanExecution({ create: () => worker }, { pauseTimeoutMs: 1 })
    const startupSession = await startup.start(request('start-failure'))
    await expect(startupSession.result).resolves.toMatchObject({ kind: 'failed', error: { message: 'start failed' } })
    await startupSession.pause()
    expect(worker.terminated).toBe(1)
  })

  it('turns worker errors and premature exits into failed outcomes', async () => {
    const firstWorker = new FakeWorker()
    const secondWorker = new FakeWorker()
    const workers = [firstWorker, secondWorker]
    let nextWorker = 0
    const execution = new WorkerScanExecution({ create: () => workers[nextWorker++]! }, { pauseTimeoutMs: 1 })

    const errored = await execution.start(request('error'))
    firstWorker.emitError(new Error('worker failed'))
    await expect(errored.result).resolves.toMatchObject({ kind: 'failed', error: { message: 'worker failed' } })
    await errored.pause()
    expect(firstWorker.terminated).toBe(1)

    const exited = await execution.start(request('exit'))
    secondWorker.emitExit(2)
    await expect(exited.result).resolves.toMatchObject({ kind: 'failed', error: { message: 'The scan worker stopped unexpectedly (code 2).' } })
    await exited.pause()
    expect(secondWorker.terminated).toBe(1)
  })
})
