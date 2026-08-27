import { describe, expect, it, vi } from 'vitest'
import { createOrbisBridge, type IpcRendererLike } from '../src/preload/bridge'

describe('Orbis preload bridge', () => {
  it('forwards valid snapshot version 3 events to the renderer', () => {
    const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
    const renderer: IpcRendererLike = {
      invoke: vi.fn(async () => undefined),
      on: vi.fn((channel, listener) => { listeners.set(channel, listener) }),
      removeListener: vi.fn((channel) => { listeners.delete(channel) })
    }
    const bridge = createOrbisBridge(renderer)
    const listener = vi.fn()
    const unsubscribe = bridge.subscribe(listener)

    listeners.get('orbis:snapshot')?.({}, {
      version: 3, committed: true, target: { name: 'root', isStartup: false }, focus: null, breadcrumbs: [], chart: [], largestItems: [],
      volume: { capacityBytes: 100, freeBytes: 50, scannedBytes: 50, unscannedBytes: 0, sizeAccuracy: 'exact' },
      scan: {
        status: 'completed', generation: 1, progress: null,
        totals: { scannedItems: 1, discoveredBytes: 50, elapsedMs: 1, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 },
        error: null
      }
    })
    listeners.get('orbis:snapshot')?.({}, { version: 2, committed: true })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }))
    unsubscribe()
    expect(renderer.removeListener).toHaveBeenCalledOnce()
  })

  it('accepts resuming progress and rejects unknown stages', () => {
    const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
    const renderer: IpcRendererLike = {
      invoke: vi.fn(async () => undefined),
      on: vi.fn((channel, listener) => { listeners.set(channel, listener) }),
      removeListener: vi.fn()
    }
    const listener = vi.fn()
    createOrbisBridge(renderer).subscribe(listener)
    const snapshot = {
      version: 3, committed: false, target: { name: 'root', isStartup: false }, focus: null, breadcrumbs: [], chart: [], largestItems: [],
      volume: { capacityBytes: 100, freeBytes: 50, scannedBytes: 20, unscannedBytes: 30, sizeAccuracy: 'partial' },
      scan: { status: 'scanning', generation: 2, progress: { stage: 'resuming', scannedItems: 4, discoveredBytes: 20, elapsedMs: 5, currentItem: 'Validating saved scan' }, totals: null, error: null }
    }
    listeners.get('orbis:snapshot')?.({}, snapshot)
    listeners.get('orbis:snapshot')?.({}, { ...snapshot, scan: { ...snapshot.scan, progress: { ...snapshot.scan.progress, stage: 'waiting' } } })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(snapshot)
  })
})
