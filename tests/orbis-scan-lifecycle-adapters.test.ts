import { randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createScanLifecycleDependencies, type ScanLifecycleFocusPort } from "../src/main/scan-lifecycle-adapters"
import type { ScanLifecycleDependencies, ScanRunContext, ScanStartGuards, UnchangedOutcome } from "../src/main/scan-run-lifecycle"
import { FullScanResumeStore, type FullScanResumeDescriptor } from "../src/main/full-scan-resume"
import { createEmptyCatalog, createLocationId, LocationCatalogStore, type PendingScanRecord, type ResolvedLocationTarget } from "../src/main/location-catalog"
import { createCoveragePublicationAccess, type CoveragePublicationAccess } from "../src/main/coverage-publication-access"
import type { FolderSizeEstimate } from "../src/main/scan-metadata"
import type { ScanExecution, ScanExecutionRequest, ScanSession } from "../src/main/scan-execution"
import { scanFilesystem, type ScanResult, type ScanTotals } from "../src/main/scanner"

interface AdapterFixture {
  readonly directory: string
  readonly indexes: string
  readonly target: string
  readonly identity: ResolvedLocationTarget
  readonly catalog: LocationCatalogStore
  readonly coverage: CoveragePublicationAccess
  readonly deps: ScanLifecycleDependencies
  readonly events: string[]
  setForeignResumeDescriptor(descriptor: FullScanResumeDescriptor | undefined): void
  setRestoreFocusError(message: string | undefined): void
  setStoredEstimate(estimate: FolderSizeEstimate | undefined): void
}

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

const UNUSED_TOTALS: ScanTotals = { scannedItems: 0, discoveredBytes: 0, elapsedMs: 0, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 }

async function targetIdentity(target: string): Promise<ResolvedLocationTarget> {
  const canonical = await realpath(target)
  const stats = await lstat(canonical)
  return { target: canonical, targetDevice: String(stats.dev), targetInode: String(stats.ino) }
}

/** Wrap the named methods of a real store so tests can observe call order. */
function recordCalls<T extends object>(target: T, labels: Partial<Record<string, string>>, events: string[]): T {
  return new Proxy(target, {
    get(original, property) {
      const value = Reflect.get(original, property, original)
      // Private class fields are unreachable through a proxy receiver, so every
      // method is re-bound to the real store.
      if (typeof value !== "function") return value
      const bound = (...args: unknown[]) => (value as (...callArgs: unknown[]) => unknown).apply(original, args)
      const label = typeof property === "string" ? labels[property] : undefined
      if (label === undefined) return bound
      return (...args: unknown[]) => {
        events.push(label)
        return bound(...args)
      }
    }
  })
}

async function fixture(name: string): Promise<AdapterFixture> {
  const directory = await mkdtemp(join(tmpdir(), `orbis-adapters-${name}-`))
  cleanup.push(directory)
  const target = join(directory, "target")
  const indexes = join(directory, "indexes")
  await mkdir(join(target, "child"), { recursive: true })
  await mkdir(indexes)
  await writeFile(join(target, "child", "file.txt"), "contents")
  const identity = await targetIdentity(target)
  const catalog = new LocationCatalogStore(indexes)
  await catalog.initialize()
  await catalog.installInitial(createEmptyCatalog(identity))
  const resumeStore = new FullScanResumeStore(indexes)
  const coverage = createCoveragePublicationAccess(indexes, catalog, catalog.artifacts)
  const events: string[] = []
  let foreignDescriptor: FullScanResumeDescriptor | undefined
  let restoreFocusError: string | undefined
  let storedEstimate: FolderSizeEstimate | undefined

  const resumeRecording = new Proxy(resumeStore, {
    get(original, property) {
      const value = Reflect.get(original, property, original)
      if (typeof value !== "function") return value
      const bound = (...args: unknown[]) => (value as (...callArgs: unknown[]) => unknown).apply(original, args)
      if (property === "readDescriptor") {
        return async () => foreignDescriptor ?? (await original.readDescriptor())
      }
      if (property === "complete") {
        return async (scanId: string) => {
          events.push("resume:complete")
          return original.complete(scanId)
        }
      }
      return bound
    }
  })
  const catalogRecording = recordCalls(catalog, { advancePublication: "catalog:advance", beginScan: "catalog:begin", clearPendingScan: "catalog:clear" }, events)
  const artifactRecording = recordCalls(catalog.artifacts, { discardUnreferencedDatabase: "artifact:discard" }, events)
  const coverageRecording = recordCalls(coverage, { publishAndInstall: "publish:start" }, events)
  const focus: ScanLifecycleFocusPort = {
    currentId: () => undefined,
    resolvePath: () => undefined,
    restore: (_access, previousFocusId) => {
      events.push("focus:restore")
      if (restoreFocusError) throw new Error(restoreFocusError)
      return previousFocusId ?? ""
    }
  }
  const scanExecution: ScanExecution = {
    start(_request: ScanExecutionRequest): Promise<ScanSession> { throw new Error("The adapter tests never start a worker session") },
    async close(): Promise<void> { /* Nothing to close. */ }
  }
  const deps = createScanLifecycleDependencies({
    indexDirectory: indexes,
    scanExecution,
    ensureInitialized: async () => undefined,
    resumeStore: resumeRecording,
    catalogStore: catalogRecording,
    coverageAccess: coverageRecording,
    estimateCache: {
      load: async () => { events.push("estimate:load"); return storedEstimate },
      store: async () => { events.push("estimate:store") }
    },
    artifacts: artifactRecording,
    focus
  })
  return {
    directory, indexes, target: identity.target, identity, catalog, coverage, deps, events,
    setForeignResumeDescriptor: (descriptor) => { foreignDescriptor = descriptor },
    setRestoreFocusError: (message) => { restoreFocusError = message },
    setStoredEstimate: (estimate) => { storedEstimate = estimate }
  }
}

async function scanResultFor(value: AdapterFixture, generation: number, paths: { readonly partialPath: string; readonly publishedPath: string }): Promise<ScanResult> {
  return scanFilesystem({ generation, target: value.target, partialPath: paths.partialPath, publishedPath: paths.publishedPath, indexDirectory: value.indexes })
}

async function publishOnce(value: AdapterFixture): Promise<string> {
  const owner = value.catalog.current.locations[0]!
  const scanId = randomUUID()
  const catalogPaths = value.catalog.paths(scanId)
  const paths = { partialPath: catalogPaths.partialPath, publishedPath: catalogPaths.indexPath }
  await value.catalog.beginScan({
    scanId, locationId: owner.id, target: value.target,
    targetDevice: value.identity.targetDevice, targetInode: value.identity.targetInode,
    basePublicationId: owner.publicationId
  })
  const result = await scanResultFor(value, 1, paths)
  const installed = await value.coverage.publishAndInstall(
    { kind: "persistent", result, expectedPath: paths.publishedPath, ownership: { scanId, locationId: owner.id, basePublicationId: owner.publicationId }, journal: null },
    value.catalog.current.selectedLocationId
  )
  if (installed.kind !== "installed") throw new Error("expected installation")
  return scanId
}

function runFor(value: AdapterFixture, generation: number, basePublicationId: string | null): { readonly run: ScanRunContext; readonly paths: ReturnType<LocationCatalogStore["paths"]> } {
  const owner = value.catalog.current.locations[0]!
  const publicationId = randomUUID()
  const paths = value.catalog.paths(publicationId)
  return {
    paths,
    run: {
      generation, publicationId, locationId: owner.id, basePublicationId,
      target: value.target, partialPath: paths.partialPath, publishedPath: paths.indexPath
    }
  }
}

function pendingRecordFor(value: AdapterFixture, run: ScanRunContext): PendingScanRecord {
  return {
    scanId: run.publicationId, locationId: run.locationId, target: run.target,
    targetDevice: value.identity.targetDevice, targetInode: value.identity.targetInode,
    basePublicationId: run.basePublicationId
  }
}

describe("scan lifecycle adapters", () => {
  it("prepares start context from the catalog, installed coverage, and the estimate cache", async () => {
    const value = await fixture("prepare")
    try {
      const estimate: FolderSizeEstimate = { items: [{ name: "child", estimatedBytes: 512 }] }
      value.setStoredEstimate(estimate)
      const context = await value.deps.prepareStartContext(value.target)
      expect(context.identity).toEqual({ targetDevice: value.identity.targetDevice, targetInode: value.identity.targetInode })
      expect(context.ownerId).toBe(value.catalog.current.selectedLocationId)
      expect(context.basePublicationId).toBeNull()
      expect(context.initialEstimate).toBe(estimate)
      expect(context.active).toBeUndefined()
      expect(context.guards).toEqual({
        expectedRevision: value.catalog.current.revision,
        selectedLocationId: value.catalog.current.selectedLocationId
      })
      expect(value.events).toContain("estimate:load")
    } finally { await value.coverage.close() }
  })

  it("prepares start context from an installed matching publication", async () => {
    const value = await fixture("prepare-installed")
    try {
      await publishOnce(value)
      value.events.length = 0
      const context = await value.deps.prepareStartContext(value.target)
      const installed = value.coverage.current()!
      expect(context.basePublicationId).toBe(installed.publication()!.publicationId)
      expect(context.identity).toEqual({ targetDevice: value.identity.targetDevice, targetInode: value.identity.targetInode })
      expect(context.active).toEqual({ manifest: installed.publication()!, path: installed.artifactPath })
      // The installed estimate wins and the cache is not consulted.
      expect(context.initialEstimate).toBe(installed.estimate)
      expect(value.events).not.toContain("estimate:load")
    } finally { await value.coverage.close() }
  })

  it("guards beginScan on the catalog revision and selected location", async () => {
    const value = await fixture("begin-scan")
    try {
      const owner = value.catalog.current.locations[0]!
      const happyGuards: ScanStartGuards = {
        expectedRevision: value.catalog.current.revision,
        selectedLocationId: value.catalog.current.selectedLocationId
      }
      const record: PendingScanRecord = {
        scanId: randomUUID(), locationId: owner.id, target: value.target,
        targetDevice: value.identity.targetDevice, targetInode: value.identity.targetInode,
        basePublicationId: owner.publicationId
      }
      await value.deps.beginScan(record, undefined, happyGuards)
      expect(value.catalog.current.pendingScan?.scanId).toBe(record.scanId)
      expect(value.deps.pendingScanId()).toBe(record.scanId)

      const staleRecord = { ...record, scanId: randomUUID() }
      await expect(value.deps.beginScan(staleRecord, record.scanId, { ...happyGuards, expectedRevision: value.catalog.current.revision + 1 }))
        .rejects.toThrow("The pending catalog snapshot is stale")
      expect(value.catalog.current.pendingScan?.scanId).toBe(record.scanId)

      await expect(value.deps.beginScan({ ...staleRecord, scanId: randomUUID() }, record.scanId, { expectedRevision: value.catalog.current.revision, selectedLocationId: createLocationId() }))
        .rejects.toThrow("The selected location changed while the scan was starting")
      expect(value.catalog.current.pendingScan?.scanId).toBe(record.scanId)
    } finally { await value.coverage.close() }
  })

  it("publishes a completed run by installing the candidate before any best-effort retirement", async () => {
    const value = await fixture("publish-completed")
    try {
      const owner = value.catalog.current.locations[0]!
      const { run } = runFor(value, 1, owner.publicationId)
      await value.deps.beginScan(pendingRecordFor(value, run), undefined, {
        expectedRevision: value.catalog.current.revision, selectedLocationId: owner.id
      })
      const catalogPaths = value.catalog.paths(run.publicationId)
      const result = await scanResultFor(value, 1, { partialPath: catalogPaths.partialPath, publishedPath: catalogPaths.indexPath })
      value.events.length = 0
      const publication = await value.deps.publishCompleted(run, { kind: "completed", result })
      expect(publication).toMatchObject({ kind: "published", totals: result.totals, activeTarget: owner.target, warnings: [] })
      // The durable install happens first; retirement and cleanup follow.
      expect(value.events).toEqual(["publish:start", "resume:complete", "focus:restore", "estimate:store", "artifact:discard"])
      expect(value.coverage.current()?.publication()?.publicationId).toBe(run.publicationId)
      expect(value.catalog.current.pendingScan).toBeNull()
    } finally { await value.coverage.close() }
  })

  it("keeps a stale base publication from publishing at all", async () => {
    const value = await fixture("publish-stale-base")
    try {
      const installedScanId = await publishOnce(value)
      const owner = value.catalog.current.locations[0]!
      const { run } = runFor(value, 2, installedScanId)
      await value.deps.beginScan(pendingRecordFor(value, run), undefined, {
        expectedRevision: value.catalog.current.revision, selectedLocationId: owner.id
      })
      const catalogPaths = value.catalog.paths(run.publicationId)
      const result = await scanResultFor(value, 2, { partialPath: catalogPaths.partialPath, publishedPath: catalogPaths.indexPath })
      value.events.length = 0
      const publication = await value.deps.publishCompleted(run, {
        kind: "completed", result,
        refresh: { strategy: "incremental", journal: { uuid: "volume", eventId: "42" }, basePublicationId: randomUUID() }
      })
      expect(publication).toEqual({ kind: "stale", reason: "stale-base-publication", candidateDisposition: "catalog-owned" })
      expect(value.events).toEqual([])
      // The pending catalog record survives; the module decides its retirement.
      expect(value.catalog.current.pendingScan?.scanId).toBe(run.publicationId)
    } finally { await value.coverage.close() }
  })

  it("keeps a completed publication published when best-effort focus restoration fails", async () => {
    const value = await fixture("publish-warnings")
    try {
      const owner = value.catalog.current.locations[0]!
      const { run } = runFor(value, 1, owner.publicationId)
      await value.deps.beginScan(pendingRecordFor(value, run), undefined, {
        expectedRevision: value.catalog.current.revision, selectedLocationId: owner.id
      })
      const catalogPaths = value.catalog.paths(run.publicationId)
      const result = await scanResultFor(value, 1, { partialPath: catalogPaths.partialPath, publishedPath: catalogPaths.indexPath })
      value.setRestoreFocusError("focus restore failed")
      value.events.length = 0
      const publication = await value.deps.publishCompleted(run, { kind: "completed", result })
      expect(publication).toMatchObject({ kind: "published", activeTarget: owner.target })
      expect(publication.kind === "published" && publication.warnings).toEqual(["focus restore failed"])
      // The failure cut the post-commit extras short, but the install stands.
      expect(value.events).toEqual(["publish:start", "resume:complete", "focus:restore"])
      expect(value.coverage.current()?.publication()?.publicationId).toBe(run.publicationId)
    } finally { await value.coverage.close() }
  })

  it("retires Resume before advancing an unchanged publication", async () => {
    const value = await fixture("publish-unchanged")
    try {
      const installedScanId = await publishOnce(value)
      const owner = value.catalog.current.locations[0]!
      const { run } = runFor(value, 2, installedScanId)
      await value.deps.beginScan(pendingRecordFor(value, run), undefined, {
        expectedRevision: value.catalog.current.revision, selectedLocationId: owner.id
      })
      const outcome: UnchangedOutcome = {
        kind: "unchanged", journal: { uuid: "volume", eventId: "42" }, totals: UNUSED_TOTALS, basePublicationId: installedScanId
      }
      value.events.length = 0
      const publication = await value.deps.publishUnchanged(run, outcome)
      expect(publication).toMatchObject({ kind: "published", totals: UNUSED_TOTALS, activeTarget: owner.target, warnings: [] })
      // Resume retirement strictly precedes the durable catalog advance.
      expect(value.events).toEqual(["resume:complete", "catalog:advance", "artifact:discard", "artifact:discard"])
      expect(value.coverage.current()?.publication()?.journal).toEqual({ uuid: "volume", eventId: "42" })
      expect(value.catalog.current.pendingScan).toBeNull()
    } finally { await value.coverage.close() }
  })

  it("refuses an unchanged publication when another scan owns the Resume descriptor", async () => {
    const value = await fixture("publish-unchanged-foreign")
    try {
      const installedScanId = await publishOnce(value)
      const revisionBefore = value.catalog.current.revision
      const owner = value.catalog.current.locations[0]!
      const { run } = runFor(value, 2, installedScanId)
      await value.deps.beginScan(pendingRecordFor(value, run), undefined, {
        expectedRevision: value.catalog.current.revision, selectedLocationId: owner.id
      })
      value.setForeignResumeDescriptor({
        version: 1, scanId: randomUUID(), partialFile: "index-partial.sqlite", candidateFile: "index.sqlite",
        target: value.target, targetDevice: value.identity.targetDevice, targetInode: value.identity.targetInode,
        indexDirectoryIdentity: "1:2", startupRoot: false, schemaVersion: 1, constructionSchemaVersion: 3,
        accountingVersion: "v2", exclusionPolicyVersion: "v1", hardLinkOrderingVersion: "utf8",
        journalDevice: "1", journalUuid: "journal", journalBaseline: "0", createdAt: "2026-01-01T00:00:00.000Z"
      })
      const outcome: UnchangedOutcome = {
        kind: "unchanged", journal: { uuid: "volume", eventId: "42" }, totals: UNUSED_TOTALS, basePublicationId: installedScanId
      }
      value.events.length = 0
      await expect(value.deps.publishUnchanged(run, outcome)).rejects.toThrow("Another Orbis scan owns the Resume descriptor")
      expect(value.events).toEqual([])
      // The catalog was never advanced.
      expect(value.catalog.current.revision).toBe(revisionBefore + 1)
      expect(value.catalog.current.pendingScan?.scanId).toBe(run.publicationId)
    } finally { await value.coverage.close() }
  })

  it("keeps an advanced unchanged publication when run-file cleanup fails", async () => {
    const value = await fixture("publish-unchanged-cleanup")
    try {
      const installedScanId = await publishOnce(value)
      const owner = value.catalog.current.locations[0]!
      const { run } = runFor(value, 2, installedScanId)
      await value.deps.beginScan(pendingRecordFor(value, run), undefined, {
        expectedRevision: value.catalog.current.revision, selectedLocationId: owner.id
      })
      const outcome: UnchangedOutcome = {
        kind: "unchanged", journal: { uuid: "volume", eventId: "42" }, totals: UNUSED_TOTALS, basePublicationId: installedScanId
      }
      const failing = new Proxy(value.catalog.artifacts, {
        get(original, property) {
          if (property === "discardUnreferencedDatabase") {
            return async () => { throw new Error("cleanup unavailable") }
          }
          const value = Reflect.get(original, property, original)
          if (typeof value !== "function") return value
          return (...args: unknown[]) => (value as (...callArgs: unknown[]) => unknown).apply(original, args)
        }
      })
      const failingDeps = createScanLifecycleDependencies({
        indexDirectory: value.indexes,
        scanExecution: { start: () => { throw new Error("no worker needed") }, close: async () => undefined },
        ensureInitialized: async () => undefined,
        resumeStore: new FullScanResumeStore(value.indexes),
        catalogStore: value.catalog,
        coverageAccess: value.coverage,
        estimateCache: { load: async () => undefined, store: async () => undefined },
        artifacts: failing,
        focus: { currentId: () => undefined, resolvePath: () => undefined, restore: () => "" }
      })
      const publication = await failingDeps.publishUnchanged(run, outcome)
      expect(publication).toMatchObject({ kind: "published", activeTarget: owner.target })
      expect(publication.kind === "published" && publication.warnings).toEqual(["cleanup unavailable"])
      // The durable catalog advance stands despite the cleanup failure.
      expect(value.coverage.current()?.publication()?.journal).toEqual({ uuid: "volume", eventId: "42" })
      expect(value.catalog.current.pendingScan).toBeNull()
    } finally { await value.coverage.close() }
  })

  it("reports an unchanged publication against a missing base as stale", async () => {
    const value = await fixture("publish-unchanged-stale")
    try {
      const owner = value.catalog.current.locations[0]!
      const { run } = runFor(value, 1, owner.publicationId)
      const publication = await value.deps.publishUnchanged(run, {
        kind: "unchanged", journal: { uuid: "volume", eventId: "42" }, totals: UNUSED_TOTALS, basePublicationId: owner.publicationId ?? randomUUID()
      })
      expect(publication).toEqual({ kind: "stale", reason: "stale-base-publication", candidateDisposition: "catalog-owned" })
    } finally { await value.coverage.close() }
  })

  it("derives run paths and publication ids from the catalog", async () => {
    const value = await fixture("paths")
    try {
      const publicationId = value.deps.createPublicationId()
      expect(publicationId).toMatch(/^[0-9a-f-]{36}$/)
      expect(value.deps.runPaths(publicationId)).toEqual({
        partialPath: value.catalog.paths(publicationId).partialPath,
        publishedPath: value.catalog.paths(publicationId).indexPath
      })
      expect(value.deps.indexDirectory).toBe(value.indexes)
    } finally { await value.coverage.close() }
  })
})