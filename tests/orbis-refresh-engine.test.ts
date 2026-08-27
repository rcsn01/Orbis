import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FSEVENT_FLAGS, type ChangeJournal } from '../src/main/change-journal'
import type { IndexManifest } from '../src/main/index-manifest'
import { createResumeJournalDrain, refreshPersistentIndex, type RefreshRequest } from '../src/main/refresh-engine'
import { scanFilesystem } from '../src/main/scanner'
import { FullScanResumeStore, type FullScanResumeDescriptor } from '../src/main/full-scan-resume'
import { subscribeScanDiagnostics, type OrbisTimingEvent } from '../src/main/diagnostics'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('Orbis refresh engine', () => {
  it('keeps a finalized full candidate resumable until manifest publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-resume-candidate-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(target, { recursive: true })
    await mkdir(indexes, { recursive: true })
    await writeFile(join(target, 'file'), Buffer.alloc(1024))
    const stats = await import('node:fs/promises').then(({ lstat }) => lstat(target))
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(stats.dev), journalUuid: 'resume-journal', eventId: '40' }),
      readChanges: () => ({ throughEventId: '40', events: [], requiresFullScan: false })
    }
    const id = '41234567-89ab-4cde-8fab-0123456789ab'
    const outcome = await refreshPersistentIndex({
      generation: 1, target, indexDirectory: indexes, partialPath: join(indexes, `index-${id}.partial.sqlite`),
      publishedPath: join(indexes, `index-${id}.sqlite`), changeJournal: journal
    })
    expect(outcome).toMatchObject({ kind: 'candidate', strategy: 'full', journal: { uuid: 'resume-journal', eventId: '40' } })
    const store = new FullScanResumeStore(indexes)
    const loaded = await store.load(target)
    expect(loaded).toMatchObject({ kind: 'candidate', descriptor: { scanId: id } })
    if (loaded.kind !== 'candidate') throw new Error('Expected a candidate receipt')
    const reused = await store.load(target, loaded.receipt)
    expect(reused).toMatchObject({ kind: 'candidate', descriptor: { scanId: id } })
  })

  it('replays again after reconciliation before proposing the publication cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-closing-fence-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(join(target, 'folder'), { recursive: true })
    await mkdir(indexes, { recursive: true })
    const file = join(target, 'folder', 'file')
    await writeFile(file, Buffer.alloc(512))
    const stats = await import('node:fs/promises').then(({ lstat }) => lstat(target))
    let reads = 0
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(stats.dev), journalUuid: 'closing-journal', eventId: '10' }),
      readChanges: () => {
        reads += 1
        if (reads === 1) {
          writeFileSync(file, Buffer.alloc(2048))
          return { throughEventId: '11', requiresFullScan: false, events: [{ relativePath: 'folder/file', eventId: '11', flags: FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile }] }
        }
        if (reads === 2) {
          writeFileSync(file, Buffer.alloc(8192))
          return { throughEventId: '12', requiresFullScan: false, events: [{ relativePath: 'folder/file', eventId: '12', flags: FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile }] }
        }
        return { throughEventId: '12', requiresFullScan: false, events: [] }
      }
    }
    const id = '51234567-89ab-4cde-8fab-0123456789ab'
    const outcome = await refreshPersistentIndex({
      generation: 1, target, indexDirectory: indexes, partialPath: join(indexes, `index-${id}.partial.sqlite`),
      publishedPath: join(indexes, `index-${id}.sqlite`), changeJournal: journal
    })
    expect(outcome).toMatchObject({ kind: 'candidate', journal: { eventId: '12' } })
    expect(reads).toBe(3)
  })

  it('publishes a full baseline and then an exact incremental candidate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(join(target, 'a', 'nested'), { recursive: true })
    await mkdir(join(target, 'clean'), { recursive: true })
    await writeFile(join(target, 'a', 'nested', 'file'), Buffer.alloc(512, 1))
    await writeFile(join(target, 'clean', 'stable'), Buffer.alloc(4096, 2))

    const targetStats = await import('node:fs/promises').then(({ lstat }) => lstat(target))
    let phase: 'baseline' | 'incremental' = 'baseline'
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(targetStats.dev), journalUuid: 'volume-journal', eventId: '10' }),
      readChanges: () => phase === 'baseline'
        ? { throughEventId: '10', events: [], requiresFullScan: false }
        : { throughEventId: '12', requiresFullScan: false, events: [
          { relativePath: 'a/nested/file', eventId: '11', flags: FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile },
          { relativePath: 'a/added', eventId: '12', flags: FSEVENT_FLAGS.itemCreated | FSEVENT_FLAGS.itemIsFile }
        ] }
    }
    const baseline = await refreshPersistentIndex({
      generation: 1, target, indexDirectory: indexes, partialPath: join(indexes, 'baseline.partial.sqlite'),
      publishedPath: join(indexes, 'baseline.sqlite'), changeJournal: journal
    })
    expect(baseline).toMatchObject({ kind: 'candidate', strategy: 'full', journal: { uuid: 'volume-journal', eventId: '10' } })
    if (baseline.kind !== 'candidate') throw new Error('Expected a baseline candidate')
    phase = 'incremental'
    await writeFile(join(target, 'a', 'nested', 'file'), Buffer.alloc(16_384, 3))
    await writeFile(join(target, 'a', 'added'), Buffer.alloc(2048, 4))
    const manifest = manifestFor(baseline.result.publishedPath, baseline.journal)
    const updated = await refreshPersistentIndex({
      generation: 2, target, indexDirectory: indexes, partialPath: join(indexes, 'updated.partial.sqlite'),
      publishedPath: join(indexes, 'updated.sqlite'), changeJournal: journal,
      active: { manifest, path: baseline.result.publishedPath }
    })
    expect(updated).toMatchObject({ kind: 'candidate', strategy: 'incremental', journal: { uuid: 'volume-journal', eventId: '12' } })
    if (updated.kind !== 'candidate') throw new Error('Expected an incremental candidate')
    const fresh = await scanFilesystem({
      generation: 3, target, indexDirectory: indexes, partialPath: join(indexes, 'fresh.partial.sqlite'), publishedPath: join(indexes, 'fresh.sqlite')
    })
    expect(rows(updated.result.publishedPath)).toEqual(rows(fresh.publishedPath))
  })

  it('matches a fresh scan after an identity-paired cross-parent directory move', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-rename-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    const oldTree = join(target, 'left', 'tree')
    const newTree = join(target, 'right', 'tree')
    await mkdir(join(oldTree, 'nested'), { recursive: true })
    await mkdir(join(target, 'right'), { recursive: true })
    await writeFile(join(oldTree, 'nested', 'file'), Buffer.alloc(4096, 1))
    const baseline = await scanFilesystem({ generation: 1, target, indexDirectory: indexes, partialPath: join(indexes, 'rename-base.partial.sqlite'), publishedPath: join(indexes, 'rename-base.sqlite') })
    await rename(oldTree, newTree)
    await symlink(join(target, 'right'), join(target, 'left', 'ignored-link'))
    const manifest = manifestFor(baseline.publishedPath, { uuid: 'journal', eventId: '20' })
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: manifest.targetDevice, journalUuid: 'journal', eventId: '20' }),
      readChanges: () => ({
        throughEventId: '24', requiresFullScan: false,
        events: [
          { relativePath: 'left/tree', eventId: '21', flags: FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsDir },
          { relativePath: 'right/tree', eventId: '22', flags: FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsDir },
          { relativePath: 'left/ignored-link', eventId: '24', flags: FSEVENT_FLAGS.itemCreated | FSEVENT_FLAGS.itemIsFile }
        ]
      })
    }
    const updated = await refreshPersistentIndex({
      generation: 2, target, indexDirectory: indexes, partialPath: join(indexes, 'rename-updated.partial.sqlite'),
      publishedPath: join(indexes, 'rename-updated.sqlite'), active: { manifest, path: baseline.publishedPath }, changeJournal: journal
    })
    expect(updated).toMatchObject({ kind: 'candidate', strategy: 'incremental' })
    if (updated.kind !== 'candidate') throw new Error('Expected an incremental rename candidate')
    const fresh = await scanFilesystem({ generation: 3, target, indexDirectory: indexes, partialPath: join(indexes, 'rename-fresh.partial.sqlite'), publishedPath: join(indexes, 'rename-fresh.sqlite') })
    expect(rows(updated.result.publishedPath)).toEqual(rows(fresh.publishedPath))
    const database = new DatabaseSync(updated.result.publishedPath, { readOnly: true })
    try { expect(database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE path LIKE '%ignored-link%'").get()).toEqual({ count: 0 }) }
    finally { database.close() }
  })

  it('retries a full scan when its post-scan history fence is untrustworthy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-full-retry-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'file'), 'value')
    const stats = await import('node:fs/promises').then(({ lstat }) => lstat(target))
    let captures = 0
    let reads = 0
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(stats.dev), journalUuid: 'journal', eventId: String(++captures * 10) }),
      readChanges: (_target, cursor) => ++reads === 1
        ? { throughEventId: cursor.eventId, events: [], requiresFullScan: true, reason: 'kernel-dropped' }
        : { throughEventId: String(Number(cursor.eventId) + 1), events: [], requiresFullScan: false }
    }
    const outcome = await refreshPersistentIndex({
      generation: 1, target, indexDirectory: indexes, partialPath: join(indexes, 'retry.partial.sqlite'),
      publishedPath: join(indexes, 'retry.sqlite'), changeJournal: journal
    })
    expect(outcome).toMatchObject({ kind: 'candidate', strategy: 'full', journal: { uuid: 'journal', eventId: '21' }, fallbackReason: 'kernel-dropped' })
    expect(captures).toBe(2)
    expect(reads).toBe(2)
  })

  it('removes an unfenced full candidate after the bounded retry is exhausted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-full-retry-fail-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    const publishedPath = join(indexes, 'failed.sqlite')
    await mkdir(target, { recursive: true })
    const stats = await import('node:fs/promises').then(({ lstat }) => lstat(target))
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(stats.dev), journalUuid: 'journal', eventId: '10' }),
      readChanges: (_target, cursor) => ({ throughEventId: cursor.eventId, events: [], requiresFullScan: true, reason: 'kernel-dropped' })
    }
    await expect(refreshPersistentIndex({
      generation: 1, target, indexDirectory: indexes, partialPath: join(indexes, 'failed.partial.sqlite'),
      publishedPath, changeJournal: journal
    })).rejects.toThrow('Unable to close the full-scan FSEvents window')
    await expect(access(publishedPath)).rejects.toThrow()
  })

  it('discards retry candidates when the post-scan window cannot close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-window-busy-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) await mkdir(join(target, name), { recursive: true })
    await mkdir(indexes, { recursive: true })
    const stats = await import('node:fs/promises').then(({ lstat }) => lstat(target))
    // Every post-scan window reports more dirty scopes than the incremental
    // bound, so the full-scan retry exhausts while a valid checkpoint exists.
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(stats.dev), journalUuid: 'busy-journal', eventId: '10' }),
      readChanges: () => ({
        throughEventId: '20', requiresFullScan: false,
        events: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((name, index) => ({
          relativePath: `${name}/file`, eventId: String(index + 11), flags: FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile
        }))
      })
    }
    const id = '81234567-89ab-4cde-8fab-0123456789ab'
    await expect(refreshPersistentIndex({
      generation: 1, target, indexDirectory: indexes, partialPath: join(indexes, `index-${id}.partial.sqlite`),
      publishedPath: join(indexes, `index-${id}.sqlite`), changeJournal: journal
    })).rejects.toThrow('Unable to close the full-scan FSEvents window: too-many-dirty-scopes')
    const saved = await new FullScanResumeStore(indexes).load(target)
    expect(saved.kind).toBe('none')
    await expect(access(join(indexes, `index-${id}.sqlite`))).rejects.toThrow()
  })

  it('publishes a full scan despite an odd rename count in the final drain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-churn-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(join(target, 'a'), { recursive: true })
    await mkdir(join(target, 'b'), { recursive: true })
    await mkdir(join(target, 'c'), { recursive: true })
    await mkdir(indexes, { recursive: true })
    await writeFile(join(target, 'a', 'one'), Buffer.alloc(512, 1))
    await writeFile(join(target, 'b', 'two'), Buffer.alloc(512, 2))
    await writeFile(join(target, 'c', 'three'), Buffer.alloc(512, 3))
    const stats = await import('node:fs/promises').then(({ lstat }) => lstat(target))
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(stats.dev), journalUuid: 'churn-journal', eventId: '10' }),
      readChanges: () => ({
        throughEventId: '11', requiresFullScan: false,
        events: [
          { relativePath: 'a/one', eventId: '11', flags: FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsFile },
          { relativePath: 'b/two', eventId: '11', flags: FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsFile },
          { relativePath: 'c/three', eventId: '11', flags: FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsFile }
        ]
      })
    }
    const id = '61234567-89ab-4cde-8fab-0123456789ab'
    const outcome = await refreshPersistentIndex({
      generation: 1, target, indexDirectory: indexes, partialPath: join(indexes, `index-${id}.partial.sqlite`),
      publishedPath: join(indexes, `index-${id}.sqlite`), changeJournal: journal
    })
    expect(outcome).toMatchObject({ kind: 'candidate', strategy: 'full' })
    if (outcome.kind !== 'candidate') throw new Error('Expected a full candidate')
    const fresh = await scanFilesystem({
      generation: 2, target, indexDirectory: indexes, partialPath: join(indexes, 'churn-fresh.partial.sqlite'),
      publishedPath: join(indexes, 'churn-fresh.sqlite')
    })
    expect(rows(outcome.result.publishedPath)).toEqual(rows(fresh.publishedPath))
  })

  it('bounds resume-invalidated restarts and then fails via the reconciliation retry cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-resume-bounded-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(target, { recursive: true })
    await mkdir(indexes, { recursive: true })
    await writeFile(join(target, 'file'), 'value')
    const stats = await import('node:fs/promises').then(({ lstat }) => lstat(target))
    let reads = 0
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(stats.dev), journalUuid: 'journal', eventId: '10' }),
      readChanges: (_target, cursor) => {
        reads += 1
        return { throughEventId: cursor.eventId, events: [], requiresFullScan: true, reason: 'kernel-dropped' }
      }
    }
    const id = '71234567-89ab-4cde-8fab-0123456789ab'
    await expect(refreshPersistentIndex({
      generation: 1, target, indexDirectory: indexes, partialPath: join(indexes, `index-${id}.partial.sqlite`),
      publishedPath: join(indexes, `index-${id}.sqlite`), changeJournal: journal
    })).rejects.toThrow('Unable to close the full-scan FSEvents window: kernel-dropped')
    expect(reads).toBe(4)
  })

  it('advances only the manifest cursor when no target events exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-empty-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(target, { recursive: true })
    const baseline = await scanFilesystem({ generation: 1, target, indexDirectory: indexes, partialPath: join(indexes, 'base.partial.sqlite'), publishedPath: join(indexes, 'base.sqlite') })
    const manifest = manifestFor(baseline.publishedPath, { uuid: 'journal', eventId: '4' })
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: manifest.targetDevice, journalUuid: 'journal', eventId: '5' }),
      readChanges: () => ({ throughEventId: '9', events: [], requiresFullScan: false })
    }
    const outcome = await refreshPersistentIndex({
      generation: 2, target, indexDirectory: indexes, partialPath: join(indexes, 'unused.partial.sqlite'),
      publishedPath: join(indexes, 'unused.sqlite'), active: { manifest, path: baseline.publishedPath }, changeJournal: journal
    })
    expect(outcome).toEqual({ kind: 'unchanged', strategy: 'incremental', journal: { uuid: 'journal', eventId: '9' }, totals: baseline.totals, basePublicationId: manifest.publicationId })
  })

  it('resumes a canceled scan from its drain watermark when the scan-start baseline is no longer verifiable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-resume-watermark-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(join(target, 'folder'), { recursive: true })
    await mkdir(indexes, { recursive: true })
    for (let index = 0; index < 50; index += 1) await writeFile(join(target, 'folder', `f${index}`), Buffer.alloc(1024))
    const stats = await lstat(target)
    const id = '91234567-89ab-4cde-8fab-0123456789ab'
    const partialPath = join(indexes, `index-${id}.partial.sqlite`)
    const publishedPath = join(indexes, `index-${id}.sqlite`)

    // Run 1: cancel as soon as the scan reports progress. The failure path
    // performs a final drain that advances the persisted watermark to 11.
    const abort = new AbortController()
    const journal1: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(stats.dev), journalUuid: 'w-journal', eventId: '10' }),
      readChanges: () => ({ throughEventId: '11', requiresFullScan: false, events: [
        { relativePath: 'folder/f0', eventId: '11', flags: FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile }
      ] })
    }
    await refreshPersistentIndex({
      generation: 1, target, indexDirectory: indexes, partialPath, publishedPath,
      changeJournal: journal1, signal: abort.signal,
      onProgress: () => abort.abort()
    }).catch(() => undefined)
    const saved = await new FullScanResumeStore(indexes).load(target)
    expect(saved.kind).toBe('construction')
    if (saved.kind !== 'construction') throw new Error('Expected a construction resume state')
    expect(saved.drainedThrough).toBe('11')
    const partialInode = (await lstat(partialPath)).ino

    // Run 2: the scan-start baseline is no longer verifiable (event-limit),
    // but the window since the last drain is. The saved scan must be reused.
    const preparation: string[] = []
    const journal2: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(stats.dev), journalUuid: 'w-journal', eventId: '10' }),
      readChanges: (_target, cursor) => {
        if (cursor.eventId === '11') preparation.push('journal-read')
        return cursor.eventId === '10'
        ? { throughEventId: '10', events: [], requiresFullScan: true, reason: 'event-limit' }
        : { throughEventId: '11', events: [], requiresFullScan: false }
      }
    }
    const resumeEvents: OrbisTimingEvent[] = []
    const unsubscribe = subscribeScanDiagnostics((event) => { if (event.generation === 2) resumeEvents.push(event) })
    let outcome: Awaited<ReturnType<typeof refreshPersistentIndex>>
    try {
      outcome = await refreshPersistentIndex({
        generation: 2, target, indexDirectory: indexes, partialPath, publishedPath, changeJournal: journal2,
        resumeExpected: true, onResumePreparation: (phase) => { preparation.push(phase) }
      })
    } finally { unsubscribe() }
    expect(outcome).toMatchObject({ kind: 'candidate', strategy: 'full', journal: { uuid: 'w-journal', eventId: '11' } })
    expect(preparation.slice(0, 6)).toEqual(['validating', 'history', 'journal-read', 'recovering', 'repairing', 'starting'])
    for (const phase of ['resume-load-total', 'resume-history-validation', 'resume-database-open', 'resume-incomplete-recovery', 'resume-semantic-totals', 'resume-checkpoint', 'resume-first-metadata-page']) {
      expect(resumeEvents.filter((event) => event.phase === phase), phase).toHaveLength(1)
    }
    // The resumed scan continued the same partial (renamed on publication)
    // instead of discarding it and re-scanning from an empty database.
    expect((await lstat(publishedPath)).ino).toBe(partialInode)
  })

  it('reuses a finalized candidate from its drain watermark when the scan-start baseline is no longer verifiable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-refresh-candidate-watermark-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(join(target, 'folder'), { recursive: true })
    await mkdir(indexes, { recursive: true })
    await writeFile(join(target, 'folder', 'file'), Buffer.alloc(1024))
    const stats = await lstat(target)
    const id = 'a1234567-89ab-4cde-8fab-0123456789ab'
    const partialPath = join(indexes, `index-${id}.partial.sqlite`)
    const publishedPath = join(indexes, `index-${id}.sqlite`)

    // Run 1: a full scan whose final drain advances the watermark to 41 with
    // a dirty scope inside the target; the candidate stays resumable.
    const journal1: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(stats.dev), journalUuid: 'cand-journal', eventId: '40' }),
      readChanges: (_target, cursor) => cursor.eventId === '40'
        ? { throughEventId: '41', requiresFullScan: false, events: [
          { relativePath: 'folder/file', eventId: '41', flags: FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile }
        ] }
        : { throughEventId: '41', events: [], requiresFullScan: false }
    }
    const first = await refreshPersistentIndex({
      generation: 1, target, indexDirectory: indexes, partialPath, publishedPath, changeJournal: journal1
    })
    expect(first).toMatchObject({ kind: 'candidate', strategy: 'full', journal: { uuid: 'cand-journal', eventId: '41' } })
    const saved = await new FullScanResumeStore(indexes).load(target)
    expect(saved.kind).toBe('candidate')
    if (saved.kind !== 'candidate') throw new Error('Expected a candidate resume state')
    expect(saved.drainedThrough).toBe('41')
    const candidateInode = (await lstat(publishedPath)).ino

    // Run 2: the scan-start baseline is no longer verifiable (kernel-dropped),
    // but the window since the candidate's drain watermark is. The candidate
    // must be reused without re-scanning.
    const journal2: ChangeJournal = {
      captureCheckpoint: () => ({ device: String(stats.dev), journalUuid: 'cand-journal', eventId: '40' }),
      readChanges: (_target, cursor) => cursor.eventId === '40'
        ? { throughEventId: '40', events: [], requiresFullScan: true, reason: 'kernel-dropped' }
        : { throughEventId: '41', events: [], requiresFullScan: false }
    }
    const outcome = await refreshPersistentIndex({
      generation: 2, target, indexDirectory: indexes, partialPath, publishedPath, changeJournal: journal2
    })
    expect(outcome).toMatchObject({ kind: 'candidate', strategy: 'full', journal: { uuid: 'cand-journal', eventId: '41' } })
    expect((await lstat(publishedPath)).ino).toBe(candidateInode)
  })
})

describe('Orbis resume journal drain', () => {
  it('advances through an odd rename count without restarting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-drain-rename-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: '1', journalUuid: 'journal', eventId: '0' }),
      readChanges: () => ({
        throughEventId: '30', requiresFullScan: false,
        events: [
          { relativePath: 'a/one', eventId: '10', flags: FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsFile },
          { relativePath: 'b/two', eventId: '20', flags: FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsFile },
          { relativePath: 'c/three', eventId: '30', flags: FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsFile }
        ]
      })
    }
    const drain = createResumeJournalDrain({ target, indexDirectory: indexes } as RefreshRequest, journal, { journalUuid: 'journal' } as FullScanResumeDescriptor)
    const result = drain('5')
    expect(result.restartReason).toBeUndefined()
    expect(result.throughEventId).toBe('30')
    expect(result.scopes).toEqual([join(target, 'a'), join(target, 'b'), join(target, 'c')])
  })

  it('scopes a renamed directory through its parent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-drain-rename-dir-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: '1', journalUuid: 'journal', eventId: '0' }),
      readChanges: () => ({
        throughEventId: '20', requiresFullScan: false,
        events: [{ relativePath: 'a/dir', eventId: '20', flags: FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsDir }]
      })
    }
    const drain = createResumeJournalDrain({ target, indexDirectory: indexes } as RefreshRequest, journal, { journalUuid: 'journal' } as FullScanResumeDescriptor)
    const result = drain('5')
    expect(result.restartReason).toBeUndefined()
    expect(result.throughEventId).toBe('20')
    expect(result.scopes).toEqual([join(target, 'a')])
  })

  it('propagates a requiresFullScan batch as a restart reason', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-drain-full-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: '1', journalUuid: 'journal', eventId: '0' }),
      readChanges: () => ({ throughEventId: '99', events: [], requiresFullScan: true, reason: 'event-limit' })
    }
    const drain = createResumeJournalDrain({ target, indexDirectory: indexes } as RefreshRequest, journal, { journalUuid: 'journal' } as FullScanResumeDescriptor)
    expect(drain('50')).toEqual({ throughEventId: '50', scopes: [], restartReason: 'event-limit' })
  })

  it('restarts when the target root itself is dirty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-drain-root-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: '1', journalUuid: 'journal', eventId: '0' }),
      readChanges: () => ({
        throughEventId: '20', requiresFullScan: false,
        events: [{ relativePath: '', eventId: '20', flags: FSEVENT_FLAGS.itemIsDir }]
      })
    }
    const drain = createResumeJournalDrain({ target, indexDirectory: indexes } as RefreshRequest, journal, { journalUuid: 'journal' } as FullScanResumeDescriptor)
    expect(drain('5')).toEqual({ throughEventId: '5', scopes: [], restartReason: 'target-root-dirty' })
  })

  it('restarts when a drain window exceeds the coalesced scope bound', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-drain-scopes-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    const events = Array.from({ length: 1025 }, (_, index) => ({
      relativePath: `d${String(index).padStart(4, '0')}/file`, eventId: String(index + 1),
      flags: FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile
    }))
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: '1', journalUuid: 'journal', eventId: '0' }),
      readChanges: () => ({ throughEventId: '2000', requiresFullScan: false, events })
    }
    const drain = createResumeJournalDrain({ target, indexDirectory: indexes } as RefreshRequest, journal, { journalUuid: 'journal' } as FullScanResumeDescriptor)
    expect(drain('5')).toEqual({ throughEventId: '5', scopes: [], restartReason: 'too-many-dirty-scopes' })
  })

  it('ignores events inside the index directory and startup exclusions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-drain-excluded-'))
    cleanup.push(directory)
    const indexes = join(directory, 'indexes')
    await mkdir(indexes, { recursive: true })
    const journal: ChangeJournal = {
      captureCheckpoint: () => ({ device: '1', journalUuid: 'journal', eventId: '0' }),
      readChanges: () => ({
        throughEventId: '20', requiresFullScan: false,
        events: [
          { relativePath: relative('/', join(indexes, 'candidate.sqlite')), eventId: '10', flags: FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile },
          { relativePath: 'System/Volumes/disk/file', eventId: '20', flags: FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile }
        ]
      })
    }
    const drain = createResumeJournalDrain({ target: '/', indexDirectory: indexes, startupRoot: true } as RefreshRequest, journal, { journalUuid: 'journal' } as FullScanResumeDescriptor)
    expect(drain('5')).toEqual({ throughEventId: '20', scopes: [] })
  })
})

function manifestFor(path: string, journal: IndexManifest['journal']): IndexManifest {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const values = Object.fromEntries((database.prepare('SELECT key, value FROM metadata').all() as unknown as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]))
    return {
      version: 1, publicationId: '00000000-0000-4000-8000-000000000001', indexFile: 'index-00000000-0000-4000-8000-000000000001.sqlite',
      target: values.target!, targetDevice: values.targetDevice!, targetInode: values.targetInode!, schemaVersion: 3,
      indexRevision: Number(values.indexRevision), journal
    }
  } finally { database.close() }
}

function rows(path: string): unknown[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try { return database.prepare('SELECT path, kind, own_bytes, size_bytes, direct_children, descendant_count, unreadable_count FROM nodes ORDER BY path').all() }
  finally { database.close() }
}
