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

export class LocationCatalogStore {
  readonly directory: string
  readonly artifacts: PublicationArtifacts
  readonly catalogPath: string
  readonly temporaryCatalogPath: string
  lastPublicationDurable = true

  constructor(directory: string) {
    this.directory = resolve(directory)
    this.catalogPath = join(this.directory, 'locations.json')
    this.temporaryCatalogPath = `${this.catalogPath}.tmp`
    this.artifacts = new PublicationArtifacts(this.directory)
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    await this.artifacts.reconcile()
  }

  paths(publicationId: string): LocationCatalogPaths {
    const files = publicationDatabaseFiles(publicationId)
    return { partialPath: join(this.directory, files.partialFile), indexPath: join(this.directory, files.candidateFile) }
  }

  async load(): Promise<LocationCatalogDocument | undefined> {
    try {
      const stats = await lstat(this.catalogPath)
      if (!stats.isFile() || stats.isSymbolicLink()) return undefined
      const value = JSON.parse(await readFile(this.catalogPath, 'utf8')) as unknown
      return isLocationCatalogDocument(value) ? value : undefined
    } catch { return undefined }
  }

  async publish(document: LocationCatalogDocument): Promise<void> {
    if (!isLocationCatalogDocument(document)) throw new Error('Invalid Orbis location catalog')
    await writeFile(this.temporaryCatalogPath, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(this.temporaryCatalogPath, 0o600)
    const file = await open(this.temporaryCatalogPath, 'r')
    try { await file.sync() } finally { await file.close() }
    this.lastPublicationDurable = false
    await rename(this.temporaryCatalogPath, this.catalogPath)
    try {
      const directory = await open(this.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
      this.lastPublicationDurable = true
    } catch { /* The rename committed; callers retain both possible generations. */ }
  }

  referencedIndexFiles(document: LocationCatalogDocument): readonly string[] {
    if (!isLocationCatalogDocument(document)) throw new Error('Invalid Orbis location catalog')
    const files = new Set(document.publications.map((publication) => publication.indexFile))
    if (document.pendingScan) {
      const pending = publicationDatabaseFiles(document.pendingScan.scanId)
      files.add(pending.partialFile)
      files.add(pending.candidateFile)
    }
    return [...files]
  }
}

export function createLocationId(): LocationId { return `loc-${randomUUID()}` as LocationId }

export function createEmptyCatalog(target: ResolvedLocationTarget): LocationCatalogDocument {
  const location: SavedLocationRecord = {
    id: createLocationId(), ...target, displayName: displayName(target.target), publicationId: null
  }
  return { version: 1, revision: 1, selectedLocationId: location.id, locations: [location], publications: [], pendingScan: null }
}

export function nextCatalog(document: LocationCatalogDocument, changes: Partial<Omit<LocationCatalogDocument, 'version' | 'revision'>>): LocationCatalogDocument {
  const next: LocationCatalogDocument = { ...document, ...changes, version: 1, revision: document.revision + 1 }
  if (!isLocationCatalogDocument(next)) throw new Error('Invalid Orbis location catalog transition')
  return next
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
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
