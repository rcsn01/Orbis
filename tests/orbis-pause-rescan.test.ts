import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ScanRunLifecycle } from "../src/main/scan-run-lifecycle"
import { createScanLifecycleDependencies } from "../src/main/scan-start-adapters"
import { FullScanResumeStore } from "../src/main/full-scan-resume"
import { createEmptyCatalog, LocationCatalogStore, type ResolvedLocationTarget } from "../src/main/location-catalog"
import { createCoveragePublicationAccess } from "../src/main/coverage-publication-access"
import type { FocusOutcome, ResolveNodeOutcome, ScanExecution, ScanExecutionRequest, ScanOutcome, ScanSession, ScanUpdate } from "../src/main/scan-execution"

/**
 * Reproduces the user's symptom end to end against the real catalog: a pause
 * that stops a long scan without a clean-pause proof must release the dead
 * run's pending catalog record and files, or the next Rescan fails with
 * "Another Orbis scan owns the catalog".
 */

function closedUpdates(): AsyncIterable<ScanUpdate> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined } as IteratorResult<ScanUpdate>)
    })
  }
}

/** A session that never emits updates and stops only as an unacknowledged pause. */
class UnacknowledgedPauseSession implements ScanSession {
  readonly events: AsyncIterable<ScanUpdate> = closedUpdates()
  readonly request: ScanExecutionRequest
  readonly #result: Promise<ScanOutcome>
  readonly #settle: (outcome: ScanOutcome) => void
  #settled = false
  paused = false
  constructor(request: ScanExecutionRequest) {
    this.request = request
    let settle!: (outcome: ScanOutcome) => void
    this.#result = new Promise<ScanOutcome>((resolve) => { settle = resolve })
    this.#settle = settle
  }
  get result(): Promise<ScanOutcome> { return this.#result }
  pause(): Promise<ScanOutcome> {
    this.paused = true
    if (!this.#settled) {
      this.#settled = true
      this.#settle({ kind: "paused", acknowledged: false })
    }
    return this.#result
  }
  focus(): Promise<FocusOutcome> { return Promise.resolve({ kind: "unavailable" }) }
  resolveNode(): Promise<ResolveNodeOutcome> { return Promise.resolve({ kind: "unavailable" }) }
}

class UnacknowledgedPauseExecution implements ScanExecution {
  readonly sessions: UnacknowledgedPauseSession[] = []
  closed = false
  async start(request: ScanExecutionRequest): Promise<ScanSession> {
    const session = new UnacknowledgedPauseSession(request)
    this.sessions.push(session)
    return session
  }
  async close(): Promise<void> { this.closed = true }
}

interface PauseRescanFixture {
  readonly lifecycle: ScanRunLifecycle
  readonly catalog: LocationCatalogStore
  readonly execution: UnacknowledgedPauseExecution
  readonly target: string
  readonly close: () => Promise<void>
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)))
})

async function fixture(name: string): Promise<PauseRescanFixture> {
  const directory = await mkdtemp(join(tmpdir(), `orbis-pause-rescan-${name}-`))
  directories.push(directory)
  const target = join(directory, "target")
  await mkdir(target)
  const indexes = join(directory, "indexes")
  await mkdir(indexes, { recursive: true, mode: 0o700 })
  const canonical = await realpath(target)
  const stats = await lstat(canonical)
  const identity: ResolvedLocationTarget = { target: canonical, targetDevice: String(stats.dev), targetInode: String(stats.ino) }
  const catalog = new LocationCatalogStore(indexes)
  await catalog.initialize()
  await catalog.installInitial(createEmptyCatalog(identity))
  const coverage = createCoveragePublicationAccess(indexes, catalog, catalog.artifacts)
  const execution = new UnacknowledgedPauseExecution()
  const deps = createScanLifecycleDependencies({
    indexDirectory: indexes,
    scanExecution: execution,
    ensureInitialized: async () => undefined,
    resumeStore: new FullScanResumeStore(indexes),
    catalogStore: catalog,
    coverageAccess: coverage,
    estimateCache: { load: async () => undefined, store: async () => undefined },
    artifacts: catalog.artifacts,
    focus: { currentId: () => undefined, resolvePath: () => undefined, restore: () => "" }
  })
  const lifecycle = new ScanRunLifecycle(deps, canonical)
  return {
    lifecycle, catalog, execution, target: canonical,
    close: async () => { await lifecycle.seal(); await coverage.close() }
  }
}

function scanIdOf(request: ScanExecutionRequest): string {
  return basename(request.partialPath).replace(/^index-/, "").replace(/\.partial\.sqlite$/, "")
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

describe("pause without a claimable resume", () => {
  it("releases the catalog transaction so the next Rescan can begin", async () => {
    const value = await fixture("rescan")
    try {
      // The first scan opens the catalog's begin-scan transaction.
      const first = await value.lifecycle.startScan({ target: value.target })
      const firstScanId = scanIdOf(value.execution.sessions[0]!.request)
      expect(first.scanStatus).toMatchObject({ status: "scanning", generation: 1 })
      expect(value.catalog.current.pendingScan).toMatchObject({
        scanId: firstScanId,
        locationId: value.catalog.current.selectedLocationId,
        target: value.target,
        basePublicationId: null
      })
      const partialPath = value.catalog.paths(firstScanId).partialPath
      await writeFile(partialPath, "partial run file")

      // The stop has no clean-pause proof and the authoritative resume load
      // finds nothing to claim: the pause ends as a plain cancellation.
      const paused = await value.lifecycle.pauseScan()
      expect(paused.scanStatus).toMatchObject({ status: "canceled", generation: 1 })
      expect(paused.resume).toBeUndefined()

      // The dead run no longer owns the catalog record or its run files.
      expect(value.catalog.current.pendingScan).toBeNull()
      expect(await pathExists(partialPath)).toBe(false)

      // The user's exact symptom: the next Rescan must begin on a fresh
      // publication id instead of failing with "Another Orbis scan owns the
      // catalog".
      const second = await value.lifecycle.startScan({ target: value.target })
      const secondScanId = scanIdOf(value.execution.sessions[1]!.request)
      expect(second.scanStatus).toMatchObject({ status: "scanning", generation: 2 })
      expect(secondScanId).not.toBe(firstScanId)
      expect(value.catalog.current.pendingScan).toMatchObject({
        scanId: secondScanId,
        locationId: value.catalog.current.selectedLocationId,
        target: value.target,
        basePublicationId: null
      })
    } finally {
      await value.close()
    }
  })
})