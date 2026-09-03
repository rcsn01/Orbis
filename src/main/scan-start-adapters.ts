import { randomUUID } from 'node:crypto'
import type { ScanLifecycleDependencies, ScanStartContext, ScanStartGuards } from './scan-run-lifecycle'
import { createPublicationSettlement, type ScanLifecycleFocusPort } from './publication-settlement'
import { readConstructionPreview, resolveConstructionNodePath } from './construction-preview'
import { createControllerTimingMilestones } from './diagnostics'
import type { CoveragePublicationAccess } from './coverage-publication-access'
import type { FullScanResumeStore } from './full-scan-resume'
import type { LocationCatalogStore, PendingScanRecord } from './location-catalog'
import type { PublicationArtifacts } from './publication-artifacts'
import { resolveTarget, validateNodeActionPath } from './scan-target'
import type { FolderSizeEstimate } from './scan-metadata'
import type { ScanExecution } from './scan-execution'

/**
 * Production scan-start adapters that satisfy the scan-run lifecycle's
 * dependency ports: they build the start context from the location catalog,
 * installed coverage, and the estimate cache, and open the catalog's begin-scan
 * transaction gate. Publication settlement lives behind the injected
 * `settlement` module (publication-settlement.ts).
 */

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

  return {
    indexDirectory: inputs.indexDirectory,
    scanExecution: inputs.scanExecution,
    resume: inputs.resumeStore,
    ensureInitialized: inputs.ensureInitialized,
    prepareStartContext,
    createPublicationId: () => randomUUID(),
    runPaths: (publicationId) => {
      const { partialPath, indexPath } = catalogStore.paths(publicationId)
      return { partialPath, publishedPath: indexPath }
    },
    beginScan,
    settlement: createPublicationSettlement({ catalogStore, coverageAccess, resumeStore, estimateCache, artifacts, focus }),
    clearPendingScan: async (scanId) => { await catalogStore.clearPendingScan(scanId) },
    discardUnreferencedDatabase: async (path) => { await artifacts.discardUnreferencedDatabase(path) },
    pendingScanId: () => {
      try { return catalogStore.current.pendingScan?.scanId } catch { return undefined }
    },
    readConstructionPreview,
    resolveConstructionNodePath,
    validateNodeActionPath,
    createMilestones: () => createControllerTimingMilestones()
  }
}