import { DatabaseSync } from 'node:sqlite'
import { createHmac } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConstructionDatabase, ConstructionError, type ConstructionPage } from '../src/main/construction-database'
import type { InsertNode } from '../src/main/database'
import { FullScanResumeStore } from '../src/main/full-scan-resume'
import { emptyScanCounters, runWithScanDiagnostics, subscribeScanCounters, subscribeScanDiagnostics, type OrbisTimingEvent } from '../src/main/diagnostics'
import { readConstructionSnapshot } from './helpers/orbis-resume-recovery'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

function options(candidatePath?: string) {
  let now = 1_000
  return {
    scanId: 'lifecycle-scan', journalDevice: '1', journalUuid: 'journal', journalBaseline: '0',
    ...(candidatePath ? { candidatePath } : {}), clock: () => now,
    advance: (milliseconds: number) => { now += milliseconds }
  }
}

function page(entries: ConstructionPage['entries'], done = true, entriesRead = 0, taskId = 'root', enumerationEpoch = 1): ConstructionPage {
  return { taskId, depth: 0, focused: false, entriesRead, enumerationEpoch, done, entries, bulkMetadataEntries: 0, fallbackMetadataEntries: 0 }
}

describe('ConstructionDatabase construction lifecycle', () => {
  it('owns ordered work leases and exposes one persisted status snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-work-'))
    cleanup.push(directory)
    const database = ConstructionDatabase.create(join(directory, 'partial.sqlite'), options())
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      const batch = database.takeWork({ limit: 4, focusTurns: 0 })
      expect(batch).toMatchObject({ work: [{ id: 'root', entriesRead: 0 }], focusTurns: 0, done: false })
      expect(database.status()).toMatchObject({ phase: 'scanning', revision: 0, checkpointSequence: 0 })
      database.accept({ kind: 'page', page: page([]) })
      expect(database.takeWork({ limit: 4, focusTurns: 0 })).toEqual({ work: [], focusTurns: 0, done: true })
    } finally { database.abort() }
  })

  it('retains checkpointed children until replay completes, refreshes metadata, and sweeps unseen rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-replay-sweep-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    const entry = (id: string, name: string, bytes: number) => ({
      kind: 'node' as const,
      node: { node: { id, parentId: 'folder', name, path: join(directory, 'folder', name), kind: 'file' as const, ownBytes: bytes, device: '1', inode: id }, pathKey: `folder/${name}`, linkCount: 1 }
    })
    const staleDirectory = { kind: 'node' as const, node: { node: { id: 'stale-directory', parentId: 'folder', name: 'stale-directory', path: join(directory, 'folder', 'stale-directory'), kind: 'directory' as const, ownBytes: 0, device: '1', inode: '3' }, pathKey: 'folder/stale-directory' } }
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: page([{ kind: 'node', node: { node: { id: 'folder', parentId: 'root', name: 'folder', path: join(directory, 'folder'), kind: 'directory', ownBytes: 0, device: '1', inode: '2' }, pathKey: 'folder' }}]) })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: { ...page([entry('kept', 'kept', 10), entry('stale', 'stale', 20), staleDirectory], false, 0, 'folder'), depth: 1 } })
      database.checkpoint({ reason: 'scheduled' })
      database.abort()

      const resumed = ConstructionDatabase.openResumable(path)
      try {
        expect(resumed.recoverIncompleteDirectories()).toMatchObject({ roots: 1, deletedNodes: 0 })
        const first = resumed.takeWork({ limit: 1, focusTurns: 0 }).work[0]!
        expect(resumed.getChildren('folder', 10).map((node) => node.id)).toEqual(['stale', 'kept', 'stale-directory'])
        resumed.accept({ kind: 'page', page: {
          ...page([entry('kept', 'kept', 35), entry('new', 'new', 5)], false, first.entriesRead, first.id, first.enumerationEpoch), depth: first.depth, focused: first.focused
        } })
        expect(resumed.getChildren('folder', 10).map((node) => node.id)).toEqual(['kept', 'stale', 'new', 'stale-directory'])
        const second = resumed.takeWork({ limit: 1, focusTurns: 0 }).work[0]!
        resumed.accept({ kind: 'page', page: {
          ...page([], true, second.entriesRead, second.id, second.enumerationEpoch), depth: second.depth, focused: second.focused
        } })
        expect(resumed.takeWork({ limit: 1, focusTurns: 0 }).done).toBe(true)
        expect(resumed.getNode('kept')).toMatchObject({ sizeBytes: 35, path: join(directory, 'folder', 'kept') })
        expect(resumed.getNode('stale')).toBeUndefined()
        expect(resumed.getNode('stale-directory')).toBeUndefined()
        expect(resumed.getNode('new')).toMatchObject({ sizeBytes: 5 })
        expect(resumed.semanticTotals()).toMatchObject({ discoveredBytes: 40 })
      } finally { resumed.abort() }
    } finally { database.abort() }
  })

  it('rejects a stale replay epoch without changing the durable construction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-replay-epoch-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.accept({ kind: 'page', page: page([{ kind: 'node', node: { node: { id: 'folder', parentId: 'root', name: 'folder', path: join(directory, 'folder'), kind: 'directory', ownBytes: 0, device: '1', inode: '2' }, pathKey: 'folder' }}]) })
      database.startTask('folder')
      database.checkpoint({ reason: 'scheduled' })
      database.abort()
      const resumed = ConstructionDatabase.openResumable(path)
      try {
        resumed.recoverIncompleteDirectories()
        const task = resumed.takeWork({ limit: 1, focusTurns: 0 }).work[0]!
        const before = readConstructionSnapshot(path)
        expect(() => resumed.accept({ kind: 'page', page: { ...page([], true, task.entriesRead, task.id, task.enumerationEpoch - 1), depth: task.depth, focused: task.focused } })).toThrow(/Stale construction page/)
        expect(readConstructionSnapshot(path)).toEqual(before)
        resumed.accept({ kind: 'page', page: { ...page([], true, task.entriesRead, task.id, task.enumerationEpoch), depth: task.depth, focused: task.focused } })
        expect(resumed.takeWork({ limit: 1, focusTurns: 0 }).done).toBe(true)
      } finally { resumed.abort() }
    } finally { database.abort() }
  })

  it('rolls back the complete metadata page when a later node violates a constraint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-page-rollback-'))
    cleanup.push(directory)
    const database = ConstructionDatabase.create(join(directory, 'partial.sqlite'), options())
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      expect(() => database.accept({ kind: 'page', page: page([
        { kind: 'node', node: { node: { id: 'first', parentId: 'root', name: 'same', path: join(directory, 'same'), kind: 'directory', ownBytes: 0, device: '1', inode: '2' }, pathKey: 'same' } },
        { kind: 'node', node: { node: { id: 'first', parentId: 'root', name: 'other', path: join(directory, 'other'), kind: 'directory', ownBytes: 0, device: '1', inode: '3' }, pathKey: 'other' } }
      ]) })).toThrow()
      expect(database.getChildren('root', 100)).toEqual([])
      expect(database.accept({ kind: 'page', page: page([]) })).toMatchObject({ scannedItems: 0 })
    } finally { database.abort() }
  })

  it('persists an explicit pause phase and checkpoint before closing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-pause-'))
    cleanup.push(directory)
    const clock = options()
    const database = ConstructionDatabase.create(join(directory, 'partial.sqlite'), clock)
    database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
    database.accept({ kind: 'page', page: page([], false) })
    clock.advance(250)
    const result = database.finish({ kind: 'pause', activeElapsedDeltaMs: 250 })
    expect(result).toEqual({ kind: 'paused', checkpointSequence: 1 })

    const reopened = new DatabaseSync(join(directory, 'partial.sqlite'), { readOnly: true })
    try {
      expect(reopened.prepare('SELECT phase, checkpoint_sequence AS sequence, active_elapsed_ms AS elapsed, checkpointed_at AS checkpointedAt FROM scan_run').get()).toEqual({
        phase: 'paused', sequence: 1, elapsed: 250, checkpointedAt: new Date(1_250).toISOString()
      })
    } finally { reopened.close() }

    const resumed = ConstructionDatabase.openResumable(join(directory, 'partial.sqlite'), { clock: clock.clock })
    expect(resumed.phase).toBe('paused')
    resumed.checkpoint({ reason: 'resume' })
    resumed.abort()
    const afterResume = new DatabaseSync(join(directory, 'partial.sqlite'), { readOnly: true })
    try { expect(afterResume.prepare('SELECT phase, checkpoint_sequence AS sequence FROM scan_run').get()).toEqual({ phase: 'scanning', sequence: 2 }) }
    finally { afterResume.close() }
  })

  it('restores a singleton surviving hard-link owner before replaying aliases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-hardlink-recovery-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    const sourceId = `n-${createHmac('sha256', Buffer.from(database.nodeIdSeed, 'hex')).update('sources').update('\0').update('file').digest('hex').slice(0, 32)}`
    database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
    database.accept({ kind: 'page', page: page([
      { kind: 'node', node: { node: { id: 'sources', parentId: 'root', name: 'Z-sources', path: join(directory, 'Z-sources'), kind: 'directory', ownBytes: 0, device: '1', inode: '3' }, pathKey: 'Z-sources' } },
      { kind: 'node', node: { node: { id: 'aliases', parentId: 'root', name: 'A-aliases', path: join(directory, 'A-aliases'), kind: 'directory', ownBytes: 0, device: '1', inode: '2' }, pathKey: 'A-aliases' } }
    ]) })
    database.takeWork({ limit: 2, focusTurns: 0 })
    database.accept({ kind: 'page', page: { ...page([
      { kind: 'node', node: { node: { id: sourceId, parentId: 'sources', name: 'file', path: join(directory, 'Z-sources', 'file'), kind: 'file', ownBytes: 10, device: '1', inode: '50' }, pathKey: 'Z-sources/file', linkCount: 2 } }
    ], true, 0, 'sources'), depth: 1 } })
    database.checkpoint({ reason: 'scheduled' })
    database.abort()

    const resumed = ConstructionDatabase.openResumable(path)
    try {
      const recovery = resumed.recoverIncompleteDirectories()
      expect(recovery.roots).toBeGreaterThan(0)
      expect(resumed.getHardLinkOwner('1', '50')).toEqual({ nodeId: sourceId, pathKey: 'Z-sources/file' })
    } finally { resumed.abort() }
  })

  it('repairs only interrupted roots, affected hard links, and their scheduler ancestors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-scoped-recovery-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    const paths = new Map<string, string>([['root', directory]])
    const pathFor = (parentId: string, name: string): string => join(paths.get(parentId) ?? directory, name)
    const node = (id: string, parentId: string, name: string, kind: 'directory' | 'file', inode: string, ownBytes = 0) => ({
      id, parentId, name, path: pathFor(parentId, name), kind, ownBytes, device: '1', inode
    })
    const directoryNode = (id: string, parentId: string, name: string, inode: string) => {
      const path = pathFor(parentId, name)
      paths.set(id, path)
      return { id, parentId, name, path, kind: 'directory' as const, ownBytes: 0, device: '1', inode }
    }
    const taskPage = (taskId: string, depth: number, entries: ConstructionPage['entries'], done: boolean, focused = false, entriesRead = 0): ConstructionPage => ({
      taskId, depth, focused, entriesRead, enumerationEpoch: 1, done, entries, bulkMetadataEntries: 0, fallbackMetadataEntries: 0
    })
    const entry = (value: ReturnType<typeof node>, pathKey: string, linkCount?: number) => ({
      kind: 'node' as const, node: { node: value, pathKey, ...(linkCount === undefined ? {} : { linkCount }) }
    })
    const seed = database.nodeIdSeed
    const hardLinkId = (parentId: string, name: string): string => `n-${createHmac('sha256', Buffer.from(seed, 'hex')).update(parentId).update('\0').update(name).digest('hex').slice(0, 32)}`
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: taskPage('root', 0, [
        entry(directoryNode('left', 'root', 'left', '2'), 'left'), entry(directoryNode('right', 'root', 'right', '3'), 'right')
      ], true) })

      database.takeWork({ limit: 2, focusTurns: 0 })
      database.accept({ kind: 'page', page: taskPage('left', 1, [
        entry(directoryNode('stable', 'left', 'stable', '4'), 'left/stable'), entry(directoryNode('reset', 'left', 'reset', '5'), 'left/reset')
      ], true) })
      database.accept({ kind: 'page', page: taskPage('right', 1, [
        entry(directoryNode('stable-right', 'right', 'stable-right', '6'), 'right/stable-right'), entry(directoryNode('reset-right', 'right', 'reset-right', '7'), 'right/reset-right')
      ], false) })
      database.markUnreadable('right')

      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: taskPage('stable', 2, [
        entry(node(hardLinkId('stable', 'external'), 'stable', 'external', 'file', '50', 10), 'left/stable/external', 2)
      ], true) })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: taskPage('reset', 2, [
        entry(node(hardLinkId('reset', 'reset-file'), 'reset', 'reset-file', 'file', '50', 10), 'left/reset/reset-file', 2),
        entry(directoryNode('nested', 'reset', 'nested', '8'), 'left/reset/nested')
      ], false) })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: taskPage('stable-right', 2, [
        entry(node('single', 'stable-right', 'single', 'file', '60', 10), 'right/stable-right/single', 1),
        entry(node(hardLinkId('stable-right', 'u-a'), 'stable-right', 'u-a', 'file', '61', 10), 'right/stable-right/u-a', 2),
        entry(node(hardLinkId('stable-right', 'u-b'), 'stable-right', 'u-b', 'file', '61', 10), 'right/stable-right/u-b', 2)
      ], true) })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.promoteSubtree('nested')
      database.checkpoint({ reason: 'scheduled' })
      database.abort()

      const before = readConstructionSnapshot(path)
      expect(before.directoryTasks.find((row) => row.nodeId === 'stable-right')).toMatchObject({ status: 'complete', ready: 0 })
      const resumed = ConstructionDatabase.openResumable(path)
      try {
        const recovery = resumed.recoverIncompleteDirectories()
        expect(recovery).toMatchObject({ roots: 2, deletedNodes: 0, affectedHardlinkIdentities: 1 })
        expect(resumed.taskIsFocused('reset')).toBe(true)
        expect(resumed.getHardLinkOwner('1', '50')).toEqual({ nodeId: hardLinkId('reset', 'reset-file'), pathKey: 'left/reset/reset-file' })
        const work = resumed.takeWork({ limit: 2, focusTurns: 0 })
        expect(work.work.map((task) => task.id).sort()).toEqual(['reset', 'reset-right'])
        for (const task of work.work) {
          const entries = task.id === 'reset' ? [
            entry(node(hardLinkId('reset', 'reset-file'), 'reset', 'reset-file', 'file', '50', 10), 'left/reset/reset-file', 2),
            entry(directoryNode('nested', 'reset', 'nested', '8'), 'left/reset/nested')
          ] : []
          resumed.accept({ kind: 'page', page: {
            ...taskPage(task.id, task.depth, entries, true, task.focused, task.entriesRead), enumerationEpoch: task.enumerationEpoch
          } })
        }
        while (true) {
          const next = resumed.takeWork({ limit: 1, focusTurns: 0 })
          if (next.done) break
          const task = next.work[0]
          if (!task) throw new Error('Missing replay task')
          resumed.accept({ kind: 'page', page: {
            ...taskPage(task.id, task.depth, [], true, task.focused, task.entriesRead), enumerationEpoch: task.enumerationEpoch
          } })
        }
        resumed.checkpoint({ reason: 'resume' })
        expect(readConstructionSnapshot(path).directoryTasks.find((row) => row.nodeId === 'right')).toMatchObject({ status: 'unreadable', pendingChildren: 0, subtreeComplete: 1, ready: 0 })
      } finally { resumed.abort() }

      const after = readConstructionSnapshot(path)
      expect(after.nodes.find((row) => row.id === hardLinkId('reset', 'reset-file'))).toMatchObject({
        parentId: 'reset', sizeBytes: 10, directChildren: 0, descendantCount: 0, unreadableCount: 0
      })
      expect(after.nodes.find((row) => row.id === hardLinkId('stable', 'external'))).toBeUndefined()
      expect(after.nodes.find((row) => row.id === 'stable')).toMatchObject({ sizeBytes: 0, directChildren: 0, descendantCount: 0, unreadableCount: 0 })
      expect(after.nodes.find((row) => row.id === 'left')).toMatchObject({ sizeBytes: 10, directChildren: 2, descendantCount: 4, unreadableCount: 0 })
      expect(after.nodes.find((row) => row.id === 'stable-right')).toMatchObject({ sizeBytes: 20, directChildren: 2, descendantCount: 2, unreadableCount: 0 })
      expect(after.nodes.find((row) => row.id === 'right')).toMatchObject({ sizeBytes: 20, directChildren: 2, descendantCount: 4, unreadableCount: 1 })
      expect(after.nodes.find((row) => row.id === 'root')).toMatchObject({ sizeBytes: 30, directChildren: 2, descendantCount: 10, unreadableCount: 1 })
      expect(after.directoryTasks.find((row) => row.nodeId === 'stable-right')).toEqual(before.directoryTasks.find((row) => row.nodeId === 'stable-right'))
      expect(after.hardlinkOwners).toEqual([
        { device: '1', inode: '50', nodeId: hardLinkId('reset', 'reset-file'), pathKey: 'left/reset/reset-file' },
        { device: '1', inode: '61', nodeId: hardLinkId('stable-right', 'u-a'), pathKey: 'right/stable-right/u-a' }
      ])
      expect(after.hardlinkPaths).toEqual([
        { parentId: 'reset', name: 'reset-file', pathKey: 'left/reset/reset-file', device: '1', inode: '50', allocatedBytes: 10 },
        { parentId: 'stable', name: 'external', pathKey: 'left/stable/external', device: '1', inode: '50', allocatedBytes: 10 },
        { parentId: 'stable-right', name: 'u-a', pathKey: 'right/stable-right/u-a', device: '1', inode: '61', allocatedBytes: 10 },
        { parentId: 'stable-right', name: 'u-b', pathKey: 'right/stable-right/u-b', device: '1', inode: '61', allocatedBytes: 10 }
      ])
      expect(after.directoryObservations.find((row) => row.nodeId === 'stable')?.directDuplicateCount).toBe(1)
      expect(after.directoryObservations.find((row) => row.nodeId === 'stable-right')).toEqual(before.directoryObservations.find((row) => row.nodeId === 'stable-right'))
      expect(after.nodes.some((row) => row.id === 'nested')).toBe(true)
    } finally { database.abort() }
  })

  it('aborts on a scoped aggregate mismatch without a global repair', async () => {
    const fixture = await createAggregateRecoveryFixture()
    installAggregateAudit(fixture.path)
    installAggregateFault(fixture.path, 'one-shot')
    const before = readConstructionSnapshot(fixture.path)
    const counters = emptyScanCounters()
    const events: OrbisTimingEvent[] = []
    const unsubscribeCounters = subscribeScanCounters((event) => { if (event.generation === 101) counters[event.counter] += event.value })
    const unsubscribeTimings = subscribeScanDiagnostics((event) => { if (event.generation === 101) events.push(event) })
    const resumed = ConstructionDatabase.openResumable(fixture.path)
    let error: unknown
    try {
      runWithScanDiagnostics(101, () => {
        resumed.recoverIncompleteDirectories()
        replayAggregateFixture(resumed)
        resumed.checkpoint({ reason: 'resume' })
      })
    } catch (caught) { error = caught } finally {
      resumed.abort()
      unsubscribeCounters()
      unsubscribeTimings()
    }
    expect(error).toBeInstanceOf(ConstructionError)
    expect(String((error as Error)?.message)).toMatch(/Directory aggregate mismatch/)
    expect(counters.resumeAggregateFallbacks).toBe(0)
    expect(events.filter((event) => event.phase === 'resume-aggregate-fallback')).toHaveLength(0)
    expect(readConstructionSnapshot(fixture.path)).toEqual(before)
    const audit = new DatabaseSync(fixture.path, { readOnly: true })
    try { expect(audit.prepare('SELECT node_id FROM aggregate_audit').all()).toEqual([]) }
    finally { audit.close() }
  })

  it('rolls back a persistent scoped aggregate fault with the durable checkpoint intact', async () => {
    const fixture = await createAggregateRecoveryFixture()
    installAggregateFault(fixture.path, 'persistent')
    const before = readConstructionSnapshot(fixture.path)
    const counters = emptyScanCounters()
    const unsubscribe = subscribeScanCounters((event) => { if (event.generation === 102) counters[event.counter] += event.value })
    const resumed = ConstructionDatabase.openResumable(fixture.path)
    let error: unknown
    try {
      runWithScanDiagnostics(102, () => {
        resumed.recoverIncompleteDirectories()
        replayAggregateFixture(resumed)
        resumed.checkpoint({ reason: 'resume' })
      })
    } catch (caught) { error = caught } finally {
      resumed.abort()
      unsubscribe()
    }
    expect(error).toBeDefined()
    expect(counters.resumeAggregateFallbacks).toBe(0)
    expect(readConstructionSnapshot(fixture.path)).toEqual(before)
  })

  it('keeps the replay marker across failed reconciliation and retries after reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-replay-reopen-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    const seed = database.nodeIdSeed
    const idFor = (parentId: string, name: string): string => `n-${createHmac('sha256', Buffer.from(seed, 'hex')).update(parentId).update('\0').update(name).digest('hex').slice(0, 32)}`
    const directoryEntry = (id: string, name: string, inode: string) => ({
      kind: 'node' as const,
      node: { node: { id, parentId: 'root', name, path: join(directory, name), kind: 'directory' as const, ownBytes: 0, device: '1', inode }, pathKey: name }
    })
    const fileEntry = (parentId: string, name: string, pathKey: string, linkCount: number) => ({
      kind: 'node' as const,
      node: { node: { id: idFor(parentId, name), parentId, name, path: join(directory, ...pathKey.split('/')), kind: 'file' as const, ownBytes: 10, device: '1', inode: '90' }, pathKey, linkCount }
    })
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: page([
        directoryEntry('stable', 'a-stable', '2'), directoryEntry('replay', 'z-replay', '3')
      ]) })
      database.takeWork({ limit: 2, focusTurns: 0 })
      database.accept({ kind: 'page', page: { ...page([fileEntry('stable', 'file', 'a-stable/file', 2)], true, 0, 'stable'), depth: 1 } })
      database.accept({ kind: 'page', page: { ...page([fileEntry('replay', 'file', 'z-replay/file', 2)], false, 0, 'replay'), depth: 1 } })
      database.checkpoint({ reason: 'scheduled' })
    } finally { database.abort() }

    installAggregateFault(path, 'persistent')
    const resumed = ConstructionDatabase.openResumable(path)
    try {
      expect(resumed.recoverIncompleteDirectories()).toMatchObject({ roots: 1, affectedHardlinkIdentities: 1 })
      const task = resumed.takeWork({ limit: 1, focusTurns: 0 }).work[0]!
      expect(task.id).toBe('replay')
      resumed.accept({ kind: 'page', page: {
        ...page([fileEntry('replay', 'file', 'z-replay/file', 2)], true, task.entriesRead, task.id, task.enumerationEpoch), depth: task.depth, focused: task.focused
      } })
      // Commit replay rows and the durable marker before reconciliation runs.
      resumed.checkpoint({ reason: 'resume' })
      expect(() => resumed.takeWork({ limit: 1, focusTurns: 0 })).toThrow(/Directory aggregate mismatch/)
    } finally { resumed.abort() }

    const afterFailure = readConstructionSnapshot(path)
    expect(afterFailure.nodes.some((node) => node.id === idFor('replay', 'file'))).toBe(true)
    expect(afterFailure.hardlinkPaths).toHaveLength(2)
    const marker = new DatabaseSync(path, { readOnly: true })
    try { expect(marker.prepare('SELECT resume_replay_pending AS pending FROM scan_run').get()).toEqual({ pending: 1 }) }
    finally { marker.close() }

    const removeFault = new DatabaseSync(path)
    try { removeFault.exec('DROP TRIGGER aggregate_fault_update') } finally { removeFault.close() }
    const retried = ConstructionDatabase.openResumable(path)
    try {
      expect(retried.recoverIncompleteDirectories()).toEqual({ roots: 0, deletedNodes: 0, affectedHardlinkIdentities: 0, repairedAncestors: 0, repairedSchedulerRows: 0 })
      retried.checkpoint({ reason: 'resume' })
    } finally { retried.abort() }

    const final = readConstructionSnapshot(path)
    expect(final.hardlinkOwners).toEqual([{ device: '1', inode: '90', nodeId: idFor('stable', 'file'), pathKey: 'a-stable/file' }])
    expect(final.hardlinkPaths).toEqual([
      { parentId: 'stable', name: 'file', pathKey: 'a-stable/file', device: '1', inode: '90', allocatedBytes: 10 },
      { parentId: 'replay', name: 'file', pathKey: 'z-replay/file', device: '1', inode: '90', allocatedBytes: 10 }
    ])
    const completed = new DatabaseSync(path, { readOnly: true })
    try { expect(completed.prepare('SELECT resume_replay_pending AS pending FROM scan_run').get()).toEqual({ pending: 0 }) }
    finally { completed.close() }
  })

  it.each([11, 23, 47])('replays retained entries and matches the independent aggregate oracle for seed %i', async (seed) => {
    const fixture = await createGeneratedRecoveryFixture(seed)
    const expectedIds = new Set(preorder(fixture.root).map((node) => node.id))
    const resumed = ConstructionDatabase.openResumable(fixture.path)
    try {
      const recovery = resumed.recoverIncompleteDirectories()
      expect(recovery.roots).toBe(fixture.selectedRoots.length)
      expect(recovery.deletedNodes).toBe(0)
      expect(recovery.repairedAncestors).toBeGreaterThan(0)
      resumed.checkpoint({ reason: 'resume' })
      replayGeneratedEntries(resumed, fixture)
      resumed.checkpoint({ reason: 'scheduled' })
    } finally { resumed.abort() }
    const final = readConstructionSnapshot(fixture.path)
    expect(new Set(final.nodes.map((row) => row.id))).toEqual(expectedIds)
    for (const aggregate of final.directoryAggregateOracle) {
      expect(final.nodes.find((row) => row.id === aggregate.id)).toMatchObject(aggregate)
    }
  })

  it('reconciles a deep chain after replay without losing its siblings', async () => {
    const fixture = await createDeepAggregateFixture()
    installAggregateAudit(fixture.path)
    const resumed = ConstructionDatabase.openResumable(fixture.path)
    try {
      const recovery = resumed.recoverIncompleteDirectories()
      expect(recovery.roots).toBe(1)
      expect(recovery.deletedNodes).toBe(0)
      resumed.checkpoint({ reason: 'resume' })
      const task = resumed.takeWork({ limit: 1, focusTurns: 0 }).work[0]
      expect(task?.id).toBe(fixture.chain.at(-1)?.id)
      const file = fixture.chain.at(-1)?.children.find((node) => node.kind === 'file')
      resumed.accept({ kind: 'page', page: {
        ...page(file ? [{ kind: 'node', node: { node: file, pathKey: file.name }}] : [], true, task?.entriesRead ?? 0, task?.id ?? '', task?.enumerationEpoch ?? 1),
        taskId: task?.id ?? '', depth: task?.depth ?? 0, focused: task?.focused ?? false
      } })
      expect(resumed.takeWork({ limit: 1, focusTurns: 0 }).done).toBe(true)
      resumed.checkpoint({ reason: 'scheduled' })
    } finally { resumed.abort() }
    const snapshot = readConstructionSnapshot(fixture.path)
    expect(snapshot.nodes.filter((row) => row.kind === 'directory')).toHaveLength(fixture.chain.length + fixture.siblingCount)
    const database = new DatabaseSync(fixture.path, { readOnly: true })
    try {
      const writes = (database.prepare('SELECT DISTINCT node_id AS nodeId FROM aggregate_audit').all() as unknown as Array<{ nodeId: string }>).map((row) => row.nodeId)
      expect(new Set(writes)).toEqual(new Set(snapshot.nodes.map((row) => row.id)))
    } finally { database.close() }
  })

  it('does not double-count an unreadable parent when a recovered child settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-unreadable-recovery-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    const directoryEntry = (id: string, parentId: string, name: string, inode: string) => ({
      kind: 'node' as const,
      node: { node: { id, parentId, name, path: join(directory, name), kind: 'directory' as const, ownBytes: 0, device: '1', inode }, pathKey: name }
    })
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: page([directoryEntry('blocked', 'root', 'blocked', '2')]) })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: { ...page([directoryEntry('child', 'blocked', 'child', '3')], false, 0, 'blocked'), depth: 1 } })
      database.markUnreadable('blocked')
      database.checkpoint({ reason: 'scheduled' })
      database.abort()

      const resumed = ConstructionDatabase.openResumable(path)
      try {
        expect(resumed.recoverIncompleteDirectories()).toMatchObject({ roots: 1, repairedAncestors: 1 })
        const before = resumed.getNode('root')
        expect(before?.unreadableCount).toBe(1)
        const childTask = resumed.takeWork({ limit: 1, focusTurns: 0 }).work[0]
        expect(childTask?.id).toBe('child')
        resumed.accept({ kind: 'page', page: {
          ...page([{ kind: 'node', node: { node: { id: 'file', parentId: 'child', name: 'file', path: join(directory, 'blocked', 'child', 'file'), kind: 'file', ownBytes: 10, device: '1', inode: '4' }, pathKey: 'blocked/child/file' }}], true, childTask?.entriesRead ?? 0, 'child', childTask?.enumerationEpoch ?? 1), depth: 2
        } })
        expect(resumed.takeWork({ limit: 1, focusTurns: 0 }).done).toBe(true)
        expect(resumed.getNode('root')?.unreadableCount).toBe(1)
        expect(resumed.getNode('blocked')?.unreadableCount).toBe(1)
        resumed.checkpoint({ reason: 'resume' })
      } finally { resumed.abort() }

      const snapshot = readConstructionSnapshot(path)
      expect(snapshot.nodes.find((row) => row.id === 'root')).toMatchObject({ sizeBytes: 10, descendantCount: 3, unreadableCount: 1 })
      expect(snapshot.nodes.find((row) => row.id === 'blocked')).toMatchObject({ sizeBytes: 10, descendantCount: 2, unreadableCount: 1 })
      for (const aggregate of snapshot.directoryAggregateOracle) {
        expect(snapshot.nodes.find((row) => row.id === aggregate.id)).toMatchObject(aggregate)
      }
    } finally { database.abort() }
  })

  it('reuses an unchanged surviving hard-link representative', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-hardlink-reuse-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    const seed = database.nodeIdSeed
    const idFor = (parentId: string, name: string): string => `n-${createHmac('sha256', Buffer.from(seed, 'hex')).update(parentId).update('\0').update(name).digest('hex').slice(0, 32)}`
    const directoryEntry = (id: string, parentId: string, name: string, inode: string, pathKey: string) => ({
      kind: 'node' as const, node: { node: { id, parentId, name, path: join(directory, ...pathKey.split('/')), kind: 'directory' as const, ownBytes: 0, device: '1', inode }, pathKey }
    })
    const fileEntry = (parentId: string, name: string, inode: string, pathKey: string) => ({
      kind: 'node' as const, node: { node: { id: idFor(parentId, name), parentId, name, path: join(directory, ...pathKey.split('/')), kind: 'file' as const, ownBytes: 10, device: '1', inode }, pathKey, linkCount: 2 }
    })
    const makePage = (taskId: string, depth: number, entries: ConstructionPage['entries'], done: boolean): ConstructionPage => ({
      taskId, depth, focused: false, entriesRead: 0, enumerationEpoch: 1, done, entries, bulkMetadataEntries: 0, fallbackMetadataEntries: 0
    })
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: makePage('root', 0, [
        directoryEntry('stable', 'root', 'a-stable', '2', 'a-stable'), directoryEntry('reset', 'root', 'z-reset', '3', 'z-reset')
      ], true) })
      database.takeWork({ limit: 2, focusTurns: 0 })
      database.accept({ kind: 'page', page: makePage('stable', 1, [fileEntry('stable', 'external', '90', 'a-stable/external')], true) })
      database.accept({ kind: 'page', page: makePage('reset', 1, [fileEntry('reset', 'reset-file', '90', 'z-reset/reset-file')], false) })
      database.checkpoint({ reason: 'scheduled' })
      database.abort()

      const before = readConstructionSnapshot(path)
      const beforeNode = before.nodes.find((row) => row.device === '1' && row.inode === '90')
      const resumed = ConstructionDatabase.openResumable(path)
      try {
        expect(resumed.recoverIncompleteDirectories()).toMatchObject({ roots: 1, affectedHardlinkIdentities: 1 })
        resumed.checkpoint({ reason: 'resume' })
      } finally { resumed.abort() }
      const after = readConstructionSnapshot(path)
      expect(after.nodes.find((row) => row.device === '1' && row.inode === '90')).toEqual(beforeNode)
      expect(after.hardlinkOwners).toEqual([{ device: '1', inode: '90', nodeId: idFor('stable', 'external'), pathKey: 'a-stable/external' }])
    } finally { database.abort() }
  })

  it('removes stale aliases when replay proves a tracked identity is a singleton', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-hardlink-singleton-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    const seed = database.nodeIdSeed
    const idFor = (parentId: string, name: string): string => `n-${createHmac('sha256', Buffer.from(seed, 'hex')).update(parentId).update('\0').update(name).digest('hex').slice(0, 32)}`
    const fileEntry = (parentId: string, name: string, inode: string, pathKey: string, linkCount: number) => ({
      kind: 'node' as const,
      node: { node: { id: idFor(parentId, name), parentId, name, path: join(directory, ...pathKey.split('/')), kind: 'file' as const, ownBytes: 10, device: '1', inode }, pathKey, linkCount }
    })
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: page([
        { kind: 'node', node: { node: { id: 'stable', parentId: 'root', name: 'a-stable', path: join(directory, 'a-stable'), kind: 'directory', ownBytes: 0, device: '1', inode: '3' }, pathKey: 'a-stable' } },
        { kind: 'node', node: { node: { id: 'replay', parentId: 'root', name: 'z-replay', path: join(directory, 'z-replay'), kind: 'directory', ownBytes: 0, device: '1', inode: '2' }, pathKey: 'z-replay' } }
      ]) })
      database.takeWork({ limit: 2, focusTurns: 0 })
      database.accept({ kind: 'page', page: { ...page([fileEntry('stable', 'file', '90', 'a-stable/file', 2)], true, 0, 'stable'), depth: 1 } })
      database.accept({ kind: 'page', page: { ...page([fileEntry('replay', 'file', '90', 'z-replay/file', 2)], false, 0, 'replay'), depth: 1 } })
      database.checkpoint({ reason: 'scheduled' })
      database.abort()

      const resumed = ConstructionDatabase.openResumable(path)
      try {
        expect(resumed.recoverIncompleteDirectories()).toMatchObject({ roots: 1, affectedHardlinkIdentities: 1 })
        const task = resumed.takeWork({ limit: 1, focusTurns: 0 }).work[0]!
        expect(task.id).toBe('replay')
        resumed.accept({ kind: 'page', page: {
          ...page([fileEntry('replay', 'file', '90', 'z-replay/file', 1)], true, task.entriesRead, task.id, task.enumerationEpoch), depth: task.depth, focused: task.focused
        } })
        expect(resumed.takeWork({ limit: 1, focusTurns: 0 }).done).toBe(true)
        resumed.checkpoint({ reason: 'resume' })
      } finally { resumed.abort() }

      const snapshot = readConstructionSnapshot(path)
      expect(snapshot.nodes.filter((row) => row.device === '1' && row.inode === '90')).toHaveLength(1)
      expect(snapshot.nodes.find((row) => row.device === '1' && row.inode === '90')).toMatchObject({ parentId: 'replay', name: 'file' })
      expect(snapshot.hardlinkOwners).toEqual([])
      expect(snapshot.hardlinkPaths).toEqual([])
    } finally { database.abort() }
  })

  it('refreshes descendant hard-link paths when replay changes a directory path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-replay-paths-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    const seed = database.nodeIdSeed
    const fileId = `n-${createHmac('sha256', Buffer.from(seed, 'hex')).update('nested').update('\0').update('file').digest('hex').slice(0, 32)}`
    const nestedPath = join(directory, 'folder', 'nested')
    const refreshedNestedPath = join(directory, 'renamed', 'nested')
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: page([{ kind: 'node', node: { node: { id: 'folder', parentId: 'root', name: 'folder', path: join(directory, 'folder'), kind: 'directory', ownBytes: 0, device: '1', inode: '2' }, pathKey: 'folder' }}]) })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: { ...page([{ kind: 'node', node: { node: { id: 'nested', parentId: 'folder', name: 'nested', path: nestedPath, kind: 'directory', ownBytes: 0, device: '1', inode: '3' }, pathKey: 'folder/nested' }}], true, 0, 'folder'), depth: 1 } })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: { ...page([
        { kind: 'node', node: { node: { id: fileId, parentId: 'nested', name: 'file', path: join(nestedPath, 'file'), kind: 'file', ownBytes: 10, device: '1', inode: '90' }, pathKey: 'folder/nested/file', linkCount: 2 } }
      ], true, 0, 'nested'), depth: 2 } })
      database.checkpoint({ reason: 'scheduled' })
      database.abort()

      const mutate = new DatabaseSync(path)
      try {
        mutate.exec(`BEGIN;
          UPDATE nodes SET scan_state = 'scanning', enumeration_complete = 0 WHERE id = 'folder';
          UPDATE directory_tasks SET status = 'scanning', entries_read = 0, ready = 1, subtree_complete = 0 WHERE node_id = 'folder';
          UPDATE scan_run SET phase = 'scanning' WHERE singleton = 1;
          COMMIT;`)
      } finally { mutate.close() }

      const resumed = ConstructionDatabase.openResumable(path)
      try {
        expect(resumed.recoverIncompleteDirectories()).toMatchObject({ roots: 1 })
        const task = resumed.takeWork({ limit: 1, focusTurns: 0 }).work[0]!
        expect(task.id).toBe('folder')
        resumed.accept({ kind: 'page', page: {
          ...page([{ kind: 'node', node: { node: { id: 'nested', parentId: 'folder', name: 'nested', path: refreshedNestedPath, kind: 'directory', ownBytes: 0, device: '1', inode: '3' }, pathKey: 'renamed/nested' }}], true, task.entriesRead, task.id, task.enumerationEpoch), depth: task.depth, focused: task.focused
        } })
        expect(resumed.takeWork({ limit: 1, focusTurns: 0 }).done).toBe(true)
        resumed.checkpoint({ reason: 'resume' })
      } finally { resumed.abort() }

      const snapshot = readConstructionSnapshot(path)
      expect(snapshot.nodes.find((row) => row.id === 'nested')).toMatchObject({ path: refreshedNestedPath, depth: 2 })
      expect(snapshot.nodes.find((row) => row.id === fileId)).toMatchObject({ path: join(refreshedNestedPath, 'file'), depth: 3 })
      expect(snapshot.directoryTasks.find((row) => row.nodeId === 'nested')).toMatchObject({ path: refreshedNestedPath, depth: 2 })
      expect(snapshot.hardlinkPaths).toEqual([{ parentId: 'nested', name: 'file', pathKey: 'renamed/nested/file', device: '1', inode: '90', allocatedBytes: 10 }])
      expect(snapshot.hardlinkOwners).toEqual([{ device: '1', inode: '90', nodeId: fileId, pathKey: 'renamed/nested/file' }])
    } finally { database.abort() }
  })

  it('preserves the durable checkpoint when hard-link node-ID insertion collides', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-hardlink-collision-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    const seed = database.nodeIdSeed
    const idFor = (parentId: string, name: string): string => `n-${createHmac('sha256', Buffer.from(seed, 'hex')).update(parentId).update('\0').update(name).digest('hex').slice(0, 32)}`
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: page([
        { kind: 'node', node: { node: { id: 'stable', parentId: 'root', name: 'stable', path: join(directory, 'stable'), kind: 'directory', ownBytes: 0, device: '1', inode: '2' }, pathKey: 'stable' } },
        { kind: 'node', node: { node: { id: 'reset', parentId: 'root', name: 'reset', path: join(directory, 'reset'), kind: 'directory', ownBytes: 0, device: '1', inode: '3' }, pathKey: 'reset' } }
      ]) })
      database.takeWork({ limit: 2, focusTurns: 0 })
      const resetOwner = idFor('reset', 'file')
      database.accept({ kind: 'page', page: { ...page([], true, 0, 'stable'), depth: 1 } })
      database.accept({ kind: 'page', page: { ...page([
        { kind: 'node', node: { node: { id: resetOwner, parentId: 'reset', name: 'file', path: join(directory, 'reset', 'file'), kind: 'file', ownBytes: 10, device: '1', inode: '90' }, pathKey: 'reset/file', linkCount: 2 } }
      ], false, 0, 'reset'), depth: 1 } })
      database.checkpoint({ reason: 'scheduled' })
      database.abort()

      const malformed = new DatabaseSync(path)
      try {
        malformed.exec('PRAGMA foreign_keys=ON; BEGIN;')
        malformed.prepare('INSERT INTO hardlink_paths (parent_id, name, path_key, device, inode, allocated_bytes) VALUES (?, ?, ?, ?, ?, ?)').run('stable', 'external', 'stable/external', '1', '90', 10)
        malformed.prepare('UPDATE directory_observations SET direct_skipped_count = 1, direct_duplicate_count = 1 WHERE node_id = ?').run('stable')
        malformed.prepare('DELETE FROM nodes WHERE id = ?').run(resetOwner)
        malformed.prepare(`INSERT INTO nodes
          (id, parent_id, name, path, kind, own_bytes, size_bytes, device, inode, scan_state, enumeration_complete, depth)
          VALUES (?, ?, ?, ?, 'file', 10, 10, '1', '99', 'complete', 1, 2)`).run(idFor('stable', 'external'), 'stable', 'collision', join(directory, 'stable', 'collision'))
        malformed.exec('COMMIT')
      } finally { malformed.close() }
      const before = readConstructionSnapshot(path)
      const resumed = ConstructionDatabase.openResumable(path)
      let error: unknown
      try {
        resumed.recoverIncompleteDirectories()
        const task = resumed.takeWork({ limit: 1, focusTurns: 0 }).work[0]
        expect(task?.id).toBe('reset')
        resumed.accept({ kind: 'page', page: {
          ...page([], true, task?.entriesRead ?? 0, task?.id ?? '', task?.enumerationEpoch ?? 1), depth: task?.depth ?? 1, focused: task?.focused ?? false
        } })
        resumed.takeWork({ limit: 1, focusTurns: 0 })
      } catch (caught) { error = caught } finally { resumed.abort() }
      expect(error).toBeInstanceOf(ConstructionError)
      expect(error).toMatchObject({ code: 'invalid-resume' })
      expect(readConstructionSnapshot(path)).toEqual(before)
    } finally { database.abort() }
  })

  it('removes an affected hard-link identity when its last path is in the reset subtree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-hardlink-no-path-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    const seed = database.nodeIdSeed
    const makePage = (taskId: string, depth: number, entries: ConstructionPage['entries'], done: boolean): ConstructionPage => ({
      taskId, depth, focused: false, entriesRead: 0, enumerationEpoch: 1, done, entries, bulkMetadataEntries: 0, fallbackMetadataEntries: 0
    })
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: makePage('root', 0, [
        { kind: 'node', node: { node: { id: 'stable', parentId: 'root', name: 'stable', path: join(directory, 'stable'), kind: 'directory', ownBytes: 0, device: '1', inode: '2' }, pathKey: 'stable' } },
        { kind: 'node', node: { node: { id: 'reset', parentId: 'root', name: 'reset', path: join(directory, 'reset'), kind: 'directory', ownBytes: 0, device: '1', inode: '3' }, pathKey: 'reset' } }
      ], true) })
      database.takeWork({ limit: 1, focusTurns: 0 })
      database.accept({ kind: 'page', page: makePage('stable', 1, [], true) })
      database.takeWork({ limit: 1, focusTurns: 0 })
      const ownerId = `n-${createHmac('sha256', Buffer.from(seed, 'hex')).update('reset').update('\0').update('file').digest('hex').slice(0, 32)}`
      database.accept({ kind: 'page', page: makePage('reset', 1, [
        { kind: 'node', node: { node: { id: ownerId, parentId: 'reset', name: 'file', path: join(directory, 'reset', 'file'), kind: 'file', ownBytes: 10, device: '1', inode: '70' }, pathKey: 'reset/file', linkCount: 2 } }
      ], false) })
      database.checkpoint({ reason: 'scheduled' })
      database.abort()

      const resumed = ConstructionDatabase.openResumable(path)
      try {
        expect(resumed.recoverIncompleteDirectories()).toMatchObject({ roots: 1, deletedNodes: 0, affectedHardlinkIdentities: 1, repairedSchedulerRows: 3 })
        expect(resumed.getHardLinkOwner('1', '70')).toMatchObject({ nodeId: ownerId, pathKey: 'reset/file' })
        const task = resumed.takeWork({ limit: 1, focusTurns: 0 }).work[0]
        expect(task?.id).toBe('reset')
        resumed.accept({ kind: 'page', page: {
          ...makePage('reset', 1, [], true), entriesRead: task?.entriesRead ?? 0, enumerationEpoch: task?.enumerationEpoch ?? 1
        } })
        expect(resumed.takeWork({ limit: 1, focusTurns: 0 }).done).toBe(true)
        resumed.checkpoint({ reason: 'resume' })
      } finally { resumed.abort() }
      const snapshot = readConstructionSnapshot(path)
      expect(snapshot.hardlinkOwners).toEqual([])
      expect(snapshot.hardlinkPaths).toEqual([])
      expect(snapshot.nodes.some((row) => row.nodeId === ownerId)).toBe(false)
    } finally { database.abort() }
  })

  it('rejects finalized hard-link groups before mutating a traversal checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-invalid-groups-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
    database.checkpoint({ reason: 'startup' })
    database.abort()
    const invalid = new DatabaseSync(path)
    try {
      invalid.exec(`
        PRAGMA foreign_keys=ON;
        BEGIN;
        INSERT INTO hardlink_paths (parent_id, name, path_key, device, inode, allocated_bytes)
          VALUES ('root', 'file', 'file', '1', '80', 10);
        INSERT INTO hardlink_groups (device, inode, owner_path_key, node_id, allocated_bytes)
          VALUES ('1', '80', 'file', 'root', 10);
        COMMIT;
      `)
    } finally { invalid.close() }
    const before = readConstructionSnapshot(path)
    const resumed = ConstructionDatabase.openResumable(path)
    try {
      expect(() => resumed.recoverIncompleteDirectories()).toThrow(ConstructionError)
      try { resumed.recoverIncompleteDirectories() } catch (error) {
        expect(error).toMatchObject({ code: 'invalid-resume' })
      }
    } finally { resumed.abort() }
    expect(readConstructionSnapshot(path)).toEqual(before)
  })

  it('counts durable checkpoints without treating terminal commit as another checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-checkpoint-counter-'))
    cleanup.push(directory)
    const counters = emptyScanCounters()
    const sequences: number[] = []
    const unsubscribe = subscribeScanCounters((event) => { if (event.generation === 31) counters[event.counter] += event.value })
    try {
      runWithScanDiagnostics(31, () => {
        const database = ConstructionDatabase.create(join(directory, 'partial.sqlite'), {
          ...options(), onCheckpoint: (_reason, sequence) => sequences.push(sequence)
        })
        database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
        database.checkpoint({ reason: 'startup' })
        database.complete()
      })
    } finally { unsubscribe() }
    expect(sequences).toEqual([1])
    expect(counters.databaseCheckpoints).toBe(sequences.length)
  })

  it('migrates a legacy traversing phase into the explicit scanning phase on resume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-migration-'))
    cleanup.push(directory)
    const path = join(directory, 'partial.sqlite')
    const database = ConstructionDatabase.create(path, options())
    database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
    database.checkpoint({ reason: 'startup' })
    database.abort()

    const legacy = new DatabaseSync(path)
    try {
      legacy.exec(`
        BEGIN;
        ALTER TABLE nodes DROP COLUMN seen_epoch;
        ALTER TABLE hardlink_paths DROP COLUMN seen_epoch;
        ALTER TABLE directory_tasks DROP COLUMN enumeration_epoch;
        ALTER TABLE scan_run RENAME TO scan_run_legacy;
        CREATE TABLE scan_run (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1), scan_id TEXT NOT NULL UNIQUE,
          node_id_seed TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('traversing', 'awaiting-reconciliation', 'finalizing')),
          checkpoint_sequence INTEGER NOT NULL DEFAULT 0, active_elapsed_ms INTEGER NOT NULL DEFAULT 0,
          journal_device TEXT NOT NULL, journal_uuid TEXT NOT NULL, journal_baseline TEXT NOT NULL,
          drained_through TEXT NOT NULL, checkpointed_at TEXT NOT NULL
        );
        INSERT INTO scan_run SELECT singleton, scan_id, node_id_seed,
          CASE phase WHEN 'scanning' THEN 'traversing' ELSE phase END, checkpoint_sequence, active_elapsed_ms,
          journal_device, journal_uuid, journal_baseline, drained_through, checkpointed_at FROM scan_run_legacy;
        DROP TABLE scan_run_legacy;
        COMMIT;
      `)
    } finally { legacy.close() }

    const resumed = ConstructionDatabase.openResumable(path)
    try { expect(resumed.phase).toBe('scanning') } finally { resumed.abort() }
    const migrated = new DatabaseSync(path, { readOnly: true })
    try {
      const columnNames = (table: string): Set<string> => new Set((migrated.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((column) => column.name))
      expect(columnNames('nodes')).toContain('seen_epoch')
      expect(columnNames('hardlink_paths')).toContain('seen_epoch')
      expect(columnNames('directory_tasks')).toContain('enumeration_epoch')
      expect(migrated.prepare('SELECT resume_replay_pending AS pending FROM scan_run').get()).toEqual({ pending: 0 })
    } finally { migrated.close() }
  })

  it('discards current work on unexpected failure while preserving the last durable scan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-failure-'))
    cleanup.push(directory)
    const database = ConstructionDatabase.create(join(directory, 'partial.sqlite'), options())
    database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
    database.checkpoint({ reason: 'startup' })
    database.accept({ kind: 'page', page: page([{ kind: 'node', node: { node: { id: 'file', parentId: 'root', name: 'file', path: join(directory, 'file'), kind: 'file', ownBytes: 10, device: '1', inode: '2' }, pathKey: 'file' } }], false) })
    expect(database.finish({ kind: 'unexpected-failure', cause: new Error('boom') })).toEqual({ kind: 'failed', checkpointSequence: 1 })

    const reopened = new DatabaseSync(join(directory, 'partial.sqlite'), { readOnly: true })
    try {
      expect(reopened.prepare('SELECT phase, checkpoint_sequence AS sequence FROM scan_run').get()).toEqual({ phase: 'scanning', sequence: 1 })
      expect(reopened.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({ count: 1 })
    } finally { reopened.close() }
  })

  it('retains a valid finalizing construction when a candidate is invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-finalizing-recovery-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(target)
    await mkdir(indexes)
    const targetStats = await lstat(target)
    const indexStats = await lstat(indexes)
    const scanId = 'b1234567-89ab-4cde-8fab-0123456789ab'
    const store = new FullScanResumeStore(indexes)
    const descriptor = store.descriptor({
      scanId, target, targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
      indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
      checkpoint: { device: String(targetStats.dev), journalUuid: 'journal', eventId: '0' }
    })
    const partialPath = join(indexes, descriptor.partialFile)
    const candidatePath = join(indexes, descriptor.candidateFile)
    const seed = 'a'.repeat(64)
    const rootId = `n-${createHmac('sha256', Buffer.from(seed, 'hex')).update('root').update('\0').update(target).digest('hex').slice(0, 32)}`
    const database = ConstructionDatabase.create(partialPath, {
      scanId, nodeIdSeed: seed, journalDevice: String(targetStats.dev), journalUuid: 'journal', journalBaseline: '0'
    })
    database.insertRoot({ id: rootId, parentId: null, name: 'target', path: target, kind: 'directory', ownBytes: 0, device: String(targetStats.dev), inode: String(targetStats.ino) })
    database.accept({ kind: 'page', page: page([], true, 0, rootId) })
    database.setPhase('finalizing')
    database.writeMetadata({
      target, rootId, capacityBytes: 100, freeBytes: 50, scannedBytes: 0,
      totals: { scannedItems: 1, discoveredBytes: 0, elapsedMs: 0, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 },
      targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino), resume: { drainedThrough: '0', dirtyScopes: [] }
    })
    database.checkpoint({ reason: 'finalize' })
    database.abort()
    await writeFile(candidatePath, 'not-a-sqlite-database')
    await writeFile(join(indexes, `${descriptor.candidateFile}.staging-0123456789abcdef`), 'stale staging')
    await store.publish(descriptor)

    const loaded = await store.load(target)
    expect(loaded).toMatchObject({ kind: 'construction', partialPath, candidatePath, descriptor: { scanId } })
    await expect(lstat(candidatePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(indexes, `${descriptor.candidateFile}.staging-0123456789abcdef`))).rejects.toMatchObject({ code: 'ENOENT' })

    const resumed = ConstructionDatabase.openResumable(partialPath, { candidatePath })
    expect(resumed.recoverIncompleteDirectories()).toEqual({ roots: 0, deletedNodes: 0, affectedHardlinkIdentities: 0, repairedAncestors: 0, repairedSchedulerRows: 0 })
    const retry = resumed.finish({ kind: 'finalize' })
    expect(retry).toMatchObject({ kind: 'candidate', candidatePath })
  })

  it('preserves an invalid candidate when no valid construction fallback exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-invalid-fallback-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(target)
    await mkdir(indexes)
    const targetStats = await lstat(target)
    const indexStats = await lstat(indexes)
    const scanId = 'c1234567-89ab-4cde-8fab-0123456789ab'
    const store = new FullScanResumeStore(indexes)
    const descriptor = store.descriptor({
      scanId, target, targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
      indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
      checkpoint: { device: String(targetStats.dev), journalUuid: 'journal', eventId: '0' }
    })
    const partialPath = join(indexes, descriptor.partialFile)
    const candidatePath = join(indexes, descriptor.candidateFile)
    await writeFile(partialPath, 'not-a-sqlite-database')
    await writeFile(candidatePath, 'not-a-sqlite-database')
    await store.publish(descriptor)

    await expect(store.load(target)).resolves.toMatchObject({ kind: 'restart', reason: 'invalid-resume-database' })
    expect((await lstat(candidatePath)).isFile()).toBe(true)
  })

  it('builds and validates an independent immutable candidate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-database-candidate-'))
    cleanup.push(directory)
    const partialPath = join(directory, 'partial.sqlite')
    const candidatePath = join(directory, 'candidate.sqlite')
    const clock = options(candidatePath)
    const database = ConstructionDatabase.create(partialPath, clock)
    database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
    database.accept({ kind: 'page', page: page([]) })
    const metadata = {
      target: directory, rootId: 'root', capacityBytes: 100, freeBytes: 50, scannedBytes: 0,
      totals: { scannedItems: 1, discoveredBytes: 0, elapsedMs: 0, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 },
      targetDevice: '1', targetInode: '1', indexRevision: 1, capturedAt: new Date(1_000).toISOString(), refreshedAt: new Date(1_000).toISOString(),
      resume: { drainedThrough: '0', dirtyScopes: [] as string[] }
    }
    const result = database.finish({ kind: 'finalize', metadata })
    expect(result).toEqual({ kind: 'candidate', candidatePath, metadata })
    expect((await lstat(partialPath)).ino).not.toBe((await lstat(candidatePath)).ino)

    const candidate = new DatabaseSync(candidatePath, { readOnly: true })
    try {
      expect(candidate.prepare("SELECT name FROM sqlite_master WHERE name = 'scan_run'").get()).toBeUndefined()
      expect(candidate.prepare('SELECT value FROM metadata WHERE key = \'target\'').get()).toEqual({ value: directory })
    } finally { candidate.close() }
  })
})

async function createAggregateRecoveryFixture(): Promise<{
  readonly directory: string
  readonly path: string
  readonly rootId: string
  readonly affectedId: string
  readonly stableId: string
  readonly unrelatedId: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'orbis-database-aggregate-fault-'))
  cleanup.push(directory)
  const path = join(directory, 'partial.sqlite')
  const database = ConstructionDatabase.create(path, options())
  const entry = (id: string, name: string, kind: 'directory' | 'file', parentId: string, inode: string, ownBytes = 0) => ({
    kind: 'node' as const,
    node: { node: { id, parentId, name, path: join(directory, name), kind, ownBytes, device: '1', inode }, pathKey: name }
  })
  try {
    database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
    database.takeWork({ limit: 1, focusTurns: 0 })
    database.accept({ kind: 'page', page: page([
      entry('affected', 'affected', 'directory', 'root', '2'),
      entry('stable', 'stable', 'directory', 'root', '3'),
      entry('unrelated', 'unrelated', 'directory', 'root', '4')
    ]) })
    database.takeWork({ limit: 1, focusTurns: 0 })
    database.accept({ kind: 'page', page: { ...page([
      entry('file', 'file', 'file', 'affected', '5', 10)
    ], false, 0, 'affected'), depth: 1 } })
    database.takeWork({ limit: 1, focusTurns: 0 })
    database.accept({ kind: 'page', page: { ...page([], true, 0, 'stable'), depth: 1 } })
    database.takeWork({ limit: 1, focusTurns: 0 })
    database.accept({ kind: 'page', page: { ...page([], true, 0, 'unrelated'), depth: 1 } })
    database.checkpoint({ reason: 'scheduled' })
  } finally { database.abort() }
  return { directory, path, rootId: 'root', affectedId: 'affected', stableId: 'stable', unrelatedId: 'unrelated' }
}

function replayAggregateFixture(database: ConstructionDatabase): void {
  const batch = database.takeWork({ limit: 8, focusTurns: 0 })
  for (const task of batch.work) {
    const entries: ConstructionPage['entries'] = task.id === 'affected' ? [{
      kind: 'node', node: { node: {
        id: 'file', parentId: 'affected', name: 'file', path: 'affected/file', kind: 'file', ownBytes: 10, device: '1', inode: '5'
      }, pathKey: 'affected/file' }
    }] : []
    database.accept({ kind: 'page', page: {
      ...page(entries, true, task.entriesRead, task.id, task.enumerationEpoch), depth: task.depth, focused: task.focused
    } })
  }
  database.takeWork({ limit: 1, focusTurns: 0 })
}

function installAggregateAudit(path: string): void {
  const database = new DatabaseSync(path)
  try {
    database.exec(`
      CREATE TABLE aggregate_audit (node_id TEXT NOT NULL);
      CREATE TRIGGER aggregate_audit_update
      AFTER UPDATE OF size_bytes, direct_children, descendant_count, unreadable_count ON nodes
      BEGIN INSERT INTO aggregate_audit (node_id) VALUES (NEW.id); END;
    `)
  } finally { database.close() }
}

function installAggregateFault(path: string, mode: 'one-shot' | 'persistent'): void {
  const database = new DatabaseSync(path)
  try {
    if (mode === 'one-shot') database.exec(`
      CREATE TABLE aggregate_fault (remaining INTEGER NOT NULL);
      INSERT INTO aggregate_fault VALUES (1);
      CREATE TRIGGER aggregate_fault_update
      AFTER UPDATE OF size_bytes ON nodes
      WHEN (SELECT remaining FROM aggregate_fault) > 0 AND NEW.id = 'root'
      BEGIN
        UPDATE aggregate_fault SET remaining = remaining - 1;
        UPDATE nodes SET size_bytes = NEW.size_bytes + 1 WHERE id = NEW.id;
      END;
    `)
    else database.exec(`
      CREATE TRIGGER aggregate_fault_update
      AFTER UPDATE OF size_bytes ON nodes
      WHEN NEW.kind = 'directory'
      BEGIN UPDATE nodes SET size_bytes = NEW.size_bytes + 1 WHERE id=NEW.id; END;
    `)
  } finally { database.close() }
}

interface GeneratedRecoveryNode extends InsertNode {
  readonly depth: number
  readonly children: GeneratedRecoveryNode[]
}

interface GeneratedRecoveryFixture {
  readonly directory: string
  readonly path: string
  readonly root: GeneratedRecoveryNode
  readonly selectedRoots: readonly GeneratedRecoveryNode[]
}

interface DeepAggregateFixture {
  readonly directory: string
  readonly path: string
  readonly chain: readonly GeneratedRecoveryNode[]
  readonly siblingCount: number
}

async function createDeepAggregateFixture(): Promise<DeepAggregateFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'orbis-deep-aggregate-'))
  cleanup.push(directory)
  const path = join(directory, 'partial.sqlite')
  const root: GeneratedRecoveryNode = {
    id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0,
    device: '', inode: '', depth: 0, children: []
  }
  const chain = [root]
  const database = ConstructionDatabase.create(path, options())
  try {
    database.insertRoot(root)
    let parent = root
    for (let depth = 1; depth <= 20; depth += 1) {
      const child: GeneratedRecoveryNode = {
        id: `chain-${depth}`, parentId: parent.id, name: `chain-${depth}`, path: join(parent.path, `chain-${depth}`),
        kind: 'directory', ownBytes: 0, device: '', inode: '', depth, children: []
      }
      const sibling: GeneratedRecoveryNode = {
        id: `sibling-${depth}`, parentId: parent.id, name: `sibling-${depth}`, path: join(parent.path, `sibling-${depth}`),
        kind: 'directory', ownBytes: 0, device: '', inode: '', depth, children: []
      }
      parent.children.push(child, sibling)
      database.insertChild(child, depth, false)
      database.insertChild(sibling, depth, false)
      parent = child
      chain.push(child)
    }
    const file: GeneratedRecoveryNode = {
      id: 'deep-file', parentId: parent.id, name: 'deep-file', path: join(parent.path, 'deep-file'),
      kind: 'file', ownBytes: 17, device: '', inode: '', depth: parent.depth + 1, children: []
    }
    parent.children.push(file)
    database.insertChild(file, file.depth, false)
    for (const node of [...chain, ...chain.flatMap((item) => item.children.filter((child) => child.kind === 'directory'))]
      .filter((node) => node.id !== parent.id).sort((left, right) => right.depth - left.depth)) database.finishEnumeration(node.id)
    database.startTask(parent.id)
    database.checkpoint({ reason: 'scheduled' })
  } finally { database.abort() }
  return { directory, path, chain, siblingCount: 20 }
}

async function createGeneratedRecoveryFixture(seed: number): Promise<GeneratedRecoveryFixture> {
  const directory = await mkdtemp(join(tmpdir(), `orbis-generated-recovery-${seed}-`))
  cleanup.push(directory)
  const random = deterministicRandom(seed)
  let nextId = 0
  let directoryCount = 1
  let fileCount = 0
  const root: GeneratedRecoveryNode = {
    id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0,
    device: '', inode: '', depth: 0, children: []
  }
  const directories = [root]
  while (directories.length > 0) {
    const parent = directories.shift()!
    const directoryLimit = parent.depth < 5 && directoryCount < 40 ? Math.min(3, 40 - directoryCount) : 0
    let childDirectories = directoryLimit === 0 ? 0 : random() % (directoryLimit + 1)
    if (parent === root) childDirectories = Math.min(directoryLimit, 2 + random() % 2)
    for (let index = 0; index < childDirectories; index += 1) {
      const name = `dir-${String(nextId++).padStart(2, '0')}`
      const child: GeneratedRecoveryNode = {
        id: name, parentId: parent.id, name, path: join(parent.path, name), kind: 'directory', ownBytes: 0,
        device: '', inode: '', depth: parent.depth + 1, children: []
      }
      parent.children.push(child)
      directories.push(child)
      directoryCount += 1
    }
    const files = Math.min(5, 80 - fileCount, random() % 6)
    for (let index = 0; index < files; index += 1) {
      const name = `file-${String(nextId++).padStart(2, '0')}`
      parent.children.push({
        id: name, parentId: parent.id, name, path: join(parent.path, name), kind: 'file', ownBytes: (random() % 31) + 1,
        device: '', inode: '', depth: parent.depth + 1, children: []
      })
      fileCount += 1
    }
    if (directoryCount >= 40 && fileCount >= 80) break
  }
  const rootDirectories = root.children.filter((child) => child.kind === 'directory')
  const selectedCount = Math.max(1, Math.min(3, rootDirectories.length > 1 ? rootDirectories.length - 1 : rootDirectories.length))
  const selectedRoots = rootDirectories.slice(-selectedCount)
  const path = join(directory, 'partial.sqlite')
  const database = ConstructionDatabase.create(path, options())
  try {
    database.insertRoot(root)
    for (const node of preorder(root).slice(1)) database.insertChild(node, node.depth, false)
    for (const node of [...directoriesFor(root)].sort((left, right) => right.depth - left.depth)) {
      if (selectedRoots.includes(node)) {
        database.startTask(node.id)
        database.advanceTask(node.id, Math.floor(node.children.length / 2))
      } else database.finishEnumeration(node.id)
    }
    database.checkpoint({ reason: 'scheduled' })
  } finally { database.abort() }
  return { directory, path, root, selectedRoots }
}

function replayGeneratedEntries(database: ConstructionDatabase, fixture: GeneratedRecoveryFixture): void {
  const byId = new Map(preorder(fixture.root).map((node) => [node.id, node]))
  while (true) {
    const batch = database.takeWork({ limit: 1, focusTurns: 0 })
    if (batch.done) return
    const task = batch.work[0]
    if (!task) throw new Error('Generated recovery fixture returned an empty work batch')
    const node = byId.get(task.id)
    if (!node) throw new Error(`Missing generated directory ${task.id}`)
    database.accept({ kind: 'page', page: {
      taskId: task.id, depth: task.depth, focused: task.focused, entriesRead: task.entriesRead, enumerationEpoch: task.enumerationEpoch, done: true,
      entries: node.children.map((child) => ({ kind: 'node' as const, node: { node: child, pathKey: child.path.slice(fixture.root.path.length + 1) } })),
      bulkMetadataEntries: 0, fallbackMetadataEntries: 0
    } })
  }
}

function preorder(root: GeneratedRecoveryNode): GeneratedRecoveryNode[] {
  return [root, ...root.children.flatMap((child) => child.kind === 'directory' ? preorder(child) : [child])]
}

function directoriesFor(root: GeneratedRecoveryNode): GeneratedRecoveryNode[] {
  return preorder(root).filter((node) => node.kind === 'directory')
}

function deterministicRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}
