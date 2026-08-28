import { access, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LocationCatalogStore, createEmptyCatalog, createLocationId, isLocationCatalogDocument,
  type LocationCatalogDocument, type SavedLocationRecord
} from '../src/main/location-catalog'
import type { IndexManifest } from '../src/main/index-manifest'
import type { LocationId } from '../src/shared/contracts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const publicationId = '01234567-89ab-4cde-8fab-0123456789ab'
const manifest: IndexManifest = { version: 1, publicationId, indexFile: `index-${publicationId}.sqlite`, target: '/Volumes/Data', targetDevice: '1', targetInode: '2', schemaVersion: 3, indexRevision: 1, journal: null }
const location: SavedLocationRecord = {
  id: 'loc-11234567-89ab-4cde-8fab-0123456789ab' as LocationId, target: '/Volumes/Data', targetDevice: '1', targetInode: '2',
  displayName: 'Data', publicationId
}

function document(overrides: Partial<LocationCatalogDocument> = {}): LocationCatalogDocument {
  return { version: 1, revision: 1, selectedLocationId: location.id, locations: [location], publications: [manifest], pendingScan: null, ...overrides }
}

describe('LocationCatalogStore', () => {
  it('publishes and loads a private atomic catalog with independent locations and publications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orbis-locations-')); roots.push(root)
    const directory = join(root, 'indexes'); const store = new LocationCatalogStore(directory)
    await store.initialize()
    await store.publish(document())
    expect(await store.load()).toEqual(document())
    expect((await lstat(directory)).mode & 0o777).toBe(0o700)
    expect((await lstat(store.catalogPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(store.catalogPath, 'utf8')).toBe(`${JSON.stringify(document())}\n`)
    await expect(access(store.temporaryCatalogPath)).rejects.toThrow()
    expect(store.referencedIndexFiles(document())).toEqual([manifest.indexFile])
  })

  it('validates catalog references, selection, pending scan ownership, and unique ids', () => {
    expect(isLocationCatalogDocument(document())).toBe(true)
    expect(isLocationCatalogDocument(document({ selectedLocationId: createLocationId() }))).toBe(false)
    expect(isLocationCatalogDocument(document({ locations: [location, { ...location, target: '/other' }] }))).toBe(false)
    expect(isLocationCatalogDocument(document({ locations: [{ ...location, publicationId: '21234567-89ab-4cde-8fab-0123456789ab' }] }))).toBe(false)
    expect(isLocationCatalogDocument(document({ pendingScan: { scanId: '21234567-89ab-4cde-8fab-0123456789ab', locationId: location.id, target: location.target, targetDevice: '1', targetInode: '2', basePublicationId: publicationId } }))).toBe(true)
    expect(isLocationCatalogDocument(document({ pendingScan: { scanId: '21234567-89ab-4cde-8fab-0123456789ab', locationId: createLocationId(), target: location.target, targetDevice: '1', targetInode: '2', basePublicationId: null } }))).toBe(false)
  })

  it('creates one unindexed initial location with a path-free unique label', () => {
    const first = createEmptyCatalog({ target: '/Users/me/Projects', targetDevice: '7', targetInode: '8' })
    expect(first).toMatchObject({ version: 1, revision: 1, locations: [{ target: '/Users/me/Projects', displayName: 'Projects', publicationId: null }], publications: [], pendingScan: null })
    expect(first.selectedLocationId).toBe(first.locations[0]!.id)
    expect(isLocationCatalogDocument(first)).toBe(true)
  })

  it('rejects malformed files without rewriting metadata or reconciling publications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orbis-locations-invalid-')); roots.push(root)
    const directory = join(root, 'indexes'); const store = new LocationCatalogStore(directory)
    await store.initialize()
    const publication = store.paths(publicationId).indexPath
    await writeFile(publication, 'publication')
    await writeFile(store.catalogPath, '{}')
    await store.initialize()
    await expect(store.load()).resolves.toBeUndefined()
    expect(await readFile(store.catalogPath, 'utf8')).toBe('{}')
    await expect(access(publication)).resolves.toBeUndefined()
  })
})
