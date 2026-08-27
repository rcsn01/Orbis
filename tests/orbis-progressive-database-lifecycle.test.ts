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
import { readConstructionSnapshot, recoverWithLegacyReference } from './helpers/orbis-resume-recovery'

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

function page(entries: ConstructionPage['entries'], done = true, entriesRead = 0, taskId = 'root'): ConstructionPage {
  return { taskId, depth: 0, focused: false, entriesRead, done, entries, bulkMetadataEntries: 0, fallbackMetadataEntries: 0 }
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
      taskId, depth, focused, entriesRead, done, entries, bulkMetadataEntries: 0, fallbackMetadataEntries: 0
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
      const legacy = recoverWithLegacyReference(path, join(directory, 'legacy.sqlite'))
      const resumed = ConstructionDatabase.openResumable(path)
      try {
        const recovery = resumed.recoverIncompleteDirectories()
        expect(recovery).toEqual({ roots: 2, deletedNodes: 2, affectedHardlinkIdentities: 1, repairedAncestors: 6, repairedSchedulerRows: 6 })
        expect(resumed.taskIsFocused('reset')).toBe(true)
        expect(resumed.getHardLinkOwner('1', '50')).toEqual({ nodeId: hardLinkId('stable', 'external'), pathKey: 'left/stable/external' })
        expect(resumed.takeWork({ limit: 2, focusTurns: 0 }).work.map((task) => task.id)).toEqual(['reset', 'reset-right'])
        resumed.checkpoint({ reason: 'resume' })
        expect(readConstructionSnapshot(path).directoryTasks.find((row) => row.nodeId === 'right')).toMatchObject({ status: 'unreadable', pendingChildren: 1, subtreeComplete: 0, ready: 0 })
      } finally { resumed.abort() }

      const after = readConstructionSnapshot(path)
      expect(after.nodes).toEqual(legacy.nodes)
      expect(after.nodes.find((row) => row.id === hardLinkId('stable', 'external'))).toMatchObject({
        parentId: 'stable', sizeBytes: 10, directChildren: 0, descendantCount: 0, unreadableCount: 0
      })
      expect(after.nodes.find((row) => row.id === 'stable')).toMatchObject({ sizeBytes: 10, directChildren: 1, descendantCount: 1, unreadableCount: 0 })
      expect(after.nodes.find((row) => row.id === 'left')).toMatchObject({ sizeBytes: 10, directChildren: 2, descendantCount: 3, unreadableCount: 0 })
      expect(after.nodes.find((row) => row.id === 'stable-right')).toMatchObject({ sizeBytes: 20, directChildren: 2, descendantCount: 2, unreadableCount: 0 })
      expect(after.nodes.find((row) => row.id === 'right')).toMatchObject({ sizeBytes: 20, directChildren: 2, descendantCount: 4, unreadableCount: 1 })
      expect(after.nodes.find((row) => row.id === 'root')).toMatchObject({ sizeBytes: 30, directChildren: 2, descendantCount: 9, unreadableCount: 1 })
      expect(after.hardlinkOwners).toEqual(legacy.hardlinkOwners)
      expect(after.hardlinkPaths).toEqual(legacy.hardlinkPaths)
      expect(after.directoryObservations).toEqual(legacy.directoryObservations)
      expect(after.directoryTasks.find((row) => row.nodeId === 'stable-right')).toEqual(before.directoryTasks.find((row) => row.nodeId === 'stable-right'))
      expect(after.directoryTasks.filter((row) => row.ready === 1).map((row) => row.nodeId)).toEqual(['reset', 'reset-right'])
      expect(after.hardlinkOwners).toEqual([
        { device: '1', inode: '50', nodeId: hardLinkId('stable', 'external'), pathKey: 'left/stable/external' },
        { device: '1', inode: '61', nodeId: hardLinkId('stable-right', 'u-a'), pathKey: 'right/stable-right/u-a' }
      ])
      expect(after.hardlinkPaths).toEqual([
        { parentId: 'stable', name: 'external', pathKey: 'left/stable/external', device: '1', inode: '50', allocatedBytes: 10 },
        { parentId: 'stable-right', name: 'u-a', pathKey: 'right/stable-right/u-a', device: '1', inode: '61', allocatedBytes: 10 },
        { parentId: 'stable-right', name: 'u-b', pathKey: 'right/stable-right/u-b', device: '1', inode: '61', allocatedBytes: 10 }
      ])
      expect(after.directoryObservations.find((row) => row.nodeId === 'stable')?.directDuplicateCount).toBe(0)
      expect(after.directoryObservations.find((row) => row.nodeId === 'stable-right')).toEqual(before.directoryObservations.find((row) => row.nodeId === 'stable-right'))
      expect(after.nodes.some((row) => row.nodeId === 'nested')).toBe(false)
    } finally { database.abort() }
  })

  it('repairs scoped aggregates and uses the diagnostic fallback only after an affected mismatch', async () => {
    const fixture = await createAggregateRecoveryFixture()
    installAggregateAudit(fixture.path)
    installAggregateFault(fixture.path, 'one-shot')
    const counters = emptyScanCounters()
    const events: OrbisTimingEvent[] = []
    const unsubscribeCounters = subscribeScanCounters((event) => { if (event.generation === 101) counters[event.counter] += event.value })
    const unsubscribeTimings = subscribeScanDiagnostics((event) => { if (event.generation === 101) events.push(event) })
    const resumed = ConstructionDatabase.openResumable(fixture.path)
    try {
      const recovery = runWithScanDiagnostics(101, () => resumed.recoverIncompleteDirectories())
      expect(recovery.repairedAncestors).toBe(2)
      resumed.checkpoint({ reason: 'resume' })
      expect(counters.resumeAggregateFallbacks).toBe(1)
      expect(events.filter((event) => event.phase === 'resume-aggregate-fallback')).toHaveLength(1)
    } finally {
      resumed.abort()
      unsubscribeCounters()
      unsubscribeTimings()
    }
    const snapshot = readConstructionSnapshot(fixture.path)
    expect(snapshot.directoryAggregateOracle).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.rootId }), expect.objectContaining({ id: fixture.affectedId })
    ]))
    for (const aggregate of snapshot.directoryAggregateOracle) {
      const node = snapshot.nodes.find((row) => row.id === aggregate.id)
      expect(node).toMatchObject(aggregate)
    }
    const audit = new DatabaseSync(fixture.path, { readOnly: true })
    try {
      const writes = (audit.prepare('SELECT node_id AS nodeId FROM aggregate_audit').all() as unknown as Array<{ nodeId: string }>).map((row) => row.nodeId)
      expect(new Set(writes)).toEqual(new Set([fixture.rootId, fixture.affectedId, fixture.stableId, fixture.unrelatedId]))
    } finally { audit.close() }
  })

  it('rejects unrelated aggregate corruption instead of invoking the global fallback', async () => {
    const fixture = await createAggregateRecoveryFixture()
    const malformed = new DatabaseSync(fixture.path)
    try { malformed.prepare('UPDATE nodes SET size_bytes = size_bytes + 1 WHERE id = ?').run(fixture.stableId) }
    finally { malformed.close() }
    installAggregateFault(fixture.path, 'one-shot')
    const before = readConstructionSnapshot(fixture.path)
    const counters = emptyScanCounters()
    const events: OrbisTimingEvent[] = []
    const unsubscribeCounters = subscribeScanCounters((event) => { if (event.generation === 102) counters[event.counter] += event.value })
    const unsubscribeTimings = subscribeScanDiagnostics((event) => { if (event.generation === 102) events.push(event) })
    const resumed = ConstructionDatabase.openResumable(fixture.path)
    let error: unknown
    try { runWithScanDiagnostics(102, () => resumed.recoverIncompleteDirectories()) } catch (caught) { error = caught } finally {
      resumed.abort()
      unsubscribeCounters()
      unsubscribeTimings()
    }
    expect(error).not.toBeInstanceOf(ConstructionError)
    expect(String((error as Error)?.message)).toMatch(/unrelated.*aggregate/i)
    expect(counters.resumeAggregateFallbacks).toBe(0)
    expect(events.filter((event) => event.phase === 'resume-aggregate-fallback')).toHaveLength(0)
    expect(readConstructionSnapshot(fixture.path)).toEqual(before)
  })

  it('rolls back a persistent aggregate fallback fault with the durable checkpoint intact', async () => {
    const fixture = await createAggregateRecoveryFixture()
    installAggregateFault(fixture.path, 'persistent')
    const before = readConstructionSnapshot(fixture.path)
    const counters = emptyScanCounters()
    const unsubscribe = subscribeScanCounters((event) => { if (event.generation === 103) counters[event.counter] += event.value })
    const resumed = ConstructionDatabase.openResumable(fixture.path)
    let error: unknown
    try { runWithScanDiagnostics(103, () => resumed.recoverIncompleteDirectories()) } catch (caught) { error = caught } finally {
      resumed.abort()
      unsubscribe()
    }
    expect(error).not.toBeInstanceOf(ConstructionError)
    expect(String((error as Error)?.message)).toMatch(/after resume fallback|aggregate/i)
    expect(counters.resumeAggregateFallbacks).toBe(1)
    expect(readConstructionSnapshot(fixture.path)).toEqual(before)
  })

  it.each([11, 23, 47])('matches the independent aggregate oracle for generated checkpoint seed %i', async (seed) => {
    const fixture = await createGeneratedRecoveryFixture(seed)
    const legacy = recoverWithLegacyReference(fixture.path, join(fixture.directory, 'legacy.sqlite'))
    const resumed = ConstructionDatabase.openResumable(fixture.path)
    try {
      const recovery = resumed.recoverIncompleteDirectories()
      expect(recovery.roots).toBe(fixture.selectedRoots.length)
      expect(recovery.repairedAncestors).toBe(fixture.selectedRoots.length + 1)
      resumed.checkpoint({ reason: 'resume' })
      const recovered = readConstructionSnapshot(fixture.path)
      expect(recovered.nodes).toEqual(legacy.nodes)
      expect(recovered.directoryObservations).toEqual(legacy.directoryObservations)
      expect(recovered.hardlinkOwners).toEqual(legacy.hardlinkOwners)
      expect(recovered.hardlinkPaths).toEqual(legacy.hardlinkPaths)

      replayGeneratedEntries(resumed, fixture)
      resumed.checkpoint({ reason: 'scheduled' })
    } finally { resumed.abort() }
    const final = readConstructionSnapshot(fixture.path)
    for (const aggregate of final.directoryAggregateOracle) {
      expect(final.nodes.find((row) => row.id === aggregate.id)).toMatchObject(aggregate)
    }
  })

  it('scales aggregate writes with an affected deep chain', async () => {
    const fixture = await createDeepAggregateFixture()
    installAggregateAudit(fixture.path)
    const resumed = ConstructionDatabase.openResumable(fixture.path)
    try {
      const recovery = resumed.recoverIncompleteDirectories()
      expect(recovery.repairedAncestors).toBe(fixture.chain.length)
      resumed.checkpoint({ reason: 'resume' })
    } finally { resumed.abort() }
    const snapshot = readConstructionSnapshot(fixture.path)
    expect(snapshot.nodes.filter((row) => row.kind === 'directory')).toHaveLength(fixture.chain.length + fixture.siblingCount)
    const database = new DatabaseSync(fixture.path, { readOnly: true })
    try {
      const writes = (database.prepare('SELECT DISTINCT node_id AS nodeId FROM aggregate_audit').all() as unknown as Array<{ nodeId: string }>).map((row) => row.nodeId)
      expect(new Set(writes)).toEqual(new Set(fixture.chain.map((node) => node.id)))
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
        expect(resumed.recoverIncompleteDirectories()).toMatchObject({ roots: 1, repairedAncestors: 3 })
        const before = resumed.getNode('root')
        expect(before?.unreadableCount).toBe(1)
        expect(resumed.takeWork({ limit: 1, focusTurns: 0 }).work.map((task) => task.id)).toEqual(['child'])
        resumed.accept({ kind: 'page', page: {
          ...page([{ kind: 'node', node: { node: { id: 'file', parentId: 'child', name: 'file', path: join(directory, 'blocked', 'child', 'file'), kind: 'file', ownBytes: 10, device: '1', inode: '4' }, pathKey: 'blocked/child/file' }}], true, 0, 'child'), depth: 2
        } })
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
      taskId, depth, focused: false, entriesRead: 0, done, entries, bulkMetadataEntries: 0, fallbackMetadataEntries: 0
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
      try { resumed.recoverIncompleteDirectories() } catch (caught) { error = caught } finally { resumed.abort() }
      expect(error).not.toBeInstanceOf(ConstructionError)
      expect(String((error as Error)?.message)).toMatch(/constraint|unique|primary/i)
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
      taskId, depth, focused: false, entriesRead: 0, done, entries, bulkMetadataEntries: 0, fallbackMetadataEntries: 0
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
        expect(resumed.recoverIncompleteDirectories()).toMatchObject({ roots: 1, deletedNodes: 1, affectedHardlinkIdentities: 1, repairedSchedulerRows: 2 })
        expect(resumed.getHardLinkOwner('1', '70')).toBeUndefined()
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
      taskId: task.id, depth: task.depth, focused: task.focused, entriesRead: task.entriesRead, done: true,
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
