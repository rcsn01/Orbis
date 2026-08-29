import { randomUUID } from 'node:crypto'
import type { CompletedOutcome, CompletedPublicationResult, ScanLifecycleDependencies, ScanLifecycleResumePort, ScanRunContext, ScanStartContext, ScanStartGuards, UnchangedOutcome, UnchangedPublicationResult } from './scan-run-lifecycle'
import { readConstructionPreview, resolveConstructionNodePath } from './construction-preview'
import { createControllerTimingMilestones, measureControllerAsync } from './diagnostics'
import type { CoveragePublicationAccess, InstalledLocationAccess } from './coverage-publication-access'
import type { FullScanResumeStore } from './full-scan-resume'
import type { IndexManifest } from './index-manifest'
import type { LocationCatalogStore, PendingScanRecord } from './location-catalog'
import type { PublicationArtifacts } from './publication-artifacts'
import { resolveTarget, validateRevealPath } from './scan-target'
import type { FolderSizeEstimate } from './scan-metadata'
import type { ScanExecution } from './scan-execution'

/**
 * Production adapters that satisfy the scan-run lifecycle's dependency ports
 * with the location catalog, coverage publication access, the resume store, and
 * the estimate cache. Catalog mutations stay behind these injected operations —
 * candidate 3's future territory.
 */

export interface ScanLifecycleFocusPort {
  /** The controller's current renderer focus id (presentation state). */
  currentId(): string | undefined
  /** Resolve a focus id to a private path through the installed coverage view. */
  resolvePath(id: string): string | undefined
  /** Restore focus after publication and return the restored id. */
  restore(access: InstalledLocationAccess, previousFocusId?: string, previousFocusPath?: string): string
}

export interface ScanLifecycleAdapterInputs {
  readonly indexDirectory: string
  readonly scanExecution: ScanExecution
  readonly ensureInitialized: () => Promise<void>
  readonly resumeStore: FullScanResumeStore
  readonly catalogStore: LocationCatalogStore
  readonly coverageAccess: CoveragePublicationAccess
  readonly estimateCache: { load(target: string): Promise<FolderSizeEstimate | undefined>; store(target: string, estimate: FolderSizeEstimate): Promise<void> }
  readonly artifacts: PublicationArtifacts
  readonly focus: ScanLifecycleFocusPort
}

export function createScanLifecycleDependencies(inputs: ScanLifecycleAdapterInputs): ScanLifecycleDependencies {
  const { catalogStore, coverageAccess, resumeStore, estimateCache, artifacts, focus } = inputs

  const resume: ScanLifecycleResumePort = {
    peek: () => resumeStore.peek(),
    load: (expectedTarget) => resumeStore.load(expectedTarget),
    loadAcknowledgedCheckpoint: (expectedTarget, checkpointSequence) => resumeStore.loadAcknowledgedCheckpoint(expectedTarget, checkpointSequence),
    discard: (expectedScanId) => resumeStore.discard(expectedScanId),
    removeDescriptor: () => resumeStore.removeDescriptor()
  }

  const prepareStartContext = async (target: string): Promise<ScanStartContext> => {
    const catalog = catalogStore.current
    const installed = coverageAccess.current()
    const installedPublication = installed?.publication()
    const resolved = installedPublication?.target === target ? undefined : await resolveTarget(target)
    const identity = installedPublication?.target === target
      ? { targetDevice: installedPublication.targetDevice, targetInode: installedPublication.targetInode }
      : { targetDevice: resolved!.targetDevice, targetInode: resolved!.targetInode }
    return {
      identity,
      ownerId: catalog.selectedLocationId,
      basePublicationId: installedPublication?.publicationId ?? null,
      initialEstimate: installed?.publicationTarget === target ? installed.estimate : await estimateCache.load(target),
      active: installed?.publicationTarget === target && installedPublication ? { manifest: installedPublication, path: installed.artifactPath } : undefined,
      guards: { expectedRevision: catalog.revision, selectedLocationId: catalog.selectedLocationId }
    }
  }

  const beginScan = async (record: PendingScanRecord, previousScanId: string | undefined, guards: ScanStartGuards): Promise<void> => {
    const document = catalogStore.current
    if (document.revision !== guards.expectedRevision) throw new Error('The pending catalog snapshot is stale')
    if (document.selectedLocationId !== guards.selectedLocationId) throw new Error('The selected location changed while the scan was starting')
    await catalogStore.beginScan(record, previousScanId)
  }

  const publishCompleted = (run: ScanRunContext, outcome: CompletedOutcome): Promise<CompletedPublicationResult> => {
    return measureControllerAsync(run.generation, 'publication-total', async () => {
      const refresh = outcome.refresh
      const before = coverageAccess.current()
      const beforePublication = before?.publication()
      if (refresh?.basePublicationId && refresh.basePublicationId !== beforePublication?.publicationId) {
        return { kind: 'stale', reason: 'stale-base-publication', candidateDisposition: 'catalog-owned' }
      }
      const previousFocusId = focus.currentId()
      const previousFocusPath = previousFocusId ? before?.resolvePath(previousFocusId) : undefined
      const install = await coverageAccess.publishAndInstall(
        refresh?.reference === true
          ? { kind: 'transient-reference', result: outcome.result, expectedPath: run.publishedPath, ownership: { scanId: run.publicationId, locationId: run.locationId, basePublicationId: run.basePublicationId } }
          : { kind: 'persistent', result: outcome.result, expectedPath: run.publishedPath, ownership: { scanId: run.publicationId, locationId: run.locationId, basePublicationId: run.basePublicationId }, journal: refresh?.journal ?? null },
        catalogStore.current.selectedLocationId
      )
      if (install.kind === 'stale') return { kind: 'stale', reason: 'stale-install', candidateDisposition: install.candidateDisposition }
      // The durable catalog commit passed. Everything below is best-effort and
      // cannot invalidate an exact committed publication.
      const warnings = [...install.warnings]
      try {
        await resumeStore.complete(run.publicationId).catch(() => false)
        focus.restore(install.access, previousFocusId, previousFocusPath)
        try { await estimateCache.store(install.access.publicationTarget, install.access.estimate) } catch { /* A cache failure must not invalidate an exact index. */ }
        try { await measureControllerAsync(run.generation, 'partial-index-cleanup', () => artifacts.discardUnreferencedDatabase(run.partialPath)) } catch { /* Startup reconciliation retries cleanup. */ }
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error))
      }
      return { kind: 'published', totals: outcome.result.totals, activeTarget: selectedTarget(catalogStore), warnings: Object.freeze(warnings) }
    })
  }

  const publishUnchanged = async (run: ScanRunContext, outcome: UnchangedOutcome): Promise<UnchangedPublicationResult> => {
    const active = coverageAccess.current()
    const manifest = active?.publication()
    if (!active || !manifest || active.publicationTarget !== run.target || manifest.publicationId !== outcome.basePublicationId) {
      return { kind: 'stale', reason: 'stale-base-publication', candidateDisposition: 'catalog-owned' }
    }
    // An unchanged scan has no new publication to protect. Retire Resume first so a crash
    // cannot resurrect a transaction after its pending catalog record is cleared.
    const nextManifest: IndexManifest = { ...manifest, journal: outcome.journal }
    const resumeDescriptor = await resumeStore.readDescriptor()
    if (resumeDescriptor && resumeDescriptor.scanId !== run.publicationId) throw new Error('Another Orbis scan owns the Resume descriptor')
    const resumeRetired = await resumeStore.complete(run.publicationId)
    if (resumeDescriptor && !resumeRetired) throw new Error('Unable to retire the completed Resume descriptor')
    await catalogStore.advancePublication(run.publicationId, nextManifest)
    // The durable catalog commit passed. Run-file cleanup cannot roll it back.
    const warnings: string[] = []
    try {
      await artifacts.discardUnreferencedDatabase(run.partialPath)
      await artifacts.discardUnreferencedDatabase(run.publishedPath)
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error))
    }
    return { kind: 'published', totals: outcome.totals, activeTarget: selectedTarget(catalogStore), warnings: Object.freeze(warnings) }
  }

  return {
    indexDirectory: inputs.indexDirectory,
    scanExecution: inputs.scanExecution,
    resume,
    ensureInitialized: inputs.ensureInitialized,
    prepareStartContext,
    createPublicationId: () => randomUUID(),
    runPaths: (publicationId) => {
      const { partialPath, indexPath } = catalogStore.paths(publicationId)
      return { partialPath, publishedPath: indexPath }
    },
    beginScan,
    publishCompleted,
    publishUnchanged,
    clearPendingScan: async (scanId) => { await catalogStore.clearPendingScan(scanId) },
    discardUnreferencedDatabase: async (path) => { await artifacts.discardUnreferencedDatabase(path) },
    pendingScanId: () => {
      try { return catalogStore.current.pendingScan?.scanId } catch { return undefined }
    },
    readConstructionPreview,
    resolveConstructionNodePath,
    validateRevealPath,
    createMilestones: () => createControllerTimingMilestones()
  }
}

function selectedTarget(catalogStore: LocationCatalogStore): string {
  const document = catalogStore.current
  return document.locations.find((location) => location.id === document.selectedLocationId)!.target
}