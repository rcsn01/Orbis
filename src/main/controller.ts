import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type { LocationId, OrbisSnapshot, ProgressSnapshot, SizeAccuracy } from '../shared/contracts'
import { buildChart } from './chart'
import { readConstructionPreview, resolveConstructionNodePath, type ConstructionResumeLoad } from './construction-preview'
import { createControllerTimingMilestones, measureController, measureControllerAsync, RESUME_PREPARATION_MESSAGES, type ControllerTimingMilestones } from './diagnostics'
import { FullScanResumeStore, type FullScanResumeLoad, type ResumeValidationReceipt } from './full-scan-resume'
import { DiskIndex, LocationIndexView, toSummary } from './index-store'
import { LocationCatalogStore, createEmptyCatalog, createLocationId, uniqueDisplayName, type LocationCatalogDocument, type SavedLocationRecord } from './location-catalog'
import {
  EXCLUSION_POLICY_VERSION, HARD_LINK_ORDERING_VERSION, IndexManifestStore, PERSISTENT_ACCOUNTING_VERSION,
  PERSISTENT_INDEX_SCHEMA_VERSION, type IndexManifest, type JournalCursor
} from './index-manifest'
import type { FolderSizeEstimate } from './scan-metadata'
import type { ScanExecution, ScanOutcome, ScanSession } from './scan-execution'
import type { PublicationArtifacts } from './publication-artifacts'
import type { ProgressivePreview, ScanResult, ScanTotals } from './scanner'

export interface OrbisDialog { showOpenDialog(options: { readonly properties: Array<'openDirectory'> }): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }> }
export interface OrbisShell { showItemInFolder(path: string): void; openExternal(url: string): Promise<void> }

export interface OrbisControllerOptions {
  /** The feature stores its private persistent index here. It must be the feature's indexes directory. */
  readonly indexDirectory?: string
  /** When supplied, indexes are stored at `${dataDirectory}/indexes`. */
  readonly dataDirectory?: string
  readonly initialTarget?: string
  readonly dialog?: OrbisDialog
  readonly shell?: OrbisShell
}

interface ScanRun {
  readonly generation: number
  readonly publicationId: string
  readonly locationId: LocationId
  readonly basePublicationId: string | null
  readonly target: string
  readonly partialPath: string
  readonly publishedPath: string
  readonly sessionPromise: Promise<ScanSession>
  readonly resumeMilestones?: ControllerTimingMilestones
  readonly durablePreview?: ProgressivePreview
  readonly durableConstruction?: ConstructionResumeLoad
  session?: ScanSession
  completed: boolean
  published: boolean
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
  #initialization: Promise<void> | undefined
  #active: DiskIndex | undefined
  #activeView: LocationIndexView | undefined
  #activeManifest: IndexManifest | undefined
  #preview: ProgressivePreview | undefined
  #target: string
  #focusId: string | undefined
  #generation = 0
  #run: ScanRun | undefined
  #scanStatus: Omit<OrbisSnapshot['scan'], 'locationId'> = { status: 'idle', generation: 0, progress: null, totals: null, error: null }
  #resume: { readonly available: boolean; readonly checkpointedAt: string } | undefined
  #savedConstruction: ConstructionResumeLoad | undefined
  #resumeReceipt: ResumeValidationReceipt | undefined
  #pausedProgress: ProgressSnapshot | undefined
  #listeners = new Set<(snapshot: OrbisSnapshot) => void>()
  #pendingTasks = new Set<Promise<void>>()
  #startQueue: Promise<void> = Promise.resolve()
  #closed = false
  #pendingRevealCancellations = new Set<(error: Error) => void>()
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
    this.#resumeStore = new FullScanResumeStore(this.indexDirectory)
    this.#explicitInitialTarget = options.initialTarget !== undefined || process.env.ORBIS_SCAN_ROOT !== undefined
    this.#target = normalize(resolve(options.initialTarget ?? process.env.ORBIS_SCAN_ROOT ?? '/'))
    this.#dialog = options.dialog
    this.#shell = options.shell
  }

  initialize(): Promise<void> {
    this.#initialization ??= this.#initializePersistentIndex()
    return this.#initialization
  }

  subscribe(listener: (snapshot: OrbisSnapshot) => void): () => void {
    if (this.#closed) return () => undefined
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
    const locations = catalog.locations.map((item) => ({ id: item.id, name: item.displayName, coverage: item.publicationId === null ? 'none' as const : this.#publication(item.publicationId)?.target === item.target ? 'direct' as const : 'ancestor' as const })) as unknown as OrbisSnapshot['locations']
    const scan = { ...this.#scanStatus, locationId: this.#run?.locationId ?? catalog.pendingScan?.locationId ?? selected.id, ...(this.#resume ? { resume: this.#resume } : {}) }
    const preview = this.#preview
    const activityTarget = this.#run?.target ?? catalog.pendingScan?.target
    const previewVisible = preview && scan.locationId === selected.id && activityTarget === selected.target
    if (previewVisible) return { version: 4, committed: false, selectedLocationId: selected.id, locations, target: { name: selected.displayName, isStartup: selected.target === '/' }, focus: preview.focus, breadcrumbs: preview.breadcrumbs, chart: preview.chart, largestItems: preview.largestItems, volume: preview.volume, scan }
    const timed = <T>(phase: string, operation: () => T): T => diagnosticGeneration === undefined ? operation() : measureController(diagnosticGeneration, phase, operation)
    const active = this.#activeView
    const focus = timed('snapshot-focus-query', () => active && this.#focusId ? active.getNode(this.#focusId) : undefined)
    const totals = this.#active ? parseTotals(this.#active.metadata.totals) : null
    const root = timed('snapshot-root-query', () => active?.root)
    const volume = this.#active && active ? parseVolume(this.#active.metadata.volume, root?.sizeBytes ?? 0, active.target, root?.sizeAccuracy ?? 'partial') : emptyVolume()
    const breadcrumbs = timed('snapshot-breadcrumbs-query', () => focus && active ? active.getBreadcrumbs(focus.id) : [])
    const chart = timed('snapshot-chart-query', () => focus && active ? buildChart(active, focus, { rootTotalBytes: active.target === '/' ? volume.capacityBytes : 0 }) : [])
    const largestItems = timed('snapshot-largest-items-query', () => focus && active ? active.getLargestItems(focus.id) : [])
    const summary = focus ? toSummary(focus) : null
    return { version: 4, committed: !!active, selectedLocationId: selected.id, locations, target: { name: root?.name ?? selected.displayName, isStartup: selected.target === '/' }, focus: summary && focus?.id === active?.rootId ? { ...summary, parentId: null } : summary, breadcrumbs, chart, largestItems, volume, scan: { ...scan, totals: scan.status === 'scanning' ? null : scan.totals ?? totals } }
  }

  #publication(id: string): IndexManifest | undefined { return this.#catalog?.publications.find((item) => item.publicationId === id) }

  async startScan(): Promise<OrbisSnapshot> {
    await this.initialize()
    const location = this.#selectedLocation()
    return this.#startScanAt(location.target)
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
    if (this.#run) throw new Error('Pause the current scan before adding another location')
    const identity = await resolveTarget(result.filePaths[0])
    const existing = this.#catalog!.locations.find((item) => item.target === identity.target)
    if (existing) {
      if (existing.targetDevice === identity.targetDevice && existing.targetInode === identity.targetInode) return this.selectLocation(existing.id)
      const changed = { ...existing, ...identity, publicationId: null }
      if (this.#catalog!.pendingScan) throw new Error('Complete or discard the saved scan before scanning another location')
      await this.#catalogStore.replaceLocation(changed)
      await this.#selectOpenedLocation(changed)
      return this.#startScanAt(changed.target)
    }
    const publicationId = await this.#coveringPublication(identity)
    if (publicationId === null && this.#catalog!.pendingScan) throw new Error('Complete or discard the saved scan before scanning another location')
    const location: SavedLocationRecord = { id: createLocationId(), ...identity, displayName: uniqueDisplayName(identity.target, this.#catalog!.locations), publicationId }
    await this.#catalogStore.addLocation(location)
    await this.#selectOpenedLocation(location)
    if (publicationId === null) return this.#startScanAt(location.target)
    this.#emit(); return this.snapshot()
  }

  async chooseFolder(): Promise<OrbisSnapshot> { return this.addLocation() }

  async selectLocation(id: LocationId): Promise<OrbisSnapshot> {
    await this.initialize()
    const location = this.#catalog!.locations.find((item) => item.id === id)
    if (!location) throw new Error('Unknown Orbis location')
    if (this.#run && this.#run.locationId !== id) throw new Error('Pause the current scan before selecting another location')
    await this.#catalogStore.selectLocation(id)
    await this.#selectOpenedLocation(location)
    this.#emit(); return this.snapshot()
  }

  async removeLocation(id: LocationId): Promise<OrbisSnapshot> {
    await this.initialize(); const catalog = this.#catalog!
    if (catalog.locations.length === 1) throw new Error('The last location cannot be removed')
    if (catalog.pendingScan?.locationId === id || this.#run?.locationId === id) throw new Error('The scan owner cannot be removed')
    if (!catalog.locations.some((item) => item.id === id)) throw new Error('Unknown Orbis location')
    await this.#catalogStore.removeLocation(id)
    const selected = this.#selectedLocation()
    await this.#selectOpenedLocation(selected)
    this.#emit(); return this.snapshot()
  }

  async cancelScan(): Promise<OrbisSnapshot> {
    const run = this.#run
    if (!run) return this.snapshot()
    if (run.completed) {
      await Promise.allSettled([...this.#pendingTasks])
      return this.snapshot()
    }
    this.#run = undefined
    if (this.#scanStatus.progress && this.#scanStatus.progress.stage !== 'resuming') this.#pausedProgress = this.#scanStatus.progress
    this.#preview = undefined
    this.#savedConstruction = undefined
    this.#rejectPendingReveals('Scan paused')
    const stopped = await this.#stopRun(run)
    if (this.#closed || this.#generation !== run.generation || this.#run) return this.snapshot()
    const saved = await this.#loadResumeAfterStop(run.target, stopped)
    if (this.#closed || this.#generation !== run.generation || this.#run) return this.snapshot()
    this.#rememberResumeLoad(saved)
    this.#resume = saved.kind === 'construction' || saved.kind === 'candidate'
      ? { available: true, checkpointedAt: saved.kind === 'construction' ? saved.checkpointedAt : saved.descriptor.createdAt }
      : undefined
    await this.#restoreConstructionPreview(saved, run.generation)
    this.#scanStatus = { status: 'canceled', generation: run.generation, progress: null, totals: null, error: null }
    this.#emit()
    return this.snapshot()
  }

  async discardSavedScan(): Promise<OrbisSnapshot> {
    const run = this.#run
    if (run?.completed) await Promise.allSettled([...this.#pendingTasks])
    else if (run) {
      this.#run = undefined
      await this.#stopRun(run)
    }
    this.#preview = undefined
    this.#savedConstruction = undefined
    this.#resumeReceipt = undefined
    this.#rejectPendingReveals('Saved scan discarded')
    const pendingScanId = this.#catalog?.pendingScan?.scanId
    await this.#resumeStore.discard(pendingScanId)
    if (pendingScanId) await this.#clearPendingScan(pendingScanId)
    this.#resume = undefined
    if (this.#scanStatus.status === 'canceled') this.#scanStatus = { status: 'idle', generation: this.#scanStatus.generation, progress: null, totals: null, error: null }
    this.#emit()
    return this.snapshot()
  }

  async focusNode(id: string): Promise<OrbisSnapshot> {
    const run = this.#run
    if (run && !run.completed && this.#preview) {
      const node = previewNode(this.#preview, id)
      if (!node) throw new Error('Unknown Orbis node')
      if (node.kind !== 'directory') throw new Error('Only directories can become the chart root')
      this.#rejectPendingReveals('The focused folder changed before the item could be revealed')
      const session = await run.sessionPromise
      if (this.#run !== run || run.completed) return this.snapshot()
      run.session = session
      void session.focus(id)
      return this.snapshot()
    }
    const saved = this.#savedConstruction
    if (saved && this.#preview) {
      const preview = await readConstructionPreview(saved, this.#scanStatus.generation, id)
      if (!preview) throw new Error('Unknown Orbis node')
      if (this.#closed || this.#run || this.#savedConstruction !== saved) throw new Error('The scan changed before the folder could be opened')
      this.#rejectPendingReveals('The focused folder changed before the item could be revealed')
      this.#preview = preview
      this.#emit()
      return this.snapshot()
    }
    const active = this.#activeView
    if (!active) throw new Error('No completed scan is available')
    const node = active.getNode(id)
    if (!node) throw new Error('Unknown Orbis node')
    if (node.kind !== 'directory') throw new Error('Only directories can become the chart root')
    this.#focusId = node.id
    this.#emit()
    return this.snapshot()
  }

  async revealNode(id: string): Promise<void> {
    if (!this.#shell) throw new Error('Reveal in Finder is unavailable')
    const run = this.#run
    if (run && !run.completed && this.#preview) {
      if (!previewNode(this.#preview, id)) throw new Error('Unknown Orbis node')
      const outcome = await this.#resolveLiveNode(run, id)
      if (outcome.kind !== 'resolved') throw new Error('Unknown Orbis node')
      if (this.#run !== run) throw new Error('The scan changed before the item could be revealed')
      const safePath = await validateRevealPath(outcome.path, run.target)
      this.#shell.showItemInFolder(safePath)
      return
    }
    const saved = this.#savedConstruction
    if (saved && this.#preview) {
      const path = await resolveConstructionNodePath(saved, id)
      if (!path) throw new Error('Unknown Orbis node')
      const safePath = await validateRevealPath(path, saved.descriptor.target)
      if (this.#closed || this.#run || this.#savedConstruction !== saved) throw new Error('The scan changed before the item could be revealed')
      this.#shell.showItemInFolder(safePath)
      return
    }
    const active = this.#activeView
    if (!active) throw new Error('No completed scan is available')
    const path = active.resolvePath(id)
    if (!path) throw new Error('Unknown Orbis node')
    const safePath = await validateRevealPath(path, active.target)
    if (this.#activeView !== active) throw new Error('The scan changed before the item could be revealed')
    this.#shell.showItemInFolder(safePath)
  }

  async openFullDiskAccess(): Promise<void> {
    if (!this.#shell) throw new Error('Full Disk Access settings are unavailable')
    await this.#shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity_Privacy_FullDiskAccess')
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#startQueue
    if (this.#initialization) await this.#initialization.catch(() => undefined)
    const run = this.#run
    if (run && !run.completed) {
      this.#run = undefined
      await this.#stopRun(run)
    }
    await this.scanExecution.close()
    await Promise.allSettled([...this.#pendingTasks])
    this.#run = undefined
    try { this.#active?.close() } catch { /* Shutdown continues so owned artifacts can still be removed. */ }
    this.#active = undefined
    this.#activeView = undefined
    this.#preview = undefined
    this.#savedConstruction = undefined
    this.#resumeReceipt = undefined
    this.#rejectPendingReveals('Orbis is shutting down')
    this.#focusId = undefined
    // Catalog reconciliation owns both durable and uncertain publication generations.
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
          : await resolveTarget(this.#target)
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
        const explicit = await resolveTarget(this.#target)
        let location = catalog.locations.find((item) => item.target === explicit.target || item.targetDevice === explicit.targetDevice && item.targetInode === explicit.targetInode)
        if (!location) {
          const publicationId = await this.#coveringPublication(explicit)
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
    } catch (error) { if (!isMissingPath(error) && errorCode(error) !== 'EACCES' && errorCode(error) !== 'EPERM' && errorCode(error) !== 'EIO' && errorCode(error) !== 'ENXIO') throw error }
    this.#target = selected.target
    this.#rememberResumeLoad(saved)
    if (saved.kind === 'construction' || saved.kind === 'candidate') {
      this.#resume = { available: true, checkpointedAt: saved.kind === 'construction' ? saved.checkpointedAt : saved.descriptor.createdAt }
      this.#scanStatus = { status: 'canceled', generation: 0, progress: null, totals: null, error: null }
      if (saved.kind === 'construction') await this.#restoreConstructionPreview(saved, 0)
    } else if (saved.kind === 'restart' && saved.reason === 'target-unavailable' && saved.descriptor) {
      this.#resume = { available: true, checkpointedAt: saved.descriptor.createdAt }
      this.#scanStatus = { status: 'canceled', generation: 0, progress: null, totals: null, error: null }
    }
    await this.#selectOpenedLocation(this.#selectedLocation())
    await this.#catalogStore.reconcileArtifacts()
  }

  #selectedLocation(): SavedLocationRecord { return this.#catalog!.locations.find((item) => item.id === this.#catalog!.selectedLocationId)! }

  async #coveringPublication(identity: { readonly target: string; readonly targetDevice: string; readonly targetInode: string }): Promise<string | null> {
    const candidates = this.#catalog!.publications.filter((item) => isWithinPath(identity.target, item.target)).sort((a, b) => b.target.length - a.target.length)
    for (const candidate of candidates) {
      let index: DiskIndex | undefined
      try {
        index = new DiskIndex(join(this.indexDirectory, candidate.indexFile))
        if (matchesManifest(index, candidate) && await targetIdentityIsCompatible(candidate) && index.openLocationView(identity.target, { device: identity.targetDevice, inode: identity.targetInode })) return candidate.publicationId
      } catch { /* Invalid publications cannot cover a new location. */ }
      finally { try { index?.close() } catch { /* Continue probing. */ } }
    }
    return null
  }

  async #selectOpenedLocation(location: SavedLocationRecord): Promise<void> {
    const publications = this.#catalog!.publications.filter((item) => isWithinPath(location.target, item.target)).sort((a, b) => b.target.length - a.target.length)
    let opened: DiskIndex | undefined; let view: LocationIndexView | undefined; let manifest: IndexManifest | undefined
    for (const candidate of publications) {
      try { const index = new DiskIndex(join(this.indexDirectory, candidate.indexFile)); const candidateView = matchesManifest(index, candidate) && await targetIdentityIsCompatible(candidate) ? index.openLocationView(location.target, { device: location.targetDevice, inode: location.targetInode }) : undefined; if (candidateView) { opened = index; view = candidateView; manifest = candidate; break } index.close() } catch { /* Ignore invalid publication. */ }
    }
    if (this.#active && this.#active !== opened) this.#active.close()
    this.#active = opened; this.#activeView = view; this.#activeManifest = manifest; this.#target = location.target; this.#focusId = view?.rootId
    if (manifest && location.publicationId !== manifest.publicationId) await this.#catalogStore.repairLocationCoverage(location.id, manifest.publicationId)
    else if (!manifest && location.publicationId !== null) await this.#catalogStore.repairLocationCoverage(location.id, null)
  }

  #startTask(task: Promise<void>): void {
    this.#pendingTasks.add(task)
    void task.finally(() => this.#pendingTasks.delete(task)).catch(() => undefined)
  }

  async #stopRun(run: ScanRun): Promise<ScanOutcome> {
    try {
      const session = await run.sessionPromise
      run.session = session
      return await session.pause()
    } catch (error) {
      // A failed or timed-out stop has no clean-pause proof. The caller must
      // use the authoritative loader instead.
      return { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  async #removeRunFiles(run: ScanRun): Promise<void> {
    await Promise.all([this.#artifacts.discardUnreferencedDatabase(run.partialPath), this.#artifacts.discardUnreferencedDatabase(run.publishedPath)])
  }

  async #startScanAt(value: string): Promise<OrbisSnapshot> {
    const resumeMilestones = createControllerTimingMilestones()
    let release!: () => void
    const previous = this.#startQueue
    this.#startQueue = new Promise<void>((resolveQueue) => { release = resolveQueue })
    await previous
    try {
      return await this.#startScanAtSerial(value, resumeMilestones)
    } finally {
      release()
    }
  }

  async #startScanAtSerial(value: string, resumeMilestones: ControllerTimingMilestones): Promise<OrbisSnapshot> {
    if (this.#closed) throw new Error('Orbis is shutting down')
    await this.initialize()
    if (!isAbsolute(value) || value.includes('\u0000')) throw new Error('Choose an absolute folder')
    const target = normalize(resolve(value))
    if (this.#run && this.#run.target !== target) throw new Error('Pause and discard the saved scan before choosing another folder')
    const previous = this.#run
    if (previous?.completed) await Promise.allSettled([...this.#pendingTasks])
    const current = this.#run
    let stoppedSaved: FullScanResumeLoad | undefined
    if (current) {
      this.#run = undefined
      const stopped = await this.#stopRun(current)
      stoppedSaved = await this.#loadResumeAfterStop(current.target, stopped)
      this.#rememberResumeLoad(stoppedSaved)
    }
    await mkdir(this.indexDirectory, { recursive: true, mode: 0o700 })
    if (this.#closed) throw new Error('Orbis is shutting down')
    const generation = ++this.#generation
    // Peek at the saved scan (descriptor + file existence) instead of fully
    // validating it: the worker performs the authoritative validation before
    // resuming, and full validation is O(index size) on large saved scans.
    let saved = stoppedSaved ?? await this.#resumeStore.peek()
    if (process.env.ORBIS_DISABLE_INCREMENTAL_SCAN === '1' && saved.kind !== 'none') {
      if (saved.kind === 'construction' || saved.kind === 'candidate' || saved.descriptor) await this.#resumeStore.discard(saved.descriptor?.scanId)
      else await this.#resumeStore.removeDescriptor()
      saved = { kind: 'none' }
      this.#resumeReceipt = undefined
    }
    const savedDescriptor = saved.kind === 'construction' || saved.kind === 'candidate' || saved.kind === 'restart' ? saved.descriptor : undefined
    if (savedDescriptor && savedDescriptor.target !== target) throw new Error('Discard the saved scan before choosing another folder')
    const publicationId = saved.kind === 'construction' || saved.kind === 'candidate' ? saved.descriptor.scanId : randomUUID()
    const { partialPath, indexPath: publishedPath } = this.#catalogStore.paths(publicationId)
    if (saved.kind !== 'construction' && saved.kind !== 'candidate') {
      await this.#artifacts.discardUnreferencedDatabase(partialPath)
      await this.#artifacts.discardUnreferencedDatabase(publishedPath)
    }
    const initialEstimate = this.#active?.target === target ? estimateFromIndex(this.#active) : await this.#estimateCache.load(target)
    const active = this.#active?.target === target && this.#activeManifest
      ? { manifest: this.#activeManifest, path: this.#active.path }
      : undefined
    const resumeExpected = saved.kind === 'construction' || saved.kind === 'candidate'
    const durablePreview = resumeExpected ? this.#preview : undefined
    const durableConstruction = resumeExpected ? this.#savedConstruction : undefined
    if (durablePreview) this.#preview = { ...durablePreview, generation }
    else if (!resumeExpected) this.#preview = undefined
    if (!resumeExpected) {
      this.#savedConstruction = undefined
      this.#resumeReceipt = undefined
      this.#pausedProgress = undefined
    }
    const resumeReceipt = resumeExpected ? this.#resumeReceipt : undefined
    // A receipt is single-use: once worker startup is scheduled it may not be
    // reused by a later generation or a second worker.
    this.#resumeReceipt = undefined
    this.#rejectPendingReveals('A newer scan started')
    const owner = this.#selectedLocation()
    const basePublicationId = this.#activeManifest?.publicationId ?? null
    const resolvedScan = this.#activeManifest?.target === target
      ? { targetDevice: this.#activeManifest.targetDevice, targetInode: this.#activeManifest.targetInode }
      : await resolveTarget(target)
    await this.#catalogStore.beginScan({ scanId: publicationId, locationId: owner.id, target, targetDevice: resolvedScan.targetDevice, targetInode: resolvedScan.targetInode, basePublicationId }, current?.publicationId)
    const sessionPromise = Promise.resolve().then(() => this.scanExecution.start({
      target, partialPath, publishedPath, indexDirectory: this.indexDirectory, startupRoot: target === '/', resumeExpected,
      ...(resumeReceipt ? { resumeReceipt } : {}),
      ...(initialEstimate ? { initialEstimate } : {}), ...(active ? { active } : {})
    }))
    const run: ScanRun = {
      generation, publicationId, locationId: owner.id, basePublicationId, target, partialPath, publishedPath, sessionPromise,
      ...(resumeExpected ? { resumeMilestones } : {}),
      ...(durablePreview ? { durablePreview: { ...durablePreview, generation } } : {}),
      ...(durableConstruction ? { durableConstruction } : {}),
      completed: false, published: false
    }
    this.#run = run
    this.#target = target
    this.#resume = undefined
    const retained = this.#pausedProgress
    const progress: ProgressSnapshot | null = resumeExpected ? {
      stage: 'resuming', scannedItems: retained?.scannedItems ?? 0,
      discoveredBytes: retained?.discoveredBytes ?? durablePreview?.volume.scannedBytes ?? 0,
      elapsedMs: retained?.elapsedMs ?? 0, currentItem: RESUME_PREPARATION_MESSAGES.validating
    } : null
    this.#scanStatus = { status: 'scanning', generation, progress, totals: null, error: null }
    this.#startTask(this.#consumeRun(run))
    this.#emit()
    return this.snapshot()
  }

  async #consumeRun(run: ScanRun): Promise<void> {
    let session: ScanSession
    try {
      session = await run.sessionPromise
      run.session = session
      run.resumeMilestones?.mark(run.generation, 'resume-click-to-session')
    } catch (error) {
      if (this.#run === run && !this.#closed) await this.#handleRunOutcome(run, { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) })
      return
    }
    if (this.#run !== run || this.#closed || run.completed) {
      await session.pause()
      return
    }
    for await (const update of session.events) {
      if (this.#run !== run || this.#closed || run.completed) continue
      if (update.type === 'resume-milestone') {
        if (update.milestone === 'preparation-started') run.resumeMilestones?.mark(run.generation, 'resume-click-to-preparation')
        else if (update.milestone === 'first-metadata-page') run.resumeMilestones?.mark(run.generation, 'resume-click-to-first-metadata-page')
        else if (update.milestone === 'first-metadata-preview') run.resumeMilestones?.mark(run.generation, 'resume-click-to-first-metadata-preview')
        continue
      }
      if (update.type === 'resume-preparation') {
        const progress = this.#scanStatus.progress
        if (progress?.stage !== 'resuming') continue
        this.#scanStatus = { ...this.#scanStatus, progress: { ...progress, currentItem: RESUME_PREPARATION_MESSAGES[update.phase] } }
      } else if (update.type === 'progress') {
        run.resumeMilestones?.mark(run.generation, 'resume-click-to-first-progress')
        this.#scanStatus = { status: 'scanning', generation: run.generation, progress: update.progress, totals: null, error: null }
      } else if (update.preview.generation === run.generation && (!this.#preview || update.preview.revision >= this.#preview.revision)) {
        this.#preview = update.preview
      }
      this.#emit()
    }
    const outcome = await session.result
    if (this.#run !== run || this.#closed) {
      if (outcome.kind === 'completed' && !run.published) await this.#removeStaleCandidate(outcome.result.publishedPath)
      return
    }
    await this.#handleRunOutcome(run, outcome)
  }

  async #handleRunOutcome(run: ScanRun, outcome: ScanOutcome): Promise<void> {
    if (outcome.kind === 'completed') {
      run.completed = true
      await this.#publish(run, outcome.result, outcome.refresh)
    } else if (outcome.kind === 'unchanged') {
      run.completed = true
      await this.#publishUnchanged(run, outcome.journal, outcome.totals, outcome.basePublicationId)
    } else if (outcome.kind === 'canceled' || outcome.kind === 'paused') {
      this.#run = undefined
      this.#preview = undefined
      this.#savedConstruction = undefined
      this.#rejectPendingReveals('Scan paused')
      this.#scanStatus = { status: 'canceled', generation: run.generation, progress: null, totals: null, error: null }
      await this.#refreshResumeState(run.generation, true, { target: run.target, outcome })
      this.#emit()
    } else {
      this.#fail(run, outcome.error.message)
    }
  }

  async #publish(run: ScanRun, result: ScanResult, refresh?: Extract<ScanOutcome, { kind: 'completed' }>['refresh']): Promise<void> {
    return measureControllerAsync(run.generation, 'publication-total', async () => {
      if (result.target !== run.target || result.publishedPath !== run.publishedPath) {
        await this.#fail(run, 'The scan worker returned an invalid publication.')
        return
      }
      if (this.#run !== run || this.#closed) {
        await this.#artifacts.discardUnreferencedDatabase(result.publishedPath)
        return
      }
      if (refresh?.basePublicationId && refresh.basePublicationId !== this.#activeManifest?.publicationId) {
        await this.#fail(run, 'The incremental scan was based on a stale index.')
        return
      }
      let next: DiskIndex | undefined
      let nextView: LocationIndexView | undefined
      let manifest: IndexManifest | undefined
      const old = this.#active
      const oldView = this.#activeView
      const oldManifest = this.#activeManifest
      const oldFocusId = this.#focusId
      try {
        next = measureController(run.generation, 'index-open', () => new DiskIndex(result.publishedPath))
        const persistent = refresh?.reference !== true
        if (persistent && !await indexDirectoryIdentityIsCompatible(next, this.indexDirectory)) throw new Error('The scan worker returned an index for another index directory')
        manifest = persistent ? manifestFor(run, next, refresh?.journal ?? null) : undefined
        const selected = this.#selectedLocation()
        nextView = next.openLocationView(selected.target, { device: selected.targetDevice, inode: selected.targetInode })
        if (!nextView) throw new Error('The selected location is not present in the candidate index')
        if (manifest) {
          const candidateManifest = manifest
          const owner = this.#catalog!.locations.find((location) => location.id === run.locationId)
          if (!owner || !next.openLocationView(owner.target, { device: owner.targetDevice, inode: owner.targetInode })) throw new Error('The scanned location is not present in the candidate index')
          const coveredLocationIds = this.#catalog!.locations.filter((location) => next!.openLocationView(location.target, { device: location.targetDevice, inode: location.targetInode })).map((location) => location.id)
          await measureControllerAsync(run.generation, 'manifest-publish', () => this.#catalogStore.commitPublication(candidateManifest, coveredLocationIds, { scanId: run.publicationId, locationId: run.locationId, basePublicationId: run.basePublicationId }))
          run.published = true
          await this.#resumeStore.complete(run.publicationId).catch(() => false)
          this.#resume = undefined
          this.#savedConstruction = undefined
          this.#resumeReceipt = undefined
        }
        if (this.#run !== run) {
          try { next.close() } catch { /* A newer run owns controller state. */ }
          if (!manifest) await this.#artifacts.discardUnreferencedDatabase(result.publishedPath)
          return
        }
        run.published = true
        this.#active = next
        this.#activeView = nextView
        if (manifest) this.#activeManifest = manifest
        this.#preview = undefined
        this.#savedConstruction = undefined
        this.#resumeReceipt = undefined
        this.#rejectPendingReveals('Scan completed')
        this.#focusId = restoreFocus(this.#activeView ?? next, oldView, oldFocusId)
        this.#target = this.#selectedLocation().target
        this.#scanStatus = { status: 'completed', generation: run.generation, progress: null, totals: result.totals, error: null }
        const snapshot = measureController(run.generation, 'snapshot-total', () => this.#buildSnapshot(run.generation))
        this.#run = undefined
        try { await this.#estimateCache.store(next.target, estimateFromIndex(next)) } catch { /* A cache failure must not invalidate an exact index. */ }
        try { await measureControllerAsync(run.generation, 'partial-index-cleanup', () => this.#artifacts.discardUnreferencedDatabase(run.partialPath)) } catch { /* Shutdown retries owned cleanup. */ }
        if (old) {
          try { old.close() } catch { /* The new index remains authoritative. */ }
          if (!persistent && old.path !== next.path) {
            try { await measureControllerAsync(run.generation, 'previous-index-cleanup', () => this.#artifacts.discardUnreferencedDatabase(old.path)) } catch { /* The new index remains authoritative. */ }
          }
        } else if (!persistent && oldManifest && oldManifest.indexFile !== manifest?.indexFile) {
          try { await this.#artifacts.discardUnreferencedDatabase(join(this.indexDirectory, oldManifest.indexFile)) } catch { /* The reference result remains active. */ }
        }
        if (!this.#closed) measureController(run.generation, 'listener-notify', () => this.#emit(snapshot))
      } catch (error) {
        if (run.published) {
          if (this.#run === run && next && nextView) {
            this.#active = next
            this.#activeView = nextView
            if (manifest) this.#activeManifest = manifest
            this.#preview = undefined
            this.#savedConstruction = undefined
            this.#resumeReceipt = undefined
            this.#focusId = nextView.rootId
            this.#target = this.#selectedLocation().target
            this.#scanStatus = { status: 'completed', generation: run.generation, progress: null, totals: result.totals, error: null }
            this.#run = undefined
            try { if (old && old !== next) old.close() } catch { /* The committed index remains authoritative. */ }
            try { await this.#artifacts.discardUnreferencedDatabase(run.partialPath) } catch { /* Startup reconciliation retries cleanup. */ }
            try { this.#emit() } catch { /* A later snapshot or restart retries read-model projection. */ }
          } else if (next && this.#active !== next) {
            try { next.close() } catch { /* A newer run owns controller state. */ }
          }
          return
        }
        if (this.#run === run) {
          this.#active = old
          this.#activeManifest = oldManifest
          this.#preview = undefined
          this.#focusId = oldFocusId
          this.#target = old?.target ?? run.target
          try { next?.close() } catch { /* Best effort while restoring the previous index. */ }
        }
        await this.#clearPendingScan(run.publicationId).catch(() => undefined)
        await this.#artifacts.discardUnreferencedDatabase(result.publishedPath)
        this.#fail(run, error instanceof Error ? error.message : String(error))
      }
    })
  }

  async #publishUnchanged(run: ScanRun, journal: JournalCursor, totals: ScanTotals, basePublicationId: string): Promise<void> {
    const active = this.#active
    const manifest = this.#activeManifest
    if (this.#run !== run || this.#closed) return
    if (!active || !manifest || active.target !== run.target || manifest.publicationId !== basePublicationId) {
      this.#fail(run, 'The incremental scan was based on a stale index.')
      return
    }
    try {
      const nextManifest: IndexManifest = { ...manifest, journal }
      // An unchanged scan has no new publication to protect. Retire Resume first so a crash
      // cannot resurrect a transaction after its pending catalog record is cleared.
      const resumeDescriptor = await this.#resumeStore.readDescriptor()
      if (resumeDescriptor && resumeDescriptor.scanId !== run.publicationId) throw new Error('Another Orbis scan owns the Resume descriptor')
      const resumeRetired = await this.#resumeStore.complete(run.publicationId)
      if (resumeDescriptor && !resumeRetired) throw new Error('Unable to retire the completed Resume descriptor')
      await this.#catalogStore.advancePublication(run.publicationId, nextManifest)
      if (this.#run !== run || this.#closed) return
      this.#activeManifest = nextManifest
      this.#preview = undefined
      this.#savedConstruction = undefined
      this.#resumeReceipt = undefined
      this.#resume = undefined
      this.#scanStatus = { status: 'completed', generation: run.generation, progress: null, totals, error: null }
      this.#run = undefined
      await this.#removeRunFiles(run)
      this.#emit()
    } catch (error) {
      this.#fail(run, error instanceof Error ? error.message : String(error))
    }
  }

  async #clearPendingScan(scanId: string): Promise<void> {
    await this.#catalogStore.clearPendingScan(scanId)
  }

  async #removeStaleCandidate(path: string): Promise<void> {
    await this.#artifacts.discardUnreferencedDatabase(path)
  }

  async #refreshResumeState(
    generation: number, restorePreview = false,
    stopped?: { readonly target: string; readonly outcome: ScanOutcome }
  ): Promise<void> {
    const saved = stopped ? await this.#loadResumeAfterStop(stopped.target, stopped.outcome) : await this.#resumeStore.load(this.#target)
    if (this.#closed || this.#generation !== generation || this.#run) return
    this.#rememberResumeLoad(saved)
    this.#resume = saved.kind === 'construction' || saved.kind === 'candidate'
      ? { available: true, checkpointedAt: saved.kind === 'construction' ? saved.checkpointedAt : saved.descriptor.createdAt }
      : undefined
    this.#savedConstruction = undefined
    if (restorePreview && saved.kind === 'construction' && saved.descriptor.target === this.#target) {
      const restored = await this.#restoreConstructionPreview(saved, generation)
      if (!restored && !this.#closed && this.#generation === generation && !this.#run) this.#preview = undefined
    } else if (restorePreview) this.#preview = undefined
  }

  async #restoreConstructionPreview(saved: FullScanResumeLoad, generation: number): Promise<boolean> {
    if (saved.kind !== 'construction' || saved.descriptor.target !== this.#target) return false
    const retainedFocusId = this.#preview?.focus.id
    const preview = await readConstructionPreview(saved, generation, retainedFocusId)
      ?? (retainedFocusId ? await readConstructionPreview(saved, generation) : undefined)
    if (!preview || this.#closed || this.#generation !== generation || this.#run || saved.descriptor.target !== this.#target) return false
    this.#savedConstruction = saved
    this.#preview = preview
    return true
  }

  #rememberResumeLoad(saved: FullScanResumeLoad): void {
    this.#resumeReceipt = saved.kind === 'construction' || saved.kind === 'candidate' ? saved.receipt : undefined
  }

  async #loadResumeAfterStop(target: string, outcome: ScanOutcome): Promise<FullScanResumeLoad> {
    if (outcome.kind === 'paused' && outcome.acknowledged && outcome.checkpointSequence !== undefined) {
      return this.#resumeStore.loadAcknowledgedCheckpoint(target, outcome.checkpointSequence)
    }
    return this.#resumeStore.load(target)
  }

  #fail(run: ScanRun, error: string): void {
    if (this.#run !== run) return
    this.#run = undefined
    this.#preview = run.durablePreview
    this.#savedConstruction = run.durableConstruction
    this.#rejectPendingReveals('Scan failed')
    this.#scanStatus = { status: 'fatal-error', generation: run.generation, progress: null, totals: null, error }
    this.#startTask(this.#stopRun(run).then(async () => {
      await this.#refreshResumeState(run.generation, true)
      if (this.#closed || this.#generation !== run.generation || this.#run) return
      if (this.#resume) this.#scanStatus = { status: 'canceled', generation: run.generation, progress: null, totals: null, error: null }
      else {
        await this.#clearPendingScan(run.publicationId).catch(() => undefined)
        await this.#removeRunFiles(run)
      }
      this.#emit()
    }))
  }

  async #resolveLiveNode(run: ScanRun, id: string): ReturnType<ScanSession['resolveNode']> {
    let rejectCancellation!: (error: Error) => void
    const canceled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    this.#pendingRevealCancellations.add(rejectCancellation)
    try {
      const session = await run.sessionPromise
      if (this.#run !== run || run.completed) throw new Error('The scan changed before the item could be revealed')
      run.session = session
      return await Promise.race([session.resolveNode(id), canceled])
    }
    finally { this.#pendingRevealCancellations.delete(rejectCancellation) }
  }

  #rejectPendingReveals(message: string): void {
    const error = new Error(message)
    for (const reject of this.#pendingRevealCancellations) reject(error)
    this.#pendingRevealCancellations.clear()
  }

  #emit(snapshot = this.snapshot()): void {
    for (const listener of this.#listeners) {
      try { listener(snapshot) } catch { /* A renderer listener must not break publication. */ }
    }
  }
}

function restoreFocus(next: DiskIndex | LocationIndexView, previous: DiskIndex | LocationIndexView | undefined, previousFocusId: string | undefined): string {
  if (previousFocusId) {
    const stable = next.getNode(previousFocusId)
    if (stable?.kind === 'directory') return stable.id
    let path = previous?.getNode(previousFocusId)?.path
    while (path && isWithinPath(path, next.target)) {
      const node = next.getNodeByPath(path)
      if (node?.kind === 'directory') return node.id
      if (path === next.target) break
      path = resolve(path, '..')
    }
  }
  return next.rootId
}

function manifestFor(run: ScanRun, index: DiskIndex, journal: JournalCursor | null): IndexManifest {
  const metadata = index.metadata
  const schemaVersion = positiveInteger(metadata.schemaVersion)
  const indexRevision = positiveInteger(metadata.indexRevision)
  const targetDevice = decimalString(metadata.targetDevice)
  const targetInode = decimalString(metadata.targetInode)
  if (schemaVersion !== PERSISTENT_INDEX_SCHEMA_VERSION || !indexRevision || !targetDevice || !targetInode
    || metadata.accountingVersion !== PERSISTENT_ACCOUNTING_VERSION
    || metadata.exclusionPolicyVersion !== EXCLUSION_POLICY_VERSION
    || metadata.hardLinkOrderingVersion !== HARD_LINK_ORDERING_VERSION) throw new Error('The scan worker returned an incompatible persistent index')
  return {
    version: 1, publicationId: run.publicationId, indexFile: basename(index.path), target: index.target,
    targetDevice, targetInode, schemaVersion, indexRevision, journal
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
    return isMissingPath(error) || code === 'EACCES' || code === 'EPERM' || code === 'EIO' || code === 'ENXIO'
  }
}

async function indexDirectoryIdentityIsCompatible(index: DiskIndex, directory: string): Promise<boolean> {
  try {
    const stats = await lstat(directory)
    return stats.isDirectory() && !stats.isSymbolicLink() && index.metadata.indexDirectoryIdentity === `${String(stats.dev)}:${String(stats.ino)}`
  } catch { return false }
}


function positiveInteger(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 ? number : undefined
}

function decimalString(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) ? value : undefined
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

function estimateFromIndex(index: DiskIndex): FolderSizeEstimate {
  const root = index.root
  return { items: root ? index.getChildren(root.id, 400).map((child) => ({ name: child.name, estimatedBytes: child.sizeBytes })) : [] }
}

function isWithinPath(path: string, parent: string): boolean {
  const child = normalize(path)
  const root = normalize(parent)
  const remainder = relative(root, child)
  return child === root || remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`)
}

async function resolveTarget(value: string): Promise<{ target: string; targetDevice: string; targetInode: string }> {
  if (!isAbsolute(value) || value.includes('\0')) throw new Error('Choose an absolute folder')
  const target = normalize(await realpath(value))
  const stats = await lstat(target)
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Choose a directory')
  return { target, targetDevice: String(stats.dev), targetInode: String(stats.ino) }
}

async function validateRevealPath(path: string, target: string): Promise<string> {
  if (!isAbsolute(path) || !isWithinPath(path, target)) throw new Error('The worker returned an unsafe Finder path')
  const stats = await lstat(path).catch((error: unknown) => {
    if (isMissingPath(error)) throw new Error('The Finder item is no longer available')
    throw error
  })
  if (stats.isSymbolicLink()) throw new Error('The Finder path is no longer a scanned item')
  const canonical = await realpath(path).catch((error: unknown) => {
    if (isMissingPath(error)) throw new Error('The Finder item is no longer available')
    throw error
  })
  const canonicalTarget = await realpath(target).catch((error: unknown) => {
    if (isMissingPath(error)) throw new Error('The scan target is no longer available')
    throw error
  })
  if (!isWithinPath(canonical, canonicalTarget)) throw new Error('The Finder path escaped the scan target')
  return canonical
}

function isMissingPath(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}


function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
}

function previewNode(preview: ProgressivePreview, id: string): { readonly id: string; readonly kind: 'directory' | 'file' } | undefined {
  if (preview.focus.id === id) return preview.focus
  if (preview.breadcrumbs.some((breadcrumb) => breadcrumb.id === id)) return { id, kind: 'directory' }
  const item = preview.largestItems.find((node) => node.id === id)
  if (item) return item
  const segment = preview.chart.find((node) => node.id === id)
  return segment?.id ? { id: segment.id, kind: segment.kind === 'file' ? 'file' : 'directory' } : undefined
}

function parseVolume(value: string | undefined, scannedBytes: number, target: string, accuracy: SizeAccuracy): OrbisSnapshot['volume'] {
  try {
    const parsed = JSON.parse(value ?? '{}') as { capacityBytes?: unknown; freeBytes?: unknown }
    const capacityBytes = finite(parsed.capacityBytes)
    const freeBytes = finite(parsed.freeBytes)
    const unscannedBytes = target === '/' ? Math.max(0, capacityBytes - freeBytes - scannedBytes) : 0
    return { capacityBytes, freeBytes, scannedBytes, unscannedBytes, sizeAccuracy: unscannedBytes > 0 ? 'estimated' : accuracy }
  } catch { return { capacityBytes: 0, freeBytes: 0, scannedBytes, unscannedBytes: 0, sizeAccuracy: accuracy } }
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
