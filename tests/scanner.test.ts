import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildChart } from "../src/main/chart"
import { removeDatabaseFiles } from "../src/main/database"
import { DiskIndex } from "../src/main/index-store"
import { defaultScanFileSystem, scanFilesystem, ScanCanceledError, type ScanFileSystem } from "../src/main/scanner"

async function fixture(): Promise<{ readonly directory: string; readonly root: string }> {
  const directory = await mkdtemp(join(tmpdir(), "orbis-scanner-"))
  const root = join(directory, "volume")
  await mkdir(join(root, "Documents", "Nested"), { recursive: true })
  await mkdir(join(root, "Empty"), { recursive: true })
  await writeFile(join(root, "Documents", "small.txt"), "small")
  await writeFile(join(root, "Documents", "Nested", "large.bin"), Buffer.alloc(48 * 1024))
  await writeFile(join(root, "root.txt"), Buffer.alloc(8 * 1024))
  return { directory, root }
}

describe("Orbis scanner", () => {
  it("indexes allocated files, nested totals, stable ordering, symlinks, and hard links", async () => {
    const { directory, root } = await fixture()
    const indexDirectory = join(directory, "indexes")
    const partialPath = join(indexDirectory, "scan.partial.sqlite")
    const publishedPath = join(indexDirectory, "scan.sqlite")
    try {
      await symlink(join(root, "Documents"), join(root, "Documents-link"))
      await symlink(join(root, "root.txt"), join(root, "root-link.txt"))
      try { await symlink(join(root, "root.txt"), join(root, "root-hard-link.txt")) } catch { /* Symlink support is platform dependent. */ }
      const source = join(root, "root.txt")
      const hard = join(root, "hard-link.txt")
      try { await (await import("node:fs/promises")).link(source, hard) } catch { /* Some filesystems disallow hard links in fixtures. */ }
      const result = await scanFilesystem({ generation: 1, target: root, partialPath, publishedPath, indexDirectory })
      const index = new DiskIndex(result.publishedPath)
      const rootNode = index.root!
      const children = index.getChildren(rootNode.id, 100)
      const names = children.map((child) => child.name)
      expect(names[0]).toBe("Documents")
      expect(names).toContain("Empty")
      expect(names.filter((name) => name === "root.txt" || name === "hard-link.txt")).toHaveLength(1)
      expect(rootNode.descendantCount).toBeGreaterThanOrEqual(5)
      expect(rootNode.sizeBytes).toBe(result.scannedBytes)
      expect(result.totals.symlinks).toBeGreaterThanOrEqual(1)
      expect(result.totals.duplicateHardLinks).toBeGreaterThanOrEqual(1)
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
        return real.lstat(path)
      }
    }
    const partialPath = join(directory, "indexes", "partial.sqlite")
    const publishedPath = join(directory, "indexes", "published.sqlite")
    try {
      const result = await scanFilesystem({ generation: 1, target: root, partialPath, publishedPath, indexDirectory: join(directory, "indexes"), fileSystem })
      expect(result.totals.unreadableItems).toBeGreaterThan(0)
      expect(result.totals.disappearingItems).toBe(1)
      expect(result.totals.skippedItems).toBeGreaterThanOrEqual(2)
      const index = new DiskIndex(publishedPath)
      expect(index.getNode(index.rootId)!.unreadableCount).toBeGreaterThan(0)
      index.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("removes a partial database when cancellation arrives", async () => {
    const { directory, root } = await fixture()
    for (let index = 0; index < 40; index += 1) await writeFile(join(root, `file-${index}.dat`), Buffer.alloc(1024))
    const partialPath = join(directory, "indexes", "partial.sqlite")
    const publishedPath = join(directory, "indexes", "published.sqlite")
    const signal = new AbortController()
    try {
      await expect(scanFilesystem({ generation: 1, target: root, partialPath, publishedPath, indexDirectory: join(directory, "indexes"), signal: signal.signal, onProgress: () => signal.abort() })).rejects.toBeInstanceOf(ScanCanceledError)
      await expect(readFile(partialPath)).rejects.toThrow()
      await expect(readFile(publishedPath)).rejects.toThrow()
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

async function sumAllocated(index: DiskIndex, id: string): Promise<number> {
  const path = index.resolvePath(id)!
  const stats = await lstat(path)
  let total = stats.blocks * 512
  for (const child of index.getChildren(id, 100)) total += await sumAllocated(index, child.id)
  return total
}
