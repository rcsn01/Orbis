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
import type { DirectoryMetadataEntry, DirectoryMetadataSource } from '../src/main/scan-metadata'

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
    const first = scanFilesystem({
      generation: 1, target, indexDirectory: indexes, partialPath, publishedPath: candidatePath,
      signal: abort.signal, control: new ProgressiveScanControl(), resumable: { descriptor, store, resume: false }, onCheckpoint: (sequence) => sequences.push(sequence),
      onPreview: () => abort.abort()
    })
    await expect(first).rejects.toBeInstanceOf(ScanCanceledError)
    expect(sequences.length).toBeGreaterThan(1)
    const loaded = await store.load(target)
    expect(loaded).toMatchObject({ kind: 'construction', descriptor: { scanId } })
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
    const result = await scanFilesystem({
      generation: 2, target, indexDirectory: indexes, partialPath, publishedPath: candidatePath,
      resumable: { descriptor, store, resume: true }, onCheckpoint: (sequence) => resumedSequences.push(sequence)
    })
    expect(resumedSequences).toHaveLength(2)
    const candidate = new DatabaseSync(result.publishedPath, { readOnly: true })
    try {
      expect(candidate.prepare('SELECT id FROM nodes WHERE parent_id IS NULL').get()).toEqual({ id: expectedRootId })
      expect(candidate.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({ count: 81 })
      expect(() => candidate.prepare('SELECT * FROM scan_run').all()).toThrow()
    } finally { candidate.close() }
    expect(await store.load(target)).toMatchObject({ kind: 'candidate', descriptor: { scanId } })
    await rename(candidatePath, partialPath)
    expect(await store.load(target)).toMatchObject({ kind: 'candidate', candidatePath })
    await expect(access(candidatePath)).resolves.toBeUndefined()
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
    expect(comparableRows(resumed.publishedPath)).toEqual(comparableRows(fresh.publishedPath))
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
    expect(comparableRows(resumed.publishedPath)).toEqual(comparableRows(fresh.publishedPath))
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

function comparableRows(path: string): readonly Record<string, unknown>[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare(`SELECT name, path, kind, own_bytes AS ownBytes, size_bytes AS sizeBytes,
      direct_children AS directChildren, descendant_count AS descendantCount, scan_state AS scanState
      FROM nodes ORDER BY path`).all() as unknown as readonly Record<string, unknown>[]
  } finally { database.close() }
}
