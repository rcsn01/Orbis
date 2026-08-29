import { randomUUID } from 'node:crypto'
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CoverageAccessError,
  createCoveragePublicationAccess,
  type CoveragePublicationAccess,
  type PersistentPublicationCandidate
} from '../src/main/coverage-publication-access'
import { createEmptyCatalog, createLocationId, LocationCatalogStore, type CatalogScanOwnership, type ResolvedLocationTarget } from '../src/main/location-catalog'
import { scanFilesystem, type ScanResult } from '../src/main/scanner'

interface Fixture {
  readonly directory: string
  readonly indexes: string
  readonly target: string
  readonly identity: ResolvedLocationTarget
  readonly catalog: LocationCatalogStore
  readonly coverage: CoveragePublicationAccess
}

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function fixture(name: string): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), `orbis-coverage-${name}-`))
  cleanup.push(directory)
  const target = join(directory, 'target')
  const indexes = join(directory, 'indexes')
  await mkdir(join(target, 'child'), { recursive: true })
  await mkdir(indexes)
  await writeFile(join(target, 'child', 'file.txt'), 'contents')
  const identity = await targetIdentity(target)
  const catalog = new LocationCatalogStore(indexes)
  await catalog.initialize()
  await catalog.installInitial(createEmptyCatalog(identity))
  return { directory, indexes, target: identity.target, identity, catalog, coverage: createCoveragePublicationAccess(indexes, catalog, catalog.artifacts) }
}

async function targetIdentity(target: string): Promise<ResolvedLocationTarget> {
  const canonical = await realpath(target)
  const stats = await lstat(canonical)
  return { target: canonical, targetDevice: String(stats.dev), targetInode: String(stats.ino) }
}

async function candidateFor(value: Fixture, generation = 1, referenceScan = false): Promise<{ candidate: PersistentPublicationCandidate; result: ScanResult }> {
  const scanId = randomUUID()
  const owner = value.catalog.current.locations[0]!
  const ownership: CatalogScanOwnership = { scanId, locationId: owner.id, basePublicationId: owner.publicationId }
  const paths = value.catalog.paths(scanId)
  await value.catalog.beginScan({
    scanId, locationId: owner.id, target: value.target,
    targetDevice: value.identity.targetDevice, targetInode: value.identity.targetInode,
    basePublicationId: owner.publicationId
  })
  const result = await scanFilesystem({ generation, target: value.target, partialPath: paths.partialPath, publishedPath: paths.indexPath, indexDirectory: value.indexes, referenceScan })
  return { candidate: { kind: 'persistent', result, expectedPath: paths.indexPath, ownership, journal: null }, result }
}

async function publish(value: Fixture): Promise<void> {
  const { candidate } = await candidateFor(value)
  const result = await value.coverage.publishAndInstall(candidate, value.catalog.current.selectedLocationId)
  expect(result.kind).toBe('installed')
}

describe('CoveragePublicationAccess', () => {
  it('commits and installs exact coverage while keeping manifest advancement visible', async () => {
    const value = await fixture('exact')
    try {
      const { candidate } = await candidateFor(value)
      const installed = await value.coverage.publishAndInstall(candidate, value.catalog.current.selectedLocationId)
      expect(installed).toMatchObject({ kind: 'installed', persistence: 'catalog', durability: 'durable', cleanupPending: false })
      if (installed.kind !== 'installed') throw new Error('expected installation')
      expect(value.coverage.current()).toBe(installed.access)
      expect(installed.access.logicalTarget).toBe(value.target)
      expect(installed.access.publication()?.publicationId).toBe(candidate.ownership.scanId)

      const manifest = installed.access.publication()!
      await value.catalog.beginScan({
        scanId: randomUUID(), locationId: installed.access.locationId, target: value.target,
        targetDevice: value.identity.targetDevice, targetInode: value.identity.targetInode,
        basePublicationId: manifest.publicationId
      })
      const pending = value.catalog.current.pendingScan!
      await value.catalog.advancePublication(pending.scanId, { ...manifest, journal: { uuid: 'volume', eventId: '42' } })
      expect(installed.access.publication()?.journal).toEqual({ uuid: 'volume', eventId: '42' })
    } finally { await value.coverage.close() }
  })

  it('discovers and activates descendant coverage without changing the current access during discovery', async () => {
    const value = await fixture('descendant')
    try {
      await publish(value)
      const original = value.coverage.current()!
      const childIdentity = await targetIdentity(join(value.target, 'child'))
      const discovery = await value.coverage.discoverCoverage(childIdentity)
      expect(discovery.publicationId).toBe(original.publication()?.publicationId)
      expect(value.coverage.current()).toBe(original)

      const child = {
        id: createLocationId(), ...childIdentity, displayName: 'child', publicationId: 'wrong-pointer'
      }
      await value.catalog.addLocation({ ...child, publicationId: discovery.publicationId })
      const selected = await value.coverage.selectAndRepair(child.id)
      expect(selected?.logicalTarget).toBe(childIdentity.target)
      expect(selected?.root.name).toBe('child')
      expect(value.coverage.current()).toBe(selected)
    } finally { await value.coverage.close() }
  })

  it('clears a stale catalog pointer when its publication is missing', async () => {
    const value = await fixture('missing')
    try {
      await publish(value)
      const manifest = value.catalog.current.publications[0]!
      await value.coverage.close()
      await rm(join(value.indexes, manifest.indexFile), { force: true })
      const reopened = createCoveragePublicationAccess(value.indexes, value.catalog, value.catalog.artifacts)
      expect(await reopened.selectAndRepair(value.catalog.current.selectedLocationId)).toBeUndefined()
      expect(value.catalog.current.locations[0]!.publicationId).toBeNull()
      await reopened.close()
    } finally { await value.coverage.close() }
  })

  it('rejects a malformed candidate before commit and preserves the installed access', async () => {
    const value = await fixture('malformed')
    try {
      await publish(value)
      const original = value.coverage.current()
      const owner = value.catalog.current.locations[0]!
      const scanId = randomUUID()
      const paths = value.catalog.paths(scanId)
      const ownership = { scanId, locationId: owner.id, basePublicationId: owner.publicationId }
      await value.catalog.beginScan({ scanId, locationId: owner.id, target: owner.target, targetDevice: owner.targetDevice, targetInode: owner.targetInode, basePublicationId: owner.publicationId })
      await writeFile(paths.indexPath, 'not sqlite')
      const result: ScanResult = { generation: 2, target: owner.target, rootId: 'root', publishedPath: paths.indexPath, capacityBytes: 0, freeBytes: 0, scannedBytes: 0, totals: { scannedItems: 0, discoveredBytes: 0, elapsedMs: 0, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 } }
      await expect(value.coverage.publishAndInstall({ kind: 'persistent', result, expectedPath: paths.indexPath, ownership, journal: null }, owner.id)).rejects.toThrow()
      expect(value.coverage.current()).toBe(original)
      expect(value.catalog.current.publications[0]?.publicationId).toBe(original?.publication()?.publicationId)
    } finally { await value.coverage.close() }
  })

  it('owns transient reference artifacts through replacement and shutdown', async () => {
    const value = await fixture('transient')
    const owner = value.catalog.current.locations[0]!
    try {
      const persistentShape = await candidateFor(value, 1, true)
      const transientPath = persistentShape.result.publishedPath
      const transient = await value.coverage.publishAndInstall({
        kind: 'transient-reference', result: persistentShape.result, expectedPath: transientPath,
        ownership: persistentShape.candidate.ownership
      }, owner.id)
      expect(transient).toMatchObject({ kind: 'installed', persistence: 'transient', durability: 'not-applicable' })
      expect(value.catalog.current.publications).toHaveLength(0)
      await expect(access(transientPath)).resolves.toBeUndefined()
      await value.coverage.close()
      await expect(access(transientPath)).rejects.toThrow()
    } finally { await value.coverage.close() }
  })

  it('makes close idempotent and rejects later mutations', async () => {
    const value = await fixture('closed')
    await value.coverage.close()
    await value.coverage.close()
    await expect(value.coverage.selectAndRepair(value.catalog.current.selectedLocationId)).rejects.toMatchObject({ code: 'closed' } satisfies Partial<CoverageAccessError>)
  })
})
