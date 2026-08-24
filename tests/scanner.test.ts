import { access, lstat, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { buildChart } from "../src/main/chart"
import { removeDatabaseFiles } from "../src/main/database"
import { DiskIndex } from "../src/main/index-store"
import { defaultScanFileSystem, scanFilesystem, ScanCanceledError, type ScanFileSystem } from "../src/main/scanner"
import { createScanFixture, type ScanFixtureManifest } from "../../../packages/feature-orbis/scripts/lib/scan-fixtures"
import { subscribeScanDiagnostics, type OrbisTimingEvent } from "../../../packages/feature-orbis/src/main/diagnostics"

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
      index.close()
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
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("reports complete opt-in timings without changing scan output", async () => {
    const { directory, root } = await fixture()
    const firstDirectory = join(directory, "first-index")
    const secondDirectory = join(directory, "second-index")
    const events: OrbisTimingEvent[] = []
    const unsubscribe = subscribeScanDiagnostics((event) => events.push(event))
    try {
      const first = await scanFilesystem({ generation: 11, target: root, partialPath: join(firstDirectory, "partial.sqlite"), publishedPath: join(firstDirectory, "published.sqlite"), indexDirectory: firstDirectory })
      unsubscribe()
      const second = await scanFilesystem({ generation: 12, target: root, partialPath: join(secondDirectory, "partial.sqlite"), publishedPath: join(secondDirectory, "published.sqlite"), indexDirectory: secondDirectory })
      expect("diagnostics" in first).toBe(false)
      expect("diagnostics" in second).toBe(false)
      expect(withoutElapsed(first.totals)).toEqual(withoutElapsed(second.totals))
      expect(readNodeRows(first.publishedPath)).toEqual(readNodeRows(second.publishedPath))
      const required = ["preflight", "database-create", "traversal", "aggregation", "index-create", "metadata-write", "database-optimize", "database-close", "publish-rename", "scan-total"]
      for (const phase of required) {
        const matches = events.filter((event) => event.phase === phase && event.generation === 11)
        expect(matches).toHaveLength(1)
        expect(matches[0]!.durationMs).toBeGreaterThanOrEqual(0)
      }
      const timings = Object.fromEntries(events.map((event) => [event.phase, event.durationMs]))
      const leaves = Object.entries(timings).filter(([phase]) => phase !== "scan-total").reduce((sum, [, duration]) => sum + duration, 0)
      expect(leaves).toBeLessThanOrEqual(timings["scan-total"]! + 0.1)
    } finally {
      unsubscribe()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("removes a partial database when cancellation arrives", async () => {
    const { directory, root } = await fixture()
    for (let index = 0; index < 40; index += 1) await writeFile(join(root, `file-${index}.dat`), Buffer.alloc(1024))
    const partialPath = join(directory, "indexes", "partial.sqlite")
    const publishedPath = join(directory, "indexes", "published.sqlite")
    const signal = new AbortController()
    try {
      await expect(scanFilesystem({ generation: 1, target: root, partialPath, publishedPath, indexDirectory: join(directory, "indexes"), signal: signal.signal, onProgress: () => signal.abort() })).rejects.toBeInstanceOf(ScanCanceledError)
      await expectDatabaseFilesAbsent(partialPath)
      await expectDatabaseFilesAbsent(publishedPath)
    } finally { await removeDatabaseFiles(partialPath); await removeDatabaseFiles(publishedPath); await rm(directory, { recursive: true, force: true }) }
  })
})

describe("Orbis chart limits", () => {
  it("caps rings and segments and aggregates omitted children", () => {
    const children = Array.from({ length: 60 }, (_, index) => ({ id: `n-${index + 2}`, parentId: "n-1", name: `item-${index}`, path: `/item-${index}`, kind: "file" as const, sizeBytes: 100, directChildren: 0, descendantCount: 0, unreadableCount: 0 }))
    const root = { id: "n-1", parentId: null, name: "root", path: "/", kind: "directory" as const, sizeBytes: children.length * 100, directChildren: children.length, descendantCount: children.length, unreadableCount: 0 }
    const source = { getNode: (id: string) => id === root.id ? root : children.find((child) => child.id === id), getChildren: (_id: string, limit: number) => children.slice(0, limit), countChildren: () => children.length }
    const chart = buildChart(source, root)
    expect(chart.length).toBeLessThanOrEqual(400)
    expect(new Set(chart.map((segment) => segment.depth)).size).toBeLessThanOrEqual(5)
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
