import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, resolve } from 'node:path'
import type { LocationId } from '../shared/contracts'
import { isLocationId } from '../shared/contracts'
import { isIndexManifest, type IndexManifest } from './index-manifest'
import { isPublicationId, PublicationArtifacts, publicationDatabaseFiles } from './publication-artifacts'

const DECIMAL = /^(?:0|[1-9]\d*)$/u

export interface SavedLocationRecord {
  readonly id: LocationId
  readonly target: string
  readonly targetDevice: string
  readonly targetInode: string
  readonly displayName: string
  readonly publicationId: string | null
}

export interface PendingScanRecord {
  readonly scanId: string
  readonly locationId: LocationId
  readonly target: string
  readonly targetDevice: string
  readonly targetInode: string
  readonly basePublicationId: string | null
}

export interface LocationCatalogDocument {
  readonly version: 1
  readonly revision: number
  readonly selectedLocationId: LocationId
  readonly locations: readonly SavedLocationRecord[]
  readonly publications: readonly IndexManifest[]
  readonly pendingScan: PendingScanRecord | null
}

export interface LocationCatalogPaths {
  readonly partialPath: string
  readonly indexPath: string
}

export interface ResolvedLocationTarget {
  readonly target: string
  readonly targetDevice: string
  readonly targetInode: string
}

export interface CatalogScanOwnership {
  readonly scanId: string
  readonly locationId: LocationId
  readonly basePublicationId: string | null
}

export interface CatalogCommit {
  readonly document: LocationCatalogDocument
  readonly durability: 'durable' | 'uncertain'
  readonly cleanupPending: boolean
}

export interface LocationCatalogStoreOptions {
  /** Internal seam for deterministic directory-durability tests. */
  readonly syncDirectory?: (directory: string) => Promise<void>
}

export class LocationCatalogStore {
  readonly directory: string
  readonly artifacts: PublicationArtifacts
  readonly catalogPath: string
  readonly temporaryCatalogPath: string
  readonly #syncDirectory: (directory: string) => Promise<void>
  #document?: LocationCatalogDocument
  #uncertainIndexFiles = new Set<string>()
  #directoryDurabilityEstablished = false
  #tail: Promise<void> = Promise.resolve()

  constructor(directory: string, options: LocationCatalogStoreOptions = {}) {
    this.directory = resolve(directory)
    this.catalogPath = join(this.directory, 'locations.json')
    this.temporaryCatalogPath = `${this.catalogPath}.tmp`
    this.artifacts = new PublicationArtifacts(this.directory)
    this.#syncDirectory = options.syncDirectory ?? syncDirectory
  }

  get current(): LocationCatalogDocument {
    if (!this.#document) throw new Error('Orbis location catalog is not initialized')
    return this.#document
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    const loaded = await this.#load()
    if (loaded) this.#document = loaded
    else {
      try {
        await lstat(this.catalogPath)
        throw new Error('Stored Orbis location catalog is invalid')
      } catch (error) {
        if (!isMissingPath(error)) throw error
      }
    }
  }

  paths(publicationId: string): LocationCatalogPaths {
    const files = publicationDatabaseFiles(publicationId)
    return { partialPath: join(this.directory, files.partialFile), indexPath: join(this.directory, files.candidateFile) }
  }

  async #load(): Promise<LocationCatalogDocument | undefined> {
    try {
      const stats = await lstat(this.catalogPath)
      if (!stats.isFile() || stats.isSymbolicLink()) return undefined
      const value = JSON.parse(await readFile(this.catalogPath, 'utf8')) as unknown
      const document = isLocationCatalogDocument(value) ? freezeCatalog(value) : undefined
      if (document) this.#document = document
      return document
    } catch { return undefined }
  }

  async installInitial(document: LocationCatalogDocument): Promise<CatalogCommit> {
    return this.#serialized(async () => {
      if (this.#document) throw new Error('Orbis location catalog is already initialized')
      return this.#commit(document)
    })
  }

  async addLocation(location: SavedLocationRecord): Promise<CatalogCommit> {
    return this.#transition((document) => ({ ...document, locations: [...document.locations, location], selectedLocationId: location.id }))
  }

  async selectLocation(locationId: LocationId): Promise<CatalogCommit> {
    return this.#transition((document) => {
      if (!document.locations.some((location) => location.id === locationId)) throw new Error('Unknown Orbis location')
      return { ...document, selectedLocationId: locationId }
    })
  }

  async replaceLocation(location: SavedLocationRecord): Promise<CatalogCommit> {
    return this.#transition((document) => {
      if (!document.locations.some((candidate) => candidate.id === location.id)) throw new Error('Unknown Orbis location')
      const locations = document.locations.map((candidate) => candidate.id === location.id ? location : candidate)
      return withReferencedPublications({ ...document, locations, selectedLocationId: location.id })
    })
  }

  async removeLocation(locationId: LocationId): Promise<CatalogCommit> {
    return this.#transition((document) => {
      if (document.locations.length === 1) throw new Error('The last location cannot be removed')
      if (document.pendingScan?.locationId === locationId) throw new Error('The scan owner cannot be removed')
      if (!document.locations.some((location) => location.id === locationId)) throw new Error('Unknown Orbis location')
      const locations = document.locations.filter((location) => location.id !== locationId)
      const selectedLocationId = document.selectedLocationId === locationId ? locations[0]!.id : document.selectedLocationId
      return withReferencedPublications({ ...document, locations, selectedLocationId })
    })
  }

  async repairLocationCoverage(locationId: LocationId, publicationId: string | null): Promise<CatalogCommit> {
    return this.#transition((document) => {
      if (publicationId !== null && !document.publications.some((publication) => publication.publicationId === publicationId)) throw new Error('Unknown Orbis publication')
      if (!document.locations.some((location) => location.id === locationId)) throw new Error('Unknown Orbis location')
      const locations = document.locations.map((location) => location.id === locationId ? { ...location, publicationId } : location)
      return withReferencedPublications({ ...document, locations })
    })
  }

  /** Reconciles a validated authoritative Resume descriptor with catalog ownership. */
  async reconcileResume(pendingScan: PendingScanRecord, owner?: SavedLocationRecord): Promise<CatalogCommit> {
    return this.#serialized(async () => {
      const document = this.current
      const existing = document.locations.find((location) => location.id === pendingScan.locationId)
      const identityMatches = existing?.target === pendingScan.target && existing.targetDevice === pendingScan.targetDevice && existing.targetInode === pendingScan.targetInode
      const reconciledPending = identityMatches ? pendingScan : { ...pendingScan, basePublicationId: null }
      if (identityMatches && document.pendingScan && samePendingScan(document.pendingScan, reconciledPending)) {
        return { document, durability: this.#directoryDurabilityEstablished ? 'durable' : 'uncertain', cleanupPending: false }
      }
      let locations: readonly SavedLocationRecord[]
      if (existing) {
        const reconciledOwner: SavedLocationRecord = {
          ...existing, target: pendingScan.target, targetDevice: pendingScan.targetDevice, targetInode: pendingScan.targetInode,
          publicationId: identityMatches ? existing.publicationId : null
        }
        locations = document.locations.map((location) => location.id === existing.id ? reconciledOwner : location)
      } else if (owner) {
        locations = [...document.locations, { ...owner, target: pendingScan.target, targetDevice: pendingScan.targetDevice, targetInode: pendingScan.targetInode, publicationId: null }]
      } else {
        throw new Error('The Resume descriptor has no saved-location owner')
      }
      const next = withReferencedPublications({ ...document, version: 1, revision: document.revision + 1, locations, pendingScan: reconciledPending })
      return this.#commit(next, document)
    })
  }

  async beginScan(pendingScan: PendingScanRecord, expectedPreviousScanId?: string): Promise<CatalogCommit> {
    return this.#transition((document) => {
      const existing = document.pendingScan
      if (existing && !samePendingScan(existing, pendingScan)) {
        const explicitlyReplaced = expectedPreviousScanId === existing.scanId && samePendingOwner(existing, pendingScan)
        if (!explicitlyReplaced) throw new Error('Another Orbis scan owns the catalog')
      }
      return { ...document, pendingScan }
    })
  }

  async clearPendingScan(expectedScanId?: string): Promise<CatalogCommit> {
    return this.#serialized(async () => {
      const document = this.current
      if (!document.pendingScan) return { document, durability: this.#directoryDurabilityEstablished ? 'durable' : 'uncertain', cleanupPending: false }
      if (expectedScanId !== undefined && document.pendingScan.scanId !== expectedScanId) throw new Error('The scan no longer owns the pending catalog transaction')
      return this.#commit({ ...document, revision: document.revision + 1, pendingScan: null }, document)
    })
  }

  async commitPublication(publication: IndexManifest, coveredLocationIds: readonly LocationId[], ownership: CatalogScanOwnership): Promise<CatalogCommit> {
    return this.#transition((document) => {
      const pending = document.pendingScan
      if (!pending || pending.scanId !== publication.publicationId || pending.scanId !== ownership.scanId
        || pending.locationId !== ownership.locationId || pending.basePublicationId !== ownership.basePublicationId) throw new Error('The publication does not own the pending scan')
      const covered = new Set(coveredLocationIds)
      if (!covered.has(pending.locationId)) throw new Error('The publication does not cover its scan owner')
      const locations = document.locations.map((location) => covered.has(location.id) ? { ...location, publicationId: publication.publicationId } : location)
      const referenced = new Set(locations.flatMap((location) => location.publicationId ? [location.publicationId] : []))
      const publications = [...document.publications.filter((candidate) => candidate.publicationId !== publication.publicationId), publication]
        .filter((candidate) => referenced.has(candidate.publicationId))
      return { ...document, locations, publications, pendingScan: null }
    })
  }

  async advancePublication(scanId: string, publication: IndexManifest): Promise<CatalogCommit> {
    return this.#transition((document) => {
      const pending = document.pendingScan
      if (!pending || pending.scanId !== scanId || pending.basePublicationId !== publication.publicationId) throw new Error('The publication does not own the pending scan')
      if (!document.publications.some((candidate) => candidate.publicationId === publication.publicationId)) throw new Error('Unknown Orbis publication')
      const publications = document.publications.map((candidate) => candidate.publicationId === publication.publicationId ? publication : candidate)
      return { ...document, publications, pendingScan: null }
    })
  }

  async reconcileArtifacts(): Promise<void> {
    await this.#serialized(async () => {
      if (!this.#directoryDurabilityEstablished) {
        const stabilized = await this.#commit(this.current, this.current, false)
        if (stabilized.durability === 'uncertain') return
      }
      await this.artifacts.reconcile({ retain: this.#retainedIndexFiles() })
    })
  }

  #retainedIndexFiles(): readonly string[] {
    const document = this.current
    const files = new Set(document.publications.map((publication) => publication.indexFile))
    if (document.pendingScan) {
      const pending = publicationDatabaseFiles(document.pendingScan.scanId)
      files.add(pending.partialFile)
      files.add(pending.candidateFile)
    }
    for (const file of this.#uncertainIndexFiles) files.add(file)
    return [...files]
  }

  #transition(change: (document: LocationCatalogDocument) => Omit<LocationCatalogDocument, 'version' | 'revision'> & Partial<Pick<LocationCatalogDocument, 'version' | 'revision'>>): Promise<CatalogCommit> {
    return this.#serialized(async () => {
      const current = this.current
      const changed = change(current)
      const next: LocationCatalogDocument = { ...changed, version: 1, revision: current.revision + 1 }
      return this.#commit(next, current)
    })
  }

  async #commit(document: LocationCatalogDocument, previous?: LocationCatalogDocument, retire = true): Promise<CatalogCommit> {
    if (!isLocationCatalogDocument(document)) throw new Error('Invalid Orbis location catalog')
    await writeFile(this.temporaryCatalogPath, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(this.temporaryCatalogPath, 0o600)
    const file = await open(this.temporaryCatalogPath, 'r')
    try { await file.sync() } finally { await file.close() }
    await rename(this.temporaryCatalogPath, this.catalogPath)
    let durability: CatalogCommit['durability'] = 'durable'
    try { await this.#syncDirectory(this.directory) } catch { durability = 'uncertain' }
    const committed = freezeCatalog(document)
    this.#document = committed
    this.#directoryDurabilityEstablished = durability === 'durable'
    const previousFiles = previous ? catalogIndexFiles(previous) : []
    const currentFiles = catalogIndexFiles(committed)
    if (durability === 'uncertain') this.#uncertainIndexFiles = new Set([...this.#uncertainIndexFiles, ...previousFiles, ...currentFiles])
    else this.#uncertainIndexFiles.clear()
    let cleanupPending = false
    if (retire && durability === 'durable') {
      const retained = new Set(committed.publications.map((publication) => publication.indexFile))
      const obsolete = (previous?.publications ?? []).filter((publication) => !retained.has(publication.indexFile))
      const results = await Promise.allSettled(obsolete.map((publication) => this.artifacts.discardUnreferencedDatabase(join(this.directory, publication.indexFile))))
      cleanupPending = results.some((result) => result.status === 'rejected')
    }
    return { document: committed, durability, cleanupPending }
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

function samePendingScan(left: PendingScanRecord, right: PendingScanRecord): boolean {
  return samePendingOwner(left, right) && left.scanId === right.scanId && left.basePublicationId === right.basePublicationId
}

function samePendingOwner(left: PendingScanRecord, right: PendingScanRecord): boolean {
  return left.locationId === right.locationId && left.target === right.target
    && left.targetDevice === right.targetDevice && left.targetInode === right.targetInode
}

function catalogIndexFiles(document: LocationCatalogDocument): readonly string[] {
  const files = document.publications.map((publication) => publication.indexFile)
  if (!document.pendingScan) return files
  const pending = publicationDatabaseFiles(document.pendingScan.scanId)
  return [...files, pending.partialFile, pending.candidateFile]
}

function withReferencedPublications(document: LocationCatalogDocument): LocationCatalogDocument {
  const referenced = new Set(document.locations.flatMap((location) => location.publicationId ? [location.publicationId] : []))
  return { ...document, publications: document.publications.filter((publication) => referenced.has(publication.publicationId)) }
}

export function createLocationId(): LocationId { return `loc-${randomUUID()}` as LocationId }

export function createEmptyCatalog(target: ResolvedLocationTarget): LocationCatalogDocument {
  const location: SavedLocationRecord = {
    id: createLocationId(), ...target, displayName: displayName(target.target), publicationId: null
  }
  return { version: 1, revision: 1, selectedLocationId: location.id, locations: [location], publications: [], pendingScan: null }
}

export function uniqueDisplayName(target: string, locations: readonly SavedLocationRecord[]): string {
  const base = displayName(target)
  const used = new Set(locations.map((location) => location.displayName))
  if (!used.has(base)) return base
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base} (${suffix})`
    if (!used.has(candidate)) return candidate
  }
  throw new Error('Too many saved locations with the same name')
}

export function isLocationCatalogDocument(value: unknown): value is LocationCatalogDocument {
  if (!isRecord(value) || value.version !== 1 || !positiveInteger(value.revision)) return false
  if (!isLocationId(value.selectedLocationId) || !Array.isArray(value.locations) || value.locations.length === 0 || !Array.isArray(value.publications)) return false
  if (!value.locations.every(isSavedLocation) || !value.publications.every(isIndexManifest)) return false
  const locationIds = new Set<string>()
  const targets = new Set<string>()
  for (const location of value.locations) {
    if (locationIds.has(location.id) || targets.has(location.target)) return false
    locationIds.add(location.id); targets.add(location.target)
  }
  if (!locationIds.has(value.selectedLocationId)) return false
  const publicationIds = new Set<string>()
  for (const publication of value.publications) {
    if (publicationIds.has(publication.publicationId)) return false
    publicationIds.add(publication.publicationId)
  }
  if (value.locations.some((location) => location.publicationId !== null && !publicationIds.has(location.publicationId))) return false
  if (value.pendingScan !== null) {
    if (!isPendingScan(value.pendingScan) || !locationIds.has(value.pendingScan.locationId)) return false
    if (value.pendingScan.basePublicationId !== null && !publicationIds.has(value.pendingScan.basePublicationId)) return false
  }
  return true
}

function isSavedLocation(value: unknown): value is SavedLocationRecord {
  return isRecord(value) && isLocationId(value.id) && canonicalPath(value.target) !== undefined
    && decimal(value.targetDevice) && decimal(value.targetInode)
    && typeof value.displayName === 'string' && value.displayName.length > 0 && value.displayName.length <= 256
    && (value.publicationId === null || isPublicationId(value.publicationId))
}

function isPendingScan(value: unknown): value is PendingScanRecord {
  return isRecord(value) && isPublicationId(value.scanId) && isLocationId(value.locationId)
    && canonicalPath(value.target) !== undefined && decimal(value.targetDevice) && decimal(value.targetInode)
    && (value.basePublicationId === null || isPublicationId(value.basePublicationId))
}

function displayName(target: string): string { return target === '/' ? '/' : basename(target) || target }
function canonicalPath(value: unknown): string | undefined { return typeof value === 'string' && !value.includes('\0') && isAbsolute(value) && normalize(value) === value ? value : undefined }
function decimal(value: unknown): value is string { return typeof value === 'string' && DECIMAL.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn }
function positiveInteger(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 }
function freezeCatalog(document: LocationCatalogDocument): LocationCatalogDocument {
  const locations = Object.freeze(document.locations.map((location) => Object.freeze({ ...location })))
  const publications = Object.freeze(document.publications.map((publication) => Object.freeze({ ...publication, journal: publication.journal ? Object.freeze({ ...publication.journal }) : null })))
  const pendingScan = document.pendingScan ? Object.freeze({ ...document.pendingScan }) : null
  return Object.freeze({ ...document, locations, publications, pendingScan })
}

function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isMissingPath(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' }
