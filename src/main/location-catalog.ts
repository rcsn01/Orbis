import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import type { FullScanResumeDescriptor } from './full-scan-resume'
import { isIndexManifest, type IndexManifest } from './index-manifest'
import { isPublicationId, PublicationArtifacts, publicationDatabaseFiles } from './publication-artifacts'

const LOCATION_ID = /^loc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const DECIMAL = /^(?:0|[1-9]\d*)$/u

export interface SavedLocationRecord {
  readonly id: string
  readonly target: string
  readonly targetDevice: string
  readonly targetInode: string
  readonly manifest: IndexManifest
}

export interface PendingScanRecord {
  readonly id: string
  readonly target: string
  readonly targetDevice: string
  readonly targetInode: string
  readonly resume: FullScanResumeDescriptor
}

export interface LocationCatalogDocument {
  readonly version: 1
  readonly locations: readonly SavedLocationRecord[]
  readonly pendingScan: PendingScanRecord | null
}

export interface LocationCatalogPaths {
  readonly partialPath: string
  readonly indexPath: string
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
      const stat = await lstat(this.catalogPath)
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined
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
    } catch { /* Rename is the commit point; retain both recovery generations. */ }
  }

  referencedIndexFiles(document: LocationCatalogDocument): readonly string[] {
    if (!isLocationCatalogDocument(document)) throw new Error('Invalid Orbis location catalog')
    return referencedIndexFiles(document)
  }

  build(locations: readonly SavedLocationRecord[] = [], pendingScan: PendingScanRecord | null = null): LocationCatalogDocument {
    const document = { version: 1 as const, locations: [...locations], pendingScan }
    if (!isLocationCatalogDocument(document)) throw new Error('Invalid Orbis location catalog')
    return document
  }

  migrate(manifest: IndexManifest | undefined, resume: FullScanResumeDescriptor | undefined, initialTarget?: string): LocationCatalogDocument {
    return migrateLocationCatalog(manifest, resume, initialTarget)
  }
}

export function createLocationId(): string { return `loc-${randomUUID()}` }

export function buildSavedLocation(manifest: IndexManifest, id = createLocationId()): SavedLocationRecord {
  return { id, target: manifest.target, targetDevice: manifest.targetDevice, targetInode: manifest.targetInode, manifest }
}

export function buildPendingScan(resume: FullScanResumeDescriptor, id = createLocationId()): PendingScanRecord {
  return { id, target: resume.target, targetDevice: resume.targetDevice, targetInode: resume.targetInode, resume }
}

export function migrateLocationCatalog(manifest?: IndexManifest, resume?: FullScanResumeDescriptor, initialTarget?: string): LocationCatalogDocument {
  const locations = manifest && isIndexManifest(manifest) ? [buildSavedLocation(manifest)] : []
  let pendingScan: PendingScanRecord | null = resume ? buildPendingScan(resume) : null
  if (!pendingScan && initialTarget !== undefined && locations.length === 0) {
    // An initial target has no durable identity yet and therefore cannot be
    // persisted as a location. Canonicalise it here so callers can compare it.
    canonicalPath(initialTarget)
  }
  return { version: 1, locations, pendingScan }
}

export function referencedIndexFiles(document: LocationCatalogDocument): readonly string[] {
  const files = new Set<string>()
  for (const location of document.locations) files.add(location.manifest.indexFile)
  if (document.pendingScan) {
    files.add(document.pendingScan.resume.partialFile)
    files.add(document.pendingScan.resume.candidateFile)
  }
  return [...files]
}

export function isLocationCatalogDocument(value: unknown): value is LocationCatalogDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as Partial<LocationCatalogDocument>
  if (document.version !== 1 || !Array.isArray(document.locations)) return false
  if (document.pendingScan !== null && !isPending(document.pendingScan)) return false
  const ids = new Set<string>(); const targets = new Set<string>(); const identities = new Set<string>()
  for (const location of document.locations) {
    if (!isSaved(location) || ids.has(location.id) || targets.has(location.target)) return false
    const identity = `${location.targetDevice}:${location.targetInode}`
    if (identities.has(identity)) return false
    ids.add(location.id); targets.add(location.target); identities.add(identity)
  }
  if (document.pendingScan && (ids.has(document.pendingScan.id) || targets.has(document.pendingScan.target) || identities.has(`${document.pendingScan.targetDevice}:${document.pendingScan.targetInode}`))) return false
  return true
}

function isSaved(value: unknown): value is SavedLocationRecord {
  if (!isRecord(value) || !validCommon(value) || !isIndexManifest(value.manifest)) return false
  return value.manifest.target === value.target && value.manifest.targetDevice === value.targetDevice && value.manifest.targetInode === value.targetInode
}

function isPending(value: unknown): value is PendingScanRecord {
  if (!isRecord(value) || !validCommon(value) || !isRecord(value.resume)) return false
  const resume = value.resume
  if (resume.version !== 1 || !isPublicationId(resume.scanId)) return false
  const files = publicationDatabaseFiles(resume.scanId)
  return resume.partialFile === files.partialFile && resume.candidateFile === files.candidateFile && resume.target === value.target && resume.targetDevice === value.targetDevice && resume.targetInode === value.targetInode
}

function validCommon(value: Record<string, unknown>): boolean {
  return typeof value.id === 'string' && LOCATION_ID.test(value.id) && typeof value.target === 'string' && canonicalPath(value.target) === value.target && decimal(value.targetDevice) && decimal(value.targetInode)
}
function canonicalPath(value: unknown): string | undefined { return typeof value === 'string' && !value.includes('\0') && isAbsolute(value) && normalize(value) === value ? value : undefined }
function decimal(value: unknown): boolean { return typeof value === 'string' && DECIMAL.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
