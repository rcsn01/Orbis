import { describe, expect, it } from 'vitest'
import { projectSnapshotView, type SnapshotProjectionSource } from '../src/main/snapshot-projection'
import type { DatabaseNode } from '../src/main/index-store'

const root = directory('root', 'physical-parent', 'Disk', 100, 2)
const folder = directory('folder', root.id, 'Folder', 40, 2)
const rootFile = file('root-file', root.id, 'root.bin', 60)
const folderFileA = file('folder-a', folder.id, 'a.bin', 30)
const folderFileB = file('folder-b', folder.id, 'b.bin', 10)

function source(overrides: Partial<SnapshotProjectionSource> = {}): SnapshotProjectionSource {
  const nodes = new Map([root, folder, rootFile, folderFileA, folderFileB].map((node) => [node.id, node]))
  const children = new Map<string, readonly DatabaseNode[]>([
    [root.id, [folder, rootFile]],
    [folder.id, [folderFileA, folderFileB]]
  ])
  return {
    getNode: (id) => nodes.get(id),
    getChildren: (id, limit) => (children.get(id) ?? []).slice(0, limit),
    countChildren: (id) => children.get(id)?.length ?? 0,
    getBreadcrumbs: (id) => id === root.id
      ? [{ id: root.id, name: root.name }]
      : id === folder.id
        ? [{ id: root.id, name: root.name }, { id: folder.id, name: folder.name }]
        : [{ id: root.id, name: root.name }, { id, name: nodes.get(id)?.name ?? id }],
    getLargestItems: (id) => (children.get(id) ?? []).map((node) => ({
      id: node.id, parentId: node.parentId, name: node.name, kind: node.kind,
      sizeBytes: node.sizeBytes, directChildren: node.directChildren,
      descendantCount: node.descendantCount, unreadableCount: node.unreadableCount,
      scanState: node.scanState, sizeAccuracy: node.sizeAccuracy
    })),
    ...overrides
  }
}

const startupVolume = { capacityBytes: 200, freeBytes: 50, scannedBytes: 100, sizeAccuracy: 'exact' as const }

describe('snapshot projection', () => {
  it('uses disk capacity only for the startup-volume root', () => {
    const disk = projectSnapshotView({
      source: source(), rootId: root.id, focusId: root.id,
      target: { name: 'Macintosh HD', isStartup: true }, volume: startupVolume
    })!
    const drilled = projectSnapshotView({
      source: source(), rootId: root.id, focusId: folder.id,
      target: { name: 'Macintosh HD', isStartup: true }, volume: startupVolume
    })!

    const diskRootRing = disk.chart.filter((segment) => segment.depth === 1)
    const drilledRootRing = drilled.chart.filter((segment) => segment.depth === 1)
    expect(diskRootRing.at(-1)?.endAngle).toBe(180)
    expect(diskRootRing.reduce((sum, segment) => sum + segment.percentage, 0)).toBe(50)
    expect(drilledRootRing.at(-1)?.endAngle).toBe(360)
    expect(drilledRootRing.reduce((sum, segment) => sum + segment.percentage, 0)).toBe(100)
  })

  it('builds the common path-free view and normalizes the logical root', () => {
    const projection = projectSnapshotView({
      source: source(), rootId: root.id, focusId: root.id,
      target: { name: 'Saved disk', isStartup: true }, volume: startupVolume
    })!

    expect(projection.target).toEqual({ name: 'Saved disk', isStartup: true })
    expect(projection.focus).toMatchObject({ id: root.id, parentId: null, name: 'Disk' })
    expect(projection.breadcrumbs).toEqual([{ id: root.id, name: 'Disk' }])
    expect(projection.largestItems.map((item) => item.id)).toEqual([folder.id, rootFile.id])
    expect(projection.volume).toEqual({
      capacityBytes: 200, freeBytes: 50, scannedBytes: 100,
      unscannedBytes: 50, sizeAccuracy: 'estimated'
    })
  })

  it('uses the supplied baseline accuracy when no startup space is unscanned', () => {
    const projection = projectSnapshotView({
      source: source(), rootId: root.id, focusId: folder.id,
      target: { name: 'Folder', isStartup: false },
      volume: { capacityBytes: 200, freeBytes: 50, scannedBytes: 40, sizeAccuracy: 'partial' }
    })!

    expect(projection.volume).toEqual({
      capacityBytes: 200, freeBytes: 50, scannedBytes: 40,
      unscannedBytes: 0, sizeAccuracy: 'partial'
    })
  })

  it.each([
    ['missing focus', 'missing', [{ id: root.id, name: root.name }]],
    ['file focus', rootFile.id, [{ id: root.id, name: root.name }, { id: rootFile.id, name: rootFile.name }]],
    ['empty breadcrumbs', folder.id, []],
    ['wrong breadcrumb root', folder.id, [{ id: 'other-root', name: 'Other' }, { id: folder.id, name: folder.name }]],
    ['wrong breadcrumb end', folder.id, [{ id: root.id, name: root.name }]]
  ])('returns no projection for %s', (_label, focusId, breadcrumbs) => {
    const projection = projectSnapshotView({
      source: source({ getBreadcrumbs: () => breadcrumbs }), rootId: root.id, focusId,
      target: { name: 'Disk', isStartup: true }, volume: startupVolume
    })

    expect(projection).toBeUndefined()
  })

  it('does not add read-model queries around projection', () => {
    const calls = { node: 0, breadcrumbs: 0, largest: 0 }
    const base = source()
    const measured = source({
      getNode: (id) => { calls.node += 1; return base.getNode(id) },
      getBreadcrumbs: (id) => { calls.breadcrumbs += 1; return base.getBreadcrumbs(id) },
      getLargestItems: (id) => { calls.largest += 1; return base.getLargestItems(id) }
    })

    expect(projectSnapshotView({
      source: measured, rootId: root.id, focusId: folder.id,
      target: { name: 'Disk', isStartup: true }, volume: startupVolume
    })).toBeDefined()
    expect(calls).toEqual({ node: 1, breadcrumbs: 1, largest: 1 })
  })
})

function directory(id: string, parentId: string | null, name: string, sizeBytes: number, directChildren: number): DatabaseNode {
  return {
    id, parentId, name, path: `/${name}`, kind: 'directory', sizeBytes, confirmedBytes: sizeBytes,
    estimatedBytes: 0, directChildren, descendantCount: directChildren, unreadableCount: 0,
    scanState: 'complete', sizeAccuracy: 'exact'
  }
}

function file(id: string, parentId: string, name: string, sizeBytes: number): DatabaseNode {
  return { ...directory(id, parentId, name, sizeBytes, 0), kind: 'file' }
}
