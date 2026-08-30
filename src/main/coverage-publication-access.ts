import { lstat } from 'node:fs/promises'
import { basename, join, normalize, relative, resolve, sep } from 'node:path'
import type { LocationId, Breadcrumb, NodeSummary } from '../shared/contracts'
import { measureController, measureControllerAsync } from './diagnostics'
import type { DatabaseNode } from './database'
import { DiskIndex, type ChartDataSource, type LocationIndexView } from './index-store'
import {
  EXCLUSION_POLICY_VERSION,
  HARD_LINK_ORDERING_VERSION,
  PERSISTENT_ACCOUNTING_VERSION,
  PERSISTENT_INDEX_SCHEMA_VERSION,
  type IndexManifest,
  type JournalCursor
} from './index-manifest'
import type {
  CatalogScanOwnership,
  LocationCatalogDocument,
  LocationCatalogStore,
  ResolvedLocationTarget,
  SavedLocationRecord
} from './location-catalog'
import type { PublicationArtifacts } from './publication-artifacts'
import type { FolderSizeEstimate } from './scan-metadata'
import type { ScanResult } from './scanner'

export interface InstalledLocationAccess extends ChartDataSource {
  readonly locationId: LocationId
  readonly logicalTarget: string
  readonly publicationTarget: string
  readonly artifactPath: string
  readonly rootId: string
  readonly root: DatabaseNode
  readonly metadata: Readonly<Record<string, string>>
  readonly estimate: FolderSizeEstimate

  publication(): IndexManifest | null
  getNodeByPath(path: string): DatabaseNode | undefined
  getLargestItems(id: string): readonly NodeSummary[]
  getBreadcrumbs(id: string): readonly Breadcrumb[]
  resolvePath(id: string): string | undefined
}

export interface CoverageDiscovery { readonly publicationId: string | null }

export interface PersistentPublicationCandidate {
  readonly kind: 'persistent'
  readonly result: ScanResult
  readonly expectedPath: string
  readonly ownership: CatalogScanOwnership
  readonly journal: JournalCursor | null
}

export interface TransientReferenceCandidate {
  readonly kind: 'transient-reference'
  readonly result: ScanResult
  readonly expectedPath: string
  readonly ownership: CatalogScanOwnership
}

export type PublicationCandidate = PersistentPublicationCandidate | TransientReferenceCandidate

export type PublicationCandidateDisposition = 'discarded' | 'catalog-owned' | 'cleanup-pending'

export type PublicationInstallResult =
  | {
      readonly kind: 'installed'
      readonly persistence: 'catalog' | 'transient'
      readonly access: InstalledLocationAccess
      readonly durability: 'durable' | 'uncertain' | 'not-applicable'
      readonly cleanupPending: boolean
      readonly warnings: readonly string[]
    }
  | {
      readonly kind: 'stale'
      readonly candidateDisposition: PublicationCandidateDisposition
    }

export interface CoveragePublicationAccess {
  selectAndRepair(locationId: LocationId): Promise<InstalledLocationAccess | undefined>
  discoverCoverage(identity: ResolvedLocationTarget): Promise<CoverageDiscovery>
  publishAndInstall(candidate: PublicationCandidate, selectedLocationId: LocationId): Promise<PublicationInstallResult>
  current(): InstalledLocationAccess | undefined
  close(): Promise<void>
}

export type CoverageAccessErrorCode = 'closed' | 'invalid-candidate' | 'stale-operation'

export class CoverageAccessError extends Error {
  constructor(readonly code: CoverageAccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CoverageAccessError'
  }
}

interface InstalledState {
  readonly index: DiskIndex
  readonly access: InstalledAccess
  readonly transient: boolean
}

interface Probe {
  readonly index: DiskIndex
  readonly view: LocationIndexView
  readonly manifest: IndexManifest
}

class InstalledAccess implements InstalledLocationAccess {
  readonly rootId: string
  readonly root: DatabaseNode
  readonly metadata: Readonly<Record<string, string>>
  readonly estimate: FolderSizeEstimate

  constructor(
    readonly locationId: LocationId,
    readonly logicalTarget: string,
    readonly publicationTarget: string,
    readonly artifactPath: string,
    private readonly publicationId: string | null,
    private readonly catalog: LocationCatalogStore,
    private readonly view: LocationIndexView,
    index: DiskIndex
  ) {
    this.rootId = view.rootId
    this.root = view.root
    this.metadata = Object.freeze({ ...index.metadata })
    const publicationRoot = index.root
    this.estimate = Object.freeze({
      items: Object.freeze(publicationRoot
        ? index.getChildren(publicationRoot.id, 400).map((child) => Object.freeze({ name: child.name, estimatedBytes: child.sizeBytes }))
        : [])
    })
  }

  publication(): IndexManifest | null {
    if (!this.publicationId) return null
    return this.catalog.current.publications.find((item) => item.publicationId === this.publicationId) ?? null
  }

  getNode(id: string): DatabaseNode | undefined { return this.view.getNode(id) }
  getNodeByPath(path: string): DatabaseNode | undefined { return this.view.getNodeByPath(path) }
  getChildren(id: string, limit: number): readonly DatabaseNode[] { return this.view.getChildren(id, limit) }
  countChildren(id: string): number { return this.view.countChildren(id) }
  getEstimatedRemainder(id: string): number { return this.view.getEstimatedRemainder(id) }
  getLargestItems(id: string): readonly NodeSummary[] { return this.view.getLargestItems(id) }
  getBreadcrumbs(id: string): readonly Breadcrumb[] { return this.view.getBreadcrumbs(id) }
  resolvePath(id: string): string | undefined { return this.view.resolvePath(id) }
}

class CoveragePublicationAccessImpl implements CoveragePublicationAccess {
  readonly #directory: string
  #installed: InstalledState | undefined
  #retired: InstalledState[] = []
  #tail: Promise<void> = Promise.resolve()
  #closed = false

  constructor(
    directory: string,
    private readonly catalog: LocationCatalogStore,
    private readonly artifacts: PublicationArtifacts
  ) {
    this.#directory = resolve(directory)
  }

  current(): InstalledLocationAccess | undefined {
    const installed = this.#installed
    if (!installed || this.#closed) return undefined
    let selected: LocationId
    try { selected = this.catalog.current.selectedLocationId } catch { return undefined }
    return installed.access.locationId === selected ? installed.access : undefined
  }

  selectAndRepair(locationId: LocationId): Promise<InstalledLocationAccess | undefined> {
    return this.#serialized(async () => {
      this.#assertOpen()
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const snapshot = this.catalog.current
        const location = snapshot.locations.find((item) => item.id === locationId)
        if (!location) throw new CoverageAccessError('stale-operation', 'The selected saved location no longer exists')
        if (snapshot.selectedLocationId !== locationId) throw new CoverageAccessError('stale-operation', 'The saved location is no longer selected')
        const probe = await this.#probeCoverage(snapshot, location)
        if (this.catalog.current.revision !== snapshot.revision) {
          closeQuietly(probe?.index)
          if (attempt === 0) continue
          throw new CoverageAccessError('stale-operation', 'The location catalog changed while coverage was being checked')
        }
        const publicationId = probe?.manifest.publicationId ?? null
        try {
          if (location.publicationId !== publicationId) await this.catalog.repairLocationCoverage(location.id, publicationId)
        } catch (error) {
          closeQuietly(probe?.index)
          if (this.catalog.current.selectedLocationId === locationId) await this.#clearInstalled()
          throw error
        }
        if (this.catalog.current.selectedLocationId !== locationId) {
          closeQuietly(probe?.index)
          if (attempt === 0) continue
          throw new CoverageAccessError('stale-operation', 'The selected location changed while coverage was being repaired')
        }
        if (!probe) {
          await this.#replaceInstalled(undefined)
          return undefined
        }
        const next = this.#stateFor(probe.index, probe.view, location, probe.manifest.publicationId, false)
        await this.#replaceInstalled(next)
        return next.access
      }
      throw new CoverageAccessError('stale-operation', 'Coverage selection became stale')
    })
  }

  discoverCoverage(identity: ResolvedLocationTarget): Promise<CoverageDiscovery> {
    return this.#serialized(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const snapshot = this.catalog.current
        const probe = await this.#probeCoverage(snapshot, identity)
        const publicationId = probe?.manifest.publicationId ?? null
        closeQuietly(probe?.index)
        if (this.catalog.current.revision === snapshot.revision) return { publicationId }
        if (attempt === 1) throw new CoverageAccessError('stale-operation', 'The location catalog changed while coverage was being discovered')
      }
      return { publicationId: null }
    })
  }

  publishAndInstall(candidate: PublicationCandidate, selectedLocationId: LocationId): Promise<PublicationInstallResult> {
    return this.#serialized(async () => {
      this.#assertOpen()
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = await this.#publishAttempt(candidate, selectedLocationId)
        if (outcome !== 'retry') return outcome
      }
      return this.#discardStale(candidate)
    })
  }

  close(): Promise<void> {
    return this.#serialized(async () => {
      if (this.#closed) return
      this.#closed = true
      await this.#clearInstalled()
    }, true)
  }

  async #publishAttempt(candidate: PublicationCandidate, selectedLocationId: LocationId): Promise<PublicationInstallResult | 'retry'> {
    const { result, ownership } = candidate
    const snapshot = this.catalog.current
    if (!candidateFactsMatch(candidate, this.#directory) || !pendingMatches(snapshot, ownership)
      || snapshot.pendingScan?.target !== result.target || snapshot.selectedLocationId !== selectedLocationId) {
      return this.#discardStale(candidate)
    }
    const owner = snapshot.locations.find((item) => item.id === ownership.locationId)
    const selected = snapshot.locations.find((item) => item.id === selectedLocationId)
    if (!owner || !selected) return this.#discardStale(candidate)

    let index: DiskIndex | undefined
    let committed = false
    try {
      index = measureController(result.generation, 'index-open', () => new DiskIndex(result.publishedPath))
      validateResultIdentity(index, result)
      const selectedView = index.openLocationView(selected.target, identityOf(selected))
      if (!selectedView) throw new CoverageAccessError('invalid-candidate', 'The selected location is not present in the candidate index')
      if (!index.openLocationView(owner.target, identityOf(owner))) throw new CoverageAccessError('invalid-candidate', 'The scanned location is not present in the candidate index')

      if (candidate.kind === 'transient-reference') {
        if (this.catalog.current.revision !== snapshot.revision || !pendingMatches(this.catalog.current, ownership)) {
          closeQuietly(index); index = undefined
          return 'retry'
        }
        const next = this.#stateFor(index, selectedView, selected, null, true)
        await this.catalog.clearPendingScan(ownership.scanId, { expectedRevision: snapshot.revision, selectedLocationId })
        committed = true
        index = undefined
        const warnings = await this.#replaceInstalled(next, result.generation)
        return { kind: 'installed', persistence: 'transient', access: next.access, durability: 'not-applicable', cleanupPending: warnings.length > 0, warnings }
      }

      validatePersistentMetadata(index)
      if (!await indexDirectoryIdentityIsCompatible(index, this.#directory)) throw new CoverageAccessError('invalid-candidate', 'The scan worker returned an index for another index directory')
      const manifest = manifestFor(candidate, index)
      if (!await targetIdentityIsCompatible(manifest)) throw new CoverageAccessError('invalid-candidate', 'The publication target identity changed')
      const coveredLocationIds = snapshot.locations
        .filter((location) => index!.openLocationView(location.target, identityOf(location)))
        .map((location) => location.id)
      if (this.catalog.current.revision !== snapshot.revision || !pendingMatches(this.catalog.current, ownership)) {
        closeQuietly(index); index = undefined
        return 'retry'
      }
      const next = this.#stateFor(index, selectedView, selected, manifest.publicationId, false)
      const commit = await measureControllerAsync(result.generation, 'manifest-publish', () => this.catalog.commitPublication(
        manifest,
        coveredLocationIds,
        { ...ownership, expectedRevision: snapshot.revision, selectedLocationId }
      ))
      committed = true
      index = undefined
      const warnings = await this.#replaceInstalled(next, result.generation)
      return {
        kind: 'installed', persistence: 'catalog', access: next.access, durability: commit.durability,
        cleanupPending: commit.cleanupPending || warnings.length > 0, warnings
      }
    } catch (error) {
      closeQuietly(index)
      if (committed) throw new CoverageAccessError('stale-operation', 'Publication committed but active installation failed', { cause: error })
      if (isStaleCatalogError(error, snapshot, this.catalog.current) && this.catalog.current.revision !== snapshot.revision) return 'retry'
      await this.#cleanupRejectedCandidate(candidate)
      throw error
    }
  }

  async #probeCoverage(document: LocationCatalogDocument, identity: ResolvedLocationTarget): Promise<Probe | undefined> {
    const candidates = document.publications
      .filter((item) => isWithinPath(identity.target, item.target))
      .sort((left, right) => pathDepth(right.target) - pathDepth(left.target) || left.publicationId.localeCompare(right.publicationId))
    for (const manifest of candidates) {
      let index: DiskIndex | undefined
      try {
        index = new DiskIndex(join(this.#directory, manifest.indexFile))
        if (!matchesManifest(index, manifest) || !await targetIdentityIsCompatible(manifest)) {
          index.close(); index = undefined; continue
        }
        const view = index.openLocationView(identity.target, { device: identity.targetDevice, inode: identity.targetInode })
        if (!view) { index.close(); index = undefined; continue }
        return { index, view, manifest }
      } catch { closeQuietly(index) }
    }
    return undefined
  }

  #stateFor(index: DiskIndex, view: LocationIndexView, location: SavedLocationRecord, publicationId: string | null, transient: boolean): InstalledState {
    return {
      index,
      transient,
      access: new InstalledAccess(location.id, location.target, index.target, index.path, publicationId, this.catalog, view, index)
    }
  }

  async #replaceInstalled(next: InstalledState | undefined, generation?: number): Promise<string[]> {
    const previous = this.#installed
    this.#installed = next
    const retiring = [...this.#retired]
    this.#retired = []
    if (previous && previous !== next) retiring.push(previous)
    const warnings: string[] = []
    for (const state of retiring) {
      let closed = false
      try {
        const close = async (): Promise<void> => { state.index.close() }
        if (generation === undefined) await close()
        else await measureControllerAsync(generation, 'previous-index-cleanup', close)
        closed = true
      } catch (error) {
        this.#retired.push(state)
        warnings.push(messageFor(error, 'Unable to close the previous index'))
      }
      if (closed && state.transient) {
        try { await this.artifacts.discardUnreferencedDatabase(state.index.path) }
        catch (error) { warnings.push(messageFor(error, 'Unable to retire the previous reference index')) }
      }
    }
    return warnings
  }

  async #clearInstalled(): Promise<void> { await this.#replaceInstalled(undefined) }

  async #cleanupRejectedCandidate(candidate: PublicationCandidate): Promise<'discarded' | 'catalog-owned' | 'cleanup-pending'> {
    try {
      const discarded = await this.artifacts.discardUnreferencedDatabase(candidate.result.publishedPath)
      return discarded ? 'discarded' : 'catalog-owned'
    } catch { return 'cleanup-pending' }
  }

  async #discardStale(candidate: PublicationCandidate): Promise<PublicationInstallResult> {
    return { kind: 'stale', candidateDisposition: await this.#cleanupRejectedCandidate(candidate) }
  }

  #assertOpen(): void {
    if (this.#closed) throw new CoverageAccessError('closed', 'Coverage publication access is closed')
  }

  #serialized<T>(operation: () => Promise<T>, allowClosed = false): Promise<T> {
    const result = this.#tail.then(() => {
      if (!allowClosed) this.#assertOpen()
      return operation()
    }, () => {
      if (!allowClosed) this.#assertOpen()
      return operation()
    })
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}

export function createCoveragePublicationAccess(
  indexesDirectory: string,
  catalog: LocationCatalogStore,
  artifacts: PublicationArtifacts
): CoveragePublicationAccess {
  return new CoveragePublicationAccessImpl(indexesDirectory, catalog, artifacts)
}

function candidateFactsMatch(candidate: PublicationCandidate, directory: string): boolean {
  const expected = resolve(candidate.expectedPath)
  const actual = resolve(candidate.result.publishedPath)
  const expectedName = `index-${candidate.ownership.scanId}.sqlite`
  return candidate.result.target.length > 0 && actual === expected
    && relative(directory, actual) === expectedName && basename(actual) === expectedName
}

function pendingMatches(document: LocationCatalogDocument, ownership: CatalogScanOwnership): boolean {
  const pending = document.pendingScan
  return !!pending && pending.scanId === ownership.scanId && pending.locationId === ownership.locationId
    && pending.basePublicationId === ownership.basePublicationId && pending.target.length > 0
}

function validateResultIdentity(index: DiskIndex, result: ScanResult): void {
  if (index.target !== normalize(result.target) || index.rootId !== result.rootId) {
    throw new CoverageAccessError('invalid-candidate', 'The scan worker returned an index for another target')
  }
}

function validatePersistentMetadata(index: DiskIndex): void {
  const metadata = index.metadata
  if (positiveInteger(metadata.schemaVersion) !== PERSISTENT_INDEX_SCHEMA_VERSION
    || !positiveInteger(metadata.indexRevision)
    || !decimalString(metadata.targetDevice)
    || !decimalString(metadata.targetInode)
    || metadata.accountingVersion !== PERSISTENT_ACCOUNTING_VERSION
    || metadata.exclusionPolicyVersion !== EXCLUSION_POLICY_VERSION
    || metadata.hardLinkOrderingVersion !== HARD_LINK_ORDERING_VERSION) {
    throw new CoverageAccessError('invalid-candidate', 'The scan worker returned an incompatible persistent index')
  }
}

function manifestFor(candidate: PersistentPublicationCandidate, index: DiskIndex): IndexManifest {
  const metadata = index.metadata
  return {
    version: 1,
    publicationId: candidate.ownership.scanId,
    indexFile: basename(index.path),
    target: index.target,
    targetDevice: decimalString(metadata.targetDevice)!,
    targetInode: decimalString(metadata.targetInode)!,
    schemaVersion: positiveInteger(metadata.schemaVersion)!,
    indexRevision: positiveInteger(metadata.indexRevision)!,
    journal: candidate.journal
  }
}

function matchesManifest(index: DiskIndex, manifest: IndexManifest): boolean {
  const metadata = index.metadata
  return index.target === manifest.target
    && metadata.schemaVersion === String(manifest.schemaVersion)
    && metadata.indexRevision === String(manifest.indexRevision)
    && metadata.targetDevice === manifest.targetDevice
    && metadata.targetInode === manifest.targetInode
    && metadata.accountingVersion === PERSISTENT_ACCOUNTING_VERSION
    && metadata.exclusionPolicyVersion === EXCLUSION_POLICY_VERSION
    && metadata.hardLinkOrderingVersion === HARD_LINK_ORDERING_VERSION
}

async function targetIdentityIsCompatible(manifest: IndexManifest): Promise<boolean> {
  try {
    const stats = await lstat(manifest.target)
    return stats.isDirectory() && !stats.isSymbolicLink() && String(stats.dev) === manifest.targetDevice && String(stats.ino) === manifest.targetInode
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM' || code === 'EIO' || code === 'ENXIO'
  }
}

async function indexDirectoryIdentityIsCompatible(index: DiskIndex, directory: string): Promise<boolean> {
  try {
    const stats = await lstat(directory)
    return stats.isDirectory() && !stats.isSymbolicLink() && index.metadata.indexDirectoryIdentity === `${String(stats.dev)}:${String(stats.ino)}`
  } catch { return false }
}

function identityOf(location: SavedLocationRecord): { readonly device: string; readonly inode: string } {
  return { device: location.targetDevice, inode: location.targetInode }
}

function isWithinPath(path: string, parent: string): boolean {
  const child = normalize(path)
  const root = normalize(parent)
  const remainder = relative(root, child)
  return child === root || remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`)
}

function pathDepth(path: string): number { return normalize(path).split(sep).filter(Boolean).length }
function positiveInteger(value: unknown): number | undefined { const number = Number(value); return Number.isSafeInteger(number) && number >= 1 ? number : undefined }
function decimalString(value: unknown): string | undefined { return typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) ? value : undefined }
function errorCode(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined }
function closeQuietly(index: DiskIndex | undefined): void { try { index?.close() } catch { /* The original failure remains authoritative. */ } }
function messageFor(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback }
function isStaleCatalogError(error: unknown, before: LocationCatalogDocument, after: LocationCatalogDocument): boolean {
  return after.revision !== before.revision && error instanceof Error
}
