import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IndexManifestStore, type IndexManifest } from '../src/main/index-manifest'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

function manifest(publicationId = '01234567-89ab-4cde-8fab-0123456789ab'): IndexManifest {
  return {
    version: 1,
    publicationId,
    indexFile: `index-${publicationId}.sqlite`,
    target: '/tmp/example',
    targetDevice: '1',
    targetInode: '2',
    schemaVersion: 2,
    indexRevision: 1,
    journal: null
  }
}

describe('Orbis index manifest store', () => {
  it('publishes and reloads an atomic private manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-manifest-'))
    cleanup.push(directory)
    const indexes = join(directory, 'indexes')
    const store = new IndexManifestStore(indexes)

    await store.initialize()
    await writeFile(store.paths(manifest().publicationId).indexPath, 'index')
    await store.publish(manifest())

    expect(await store.load()).toEqual(manifest())
    expect((await lstat(indexes)).mode & 0o777).toBe(0o700)
    expect((await lstat(join(indexes, 'current.json'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(indexes, 'current.json'), 'utf8')).toBe(`${JSON.stringify(manifest())}\n`)
    await expect(access(join(indexes, 'current.json.tmp'))).rejects.toThrow()
  })

  it('recovers deterministically around manifest replacement crash points', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-manifest-crash-'))
    cleanup.push(directory)
    const indexes = join(directory, 'indexes')
    const store = new IndexManifestStore(indexes)
    await store.initialize()
    const first = manifest()
    const second = manifest('21234567-89ab-4cde-8fab-0123456789ab')
    await writeFile(store.paths(first.publicationId).indexPath, 'first')
    await writeFile(store.paths(second.publicationId).indexPath, 'second')
    await store.publish(first)

    // Crash before current.json.tmp is renamed: the old publication wins.
    await writeFile(store.temporaryManifestPath, `${JSON.stringify(second)}\n`)
    await store.initialize()
    expect(await store.load()).toEqual(first)
    await store.cleanup(first.indexFile)
    await expect(access(store.paths(first.publicationId).indexPath)).resolves.toBeUndefined()
    await expect(access(store.paths(second.publicationId).indexPath)).rejects.toThrow()

    // Crash after manifest rename: the new referenced publication wins.
    await writeFile(store.paths(second.publicationId).indexPath, 'second')
    await store.publish(second)
    await store.cleanup(second.indexFile)
    expect(await store.load()).toEqual(second)
    await expect(access(store.paths(second.publicationId).indexPath)).resolves.toBeUndefined()
  })

  it('rejects unsafe manifests and cleans only unreferenced owned files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-manifest-cleanup-'))
    cleanup.push(directory)
    const indexes = join(directory, 'indexes')
    const store = new IndexManifestStore(indexes)
    await store.initialize()
    const active = manifest()
    await writeFile(store.paths(active.publicationId).indexPath, 'active')
    await store.publish(active)
    const orphan = store.paths('11234567-89ab-4cde-8fab-0123456789ab')
    await writeFile(orphan.indexPath, 'orphan')
    await writeFile(orphan.partialPath, 'partial')
    await writeFile(`${orphan.partialPath}-journal`, 'journal')
    const unrelated = join(indexes, 'keep.txt')
    const abandonedReconciliation = join(indexes, '.incremental-abandoned')
    const unrelatedDirectory = join(indexes, 'keep-directory')
    await writeFile(unrelated, 'host data')
    await mkdir(abandonedReconciliation)
    await writeFile(join(abandonedReconciliation, 'candidate.sqlite'), 'candidate')
    await mkdir(unrelatedDirectory)

    await store.cleanup(active.indexFile)

    await expect(access(store.paths(active.publicationId).indexPath)).resolves.toBeUndefined()
    for (const path of [orphan.indexPath, orphan.partialPath, `${orphan.partialPath}-journal`]) await expect(access(path)).rejects.toThrow()
    await expect(access(unrelated)).resolves.toBeUndefined()
    await expect(access(abandonedReconciliation)).rejects.toThrow()
    await expect(access(unrelatedDirectory)).resolves.toBeUndefined()

    await writeFile(join(indexes, 'current.json'), '{"version":1,"indexFile":"../escape.sqlite"}\n')
    await expect(store.load()).resolves.toBeUndefined()
  })
})
