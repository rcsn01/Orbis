import { existsSync } from "node:fs"
import { access, link, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { buildChart } from "../src/main/chart"
import { removeDatabaseFiles } from "../src/main/database"
import { DiskIndex } from "../src/main/index-store"
import { defaultScanFileSystem, scanFilesystem, ScanCanceledError, type ScanFileSystem } from "../src/main/scanner"
import { createScanFixture, type ScanFixtureManifest } from "../scripts/lib/scan-fixtures"
import { subscribeScanDiagnostics, type OrbisTimingEvent } from "../src/main/diagnostics"

async function fixture(): Promise<{ readonly directory: string; readonly root: string; readonly manifest: ScanFixtureManifest }> {
  const created = await createScanFixture("semantics", "quick")
  return { directory: created.directory, root: created.root, manifest: created.manifest }
}

describe("Orbis scanner", () => {
  it("indexes allocated files, nested totals, stable ordering, symlinks, and hard links", async () => {
    const { directory, root, manifest } = await fixture()
    const indexDirectory = join(directory, "indexes")
    const partialPath = join(indexDirectory, "scan.partial.sqlite")
    const publishedPath = join(indexDirectory, "scan.sqlite")
    try {
      const result = await scanFilesystem({ generation: 1, target: root, partialPath, publishedPath, indexDirectory })
      const index = new DiskIndex(result.publishedPath)
      const rootNode = index.root!
      const children = index.getChildren(rootNode.id, 100)
      const names = children.map((child) => child.name)
      expect(names[0]).toBe("Documents")
      expect(names).toContain("Empty")
      expect(names.filter((name) => name === "root.txt" || name === "hard-link.txt")).toHaveLength(1)
      expect(rootNode.descendantCount).toBe(manifest.files + manifest.directories - 1)
      expect(result.totals.scannedItems).toBe(manifest.files + manifest.directories)
      expect(rootNode.sizeBytes).toBe(result.scannedBytes)
      expect(result.totals.symlinks).toBe(manifest.symlinks)
      expect(result.totals.duplicateHardLinks).toBe(manifest.hardLinkAliases)
      const indexedRootFile = children.find((child) => child.name === "root.txt" || child.name === "hard-link.txt")!
      const expectedRootBytes = (await lstat(join(root, "root.txt"))).blocks * 512
      expect(index.getNode(indexedRootFile.id)!.sizeBytes).toBe(expectedRootBytes)
      const documents = children.find((child) => child.name === "Documents")!
      expect(index.getNode(documents.id)!.sizeBytes).toBeGreaterThanOrEqual((await lstat(join(root, "Documents"))).blocks * 512)
      expect(index.getBreadcrumbs(children[0]!.id).map((item) => item.name)).toEqual(["volume", "Documents"])
      const allocatedTotal = await sumAllocated(index, rootNode.id)
      expect(rootNode.sizeBytes).toBe(allocatedTotal)
      assertEveryDirectoryAggregate(result.publishedPath)
      index.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("bounds concurrent metadata reads while preserving deterministic writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-bounded-metadata-"))
    const root = join(directory, "root")
    const indexDirectory = join(directory, "indexes")
    await mkdir(root)
    for (let index = 0; index < 16; index += 1) await writeFile(join(root, `file-${String(index).padStart(2, "0")}.dat`), "data")
    const real = defaultScanFileSystem()
    let active = 0
    let maximumActive = 0
    const fileSystem: ScanFileSystem = {
      ...real,
      lstat: async (path) => {
        if (!path.startsWith(`${root}/`)) return real.lstat(path)
        active += 1
        maximumActive = Math.max(maximumActive, active)
        try { await new Promise((resolveDelay) => setTimeout(resolveDelay, 5)); return await real.lstat(path) }
        finally { active -= 1 }
      }
    }
    try {
      const result = await scanFilesystem({ generation: 1, target: root, partialPath: join(indexDirectory, "partial.sqlite"), publishedPath: join(indexDirectory, "published.sqlite"), indexDirectory, fileSystem, metadataConcurrency: 4 })
      expect(maximumActive).toBe(4)
      const idsByName = new Map(readNodeRows(result.publishedPath).map((row) => [String(row.name), String(row.id)]))
      for (let index = 0; index < 16; index += 1) expect(idsByName.has(`file-${String(index).padStart(2, "0")}.dat`)).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("shares one metadata-operation limit across nested directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-global-metadata-limit-"))
    const root = join(directory, "root")
    const indexDirectory = join(directory, "indexes")
    for (let branch = 0; branch < 4; branch += 1) {
      const child = join(root, `d-${branch}`)
      await mkdir(child, { recursive: true })
      for (let file = 0; file < 4; file += 1) await writeFile(join(child, `f-${file}.dat`), "data")
    }
    const real = defaultScanFileSystem()
    let active = 0
    let maximumActive = 0
    const fileSystem: ScanFileSystem = {
      ...real,
      lstat: async (path) => {
        if (!path.startsWith(`${root}/`)) return real.lstat(path)
        active += 1
        maximumActive = Math.max(maximumActive, active)
        const relativeDepth = path.slice(root.length + 1).split("/").length
        const delay = relativeDepth === 1 && path.endsWith("d-0") ? 1 : relativeDepth === 1 ? 30 : 10
        try { await new Promise((resolveDelay) => setTimeout(resolveDelay, delay)); return await real.lstat(path) }
        finally { active -= 1 }
      }
    }
    try {
      await scanFilesystem({ generation: 1, target: root, partialPath: join(indexDirectory, "partial.sqlite"), publishedPath: join(indexDirectory, "published.sqlite"), indexDirectory, fileSystem, metadataConcurrency: 4 })
      expect(maximumActive).toBe(4)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("stops metadata admission and drains in-flight reads on cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-canceled-metadata-"))
    const root = join(directory, "root")
    const indexDirectory = join(directory, "indexes")
    await mkdir(root)
    for (let index = 0; index < 20; index += 1) await writeFile(join(root, `file-${index}.dat`), "data")
    const signal = new AbortController()
    const real = defaultScanFileSystem()
    let started = 0
    let releaseReads: (() => void) | undefined
    const readsReleased = new Promise<void>((resolveReads) => { releaseReads = resolveReads })
    const fileSystem: ScanFileSystem = {
      ...real,
      lstat: async (path) => {
        if (!path.startsWith(`${root}/`)) return real.lstat(path)
        started += 1
        if (started === 4) { signal.abort(); releaseReads?.() }
        await readsReleased
        return real.lstat(path)
      }
    }
    const partialPath = join(indexDirectory, "partial.sqlite")
    const publishedPath = join(indexDirectory, "published.sqlite")
    try {
      await expect(scanFilesystem({ generation: 1, target: root, partialPath, publishedPath, indexDirectory, fileSystem, signal: signal.signal, metadataConcurrency: 4 })).rejects.toBeInstanceOf(ScanCanceledError)
      expect(started).toBe(4)
      await expectDatabaseFilesAbsent(partialPath)
      await expectDatabaseFilesAbsent(publishedPath)
    } finally { releaseReads?.(); await rm(directory, { recursive: true, force: true }) }
  })

  it("deduplicates hard links across top-level subtrees deterministically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-concurrent-hard-links-"))
    const root = join(directory, "root")
    const indexDirectory = join(directory, "indexes")
    await mkdir(join(root, "a"), { recursive: true })
    await mkdir(join(root, "b"), { recursive: true })
    const source = join(root, "a", "source.dat")
    await writeFile(source, "shared")
    await link(source, join(root, "b", "alias.dat"))
    try {
      const result = await scanFilesystem({ generation: 1, target: root, partialPath: join(indexDirectory, "partial.sqlite"), publishedPath: join(indexDirectory, "published.sqlite"), indexDirectory, metadataConcurrency: 4 })
      expect(result.totals.duplicateHardLinks).toBe(1)
      const fileRows = readNodeRows(result.publishedPath).filter((row) => row.kind === "file")
      expect(fileRows).toHaveLength(1)
      expect(fileRows[0]!.path).toBe(source)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("uses a total name order for deterministic hard-link representatives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-collation-order-"))
    const root = "/orbis-virtual-collation-root"
    const indexDirectory = join(directory, "indexes")
    const real = defaultScanFileSystem()
    const fileSystem: ScanFileSystem = {
      realpath: async (path) => path.startsWith(directory) ? real.realpath(path) : path,
      statfs: async () => ({ blocks: 100, bfree: 50, bsize: 4_096 }),
      readdir: async () => ["a", "A"],
      lstat: async (path) => {
        if (path.startsWith(directory)) return real.lstat(path)
        const rootNode = path === root
        return { blocks: 1, dev: 1, ino: rootNode ? 1 : 2, isDirectory: () => rootNode, isFile: () => !rootNode, isSymbolicLink: () => false }
      }
    }
    try {
      const result = await scanFilesystem({ generation: 1, target: root, partialPath: join(indexDirectory, "partial.sqlite"), publishedPath: join(indexDirectory, "published.sqlite"), indexDirectory, fileSystem, metadataConcurrency: 4 })
      expect(result.totals.duplicateHardLinks).toBe(1)
      const fileRows = readNodeRows(result.publishedPath).filter((row) => row.kind === "file")
      expect(fileRows).toHaveLength(1)
      expect(fileRows[0]!.name).toBe("A")
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("keeps unreadable and disappearing directories as skipped work", async () => {
    const { directory, root } = await fixture()
    const real = defaultScanFileSystem()
    const fileSystem: ScanFileSystem = {
      ...real,
      readdir: async (path) => {
        if (path.endsWith("Empty")) { const error = new Error("denied") as NodeJS.ErrnoException; error.code = "EACCES"; throw error }
        return real.readdir(path)
      },
      lstat: async (path) => {
        if (path.endsWith("small.txt")) { const error = new Error("gone") as NodeJS.ErrnoException; error.code = "ENOENT"; throw error }
        const stats = await real.lstat(path)
        if (!path.endsWith("Nested")) return stats
        return { ...(stats.blocks === undefined ? {} : { blocks: stats.blocks }), dev: Number(stats.dev) + 1, ino: stats.ino, isDirectory: () => stats.isDirectory(), isFile: () => stats.isFile(), isSymbolicLink: () => stats.isSymbolicLink() }
      }
    }
    const partialPath = join(directory, "indexes", "partial.sqlite")
    const publishedPath = join(directory, "indexes", "published.sqlite")
    try {
      const result = await scanFilesystem({ generation: 1, target: root, partialPath, publishedPath, indexDirectory: join(directory, "indexes"), fileSystem })
      expect(result.totals.unreadableItems).toBeGreaterThan(0)
      expect(result.totals.disappearingItems).toBe(1)
      expect(result.totals.skippedItems).toBeGreaterThanOrEqual(3)
      expect(result.totals.nestedMounts).toBe(1)
      const index = new DiskIndex(publishedPath)
      expect(index.getNode(index.rootId)!.unreadableCount).toBeGreaterThan(0)
      index.close()
      assertEveryDirectoryAggregate(publishedPath)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("aggregates a deep tree without a synchronous recursion limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-deep-aggregate-"))
    const indexDirectory = join(directory, "indexes")
    const root = "/orbis-virtual-deep-root"
    const depth = 1_500
    const real = defaultScanFileSystem()
    const virtualDepth = (path: string): number => path === root ? 0 : path.startsWith(`${root}/`) ? path.slice(root.length + 1).split("/").length : -1
    const fileSystem: ScanFileSystem = {
      realpath: async (path) => path.startsWith(directory) ? real.realpath(path) : path,
      statfs: async () => ({ blocks: 10_000, bfree: 5_000, bsize: 4_096 }),
      readdir: async (path) => virtualDepth(path) < depth ? ["d"] : [],
      lstat: async (path) => {
        const level = virtualDepth(path)
        if (level < 0) return real.lstat(path)
        return { blocks: 1, dev: 1, ino: level + 1, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }
      }
    }
    try {
      const result = await scanFilesystem({ generation: 1, target: root, partialPath: join(indexDirectory, "partial.sqlite"), publishedPath: join(indexDirectory, "published.sqlite"), indexDirectory, fileSystem })
      expect(result.totals.scannedItems).toBe(depth + 1)
      expect(result.scannedBytes).toBe((depth + 1) * 512)
      const index = new DiskIndex(result.publishedPath)
      expect(index.root).toMatchObject({ directChildren: 1, descendantCount: depth, sizeBytes: (depth + 1) * 512 })
      index.close()
      assertEveryDirectoryAggregate(result.publishedPath)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 15_000)

  it("matches the independent directory oracle across fixture shapes", async () => {
    for (const name of ["wide", "deep", "tiny", "mixed"] as const) {
      const created = await createScanFixture(name, "quick")
      const indexDirectory = join(created.directory, "indexes")
      try {
        const result = await scanFilesystem({ generation: 1, target: created.root, partialPath: join(indexDirectory, "partial.sqlite"), publishedPath: join(indexDirectory, "published.sqlite"), indexDirectory })
        assertEveryDirectoryAggregate(result.publishedPath)
      } finally { await rm(created.directory, { recursive: true, force: true }) }
    }
  })

  it("reports complete opt-in timings without changing scan output", async () => {
    const { directory, root } = await fixture()
    const firstDirectory = join(directory, "first-index")
    const secondDirectory = join(directory, "second-index")
    const events: OrbisTimingEvent[] = []
    const unsubscribe = subscribeScanDiagnostics((event) => events.push(event))
    const previousLegacy = process.env.ORBIS_LEGACY_SCAN
    process.env.ORBIS_LEGACY_SCAN = "1"
    try {
      const first = await scanFilesystem({ generation: 11, target: root, partialPath: join(firstDirectory, "partial.sqlite"), publishedPath: join(firstDirectory, "published.sqlite"), indexDirectory: firstDirectory, metadataConcurrency: 1 })
      unsubscribe()
      const second = await scanFilesystem({ generation: 12, target: root, partialPath: join(secondDirectory, "partial.sqlite"), publishedPath: join(secondDirectory, "published.sqlite"), indexDirectory: secondDirectory, metadataConcurrency: 4 })
      expect("diagnostics" in first).toBe(false)
      expect("diagnostics" in second).toBe(false)
      expect(withoutElapsed(first.totals)).toEqual(withoutElapsed(second.totals))
      expect(readComparableNodeRows(first.publishedPath)).toEqual(readComparableNodeRows(second.publishedPath))
      const work = ["scheduler", "metadata-open", "metadata-read", "page-normalize", "aggregation", "metadata-batch-flush", "preview-build", "database-checkpoint", "candidate-finalize"]
      const required = ["preflight", "database-create", "traversal", ...work, "index-create", "metadata-write", "database-commit", "database-optimize", "database-close", "publish-rename", "scan-total"]
      for (const phase of required) {
        const matches = events.filter((event) => event.phase === phase && event.generation === 11)
        expect(matches).toHaveLength(1)
        expect(matches[0]!.durationMs).toBeGreaterThanOrEqual(0)
      }
      const timings = Object.fromEntries(events.map((event) => [event.phase, event.durationMs]))
      const leaves = Object.entries(timings).filter(([phase]) => phase !== "scan-total" && !work.includes(phase)).reduce((sum, [, duration]) => sum + duration, 0)
      expect(leaves).toBeLessThanOrEqual(timings["scan-total"]! + 0.1)
    } finally {
      if (previousLegacy === undefined) delete process.env.ORBIS_LEGACY_SCAN
      else process.env.ORBIS_LEGACY_SCAN = previousLegacy
      unsubscribe()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("removes a database when cancellation arrives during final publication progress", async () => {
    const { directory, root } = await fixture()
    const partialPath = join(directory, "indexes", "partial.sqlite")
    const publishedPath = join(directory, "indexes", "published.sqlite")
    const signal = new AbortController()
    try {
      await expect(scanFilesystem({ generation: 1, target: root, partialPath, publishedPath, indexDirectory: join(directory, "indexes"), signal: signal.signal, onProgress: () => { if (existsSync(publishedPath)) signal.abort() } })).rejects.toBeInstanceOf(ScanCanceledError)
      await expectDatabaseFilesAbsent(partialPath)
      await expectDatabaseFilesAbsent(publishedPath)
    } finally { await removeDatabaseFiles(partialPath); await removeDatabaseFiles(publishedPath); await rm(directory, { recursive: true, force: true }) }
  })

  it("rolls back completed subtree aggregates when cancellation arrives", async () => {
    const { directory, root } = await fixture()
    const partialPath = join(directory, "indexes", "partial.sqlite")
    const publishedPath = join(directory, "indexes", "published.sqlite")
    const signal = new AbortController()
    const real = defaultScanFileSystem()
    const visitedDirectories: string[] = []
    const fileSystem: ScanFileSystem = {
      ...real,
      readdir: async (path) => {
        visitedDirectories.push(path)
        if (path.endsWith("Empty")) signal.abort()
        return real.readdir(path)
      }
    }
    try {
      await expect(scanFilesystem({ generation: 1, target: root, partialPath, publishedPath, indexDirectory: join(directory, "indexes"), signal: signal.signal, fileSystem })).rejects.toBeInstanceOf(ScanCanceledError)
      expect(visitedDirectories.findIndex((path) => path.endsWith("Documents"))).toBeLessThan(visitedDirectories.findIndex((path) => path.endsWith("Empty")))
      await expectDatabaseFilesAbsent(partialPath)
      await expectDatabaseFilesAbsent(publishedPath)
    } finally { await removeDatabaseFiles(partialPath); await removeDatabaseFiles(publishedPath); await rm(directory, { recursive: true, force: true }) }
  })
})

describe("Orbis chart limits", () => {
  it("batches a large tail of small files into one counted Other segment", () => {
    const children = Array.from({ length: 50 }, (_, index) => ({ id: `n-${index + 2}`, parentId: "n-1", name: `tiny-${index}`, path: `/tiny-${index}`, kind: "file" as const, sizeBytes: 1, confirmedBytes: 1, estimatedBytes: 0, directChildren: 0, descendantCount: 0, unreadableCount: 0, scanState: "complete" as const, sizeAccuracy: "exact" as const }))
    const root = { id: "n-1", parentId: null, name: "root", path: "/", kind: "directory" as const, sizeBytes: children.length, confirmedBytes: children.length, estimatedBytes: 0, directChildren: children.length, descendantCount: children.length, unreadableCount: 0, scanState: "complete" as const, sizeAccuracy: "exact" as const }
    const source = { getNode: (id: string) => id === root.id ? root : children.find((child) => child.id === id), getChildren: (_id: string, limit: number) => children.slice(0, limit), countChildren: () => children.length }

    const chart = buildChart(source, root, { maxRings: 1 })
    const other = chart.find((segment) => segment.name === "Other")

    expect(chart.filter((segment) => segment.id !== null)).toHaveLength(8)
    expect(other).toMatchObject({ id: null, sizeBytes: 42, itemCount: 42, drillable: false })
    expect(chart.reduce((sum, segment) => sum + segment.sizeBytes, 0)).toBe(root.sizeBytes)
    expect(chart[0]?.startAngle).toBe(0)
    expect(chart.at(-1)?.endAngle).toBe(360)

    const capacityChart = buildChart(source, root, { maxRings: 1, rootTotalBytes: 150 })
    expect(capacityChart.find((segment) => segment.name === "Other")).toMatchObject({ sizeBytes: 50, itemCount: 50 })
    expect(capacityChart.at(-1)?.endAngle).toBeCloseTo(120)
    expect(capacityChart.reduce((sum, segment) => sum + segment.percentage, 0)).toBeCloseTo(100 / 3)
    expect(capacityChart.some((segment) => segment.name === "Unscanned or system data")).toBe(false)
  })

  it("uses the one-percent share threshold before the visible-file cap", () => {
    const children = [
      { id: "n-big", parentId: "n-1", name: "big", path: "/big", kind: "file" as const, sizeBytes: 40, confirmedBytes: 40, estimatedBytes: 0, directChildren: 0, descendantCount: 0, unreadableCount: 0, scanState: "complete" as const, sizeAccuracy: "exact" as const },
      { id: "n-medium", parentId: "n-1", name: "medium", path: "/medium", kind: "file" as const, sizeBytes: 10, confirmedBytes: 10, estimatedBytes: 0, directChildren: 0, descendantCount: 0, unreadableCount: 0, scanState: "complete" as const, sizeAccuracy: "exact" as const },
      ...Array.from({ length: 8 }, (_, index) => ({ id: `n-small-${index}`, parentId: "n-1", name: `small-${index}`, path: `/small-${index}`, kind: "file" as const, sizeBytes: 5, confirmedBytes: 5, estimatedBytes: 0, directChildren: 0, descendantCount: 0, unreadableCount: 0, scanState: "complete" as const, sizeAccuracy: "exact" as const }))
    ]
    const root = { id: "n-1", parentId: null, name: "root", path: "/", kind: "directory" as const, sizeBytes: 1000, confirmedBytes: 1000, estimatedBytes: 0, directChildren: children.length, descendantCount: children.length, unreadableCount: 0, scanState: "complete" as const, sizeAccuracy: "exact" as const }
    const source = { getNode: (id: string) => id === root.id ? root : children.find((child) => child.id === id), getChildren: (_id: string, limit: number) => children.slice(0, limit), countChildren: () => children.length }

    const chart = buildChart(source, root, { maxRings: 1 })

    expect(chart.filter((segment) => segment.id !== null).map((segment) => segment.name)).toEqual(["big", "medium"])
    expect(chart.find((segment) => segment.name === "Other")).toMatchObject({ itemCount: 8, sizeBytes: 950 })
  })

  it("caps rings and segments and aggregates omitted children", () => {
    const children = Array.from({ length: 60 }, (_, index) => ({ id: `n-${index + 2}`, parentId: "n-1", name: `item-${index}`, path: `/item-${index}`, kind: "file" as const, sizeBytes: 100, confirmedBytes: 100, estimatedBytes: 0, directChildren: 0, descendantCount: 0, unreadableCount: 0, scanState: "complete" as const, sizeAccuracy: "exact" as const }))
    const root = { id: "n-1", parentId: null, name: "root", path: "/", kind: "directory" as const, sizeBytes: children.length * 100, confirmedBytes: children.length * 100, estimatedBytes: 0, directChildren: children.length, descendantCount: children.length, unreadableCount: 0, scanState: "complete" as const, sizeAccuracy: "exact" as const }
    const source = { getNode: (id: string) => id === root.id ? root : children.find((child) => child.id === id), getChildren: (_id: string, limit: number) => children.slice(0, limit), countChildren: () => children.length }
    const chart = buildChart(source, root)
    expect(chart.length).toBeLessThanOrEqual(400)
    expect(new Set(chart.map((segment) => segment.depth)).size).toBeLessThanOrEqual(10)
    expect(chart.some((segment) => segment.name === "Other" && segment.id === null && !segment.drillable)).toBe(true)
    for (const maxSegments of [1, 2, 3]) {
      const limited = buildChart(source, root, { maxSegments })
      expect(limited).toHaveLength(maxSegments)
      expect(limited.some((segment) => segment.name === "Other")).toBe(true)
      expect(limited.reduce((sum, segment) => sum + segment.sizeBytes, 0)).toBe(root.sizeBytes)
    }
  })
})

async function expectDatabaseFilesAbsent(path: string): Promise<void> {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) await expect(access(`${path}${suffix}`)).rejects.toThrow()
}

function readNodeRows(path: string): readonly Record<string, unknown>[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try { return database.prepare("SELECT * FROM nodes ORDER BY id").all() as unknown as readonly Record<string, unknown>[] }
  finally { database.close() }
}

function readComparableNodeRows(path: string): readonly Record<string, unknown>[] {
  return readNodeRows(path).map(({ id: _id, parent_id: _parentId, ...row }) => row)
    .sort((left, right) => String(left.path).localeCompare(String(right.path)))
}

function assertEveryDirectoryAggregate(path: string): void {
  const rows = readNodeRows(path)
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  const children = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    if (row.parent_id === null) continue
    const siblings = children.get(String(row.parent_id)) ?? []
    siblings.push(row)
    children.set(String(row.parent_id), siblings)
  }
  const visit = (row: Record<string, unknown>): { sizeBytes: number; descendantCount: number; unreadableCount: number } => {
    const direct = children.get(String(row.id)) ?? []
    let sizeBytes = Number(row.own_bytes)
    let descendantCount = 0
    let unreadableCount = Number(row.own_unreadable)
    for (const child of direct) {
      const aggregate = child.kind === "directory"
        ? visit(byId.get(String(child.id))!)
        : { sizeBytes: Number(child.own_bytes), descendantCount: 0, unreadableCount: Number(child.own_unreadable) }
      sizeBytes += aggregate.sizeBytes
      descendantCount += 1 + aggregate.descendantCount
      unreadableCount += aggregate.unreadableCount
    }
    if (row.kind === "directory") {
      expect(row.size_bytes, `${String(row.path)} size`).toBe(sizeBytes)
      expect(row.direct_children, `${String(row.path)} direct children`).toBe(direct.length)
      expect(row.descendant_count, `${String(row.path)} descendants`).toBe(descendantCount)
      expect(row.unreadable_count, `${String(row.path)} unreadable`).toBe(unreadableCount)
    }
    return { sizeBytes, descendantCount, unreadableCount }
  }
  for (const row of rows) if (row.parent_id === null) visit(row)
}

function withoutElapsed<T extends { readonly elapsedMs: number }>(totals: T): Omit<T, "elapsedMs"> {
  const { elapsedMs, ...rest } = totals
  void elapsedMs
  return rest
}

async function sumAllocated(index: DiskIndex, id: string): Promise<number> {
  const path = index.resolvePath(id)!
  const stats = await lstat(path)
  let total = stats.blocks * 512
  for (const child of index.getChildren(id, 100)) total += await sumAllocated(index, child.id)
  return total
}
