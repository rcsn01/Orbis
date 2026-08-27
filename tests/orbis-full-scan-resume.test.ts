import { DatabaseSync } from 'node:sqlite'
import { createHmac } from 'node:crypto'
import { access, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FullScanResumeStore } from '../src/main/full-scan-resume'
import { IndexManifestStore } from '../src/main/index-manifest'
import { ProgressiveScanControl, ScanCanceledError, scanFilesystem } from '../src/main/scanner'
import { ConstructionDatabase } from '../src/main/construction-database'
import {
  emptyScanCounters, runWithScanDiagnostics, subscribeResumeReceiptFallbacks, subscribeScanCounters, subscribeScanDiagnostics,
  type OrbisTimingEvent
} from '../src/main/diagnostics'
import type { DirectoryMetadataEntry, DirectoryMetadataSource } from '../src/main/scan-metadata'
import { normalizeCandidateSemantics, readCandidateSemantics } from './helpers/orbis-resume-recovery'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

const scanId = '31234567-89ab-4cde-8fab-0123456789ab'

describe('resumable Orbis full scans', () => {
  it('restarts an incomplete directory with the persisted node ID seed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-resume-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(target, { recursive: true })
    await mkdir(indexes, { recursive: true })
    for (let index = 0; index < 70; index += 1) await writeFile(join(target, `file-${String(index).padStart(2, '0')}`), Buffer.alloc(512, index))
    for (let index = 0; index < 10; index += 1) await mkdir(join(target, `small-${String(index).padStart(2, '0')}`))
    const targetStats = await lstat(target)
    const indexStats = await lstat(indexes)
    const store = new FullScanResumeStore(indexes)
    const descriptor = store.descriptor({
      scanId, target, targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
      indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
      checkpoint: { device: String(targetStats.dev), journalUuid: 'test-journal', eventId: '10' }
    })
    const partialPath = join(indexes, descriptor.partialFile)
    const candidatePath = join(indexes, descriptor.candidateFile)
    const abort = new AbortController()
    const sequences: number[] = []
    let previewCount = 0
    const first = scanFilesystem({
      generation: 1, target, indexDirectory: indexes, partialPath, publishedPath: candidatePath,
      signal: abort.signal, control: new ProgressiveScanControl(), resumable: { descriptor, store, resume: false }, onCheckpoint: (sequence) => sequences.push(sequence),
      onPreview: () => { previewCount += 1; if (previewCount === 2) abort.abort() }
    })
    await expect(first).rejects.toBeInstanceOf(ScanCanceledError)
    expect(sequences.length).toBeGreaterThan(1)
    const loadEvents: OrbisTimingEvent[] = []
    const loadCounters = emptyScanCounters()
    const unsubscribeLoadTimings = subscribeScanDiagnostics((event) => { if (event.generation === 20) loadEvents.push(event) })
    const unsubscribeLoadCounters = subscribeScanCounters((event) => { if (event.generation === 20) loadCounters[event.counter] += event.value })
    let loaded: Awaited<ReturnType<FullScanResumeStore['load']>>
    try { loaded = await runWithScanDiagnostics(20, () => store.load(target)) }
    finally { unsubscribeLoadTimings(); unsubscribeLoadCounters() }
    expect(loaded).toMatchObject({ kind: 'construction', descriptor: { scanId } })
    if (loaded.kind !== 'construction') throw new Error('Expected a construction receipt')

    const receiptEvents: OrbisTimingEvent[] = []
    const receiptCounters = emptyScanCounters()
    const unsubscribeReceiptTimings = subscribeScanDiagnostics((event) => { if (event.generation === 21) receiptEvents.push(event) })
    const unsubscribeReceiptCounters = subscribeScanCounters((event) => { if (event.generation === 21) receiptCounters[event.counter] += event.value })
    try {
      const reused = await runWithScanDiagnostics(21, () => store.load(target, loaded.receipt))
      expect(reused).toMatchObject({ kind: 'construction', descriptor: { scanId } })
    } finally { unsubscribeReceiptTimings(); unsubscribeReceiptCounters() }
    expect(receiptCounters.resumeReceiptValidations).toBe(1)
    expect(receiptCounters.resumeFullValidations).toBe(0)
    expect(receiptEvents.find((event) => event.phase === 'resume-integrity-check')?.durationMs).toBe(0)
    expect(receiptEvents.find((event) => event.phase === 'resume-foreign-key-check')?.durationMs).toBe(0)

    const fallbackReasons: string[] = []
    const fallbackCounters = emptyScanCounters()
    const unsubscribeFallbacks = subscribeResumeReceiptFallbacks((event) => fallbackReasons.push(event.reason))
    const unsubscribeFallbackCounters = subscribeScanCounters((event) => fallbackCounters[event.counter] += event.value)
    let currentReceipt = loaded.receipt
    try {
      const mismatches = [
        (receipt: typeof currentReceipt) => ({ ...receipt, descriptorDigest: '0'.repeat(64) }),
        (receipt: typeof currentReceipt) => ({ ...receipt, database: { ...receipt.database, size: receipt.database.size + 1 } }),
        (receipt: typeof currentReceipt) => ({ ...receipt, database: {
          ...receipt.database,
          wal: { device: '0', inode: '0', size: 0, modifiedNs: '0', changedNs: '0' },
          shm: { device: '0', inode: '0', size: 0, modifiedNs: '0', changedNs: '0' }
        } }),
        (receipt: typeof currentReceipt) => ({ ...receipt, drainedThrough: receipt.drainedThrough === '0' ? '1' : '0' }),
        (receipt: typeof currentReceipt) => ({ ...receipt, checkpointSequence: receipt.checkpointSequence! + 1 })
      ]
      for (const [index, mismatch] of mismatches.entries()) {
        const fallback = await runWithScanDiagnostics(22 + index, () => store.load(target, mismatch(currentReceipt)))
        expect(fallback).toMatchObject({ kind: 'construction', descriptor: { scanId } })
        if (fallback.kind !== 'construction') throw new Error('Expected a construction fallback')
        currentReceipt = fallback.receipt
      }
      const sidecarRaceStore = new FullScanResumeStore(indexes, {
        onReceiptValidationStep: async (step) => {
          if (step === 'post-query') {
            await writeFile(`${partialPath}-wal`, Buffer.alloc(0))
            await writeFile(`${partialPath}-shm`, Buffer.alloc(0))
          }
        }
      })
      const sidecarRaced = await runWithScanDiagnostics(27, () => sidecarRaceStore.load(target, currentReceipt))
      expect(sidecarRaced).toMatchObject({ kind: 'construction', descriptor: { scanId } })
      if (sidecarRaced.kind !== 'construction') throw new Error('Expected a sidecar-race fallback')
      currentReceipt = sidecarRaced.receipt
      const racedStore = new FullScanResumeStore(indexes, {
        onReceiptValidationStep: async (step) => {
          if (step === 'post-query') await writeFile(store.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`)
        }
      })
      const raced = await runWithScanDiagnostics(28, () => racedStore.load(target, currentReceipt))
      expect(raced).toMatchObject({ kind: 'construction', descriptor: { scanId } })
      await Promise.all([rm(`${partialPath}-wal`, { force: true }), rm(`${partialPath}-shm`, { force: true })])
    } finally { unsubscribeFallbacks(); unsubscribeFallbackCounters() }
    expect(fallbackReasons).toEqual(['descriptor-mismatch', 'database-stamp-mismatch', 'sidecar-stamp-mismatch', 'resume-row-mismatch', 'resume-row-mismatch', 'sidecar-stamp-mismatch', 'descriptor-mismatch'])
    expect(fallbackCounters.resumeReceiptFallbacks).toBe(7)
    expect(fallbackCounters.resumeFullValidations).toBe(7)

    for (const phase of ['resume-load-total', 'resume-descriptor-validation', 'resume-file-validation', 'resume-candidate-validation', 'resume-construction-validation', 'resume-integrity-check', 'resume-foreign-key-check']) {
      expect(loadEvents.filter((event) => event.phase === phase), phase).toHaveLength(1)
    }
    expect(loadCounters.resumeFullValidations).toBe(1)
    const drain = ConstructionDatabase.openResumable(partialPath)
    drain.setJournalDrain([join(target, 'changed-scope')], '12')
    drain.checkpoint()
    drain.setJournalDrain([join(target, 'later-scope')], '14')
    drain.checkpoint()
    drain.abort()
    const checkpoint = new DatabaseSync(partialPath, { readOnly: true })
    expect((checkpoint.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }).count).toBeGreaterThan(1)
    expect(checkpoint.prepare('SELECT drained_through AS cursor FROM scan_run').get()).toEqual({ cursor: '14' })
    expect(checkpoint.prepare('SELECT path FROM dirty_scopes ORDER BY path').all()).toEqual([
      { path: join(target, 'changed-scope') }, { path: join(target, 'later-scope') }
    ])
    const seed = (checkpoint.prepare('SELECT node_id_seed AS seed FROM scan_run').get() as { seed: string }).seed
    const expectedRootId = `n-${createHmac('sha256', Buffer.from(seed, 'hex')).update('root').update('\0').update(target).digest('hex').slice(0, 32)}`
    checkpoint.close()

    const resumedSequences: number[] = []
    const events: OrbisTimingEvent[] = []
    const counters = emptyScanCounters()
    const milestones: string[] = []
    const unsubscribeTimings = subscribeScanDiagnostics((event) => { if (event.generation === 2) events.push(event) })
    const unsubscribeCounters = subscribeScanCounters((event) => { if (event.generation === 2) counters[event.counter] += event.value })
    let result: Awaited<ReturnType<typeof scanFilesystem>>
    try {
      result = await scanFilesystem({
        generation: 2, target, indexDirectory: indexes, partialPath, publishedPath: candidatePath,
        resumable: { descriptor, store, resume: true }, onCheckpoint: (sequence) => resumedSequences.push(sequence),
        onResumeMilestone: (milestone) => milestones.push(milestone)
      })
    } finally { unsubscribeTimings(); unsubscribeCounters() }
    expect(resumedSequences).toHaveLength(3)
    for (const phase of ['resume-database-open', 'resume-incomplete-recovery', 'resume-hardlink-repair', 'resume-aggregate-repair', 'resume-scheduler-repair', 'resume-semantic-totals', 'resume-checkpoint']) {
      const matches = events.filter((event) => event.phase === phase)
      expect(matches, phase).toHaveLength(1)
      expect(matches[0]!.durationMs).toBeGreaterThanOrEqual(0)
    }
    expect(milestones).toEqual(['first-metadata-page'])
    expect(counters.resumeRecoveryRoots).toBeGreaterThan(0)
    expect(counters.resumeReplayedEntries).toBeGreaterThan(0)
    const candidate = new DatabaseSync(result.publishedPath, { readOnly: true })
    try {
      expect(candidate.prepare('SELECT id FROM nodes WHERE parent_id IS NULL').get()).toEqual({ id: expectedRootId })
      expect(candidate.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({ count: 81 })
      expect(() => candidate.prepare('SELECT * FROM scan_run').all()).toThrow()
    } finally { candidate.close() }
    expect(await store.load(target)).toMatchObject({ kind: 'candidate', descriptor: { scanId } })
    await rename(candidatePath, partialPath)
    await Promise.all([writeFile(`${partialPath}-wal`, Buffer.alloc(0)), writeFile(`${partialPath}-shm`, Buffer.alloc(0))])
    expect(await store.load(target)).toMatchObject({ kind: 'candidate', candidatePath })
    await expect(access(candidatePath)).resolves.toBeUndefined()
    await expect(access(`${partialPath}-wal`)).rejects.toThrow()
    await expect(access(`${partialPath}-shm`)).rejects.toThrow()
  })

  it('translates structural construction recovery errors without discarding the checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-resume-invalid-construction-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(target, { recursive: true })
    await mkdir(indexes, { recursive: true })
    const targetStats = await lstat(target)
    const indexStats = await lstat(indexes)
    const store = new FullScanResumeStore(indexes)
    const descriptor = store.descriptor({
      scanId: '41234567-89ab-4cde-8fab-0123456789ab', target,
      targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
      indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
      checkpoint: { device: String(targetStats.dev), journalUuid: 'invalid-journal', eventId: '0' }
    })
    const partialPath = join(indexes, descriptor.partialFile)
    const candidatePath = join(indexes, descriptor.candidateFile)
    const database = ConstructionDatabase.create(partialPath, {
      scanId: descriptor.scanId, journalDevice: descriptor.journalDevice, journalUuid: descriptor.journalUuid,
      journalBaseline: descriptor.journalBaseline
    })
    const seed = database.nodeIdSeed
    const rootId = `n-${createHmac('sha256', Buffer.from(seed, 'hex')).update('root').update('\0').update(target).digest('hex').slice(0, 32)}`
    database.insertRoot({ id: rootId, parentId: null, name: 'target', path: target, kind: 'directory', ownBytes: 0, device: String(targetStats.dev), inode: String(targetStats.ino) })
    database.checkpoint({ reason: 'startup' })
    database.abort()
    const invalid = new DatabaseSync(partialPath)
    try {
      invalid.exec(`
        PRAGMA foreign_keys=ON;
        BEGIN;
        INSERT INTO hardlink_paths (parent_id, name, path_key, device, inode, allocated_bytes)
          VALUES ('${rootId}', 'file', 'file', '${String(targetStats.dev)}', '80', 10);
        INSERT INTO hardlink_groups (device, inode, owner_path_key, node_id, allocated_bytes)
          VALUES ('${String(targetStats.dev)}', '80', 'file', '${rootId}', 10);
        COMMIT;
      `)
    } finally { invalid.close() }

    await expect(scanFilesystem({
      generation: 2, target, indexDirectory: indexes, partialPath, publishedPath: candidatePath,
      resumable: { descriptor, store, resume: true }
    })).rejects.toThrow('resume-invalidated:invalid-construction-state')
    const checkpoint = new DatabaseSync(partialPath, { readOnly: true })
    try {
      expect(checkpoint.prepare('SELECT phase, checkpoint_sequence AS sequence FROM scan_run').get()).toEqual({ phase: 'scanning', sequence: 1 })
      expect(checkpoint.prepare('SELECT COUNT(*) AS count FROM hardlink_groups').get()).toEqual({ count: 1 })
    } finally { checkpoint.close() }
  })

  it('rolls back an interrupted metadata batch before preserving resumable progress', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-resume-batch-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(target, { recursive: true })
    await mkdir(indexes, { recursive: true })
    const targetStats = await lstat(target)
    const indexStats = await lstat(indexes)
    const store = new FullScanResumeStore(indexes)
    const descriptor = store.descriptor({
      scanId, target, targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
      indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
      checkpoint: { device: String(targetStats.dev), journalUuid: 'test-journal', eventId: '10' }
    })
    const partialPath = join(indexes, descriptor.partialFile)
    const candidatePath = join(indexes, descriptor.candidateFile)
    const abort = new AbortController()
    let interrupt = true
    const source = metadataSource(300, (index) => {
      if (interrupt && index === 50) abort.abort()
    })
    const sequences: number[] = []
    const interrupted = scanFilesystem({
      generation: 3, target, indexDirectory: indexes, partialPath, publishedPath: candidatePath,
      signal: abort.signal, control: new ProgressiveScanControl(), directoryMetadataSource: source, metadataBatchSize: 256,
      resumable: { descriptor, store, resume: false }, onCheckpoint: (sequence) => sequences.push(sequence), onPreview: () => undefined
    })
    await expect(interrupted).rejects.toBeInstanceOf(ScanCanceledError)
    expect(sequences).toEqual([1, 2])
    const checkpoint = new DatabaseSync(partialPath, { readOnly: true })
    try {
      expect(checkpoint.prepare('SELECT entries_read AS entriesRead FROM directory_tasks').get()).toEqual({ entriesRead: 32 })
      expect(checkpoint.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({ count: 33 })
    } finally { checkpoint.close() }

    interrupt = false
    const resumed = await scanFilesystem({
      generation: 4, target, indexDirectory: indexes, partialPath, publishedPath: candidatePath,
      directoryMetadataSource: source, metadataBatchSize: 256, resumable: { descriptor, store, resume: true }
    })
    const fresh = await scanFilesystem({
      generation: 5, target, indexDirectory: join(directory, 'fresh-indexes'), partialPath: join(directory, 'fresh.partial.sqlite'),
      publishedPath: join(directory, 'fresh.sqlite'), directoryMetadataSource: source, metadataBatchSize: 256
    })
    expect(resumed.totals).toMatchObject({ scannedItems: fresh.totals.scannedItems, discoveredBytes: fresh.totals.discoveredBytes, skippedItems: fresh.totals.skippedItems })
    expect(normalizeCandidateSemantics(readCandidateSemantics(resumed.publishedPath)))
      .toEqual(normalizeCandidateSemantics(readCandidateSemantics(fresh.publishedPath)))
  })

  it('checkpoints unflushed metadata batches across an interrupted scan of many files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-resume-batch-large-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(target, { recursive: true })
    await mkdir(indexes, { recursive: true })
    const targetStats = await lstat(target)
    const indexStats = await lstat(indexes)
    const store = new FullScanResumeStore(indexes)
    const descriptor = store.descriptor({
      scanId, target, targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
      indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
      checkpoint: { device: String(targetStats.dev), journalUuid: 'test-journal', eventId: '10' }
    })
    const partialPath = join(indexes, descriptor.partialFile)
    const candidatePath = join(indexes, descriptor.candidateFile)
    const abort = new AbortController()
    let interrupt = true
    // The abort lands mid-page with thousands of files still unflushed in
    // the metadata accumulator; the failure-path checkpoint must commit them
    // so the resume re-reads only the aborted page's tail.
    const source = metadataSource(5_000, (index) => {
      if (interrupt && index === 4_200) abort.abort()
    })
    const interrupted = scanFilesystem({
      generation: 3, target, indexDirectory: indexes, partialPath, publishedPath: candidatePath,
      signal: abort.signal, control: new ProgressiveScanControl(), directoryMetadataSource: source, metadataBatchSize: 256,
      resumable: { descriptor, store, resume: false }, onCheckpoint: () => undefined, onPreview: () => undefined
    })
    await expect(interrupted).rejects.toBeInstanceOf(ScanCanceledError)
    interrupt = false
    const resumed = await scanFilesystem({
      generation: 4, target, indexDirectory: indexes, partialPath, publishedPath: candidatePath,
      directoryMetadataSource: source, metadataBatchSize: 256, resumable: { descriptor, store, resume: true }
    })
    const fresh = await scanFilesystem({
      generation: 5, target, indexDirectory: join(directory, 'fresh-indexes'), partialPath: join(directory, 'fresh.partial.sqlite'),
      publishedPath: join(directory, 'fresh.sqlite'), directoryMetadataSource: source, metadataBatchSize: 256
    })
    expect(resumed.totals).toMatchObject({ scannedItems: fresh.totals.scannedItems, discoveredBytes: fresh.totals.discoveredBytes, skippedItems: fresh.totals.skippedItems })
    expect(normalizeCandidateSemantics(readCandidateSemantics(resumed.publishedPath)))
      .toEqual(normalizeCandidateSemantics(readCandidateSemantics(fresh.publishedPath)))
  })

  it('preserves descriptor-owned SQLite files during orphan cleanup and discards only those files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-resume-cleanup-'))
    cleanup.push(directory)
    const indexes = join(directory, 'indexes')
    const target = join(directory, 'target')
    await mkdir(target)
    const manifests = new IndexManifestStore(indexes)
    await manifests.initialize()
    const targetStats = await lstat(target)
    const indexStats = await lstat(indexes)
    const store = new FullScanResumeStore(indexes)
    const descriptor = store.descriptor({
      scanId, target, targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
      indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
      checkpoint: { device: String(targetStats.dev), journalUuid: 'journal', eventId: '1' }
    })
    await writeFile(join(indexes, descriptor.partialFile), 'partial')
    await writeFile(`${join(indexes, descriptor.partialFile)}-journal`, 'journal')
    await writeFile(join(indexes, descriptor.candidateFile), 'candidate')
    await store.publish(descriptor)

    await manifests.cleanup()
    await expect(access(join(indexes, descriptor.partialFile))).resolves.toBeUndefined()
    await expect(access(`${join(indexes, descriptor.partialFile)}-journal`)).resolves.toBeUndefined()
    await expect(access(join(indexes, descriptor.candidateFile))).resolves.toBeUndefined()
    await store.discard(scanId)
    await expect(access(join(indexes, descriptor.partialFile))).rejects.toThrow()
    await expect(access(join(indexes, descriptor.candidateFile))).rejects.toThrow()
    await expect(access(store.descriptorPath)).rejects.toThrow()

    await writeFile(join(indexes, descriptor.candidateFile), 'authoritative')
    await store.publish(descriptor)
    await writeFile(join(indexes, 'current.json'), `${JSON.stringify({ publicationId: scanId, indexFile: descriptor.candidateFile })}\n`)
    await store.discard(scanId)
    await expect(access(join(indexes, descriptor.candidateFile))).resolves.toBeUndefined()
    await expect(access(store.descriptorPath)).rejects.toThrow()
  })
})

function metadataSource(count: number, onEntry: (index: number) => void): DirectoryMetadataSource {
  return {
    open: async () => {
      let offset = 0
      return {
        readPage: async (limit) => {
          const start = offset
          const end = Math.min(count, start + limit)
          offset = end
          const entries = Array.from({ length: end - start }, (_, local): DirectoryMetadataEntry => {
            const index = start + local
            const entry = { name: `file-${String(index).padStart(3, '0')}`, device: '', inode: String(index), allocatedBytes: index + 1, mountPoint: false } as Omit<DirectoryMetadataEntry, 'kind'> & { kind: DirectoryMetadataEntry['kind'] }
            Object.defineProperty(entry, 'kind', { enumerable: true, get: () => { onEntry(index); return 'file' as const } })
            return entry
          })
          return { entries, done: end === count, bulkEntries: entries.length, fallbackEntries: 0 }
        },
        close: async () => undefined
      }
    }
  }
}
