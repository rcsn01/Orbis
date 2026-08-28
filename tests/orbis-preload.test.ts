import { describe, expect, it, vi } from 'vitest'
import { createOrbisBridge, type IpcRendererLike } from '../src/preload/bridge'
import type { LocationId } from '../src/shared/contracts'

const id = 'loc-123e4567-e89b-42d3-a456-426614174000' as LocationId
const snapshot = {
  version: 4, committed: true, selectedLocationId: id,
  locations: [{ id, name: 'root', coverage: 'direct' }],
  target: { name: 'root', isStartup: false }, focus: null, breadcrumbs: [], chart: [], largestItems: [],
  volume: { capacityBytes: 100, freeBytes: 50, scannedBytes: 50, unscannedBytes: 0, sizeAccuracy: 'exact' },
  scan: {
    locationId: id, status: 'completed', generation: 1, progress: null,
    totals: { scannedItems: 1, discoveredBytes: 50, elapsedMs: 1, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 }, error: null
  }
} as const

function renderer() {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  const value: IpcRendererLike = {
    invoke: vi.fn(async () => undefined),
    on: vi.fn((channel, listener) => { listeners.set(channel, listener) }),
    removeListener: vi.fn((channel) => { listeners.delete(channel) })
  }
  return { listeners, value }
}

describe('Orbis preload bridge', () => {
  it('forwards valid v4 snapshots and rejects v3 and broken location references', () => {
    const { listeners, value } = renderer()
    const listener = vi.fn()
    const unsubscribe = createOrbisBridge(value).subscribe(listener)

    listeners.get('orbis:snapshot')?.({}, snapshot)
    listeners.get('orbis:snapshot')?.({}, { ...snapshot, version: 3 })
    listeners.get('orbis:snapshot')?.({}, { ...snapshot, selectedLocationId: 'loc-223e4567-e89b-42d3-a456-426614174000' })
    listeners.get('orbis:snapshot')?.({}, { ...snapshot, locations: [...snapshot.locations, snapshot.locations[0]] })
    listeners.get('orbis:snapshot')?.({}, { ...snapshot, scan: { ...snapshot.scan, locationId: 'loc-223e4567-e89b-42d3-a456-426614174000' } })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(snapshot)
    unsubscribe()
    expect(value.removeListener).toHaveBeenCalledOnce()
  })

  it('uses shared location IPC channels and forwards location ids', async () => {
    const { value } = renderer()
    const bridge = createOrbisBridge(value)
    await bridge.addLocation()
    await bridge.selectLocation(id)
    await bridge.removeLocation(id)
    expect(value.invoke).toHaveBeenNthCalledWith(1, 'orbis:add-location')
    expect(value.invoke).toHaveBeenNthCalledWith(2, 'orbis:select-location', id)
    expect(value.invoke).toHaveBeenNthCalledWith(3, 'orbis:remove-location', id)
  })

  it('accepts resuming progress and rejects unknown stages', () => {
    const { listeners, value } = renderer()
    const listener = vi.fn()
    createOrbisBridge(value).subscribe(listener)
    const resuming = { ...snapshot, committed: false, scan: { ...snapshot.scan, status: 'scanning', totals: null, progress: { stage: 'resuming', scannedItems: 4, discoveredBytes: 20, elapsedMs: 5, currentItem: 'Validating saved scan' } } }
    listeners.get('orbis:snapshot')?.({}, resuming)
    listeners.get('orbis:snapshot')?.({}, { ...resuming, scan: { ...resuming.scan, progress: { ...resuming.scan.progress, stage: 'waiting' } } })
    expect(listener).toHaveBeenCalledOnce()
  })
})
