import { DatabaseSync } from 'node:sqlite'
import { chmod, link, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultScanFileSystem, ProgressiveScanControl, ScanCanceledError, scanFilesystem, type ProgressivePreview, type ScanFileSystem, type ScanTotals } from '../src/main/scanner'
import { ConstructionDatabase } from '../src/main/construction-database'
import type { DirectoryMetadataEntry, DirectoryMetadataSource } from '../src/main/scan-metadata'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('progressive Orbis scanner', () => {
  it('publishes the root preview before scan progress so the scanning sunburst is available immediately', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-initial-preview-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'file.dat'), Buffer.alloc(512))
    const events: string[] = []
    const previews: ProgressivePreview[] = []

    await scanFilesystem({
      generation: 6, target: root, partialPath: join(indexes, 'partial.sqlite'), publishedPath: join(indexes, 'index.sqlite'), indexDirectory: indexes,
      onProgress: () => events.push('progress'),
      onPreview: (preview) => { events.push('preview'); previews.push(preview) }
    })

    expect(events[0]).toBe('preview')
    expect(previews[0]).toMatchObject({ focus: { name: 'root', scanState: 'queued' } })
    expect(previews.some((preview) => preview.largestItems.some((item) => item.name === 'file.dat'))).toBe(true)
  })

  it('publishes bounded previews and an exact terminal index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-progressive-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(join(root, 'alpha', 'nested'), { recursive: true })
    await mkdir(join(root, 'beta'), { recursive: true })
    for (let index = 0; index < 40; index += 1) await writeFile(join(root, `file-${String(index).padStart(2, '0')}.dat`), Buffer.alloc(512, index))
    await writeFile(join(root, 'alpha', 'nested', 'deep.dat'), Buffer.alloc(4096, 1))
    const previews: ProgressivePreview[] = []
    const control = new ProgressiveScanControl()
    let focused = false
    const partialPath = join(indexes, 'scan.partial.sqlite')
    const publishedPath = join(indexes, 'scan.sqlite')

    const result = await scanFilesystem({
      generation: 7, target: root, partialPath, publishedPath, indexDirectory: indexes,
      control, onPreview: (preview) => {
        previews.push(preview)
        const alpha = preview.largestItems.find((item) => item.name === 'alpha')
        if (!focused && alpha) { focused = true; control.focus(alpha.id) }
      }
    })

    expect(previews.length).toBeGreaterThan(0)
    expect(focused).toBe(true)
    expect(previews[0]).toMatchObject({ generation: 7, committed: false })
    expect(previews.every((preview) => preview.chart.length <= 400 && preview.largestItems.length <= 100)).toBe(true)
    expect(JSON.stringify(previews)).not.toContain(root)

    const database = new DatabaseSync(result.publishedPath, { readOnly: true })
    try {
      const pending = database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE scan_state IN ('queued', 'scanning')").get() as { count: number }
      const rootRow = database.prepare('SELECT size_bytes AS size, scan_state AS state FROM nodes WHERE parent_id IS NULL').get() as { size: number; state: string }
      const count = database.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }
      expect(pending.count).toBe(0)
      expect(rootRow.state).toBe('complete')
      expect(rootRow.size).toBe(result.scannedBytes)
      expect(count.count).toBe(result.totals.scannedItems)
      for (const table of ['directory_tasks', 'hardlink_owners', 'scan_state', 'size_estimates', 'estimate_roots']) expect(() => database.prepare(`SELECT * FROM ${table}`).all()).toThrow()
      for (const table of ['hardlink_paths', 'hardlink_groups', 'directory_observations']) expect(() => database.prepare(`SELECT * FROM ${table}`).all()).not.toThrow()
      const observationCount = database.prepare('SELECT COUNT(*) AS count FROM directory_observations').get() as { count: number }
      const directoryCount = database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE kind = 'directory'").get() as { count: number }
      const hardLinkGroupCount = database.prepare('SELECT COUNT(*) AS count FROM hardlink_groups').get() as { count: number }
      expect(observationCount.count).toBe(directoryCount.count)
      expect(hardLinkGroupCount.count).toBe(0)
      expect(database.prepare('SELECT COUNT(*) AS count FROM hardlink_paths').get()).toEqual({ count: 0 })
      expect(database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get()).toEqual({ value: '3' })
    } finally { database.close() }
  })

  it('persists direct directory observations without changing scan totals', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-observations-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(root, { recursive: true })
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const entries: DirectoryMetadataEntry[] = [
      metadataEntry('denied', 'file', { error: denied }),
      metadataEntry('missing', 'file', { error: missing }),
      metadataEntry('link', 'symlink'),
      metadataEntry('mounted', 'directory', { mountPoint: true }),
      metadataEntry('socket', 'other'),
      metadataEntry('outside', 'file', { device: '999' })
    ]
    const source: DirectoryMetadataSource = {
      open: async () => {
        let read = false
        return {
          readPage: async () => {
            if (read) return { entries: [], done: true, bulkEntries: 0, fallbackEntries: 0 }
            read = true
            return { entries, done: true, bulkEntries: entries.length, fallbackEntries: 0 }
          },
          close: async () => undefined
        }
      }
    }
    const result = await scanFilesystem({
      generation: 14, target: root, partialPath: join(indexes, 'partial.sqlite'), publishedPath: join(indexes, 'index.sqlite'),
      indexDirectory: indexes, directoryMetadataSource: source
    })
    expect(result.totals).toMatchObject({ skippedItems: 6, unreadableItems: 1, disappearingItems: 1, symlinks: 1, nestedMounts: 2 })
    const database = new DatabaseSync(result.publishedPath, { readOnly: true })
    try {
      expect(database.prepare(`SELECT direct_skipped_count AS skipped, direct_unreadable_count AS unreadable,
        direct_disappearing_count AS disappearing, direct_symlink_count AS symlinks,
        direct_nested_mount_count AS mounts, enumeration_status AS status FROM directory_observations`).get()).toEqual({
        skipped: 6, unreadable: 1, disappearing: 1, symlinks: 1, mounts: 2, status: 'complete'
      })
    } finally { database.close() }
  })

  it('pins an initial cached estimate in previews until exact completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-cached-estimate-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(join(root, 'Applications'), { recursive: true })
    for (let index = 0; index < 40; index += 1) await writeFile(join(root, 'Applications', `${index}.bin`), Buffer.alloc(4096))
    const cachedBytes = 64 * 1024
    const previews: ProgressivePreview[] = []

    const result = await scanFilesystem({
      generation: 13, target: root, partialPath: join(indexes, 'partial.sqlite'), publishedPath: join(indexes, 'index.sqlite'), indexDirectory: indexes,
      initialEstimate: { items: [{ name: 'Applications', estimatedBytes: cachedBytes }] },
      onPreview: (preview) => previews.push(preview)
    })

    const provisional = previews.flatMap((preview) => preview.largestItems).filter((item) => item.name === 'Applications' && item.scanState !== 'complete')
    const provisionalSegments = previews.flatMap((preview) => preview.chart).filter((item) => item.name === 'Applications' && item.scanState !== 'complete')
    expect(provisional.length).toBeGreaterThan(0)
    expect(provisionalSegments.length).toBeGreaterThan(0)
    expect(provisional.every((item) => item.estimatedSizeBytes === cachedBytes && item.sizeAccuracy === 'estimated')).toBe(true)
    expect(provisionalSegments.every((item) => item.sizeBytes === cachedBytes && item.estimatedSizeBytes === cachedBytes)).toBe(true)
    expect(result.scannedBytes).toBeGreaterThan(cachedBytes)
  })

  it('subtracts provisional child display sizes from an estimated remainder', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-estimate-remainder-'))
    cleanup.push(directory)
    const database = new ConstructionDatabase(join(directory, 'partial.sqlite'))
    try {
      database.insertRoot({ id: 'n-root', parentId: null, name: 'root', path: join(directory, 'root'), kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.applyEstimates({ items: [{ name: 'folder', estimatedBytes: 4096 }] })
      database.insertChild({ id: 'n-folder', parentId: 'n-root', name: 'folder', path: join(directory, 'root', 'folder'), kind: 'directory', ownBytes: 512, device: '1', inode: '2' }, 1, false)

      expect(database.getNode('n-folder')).toMatchObject({ sizeBytes: 4096, confirmedBytes: 512, estimatedBytes: 4096, sizeAccuracy: 'estimated' })
      expect(database.getEstimatedRemainder('n-root')).toBe(0)
    } finally { database.abort() }
  })

  it('rolls back JSON page writes and pending hard-link ownership when a batch fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-page-rollback-'))
    cleanup.push(directory)
    const database = new ConstructionDatabase(join(directory, 'construction.sqlite'))
    try {
      database.insertRoot({ id: 'root', parentId: null, name: 'root', path: directory, kind: 'directory', ownBytes: 0, device: '1', inode: '1' })
      database.applyMetadataBatch(() => {
        database.insertChild({ id: 'file', parentId: 'root', name: 'file', path: join(directory, 'file'), kind: 'file', ownBytes: 512, device: '1', inode: '2' }, 1, false)
        database.insertHardLinkPath('root', 'file', 'file', '1', '2', 512)
        database.insertHardLinkPath('root', 'file-copy', 'file', '1', '2', 512)
        database.setHardLinkOwner('1', '2', 'file', 'file')
      })
      // The duplicate path_key is only written when the deferred flush runs;
      // the failure propagates and the whole construction transaction rolls
      // back, leaving no rows at all.
      expect(() => database.semanticTotals()).toThrow()
      database.abort()
      const reopened = new DatabaseSync(join(directory, 'construction.sqlite'), { readOnly: true })
      try {
        expect(reopened.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({ count: 0 })
      } finally { reopened.close() }
    } finally { database.abort() }
  })

  it('rolls back the construction database when canceled after a preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-cancel-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(root, { recursive: true })
    for (let index = 0; index < 80; index += 1) await writeFile(join(root, `${index}.dat`), Buffer.alloc(128, index))
    const abort = new AbortController()
    const partialPath = join(indexes, 'partial.sqlite')
    const publishedPath = join(indexes, 'index.sqlite')
    const scan = scanFilesystem({
      generation: 2, target: root, partialPath, publishedPath, indexDirectory: indexes,
      signal: abort.signal, control: new ProgressiveScanControl(), onPreview: () => abort.abort()
    })
    await expect(scan).rejects.toBeInstanceOf(ScanCanceledError)
    await expect(import('node:fs/promises').then(({ stat }) => stat(partialPath))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(import('node:fs/promises').then(({ stat }) => stat(publishedPath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('chooses the lexical hard-link owner even when breadth-first discovery finds the alias first', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-hardlinks-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(join(root, 'a', 'nested'), { recursive: true })
    await mkdir(join(root, 'z'), { recursive: true })
    const canonical = join(root, 'a', 'nested', 'shared.dat')
    await writeFile(canonical, Buffer.alloc(2048, 4))
    await link(canonical, join(root, 'z', 'shared.dat'))
    const result = await scanFilesystem({
      generation: 1, target: root, partialPath: join(indexes, 'partial.sqlite'), publishedPath: join(indexes, 'index.sqlite'),
      indexDirectory: indexes, control: new ProgressiveScanControl()
    })
    const database = new DatabaseSync(result.publishedPath, { readOnly: true })
    try {
      const rows = database.prepare("SELECT path FROM nodes WHERE name = 'shared.dat'").all() as unknown as Array<{ path: string }>
      const aliases = database.prepare("SELECT path_key AS pathKey FROM hardlink_paths ORDER BY path_key").all() as unknown as Array<{ pathKey: string }>
      const groups = database.prepare("SELECT owner_path_key AS ownerPathKey, allocated_bytes AS allocatedBytes FROM hardlink_groups").all() as unknown as Array<{ ownerPathKey: string; allocatedBytes: number }>
      expect(rows.map((row) => row.path)).toEqual([canonical])
      expect(aliases.map((row) => row.pathKey)).toEqual(['a/nested/shared.dat', 'z/shared.dat'])
      expect(groups).toEqual([{ ownerPathKey: 'a/nested/shared.dat', allocatedBytes: expect.any(Number) }])
      expect(groups[0]!.allocatedBytes).toBeGreaterThan(0)
      expect(result.totals.duplicateHardLinks).toBe(1)
      expect(result.totals.skippedItems).toBe(1)
    } finally { database.close() }
  })

  it('replaces a hard-link owner discovered on an earlier metadata page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-hardlink-pages-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(root, { recursive: true })
    const lexicalOwner = join(root, 'a.dat')
    const firstAlias = join(root, 'z.dat')
    await writeFile(lexicalOwner, Buffer.alloc(2048, 3))
    await link(lexicalOwner, firstAlias)
    const stats = await lstat(lexicalOwner)
    const entries = ['z.dat', 'a.dat'].map((name) => metadataEntry(name, 'file', {
      device: String(stats.dev), inode: String(stats.ino), allocatedBytes: Number(stats.blocks) * 512
    }))
    const source: DirectoryMetadataSource = {
      open: async () => {
        let offset = 0
        return {
          readPage: async () => {
            const page = entries.slice(offset, offset + 1)
            offset += page.length
            return { entries: page, done: offset === entries.length, bulkEntries: page.length, fallbackEntries: 0 }
          },
          close: async () => undefined
        }
      }
    }
    const result = await scanFilesystem({
      generation: 1, target: root, partialPath: join(indexes, 'pages.partial.sqlite'),
      publishedPath: join(indexes, 'pages.sqlite'), indexDirectory: indexes,
      directoryMetadataSource: source, metadataBatchSize: 1
    })
    const database = new DatabaseSync(result.publishedPath, { readOnly: true })
    try {
      expect(database.prepare("SELECT path FROM nodes WHERE kind = 'file'").all()).toEqual([{ path: lexicalOwner }])
      expect(database.prepare('SELECT path_key AS pathKey FROM hardlink_paths ORDER BY path_key').all()).toEqual([{ pathKey: 'a.dat' }, { pathKey: 'z.dat' }])
      expect(database.prepare('SELECT owner_path_key AS ownerPathKey FROM hardlink_groups').all()).toEqual([{ ownerPathKey: 'a.dat' }])
    } finally { database.close() }
  })

  it('propagates exact totals up a deep chain as each level completes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-deep-chain-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    let current = root
    await mkdir(current, { recursive: true })
    for (let level = 0; level < 6; level += 1) {
      current = join(current, `d${level}`)
      await mkdir(current)
      await writeFile(join(current, `file-${level}.dat`), Buffer.alloc(1024 * (level + 1), level))
    }
    const result = await scanFilesystem({
      generation: 1, target: root, partialPath: join(indexes, 'deep.partial.sqlite'),
      publishedPath: join(indexes, 'deep.sqlite'), indexDirectory: indexes
    })
    const rows = readComparableRows(result.publishedPath) as unknown as ComparableRow[]
    // Every directory's size must equal its own bytes plus every descendant's
    // own bytes, and descendant counts must match the subtree sizes — the
    // post-order propagation must be exact at every level of the chain.
    for (const row of rows) {
      if (row.kind !== 'directory') continue
      const descendants = rows.filter((candidate) => candidate.path.startsWith(`${row.path}/`))
      expect(row.sizeBytes).toBe(row.ownBytes + descendants.reduce((sum, child) => sum + child.ownBytes, 0))
      expect(row.descendantCount).toBe(descendants.length)
      expect(row.scanState).toBe('complete')
    }
  })

  it('propagates a partially enumerated unreadable directory to its ancestors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-unreadable-partial-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    const sub = join(root, 'sub')
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'f1.dat'), Buffer.alloc(1024, 1))
    await writeFile(join(sub, 'f2.dat'), Buffer.alloc(2048, 2))
    await chmod(sub, 0o000)
    const source: DirectoryMetadataSource = {
      open: async (path) => {
        if (path === sub) {
          let calls = 0
          return {
            readPage: async () => {
              calls += 1
              if (calls === 1) return {
                entries: [metadataEntry('f1.dat', 'file', { allocatedBytes: 1024 }), metadataEntry('f2.dat', 'file', { allocatedBytes: 2048 })],
                done: false, bulkEntries: 2, fallbackEntries: 0
              }
              throw Object.assign(new Error('denied'), { code: 'EACCES' })
            },
            close: async () => undefined
          }
        }
        return {
          readPage: async () => ({ entries: [metadataEntry('sub', 'directory')], done: true, bulkEntries: 1, fallbackEntries: 0 }),
          close: async () => undefined
        }
      }
    }
    const result = await scanFilesystem({
      generation: 1, target: root, partialPath: join(indexes, 'unreadable.partial.sqlite'),
      publishedPath: join(indexes, 'unreadable.sqlite'), indexDirectory: indexes,
      directoryMetadataSource: source, metadataBatchSize: 1
    })
    // The root counts as one scanned item, plus the subdirectory and its two files.
    expect(result.totals).toMatchObject({ scannedItems: 4, unreadableItems: 1, skippedItems: 1, discoveredBytes: 3072 })
    await chmod(sub, 0o755)
    const rows = readComparableRows(result.publishedPath) as unknown as ComparableRow[]
    const byPath = new Map(rows.map((row) => [row.path, row]))
    const rootRow = byPath.get(root)!
    const subRow = byPath.get(sub)!
    expect(subRow.scanState).toBe('unreadable')
    expect(subRow.sizeBytes).toBe(3072)
    expect(subRow.descendantCount).toBe(2)
    expect(subRow.unreadableCount).toBe(1)
    expect(rootRow.scanState).toBe('complete')
    expect(rootRow.sizeBytes).toBe(rootRow.ownBytes + 3072)
    expect(rootRow.descendantCount).toBe(3)
    expect(rootRow.unreadableCount).toBe(1)
  })

  it('shrinks completed ancestors when a hard-link owner is replaced after its directory finished', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-hardlink-late-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    // The first owner lives in a lexically later directory so the replacement
    // discovered in the earlier directory wins the full-path comparison.
    const dirZ = join(root, 'z')
    const dirA = join(root, 'a')
    await mkdir(dirZ, { recursive: true })
    await mkdir(dirA, { recursive: true })
    const firstOwner = join(dirZ, 'z.dat')
    const betterOwner = join(dirA, 'a.dat')
    await writeFile(firstOwner, Buffer.alloc(2048, 3))
    await link(firstOwner, betterOwner)
    const stats = await lstat(firstOwner)
    const bytes = Number(stats.blocks) * 512
    const source: DirectoryMetadataSource = {
      open: async (path) => {
        const pages: DirectoryMetadataEntry[][] = path === root
          ? [[metadataEntry('z', 'directory'), metadataEntry('a', 'directory')]]
          : path === dirZ
            ? [[metadataEntry('z.dat', 'file', { device: String(stats.dev), inode: String(stats.ino), allocatedBytes: bytes })]]
            : [[metadataEntry('a.dat', 'file', { device: String(stats.dev), inode: String(stats.ino), allocatedBytes: bytes })]]
        let offset = 0
        return {
          readPage: async () => {
            const page = pages[offset] ?? []
            offset += 1
            return { entries: page, done: offset === pages.length, bulkEntries: page.length, fallbackEntries: 0 }
          },
          close: async () => undefined
        }
      }
    }
    const result = await scanFilesystem({
      generation: 1, target: root, partialPath: join(indexes, 'late.partial.sqlite'),
      publishedPath: join(indexes, 'late.sqlite'), indexDirectory: indexes,
      directoryMetadataSource: source, metadataBatchSize: 1
    })
    const rows = readComparableRows(result.publishedPath) as unknown as ComparableRow[]
    const byPath = new Map(rows.map((row) => [row.path, row]))
    const rootRow = byPath.get(root)!
    const zRow = byPath.get(dirZ)!
    const aRow = byPath.get(dirA)!
    expect(byPath.get(firstOwner)).toBeUndefined()
    expect(byPath.get(betterOwner)?.sizeBytes).toBe(bytes)
    // The owner's directory completed and propagated before the replacement,
    // so the removal must shrink the completed chain, not just the parent.
    expect(zRow.sizeBytes).toBe(zRow.ownBytes)
    expect(aRow.sizeBytes).toBe(aRow.ownBytes + bytes)
    expect(rootRow.sizeBytes).toBe(rootRow.ownBytes + zRow.ownBytes + aRow.ownBytes + bytes)
    expect(rootRow.descendantCount).toBe(3)
  })

  it('uses UTF-8 binary path ordering for non-BMP hard-link aliases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-hardlink-unicode-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(root, { recursive: true })
    const astral = join(root, '\u{10000}.dat')
    const privateUse = join(root, '\uE000.dat')
    await writeFile(astral, Buffer.alloc(2048, 1))
    await link(astral, privateUse)
    const expected = [astral, privateUse].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))[0]!
    const result = await scanFilesystem({
      generation: 1, target: root, partialPath: join(indexes, 'unicode.partial.sqlite'),
      publishedPath: join(indexes, 'unicode.sqlite'), indexDirectory: indexes
    })
    const database = new DatabaseSync(result.publishedPath, { readOnly: true })
    try { expect(database.prepare("SELECT path FROM nodes WHERE kind = 'file'").all()).toEqual([{ path: expected }]) }
    finally { database.close() }
  })

  it('reads 32 root entries before the first preview and uses the configured batch afterward', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-batch-policy-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(root, { recursive: true })
    const events: string[] = []
    const entries = Array.from({ length: 400 }, (_, index) => metadataEntry(`file-${index}`, 'file'))
    const source: DirectoryMetadataSource = {
      open: async () => {
        let offset = 0
        return {
          readPage: async (limit) => {
            events.push(`read:${limit}`)
            const page = entries.slice(offset, offset + limit)
            offset += page.length
            return { entries: page, done: offset === entries.length, bulkEntries: page.length, fallbackEntries: 0 }
          },
          close: async () => undefined
        }
      }
    }
    const result = await scanFilesystem({
      generation: 15, target: root, partialPath: join(indexes, 'partial.sqlite'), publishedPath: join(indexes, 'index.sqlite'),
      indexDirectory: indexes, directoryMetadataSource: source, metadataBatchSize: 256,
      onPreview: () => events.push('preview')
    })
    expect(events.slice(0, 4)).toEqual(['preview', 'read:32', 'preview', 'read:256'])
    expect(events.filter((event) => event.startsWith('read:'))).toEqual(['read:32', 'read:256', 'read:256'])
    expect(result.totals.scannedItems).toBe(401)
  })

  it('emits the first root-page preview before opening a descendant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-first-preview-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(join(root, 'child-a'), { recursive: true })
    await mkdir(join(root, 'child-b'), { recursive: true })
    for (let index = 0; index < 40; index += 1) await writeFile(join(root, `file-${String(index).padStart(2, '0')}.dat`), 'data')
    const real = defaultScanFileSystem()
    const opened: string[] = []
    const fileSystem = withDirectoryHandles(real, (path) => opened.push(path))
    const previews: ProgressivePreview[] = []
    await scanFilesystem({
      generation: 3, target: root, partialPath: join(indexes, 'partial.sqlite'), publishedPath: join(indexes, 'index.sqlite'), indexDirectory: indexes,
      fileSystem, onPreview: (preview) => { if (previews.length === 1) expect(opened).toEqual([root]); previews.push(preview) }
    })
    expect(previews.length).toBeGreaterThan(0)
    expect(opened.some((path) => path === join(root, 'child-a'))).toBe(true)
  })

  it('emits a preview for a root page made entirely of skipped entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-skipped-preview-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(root, { recursive: true })
    for (let index = 0; index < 40; index += 1) await writeFile(join(root, `protected-${index}.dat`), 'data')
    const real = defaultScanFileSystem()
    const fileSystem = withDirectoryHandles({
      ...real,
      lstat: async (path) => {
        if (path.startsWith(`${root}/`)) { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EACCES'; throw error }
        return real.lstat(path)
      }
    }, () => undefined)
    const previews: ProgressivePreview[] = []
    await scanFilesystem({
      generation: 8, target: root, partialPath: join(indexes, 'partial.sqlite'), publishedPath: join(indexes, 'index.sqlite'), indexDirectory: indexes,
      fileSystem, onPreview: (preview) => previews.push(preview)
    })
    expect(previews[0]?.focus).toMatchObject({ directChildren: 0, scanState: 'queued' })
    expect(previews.some((preview) => preview.focus.scanState === 'scanning')).toBe(true)
  })

  it('updates provisional sizes and revisions as later root pages finish', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-preview-revisions-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    await mkdir(root, { recursive: true })
    for (let index = 0; index < 64; index += 1) await writeFile(join(root, `file-${String(index).padStart(2, '0')}.dat`), Buffer.alloc(512))
    const real = defaultScanFileSystem()
    const fileSystem = withDirectoryHandles({
      ...real,
      lstat: async (path) => { await new Promise((resolveDelay) => setTimeout(resolveDelay, 16)); return real.lstat(path) }
    }, () => undefined)
    const previews: ProgressivePreview[] = []
    await scanFilesystem({
      generation: 9, target: root, partialPath: join(indexes, 'partial.sqlite'), publishedPath: join(indexes, 'index.sqlite'), indexDirectory: indexes,
      fileSystem, onPreview: (preview) => previews.push(preview)
    })
    expect(previews.length).toBeGreaterThanOrEqual(2)
    expect(previews[0]!.revision).toBeLessThan(previews.at(-1)!.revision)
    expect(previews[0]!.focus.sizeBytes).toBeLessThan(previews.at(-1)!.focus.sizeBytes)
  })

  it('keeps normal directory work breadth-first through shallow levels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-breadth-first-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    for (const branch of ['a', 'b']) {
      for (let level = 1; level <= 7; level += 1) await mkdir(join(root, branch, ...Array.from({ length: level - 1 }, () => 'next')), { recursive: true })
    }
    const real = defaultScanFileSystem()
    const opened: string[] = []
    await scanFilesystem({
      generation: 4, target: root, partialPath: join(indexes, 'partial.sqlite'), publishedPath: join(indexes, 'index.sqlite'), indexDirectory: indexes,
      fileSystem: withDirectoryHandles(real, (path) => opened.push(path))
    })
    const position = (path: string): number => opened.indexOf(path)
    const a = join(root, 'a')
    const b = join(root, 'b')
    const aDeep = join(a, 'next')
    const bDeep = join(b, 'next')
    expect(position(a)).toBeGreaterThan(-1)
    expect(position(b)).toBeGreaterThan(position(a))
    expect(position(aDeep)).toBeGreaterThan(position(b))
    expect(position(bDeep)).toBeGreaterThan(position(b))
    expect(position(join(aDeep, 'next'))).toBeGreaterThan(position(bDeep))
  })

  it('gives a focused subtree three turns without starving normal work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-focus-schedule-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    for (const name of ['focus', 'normal']) {
      for (let child = 0; child < 4; child += 1) await mkdir(join(root, name, `child-${child}`), { recursive: true })
    }
    const real = defaultScanFileSystem()
    const opened: string[] = []
    const control = new ProgressiveScanControl()
    let promoted = false
    await scanFilesystem({
      generation: 5, target: root, partialPath: join(indexes, 'partial.sqlite'), publishedPath: join(indexes, 'index.sqlite'), indexDirectory: indexes,
      control, fileSystem: withDirectoryHandles(real, (path) => opened.push(path)), onPreview: (preview) => {
        if (promoted) return
        const focus = preview.largestItems.find((item) => item.name === 'focus')
        if (focus) { promoted = control.focus(focus.id) }
      }
    })
    const focus = join(root, 'focus')
    const normal = join(root, 'normal')
    expect(promoted).toBe(true)
    expect(opened.indexOf(focus)).toBeGreaterThan(-1)
    expect(opened.indexOf(normal)).toBeGreaterThan(opened.indexOf(focus))
    expect(opened.indexOf(join(focus, 'child-3'))).toBeGreaterThan(opened.indexOf(normal))
  })

  it('bounds metadata operations and open directory handles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-progressive-bounds-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    for (let branch = 0; branch < 10; branch += 1) {
      const child = join(root, `branch-${branch}`)
      await mkdir(child, { recursive: true })
      for (let file = 0; file < 40; file += 1) await writeFile(join(child, `file-${file}.dat`), 'data')
    }
    const real = defaultScanFileSystem()
    let activeMetadata = 0
    let maximumMetadata = 0
    const opened: string[] = []
    const fileSystem = withDirectoryHandles({
      ...real,
      lstat: async (path) => {
        activeMetadata += 1
        maximumMetadata = Math.max(maximumMetadata, activeMetadata)
        try { await new Promise((resolveDelay) => setTimeout(resolveDelay, 1)); return await real.lstat(path) }
        finally { activeMetadata -= 1 }
      }
    }, (path) => opened.push(path))
    await scanFilesystem({
      generation: 6, target: root, partialPath: join(indexes, 'partial.sqlite'), publishedPath: join(indexes, 'index.sqlite'), indexDirectory: indexes,
      fileSystem
    })
    expect(maximumMetadata).toBeLessThanOrEqual(4)
    expect(opened.length).toBeGreaterThan(0)
    expect(fileSystem.maximumOpenHandles).toBeLessThanOrEqual(8)
  })

  it('keeps ORBIS_LEGACY_SCAN on the feature-rich progressive scanner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-equivalence-'))
    cleanup.push(directory)
    const root = join(directory, 'root')
    await mkdir(join(root, 'nested', 'deeper'), { recursive: true })
    await writeFile(join(root, 'root.txt'), Buffer.alloc(1024))
    await writeFile(join(root, 'nested', 'deeper', 'deep.txt'), Buffer.alloc(2048))
    const previousLegacy = process.env.ORBIS_LEGACY_SCAN
    try {
      process.env.ORBIS_LEGACY_SCAN = '1'
      let previews = 0
      const compatibility = await scanFilesystem({
        generation: 10, target: root, partialPath: join(directory, 'compatibility.partial.sqlite'),
        publishedPath: join(directory, 'compatibility.sqlite'), indexDirectory: join(directory, 'compatibility-indexes'),
        onPreview: () => { previews += 1 }
      })
      delete process.env.ORBIS_LEGACY_SCAN
      const progressive = await scanFilesystem({ generation: 11, target: root, partialPath: join(directory, 'progressive.partial.sqlite'), publishedPath: join(directory, 'progressive.sqlite'), indexDirectory: join(directory, 'progressive-indexes') })
      expect(previews).toBeGreaterThan(0)
      expect(normalizeTotals(compatibility.totals)).toEqual(normalizeTotals(progressive.totals))
      expect(compatibility.scannedBytes).toBe(progressive.scannedBytes)
      expect(readComparableRows(compatibility.publishedPath)).toEqual(readComparableRows(progressive.publishedPath))
    } finally {
      if (previousLegacy === undefined) delete process.env.ORBIS_LEGACY_SCAN
      else process.env.ORBIS_LEGACY_SCAN = previousLegacy
    }
  })
})

function metadataEntry(name: string, kind: DirectoryMetadataEntry['kind'], overrides: Partial<DirectoryMetadataEntry> = {}): DirectoryMetadataEntry {
  return { name, kind, allocatedBytes: 0, device: '', inode: name, mountPoint: false, ...overrides }
}

type TestDirectoryHandle = { read(): Promise<{ name: string } | null>; close(): Promise<void> }

type InstrumentedFileSystem = ScanFileSystem & { readonly opendir: (path: string) => Promise<TestDirectoryHandle>; maximumOpenHandles: number }

function withDirectoryHandles(fileSystem: ScanFileSystem, onOpen: (path: string) => void): InstrumentedFileSystem {
  let active = 0
  let maximumOpenHandles = 0
  const instrumented: InstrumentedFileSystem = {
    ...fileSystem,
    maximumOpenHandles: 0,
    opendir: async (path) => {
      onOpen(path)
      const names = [...await fileSystem.readdir(path)].sort()
      let index = 0
      let closed = false
      active += 1
      maximumOpenHandles = Math.max(maximumOpenHandles, active)
      instrumented.maximumOpenHandles = maximumOpenHandles
      return {
        read: async () => index < names.length ? { name: names[index++]! } : null,
        close: async () => { if (!closed) { closed = true; active -= 1 } }
      }
    }
  }
  return instrumented
}

function normalizeTotals(totals: ScanTotals): ScanTotals {
  return { ...totals, elapsedMs: 0 }
}

function readComparableRows(path: string): readonly Record<string, unknown>[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = database.prepare(`SELECT id, parent_id AS parentId, path, kind, own_bytes AS ownBytes, size_bytes AS sizeBytes,
      direct_children AS directChildren, descendant_count AS descendantCount, unreadable_count AS unreadableCount, scan_state AS scanState
      FROM nodes`).all() as unknown as Array<Record<string, unknown>>
    const paths = new Map(rows.map((row) => [String(row.id), String(row.path)]))
    return rows.map((row) => ({
      path: String(row.path), parentPath: row.parentId === null ? null : paths.get(String(row.parentId)) ?? null,
      kind: String(row.kind), ownBytes: Number(row.ownBytes), sizeBytes: Number(row.sizeBytes), directChildren: Number(row.directChildren),
      descendantCount: Number(row.descendantCount), unreadableCount: Number(row.unreadableCount), scanState: String(row.scanState)
    })).sort((left, right) => String(left.path).localeCompare(String(right.path)))
  } finally { database.close() }
}

type ComparableRow = { path: string; kind: string; ownBytes: number; sizeBytes: number; descendantCount: number; unreadableCount: number; scanState: string }
