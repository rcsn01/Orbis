import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocationCatalogStore, buildSavedLocation, isLocationCatalogDocument } from '../src/main/location-catalog'
import type { IndexManifest } from '../src/main/index-manifest'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const publicationId = '01234567-89ab-4cde-8fab-0123456789ab'
const manifest: IndexManifest = { version: 1, publicationId, indexFile: `index-${publicationId}.sqlite`, target: '/Volumes/Data', targetDevice: '1', targetInode: '2', schemaVersion: 3, indexRevision: 1, journal: null }

describe('LocationCatalogStore', () => {
  it('publishes and loads a private, validated catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orbis-locations-')); roots.push(root)
    const directory = join(root, 'indexes'); const store = new LocationCatalogStore(directory)
    await store.initialize()
    const document = store.build([buildSavedLocation(manifest, 'loc-11234567-89ab-4cde-8fab-0123456789ab')])
    await store.publish(document)
    expect(await store.load()).toEqual(document)
    expect((await stat(join(directory, 'locations.json'))).mode & 0o777).toBe(0o600)
    expect(store.referencedIndexFiles(document)).toEqual([manifest.indexFile])
  })

  it('rejects duplicate identities and unsafe metadata files', async () => {
    const first = buildSavedLocation(manifest, 'loc-11234567-89ab-4cde-8fab-0123456789ab')
    const second = { ...first, id: 'loc-21234567-89ab-4cde-8fab-0123456789ab' }
    expect(isLocationCatalogDocument({ version: 1, locations: [first, second], pendingScan: null })).toBe(false)
    const root = await mkdtemp(join(tmpdir(), 'orbis-locations-')); roots.push(root)
    const directory = join(root, 'indexes'); await mkdir(directory)
    await writeFile(join(directory, 'locations.json'), '{}')
    expect(await new LocationCatalogStore(directory).load()).toBeUndefined()
    expect(await readFile(join(directory, 'locations.json'), 'utf8')).toBe('{}')
  })
})
