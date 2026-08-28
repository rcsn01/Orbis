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
    await store.installInitial(document())
    const reopened = new LocationCatalogStore(directory)
    await reopened.initialize()
    expect(reopened.current).toEqual(document())
    expect((await lstat(directory)).mode & 0o777).toBe(0o700)
    expect((await lstat(store.catalogPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(store.catalogPath, 'utf8')).toBe(`${JSON.stringify(document())}\n`)
    await expect(access(store.temporaryCatalogPath)).rejects.toThrow()
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
    const reopened = new LocationCatalogStore(directory)
    await expect(reopened.initialize()).rejects.toThrow('catalog is invalid')
    expect(await readFile(store.catalogPath, 'utf8')).toBe('{}')
    await expect(access(publication)).resolves.toBeUndefined()
  })

  it('owns serialized saved-location transitions and the current revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orbis-locations-transitions-')); roots.push(root)
    const store = new LocationCatalogStore(join(root, 'indexes'))
    await store.initialize()
    await store.installInitial(document())
    const second: SavedLocationRecord = {
      id: createLocationId(), target: '/Volumes/Other', targetDevice: '3', targetInode: '4', displayName: 'Other', publicationId: null
    }
    const third: SavedLocationRecord = {
      id: createLocationId(), target: '/Volumes/Third', targetDevice: '5', targetInode: '6', displayName: 'Third', publicationId: null
    }

    await Promise.all([store.addLocation(second), store.addLocation(third)])
    await store.selectLocation(second.id)

    expect(store.current).toMatchObject({ revision: 4, selectedLocationId: second.id })
    expect(store.current.locations.map((item) => item.id)).toEqual([location.id, second.id, third.id])
    const reopened = new LocationCatalogStore(store.directory)
    await reopened.initialize()
    expect(reopened.current).toEqual(store.current)
  })

  it('requires explicit ownership when one scan supersedes another', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orbis-locations-scan-owner-')); roots.push(root)
    const store = new LocationCatalogStore(join(root, 'indexes'))
    await store.initialize()
    await store.installInitial(document())
    const firstScanId = '21234567-89ab-4cde-8fab-0123456789ab'
    const secondScanId = '31234567-89ab-4cde-8fab-0123456789ab'
    const pending = { locationId: location.id, target: location.target, targetDevice: location.targetDevice, targetInode: location.targetInode, basePublicationId: publicationId }
    await store.beginScan({ ...pending, scanId: firstScanId })

    await expect(store.beginScan({ ...pending, scanId: secondScanId })).rejects.toThrow('owns the catalog')
    await store.beginScan({ ...pending, scanId: secondScanId }, firstScanId)

    expect(store.current.pendingScan?.scanId).toBe(secondScanId)
  })

  it('commits coverage and retires only publications that leave the live set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orbis-locations-publication-')); roots.push(root)
    const store = new LocationCatalogStore(join(root, 'indexes'))
    await store.initialize()
    const secondId = '21234567-89ab-4cde-8fab-0123456789ab'
    const secondManifest: IndexManifest = { ...manifest, publicationId: secondId, indexFile: `index-${secondId}.sqlite`, target: '/Volumes' }
    const child: SavedLocationRecord = { ...location, id: createLocationId(), target: '/Volumes/Data/Child', targetDevice: '3', targetInode: '4', displayName: 'Child' }
    await store.installInitial(document({ locations: [location, child] }))
    await writeFile(join(store.directory, manifest.indexFile), 'old')
    await writeFile(join(store.directory, secondManifest.indexFile), 'new')
    await store.beginScan({ scanId: secondId, locationId: location.id, target: '/Volumes', targetDevice: '9', targetInode: '10', basePublicationId: publicationId })

    const commit = await store.commitPublication(secondManifest, [location.id, child.id], { scanId: secondId, locationId: location.id, basePublicationId: publicationId })

    expect(commit.durability).toBe('durable')
    expect(store.current.pendingScan).toBeNull()
    expect(store.current.locations.every((item) => item.publicationId === secondId)).toBe(true)
    expect(store.current.publications).toEqual([secondManifest])
    await expect(access(join(store.directory, manifest.indexFile))).rejects.toThrow()
    await expect(access(join(store.directory, secondManifest.indexFile))).resolves.toBeUndefined()
  })

  it('owns removal, coverage repair, and unchanged publication transitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orbis-locations-lifecycle-')); roots.push(root)
    const store = new LocationCatalogStore(join(root, 'indexes'))
    await store.initialize()
    const child: SavedLocationRecord = { ...location, id: createLocationId(), target: '/Volumes/Data/Child', targetDevice: '3', targetInode: '4', displayName: 'Child' }
    await store.installInitial(document({ locations: [location, child] }))

    await store.removeLocation(location.id)
    expect(store.current.locations).toEqual([child])
    expect(store.current.publications).toEqual([manifest])
    const scanId = '21234567-89ab-4cde-8fab-0123456789ab'
    await store.beginScan({ scanId, locationId: child.id, target: child.target, targetDevice: child.targetDevice, targetInode: child.targetInode, basePublicationId: publicationId })
    const refreshed = { ...manifest, journal: { uuid: 'volume', eventId: '9' } }
    await expect(store.advancePublication('wrong-scan', refreshed)).rejects.toThrow('pending scan')
    await store.advancePublication(scanId, refreshed)
    expect(store.current).toMatchObject({ pendingScan: null, publications: [refreshed] })
    await store.repairLocationCoverage(child.id, null)
    expect(store.current.publications).toEqual([])
    await store.beginScan({ scanId, locationId: child.id, target: child.target, targetDevice: child.targetDevice, targetInode: child.targetInode, basePublicationId: null })
    const restoredScanId = '31234567-89ab-4cde-8fab-0123456789ab'
    await store.reconcileResume({ scanId: restoredScanId, locationId: child.id, target: child.target, targetDevice: child.targetDevice, targetInode: child.targetInode, basePublicationId: null })
    expect(store.current.pendingScan?.scanId).toBe(restoredScanId)

    const replacementStore = new LocationCatalogStore(join(root, 'replacement-indexes'))
    await replacementStore.initialize()
    await replacementStore.installInitial(document())
    await replacementStore.reconcileResume({ scanId: restoredScanId, locationId: location.id, target: location.target, targetDevice: '7', targetInode: '8', basePublicationId: publicationId })
    expect(replacementStore.current.locations[0]).toMatchObject({ targetDevice: '7', targetInode: '8', publicationId: null })
    expect(replacementStore.current.pendingScan).toMatchObject({ scanId: restoredScanId, basePublicationId: null })
    expect(replacementStore.current.publications).toEqual([])
  })

  it('preserves both publication generations when directory durability is uncertain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orbis-locations-uncertain-')); roots.push(root)
    let syncs = 0
    const store = new LocationCatalogStore(join(root, 'indexes'), { syncDirectory: async () => {
      syncs += 1
      if (syncs === 3) throw new Error('injected directory fsync failure')
    } })
    await store.initialize()
    await store.installInitial(document())
    const secondId = '21234567-89ab-4cde-8fab-0123456789ab'
    const secondManifest: IndexManifest = { ...manifest, publicationId: secondId, indexFile: `index-${secondId}.sqlite` }
    await writeFile(join(store.directory, manifest.indexFile), 'old')
    await writeFile(join(store.directory, secondManifest.indexFile), 'new')
    await store.beginScan({ scanId: secondId, locationId: location.id, target: location.target, targetDevice: location.targetDevice, targetInode: location.targetInode, basePublicationId: publicationId })

    const commit = await store.commitPublication(secondManifest, [location.id], { scanId: secondId, locationId: location.id, basePublicationId: publicationId })

    expect(commit.durability).toBe('uncertain')
    expect(store.current.locations[0]!.publicationId).toBe(secondId)
    await expect(access(join(store.directory, manifest.indexFile))).resolves.toBeUndefined()
    await expect(access(join(store.directory, secondManifest.indexFile))).resolves.toBeUndefined()
    await store.reconcileArtifacts()
    await expect(access(join(store.directory, manifest.indexFile))).rejects.toThrow()
    await expect(access(join(store.directory, secondManifest.indexFile))).resolves.toBeUndefined()
  })
})
