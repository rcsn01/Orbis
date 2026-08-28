import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMITTED_NODE_SELECT, CONSTRUCTION_NODE_SELECT, DiskIndex, NodeReadModel, nodeFromRow, toSummary } from '../src/main/index-store'
import { ConstructionDatabase } from '../src/main/construction-database'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

/** Drive a construction database to a committed index and return its path. */
function buildCommittedIndex(directory: string, withMetadata: boolean): string {
  const path = join(directory, 'index.sqlite')
  const database = new ConstructionDatabase(path)
  const rootPath = join(directory, 'root')
  database.insertRoot({ id: 'n-root', parentId: null, name: 'root', path: rootPath, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
  database.insertChild({ id: 'n-big', parentId: 'n-root', name: 'big', path: join(rootPath, 'big'), kind: 'file', ownBytes: 2048, device: '1', inode: '2' }, 1, false)
  database.insertChild({ id: 'n-small', parentId: 'n-root', name: 'small', path: join(rootPath, 'small'), kind: 'file', ownBytes: 512, device: '1', inode: '3' }, 1, false)
  database.insertChild({ id: 'n-dir', parentId: 'n-root', name: 'dir', path: join(rootPath, 'dir'), kind: 'directory', ownBytes: 0, device: '1', inode: '4' }, 1, false)
  if (withMetadata) {
    database.writeMetadata({
      target: rootPath, rootId: 'n-root', capacityBytes: 0, freeBytes: 0, scannedBytes: 2560,
      targetDevice: '1', targetInode: '1', indexDirectoryIdentity: '1:1', indexRevision: 1,
      totals: { scannedItems: 4, discoveredBytes: 2560, elapsedMs: 0, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 }
    })
  }
  database.finishEnumeration('n-dir')
  database.finishEnumeration('n-root')
  database.finalize()
  database.complete()
  return path
}

describe('node read-model', () => {
  it('emits the shared row-shape contract from both SELECT constants', () => {
    const aliases = ['id', 'parentId', 'name', 'path', 'kind', 'confirmedBytes', 'display_size', 'estimatedBytes', 'directChildren', 'descendantCount', 'unreadableCount', 'ownUnreadable', 'scanState']
    for (const select of [COMMITTED_NODE_SELECT, CONSTRUCTION_NODE_SELECT]) {
      for (const alias of aliases) expect(select).toContain(alias)
    }
    expect(CONSTRUCTION_NODE_SELECT).toContain('LEFT JOIN size_estimates')
    expect(COMMITTED_NODE_SELECT).not.toContain('size_estimates')
  })

  it('clamps corrupt rows instead of passing them through', () => {
    const node = nodeFromRow({ id: 'n-x', parentId: null, name: 'x', path: '/x', kind: 'file', confirmedBytes: -5, display_size: NaN, estimatedBytes: 3, directChildren: -1, descendantCount: NaN, unreadableCount: 2, ownUnreadable: 0, scanState: 'garbage' })
    expect(node.scanState).toBe('complete')
    expect(node.sizeBytes).toBe(0)
    expect(node.confirmedBytes).toBe(0)
    expect(node.directChildren).toBe(0)
    expect(node.descendantCount).toBe(0)
    expect(node.sizeAccuracy).toBe('partial')
  })

  it('maps pending, estimated, complete, and unreadable rows through the construction adapter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-read-model-construction-'))
    cleanup.push(directory)
    const database = new ConstructionDatabase(join(directory, 'construction.sqlite'))
    try {
      database.insertRoot({ id: 'n-root', parentId: null, name: 'root', path: join(directory, 'root'), kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.applyEstimates({ items: [{ name: 'folder', estimatedBytes: 4096 }] })
      database.insertChild({ id: 'n-folder', parentId: 'n-root', name: 'folder', path: join(directory, 'root', 'folder'), kind: 'directory', ownBytes: 512, device: '1', inode: '2' }, 1, false)
      database.insertChild({ id: 'n-plain', parentId: 'n-root', name: 'plain', path: join(directory, 'root', 'plain'), kind: 'directory', ownBytes: 256, device: '1', inode: '3' }, 1, false)
      database.insertChild({ id: 'n-file', parentId: 'n-root', name: 'file', path: join(directory, 'root', 'file'), kind: 'file', ownBytes: 128, device: '1', inode: '4' }, 1, false)

      const pending = database.getNode('n-folder')!
      expect(pending).toMatchObject({ scanState: 'queued', sizeBytes: 4096, confirmedBytes: 512, estimatedBytes: 4096, sizeAccuracy: 'estimated' })
      expect(database.getNode('n-plain')).toMatchObject({ scanState: 'queued', sizeBytes: 256, confirmedBytes: 256, estimatedBytes: 0, sizeAccuracy: 'partial' })
      expect(database.getNode('n-file')).toMatchObject({ scanState: 'complete', sizeAccuracy: 'exact', estimatedBytes: 0 })
      expect(database.getBreadcrumbs('n-folder')).toEqual([{ id: 'n-root', name: 'root' }, { id: 'n-folder', name: 'folder' }])
      const pendingSummary = toSummary(pending)
      expect(pendingSummary).toMatchObject({ sizeBytes: 4096, sizeAccuracy: 'estimated', estimatedSizeBytes: 4096 })

      database.finishEnumeration('n-folder')
      expect(database.getNode('n-folder')).toMatchObject({ scanState: 'complete', sizeBytes: 512, confirmedBytes: 512, estimatedBytes: 0, sizeAccuracy: 'exact' })
      expect(Object.hasOwn(toSummary(database.getNode('n-folder')!), 'estimatedSizeBytes')).toBe(false)

      database.markUnreadable('n-plain')
      expect(database.getNode('n-plain')).toMatchObject({ scanState: 'unreadable', sizeAccuracy: 'partial' })
    } finally { database.abort() }
  })

  it('computes estimated remainders from un-discovered estimate roots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-read-model-remainder-'))
    cleanup.push(directory)
    // A discovered child consumes its estimate: the remainder is zero.
    const consumed = new ConstructionDatabase(join(directory, 'consumed.sqlite'))
    try {
      consumed.insertRoot({ id: 'n-root', parentId: null, name: 'root', path: join(directory, 'root'), kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      consumed.applyEstimates({ items: [{ name: 'folder', estimatedBytes: 4096 }] })
      consumed.insertChild({ id: 'n-folder', parentId: 'n-root', name: 'folder', path: join(directory, 'root', 'folder'), kind: 'directory', ownBytes: 512, device: '1', inode: '2' }, 1, false)
      expect(consumed.getNode('n-folder')).toMatchObject({ sizeBytes: 4096, confirmedBytes: 512, estimatedBytes: 4096, sizeAccuracy: 'estimated' })
      expect(consumed.getEstimatedRemainder('n-root')).toBe(0)
    } finally { consumed.abort() }
    // An estimate root that has not been discovered yet stays in the remainder.
    const pending = new ConstructionDatabase(join(directory, 'pending.sqlite'))
    try {
      pending.insertRoot({ id: 'n-root', parentId: null, name: 'root', path: join(directory, 'root'), kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      pending.applyEstimates({ items: [{ name: 'later', estimatedBytes: 4096 }] })
      expect(pending.getEstimatedRemainder('n-root')).toBe(4096)
      pending.insertChild({ id: 'n-later', parentId: 'n-root', name: 'later', path: join(directory, 'root', 'later'), kind: 'directory', ownBytes: 512, device: '1', inode: '2' }, 1, false)
      expect(pending.getEstimatedRemainder('n-root')).toBe(0)
    } finally { pending.abort() }
  })

  it('maps a finalized index through the committed read-model and DiskIndex', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-read-model-committed-'))
    cleanup.push(directory)
    const path = buildCommittedIndex(directory, true)
    // Constructing the committed variant against a file without a
    // size_estimates table must not throw.
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const model = new NodeReadModel(database, 'committed')
      const root = model.getNode('n-root')!
      expect(root).toMatchObject({ scanState: 'complete', sizeAccuracy: 'exact', estimatedBytes: 0, confirmedBytes: 2560, sizeBytes: 2560 })
      expect(model.getEstimatedRemainder('n-root')).toBe(0)
      expect(model.getChildren('n-root', 100).map((child) => child.name)).toEqual(['big', 'small', 'dir'])
      expect(model.getChildren('n-root', 0)).toEqual([])
      expect(model.countChildren('n-root')).toBe(3)
      expect(model.getNodeByPath(join(directory, 'root', 'big'))?.id).toBe('n-big')
      expect(model.getNodeByPath('/no/such/path')).toBeUndefined()
      expect(model.getBreadcrumbs('n-dir')).toEqual([{ id: 'n-root', name: 'root' }, { id: 'n-dir', name: 'dir' }])
      const summary = toSummary(root)
      expect(summary.sizeAccuracy).toBe('exact')
      expect(Object.hasOwn(summary, 'estimatedSizeBytes')).toBe(false)
    } finally { database.close() }

    const index = new DiskIndex(path)
    try {
      expect(index.getNode('n-root')?.sizeAccuracy).toBe('exact')
      expect(index.getChildren('n-root', 100).map((child) => child.name)).toEqual(['big', 'small', 'dir'])
      expect(index.getBreadcrumbs('n-dir').map((item) => item.name)).toEqual(['root', 'dir'])
      expect(index.getEstimatedRemainder('n-root')).toBe(0)
      expect(index.getNodeByPath(join(directory, 'root', 'small'))?.id).toBe('n-small')
    } finally { index.close() }
  })

  it('opens a boundary-safe descendant location view at the public seam', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-read-model-location-'))
    cleanup.push(directory)
    const path = buildCommittedIndex(directory, true)
    // A published descendant aggregate is authoritative; the view must not
    // recompute it from whichever children happen to be visible.
    const writable = new DatabaseSync(path)
    try {
      writable.prepare('UPDATE nodes SET size_bytes = ?, direct_children = ?, descendant_count = ? WHERE id = ?').run(777, 9, 12, 'n-dir')
    } finally { writable.close() }

    const index = new DiskIndex(path)
    try {
      const target = join(directory, 'root', 'dir')
      const view = index.openLocationView(target, { device: '1', inode: '4' })
      expect(view).toBeDefined()
      expect(view).toMatchObject({ target, rootId: 'n-dir' })
      expect(view!.root).toMatchObject({ id: 'n-dir', sizeBytes: 777, directChildren: 9, descendantCount: 12 })
      expect(view!.getBreadcrumbs('n-dir')).toEqual([{ id: 'n-dir', name: 'dir' }])

      // Ancestors and siblings belong to the publication, but not this
      // logical root. This applies uniformly to reads and reveal paths.
      expect(view!.getNode('n-root')).toBeUndefined()
      expect(view!.getNode('n-small')).toBeUndefined()
      expect(view!.getChildren('n-root', 100)).toEqual([])
      expect(view!.countChildren('n-root')).toBe(0)
      expect(view!.getLargestItems('n-root')).toEqual([])
      expect(view!.resolvePath('n-small')).toBeUndefined()
      expect(view!.resolvePath('n-dir')).toBe(target)

      expect(index.openLocationView(target, { device: '1', inode: '999' })).toBeUndefined()
      expect(index.openLocationView(target, { device: '999', inode: '4' })).toBeUndefined()
      expect(index.openLocationView(join(directory, 'root', 'di'), { device: '1', inode: '4' })).toBeUndefined()
    } finally { index.close() }
  })

  it('fails closed on a corrupt parent chain for the committed variant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-read-model-corrupt-'))
    cleanup.push(directory)
    const path = buildCommittedIndex(directory, false)
    const database = new DatabaseSync(path, { enableForeignKeyConstraints: false })
    try {
      // Cycle: root -> big -> root.
      database.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run('n-big', 'n-root')
      // Dangling: small's parent no longer exists.
      database.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run('n-missing', 'n-small')
      const model = new NodeReadModel(database, 'committed')
      expect(model.getBreadcrumbs('n-root')).toEqual([])
      expect(model.getBreadcrumbs('n-dir')).toEqual([])
      expect(model.getBreadcrumbs('n-small')).toEqual([])
    } finally { database.close() }
  })

  it('fails closed on a corrupt parent chain for the construction variant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-read-model-corrupt-construction-'))
    cleanup.push(directory)
    const database = new DatabaseSync(join(directory, 'construction.sqlite'))
    try {
      database.exec(`
        CREATE TABLE nodes (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          kind TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          direct_children INTEGER NOT NULL DEFAULT 0,
          descendant_count INTEGER NOT NULL DEFAULT 0,
          unreadable_count INTEGER NOT NULL DEFAULT 0,
          own_unreadable INTEGER NOT NULL DEFAULT 0,
          scan_state TEXT NOT NULL
        );
        CREATE TABLE size_estimates (
          node_id TEXT PRIMARY KEY,
          estimated_bytes INTEGER NOT NULL,
          indexed_items INTEGER NOT NULL,
          physical_size_coverage REAL NOT NULL
        );
      `)
      const insert = database.prepare('INSERT INTO nodes (id, parent_id, name, path, kind, size_bytes, scan_state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      insert.run('n-a', null, 'a', '/a', 'directory', 0, 'complete')
      insert.run('n-b', 'n-a', 'b', '/a/b', 'directory', 0, 'complete')
      insert.run('n-c', 'n-b', 'c', '/a/b/c', 'directory', 0, 'complete')
      // Dangling: c's parent no longer exists.
      database.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run('n-missing', 'n-c')
      const model = new NodeReadModel(database, 'construction')
      expect(model.getBreadcrumbs('n-c')).toEqual([])
      expect(model.getBreadcrumbs('n-b')).toEqual([{ id: 'n-a', name: 'a' }, { id: 'n-b', name: 'b' }])
    } finally { database.close() }
  })
})
