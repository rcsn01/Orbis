import type { CompletedOutcome, ScanRunContext, UnchangedOutcome } from './scan-run-lifecycle'
import { measureControllerAsync } from './diagnostics'
import type { CoveragePublicationAccess, InstalledLocationAccess, PublicationCandidateDisposition } from './coverage-publication-access'
import type { FullScanResumeStore } from './full-scan-resume'
import type { IndexManifest } from './index-manifest'
import type { LocationCatalogStore } from './location-catalog'
import type { PublicationArtifacts } from './publication-artifacts'
import type { FolderSizeEstimate } from './scan-metadata'
import type { ScanTotals } from './scanner'

/**
 * Publication settlement: the catalog-side conversion of a terminal scan run's
 * outcome into an immutable publication. It owns stale-base checks, coverage
 * publication candidate installation, the post-commit best-effort ritual
 * (Resume retirement, focus restore, estimate-cache store, run-file discard),
 * and the single stale-result vocabulary shared with the scan run lifecycle.
 * It does not own the lifecycle's run identity, worker session, renderer
 * navigation policy, or catalog record creation.
 */

export interface ScanLifecycleFocusPort {
  /** The controller's current renderer focus id (presentation state). */
  currentId(): string | undefined
  /** Resolve a focus id to a private path through the installed coverage view. */
  resolvePath(id: string): string | undefined
  /** Restore focus after publication and return the restored id. */
  restore(access: InstalledLocationAccess, previousFocusId?: string, previousFocusPath?: string): string
}

export interface SettlementInputs {
  readonly catalogStore: LocationCatalogStore
  readonly coverageAccess: CoveragePublicationAccess
  readonly resumeStore: FullScanResumeStore
  readonly estimateCache: { load(target: string): Promise<FolderSizeEstimate | undefined>; store(target: string, estimate: FolderSizeEstimate): Promise<void> }
  readonly artifacts: PublicationArtifacts
  readonly focus: ScanLifecycleFocusPort
}

export type SettlementStaleReason = 'stale-base-publication' | 'stale-install'

/**
 * An unchanged outcome can only go stale through its base publication; the
 * `stale-install` reason is exclusive to completed candidates. That guarantee
 * used to be type-enforced by separate result unions and is now an
 * implementation invariant of this module.
 */
export interface SettlementStaleResult {
  readonly kind: 'stale'
  readonly reason: SettlementStaleReason
  readonly candidateDisposition: PublicationCandidateDisposition
}

export interface SettlementPublishedResult {
  readonly kind: 'published'
  readonly totals: ScanTotals
  readonly activeTarget: string
  readonly warnings: readonly string[]
}

export type SettlementResult = SettlementPublishedResult | SettlementStaleResult

/**
 * Commit-point contract: every failure that happens before the durable catalog
 * commit (`publishAndInstall` or `advancePublication`) rejects and rejects the
 * whole settlement. Once the durable commit has passed, the residual work is
 * best-effort only: its failures degrade into `warnings` and never reverse a
 * `published` result.
 */
export interface PublicationSettlement {
  settle(run: ScanRunContext, outcome: CompletedOutcome | UnchangedOutcome): Promise<SettlementResult>
}

export function createPublicationSettlement(inputs: SettlementInputs): PublicationSettlement {
  const { catalogStore, coverageAccess, resumeStore, estimateCache, artifacts, focus } = inputs

  const settleCompleted = (run: ScanRunContext, outcome: CompletedOutcome): Promise<SettlementResult> => {
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

  const settleUnchanged = async (run: ScanRunContext, outcome: UnchangedOutcome): Promise<SettlementResult> => {
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
    settle: (run, outcome) => outcome.kind === 'completed' ? settleCompleted(run, outcome) : settleUnchanged(run, outcome)
  }
}

function selectedTarget(catalogStore: LocationCatalogStore): string {
  const document = catalogStore.current
  return document.locations.find((location) => location.id === document.selectedLocationId)!.target
}