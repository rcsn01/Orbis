import { DatabaseSync } from 'node:sqlite'
import { copyFile, link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { replaceIndexSubtrees } from '../src/main/persistent-index-database'
import { scanFilesystem } from '../src/main/scanner'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('persistent Orbis index reconciliation', () => {
  it('replaces an exact subtree and recomputes global hard-link ownership', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-incremental-db-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(join(target, 'a'), { recursive: true })
    await mkdir(join(target, 'z'), { recursive: true })
    const existingAlias = join(target, 'z', 'shared.dat')
    await writeFile(existingAlias, Buffer.alloc(8192, 1))
    await writeFile(join(target, 'a', 'changed.dat'), Buffer.alloc(512, 2))

    const active = await scan(1, target, indexes, 'active')
    await writeFile(join(target, 'a', 'changed.dat'), Buffer.alloc(12_288, 3))
    await writeFile(join(target, 'a', 'added.dat'), Buffer.alloc(4096, 4))
    await link(existingAlias, join(target, 'a', 'shared.dat'))
    const replacement = await scan(2, join(target, 'a'), indexes, 'replacement')
    const candidate = join(indexes, 'candidate.sqlite')
    await copyFile(active.publishedPath, candidate)

    replaceIndexSubtrees({
      candidatePath: candidate,
      target,
      replacements: [{ path: join(target, 'a'), indexPath: replacement.publishedPath }],
      indexRevision: 2,
      capacityBytes: active.capacityBytes,
      freeBytes: active.freeBytes,
      elapsedMs: 10
    })
    const fresh = await scan(3, target, indexes, 'fresh')

    expect(readSemanticRows(candidate)).toEqual(readSemanticRows(fresh.publishedPath))
    const database = new DatabaseSync(candidate, { readOnly: true })
    try {
      expect(database.prepare("SELECT path FROM nodes WHERE name = 'shared.dat'").all()).toEqual([{ path: join(target, 'a', 'shared.dat') }])
      expect(database.prepare("SELECT value FROM metadata WHERE key = 'indexRevision'").get()).toEqual({ value: '2' })
      const totals = JSON.parse((database.prepare("SELECT value FROM metadata WHERE key = 'totals'").get() as { value: string }).value)
      expect(totals.duplicateHardLinks).toBe(1)
      expect(totals.discoveredBytes).toBe((database.prepare("SELECT size_bytes AS bytes FROM nodes WHERE parent_id IS NULL").get() as { bytes: number }).bytes)
    } finally { database.close() }
  })

  it('promotes a hard-link owner outside the dirty subtree after deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-incremental-owner-delete-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(join(target, 'A-owner'), { recursive: true })
    await mkdir(join(target, 'Z-source'), { recursive: true })
    const source = join(target, 'Z-source', 'shared.dat')
    const owner = join(target, 'A-owner', 'shared.dat')
    await writeFile(source, Buffer.alloc(8192, 1))
    await link(source, owner)
    const active = await scan(1, target, indexes, 'delete-active')
    await rm(owner)
    const replacement = await scan(2, join(target, 'A-owner'), indexes, 'delete-replacement')
    const candidate = join(indexes, 'delete-candidate.sqlite')
    await copyFile(active.publishedPath, candidate)
    replaceIndexSubtrees({
      candidatePath: candidate, target, replacements: [{ path: join(target, 'A-owner'), indexPath: replacement.publishedPath }],
      indexRevision: 2, capacityBytes: active.capacityBytes, freeBytes: active.freeBytes, elapsedMs: 1
    })
    const fresh = await scan(3, target, indexes, 'delete-fresh')
    expect(readSemanticRows(candidate)).toEqual(readSemanticRows(fresh.publishedPath))
    const database = new DatabaseSync(candidate, { readOnly: true })
    try { expect(database.prepare("SELECT path FROM nodes WHERE name = 'shared.dat'").all()).toEqual([{ path: source }]) }
    finally { database.close() }
  })

  it('propagates allocation changes observed through a non-owner alias', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-incremental-alias-size-'))
    cleanup.push(directory)
    const target = join(directory, 'target')
    const indexes = join(directory, 'indexes')
    await mkdir(join(target, 'a'), { recursive: true })
    await mkdir(join(target, 'z'), { recursive: true })
    const owner = join(target, 'a', 'shared.dat')
    const alias = join(target, 'z', 'shared.dat')
    await writeFile(owner, Buffer.alloc(512, 1))
    await link(owner, alias)
    const active = await scan(1, target, indexes, 'allocation-active')
    await writeFile(alias, Buffer.alloc(65_536, 2))
    const replacement = await scan(2, join(target, 'z'), indexes, 'allocation-replacement')
    const candidate = join(indexes, 'allocation-candidate.sqlite')
    await copyFile(active.publishedPath, candidate)
    replaceIndexSubtrees({
      candidatePath: candidate, target, replacements: [{ path: join(target, 'z'), indexPath: replacement.publishedPath }],
      indexRevision: 2, capacityBytes: active.capacityBytes, freeBytes: active.freeBytes, elapsedMs: 1
    })
    const fresh = await scan(3, target, indexes, 'allocation-fresh')
    expect(readSemanticRows(candidate)).toEqual(readSemanticRows(fresh.publishedPath))
  })
})

async function scan(generation: number, target: string, indexes: string, name: string) {
  return scanFilesystem({
    generation,
    target,
    indexDirectory: indexes,
    partialPath: join(indexes, `${name}.partial.sqlite`),
    publishedPath: join(indexes, `${name}.sqlite`)
  })
}

function readSemanticRows(path: string): unknown[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare(`SELECT path, kind, own_bytes AS ownBytes, size_bytes AS sizeBytes,
      direct_children AS directChildren, descendant_count AS descendantCount, unreadable_count AS unreadableCount,
      device, inode FROM nodes ORDER BY path`).all()
  } finally { database.close() }
}
