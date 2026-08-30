import { randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createScanLifecycleDependencies } from "../src/main/scan-start-adapters"
import type { ScanLifecycleDependencies, ScanStartGuards } from "../src/main/scan-run-lifecycle"
import { FullScanResumeStore } from "../src/main/full-scan-resume"
import { createEmptyCatalog, createLocationId, LocationCatalogStore, type PendingScanRecord, type ResolvedLocationTarget } from "../src/main/location-catalog"
import { createCoveragePublicationAccess, type CoveragePublicationAccess } from "../src/main/coverage-publication-access"
import type { FolderSizeEstimate } from "../src/main/scan-metadata"
import type { ScanExecution, ScanExecutionRequest, ScanSession } from "../src/main/scan-execution"
import { scanFilesystem, type ScanResult } from "../src/main/scanner"

interface StartFixture {
  readonly directory: string
  readonly indexes: string
  readonly target: string
  readonly identity: ResolvedLocationTarget
  readonly catalog: LocationCatalogStore
  readonly coverage: CoveragePublicationAccess
  readonly deps: ScanLifecycleDependencies
  readonly events: string[]
  setStoredEstimate(estimate: FolderSizeEstimate | undefined): void
}

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function targetIdentity(target: string): Promise<ResolvedLocationTarget> {
  const canonical = await realpath(target)
  const stats = await lstat(canonical)
  return { target: canonical, targetDevice: String(stats.dev), targetInode: String(stats.ino) }
}

async function fixture(name: string): Promise<StartFixture> {
  const directory = await mkdtemp(join(tmpdir(), `orbis-start-adapters-${name}-`))
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
  const coverage = createCoveragePublicationAccess(indexes, catalog, catalog.artifacts)
  const events: string[] = []
  let storedEstimate: FolderSizeEstimate | undefined

  const scanExecution: ScanExecution = {
    start(_request: ScanExecutionRequest): Promise<ScanSession> { throw new Error("The adapter tests never start a worker session") },
    async close(): Promise<void> { /* Nothing to close. */ }
  }
  const deps = createScanLifecycleDependencies({
    indexDirectory: indexes,
    scanExecution,
    ensureInitialized: async () => undefined,
    resumeStore: new FullScanResumeStore(indexes),
    catalogStore: catalog,
    coverageAccess: coverage,
    estimateCache: {
      load: async () => { events.push("estimate:load"); return storedEstimate },
      store: async () => { events.push("estimate:store") }
    },
    artifacts: catalog.artifacts,
    focus: { currentId: () => undefined, resolvePath: () => undefined, restore: () => "" }
  })
  return {
    directory, indexes, target: identity.target, identity, catalog, coverage, deps, events,
    setStoredEstimate: (estimate) => { storedEstimate = estimate }
  }
}

async function scanResultFor(value: StartFixture, generation: number, paths: { readonly partialPath: string; readonly publishedPath: string }): Promise<ScanResult> {
  return scanFilesystem({ generation, target: value.target, partialPath: paths.partialPath, publishedPath: paths.publishedPath, indexDirectory: value.indexes })
}

async function publishOnce(value: StartFixture): Promise<void> {
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
}

describe("scan start adapters", () => {  it("prepares start context from the catalog, installed coverage, and the estimate cache", async () => {
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