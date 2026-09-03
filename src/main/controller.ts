import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import type { LocationId, NodeKind, OrbisSnapshot, SizeAccuracy } from '../shared/contracts'
import { measureController } from './diagnostics'
import { FullScanResumeStore } from './full-scan-resume'
import { createCoveragePublicationAccess, type CoveragePublicationAccess, type InstalledLocationAccess } from './coverage-publication-access'
import { LocationCatalogStore, createEmptyCatalog, createLocationId, uniqueDisplayName, type LocationCatalogDocument, type SavedLocationRecord } from './location-catalog'
import { IndexManifestStore, type IndexManifest } from './index-manifest'
import type { FolderSizeEstimate } from './scan-metadata'
import type { ScanExecution } from './scan-execution'
import type { PublicationArtifacts } from './publication-artifacts'
import { createScanLifecycleDependencies } from './scan-start-adapters'
import { ScanRunLifecycle } from './scan-run-lifecycle'
import { errorCode, isMissingPath, isWithinPath, resolveTarget, validateNodeActionPath } from './scan-target'
import type { ScanTotals } from './scanner'
import { projectSnapshotView, type SnapshotVolumeFacts } from './snapshot-projection'

export interface OrbisDialog { showOpenDialog(options: { readonly properties: Array<'openDirectory'> }): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }> }
export interface OrbisShell {
  showItemInFolder(path: string): void
  quickLook(path: string): void
  openInTerminal(directory: string): Promise<void>
  openExternal(url: string): Promise<void>
}
export type OrbisNodeAction = 'quick-look' | 'show-in-finder' | 'open-in-terminal'

export interface OrbisControllerOptions {
  /** The feature stores its private persistent index here. It must be the feature's indexes directory. */
  readonly indexDirectory?: string
  /** When supplied, indexes are stored at `${dataDirectory}/indexes`. */
  readonly dataDirectory?: string
  readonly initialTarget?: string
  readonly dialog?: OrbisDialog
  readonly shell?: OrbisShell
}

const EMPTY_TOTALS: ScanTotals = {
  scannedItems: 0,
  discoveredBytes: 0,
  elapsedMs: 0,
  skippedItems: 0,
  unreadableItems: 0,
  nestedMounts: 0,
  symlinks: 0,
  duplicateHardLinks: 0,
  disappearingItems: 0
}

export class OrbisController {
  readonly indexDirectory: string
  readonly #artifacts: PublicationArtifacts
  readonly #estimateCache: FolderEstimateCache
  readonly #manifestStore: IndexManifestStore
  readonly #catalogStore: LocationCatalogStore
  readonly #resumeStore: FullScanResumeStore
  readonly #explicitInitialTarget: boolean
  readonly #initialTarget: string
  readonly #coverageAccess: CoveragePublicationAccess
  readonly #lifecycle: ScanRunLifecycle
  #initialization: Promise<void> | undefined
  #focusId: string | undefined
  #listeners = new Set<(snapshot: OrbisSnapshot) => void>()
  #dialog: OrbisDialog | undefined
  #shell: OrbisShell | undefined

  constructor(
    private readonly scanExecution: ScanExecution,
    options: OrbisControllerOptions
  ) {
    const dataDirectory = options.dataDirectory ? resolve(options.dataDirectory) : undefined
    if (!options.indexDirectory && !dataDirectory) throw new Error('Orbis requires a writable data directory')
    this.indexDirectory = resolve(options.indexDirectory ?? join(dataDirectory!, 'indexes'))
    this.#estimateCache = new FolderEstimateCache(join(this.indexDirectory, 'folder-estimates.json'))
    this.#manifestStore = new IndexManifestStore(this.indexDirectory)
    this.#catalogStore = new LocationCatalogStore(this.indexDirectory)
    this.#artifacts = this.#catalogStore.artifacts
    this.#coverageAccess = createCoveragePublicationAccess(this.indexDirectory, this.#catalogStore, this.#artifacts)
    this.#resumeStore = new FullScanResumeStore(this.indexDirectory)
    this.#explicitInitialTarget = options.initialTarget !== undefined || process.env.ORBIS_SCAN_ROOT !== undefined
    this.#initialTarget = normalize(resolve(options.initialTarget ?? process.env.ORBIS_SCAN_ROOT ?? '/'))
    this.#dialog = options.dialog
    this.#shell = options.shell

    this.#lifecycle = new ScanRunLifecycle(createScanLifecycleDependencies({
      indexDirectory: this.indexDirectory,
      scanExecution: this.scanExecution,
      ensureInitialized: () => this.initialize(),
      resumeStore: this.#resumeStore,
      catalogStore: this.#catalogStore,
      coverageAccess: this.#coverageAccess,
      estimateCache: this.#estimateCache,
      artifacts: this.#artifacts,
      focus: {
        currentId: () => this.#focusId,
        resolvePath: (id) => this.#coverageAccess.current()?.resolvePath(id),
        restore: (access, previousFocusId, previousFocusPath) => {
          const restored = restoreFocus(access, previousFocusId, previousFocusPath)
          this.#focusId = restored
          return restored
        }
      }
    }), this.#initialTarget)
    this.#lifecycle.subscribe((transition) => {
      if (transition.kind !== 'completed') {
        this.#emit()
        return
      }
      const snapshot = measureController(transition.generation, 'snapshot-total', () => this.#buildSnapshot(transition.generation))
      if (!this.#lifecycle.state.sealed) measureController(transition.generation, 'listener-notify', () => this.#emit(snapshot))
    })
  }

  initialize(): Promise<void> {
    this.#initialization ??= this.#initializePersistentIndex()
    return this.#initialization
  }

  subscribe(listener: (snapshot: OrbisSnapshot) => void): () => void {
    if (this.#lifecycle.state.sealed) return () => undefined
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  snapshot(): OrbisSnapshot { return this.#buildSnapshot() }

  get #catalog(): LocationCatalogDocument | undefined {
    try { return this.#catalogStore.current } catch { return undefined }
  }

  #buildSnapshot(diagnosticGeneration?: number): OrbisSnapshot {
    const catalog = this.#catalog
    if (!catalog) throw new Error('Orbis is not initialized')
    const selected = catalog.locations.find((item) => item.id === catalog.selectedLocationId)!
    const locations = catalog.locations.map((item) => ({
      id: item.id,
      name: item.displayName,
      coverage: item.publicationId === null
        ? 'none' as const
        : this.#publication(item.publicationId)?.target === item.target ? 'direct' as const : 'ancestor' as const
    })) as unknown as OrbisSnapshot['locations']
    const lifecycle = this.#lifecycle.state
    const scan = {
      ...lifecycle.scanStatus,
      locationId: lifecycle.run?.locationId ?? catalog.pendingScan?.locationId ?? selected.id,
      ...(lifecycle.resume ? { resume: lifecycle.resume } : {})
    }
    const preview = lifecycle.preview
    const activityTarget = lifecycle.run?.target ?? catalog.pendingScan?.target
    const previewVisible = preview && scan.locationId === selected.id && activityTarget === selected.target
    if (previewVisible) return {
      version: 4,
      committed: false,
      selectedLocationId: selected.id,
      locations,
      target: { name: selected.displayName, isStartup: selected.target === '/' },
      focus: preview.focus,
      breadcrumbs: preview.breadcrumbs,
      chart: preview.chart,
      largestItems: preview.largestItems,
      volume: preview.volume,
      scan
    }
    const timed = <T>(phase: string, operation: () => T): T => diagnosticGeneration === undefined ? operation() : measureController(diagnosticGeneration, phase, operation)
    const active = this.#coverageAccess.current()
    const totals = active ? parseTotals(active.metadata.totals) : null
    const root = timed('snapshot-root-query', () => active?.root)
    const target = { name: root?.name ?? selected.displayName, isStartup: selected.target === '/' }
    const volumeFacts = active ? parseVolumeFacts(active.metadata.volume, root?.sizeBytes ?? 0, root?.sizeAccuracy ?? 'partial') : undefined
    const projection = timed('snapshot-projection-query', () => active && this.#focusId && volumeFacts ? projectSnapshotView({
      source: active,
      rootId: active.rootId,
      focusId: this.#focusId,
      target,
      volume: volumeFacts
    }) : undefined)
    return {
      version: 4,
      committed: !!active,
      selectedLocationId: selected.id,
      locations,
      target: projection?.target ?? target,
      focus: projection?.focus ?? null,
      breadcrumbs: projection?.breadcrumbs ?? [],
      chart: projection?.chart ?? [],
      largestItems: projection?.largestItems ?? [],
      volume: projection?.volume ?? emptyVolume(),
      scan: { ...scan, totals: scan.status === 'scanning' ? null : scan.totals ?? totals }
    }
  }

  #publication(id: string): IndexManifest | undefined { return this.#catalog?.publications.find((item) => item.publicationId === id) }

  async startScan(): Promise<OrbisSnapshot> {
    await this.initialize()
    return this.#startScanAt(this.#selectedLocation().target)
  }

  async rescan(): Promise<OrbisSnapshot> {
    await this.initialize()
    const pending = this.#catalog!.pendingScan
    if (pending) {
      if (this.#catalog!.selectedLocationId !== pending.locationId) await this.selectLocation(pending.locationId)
      return this.#startScanAt(pending.target)
    }
    const location = this.#selectedLocation()
    const publication = location.publicationId ? this.#publication(location.publicationId) : undefined
    return this.#startScanAt(publication?.target ?? location.target)
  }

  async addLocation(): Promise<OrbisSnapshot> {
    if (!this.#dialog) throw new Error('Folder selection is unavailable')
    const result = await this.#dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return this.snapshot()
    await this.initialize()
    if (this.#lifecycle.state.run) throw new Error('Pause the current scan before adding another location')
    const identity = await resolveTarget(result.filePaths[0])
    const catalog = this.#catalog!
    const existing = catalog.locations.find((item) => item.target === identity.target)
    if (existing) {
      if (existing.targetDevice === identity.targetDevice && existing.targetInode === identity.targetInode) return this.selectLocation(existing.id)
      const changed = { ...existing, ...identity, publicationId: null }
      if (catalog.pendingScan) throw new Error('Complete or discard the saved scan before scanning another location')
      await this.#catalogStore.replaceLocation(changed)
      const access = await this.#coverageAccess.selectAndRepair(changed.id)
      this.#focusId = access?.rootId
      return this.#startScanAt(changed.target)
    }
    const { publicationId } = await this.#coverageAccess.discoverCoverage(identity)
    if (publicationId === null && this.#catalog!.pendingScan) throw new Error('Complete or discard the saved scan before scanning another location')
    const location: SavedLocationRecord = { id: createLocationId(), ...identity, displayName: uniqueDisplayName(identity.target, this.#catalog!.locations), publicationId }
    await this.#catalogStore.addLocation(location)
    const access = await this.#coverageAccess.selectAndRepair(location.id)
    this.#focusId = access?.rootId
    if (publicationId === null) return this.#startScanAt(location.target)
    this.#emit()
    return this.snapshot()
  }

  async chooseFolder(): Promise<OrbisSnapshot> { return this.addLocation() }

  async selectLocation(id: LocationId): Promise<OrbisSnapshot> {
    await this.initialize()
    const location = this.#catalog!.locations.find((item) => item.id === id)
    if (!location) throw new Error('Unknown Orbis location')
    const run = this.#lifecycle.state.run
    if (run && run.locationId !== id) throw new Error('Pause the current scan before selecting another location')
    await this.#catalogStore.selectLocation(id)
    const access = await this.#coverageAccess.selectAndRepair(id)
    this.#focusId = access?.rootId
    this.#emit()
    return this.snapshot()
  }

  async removeLocation(id: LocationId): Promise<OrbisSnapshot> {
    await this.initialize()
    const catalog = this.#catalog!
    if (catalog.locations.length === 1) throw new Error('The last location cannot be removed')
    const run = this.#lifecycle.state.run
    if (catalog.pendingScan?.locationId === id || run?.locationId === id) throw new Error('The scan owner cannot be removed')
    if (!catalog.locations.some((item) => item.id === id)) throw new Error('Unknown Orbis location')
    await this.#catalogStore.removeLocation(id)
    const selected = this.#selectedLocation()
    const access = await this.#coverageAccess.selectAndRepair(selected.id)
    this.#focusId = access?.rootId
    this.#emit()
    return this.snapshot()
  }

  async cancelScan(): Promise<OrbisSnapshot> {
    await this.#lifecycle.pauseScan()
    return this.snapshot()
  }

  async discardSavedScan(): Promise<OrbisSnapshot> {
    await this.#lifecycle.discardSavedScan()
    return this.snapshot()
  }

  async focusNode(id: string): Promise<OrbisSnapshot> {
    const disposition = await this.#lifecycle.focusNode(id)
    if (disposition === 'applied') return this.snapshot()
    const active = this.#coverageAccess.current()
    if (!active) throw new Error('No completed scan is available')
    const node = active.getNode(id)
    if (!node) throw new Error('Unknown Orbis node')
    if (node.kind !== 'directory') throw new Error('Only directories can become the chart root')
    this.#focusId = node.id
    this.#emit()
    return this.snapshot()
  }

  async revealNode(id: string): Promise<void> {
    await this.performNodeAction(id, 'show-in-finder')
  }

  async performNodeAction(id: string, action: OrbisNodeAction): Promise<void> {
    if (!this.#shell) throw new Error('Native item actions are unavailable')
    const focusedFolderId = this.#lifecycle.state.preview?.focus.id ?? this.#focusId
    const selected = await this.#resolveValidatedNode(id)
    if (action === 'quick-look') {
      this.#shell.quickLook(selected.validatedPath)
      return
    }
    if (action === 'show-in-finder') {
      this.#shell.showItemInFolder(selected.validatedPath)
      return
    }
    if (selected.nodeKind === 'directory') {
      await this.#shell.openInTerminal(selected.validatedPath)
      return
    }
    if (!focusedFolderId) throw new Error('No focused folder is available')
    const focused = await this.#resolveValidatedNode(focusedFolderId)
    if (focused.nodeKind !== 'directory') throw new Error('The focused item is no longer a folder')
    await this.#shell.openInTerminal(focused.validatedPath)
  }

  async #resolveValidatedNode(id: string): Promise<{ readonly validatedPath: string; readonly nodeKind: NodeKind }> {
    const result = await this.#lifecycle.resolveNodePath(id)
    if (result.kind !== 'not-running') return result
    const active = this.#coverageAccess.current()
    if (!active) throw new Error('No completed scan is available')
    const node = active.getNode(id)
    const path = active.resolvePath(id)
    if (!node || !path) throw new Error('Unknown Orbis node')
    const validatedPath = await validateNodeActionPath(path, active.logicalTarget, node.kind)
    if (this.#coverageAccess.current() !== active) throw new Error('The scan changed before the item action could run')
    return { validatedPath, nodeKind: node.kind }
  }

  async openFullDiskAccess(): Promise<void> {
    if (!this.#shell) throw new Error('Full Disk Access settings are unavailable')
    await this.#shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity_Privacy.FullDiskAccess')
  }

  async close(): Promise<void> {
    if (this.#lifecycle.state.sealed) return
    await this.#lifecycle.seal(this.#initialization)
    await this.#coverageAccess.close().catch(() => undefined)
    this.#focusId = undefined
    await this.#catalogStore.reconcileArtifacts().catch(() => undefined)
    this.#listeners.clear()
  }

  async #initializePersistentIndex(): Promise<void> {
    await this.#catalogStore.initialize()
    let catalog: LocationCatalogDocument | undefined = this.#catalog
    const legacy = await this.#manifestStore.load()
    const peek = await this.#resumeStore.peek()
    const descriptor = peek.kind === 'construction' || peek.kind === 'candidate' || peek.kind === 'restart' ? peek.descriptor : undefined
    if (!catalog) {
      const identity = legacy
        ? { target: legacy.target, targetDevice: legacy.targetDevice, targetInode: legacy.targetInode }
        : descriptor
          ? { target: descriptor.target, targetDevice: descriptor.targetDevice, targetInode: descriptor.targetInode }
          : await resolveTarget(this.#initialTarget)
      catalog = createEmptyCatalog(identity)
      if (legacy) catalog = { ...catalog, locations: [{ ...catalog.locations[0]!, publicationId: legacy.publicationId }], publications: [legacy] }
      if (descriptor) {
        let owner = catalog.locations.find((item) => item.target === descriptor.target)
        if (!owner) {
          owner = { id: createLocationId(), target: descriptor.target, targetDevice: descriptor.targetDevice, targetInode: descriptor.targetInode, displayName: uniqueDisplayName(descriptor.target, catalog.locations), publicationId: null }
          catalog = { ...catalog, locations: [...catalog.locations, owner], selectedLocationId: owner.id }
        }
        catalog = { ...catalog, pendingScan: { scanId: descriptor.scanId, locationId: owner.id, target: descriptor.target, targetDevice: descriptor.targetDevice, targetInode: descriptor.targetInode, basePublicationId: owner.publicationId } }
      }
      catalog = (await this.#catalogStore.installInitial(catalog)).document
      await this.#artifacts.removeManifestMetadata().catch(() => undefined)
    }
    if (!catalog) throw new Error('Unable to initialize Orbis catalog')
    if (this.#explicitInitialTarget) {
      try {
        const explicit = await resolveTarget(this.#initialTarget)
        let location = catalog.locations.find((item) => item.target === explicit.target || item.targetDevice === explicit.targetDevice && item.targetInode === explicit.targetInode)
        if (!location) {
          const { publicationId } = await this.#coverageAccess.discoverCoverage(explicit)
          location = { id: createLocationId(), ...explicit, displayName: uniqueDisplayName(explicit.target, catalog.locations), publicationId }
          catalog = (await this.#catalogStore.addLocation(location)).document
        } else if (catalog.selectedLocationId !== location.id) catalog = (await this.#catalogStore.selectLocation(location.id)).document
      } catch (error) { if (!isMissingPath(error)) throw error }
    }
    let saved = await this.#resumeStore.load()
    if (saved.kind === 'candidate') {
      const candidate = saved
      if (catalog.publications.some((item) => item.publicationId === candidate.descriptor.scanId)) {
        await this.#resumeStore.complete(candidate.descriptor.scanId)
        saved = { kind: 'none' }
      }
    }
    if (saved.kind === 'construction' || saved.kind === 'candidate') {
      let owner = catalog.locations.find((item) => item.target === saved.descriptor.target)
      if (!owner) owner = { id: createLocationId(), target: saved.descriptor.target, targetDevice: saved.descriptor.targetDevice, targetInode: saved.descriptor.targetInode, displayName: uniqueDisplayName(saved.descriptor.target, catalog.locations), publicationId: null }
      catalog = (await this.#catalogStore.reconcileResume({ scanId: saved.descriptor.scanId, locationId: owner.id, target: saved.descriptor.target, targetDevice: saved.descriptor.targetDevice, targetInode: saved.descriptor.targetInode, basePublicationId: owner.publicationId }, owner)).document
    } else if (saved.kind === 'none' && catalog.pendingScan) {
      catalog = (await this.#catalogStore.clearPendingScan(catalog.pendingScan.scanId)).document
    } else if (saved.kind === 'restart' && saved.reason !== 'target-unavailable') {
      await this.#resumeStore.discard(saved.descriptor?.scanId)
      if (catalog.pendingScan) catalog = (await this.#catalogStore.clearPendingScan(catalog.pendingScan.scanId)).document
    }
    let selected = this.#selectedLocation()
    try {
      const live = await lstat(selected.target)
      if (!live.isDirectory() || live.isSymbolicLink() || String(live.dev) !== selected.targetDevice || String(live.ino) !== selected.targetInode) {
        catalog = (await this.#catalogStore.replaceLocation({ ...selected, targetDevice: String(live.dev), targetInode: String(live.ino), publicationId: null })).document
        selected = this.#selectedLocation()
      }
    } catch (error) {
      if (!isMissingPath(error) && errorCode(error) !== 'EACCES' && errorCode(error) !== 'EPERM' && errorCode(error) !== 'EIO' && errorCode(error) !== 'ENXIO') throw error
    }
    const access = await this.#coverageAccess.selectAndRepair(this.#selectedLocation().id)
    this.#focusId = access?.rootId
    await this.#catalogStore.reconcileArtifacts()
    await this.#lifecycle.adoptStartupState({ saved, selectedTarget: selected.target })
  }

  #selectedLocation(): SavedLocationRecord { return this.#catalog!.locations.find((item) => item.id === this.#catalog!.selectedLocationId)! }

  async #startScanAt(value: string): Promise<OrbisSnapshot> {
    if (!isAbsolute(value) || value.includes('\u0000')) throw new Error('Choose an absolute folder')
    const target = normalize(resolve(value))
    await this.#lifecycle.startScan({ target })
    return this.snapshot()
  }

  #emit(snapshot = this.snapshot()): void {
    for (const listener of this.#listeners) {
      try { listener(snapshot) } catch { /* A renderer listener must not break the lifecycle. */ }
    }
  }
}

function restoreFocus(next: InstalledLocationAccess, previousFocusId: string | undefined, previousFocusPath: string | undefined): string {
  if (previousFocusId) {
    const stable = next.getNode(previousFocusId)
    if (stable?.kind === 'directory') return stable.id
  }
  let path = previousFocusPath
  while (path && isWithinPath(path, next.logicalTarget)) {
    const node = next.getNodeByPath(path)
    if (node?.kind === 'directory') return node.id
    if (path === next.logicalTarget) break
    path = resolve(path, '..')
  }
  return next.rootId
}

interface EstimateCacheDocument {
  readonly version: 1
  readonly target: string
  readonly device: string
  readonly inode: string
  readonly capturedAt: string
  readonly estimate: FolderSizeEstimate
}

const ESTIMATE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000

class FolderEstimateCache {
  constructor(private readonly path: string) {}

  async load(target: string): Promise<FolderSizeEstimate | undefined> {
    try {
      const canonicalTarget = normalize(resolve(target))
      const stats = await lstat(canonicalTarget)
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!stats.isDirectory() || stats.isSymbolicLink() || !isEstimateCacheDocument(parsed)) return undefined
      const capturedAt = Date.parse(parsed.capturedAt)
      if (!Number.isFinite(capturedAt) || capturedAt > Date.now() + 60_000 || Date.now() - capturedAt > ESTIMATE_CACHE_MAX_AGE_MS) return undefined
      if (normalize(resolve(parsed.target)) !== canonicalTarget || parsed.device !== String(stats.dev) || parsed.inode !== String(stats.ino)) return undefined
      return parsed.estimate
    } catch { return undefined }
  }

  async store(target: string, estimate: FolderSizeEstimate): Promise<void> {
    const canonicalTarget = normalize(resolve(target))
    const stats = await lstat(canonicalTarget)
    if (!stats.isDirectory() || stats.isSymbolicLink()) return
    const document: EstimateCacheDocument = { version: 1, target: canonicalTarget, device: String(stats.dev), inode: String(stats.ino), capturedAt: new Date().toISOString(), estimate }
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }
}

function isEstimateCacheDocument(value: unknown): value is EstimateCacheDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as Partial<EstimateCacheDocument>
  const estimate = document.estimate
  return document.version === 1 && typeof document.target === 'string' && typeof document.device === 'string' && typeof document.inode === 'string' && typeof document.capturedAt === 'string'
    && !!estimate && Array.isArray(estimate.items) && estimate.items.length <= 400
    && estimate.items.every((item) => item && typeof item.name === 'string' && item.name.length <= 1024 && finiteNonnegative(item.estimatedBytes))
}

function finiteNonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }

function parseVolumeFacts(value: string | undefined, scannedBytes: number, sizeAccuracy: SizeAccuracy): SnapshotVolumeFacts {
  try {
    const parsed = JSON.parse(value ?? '{}') as { capacityBytes?: unknown; freeBytes?: unknown }
    return { capacityBytes: finite(parsed.capacityBytes), freeBytes: finite(parsed.freeBytes), scannedBytes, sizeAccuracy }
  } catch { return { capacityBytes: 0, freeBytes: 0, scannedBytes, sizeAccuracy } }
}

function emptyVolume(): OrbisSnapshot['volume'] { return { capacityBytes: 0, freeBytes: 0, scannedBytes: 0, unscannedBytes: 0, sizeAccuracy: 'partial' } }

function parseTotals(value: string | undefined): ScanTotals {
  try {
    const parsed = JSON.parse(value ?? 'null') as Partial<ScanTotals> | null
    if (!parsed) return EMPTY_TOTALS
    return { ...EMPTY_TOTALS, ...Object.fromEntries(Object.keys(EMPTY_TOTALS).map((key) => [key, finite(parsed[key as keyof ScanTotals])])) } as ScanTotals
  } catch { return EMPTY_TOTALS }
}

function finite(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0 }
